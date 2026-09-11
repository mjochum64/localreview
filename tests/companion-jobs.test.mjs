import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { upsertJob, writeJobFile } from "../plugins/localreview/scripts/lib/state.mjs";

const COMPANION = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "../plugins/localreview/scripts/review-companion.mjs"
);

function repoWithChange() {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "const a = 1;\n", "utf8");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), "const a = 2;\n", "utf8");
  return cwd;
}

// upsertJob/writeJobFile resolve their state directory from process.env.CLAUDE_PLUGIN_DATA
// of the CURRENT process. The child companion process gets its own env passed via `run`,
// so the in-process calls below must point at the same CLAUDE_PLUGIN_DATA the child will
// see, or the two would write to different state directories.
function withPluginDataEnv(dataDir, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

test("status lists stored jobs", () => {
  const cwd = repoWithChange();
  const dataDir = makeTempDir();
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
  withPluginDataEnv(dataDir, () => {
    upsertJob(cwd, { id: "review-1", status: "completed", target: "working tree diff", startedAt: "2026-09-11T10:00:00.000Z" });
  });

  const result = run("node", [COMPANION, "status", "--json", "--cwd", cwd], { env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.jobs[0].id, "review-1");
});

test("result replays a stored review", () => {
  const cwd = repoWithChange();
  const dataDir = makeTempDir();
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
  let file;
  withPluginDataEnv(dataDir, () => {
    file = writeJobFile(cwd, "review-1", { rendered: "# Lokaler Review\n\ngespeichert" });
    upsertJob(cwd, { id: "review-1", status: "completed", resultFile: file });
  });

  const result = run("node", [COMPANION, "result", "--json", "--job-id", "review-1", "--cwd", cwd], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).rendered, /gespeichert/);
});

test("result reports a clear error when the stored file is missing", () => {
  const cwd = repoWithChange();
  const dataDir = makeTempDir();
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
  let file;
  withPluginDataEnv(dataDir, () => {
    file = writeJobFile(cwd, "review-1", { rendered: "# Lokaler Review\n\nbald weg" });
    upsertJob(cwd, { id: "review-1", status: "completed", resultFile: file });
  });
  fs.unlinkSync(file);

  const result = run("node", [COMPANION, "result", "--json", "--job-id", "review-1", "--cwd", cwd], { env });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
});

test("a second review is refused while one is running", () => {
  const cwd = repoWithChange();
  const dataDir = makeTempDir();
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, LOCALREVIEW_BASE_URL: "http://127.0.0.1:1/v1" };
  withPluginDataEnv(dataDir, () => {
    upsertJob(cwd, { id: "review-running", status: "running", pid: process.pid, startedAt: "2026-09-11T10:00:00.000Z" });
  });

  const result = run("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], { env });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.error, /laeuft bereits/i);
});

test("cancel marks a stale job as cancelled", () => {
  const cwd = repoWithChange();
  const dataDir = makeTempDir();
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
  withPluginDataEnv(dataDir, () => {
    upsertJob(cwd, { id: "review-running", status: "running", pid: 999_999_999, startedAt: "2026-09-11T10:00:00.000Z" });
  });

  const result = run("node", [COMPANION, "cancel", "--json", "--cwd", cwd], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).job.status, "cancelled");
});

// Vor dem Wrapper liefen parseArgs und die Repo-Aufloesung ausserhalb jedes
// try/catch: ein ganz gewoehnlicher Bedienfehler wurde zur unhandled rejection,
// also Stacktrace auf stderr und leeres stdout. Weil alle Command-Dateien mit
// --json aufrufen, kam damit ueberhaupt keine verwertbare Antwort zurueck.
test("status outside a git repository reports a readable error, not a stack trace", () => {
  const cwd = makeTempDir();
  const dataDir = makeTempDir();

  const result = run("node", [COMPANION, "status", "--json", "--cwd", cwd], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir }
  });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /Git repository/i);
  assert.doesNotMatch(result.stderr, /at .*\.mjs/);
});

test("an unsupported scope reports a readable error, not a stack trace", () => {
  const cwd = repoWithChange();
  const dataDir = makeTempDir();

  const result = run("node", [COMPANION, "review", "--json", "--wait", "--scope", "bogus", "--cwd", cwd], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, LOCALREVIEW_BASE_URL: "http://127.0.0.1:1/v1" }
  });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.error, /scope/i);
  assert.doesNotMatch(result.stderr, /at .*\.mjs/);
});

test("a flag without its value reports a readable error, not a stack trace", () => {
  const cwd = repoWithChange();
  const dataDir = makeTempDir();

  const result = run("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd, "--base"], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, LOCALREVIEW_BASE_URL: "http://127.0.0.1:1/v1" }
  });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.error, /Missing value for --base/);
  assert.doesNotMatch(result.stderr, /at .*\.mjs/);
});

// Bricht ein Review-Prozess ab, bleibt sein Job-Eintrag auf "running" stehen.
// Wuerde der Eintrag allein den Start blockieren, waere das Plugin fuer dieses
// Repository dauerhaft unbenutzbar -- die einzige Rettung waere, von Hand eine
// State-Datei unter os.tmpdir() zu finden und zu loeschen.
test("a dead pid does not block the next review", () => {
  const cwd = repoWithChange();
  const dataDir = makeTempDir();
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, LOCALREVIEW_BASE_URL: "http://127.0.0.1:1/v1" };
  withPluginDataEnv(dataDir, () => {
    upsertJob(cwd, { id: "review-crashed", status: "running", pid: 999_999_999, startedAt: "2026-09-11T10:00:00.000Z" });
  });

  const result = run("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], { env });
  const payload = JSON.parse(result.stdout);
  assert.doesNotMatch(payload.error ?? "", /laeuft bereits/i);
  // Der Lauf kommt bis zum Server und scheitert erst dort -- der Job-Eintrag
  // hat ihn also nicht aufgehalten.
  assert.match(payload.error, /nicht erreichbar/i);
});
