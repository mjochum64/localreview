import { REVIEW_SCHEMA_NAME } from "./prompts.mjs";

const JSON_HEADERS = { "content-type": "application/json" };

function endpoint(config, suffix) {
  return `${String(config.baseUrl).replace(/\/+$/, "")}${suffix}`;
}

// Jeder OpenAI-kompatible Server begruendet einen Fehlerstatus im Body:
// unbekannte Modell-ID, max_output_tokens ueber dem Ceiling des Modells, ein
// nicht unterstuetztes Feld in text.format, Modell nicht geladen. Ohne den Body
// bleibt dem Nutzer eine nackte Zahl, waehrend die Diagnose direkt vorlag.
// Gedeckelt, weil manche Server ganze HTML-Fehlerseiten liefern.
async function readErrorDetail(response) {
  try {
    const body = (await response.text()).trim();
    return body ? ` ${body.slice(0, 500)}` : "";
  } catch {
    return "";
  }
}

async function requestJson(config, suffix, { method = "GET", body = null, signal } = {}) {
  let response;
  try {
    response = await fetch(endpoint(config, suffix), {
      method,
      signal,
      redirect: "error",
      headers: body ? JSON_HEADERS : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw error;
    }
    throw new ReviewTransportError(`Server nicht erreichbar: ${error.message}`, {
      kind: "unreachable",
      cause: error
    });
  }
  if (response.status === 404) {
    return { missing: true, value: null };
  }
  if (!response.ok) {
    throw new Error(`${method} ${suffix} scheiterte mit HTTP ${response.status}.${await readErrorDetail(response)}`);
  }
  return { missing: false, value: await response.json() };
}

export async function listModels(config, { signal } = {}) {
  const { missing, value } = await requestJson(config, "/models", { signal });
  if (missing) {
    return [];
  }
  return (value?.data ?? []).map((entry) => ({
    id: entry.id,
    maxModelLen: typeof entry.max_model_len === "number" ? entry.max_model_len : null
  }));
}

export async function getModelStatus(config, modelId, { signal } = {}) {
  const { missing, value } = await requestJson(config, "/models/status", { signal });
  if (missing) {
    return null;
  }
  const entry = (value?.models ?? []).find((model) => model.id === modelId);
  if (!entry) {
    return null;
  }
  return {
    loaded: entry.loaded === true,
    sizeBytes: typeof entry.estimated_size === "number" ? entry.estimated_size : null,
    loadSecondsPerGb:
      typeof value.load_seconds_per_gb_estimate === "number" ? value.load_seconds_per_gb_estimate : null,
    maxOutputTokens: typeof entry.max_tokens === "number" ? entry.max_tokens : null
  };
}

export async function ensureModelLoaded(config, modelId, { signal, onProgress } = {}) {
  const status = await getModelStatus(config, modelId, { signal });
  if (status === null) {
    return { warmed: false, skipped: "unsupported" };
  }
  if (status.loaded) {
    return { warmed: false, skipped: null };
  }
  const seconds =
    status.sizeBytes && status.loadSecondsPerGb
      ? Math.round((status.sizeBytes / 1_000_000_000) * status.loadSecondsPerGb)
      : null;
  onProgress?.(seconds ? `Modell ${modelId} wird geladen, geschaetzt ${seconds}s.` : `Modell ${modelId} wird geladen.`);
  await requestJson(config, `/models/${encodeURIComponent(modelId)}/load`, { method: "POST", body: {}, signal });
  return { warmed: true, skipped: null };
}

// fallback greift nur, wenn die Kontextlaenge UNBEKANNT ist. Als Untergrenze
// verwendet -- das frueher hier stehende Math.max(fallback, ...) -- kehrte er die
// Rechnung um: ein Server, der 8192 Token Kontext meldet, bekam
// max(32768, 8192 - 32768) = 32768, also ein Eingabebudget viermal so gross wie
// sein ganzes Kontextfenster. Ist die Laenge bekannt, gilt sie, notfalls bis auf
// einen kleinen Rest heruntergerechnet.
export function resolveBudgetTokens(models, modelId, { reserveTokens = 32_768, fallback = 32_768 } = {}) {
  const model = models.find((entry) => entry.id === modelId);
  if (!model || typeof model.maxModelLen !== "number") {
    return fallback;
  }
  return Math.max(1_024, model.maxModelLen - reserveTokens);
}

// Derives the output-token ceiling from the same source resolveBudgetTokens uses
// to shrink the input budget (the server's advertised /models/status max_tokens),
// so the two are halves of one calculation instead of two independent numbers
// that can silently drift apart (see requestReview's former hardcoded 8_192).
//
// Der Fallback ist bewusst konservativ: /v1/models/status ist eine oMLX-Extra,
// generische Server (LM Studio) antworten dort mit 404 und haben nie etwas ueber
// ihre Grenzen gesagt. Ihnen 32768 Output-Token zuzumuten, nur weil das
// Referenzmodell so viel kann, heisst raten -- auf der teuren Seite.
// maxModelLen deckelt zusaetzlich: mehr als die Haelfte des Kontextfensters fuer
// die Antwort zu reservieren liesse fuer den Diff, also den Review-Gegenstand,
// weniger uebrig als fuer die Antwort darueber.
export function resolveOutputTokens(status, { fallback = 8_192, maxModelLen = null } = {}) {
  const advertised =
    typeof status?.maxOutputTokens === "number" && status.maxOutputTokens > 0 ? status.maxOutputTokens : fallback;
  return typeof maxModelLen === "number" && maxModelLen > 0
    ? Math.min(advertised, Math.floor(maxModelLen / 2))
    : advertised;
}

export class ReviewTransportError extends Error {
  // kind benennt die Ursache strukturiert: "unreachable" (der Server antwortet
  // gar nicht), "http" (er antwortet mit einem Fehlerstatus) oder "stream" (die
  // Verbindung bricht mitten im Stream ab). Der Aufrufer haengt nur an den
  // ersten Fall einen Hinweis auf LOCALREVIEW_BASE_URL an -- diese Entscheidung
  // an einem Feld statt am Wortlaut der Meldung festzumachen heisst, dass eine
  // spaetere Umformulierung den Hinweis nicht stillschweigend verliert.
  constructor(message, { kind = null, tokensSeen = 0, partialText = "", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ReviewTransportError";
    this.kind = kind;
    this.tokensSeen = tokensSeen;
    // Was bis zum Abbruch angekommen war. Spec Abschnitt 9 verlangt die
    // Teilausgabe im Job-Log -- das ist der Unterschied zwischen "die Verbindung
    // brach ab, hier ist, was wir hatten" und blossem "die Verbindung brach ab".
    this.partialText = partialText;
  }
}

const REVIEW_VERDICTS = new Set(["approve", "needs-attention"]);

// Nicht jedes JSON-Objekt in der Antwort ist ein Review. Ein Server, der das
// Schema ignoriert, liefert Prosa -- und Prosa ueber Code enthaelt regelmaessig
// JSON-Schnipsel (ein zitiertes Config-Fragment genuegt). Ohne diese Pruefung
// wuerde so ein Schnipsel zum Ergebnis befoerdert, render.mjs verwirft dann
// rawText, und aus einem Review mit drei Befunden wird "Ergebnis: undefined,
// Befunde: Keine." Was nicht wie ein Review aussieht, faellt deshalb in den
// Prosa-Pfad: dort bleibt rawText erhalten und wird dem Nutzer gezeigt.
export function isReviewShape(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    REVIEW_VERDICTS.has(value.verdict) &&
    Array.isArray(value.findings)
  );
}

export function extractJsonBlock(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/m.exec(String(text ?? ""));
  const candidates = fenced ? [fenced[1]] : [];
  const braced = /\{[\s\S]*\}/m.exec(String(text ?? ""));
  if (braced) {
    candidates.push(braced[0]);
  }
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
    } catch {
      // naechsten Kandidaten versuchen
    }
  }
  return null;
}

function parseSseLine(line, state, onProgress) {
  if (line.startsWith("event:")) {
    state.event = line.slice(6).trim();
    return;
  }
  if (!line.startsWith("data:")) {
    return;
  }
  let data;
  try {
    data = JSON.parse(line.slice(5).trim());
  } catch {
    return;
  }
  if (state.event === "response.output_text.delta" && typeof data.delta === "string") {
    state.text += data.delta;
    state.tokensSeen += 1;
    onProgress?.(`${state.tokensSeen} Textabschnitte empfangen.`);
    return;
  }
  // Beobachtet gegen einen echten oMLX-Server: ein abgeschnittener Response-Stream
  // sendet vor dem Verbindungsende dieses Event mit response.status "incomplete"
  // und incomplete_details.reason "max_output_tokens" -- das unterscheidet einen
  // erschoepften Token-Budget-Abbruch zuverlaessig von einem Server, der das
  // JSON-Schema schlicht ignoriert und stattdessen Freitext liefert.
  if (state.event === "response.incomplete") {
    state.incomplete = true;
    state.incompleteReason = data.response?.incomplete_details?.reason ?? null;
  }
}

export async function requestReview(config, options = {}) {
  const { model, instructions, payload, schema, maxOutputTokens = 32_768, signal, onProgress } = options;

  const body = {
    model,
    stream: true,
    max_output_tokens: maxOutputTokens,
    instructions,
    input: [{ role: "user", content: [{ type: "input_text", text: payload }] }],
    text: { format: { type: "json_schema", name: REVIEW_SCHEMA_NAME, strict: true, schema } }
  };

  const state = { event: null, text: "", tokensSeen: 0, incomplete: false, incompleteReason: null };

  let response;
  try {
    response = await fetch(endpoint(config, "/responses"), {
      method: "POST",
      signal,
      redirect: "error",
      headers: JSON_HEADERS,
      body: JSON.stringify(body)
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw error;
    }
    throw new ReviewTransportError(`Server nicht erreichbar: ${error.message}`, {
      kind: "unreachable",
      cause: error
    });
  }

  if (!response.ok) {
    throw new ReviewTransportError(
      `Review-Call scheiterte mit HTTP ${response.status}.${await readErrorDetail(response)}`,
      { kind: "http" }
    );
  }

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        parseSseLine(buffer.slice(0, newlineIndex).trim(), state, onProgress);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw error;
    }
    throw new ReviewTransportError(`Verbindung waehrend des Reviews abgebrochen: ${error.message}`, {
      kind: "stream",
      tokensSeen: state.tokensSeen,
      partialText: state.text,
      cause: error
    });
  }

  const rawText = state.text.trim();
  try {
    const parsed = JSON.parse(rawText);
    if (isReviewShape(parsed)) {
      return {
        parsed,
        rawText,
        structured: true,
        tokensSeen: state.tokensSeen,
        incomplete: state.incomplete,
        incompleteReason: state.incompleteReason
      };
    }
  } catch {
    // Schema wurde ignoriert, Fallback unten
  }

  const extracted = extractJsonBlock(rawText);
  return {
    parsed: isReviewShape(extracted) ? extracted : null,
    rawText,
    structured: false,
    tokensSeen: state.tokensSeen,
    incomplete: state.incomplete,
    incompleteReason: state.incompleteReason
  };
}
