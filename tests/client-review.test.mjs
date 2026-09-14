import test from "node:test";
import assert from "node:assert/strict";
import { sendSse, startFakeServer } from "./fake-server.mjs";
import {
  ReviewTransportError,
  extractJsonBlock,
  isReviewShape,
  requestReview
} from "../plugins/localreview/scripts/lib/client.mjs";

const SCHEMA = { type: "object", additionalProperties: false, required: ["verdict"], properties: { verdict: { type: "string" } } };

// Ein Ergebnis wird nur als Review akzeptiert, wenn es auch wie eines aussieht
// (verdict aus dem Enum, findings ein Array) -- siehe isReviewShape. Die
// Fixtures hier bilden deshalb die Form ab, die ein schemakonformer Server
// liefert, statt nur das eine Feld, das die Assertion prueft.
const APPROVED = { verdict: "approve", summary: "ok", findings: [], next_steps: [] };
const FLAGGED = { verdict: "needs-attention", summary: "Befund", findings: [], next_steps: [] };

function textEvents(text) {
  return [
    { type: "response.created", data: {} },
    { type: "response.output_text.delta", data: { delta: text } },
    { type: "response.completed", data: {} }
  ];
}

test("extracts a fenced json block", () => {
  assert.deepEqual(extractJsonBlock('Vorwort\n```json\n{"verdict":"approve"}\n```\nNachwort'), {
    verdict: "approve"
  });
  assert.equal(extractJsonBlock("kein json hier"), null);
});

test("recognizes a review result by its shape", () => {
  assert.equal(isReviewShape(APPROVED), true);
  assert.equal(isReviewShape({ verdict: "approve" }), false);
  assert.equal(isReviewShape({ verdict: "vielleicht", findings: [] }), false);
  assert.equal(isReviewShape({ error: "model not loaded" }), false);
  assert.equal(isReviewShape([APPROVED]), false);
  assert.equal(isReviewShape(null), false);
});

test("returns parsed json when the server honours the schema", async () => {
  let received = null;
  const server = await startFakeServer(({ res, body }) => {
    received = body;
    sendSse(res, textEvents(JSON.stringify(APPROVED)));
  });
  try {
    const result = await requestReview(
      { baseUrl: server.baseUrl },
      { model: "m1", instructions: "sei streng", payload: "diff", schema: SCHEMA }
    );
    assert.deepEqual(result.parsed, APPROVED);
    assert.equal(result.structured, true);
    assert.equal(received.stream, true);
    assert.equal(received.text.format.type, "json_schema");
    assert.equal(received.text.format.strict, true);
  } finally {
    await server.close();
  }
});

test("falls back to a fenced block when the schema was ignored", async () => {
  const server = await startFakeServer(({ res }) =>
    sendSse(res, textEvents(`Hier mein Review:\n\`\`\`json\n${JSON.stringify(FLAGGED)}\n\`\`\``))
  );
  try {
    const result = await requestReview(
      { baseUrl: server.baseUrl },
      { model: "m1", instructions: "x", payload: "y", schema: SCHEMA }
    );
    assert.deepEqual(result.parsed, FLAGGED);
    assert.equal(result.structured, false);
    assert.equal(result.incomplete, false);
  } finally {
    await server.close();
  }
});

// Signal empirisch gegen den echten oMLX-Server (Qwen3.8-27B-4bit) beobachtet: ein
// als incomplete beendeter Response-Stream sendet vor dem Verbindungsende ein
// response.incomplete-Event mit incomplete_details.reason "max_output_tokens" --
// und zwar zusaetzlich zu, nicht statt, den bereits gesendeten output_text.delta-
// Events. requestReview muss dieses Signal von einem Server unterscheiden, der das
// Schema schlicht ignoriert (die vorige Testgruppe), damit render.mjs den Nutzer
// nicht faelschlich auf den Server verweist.
test("flags a response cut short by the output-token budget as incomplete", async () => {
  const server = await startFakeServer(({ res }) =>
    sendSse(res, [
      { type: "response.output_text.delta", data: { delta: '{"verdict":"approve","summary":"an' } },
      {
        type: "response.incomplete",
        data: { response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }
      }
    ])
  );
  try {
    const result = await requestReview(
      { baseUrl: server.baseUrl },
      { model: "m1", instructions: "x", payload: "y", schema: SCHEMA }
    );
    assert.equal(result.parsed, null);
    assert.equal(result.structured, false);
    assert.equal(result.incomplete, true);
    assert.equal(result.incompleteReason, "max_output_tokens");
  } finally {
    await server.close();
  }
});

// Der Fall, der drei echte Befunde vernichtet hat: ein Server ohne
// Schema-Unterstuetzung antwortet in Prosa, und diese Prosa enthaelt -- voellig
// gewoehnlich fuer ein Review -- ein zitiertes JSON-Fragment. Wird das Fragment
// zum Ergebnis befoerdert, verwirft render.mjs den Prosatext und meldet
// "Keine Befunde".
test("does not mistake a quoted json snippet in prose for the review result", async () => {
  const prose = [
    "Ich habe drei Probleme gefunden:",
    "",
    "1. SQL-Injection in db.js Zeile 42.",
    "2. Hart kodiertes Passwort in config.js, hier der Auszug:",
    "",
    '```json',
    '{"user":"admin","pass":"hunter2"}',
    '```',
    "",
    "3. Fehlende Fehlerbehandlung in api.js."
  ].join("\n");
  const server = await startFakeServer(({ res }) => sendSse(res, textEvents(prose)));
  try {
    const result = await requestReview(
      { baseUrl: server.baseUrl },
      { model: "m1", instructions: "x", payload: "y", schema: SCHEMA }
    );
    assert.equal(result.parsed, null);
    assert.equal(result.structured, false);
    assert.match(result.rawText, /SQL-Injection/);
    assert.match(result.rawText, /Fehlende Fehlerbehandlung/);
  } finally {
    await server.close();
  }
});

// Dieselbe Luecke laesst auch ein schemakonform aussehendes, aber voellig
// anderes Objekt als Review durchgehen -- ein Server-Fehler im Textstream etwa
// rendert sonst als bestandener Review mit "Ergebnis: undefined".
test("does not mistake a server error object for a review result", async () => {
  const server = await startFakeServer(({ res }) =>
    sendSse(res, textEvents(JSON.stringify({ error: "model not loaded" })))
  );
  try {
    const result = await requestReview(
      { baseUrl: server.baseUrl },
      { model: "m1", instructions: "x", payload: "y", schema: SCHEMA }
    );
    assert.equal(result.parsed, null);
    assert.match(result.rawText, /model not loaded/);
  } finally {
    await server.close();
  }
});

test("passes prose through when nothing parses", async () => {
  const server = await startFakeServer(({ res }) => sendSse(res, textEvents("Das sieht solide aus.")));
  try {
    const result = await requestReview(
      { baseUrl: server.baseUrl },
      { model: "m1", instructions: "x", payload: "y", schema: SCHEMA }
    );
    assert.equal(result.parsed, null);
    assert.equal(result.structured, false);
    assert.match(result.rawText, /solide/);
  } finally {
    await server.close();
  }
});

// Ein HTTP-Fehlerstatus ohne den Body des Servers ist eine nackte Zahl: die
// Begruendung -- unbekanntes Modell, Token-Ceiling ueberschritten, Feld nicht
// unterstuetzt -- steht genau dort und wurde bisher verworfen.
test("carries the server's explanation of an http error", async () => {
  const server = await startFakeServer(({ res }) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "max_output_tokens exceeds model limit of 8192" } }));
  });
  try {
    await assert.rejects(
      requestReview({ baseUrl: server.baseUrl }, { model: "m1", instructions: "x", payload: "y", schema: SCHEMA }),
      (error) =>
        error instanceof ReviewTransportError &&
        error.kind === "http" &&
        /HTTP 400/.test(error.message) &&
        /exceeds model limit of 8192/.test(error.message)
    );
  } finally {
    await server.close();
  }
});

test("reports how many tokens arrived before a broken stream", async () => {
  const server = await startFakeServer(({ res }) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    // res.destroy() erst im write-Callback: Node/undici liefert den fetch()-Header
    // nur zu, wenn dieser Chunk tatsaechlich an den Socket geflusht wurde, bevor
    // die Verbindung abreisst. Ohne den Callback gewinnt bei destroy() im selben
    // Tick fast immer das Verbindungsende (fetch() selbst wirft "other side
    // closed"), und der Body-Stream wird nie geoeffnet -- der Test wuerde dann
    // nie den beabsichtigten "Abbruch mitten im Stream"-Pfad pruefen.
    res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "teil" })}\n\n`, () => {
      res.destroy();
    });
  });
  try {
    await assert.rejects(
      requestReview({ baseUrl: server.baseUrl }, { model: "m1", instructions: "x", payload: "y", schema: SCHEMA }),
      (error) => error instanceof ReviewTransportError && error.kind === "stream" && error.tokensSeen > 0
    );
  } finally {
    await server.close();
  }
});

test("aborts on signal", { timeout: 5000 }, async () => {
  const server = await startFakeServer(({ res }) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(
      requestReview(
        { baseUrl: server.baseUrl },
        { model: "m1", instructions: "x", payload: "y", schema: SCHEMA, signal: controller.signal }
      ),
      /abort/i
    );
  } finally {
    await server.close();
  }
});

// Der Fehler, der diese Umstellung ausgeloest hat: fetch laeuft ueber undici,
// und undici bricht jeden Response-Body ab, der 300 Sekunden lang kein Byte
// liefert -- UND_ERR_BODY_TIMEOUT, nach aussen nur "terminated". Genau so
// verhaelt sich ein Server, der einen grossen Prompt prefillt: Header sofort,
// danach minutenlang Stille. Der Test kann keine 300 Sekunden warten; er haelt
// fest, dass ein Body, der erst nach einer Pause einsetzt, ueberhaupt
// durchlaeuft -- und schlaegt an, sobald jemand dem Transport wieder ein kurzes
// Body-Timeout verpasst.
test("survives a body that stays silent after the headers", async () => {
  const server = await startFakeServer(({ res }) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    setTimeout(() => {
      for (const event of textEvents(JSON.stringify(APPROVED))) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }
      res.end();
    }, 400);
  });
  try {
    const result = await requestReview(
      { baseUrl: server.baseUrl },
      { model: "m1", instructions: "x", payload: "y", schema: SCHEMA }
    );
    assert.deepEqual(result.parsed, APPROVED);
  } finally {
    await server.close();
  }
});

// Das Deadline-Signal ist nach der Umstellung die einzige verbliebene Grenze.
// Reisst es den Socket auf, meldet der Response-Stream je nach Zeitpunkt einen
// ECONNRESET -- der Aufrufer unterscheidet Zeitlimit und Nutzerabbruch aber am
// Namen AbortError, und ein Serverfehler an dieser Stelle wuerde den Nutzer auf
// die falsche Faehrte schicken.
test("reports an aborted stream as AbortError, not as a server failure", async () => {
  const controller = new AbortController();
  let open = null;
  const server = await startFakeServer(({ res }) => {
    open = res;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: response.created\ndata: {}\n\n");
    setTimeout(() => controller.abort(), 100);
  });
  try {
    await assert.rejects(
      requestReview(
        { baseUrl: server.baseUrl },
        { model: "m1", instructions: "x", payload: "y", schema: SCHEMA, signal: controller.signal }
      ),
      (error) => error.name === "AbortError"
    );
  } finally {
    // Der Client ist weg, die Antwort des Fake-Servers bleibt sonst offen und
    // server.close() wartet auf eine Verbindung, die niemand mehr beendet.
    open?.destroy();
    await server.close();
  }
});

// Vor der Umstellung verhinderte redirect: "error", dass der Review-Payload
// einem umgeleiteten Ziel hinterhergetragen wird. node:http folgt von sich aus
// keiner Weiterleitung -- der Test haelt fest, dass sie als Fehler ankommt und
// nicht stillschweigend verfolgt wird.
test("does not follow a redirect away from the configured server", async () => {
  const server = await startFakeServer(({ res }) => {
    res.writeHead(302, { location: "http://example.invalid/v1/responses" });
    res.end();
  });
  try {
    await assert.rejects(
      requestReview({ baseUrl: server.baseUrl }, { model: "m1", instructions: "x", payload: "y", schema: SCHEMA }),
      (error) => error instanceof ReviewTransportError && error.kind === "http" && /HTTP 302/.test(error.message)
    );
  } finally {
    await server.close();
  }
});
