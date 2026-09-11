import test from "node:test";
import assert from "node:assert/strict";
import {
  renderCancelReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport
} from "../plugins/localreview/scripts/lib/render.mjs";

const META = {
  target: { label: "working tree diff" },
  model: "Qwen3.8-27B-4bit",
  durationMs: 65_000,
  includedFiles: ["a.js"],
  omittedFiles: [],
  secretFiles: []
};

test("sorts findings by severity and links file:line", () => {
  const parsed = {
    verdict: "needs-attention",
    summary: "Zwei Befunde.",
    findings: [
      { severity: "low", title: "Namensgebung", file: "b.js", line: 4, detail: "d", suggestion: null },
      { severity: "critical", title: "Nullzeiger", file: "a.js", line: 12, detail: "d", suggestion: "pruefen" }
    ],
    next_steps: ["Tests ergaenzen"]
  };
  const output = renderReviewResult({ parsed, rawText: "", structured: true }, META);
  assert.ok(output.indexOf("Nullzeiger") < output.indexOf("Namensgebung"));
  assert.match(output, /a\.js:12/);
  assert.match(output, /needs-attention/);
  assert.match(output, /Tests ergaenzen/);
});

test("warns and passes prose through when the schema was ignored", () => {
  const output = renderReviewResult(
    { parsed: null, rawText: "Freitext-Review", structured: false },
    META
  );
  assert.match(output, /strukturierte Ausgabe nicht unterstuetzt/i);
  assert.match(output, /Freitext-Review/);
  assert.doesNotMatch(output, /abgeschnitten/i);
});

test("warns about a truncated answer instead of blaming the server when the output budget ran out", () => {
  const output = renderReviewResult(
    { parsed: null, rawText: '{"verdict":"approve","summary":"an', structured: false, incomplete: true, incompleteReason: "max_output_tokens" },
    META
  );
  assert.match(output, /abgeschnitten/i);
  assert.match(output, /Output-Token-Budget/i);
  assert.doesNotMatch(output, /Schema ignoriert/i);
});

// Die Responses API kennt mehr incomplete_details.reason-Werte als
// "max_output_tokens", z. B. "content_filter". Ohne Unterscheidung nach Grund
// wuerde eine Content-Filter-Abbruch faelschlich als Budget-Erschoepfung gemeldet
// und den Nutzer anweisen, ein Limit zu erhoehen, das nie das Problem war.
test("names a content-filter truncation without claiming the output budget ran out", () => {
  const output = renderReviewResult(
    { parsed: null, rawText: "", structured: false, incomplete: true, incompleteReason: "content_filter" },
    META
  );
  assert.match(output, /abgeschnitten/i);
  assert.match(output, /Content-Filter/i);
  assert.doesNotMatch(output, /Output-Token-Budget/i);
  assert.doesNotMatch(output, /Schema ignoriert/i);
});

// Ein unbekannter oder fehlender Grund darf keine Ursache erfinden -- weder
// "Schema ignoriert" noch "Output-Token-Budget" noch "Content-Filter" treffen
// nachweislich zu, also bleibt nur die ehrliche, generische Meldung.
test("gives an honest generic warning when the incomplete reason is unknown or absent", () => {
  const withUnknownReason = renderReviewResult(
    { parsed: null, rawText: "", structured: false, incomplete: true, incompleteReason: "something_new" },
    META
  );
  assert.match(withUnknownReason, /abgeschnitten/i);
  assert.doesNotMatch(withUnknownReason, /Output-Token-Budget/i);
  assert.doesNotMatch(withUnknownReason, /Content-Filter/i);
  assert.doesNotMatch(withUnknownReason, /Schema ignoriert/i);

  const withoutReason = renderReviewResult(
    { parsed: null, rawText: "", structured: false, incomplete: true, incompleteReason: null },
    META
  );
  assert.match(withoutReason, /abgeschnitten/i);
  assert.doesNotMatch(withoutReason, /Output-Token-Budget/i);
  assert.doesNotMatch(withoutReason, /Content-Filter/i);
  assert.doesNotMatch(withoutReason, /Schema ignoriert/i);
});

test("names omitted and secret files", () => {
  const output = renderReviewResult(
    { parsed: { verdict: "approve", summary: "ok", findings: [], next_steps: [] }, rawText: "", structured: true },
    { ...META, omittedFiles: ["big.js"], secretFiles: [".env"] }
  );
  assert.match(output, /big\.js/);
  assert.match(output, /\.env/);
});

test("status report lists jobs with their state", () => {
  const output = renderStatusReport([
    { id: "job-2", status: "running", startedAt: "2026-09-11T11:00:00.000Z", target: "working tree diff" },
    { id: "job-1", status: "completed", startedAt: "2026-09-11T10:00:00.000Z", target: "branch diff against main" }
  ]);
  assert.match(output, /job-2/);
  assert.match(output, /running/);
  assert.match(output, /job-1/);
});

test("cancel and setup reports render", () => {
  assert.match(renderCancelReport({ id: "job-2", status: "cancelled" }), /job-2/);
  assert.match(
    renderSetupReport({
      baseUrl: "http://127.0.0.1:8000/v1",
      loopback: true,
      reachable: true,
      models: [{ id: "m1", maxModelLen: 262144 }],
      model: "m1"
    }),
    /127\.0\.0\.1:8000/
  );
});

test("loopback warning appears when server is not loopback", () => {
  const withLoopbackFalse = renderSetupReport({
    baseUrl: "http://192.168.1.100:8000/v1",
    loopback: false,
    reachable: true,
    models: [],
    model: "m1"
  });
  assert.match(withLoopbackFalse, /verlaesst diese Maschine/);

  const withLoopbackTrue = renderSetupReport({
    baseUrl: "http://127.0.0.1:8000/v1",
    loopback: true,
    reachable: true,
    models: [],
    model: "m1"
  });
  assert.doesNotMatch(withLoopbackTrue, /verlaesst diese Maschine/);
});
