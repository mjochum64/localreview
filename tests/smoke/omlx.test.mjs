import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { initGitRepo, makeTempDir, run } from "../helpers.mjs";

const COMPANION = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "../../plugins/localreview/scripts/review-companion.mjs"
);
const BASE_URL = process.env.LOCALREVIEW_BASE_URL ?? "http://127.0.0.1:8000/v1";

async function serverReachable() {
  try {
    const response = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

test("reviews a real change against the local server", { timeout: 600_000 }, async (t) => {
  if (!(await serverReachable())) {
    t.skip(`Kein Server auf ${BASE_URL}`);
    return;
  }

  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "divide.js"), "export function divide(a, b) {\n  return a / b;\n}\n", "utf8");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(
    path.join(cwd, "divide.js"),
    "export function divide(a, b) {\n  return a / b;\n}\n\nexport function half(a) {\n  return divide(a, 0);\n}\n",
    "utf8"
  );

  const result = run("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: makeTempDir() }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(["approve", "needs-attention"].includes(payload.verdict));
});
