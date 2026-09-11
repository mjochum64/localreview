---
description: Code-Review gegen das lokal laufende Modell
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [--focus "…"]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Führe den lokalen Review aus:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/review-companion.mjs" review --json $ARGUMENTS
```

Regeln:
- Dieses Kommando ist read-only. Ändere nichts und schlage keine Änderungen vor, die du selbst anwendest.
- Gib die Ausgabe des Reviews unverändert an den Nutzer zurück.
- Enthält `$ARGUMENTS` weder `--wait` noch `--background`, frage mit `AskUserQuestion` genau einmal, ob im Vordergrund gewartet oder im Hintergrund gelaufen werden soll. Empfehle Hintergrund, sobald mehr als zwei Dateien betroffen sind.
- Bei `--background` starte den Aufruf mit `Bash(run_in_background: true)` und verweise auf `/localreview:status`.
- Reiche die Argumente des Nutzers unverändert weiter.
