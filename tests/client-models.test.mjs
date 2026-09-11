import test from "node:test";
import assert from "node:assert/strict";
import { sendJson, startFakeServer } from "./fake-server.mjs";
import {
  ensureModelLoaded,
  getModelStatus,
  listModels,
  resolveBudgetTokens,
  resolveOutputTokens
} from "../plugins/localreview/scripts/lib/client.mjs";

test("lists models with their context length", async () => {
  const server = await startFakeServer(({ req, res }) => {
    assert.equal(req.url, "/v1/models");
    sendJson(res, 200, {
      object: "list",
      data: [{ id: "Qwen3.8-27B-4bit", max_model_len: 262144 }, { id: "other", max_model_len: null }]
    });
  });
  try {
    const models = await listModels({ baseUrl: server.baseUrl });
    assert.deepEqual(models, [
      { id: "Qwen3.8-27B-4bit", maxModelLen: 262144 },
      { id: "other", maxModelLen: null }
    ]);
  } finally {
    await server.close();
  }
});

test("model status returns null when the endpoint is absent", async () => {
  const server = await startFakeServer(({ res }) => sendJson(res, 404, { error: "not found" }));
  try {
    assert.equal(await getModelStatus({ baseUrl: server.baseUrl }, "any"), null);
  } finally {
    await server.close();
  }
});

test("ensureModelLoaded skips cleanly on a generic server", async () => {
  const server = await startFakeServer(({ res }) => sendJson(res, 404, { error: "not found" }));
  try {
    const result = await ensureModelLoaded({ baseUrl: server.baseUrl }, "any");
    assert.deepEqual(result, { warmed: false, skipped: "unsupported" });
  } finally {
    await server.close();
  }
});

test("ensureModelLoaded warms a cold model", async () => {
  const calls = [];
  const server = await startFakeServer(({ req, res }) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === "/v1/models/status") {
      sendJson(res, 200, {
        models: [{ id: "m1", loaded: false, estimated_size: 1_000_000_000 }],
        load_seconds_per_gb_estimate: 0.6
      });
      return;
    }
    sendJson(res, 200, { ok: true });
  });
  try {
    const result = await ensureModelLoaded({ baseUrl: server.baseUrl }, "m1");
    assert.deepEqual(result, { warmed: true, skipped: null });
    assert.ok(calls.includes("POST /v1/models/m1/load"));
  } finally {
    await server.close();
  }
});

test("budget reserves output tokens and falls back without context length", () => {
  const models = [{ id: "big", maxModelLen: 262144 }, { id: "unknown", maxModelLen: null }];
  assert.equal(resolveBudgetTokens(models, "big", {}), 262144 - 32768);
  assert.equal(resolveBudgetTokens(models, "unknown", {}), 32768);
  assert.equal(resolveBudgetTokens(models, "missing", {}), 32768);
});

// Der fallback ist ein Ersatzwert fuer eine unbekannte Kontextlaenge, keine
// Untergrenze. Als Untergrenze kehrte er die Rechnung um: ein Modell mit 8192
// Token Kontext bekam ein Eingabebudget von 32768 -- viermal sein Kontextfenster,
// und der Ueberlauf faellt still aus, weil niemand nachrechnet.
test("a small context window is never floored up to the fallback", () => {
  const models = [{ id: "small", maxModelLen: 8192 }];
  assert.equal(resolveBudgetTokens(models, "small", { reserveTokens: 4096, fallback: 8192 }), 4096);
  assert.equal(resolveBudgetTokens(models, "small", {}), 1024);
});

// Beobachtet gegen den echten oMLX-Server: /v1/models/status meldet pro Modell ein
// max_tokens-Feld -- den harten Output-Ceiling des Modells. getModelStatus muss das
// durchreichen, damit resolveOutputTokens (und darueber requestReview's
// max_output_tokens) diesen realen Wert statt einer erfundenen Konstante nutzt.
test("model status exposes the server's advertised output-token ceiling", async () => {
  const server = await startFakeServer(({ res }) =>
    sendJson(res, 200, { models: [{ id: "m1", loaded: true, max_tokens: 32768 }] })
  );
  try {
    const status = await getModelStatus({ baseUrl: server.baseUrl }, "m1");
    assert.equal(status.maxOutputTokens, 32768);
  } finally {
    await server.close();
  }
});

test("model status reports no output ceiling when the server does not advertise one", async () => {
  const server = await startFakeServer(({ res }) => sendJson(res, 200, { models: [{ id: "m1", loaded: true }] }));
  try {
    const status = await getModelStatus({ baseUrl: server.baseUrl }, "m1");
    assert.equal(status.maxOutputTokens, null);
  } finally {
    await server.close();
  }
});

test("resolveOutputTokens prefers the server's ceiling over the fallback", () => {
  assert.equal(resolveOutputTokens({ maxOutputTokens: 32768 }, {}), 32768);
  assert.equal(resolveOutputTokens({ maxOutputTokens: 4096 }, { fallback: 8_192 }), 4096);
});

// Ein Server ohne /v1/models/status hat nie etwas ueber seine Grenzen gesagt.
// Ihm 32768 Output-Token zuzumuten, weil das Referenzmodell so viel kann, ist
// geraten -- und zwar auf der Seite, auf der es fehlschlaegt.
test("a server that advertises nothing gets the conservative default", () => {
  assert.equal(resolveOutputTokens(null, {}), 8_192);
  assert.equal(resolveOutputTokens({ maxOutputTokens: null }, {}), 8_192);
});

test("the output reserve never claims more than half the context window", () => {
  assert.equal(resolveOutputTokens({ maxOutputTokens: 32768 }, { maxModelLen: 8192 }), 4096);
  assert.equal(resolveOutputTokens(null, { maxModelLen: 8192 }), 4096);
  assert.equal(resolveOutputTokens({ maxOutputTokens: 32768 }, { maxModelLen: 262144 }), 32768);
});
