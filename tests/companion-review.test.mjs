import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { initGitRepo, makeTempDir, run, runAsync } from "./helpers.mjs";
import { sendJson, sendSse, startFakeServer } from "./fake-server.mjs";
import { resolveJobLogFile } from "../plugins/localreview/scripts/lib/state.mjs";

const COMPANION = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "../plugins/localreview/scripts/review-companion.mjs"
);

const REVIEW_JSON = JSON.stringify({
  verdict: "needs-attention",
  summary: "Ein Befund.",
  findings: [
    { severity: "high", title: "Fehlender Test", file: "a.js", line: 1, detail: "kein Test", suggestion: null }
  ],
  next_steps: ["Test schreiben"]
});

async function startReviewServer() {
  return startFakeServer(({ req, res }) => {
    if (req.url === "/v1/models") {
      sendJson(res, 200, { data: [{ id: "m1", max_model_len: 262144 }] });
      return;
    }
    if (req.url === "/v1/models/status") {
      sendJson(res, 200, { models: [{ id: "m1", loaded: true }] });
      return;
    }
    sendSse(res, [
      { type: "response.output_text.delta", data: { delta: REVIEW_JSON } },
      { type: "response.completed", data: {} }
    ]);
  });
}

function makeDirtyRepo() {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "const a = 1;\n", "utf8");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), "const a = 2;\n", "utf8");
  return cwd;
}

// resolveJobLogFile resolves its state directory from process.env.CLAUDE_PLUGIN_DATA
// of the CURRENT process, same as upsertJob/writeJobFile in companion-jobs.test.mjs —
// so reading a log file the child wrote requires pointing this process at the same
// CLAUDE_PLUGIN_DATA the child saw.
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

// Two ~90 KB staged files (~45_000 tokens) push the assembled diff past the
// budget resolveBudgetTokens falls back to when /v1/models advertises no
// max_model_len — while staying under the 256 KB inline-diff byte cap and the
// 2-file inline-diff file cap, so collectReviewContext still hands
// buildReviewPayload the real diff instead of falling back to its own
// lightweight (non-diff) context first.
function makeOverBudgetRepo() {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "seed.js"), "const seed = 1;\n", "utf8");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  // Gross, aber normal umbrochen: gemeint ist "sprengt das Token-Budget", nicht
  // "ist maschinell erzeugt". Als ein einziger 90.000-Zeichen-Zeile schriebe das
  // Fixture ungewollt den zweiten Fall hin, und isGeneratedContent wuerde beide
  // Dateien aus dem Fan-out nehmen -- der Map-Reduce-Pfad bliebe ungeprueft.
  fs.writeFileSync(path.join(cwd, "bigfile1.txt"), `${"a".repeat(89)}\n`.repeat(1_000), "utf8");
  fs.writeFileSync(path.join(cwd, "bigfile2.txt"), `${"b".repeat(89)}\n`.repeat(1_000), "utf8");
  run("git", ["add", "bigfile1.txt", "bigfile2.txt"], { cwd });
  return cwd;
}

function isReduceCall(body) {
  return (body?.instructions ?? "").includes("Teil-Reviews eines einzelnen Branches");
}

function perFileText(body) {
  return body?.input?.[0]?.content?.[0]?.text ?? "";
}

test("runs a review end to end and stores the result", async () => {
  const server = await startReviewServer();
  const cwd = makeDirtyRepo();
  const dataDir = makeTempDir();
  try {
    // runAsync, not run: this test hosts the fake server in this same process, and
    // a synchronous spawnSync child here would block the event loop the server's
    // request handler needs to run on (see helpers.mjs).
    const result = await runAsync("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], {
      env: {
        ...process.env,
        LOCALREVIEW_BASE_URL: server.baseUrl,
        LOCALREVIEW_MODEL: "m1",
        CLAUDE_PLUGIN_DATA: dataDir
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.verdict, "needs-attention");
    assert.match(payload.rendered, /Fehlender Test/);
    assert.ok(fs.existsSync(payload.resultFile));
  } finally {
    await server.close();
  }
});

// Der Endpunkt-Beweis fuer C2: ein Server ohne Schema-Unterstuetzung (LM Studio
// tut genau das) antwortet in Prosa mit drei echten Befunden, und darin steht ein
// zitiertes JSON-Fragment. Vor dem Formcheck wurde das Fragment zum Ergebnis
// befoerdert und der Nutzer sah "Ergebnis: undefined / Befunde: Keine." -- die
// Befunde des Modells waren weg.
// Spec Abschnitt 5, Schritt 4: SSE-Deltas werden zu Fortschritt im Job-Log.
// Bisher geschah das nur im Map-Reduce-Fallback; auf dem normalen Pfad -- dem
// haeufigen -- entstand nicht einmal eine Log-Datei, und /localreview:status
// zeigte waehrend eines minutenlangen Laufs nur "running".
test("logs progress on the normal review path", async () => {
  const server = await startFakeServer(({ req, res }) => {
    if (req.url === "/v1/models") {
      sendJson(res, 200, { data: [{ id: "m1", max_model_len: 262144 }] });
      return;
    }
    if (req.url === "/v1/models/status") {
      // Nicht geladen: die Vorwaermmeldung samt geschaetzter Ladezeit muss
      // ebenfalls im Log landen, sonst laedt ein kaltes Modell ohne Lebenszeichen.
      sendJson(res, 200, {
        models: [{ id: "m1", loaded: false, estimated_size: 2_000_000_000 }],
        load_seconds_per_gb_estimate: 3
      });
      return;
    }
    if (req.url === "/v1/models/m1/load") {
      sendJson(res, 200, { ok: true });
      return;
    }
    sendSse(res, [
      { type: "response.output_text.delta", data: { delta: REVIEW_JSON } },
      { type: "response.completed", data: {} }
    ]);
  });

  const cwd = makeDirtyRepo();
  const dataDir = makeTempDir();
  try {
    const result = await runAsync("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], {
      env: {
        ...process.env,
        LOCALREVIEW_BASE_URL: server.baseUrl,
        LOCALREVIEW_MODEL: "m1",
        CLAUDE_PLUGIN_DATA: dataDir
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    withPluginDataEnv(dataDir, () => {
      const logContent = fs.readFileSync(resolveJobLogFile(cwd, payload.jobId), "utf8");
      assert.match(logContent, /Review gestartet/);
      assert.match(logContent, /Modell m1 wird geladen, geschaetzt 6s/);
      assert.match(logContent, /Textabschnitte empfangen/);
      assert.match(logContent, /Review abgeschlossen: needs-attention/);
    });
  } finally {
    await server.close();
  }
});

// Spec Abschnitt 9: Verbindungsabriss im Stream -> Teilausgabe ins Job-Log, Job
// failed. Ohne das bleibt vom Abbruch nur die Fehlermeldung, und die Minuten
// Modellzeit, die schon geflossen sind, sind spurlos weg.
test("keeps the partial output in the job log when the stream breaks", async () => {
  const server = await startFakeServer(({ req, res }) => {
    if (req.url === "/v1/models") {
      sendJson(res, 200, { data: [{ id: "m1", max_model_len: 262144 }] });
      return;
    }
    if (req.url === "/v1/models/status") {
      sendJson(res, 200, { models: [{ id: "m1", loaded: true }] });
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    // destroy() erst im write-Callback, sonst gewinnt das Verbindungsende gegen
    // die Header-Zustellung und der Body-Stream wird nie geoeffnet (siehe
    // client-review.test.mjs).
    res.write(
      `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: '{"verdict":"needs-attention","summ' })}\n\n`,
      () => res.destroy()
    );
  });

  const cwd = makeDirtyRepo();
  const dataDir = makeTempDir();
  try {
    const result = await runAsync("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], {
      env: {
        ...process.env,
        LOCALREVIEW_BASE_URL: server.baseUrl,
        LOCALREVIEW_MODEL: "m1",
        CLAUDE_PLUGIN_DATA: dataDir
      }
    });
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);

    withPluginDataEnv(dataDir, () => {
      const logContent = fs.readFileSync(resolveJobLogFile(cwd, payload.jobId), "utf8");
      assert.match(logContent, /Teilausgabe vor dem Abbruch/);
      assert.match(logContent, /needs-attention/);
      assert.match(logContent, /Review fehlgeschlagen/);
    });
  } finally {
    await server.close();
  }
});

test("shows the prose findings when the server answers in prose containing a json snippet", async () => {
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

  const server = await startFakeServer(({ req, res }) => {
    if (req.url === "/v1/models") {
      sendJson(res, 200, { data: [{ id: "m1", max_model_len: 262144 }] });
      return;
    }
    if (req.url === "/v1/models/status") {
      sendJson(res, 200, { models: [{ id: "m1", loaded: true }] });
      return;
    }
    sendSse(res, [
      { type: "response.output_text.delta", data: { delta: prose } },
      { type: "response.completed", data: {} }
    ]);
  });

  const cwd = makeDirtyRepo();
  const dataDir = makeTempDir();
  try {
    const result = await runAsync("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], {
      env: {
        ...process.env,
        LOCALREVIEW_BASE_URL: server.baseUrl,
        LOCALREVIEW_MODEL: "m1",
        CLAUDE_PLUGIN_DATA: dataDir
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verdict, null);
    assert.match(payload.rendered, /SQL-Injection/);
    assert.match(payload.rendered, /Fehlende Fehlerbehandlung/);
    assert.match(payload.rendered, /strukturierte Ausgabe nicht unterstuetzt/i);
    assert.doesNotMatch(payload.rendered, /Keine\./);
    assert.doesNotMatch(payload.rendered, /undefined/);
  } finally {
    await server.close();
  }
});

test("reports a clear error when the server is unreachable", () => {
  const cwd = makeDirtyRepo();
  const dataDir = makeTempDir();
  const result = run("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], {
    env: {
      ...process.env,
      LOCALREVIEW_BASE_URL: "http://127.0.0.1:1/v1",
      LOCALREVIEW_MODEL: "m1",
      CLAUDE_PLUGIN_DATA: dataDir
    }
  });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /nicht erreichbar|LOCALREVIEW_BASE_URL/);
});

// Laeuft die Deadline ab, kommt ein AbortError mit der englischen Standardmeldung
// "This operation was aborted" -- ohne Ursache und ununterscheidbar von einem
// Abbruch durch den Nutzer. Der Job muss stattdessen sagen, welches Limit griff
// und wie man es anhebt.
test("names the deadline when the time limit expires", { timeout: 20_000 }, async () => {
  const server = await startFakeServer(({ req, res }) => {
    if (req.url === "/v1/models") {
      sendJson(res, 200, { data: [{ id: "m1", max_model_len: 262144 }] });
      return;
    }
    if (req.url === "/v1/models/status") {
      sendJson(res, 200, { models: [{ id: "m1", loaded: true }] });
      return;
    }
    // Antwortet nie: der Review laeuft in die Deadline.
    res.writeHead(200, { "content-type": "text/event-stream" });
  });

  const cwd = makeDirtyRepo();
  const dataDir = makeTempDir();
  try {
    const result = await runAsync("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], {
      env: {
        ...process.env,
        LOCALREVIEW_BASE_URL: server.baseUrl,
        LOCALREVIEW_MODEL: "m1",
        LOCALREVIEW_DEADLINE_MS: "1500",
        CLAUDE_PLUGIN_DATA: dataDir
      }
    });
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Zeitlimit von 2s/);
    assert.match(payload.error, /LOCALREVIEW_DEADLINE_MS/);
    assert.doesNotMatch(payload.error, /aborted/i);
  } finally {
    await server.close();
  }
});

// Der wahrscheinlichste Fehler beim ersten Start: kein Modell gesetzt und der
// Server meldet auch keines. Die Meldung muss sagen, was zu tun ist.
test("names a remedy when no model is configured and the server offers none", async () => {
  const server = await startFakeServer(({ req, res }) => {
    if (req.url === "/v1/models") {
      sendJson(res, 200, { data: [] });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });

  const cwd = makeDirtyRepo();
  const dataDir = makeTempDir();
  try {
    const result = await runAsync("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], {
      env: { ...process.env, LOCALREVIEW_BASE_URL: server.baseUrl, CLAUDE_PLUGIN_DATA: dataDir }
    });
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.error, /Kein Modell konfiguriert/);
    assert.match(payload.error, /LOCALREVIEW_MODEL/);
    assert.match(payload.error, /localreview:setup/);
  } finally {
    await server.close();
  }
});

// Spec Abschnitt 9: "Unbekannte Modell-ID | Fehlermeldung samt Liste aus
// /v1/models". Die Liste liegt zu diesem Zeitpunkt schon vor.
test("lists the available models when the configured one is unknown", async () => {
  const server = await startFakeServer(({ req, res }) => {
    if (req.url === "/v1/models") {
      sendJson(res, 200, { data: [{ id: "m1", max_model_len: 262144 }, { id: "m2", max_model_len: 8192 }] });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });

  const cwd = makeDirtyRepo();
  const dataDir = makeTempDir();
  try {
    const result = await runAsync("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], {
      env: {
        ...process.env,
        LOCALREVIEW_BASE_URL: server.baseUrl,
        LOCALREVIEW_MODEL: "gibt-es-nicht",
        CLAUDE_PLUGIN_DATA: dataDir
      }
    });
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.error, /gibt-es-nicht/);
    assert.match(payload.error, /m1, m2/);
  } finally {
    await server.close();
  }
});

// R19 leitete das Output-Ceiling aus /v1/models/status ab. Server ohne diesen
// Endpunkt fielen damit auf 32768 -- unbesehen und mehr als das Kontextfenster
// eines kleinen Modells ueberhaupt hergibt. Ein lokales Modell mit kleinem
// Kontext ist ein voellig gewoehnlicher Fall.
test("keeps the output reserve inside a small context window", async () => {
  let reviewBody = null;
  const server = await startFakeServer(({ req, res, body }) => {
    if (req.url === "/v1/models") {
      sendJson(res, 200, { data: [{ id: "m1", max_model_len: 8192 }] });
      return;
    }
    if (req.url === "/v1/models/status") {
      // Generischer Server: kein status-Endpunkt.
      sendJson(res, 404, { error: "not found" });
      return;
    }
    reviewBody = body;
    sendSse(res, [
      { type: "response.output_text.delta", data: { delta: REVIEW_JSON } },
      { type: "response.completed", data: {} }
    ]);
  });

  const cwd = makeDirtyRepo();
  const dataDir = makeTempDir();
  try {
    const result = await runAsync("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], {
      env: {
        ...process.env,
        LOCALREVIEW_BASE_URL: server.baseUrl,
        LOCALREVIEW_MODEL: "m1",
        CLAUDE_PLUGIN_DATA: dataDir
      }
    });
    assert.equal(result.status, 0, result.stderr);
    // Die Haelfte des Kontextfensters, nicht das Vierfache davon.
    assert.equal(reviewBody.max_output_tokens, 4096);
  } finally {
    await server.close();
  }
});

test("exits cleanly when there is nothing to review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "const a = 1;\n", "utf8");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  const dataDir = makeTempDir();

  const result = run("node", [COMPANION, "review", "--json", "--wait", "--scope", "working-tree", "--cwd", cwd], {
    env: { ...process.env, LOCALREVIEW_BASE_URL: "http://127.0.0.1:1/v1", CLAUDE_PLUGIN_DATA: dataDir }
  });
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.nothingToReview, true);
});

test("falls back to a per-file map-reduce review when the diff exceeds the token budget, and logs progress", async () => {
  const requests = [];
  const server = await startFakeServer(({ req, res, body }) => {
    if (req.url === "/v1/models") {
      // No max_model_len and no /v1/models/status: both budgets fall back to the
      // conservative 8_192 default, which the two ~90 KB staged files far exceed.
      sendJson(res, 200, { data: [{ id: "m1" }] });
      return;
    }
    if (req.url === "/v1/models/status") {
      sendJson(res, 200, { models: [{ id: "m1", loaded: true }] });
      return;
    }
    requests.push(body);
    if (isReduceCall(body)) {
      sendSse(res, [
        {
          type: "response.output_text.delta",
          data: {
            delta: JSON.stringify({
              verdict: "approve",
              summary: "Zusammengefasste Bewertung ueber beide Dateien.",
              findings: [],
              next_steps: ["Reduce-next-step"]
            })
          }
        },
        { type: "response.completed", data: {} }
      ]);
      return;
    }
    const forFile1 = perFileText(body).includes("bigfile1.txt");
    const perFileJson = JSON.stringify(
      forFile1
        ? {
            verdict: "needs-attention",
            summary: "Befund in Datei 1.",
            findings: [
              { severity: "high", title: "Finding-1", file: "bigfile1.txt", line: 1, detail: "d1", suggestion: null }
            ],
            next_steps: ["Step-1"]
          }
        : { verdict: "approve", summary: "Datei 2 ist sauber.", findings: [], next_steps: [] }
    );
    sendSse(res, [
      { type: "response.output_text.delta", data: { delta: perFileJson } },
      { type: "response.completed", data: {} }
    ]);
  });

  const cwd = makeOverBudgetRepo();
  const dataDir = makeTempDir();
  try {
    const result = await runAsync("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], {
      env: {
        ...process.env,
        LOCALREVIEW_BASE_URL: server.baseUrl,
        LOCALREVIEW_MODEL: "m1",
        CLAUDE_PLUGIN_DATA: dataDir
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);

    // One /responses call per non-secret changed file, plus one reduce call.
    assert.equal(requests.length, 3);

    // The findings below must be exactly what the per-file calls reported —
    // the reduce call only contributed summary/next_steps.
    assert.equal(payload.verdict, "needs-attention");
    assert.match(payload.rendered, /Finding-1/);
    assert.match(payload.rendered, /Zusammengefasste Bewertung ueber beide Dateien\./);
    assert.match(payload.rendered, /Reduce-next-step/);
    assert.ok(fs.existsSync(payload.resultFile));

    // Beide Dateien wurden je mit einem eigenen Call reviewt. Die Buchhaltung des
    // verworfenen Gesamt-Payloads haette beide als "aus Platzgruenden ausgelassen"
    // gemeldet -- der Report haette also behauptet, nichts geprueft zu haben.
    assert.doesNotMatch(payload.rendered, /Aus Platzgruenden ausgelassen/);

    withPluginDataEnv(dataDir, () => {
      const logFile = resolveJobLogFile(cwd, payload.jobId);
      const logContent = fs.readFileSync(logFile, "utf8");
      assert.match(logContent, /Teil-Review 1\/2: bigfile1\.txt/);
      assert.match(logContent, /Teil-Review 2\/2: bigfile2\.txt/);
    });
  } finally {
    await server.close();
  }
});

test("keeps the verdict honest when a per-file result cannot be parsed", async () => {
  const server = await startFakeServer(({ req, res, body }) => {
    if (req.url === "/v1/models") {
      sendJson(res, 200, { data: [{ id: "m1" }] });
      return;
    }
    if (req.url === "/v1/models/status") {
      sendJson(res, 200, { models: [{ id: "m1", loaded: true }] });
      return;
    }
    if (isReduceCall(body)) {
      sendSse(res, [
        {
          type: "response.output_text.delta",
          data: { delta: JSON.stringify({ verdict: "approve", summary: "Zusammenfassung.", findings: [], next_steps: [] }) }
        },
        { type: "response.completed", data: {} }
      ]);
      return;
    }
    if (perFileText(body).includes("bigfile1.txt")) {
      // Garbled, unparseable response for this file — no JSON at all.
      sendSse(res, [
        { type: "response.output_text.delta", data: { delta: "Ich kann diese Datei nicht bewerten." } },
        { type: "response.completed", data: {} }
      ]);
      return;
    }
    sendSse(res, [
      {
        type: "response.output_text.delta",
        data: { delta: JSON.stringify({ verdict: "approve", summary: "Datei 2 ist sauber.", findings: [], next_steps: [] }) }
      },
      { type: "response.completed", data: {} }
    ]);
  });

  const cwd = makeOverBudgetRepo();
  const dataDir = makeTempDir();
  try {
    const result = await runAsync("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], {
      env: {
        ...process.env,
        LOCALREVIEW_BASE_URL: server.baseUrl,
        LOCALREVIEW_MODEL: "m1",
        CLAUDE_PLUGIN_DATA: dataDir
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    // Every file that produced a usable result said "approve" — but bigfile1.txt
    // was never actually reviewed, so the run must not present a clean bill of health.
    assert.equal(payload.verdict, "needs-attention");
    assert.match(payload.rendered, /bigfile1\.txt/);
  } finally {
    await server.close();
  }
});

test("fails clearly when no per-file result can be parsed", async () => {
  const server = await startFakeServer(({ req, res }) => {
    if (req.url === "/v1/models") {
      sendJson(res, 200, { data: [{ id: "m1" }] });
      return;
    }
    if (req.url === "/v1/models/status") {
      sendJson(res, 200, { models: [{ id: "m1", loaded: true }] });
      return;
    }
    sendSse(res, [
      { type: "response.output_text.delta", data: { delta: "Keine verwertbare Antwort." } },
      { type: "response.completed", data: {} }
    ]);
  });

  const cwd = makeOverBudgetRepo();
  const dataDir = makeTempDir();
  try {
    const result = await runAsync("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], {
      env: {
        ...process.env,
        LOCALREVIEW_BASE_URL: server.baseUrl,
        LOCALREVIEW_MODEL: "m1",
        CLAUDE_PLUGIN_DATA: dataDir
      }
    });
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /verwertbare Antwort/i);
  } finally {
    await server.close();
  }
});

test("keeps merged findings when the reduce call fails", async () => {
  const server = await startFakeServer(({ req, res, body }) => {
    if (req.url === "/v1/models") {
      sendJson(res, 200, { data: [{ id: "m1" }] });
      return;
    }
    if (req.url === "/v1/models/status") {
      sendJson(res, 200, { models: [{ id: "m1", loaded: true }] });
      return;
    }
    if (isReduceCall(body)) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
      return;
    }
    const forFile1 = perFileText(body).includes("bigfile1.txt");
    const perFileJson = JSON.stringify(
      forFile1
        ? {
            verdict: "needs-attention",
            summary: "Befund in Datei 1.",
            findings: [
              { severity: "high", title: "Finding-1", file: "bigfile1.txt", line: 1, detail: "d1", suggestion: null }
            ],
            next_steps: ["Step-1"]
          }
        : { verdict: "approve", summary: "Datei 2 ist sauber.", findings: [], next_steps: [] }
    );
    sendSse(res, [
      { type: "response.output_text.delta", data: { delta: perFileJson } },
      { type: "response.completed", data: {} }
    ]);
  });

  const cwd = makeOverBudgetRepo();
  const dataDir = makeTempDir();
  try {
    const result = await runAsync("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], {
      env: {
        ...process.env,
        LOCALREVIEW_BASE_URL: server.baseUrl,
        LOCALREVIEW_MODEL: "m1",
        CLAUDE_PLUGIN_DATA: dataDir
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.verdict, "needs-attention");
    assert.match(payload.rendered, /Finding-1/);
    assert.ok(fs.existsSync(payload.resultFile));
  } finally {
    await server.close();
  }
});
