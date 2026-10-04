# fenesh-bot: agent instructions

Metaculus forecasting bot (bot user `fenesh-bot`, id 309777). TypeScript run directly by Node >= 24
(type stripping: no enums, no parameter properties, `.ts` import extensions). glide-mq on Valkey.

## Rules

- Secrets live only in the environment (`/etc/fenesh-bot/env` on the host, `~/.config/metaculus/bot.env`
  and `~/.config/tiyuvta/bedrock.env` on the rig). Never commit them, never print them.
- Model calls go through Bedrock with metered keys only. No consumer logins (Claude Max, SuperGrok,
  ChatGPT) in the bot's path. Claude ids use `global.anthropic.*`; OpenAI ids are plain `openai.*` on
  Mantle; never `us.` ids. Exception (owner, 2026-10-04): GPT-6.1 Sol runs only as the profile
  `global.openai.gpt-6.1-sol` on bedrock-runtime; the bare id is refused there.
- No Grok model and no X / xAI API at all (owner decision 2026-10-04). No gpt-oss either. The ensemble
  is GPT-6 Astra, GPT-6.1 Sol, Opus 5.5, Fable 5.1 plus LAYA as the System 1 vote (owner, 2026-10-04):
  `convaiinnovations/laya`, multilingual checkpoint, a non-generative decision model that runs on CPU
  in the loopback sidecar (`sidecar/`, `deploy/fenesh-laya.service`), never on Bedrock. Its
  probabilities always go through `src/laya-calibration.json`; refit with `sidecar/calibrate.py` after
  rerunning the census evals, and keep the pinned revision in the unit and the calibration in step.
  Fine-tuning LAYA is a later lever. The park-predictor lane allowed copying `tools/laya_ft_v5.py`;
  its weights, its data (`~/park-predictor-data`) and the 5090 lock are off limits.
- The fast steps (plan, base-rate class, market match, JSON repair, wiki) run on GPT-6.1 Sol at low
  effort through `fast()` in `src/llm.ts`.
- Research sources plug into `src/research/sources.ts`; add one there only when the owner approves it.
  AskNews (approved 2026-10-04) bills credits per search and is capped per day.
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
