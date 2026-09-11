# localreview — Design

Datum: 2026-09-11
Status: abgestimmt, bereit für die Implementierungsplanung

## 1. Ziel

Ein Claude-Code-Plugin, das Code-Reviews gegen ein **lokal laufendes MLX-Modell** ausführt.
Vorbild ist `openai/codex-plugin-cc`: Slash-Command → Companion-Script → Review-Engine →
gerenderte Ausgabe. Statt der Codex CLI als Engine spricht `localreview` direkt einen
OpenAI-kompatiblen HTTP-Server an — primär oMLX auf
`http://127.0.0.1:8000/v1`.

Zweck ist die **zusätzliche Zweitmeinung**: ein zweites Modell, das den Diff liest, während
Claude Code die eigentliche Arbeit macht. Kein Ersatz für Claude Code, keine Delegation von
Änderungen, kein Agent mit Schreibrechten.

## 2. Getroffene Entscheidungen

| Frage | Entscheidung | Begründung |
|---|---|---|
| Engine | Eigener Review-Loop per HTTP, keine Codex CLI | Ein read-only Review braucht weder Sandbox noch Tool-Loop noch Thread-Resume. Der gesamte JSON-RPC-Transport des Vorbilds entfällt. |
| Kontextbeschaffung | Statischer Kontext (Diff + geänderte Dateien) | Deterministisch, testbar, kein Pfad-Sandbox-Problem. Mit 262k Modellkontext fast immer ausreichend. |
| Ausführung | Background-Jobs mit State, plus `status`/`result`/`cancel` | Ein 27B-4bit-Review dauert Minuten. Ohne Hintergrundlauf blockiert die Session. |
| Trigger | Nur Slash-Commands, kein Stop-Gate-Hook | Der Stop-Hook des Vorbilds hält das Sessionende bis zu 900 s auf — bei lokaler Inferenz realistisch die volle Zeit. |
| Ausgabe | Striktes JSON-Schema, selbst gerendert | oMLX respektiert `text.format.json_schema` (verifiziert). Ermöglicht Sortierung nach Severity und maschinenlesbare Ergebnisse. |
| Serverbindung | oMLX-first, Rest generisch | Basis sind Standard-OpenAI-Endpunkte mit konfigurierbarer `base_url`. oMLX-Extras werden per Feature-Detection genutzt, sonst übersprungen. |
| Bauweise | Hybrid: neues Skelett, bewährte Module portiert | `git.mjs`, `state.mjs`, `tracked-jobs.mjs`, Teile von `render.mjs` enthalten echte Detailarbeit samt Tests. Der Codex-Transport wird neu gebaut. |

## 3. Verifizierte Grundlagen

Gemessen am 2026-09-11 auf dem Zielrechner (Apple Silicon, macOS 25.6).

**oMLX** — `/Applications/oMLX.app`, Server-Prozess `omlx-server`, FastAPI auf `127.0.0.1:8000`:

| Fähigkeit | Ergebnis |
|---|---|
| `/v1/responses` mit SSE und function calls | funktioniert; Events `response.function_call_arguments.delta/done`, `response.output_text.delta`, `response.completed` |
| `text.format.json_schema`, `strict: true` | **wird respektiert**; Antwort war valides JSON gegen das Testschema |
| `/v1/chat/completions`, `/v1/completions` | vorhanden |
| `/v1/messages` (Anthropic-Format) | vorhanden |
| `/v1/models` | liefert `max_model_len` je Modell |
| `/v1/models/status` | liefert `loaded`, `estimated_size`, `load_seconds_per_gb_estimate` |
| `/v1/models/{id}/load`, `/unload` | vorhanden |
| `/v1/embeddings`, `/v1/rerank` | vorhanden (in dieser Version nicht genutzt) |
| Modell zum Messzeitpunkt | `Qwen3.8-27B-4bit`, geladen, `max_model_len` 262144, `max_tokens` 32768, ~16,9 GB resident |

**LM Studio** — zum Vergleich, `127.0.0.1:1234`:

| Fähigkeit | Ergebnis |
|---|---|
| `/v1/responses` mit SSE und function calls | funktioniert |
| `text.format.json_schema` | **wird still ignoriert**; Server echot `{"format":{"type":"text"}}` und antwortet mit Prosa |

Daraus folgt der Prosa-Fallback in Abschnitt 9: Er ist kein hypothetischer Zweig, sondern
das reale Verhalten eines unterstützten Servers.

**Nicht verifiziert:** `mlx_lm.server` (nicht installiert). Klassisch bietet er nur
Chat-Completions. Da `localreview` den Client selbst kontrolliert, wäre er über den
Chat-Pfad grundsätzlich nutzbar — ungetestet und ohne Structured Output.

## 4. Architektur

```
localreview/
  .claude-plugin/marketplace.json
  plugins/localreview/
    .claude-plugin/plugin.json
    commands/{review,status,result,cancel,setup}.md
    scripts/review-companion.mjs      # einziger Entry, Subcommands
    scripts/lib/
      args.mjs          # portiert, unverändert
      git.mjs           # portiert: resolveReviewTarget, collectReviewContext
      state.mjs         # portiert: Job-State pro Repo
      tracked-jobs.mjs  # portiert: PID-Tracking, Logs, Historie
      render.mjs        # portiert, Renderer auf eigenes Schema umgestellt
      client.mjs        # NEU: HTTP gegen OpenAI-kompatiblen Server
      context.mjs       # NEU: Payload-Bau und Token-Budget
      prompts.mjs       # NEU: Review-Instruktion, Fokus-Einschub
    schemas/review-output.schema.json
    LICENSE NOTICE
  tests/
  docs/superpowers/specs/
```

Modulgrenzen, jedes für sich testbar:

| Modul | Aufgabe | Abhängigkeiten |
|---|---|---|
| `git.mjs` | Repo-Root, Review-Ziel, Diff, untracked files | `child_process`, git |
| `context.mjs` | Payload aus git-Kontext bauen, Token-Budget einhalten | `git.mjs`-Ergebnis (reine Daten) |
| `prompts.mjs` | Instruktionstext, Fokus-Abschnitt | keine |
| `client.mjs` | HTTP/SSE gegen `base_url`, Schema-Anforderung, Abbruch | `fetch`, `AbortController` |
| `state.mjs` | atomarer Job-State auf Platte | `fs` |
| `tracked-jobs.mjs` | Job-Lebenszyklus, Fortschrittslog, PID | `state.mjs` |
| `render.mjs` | Schema-Ergebnis → Markdown | Schema |
| `review-companion.mjs` | Subcommands verdrahten, JSON-Ausgabe | alle |

`client.mjs` kennt weder git noch Job-State; `context.mjs` kennt kein HTTP. Damit lässt sich
der Payload-Bau ohne Server und der Client ohne Repo testen.

### Kommandos

| Command | Flags | Zweck |
|---|---|---|
| `/localreview:review` | `--base <ref>`, `--scope auto\|working-tree\|branch`, `--background`, `--wait`, `--model <id>`, `--focus "…"` | der Review |
| `/localreview:status` | — | laufende und letzte Jobs |
| `/localreview:result` | `--job-id <id>` | Ergebnis erneut rendern |
| `/localreview:cancel` | — | laufenden Job abbrechen |
| `/localreview:setup` | — | Server-Health, Modellliste, Config schreiben |

Bewusste Abweichung vom Vorbild: **kein eigenes `adversarial-review`-Command.** Der
Unterschied besteht dort nur aus Prompt und Fokustext; hier leistet das `--focus`.

### Konfiguration

Auflösungsreihenfolge: CLI-Flag → Umgebungsvariable (`LOCALREVIEW_BASE_URL`,
`LOCALREVIEW_MODEL`) → `~/.config/localreview/config.json` → Default
`http://127.0.0.1:8000/v1`. Der Serverwechsel ist damit Konfiguration, kein Code.

## 5. Datenfluss eines Laufs

```
/localreview:review --base main --background
  └─ Claude Code startet Bash(run_in_background):
     node review-companion.mjs review --json --base main
        1. git.mjs      → repoRoot, Ziel (branch vs. working-tree), Diff + untracked
        2. context.mjs  → Payload bauen, gegen Token-Budget prüfen
        3. state.mjs    → Job anlegen (id, pid, target, startedAt, status=running)
        4. client.mjs   → POST /v1/responses, stream:true, json_schema
                          SSE-Deltas → Fortschritt ins Job-Log
        5. state.mjs    → Ergebnis-JSON, status=completed|failed|cancelled
        6. render.mjs   → Markdown, nach Severity sortiert
```

Job-State liegt unter `$CLAUDE_PLUGIN_DATA/state/<repo-slug>-<sha16>/` mit Fallback in
`os.tmpdir()/localreview/`, je Job eine JSON- und eine Log-Datei, gedeckelt auf 50 Jobs.
Dieses Verhalten kommt mit `state.mjs` mit; geändert wird nur der Name des Fallback-Ordners.

## 6. Kontext- und Budget-Strategie

`context.mjs` liest `max_model_len` aus `/v1/models`, zieht die Output-Reserve ab
(`max_tokens`, beim Referenzmodell 32768) und schätzt den Payload mit Zeichen/4.

Füllreihenfolge:

1. Diff (immer, das ist der Review-Gegenstand)
2. vollständige Inhalte der geänderten Dateien, solange Budget bleibt
3. Dateiliste als Rahmen

Passt der Payload nicht — bei 262k Kontext praktisch nur bei sehr großen Branch-Diffs —
greift **Map-Reduce**: ein Call je Datei, danach ein Reduce-Call, der die Findings
zusammenführt und eine gemeinsame `summary` und `verdict` bildet. Das ist der Fallback,
nicht der Normalfall.

Fehlt `max_model_len` (generischer Server), gilt konservativ 32k.

## 7. Ergebnisschema und Rendering

`strict: true` verlangt, dass alle Eigenschaften in `required` stehen und
`additionalProperties: false` gesetzt ist. Optionale Werte werden deshalb als nullable
Union modelliert.

```json
{
  "verdict": "approve | needs-attention",
  "summary": "…",
  "findings": [
    {
      "severity": "critical | high | medium | low",
      "title": "…",
      "file": "…",
      "line": 123,
      "detail": "…",
      "suggestion": "…"
    }
  ],
  "next_steps": ["…"]
}
```

`line` und `suggestion` sind nullable. `render.mjs` sortiert nach Severity, gruppiert nach
Datei und schreibt Fundstellen als `file:line` — in Claude Code anklickbar.

## 8. Modell-Handling

Feature-Detection statt harter oMLX-Bindung:

| Schritt | oMLX | generischer Server |
|---|---|---|
| Modellliste, Kontextlänge | `/v1/models` mit `max_model_len` | `/v1/models`, Budget-Default 32k |
| Ist das Modell geladen? | `/v1/models/status` | übersprungen |
| Vorwärmen vor langem Lauf | `/v1/models/{id}/load`; erwartete Ladezeit ≈ `load_seconds_per_gb_estimate` × Größe | übersprungen, erster Call lädt kalt |

**Kein automatisches Unload.** Die Speicherpolitik bleibt beim Nutzer; das Plugin verdrängt
kein Modell, das ein anderes Werkzeug gerade benutzt.

## 9. Fehlerbehandlung

| Fall | Verhalten |
|---|---|
| `ECONNREFUSED` | Klartextmeldung mit `base_url` und Hinweis auf `LOCALREVIEW_BASE_URL`; Job `failed`, Exit 1 |
| Unbekannte Modell-ID | Fehlermeldung samt Liste aus `/v1/models` |
| Modell kalt | Vorwärmen mit Fortschrittsmeldung; Timeout = geschätzte Ladezeit plus Puffer |
| Server ignoriert `json_schema` | Antwort validiert nicht → Extraktion eines fenced JSON-Blocks → sonst Prosa durchreichen mit Warnung „strukturierte Ausgabe nicht unterstützt" |
| Verbindungsabriss im Stream | Teilausgabe ins Job-Log, Job `failed`. Automatischer Retry **nur**, wenn noch kein Token empfangen wurde |
| Nichts zu reviewen | Exit 0 mit klarer Aussage, kein Fehler |
| `cancel` | `AbortController` schließt die HTTP-Verbindung, PID aus Job-State bekommt SIGTERM, Job `cancelled` |
| Zweiter Review parallel | Abgelehnt mit Verweis auf den laufenden Job. Zwei 27B-Läufe gleichzeitig sprengen den Arbeitsspeicher; es gibt kein Override-Flag |
| Gesamtlaufzeit | Konfigurierbare Deadline, Default 30 Minuten, danach Job `failed` |

## 10. Sicherheit

- `client.mjs` spricht ausschließlich die konfigurierte `base_url` an und folgt keinen
  Weiterleitungen auf andere Hosts. Ist die `base_url` nicht Loopback, erscheint eine
  deutliche Warnung: dann verlässt der Quellcode die Maschine, was dem Zweck des Plugins
  widerspricht.
- Dateien, die typischerweise Zugangsdaten enthalten, werden aus dem Payload und damit aus
  den Job-Logs ausgeschlossen: `.env*`, `*.pem`, `*.key`, `*.p12`,
  `id_rsa*`/`id_dsa*`/`id_ecdsa*`/`id_ed25519*` (samt `_sk`-Varianten fuer Security-Keys).
  Die Erkennung ist case-insensitiv. Der Report benennt ausgelassene Dateien, damit die
  Auslassung sichtbar bleibt.

## 11. Tests

Test-Runner ist `node --test`, Struktur analog zum Vorbild (`tests/*.test.mjs` plus
`helpers.mjs`). Entwicklung testgetrieben.

| Ziel | Testart |
|---|---|
| `git.mjs`, `state.mjs`, `tracked-jobs.mjs` | portierte Tests des Vorbilds übernehmen und anpassen |
| `context.mjs` | Budget-Rechnung, Füllreihenfolge, Auslösen des Map-Reduce-Fallbacks; reine Funktionen |
| `client.mjs` | gegen einen Fake-SSE-Server auf `node:http`, analog `tests/fake-codex-fixture.mjs`: Schema-Antwort, Prosa-Fallback, Abbruch, HTTP 500, Verbindungsabriss |
| `render.mjs` | Snapshot Schema → Markdown, Sortierreihenfolge |
| Ende-zu-Ende gegen echtes oMLX | eigenes `npm run smoke`, überspringt sich wenn Port 8000 geschlossen ist; nicht Teil der CI |

CI übernimmt das Muster aus `.github/workflows/pull-request-ci.yml` des Vorbilds.

## 12. Lizenz und Verteilung

Eigenes Repository. Portierte Dateien behalten ihren Urheberrechtsvermerk; `NOTICE` erhält
den Eintrag „Portions Copyright 2026 OpenAI, Apache License 2.0, from
openai/codex-plugin-cc". Der Plugin-Name enthält kein „codex". Verteilung als
öffentliches Repository über den Claude-Code-Marketplace.

## 13. Nicht im Umfang

app-server und Broker, Thread-Resume, Sandbox, `apply_patch`, Delegation und Rescue-Tasks,
Session-Transfer, Stop-Gate-Hook, agentischer Tool-Loop, Retrieval über `embeddings` und
`rerank`, Modell-Ensembles.

Retrieval ist die wahrscheinlichste spätere Erweiterung. Der Ort dafür ist `context.mjs`;
alle anderen Module bleiben davon unberührt.
