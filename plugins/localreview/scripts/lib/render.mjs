const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "unbekannt";
  }
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function renderOmissions(meta) {
  const lines = [];
  if (meta.omittedFiles?.length) {
    lines.push(`Aus Platzgruenden ausgelassen: ${meta.omittedFiles.join(", ")}`);
  }
  if (meta.secretFiles?.length) {
    lines.push(`Aus Sicherheitsgruenden ausgelassen: ${meta.secretFiles.join(", ")}`);
  }
  return lines;
}

// incomplete_details.reason der Responses API kann mehr sein als "max_output_tokens"
// (z. B. "content_filter"). Die Warnung muss auf den Grund eingehen, nicht nur auf
// das incomplete-Flag -- sonst faellt eine Content-Filter-Abbruch faelschlich unter
// die Budget-Warnung und schickt den Nutzer los, ein Limit zu erhoehen, das nie das
// Problem war. Ein unbekannter oder fehlender Grund bekommt eine ehrliche, generische
// Meldung statt einer erfundenen Ursache.
function renderIncompleteWarning(reason) {
  if (reason === "max_output_tokens") {
    return "> Warnung: Antwort abgeschnitten — das Output-Token-Budget wurde erschoepft, bevor die Antwort vollstaendig war. Versuche es erneut oder mit einem kleineren Diff.";
  }
  if (reason === "content_filter") {
    return "> Warnung: Antwort abgeschnitten — der Server hat die Antwort durch einen Content-Filter beendet, bevor sie vollstaendig war.";
  }
  return "> Warnung: Antwort abgeschnitten — die Antwort war unvollstaendig, der Grund ist nicht bekannt.";
}

export function renderReviewResult(result, meta) {
  const head = [
    `# Lokaler Review`,
    "",
    `Ziel: ${meta.target?.label ?? "unbekannt"}`,
    `Modell: ${meta.model ?? "unbekannt"}`,
    `Dauer: ${formatDuration(meta.durationMs)}`,
    ...renderOmissions(meta),
    ""
  ];

  if (!result.parsed) {
    // Zwei verschiedene Ursachen sehen fuer den Nutzer gleich aus (kein geparstes
    // JSON), sind aber grundverschieden: ein Server, der das Schema ignoriert und
    // Freitext liefert, gegenueber einem Server, der dem Schema gefolgt ist, aber
    // die Antwort abgebrochen hat, bevor sie fertig war. result.incomplete kommt aus
    // dem beobachteten response.incomplete-Event (client.mjs); result.incompleteReason
    // traegt dessen incomplete_details.reason und entscheidet, welche der abgebrochen-
    // Warnungen zutrifft, statt dem Server pauschal vorzuwerfen, er habe das Schema
    // ignoriert.
    const warning = result.incomplete
      ? renderIncompleteWarning(result.incompleteReason)
      : "> Warnung: strukturierte Ausgabe nicht unterstuetzt — der Server hat das JSON-Schema ignoriert.";
    return [
      ...head,
      warning,
      "",
      result.rawText || "(keine Ausgabe)"
    ].join("\n");
  }

  const parsed = result.parsed;
  const findings = [...(parsed.findings ?? [])].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity)
  );

  const body = findings.map((finding) => {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    const suggestion = finding.suggestion ? `\n\nVorschlag: ${finding.suggestion}` : "";
    return `### [${finding.severity}] ${finding.title}\n\n${location}\n\n${finding.detail}${suggestion}`;
  });

  const nextSteps = (parsed.next_steps ?? []).map((step) => `- ${step}`);

  return [
    ...head,
    `Ergebnis: **${parsed.verdict}**`,
    "",
    parsed.summary ?? "",
    "",
    findings.length > 0 ? "## Befunde" : "## Befunde\n\nKeine.",
    ...(findings.length > 0 ? ["", ...body] : []),
    "",
    nextSteps.length > 0 ? "## Naechste Schritte" : "",
    ...nextSteps
  ]
    .filter((line) => line !== "")
    .join("\n\n");
}

export function renderStatusReport(jobs) {
  if (!jobs || jobs.length === 0) {
    return "Keine Review-Jobs in diesem Repository.";
  }
  const rows = jobs.map(
    (job) => `- \`${job.id}\` — ${job.status} — ${job.target ?? "unbekannt"} — gestartet ${job.startedAt}`
  );
  return ["# Review-Jobs", "", ...rows].join("\n");
}

export function renderCancelReport(job) {
  if (!job) {
    return "Kein laufender Review-Job gefunden.";
  }
  return `Job \`${job.id}\` ist jetzt ${job.status}.`;
}

export function renderSetupReport(report) {
  const lines = [
    "# localreview Setup",
    "",
    `Server: ${report.baseUrl}`,
    `Erreichbar: ${report.reachable ? "ja" : "nein"}`,
    `Modell: ${report.model ?? "nicht gesetzt"}`
  ];
  if (!report.loopback) {
    lines.push("", "> Warnung: die konfigurierte Adresse ist kein Loopback — dein Quellcode verlaesst diese Maschine.");
  }
  if (report.models?.length) {
    lines.push("", "## Verfuegbare Modelle", "", ...report.models.map((model) => `- ${model.id} (${model.maxModelLen ?? "?"} Token)`));
  }
  return lines.join("\n");
}
