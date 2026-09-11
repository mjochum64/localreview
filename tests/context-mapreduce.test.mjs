import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPerFilePayloads,
  mergeFindings
} from "../plugins/localreview/scripts/lib/context.mjs";

const CONTEXT = {
  repoRoot: "/repo",
  branch: "feature",
  target: { mode: "branch", label: "branch diff against main" },
  summary: "Grosser Branch.",
  content: "x".repeat(40_000),
  changedFiles: ["a.js", "b.js", ".env"]
};

test("creates one payload per non-secret file", () => {
  const payloads = buildPerFilePayloads(CONTEXT, {
    budgetTokens: 1_000,
    readFile: (file) => `Inhalt von ${file}`
  });
  assert.deepEqual(payloads.map((entry) => entry.file), ["a.js", "b.js"]);
  assert.match(payloads[0].text, /Inhalt von a\.js/);
  assert.match(payloads[0].text, /branch diff against main/);
});

test("merges partial results and escalates the verdict", () => {
  const merged = mergeFindings([
    { verdict: "approve", summary: "ok", findings: [], next_steps: [] },
    {
      verdict: "needs-attention",
      summary: "Befund",
      findings: [{ severity: "high", title: "T", file: "b.js", line: 2, detail: "d", suggestion: null }],
      next_steps: ["Fix"]
    }
  ]);
  assert.equal(merged.verdict, "needs-attention");
  assert.equal(merged.findings.length, 1);
  assert.deepEqual(merged.next_steps, ["Fix"]);
});

test("merging nothing yields an approve verdict", () => {
  assert.deepEqual(mergeFindings([]), { verdict: "approve", summary: "", findings: [], next_steps: [] });
});
