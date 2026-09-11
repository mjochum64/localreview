import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { makeTempDir, run, runAsync } from "./helpers.mjs";
import { sendJson, startFakeServer } from "./fake-server.mjs";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "plugins/localreview/scripts/review-companion.mjs");

test("setup reports reachability and models", async () => {
  const server = await startFakeServer(({ res }) =>
    sendJson(res, 200, { data: [{ id: "m1", max_model_len: 262144 }] })
  );
  try {
    // runAsync, not run: this test hosts the fake server in this same process, and
    // a synchronous spawnSync child here would block the event loop the server's
    // request handler needs to run on (see helpers.mjs).
    const result = await runAsync("node", [COMPANION, "setup", "--json"], {
      cwd: makeTempDir(),
      env: { ...process.env, LOCALREVIEW_BASE_URL: server.baseUrl }
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.report.reachable, true);
    assert.equal(payload.report.models[0].id, "m1");
  } finally {
    await server.close();
  }
});

test("setup reports an unreachable server without crashing", () => {
  const result = run("node", [COMPANION, "setup", "--json"], {
    cwd: makeTempDir(),
    env: { ...process.env, LOCALREVIEW_BASE_URL: "http://127.0.0.1:1/v1" }
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).report.reachable, false);
});

test("every command file calls the companion via CLAUDE_PLUGIN_ROOT", () => {
  const dir = path.join(ROOT, "plugins/localreview/commands");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
  assert.deepEqual(files.sort(), ["cancel.md", "result.md", "review.md", "setup.md", "status.md"]);
  for (const file of files) {
    const body = fs.readFileSync(path.join(dir, file), "utf8");
    assert.match(body, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/review-companion\.mjs/);
    assert.match(body, /^---\ndescription:/);
  }
});

test("every command file disables autonomous model invocation", () => {
  const dir = path.join(ROOT, "plugins/localreview/commands");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
  for (const file of files) {
    const body = fs.readFileSync(path.join(dir, file), "utf8");
    assert.match(body, /^disable-model-invocation: true$/m, `${file} is missing disable-model-invocation: true`);
  }
});
