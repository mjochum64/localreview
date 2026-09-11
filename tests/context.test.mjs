import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewPayload,
  estimateTokens,
  isSecretPath
} from "../plugins/localreview/scripts/lib/context.mjs";

function makeContext(overrides = {}) {
  return {
    repoRoot: "/repo",
    branch: "feature",
    target: { mode: "working-tree", label: "working tree diff" },
    summary: "Reviewing 1 staged file(s).",
    content: "## Git Status\n\nM a.js\n\n## Staged Diff\n\n+const a = 1;\n",
    changedFiles: ["a.js"],
    ...overrides
  };
}

test("estimates tokens as characters divided by four", () => {
  assert.equal(estimateTokens("12345678"), 2);
  assert.equal(estimateTokens(""), 0);
});

test("flags files that typically hold credentials", () => {
  assert.equal(isSecretPath(".env"), true);
  assert.equal(isSecretPath("config/.env.local"), true);
  assert.equal(isSecretPath("certs/server.pem"), true);
  assert.equal(isSecretPath("keys/id_rsa"), true);
  assert.equal(isSecretPath("src/environment.js"), false);
});

test("flags modern and legacy SSH private key types", () => {
  assert.equal(isSecretPath("keys/id_dsa"), true);
  assert.equal(isSecretPath("keys/id_ecdsa"), true);
  assert.equal(isSecretPath("keys/id_ed25519"), true);
});

test("flags security-key SSH variants", () => {
  assert.equal(isSecretPath("keys/id_ecdsa_sk"), true);
  assert.equal(isSecretPath("keys/id_ed25519_sk"), true);
});

test("flags credential files regardless of case", () => {
  assert.equal(isSecretPath(".ENV"), true);
  assert.equal(isSecretPath("certs/SERVER.PEM"), true);
  assert.equal(isSecretPath("keys/ID_RSA"), true);
  assert.equal(isSecretPath("keys/Id_Ed25519"), true);
});

test("does not flag ordinary files that merely resemble secret names", () => {
  assert.equal(isSecretPath("src/environment.js"), false);
  assert.equal(isSecretPath("src/keyboard.js"), false);
  assert.equal(isSecretPath("src/monkey.ts"), false);
});

test("includes branch, target and diff in the payload", () => {
  const payload = buildReviewPayload(makeContext(), {
    budgetTokens: 10_000,
    readFile: () => "const a = 1;\n"
  });
  assert.match(payload.text, /Branch: feature/);
  assert.match(payload.text, /working tree diff/);
  assert.match(payload.text, /\+const a = 1;/);
  assert.deepEqual(payload.includedFiles, ["a.js"]);
  assert.equal(payload.overBudget, false);
});

test("omits file bodies once the budget is exhausted", () => {
  const context = makeContext({ changedFiles: ["a.js", "b.js"] });
  const payload = buildReviewPayload(context, {
    budgetTokens: estimateTokens(context.content) + 40,
    readFile: () => "x".repeat(400)
  });
  assert.deepEqual(payload.includedFiles, []);
  assert.deepEqual(payload.omittedFiles, ["a.js", "b.js"]);
  assert.match(payload.text, /ausgelassen/i);
});

test("never reads secret files and names them", () => {
  const context = makeContext({ changedFiles: ["a.js", ".env"] });
  const reads = [];
  const payload = buildReviewPayload(context, {
    budgetTokens: 10_000,
    readFile: (file) => {
      reads.push(file);
      return "content";
    }
  });
  assert.deepEqual(reads, ["a.js"]);
  assert.deepEqual(payload.secretFiles, [".env"]);
  assert.match(payload.text, /\.env/);
});

test("reports over-budget when the diff alone does not fit", () => {
  const context = makeContext({ content: "x".repeat(4000) });
  const payload = buildReviewPayload(context, { budgetTokens: 100, readFile: () => null });
  assert.equal(payload.overBudget, true);
});
