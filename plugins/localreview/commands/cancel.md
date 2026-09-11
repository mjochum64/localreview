---
description: Laufenden Review-Job in diesem Repository abbrechen
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Breche den laufenden Review ab:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/review-companion.mjs" cancel --json
```

Regeln:
- Gib die Ausgabe unverändert an den Nutzer zurück.
- Läuft kein Job, ist das kein Fehler — melde das so, wie es die Ausgabe angibt.
