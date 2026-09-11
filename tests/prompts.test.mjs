import test from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_SCHEMA_NAME,
  buildInstructions,
  loadReviewSchema
} from "../plugins/localreview/scripts/lib/prompts.mjs";

test("schema is strict-compatible", () => {
  const schema = loadReviewSchema();
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["verdict", "summary", "findings", "next_steps"]);

  const finding = schema.properties.findings.items;
  assert.equal(finding.additionalProperties, false);
  assert.deepEqual(finding.required, ["severity", "title", "file", "line", "detail", "suggestion"]);
  assert.deepEqual(finding.properties.line.type, ["integer", "null"]);
  assert.deepEqual(finding.properties.suggestion.type, ["string", "null"]);
});

test("schema name is stable", () => {
  assert.equal(REVIEW_SCHEMA_NAME, "review_output");
});

test("instructions state the read-only contract", () => {
  const text = buildInstructions({});
  assert.match(text, /read-only/i);
  assert.equal(/patch/i.test(text), true);
  assert.equal(text.includes("FOKUS"), false);
});

test("focus text is appended as its own marked section", () => {
  const text = buildInstructions({ focus: "hinterfrage das Caching-Design" });
  assert.match(text, /FOKUS/);
  assert.match(text, /hinterfrage das Caching-Design/);
});
