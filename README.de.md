# localreview

> Deutsche Fassung. English version: [README.md](README.md).

Ein Claude-Code-Plugin für eine **zweite Meinung** zu einem Diff: Es schickt den
Review-Kontext an ein lokal laufendes, OpenAI-kompatibles Modell (primär oMLX auf
`127.0.0.1:8000`) und liefert dessen strukturiertes Review zurück. localreview ist
read-only — es ändert keinen Code, wendet keine Vorschläge an und läuft nur, wenn du
eines der fünf Slash-Commands aufrufst. Es gibt keinen automatischen Trigger und
keinen Stop-Hook.

## Voraussetzungen

- Node.js ≥ 18.18.0
- Ein lokal laufender, OpenAI-kompatibler Server mit den Endpunkten `/v1/models` und
  `/v1/responses` (SSE-Streaming). Default-Adresse: `http://127.0.0.1:8000/v1`.
  Primär getestet gegen oMLX; jeder Server, der diese Endpunkte bedient, funktioniert
  grundsätzlich mit — siehe Einschränkung unten.

Mit `/localreview:setup` prüfst du, ob dein Server erreichbar ist und welche Modelle
er anbietet, bevor du einen Review startest.

## Installation

In Claude Code:

```
/plugin marketplace add mjochum64/localreview
/plugin install localreview@localreview
```

## Kommandos

| Command | Zweck |
|---|---|
| `/localreview:review [--wait\|--background] [--base <ref>] [--scope auto\|working-tree\|branch] [--model <id>] [--focus "…"]` | Startet einen Review gegen den aktuellen Diff. `--scope` steuert, ob working-tree-Änderungen oder der Branch gegen `--base` verglichen werden (`auto` erkennt das selbst). Ohne `--wait`/`--background` fragt Claude einmal nach, wie gewartet werden soll. |
| `/localreview:status` | Zeigt laufende und vergangene Review-Jobs in diesem Repository. |
| `/localreview:result [--job-id <id>]` | Zeigt das gespeicherte Ergebnis eines abgeschlossenen Jobs, ohne `--job-id` das zuletzt gespeicherte. |
| `/localreview:cancel` | Bricht einen laufenden Review-Job ab. |
| `/localreview:setup` | Prüft Erreichbarkeit des Servers und listet die dort verfügbaren Modelle. |

Ein Review kann je nach Modellgröße mehrere Minuten dauern; `--background` startet ihn
im Hintergrund, `/localreview:status` und `/localreview:result` fragen den Fortschritt
bzw. das Ergebnis danach ab.

## Konfiguration

localreview löst die Server-Adresse und das Modell in dieser Reihenfolge auf (erste
gesetzte Quelle gewinnt):

1. **CLI-Flag** `--model` / `-m <id>` bei `/localreview:review` und `/localreview:setup`
   (überschreibt nur das Modell, nicht die Server-Adresse).
2. **Umgebungsvariablen**: `LOCALREVIEW_BASE_URL`, `LOCALREVIEW_MODEL`, optional
   `LOCALREVIEW_DEADLINE_MS` (Timeout in Millisekunden, Default 1 800 000 = 30 Minuten).
3. **Konfigurationsdatei** `~/.config/localreview/config.json`:

   ```json
   {
     "baseUrl": "http://127.0.0.1:8000/v1",
     "model": "Qwen3.8-27B-4bit",
     "deadlineMs": 1800000
   }
   ```

4. **Default**: `http://127.0.0.1:8000/v1`, kein festes Modell (localreview nimmt dann
   das erste von `/v1/models` gemeldete Modell).

Ist die konfigurierte Adresse kein Loopback (`127.0.0.1`, `localhost`, `::1`), warnen
`review` und `setup` ausdrücklich, weil dein Quellcode dann diese Maschine verlässt.

## Ausgeschlossene Dateien

Dateien, die typischerweise Zugangsdaten enthalten, werden vom Review ausgenommen:
`.env` und `.env.*`, `*.pem`, `*.key`, `*.p12` sowie private SSH-Schlüssel
(`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, auch die `_sk`-Varianten). Die
Erkennung ignoriert Groß- und Kleinschreibung. Ausgeschlossen heißt
hier: Ihr Inhalt landet weder im Payload an das Modell noch im Job-Log — localreview
lässt git diesen Diff gar nicht erst ausgeben. Der Report benennt jede so ausgelassene
Datei namentlich, damit die Lücke sichtbar bleibt.

Ändert ein Diff ausschließlich solche Dateien, bricht `review` mit einer klaren Meldung
ab, statt ein Review zu melden, für das nichts gesendet wurde.

## Smoke-Test

Neben der Unit-Test-Suite (`npm test`) gibt es einen Smoke-Test, der wirklich gegen
einen laufenden lokalen Server spricht: `tests/smoke/omlx.test.mjs`. Er liegt bewusst
außerhalb von `tests/*.test.mjs` und wird deshalb von `npm test` nicht mit ausgeführt.

```
npm run smoke
```

Der Test prüft zuerst `${LOCALREVIEW_BASE_URL:-http://127.0.0.1:8000/v1}/models`. Antwortet
dort niemand, überspringt er sich selbst (kein Fehlschlag, Exit-Code 0). Antwortet ein
Server, legt er ein temporäres Git-Repo mit einem echten Diff an, ruft
`review-companion.mjs review --json --wait` darauf auf und prüft, dass ein gültiges
Verdict (`approve` oder `needs-attention`) zurückkommt. Weil dabei ein echtes Modell
antworten muss, hat der Test ein Timeout von 10 Minuten.

## Bekannte Einschränkung

localreview verlangt vom Server strukturierte Ausgabe über
`text.format.json_schema` (`strict: true`), um Befunde nach Schweregrad zu sortieren.
oMLX unterstützt das und respektiert das Schema. Server, die dieses Feld stillschweigend
ignorieren — LM Studio tut das —, antworten stattdessen mit Prosa. localreview erkennt
das und zeigt diese Prosa dann unverändert mit einer Warnung an, statt einer sortierten
Befundliste.
