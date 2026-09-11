---
description: Prüfen, ob der lokale Modell-Server erreichbar ist und welche Modelle er anbietet
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Prüfe die Bereitschaft des lokalen Servers:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/review-companion.mjs" setup --json
```

Regeln:
- Gib die Ausgabe unverändert an den Nutzer zurück, einschließlich einer eventuellen Warnung, dass die konfigurierte Adresse kein Loopback ist.
- Ist der Server nicht erreichbar, weise auf `LOCALREVIEW_BASE_URL` und die Konfigurationsdatei `~/.config/localreview/config.json` hin.
