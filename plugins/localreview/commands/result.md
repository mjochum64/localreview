---
description: Gespeichertes Ergebnis eines abgeschlossenen Review-Jobs anzeigen
argument-hint: '[--job-id <id>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Zeige das gespeicherte Review-Ergebnis:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/review-companion.mjs" result --json $ARGUMENTS
```

Regeln:
- Ohne `--job-id` wird das zuletzt gespeicherte Ergebnis angezeigt.
- Gib die Ausgabe unverändert und vollständig an den Nutzer zurück, ohne sie zu kürzen.
- Ist kein Ergebnis vorhanden, verweise auf `/localreview:status` und `/localreview:review`.
