---
description: Laufende und vergangene Review-Jobs in diesem Repository anzeigen
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Zeige den Job-Status:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/review-companion.mjs" status --json
```

Regeln:
- Gib die Ausgabe unverändert an den Nutzer zurück.
- Verweise bei einem laufenden Job auf `/localreview:result` (sobald abgeschlossen) und `/localreview:cancel`.
