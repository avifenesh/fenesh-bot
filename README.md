# fenesh-bot

A forecasting bot for the [Metaculus FutureEval](https://www.metaculus.com/futureeval/) bot tournaments
and MiniBench. It runs as one service: a [glide-mq](https://github.com/avifenesh/glide-mq) worker on Valkey
that polls for open questions, researches each one, asks several frontier models for a forecast,
aggregates them in code and posts the forecast with a comment explaining it.

## How a question is forecast

1. **Plan.** GPT-6.1 Sol at low effort writes search queries, Wikipedia titles, prediction-market queries and
   data series to pull.
2. **Gather.** Every research source runs in parallel: web search (the
   [harness-websearch](https://github.com/avifenesh/tools) CLI's keyless chain: Exa, Parallel, Mojeek,
   Marginalia, Wikipedia), news (AskNews, GDELT, Wikipedia Current Events), Wikipedia, Polymarket and Manifold prices, the pages named in the resolution criteria, and
   FRED / CoinGecko / Yahoo Finance series with summary statistics.
3. **Research brief.** GPT-6.1 Sol reads the gathered items and uses the same sources as tools to check the
   resolution source, verify key claims and find base rates. It writes a dated, sourced brief with no
   probability in it.
4. **Forecast.** Four reasoning models (GPT-6 Astra, GPT-6.1 Sol, Claude Opus 5.5, Claude Fable 5.1)
   forecast independently from the brief at high reasoning effort.
5. **Aggregate in code.** Yes/no: median, kept within 2-98%. Multiple choice: mean per option. Numeric,
   discrete and date: pointwise median of the models' CDFs, widened 15% around the median, then
   standardized to the Metaculus CDF rules.
6. **Disagreement check.** When the models disagree beyond a threshold, a supervisor (Opus 5.5 with the
   research tools) finds and checks the crux, and the models forecast again with its addendum.
7. **Submit.** The forecast and a comment with every model's forecast and the brief.

Every run is archived in SQLite (inputs, every model's forecast, the submission, cost) so each component
can be scored when questions resolve.

## Reliability

- Questions are open for a few hours and a missed question scores zero, so each question job has a
  deterministic id (no double work), retries, and a delayed safety job that forecasts on a cheaper path
  25 minutes before close if nothing was submitted.
- Earliest-closing questions run first.
- A per-question cost cap and a daily budget; past the budget the bot uses the cheaper path (GPT-6.1 Sol,
  Opus 5.5 and Fable 5.1, no supervisor). MiniBench gets the full path, since it is the
  bench the system is tuned against.
- Alerts (a question failed or closed unforecast) are logged as
  `{"msg":"alert"}`. `deploy/alert-relay.sh` runs on the owner's machine every 2 minutes
  (`deploy/fenesh-alert-relay.timer`), reads them from the host's journal over SSH and sends them to the
  owner's phone with `hermes send`. `FENESH_ALERT_WEBHOOK` is an optional extra channel.

## Models

All models run on Amazon Bedrock with a bearer key:

| Model | Bedrock id | API | Fallback |
|---|---|---|---|
| GPT-6 Astra | `openai.gpt-6-astra` | Mantle Responses (`/openai/v1/responses`) | GPT-6 Sol |
| GPT-6.1 Sol | `global.openai.gpt-6.1-sol` | bedrock-runtime Responses (`/openai/v1/responses`) | GPT-6 Sol |
| Claude Opus 5.5 | `global.anthropic.claude-opus-5-5` | Converse, adaptive thinking | Claude Sonnet 5.5 |
| Claude Fable 5.1 | `global.anthropic.claude-fable-5-1` | Converse, adaptive thinking | Claude Sonnet 5.5 |
| GPT-6 Sol (fallback only) | `global.openai.gpt-6-sol` | bedrock-runtime Responses | Claude Sonnet 5.5 |
| Claude Sonnet 5.5 (fallback only) | `global.anthropic.claude-sonnet-5-5` | Converse | GPT-6 Sol |

Every call has a fallback chain: a failed or empty reply is retried once, then the model's fallback
answers, then the fallback's fallback, never a model already tried. A model that fails two calls in a
row is skipped for 15 minutes. A forecaster's fallback is never another ensemble member, and if two
members fall back to the same model only its first answer counts.

Reasoning effort is never below medium: forecasts run at xhigh (GPT) and high (Claude), research at
high, and the small steps (plan, classification, market match, JSON repair, wiki) at medium. The prompt
cache is always on: Claude calls carry a cache point at the end of the conversation, and GPT calls a
`prompt_cache_key`, so repeated prefixes (tool-loop rounds, the two forecast rounds, a revision) bill at
the cache-read rate. Costs count cache reads and writes, and the long-context rates GPT models charge
above 272K input tokens.

GPT-6.1 Sol is an exception to the plain `openai.*` id rule: it only runs as the global inference
profile on bedrock-runtime, where the bare id is refused with "on-demand throughput isn't supported".

## Setup (first time on a machine)

Node 24 or newer runs the TypeScript directly; there is no build step.

```bash
npm ci
cp .env.example .env   # fill in METACULUS_TOKEN, AWS_BEARER_TOKEN_BEDROCK, ASKNEWS_API_KEY
set -a; . ./.env; set +a
node src/cli.ts run <post-id> --dry-run   # forecast one question without submitting
node src/cli.ts status                    # recent runs and spend
```

Run the service against a local Valkey:

```bash
valkey-server --port 6379 &
node src/cli.ts worker
```

## Deploy

`deploy/push.sh <ssh-target>` ships the current commit and runs `deploy/install.sh` there: Node, Valkey
(loopback, append-only), a swap file and the systemd unit on an Ubuntu 24.04 host. The env file goes to `/etc/fenesh-bot/env` and is never committed.

## Tests

```bash
npm test          # integration tests; the queue test starts its own Valkey on a free port
npm run typecheck
```

## License

MIT. Parts of `src/numeric.ts` are ported from
[forecasting-tools](https://github.com/Metaculus/forecasting-tools) (MIT); see `NOTICE`.
