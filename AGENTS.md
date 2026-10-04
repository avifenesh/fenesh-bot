# fenesh-bot: agent instructions

Metaculus forecasting bot (bot user `fenesh-bot`, id 309777). TypeScript run directly by Node >= 24
(type stripping: no enums, no parameter properties, `.ts` import extensions). glide-mq on Valkey.

## Rules

- Secrets live only in the environment (`/etc/fenesh-bot/env` on the host, `~/.config/metaculus/bot.env`
  and `~/.config/tiyuvta/bedrock.env` on the rig). Never commit them, never print them.
- Model calls go through Bedrock with metered keys only. No consumer logins (Claude Max, SuperGrok,
  ChatGPT) in the bot's path. Claude ids use `global.anthropic.*`; OpenAI ids are plain `openai.*` on
  Mantle; never `us.` ids.
- No X / xAI API source for now (owner decision 2026-10-04). Research sources plug into
  `src/research/sources.ts`; add one there when the owner approves it.
- One forecast per question. Never resubmit a question unless the owner asks.
- `--dry-run` for any manual test against live questions.
- The repo is private until the owner says to open-source it; keep code and docs free of private research
  framing.
- Prompt or aggregation changes are measured before they ship: compare on the archived runs or paired
  shadow runs, not on one MiniBench round (too few questions to separate variants).

## Layout

- `src/cli.ts` entry points (run, worker, poll, status)
- `src/queue.ts` the glide-mq service (poll scheduler, question jobs, safety jobs, alerts)
- `src/pipeline.ts` one question end to end
- `src/prompts.ts` prompt text
- `src/llm.ts` Bedrock transports and tool loop
- `src/numeric.ts` percentile -> CDF -> Metaculus CDF rules
- `src/research/` sources and HTTP
- `src/store.ts` SQLite archive
- `deploy/` systemd unit and install script

## Tests

`npm test` (vitest). Integration tests over unit tests; the queue test needs `valkey-server` on PATH.
