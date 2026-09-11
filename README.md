# localreview

A Claude Code plugin that gets you a **second opinion** on a diff: it sends the review
context to a locally running, OpenAI-compatible model (primarily oMLX on
`127.0.0.1:8000`) and returns that model's structured review. localreview is read-only —
it never changes code, never applies suggestions, and only runs when you invoke one of
its five slash commands. There is no automatic trigger and no stop hook.

> **Language note:** the plugin's interface is German. Command descriptions, error
> messages and the rendered report are in German, and the instruction sent to the model
> is German too — so the review you get back is written in German. This README is
> English; [README.de.md](README.de.md) is the German original. If you need an English
> interface, that is not yet built.

## Why this exists

Your code never leaves your machine. The review runs against a model you host yourself,
so you can ask for a second opinion on work you are not allowed — or not willing — to
send to a cloud provider.

## Requirements

- Node.js ≥ 18.18.0
- A locally running, OpenAI-compatible server exposing `/v1/models` and `/v1/responses`
  (with SSE streaming). Default address: `http://127.0.0.1:8000/v1`. Primarily tested
  against oMLX; any server serving those endpoints should work — see the known
  limitation below.

Run `/localreview:setup` to check whether your server is reachable and which models it
offers before starting a review.

## Installation

In Claude Code:

```
/plugin marketplace add mjochum64/localreview
/plugin install localreview@localreview
```

## Commands

| Command | Purpose |
|---|---|
| `/localreview:review [--wait\|--background] [--base <ref>] [--scope auto\|working-tree\|branch] [--model <id>] [--focus "…"]` | Starts a review of the current diff. `--scope` selects working-tree changes or the branch compared against `--base` (`auto` decides for you). Without `--wait`/`--background`, Claude asks once how you want to wait. |
| `/localreview:status` | Lists running and past review jobs for this repository. |
| `/localreview:result [--job-id <id>]` | Shows a finished job's stored result; without `--job-id`, the most recent one. |
| `/localreview:cancel` | Cancels a running review job. |
| `/localreview:setup` | Checks that the server is reachable and lists the models it offers. |

Depending on model size a review can take several minutes. `--background` runs it in the
background; `/localreview:status` and `/localreview:result` then give you progress and
the result.

## Configuration

localreview resolves the server address and the model in this order — the first source
that is set wins:

1. **CLI flag** `--model` / `-m <id>` on `/localreview:review` and `/localreview:setup`
   (overrides the model only, not the server address).
2. **Environment variables**: `LOCALREVIEW_BASE_URL`, `LOCALREVIEW_MODEL`, and
   optionally `LOCALREVIEW_DEADLINE_MS` (timeout in milliseconds, default 1,800,000 =
   30 minutes).
3. **Config file** `~/.config/localreview/config.json`:

   ```json
   {
     "baseUrl": "http://127.0.0.1:8000/v1",
     "model": "Qwen3.8-27B-4bit",
     "deadlineMs": 1800000
   }
   ```

4. **Default**: `http://127.0.0.1:8000/v1` with no fixed model — localreview then uses
   the first model reported by `/v1/models`.

If the configured address is not a loopback address (`127.0.0.1`, `localhost`, `::1`),
both `review` and `setup` warn you explicitly, because your source code then leaves this
machine.

## Excluded files

Files that typically hold credentials are kept out of the review: `.env` and `.env.*`,
`*.pem`, `*.key`, `*.p12`, and private SSH keys (`id_rsa`, `id_dsa`, `id_ecdsa`,
`id_ed25519`, including the `_sk` variants). Matching ignores case.

Excluded means their content reaches neither the payload sent to the model nor the job
log — localreview has git leave them out of the diff in the first place, rather than
filtering them afterwards. The report names every file withheld this way, so the gap
stays visible to you.

If a diff touches nothing but such files, `review` stops with a clear message instead of
reporting a review for which nothing was sent.

Two gaps are known and not yet covered: content inside submodules (`--submodule=diff`)
is not reached by the exclusion pathspecs, and the pattern list is a heuristic — it will
not catch a credential file you named something else.

## Smoke test

Alongside the unit suite (`npm test`) there is a smoke test that really talks to a
running local server: `tests/smoke/omlx.test.mjs`. It deliberately sits outside
`tests/*.test.mjs`, so `npm test` does not run it.

```
npm run smoke
```

The test first probes `${LOCALREVIEW_BASE_URL:-http://127.0.0.1:8000/v1}/models`. If
nothing answers, it skips itself (no failure, exit code 0). If a server answers, it
creates a temporary git repository with a real diff, runs
`review-companion.mjs review --json --wait` against it, and checks that a valid verdict
(`approve` or `needs-attention`) comes back. Because a real model has to answer, the
test allows itself 10 minutes.

## Known limitation

localreview asks the server for structured output via `text.format.json_schema`
(`strict: true`) so it can sort findings by severity. oMLX supports this and honours the
schema. Servers that silently ignore the field — LM Studio does — answer with prose
instead. localreview detects this and shows that prose unchanged, with a warning, rather
than a sorted list of findings.

## Attribution and licence

Apache-2.0. Seven utility modules under `plugins/localreview/scripts/lib/` are derived
from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0);
each carries its original copyright header and `NOTICE` lists them. The design rationale,
including the measured capabilities of the servers this was built against, is in
[docs/superpowers/specs](docs/superpowers/specs).
