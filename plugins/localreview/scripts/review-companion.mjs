#!/usr/bin/env node
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { resolveConfig, isLoopbackUrl } from "./lib/config.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { buildReviewPayload, buildPerFilePayloads, isSecretPath, mergeFindings } from "./lib/context.mjs";
import { buildInstructions, buildReduceInstructions, loadReviewSchema } from "./lib/prompts.mjs";
import {
  ReviewTransportError,
  ensureModelLoaded,
  getModelStatus,
  listModels,
  requestReview,
  resolveBudgetTokens,
  resolveOutputTokens
} from "./lib/client.mjs";
import { renderCancelReport, renderReviewResult, renderSetupReport, renderStatusReport } from "./lib/render.mjs";
import {
  ensureStateDir,
  generateJobId,
  listJobs,
  readJobFile,
  resolveJobLogFile,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { appendLogBlock, appendLogLine, nowIso } from "./lib/tracked-jobs.mjs";

const REVIEW_OPTIONS = {
  valueOptions: ["base", "scope", "model", "focus", "cwd", "job-id"],
  booleanOptions: ["json", "background", "wait"],
  aliasMap: { m: "model" }
};

// Ein AbortError sagt von sich aus nicht, warum abgebrochen wurde: die Deadline
// und ein Abbruch von aussen erzeugen denselben Fehler mit derselben englischen
// Meldung ("This operation was aborted"). Ohne den festgehaltenen Grund kann der
// Nutzer ein 30-Minuten-Zeitlimit nicht von seinem eigenen Abbruch unterscheiden.
function describeReviewError(error, config, abortReason) {
  if (error?.name === "AbortError") {
    return abortReason === "deadline"
      ? `Zeitlimit von ${Math.round(config.deadlineMs / 1000)}s erreicht. Erhoehe LOCALREVIEW_DEADLINE_MS oder reviewe einen kleineren Diff.`
      : "Review abgebrochen.";
  }
  if (error instanceof ReviewTransportError && error.kind === "unreachable") {
    return `${error.message}. Pruefe den Server oder setze LOCALREVIEW_BASE_URL.`;
  }
  return error.message;
}

// Ein Log-Eintrag je SSE-Delta waere eine Zeile pro Textabschnitt. Der erste und
// danach jeder 50. genuegen fuer den Zweck: im Job-Log sehen, dass der Lauf lebt
// und vorankommt, waehrend /localreview:status sonst minutenlang nur "running"
// zeigt.
function makeProgressLogger(logFile, every = 50) {
  let seen = 0;
  return (message) => {
    seen += 1;
    if (seen === 1 || seen % every === 0) {
      appendLogLine(logFile, message);
    }
  };
}

function emit(useJson, payload, rendered) {
  process.stdout.write(useJson ? `${JSON.stringify(payload, null, 2)}\n` : `${rendered}\n`);
}

function isAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findRunningJob(repoRoot) {
  return listJobs(repoRoot).find((job) => job.status === "running" && isAlive(job.pid)) ?? null;
}

// parseArgs, die Repo-Aufloesung und resolveReviewTarget werfen bei ganz
// gewoehnlichen Bedienfehlern: kein Git-Repository, unbekannter --scope, --base
// ohne Wert. Bisher lief das alles ausserhalb jedes try/catch, aus einem Wurf
// wurde eine unhandled rejection -- Stacktrace auf stderr, leeres stdout. Weil
// alle fuenf Command-Dateien mit --json aufrufen, kam bei Claude in genau diesen
// Faellen ueberhaupt keine verwertbare Antwort an. Der Wrapper ist zugleich die
// einzige Stelle, die parseArgs und die Repo-Aufloesung kennt; die vier
// Subcommands wiederholten sie vorher je fuer sich.
async function runCommand(argv, handler, { requireRepo = true } = {}) {
  // Scheitert schon parseArgs, gibt es noch keine options -- die Ausgabeform muss
  // dann direkt aus argv kommen, sonst antwortet ein --json-Aufruf ausgerechnet im
  // Fehlerfall in Prosa, die der Aufrufer nicht parsen kann.
  let useJson = argv.includes("--json");
  try {
    const { options } = parseArgs(argv, REVIEW_OPTIONS);
    useJson = options.json === true;
    // ensureGitRepository statt getRepoRoot: identisches Ergebnis, aber mit der
    // lesbaren Meldung statt der rohen git-Fehlerausgabe.
    const repoRoot = requireRepo ? ensureGitRepository(options.cwd ?? process.cwd()) : null;
    return await handler({ options, useJson, repoRoot });
  } catch (error) {
    const message = error?.message ?? String(error);
    emit(useJson, { ok: false, error: message }, message);
    return 1;
  }
}

function runStatus(argv) {
  return runCommand(argv, ({ useJson, repoRoot }) => {
    const jobs = listJobs(repoRoot);
    emit(useJson, { ok: true, jobs }, renderStatusReport(jobs));
    return 0;
  });
}

function runResult(argv) {
  return runCommand(argv, ({ options, useJson, repoRoot }) => {
    const jobs = listJobs(repoRoot);
    const job = options["job-id"]
      ? jobs.find((entry) => entry.id === options["job-id"])
      : jobs.find((entry) => entry.resultFile);

    if (!job?.resultFile) {
      emit(useJson, { ok: false, error: "Kein gespeichertes Ergebnis gefunden." }, "Kein gespeichertes Ergebnis gefunden.");
      return 1;
    }

    let stored;
    try {
      stored = readJobFile(job.resultFile);
    } catch {
      const message = "Das gespeicherte Ergebnis ist nicht mehr lesbar (Datei fehlt oder ist beschaedigt).";
      emit(useJson, { ok: false, error: message }, message);
      return 1;
    }

    emit(useJson, { ok: true, jobId: job.id, rendered: stored.rendered }, stored.rendered);
    return 0;
  });
}

function runCancel(argv) {
  return runCommand(argv, ({ useJson, repoRoot }) => {
    const job = listJobs(repoRoot).find((entry) => entry.status === "running");

    if (!job) {
      emit(useJson, { ok: true, job: null }, renderCancelReport(null));
      return 0;
    }
    if (isAlive(job.pid)) {
      terminateProcessTree(job.pid, {});
    }
    const completedAt = nowIso();
    upsertJob(repoRoot, { id: job.id, status: "cancelled", completedAt });
    const updated = { ...job, status: "cancelled", completedAt };
    emit(useJson, { ok: true, job: updated }, renderCancelReport(updated));
    return 0;
  });
}

// Einziger Subcommand ohne Repo-Bezug: setup prueft den Server, nicht das Projekt.
function runSetup(argv) {
  return runCommand(argv, async ({ options, useJson }) => {
    const config = resolveConfig({ model: options.model });

    let models = [];
    let reachable = true;
    let error = null;
    try {
      models = await listModels(config, {});
    } catch (err) {
      reachable = false;
      error = err.message;
    }

    const report = {
      baseUrl: config.baseUrl,
      loopback: isLoopbackUrl(config.baseUrl),
      reachable,
      error,
      models,
      model: config.model ?? models[0]?.id ?? null
    };

    emit(useJson, { ok: reachable, report }, renderSetupReport(report));
    return reachable ? 0 : 1;
  }, { requireRepo: false });
}

function runReview(argv) {
  return runCommand(argv, async ({ options, useJson, repoRoot }) => {
    const config = resolveConfig({ model: options.model });

    const running = findRunningJob(repoRoot);
    if (running) {
      const message = `Ein Review laeuft bereits (${running.id}). Warte darauf oder brich ihn mit /localreview:cancel ab.`;
      emit(useJson, { ok: false, error: message }, message);
      return 1;
    }

    const target = resolveReviewTarget(repoRoot, { scope: options.scope, base: options.base });
    const reviewContext = collectReviewContext(repoRoot, target, {});

    if (reviewContext.changedFiles.length === 0) {
      emit(useJson, { ok: true, nothingToReview: true }, "Nichts zu reviewen.");
      return 0;
    }

    // git.mjs haelt die Inhalte moeglicher Zugangsdaten aus dem Diff heraus. Sind sie
    // die einzige Aenderung, bliebe nichts uebrig, was gesendet werden koennte -- und
    // ein "approve" waere der Freispruch fuer ein Review, das nie stattgefunden hat.
    const secretFiles = reviewContext.changedFiles.filter((file) => isSecretPath(file));
    if (secretFiles.length === reviewContext.changedFiles.length) {
      const message = `Nur moegliche Zugangsdaten geaendert (${secretFiles.join(", ")}). Diese Dateien werden nicht gesendet, es bleibt nichts zu reviewen.`;
      emit(useJson, { ok: true, nothingToReview: true, secretFiles }, message);
      return 0;
    }

    if (!isLoopbackUrl(config.baseUrl)) {
      process.stderr.write(
        `Warnung: ${config.baseUrl} ist kein Loopback — dein Quellcode verlaesst diese Maschine.\n`
      );
    }

    ensureStateDir(repoRoot);
    const jobId = generateJobId("review");
    const startedAt = Date.now();
    // Das Job-Log entsteht fuer jeden Lauf, nicht nur fuer den Map-Reduce-Fallback:
    // ein Hintergrund-Review dauert Minuten, und ohne Log zeigt /localreview:status
    // waehrenddessen nichts ausser "running" -- genau das, wofuer es die
    // Hintergrundjobs ueberhaupt gibt (Spec Abschnitt 5, Schritt 4).
    const logFile = resolveJobLogFile(repoRoot, jobId);
    upsertJob(repoRoot, {
      id: jobId,
      kind: "review",
      status: "running",
      pid: process.pid,
      target: target.label,
      model: config.model,
      logFile,
      startedAt: nowIso()
    });
    appendLogLine(logFile, `Review gestartet: ${target.label}.`);

    const controller = new AbortController();
    let abortReason = null;
    const deadline = setTimeout(() => {
      abortReason = "deadline";
      controller.abort();
    }, config.deadlineMs);

    try {
      const models = await listModels(config, { signal: controller.signal });
      const modelId = config.model ?? models[0]?.id;
      if (!modelId) {
        throw new Error(
          `Kein Modell konfiguriert und ${config.baseUrl}/models liefert keines. Setze LOCALREVIEW_MODEL oder pruefe mit /localreview:setup, welche Modelle der Server anbietet.`
        );
      }
      // Spec Abschnitt 9: eine unbekannte Modell-ID meldet die verfuegbaren
      // Modelle. Die Liste liegt aus dem Aufruf oben ohnehin vor, und ohne diese
      // Pruefung landet der haeufigste Konfigurationsfehler irgendwo tief im
      // Review-Call. Ein Server ohne /models (leere Liste) wird nicht blockiert.
      if (config.model && models.length > 0 && !models.some((entry) => entry.id === config.model)) {
        throw new Error(
          `Modell "${config.model}" kennt ${config.baseUrl} nicht. Verfuegbar: ${models
            .map((entry) => entry.id)
            .join(", ")}. Setze LOCALREVIEW_MODEL passend oder pruefe /localreview:setup.`
        );
      }

      // onProgress traegt die Vorwaermmeldung samt geschaetzter Ladezeit -- ohne
      // sie laedt ein kaltes 27B-Modell minutenlang ohne jedes Lebenszeichen.
      await ensureModelLoaded(config, modelId, {
        signal: controller.signal,
        onProgress: (message) => appendLogLine(logFile, message)
      });

      // Output-Ceiling und Eingabebudget sind zwei Haelften derselben Aufteilung
      // des Kontextfensters: was hier fuer die Antwort reserviert wird, ist exakt
      // das, was unten als maxOutputTokens mitgeht -- die beiden koennen also nicht
      // auseinanderlaufen, wie es das frueher fest verdrahtete 8_192 gegen eine
      // Reserve von 32_768 tat. maxModelLen deckelt beide: ohne das bekaeme ein
      // Modell mit kleinem Kontext eine Reserve, die groesser ist als sein Fenster.
      const modelStatus = await getModelStatus(config, modelId, { signal: controller.signal });
      const maxModelLen = models.find((entry) => entry.id === modelId)?.maxModelLen ?? null;
      const outputTokens = resolveOutputTokens(modelStatus, { maxModelLen });
      const budgetTokens = resolveBudgetTokens(models, modelId, { reserveTokens: outputTokens, fallback: outputTokens });
      const payload = buildReviewPayload(reviewContext, { budgetTokens });

      // Auf dem Map-Reduce-Pfad wird `payload` verworfen; seine Buchhaltung
      // beschreibt dann eine Nutzlast, die nie gesendet wurde (includedFiles leer,
      // omittedFiles alle Dateien). Was der Fan-out wirklich abgedeckt hat, traegt
      // deshalb coverage -- sonst meldet der Report jede reviewte Datei als
      // "aus Platzgruenden ausgelassen".
      let coverage = { includedFiles: payload.includedFiles, omittedFiles: payload.omittedFiles };

      let result;
      if (payload.overBudget) {
        const parts = buildPerFilePayloads(reviewContext, { budgetTokens });

        const partial = [];
        const unreadableFiles = [];
        for (const [index, part] of parts.entries()) {
          appendLogLine(logFile, `Teil-Review ${index + 1}/${parts.length}: ${part.file}`);
          const partResult = await requestReview(config, {
            model: modelId,
            instructions: buildInstructions({ focus: options.focus }),
            payload: part.text,
            schema: loadReviewSchema(),
            maxOutputTokens: outputTokens,
            signal: controller.signal,
            onProgress: makeProgressLogger(logFile)
          });
          if (partResult.parsed) {
            partial.push(partResult.parsed);
          } else {
            unreadableFiles.push(part.file);
          }
        }

        // A per-file result that failed to parse must never be silently dropped:
        // that would let a review that learned nothing about a file present itself
        // as having approved it. If literally nothing came back usable, fail the
        // job outright instead of reporting a false "approve".
        if (partial.length === 0) {
          throw new Error(
            parts.length === 0
              ? "Es gab keine Datei, die gesendet werden durfte -- der Review hat nichts geprueft."
              : `Kein Teil-Review hat eine verwertbare Antwort geliefert (${parts.length} Datei(en) betroffen).`
          );
        }

        coverage = { includedFiles: parts.map((part) => part.file), omittedFiles: [] };

        const merged = mergeFindings(partial);
        if (unreadableFiles.length > 0) {
          merged.verdict = "needs-attention";
        }
        const notes = [];
        if (unreadableFiles.length > 0) {
          notes.push(
            `Teil-Review unvollstaendig: fuer folgende Dateien kam keine verwertbare Antwort zurueck und sie wurden nicht bewertet: ${unreadableFiles.join(", ")}.`
          );
        }

        // The reduce call only ever produces summary/next_steps (see mergeFindings);
        // if it fails, the findings and verdict gathered above must survive and the
        // job must still complete — losing N already-finished per-file reviews to one
        // failed summarization call would be a much worse outcome than a plain summary.
        let reduce = null;
        try {
          reduce = await requestReview(config, {
            model: modelId,
            instructions: buildReduceInstructions(),
            payload: JSON.stringify(merged),
            schema: loadReviewSchema(),
            maxOutputTokens: outputTokens,
            signal: controller.signal,
            onProgress: makeProgressLogger(logFile)
          });
        } catch (reduceError) {
          if (reduceError?.name === "AbortError") {
            throw reduceError;
          }
          notes.push(
            `Zusammenfassung nicht verfuegbar: der abschliessende Reduce-Call ist fehlgeschlagen (${reduceError.message}). Die Einzelbefunde unten sind vollstaendig.`
          );
        }

        const summary = [...notes, reduce?.parsed?.summary ?? ""].filter((line) => line).join("\n\n");
        result = {
          parsed: { ...merged, summary, next_steps: reduce?.parsed?.next_steps ?? merged.next_steps },
          rawText: reduce?.rawText ?? null,
          structured: reduce?.structured ?? false,
          tokensSeen: reduce?.tokensSeen ?? 0,
          incomplete: reduce?.incomplete ?? false,
          incompleteReason: reduce?.incompleteReason ?? null
        };
      } else {
        appendLogLine(logFile, `Review-Call an ${modelId} gesendet.`);
        result = await requestReview(config, {
          model: modelId,
          instructions: buildInstructions({ focus: options.focus }),
          payload: payload.text,
          schema: loadReviewSchema(),
          maxOutputTokens: outputTokens,
          signal: controller.signal,
          onProgress: makeProgressLogger(logFile)
        });
      }

      const meta = {
        target,
        model: modelId,
        durationMs: Date.now() - startedAt,
        includedFiles: coverage.includedFiles,
        omittedFiles: coverage.omittedFiles,
        secretFiles: payload.secretFiles,
        generatedFiles: payload.generatedFiles
      };
      const rendered = renderReviewResult(result, meta);
      const resultFile = writeJobFile(repoRoot, jobId, { result, meta, rendered });

      appendLogLine(logFile, `Review abgeschlossen: ${result.parsed?.verdict ?? "ohne strukturiertes Verdikt"}.`);
      upsertJob(repoRoot, {
        id: jobId,
        status: "completed",
        completedAt: nowIso(),
        verdict: result.parsed?.verdict ?? null,
        resultFile
      });

      emit(
        useJson,
        { ok: true, jobId, verdict: result.parsed?.verdict ?? null, structured: result.structured, resultFile, rendered },
        rendered
      );
      return 0;
    } catch (error) {
      const message = describeReviewError(error, config, abortReason);
      // Spec Abschnitt 9: Teilausgabe ins Job-Log, dann scheitert der Job.
      appendLogBlock(logFile, "Teilausgabe vor dem Abbruch", error?.partialText ?? "");
      appendLogLine(logFile, `Review fehlgeschlagen: ${message}`);
      upsertJob(repoRoot, { id: jobId, status: "failed", completedAt: nowIso(), error: message });
      emit(useJson, { ok: false, jobId, error: message }, `Review fehlgeschlagen: ${message}`);
      return 1;
    } finally {
      clearTimeout(deadline);
    }
  });
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand === "review") {
    return runReview(rest);
  }
  if (subcommand === "status") {
    return runStatus(rest);
  }
  if (subcommand === "result") {
    return runResult(rest);
  }
  if (subcommand === "cancel") {
    return runCancel(rest);
  }
  if (subcommand === "setup") {
    return runSetup(rest);
  }
  process.stderr.write(`Unbekannter Subcommand: ${subcommand ?? "(keiner)"}\n`);
  return 2;
}

// Backstop: die Subcommands fangen ihre Fehler selbst, aber ein Wurf daneben
// darf den Nutzer nicht mit einem Stacktrace und leerem stdout zuruecklassen.
try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
}
