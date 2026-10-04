# fenesh-bot

A forecasting bot for the [Metaculus FutureEval](https://www.metaculus.com/futureeval/) bot tournaments
and MiniBench. It runs as one service: a [glide-mq](https://github.com/avifenesh/glide-mq) worker on Valkey
that polls for open questions, researches each one, asks several frontier models for a forecast,
aggregates them in code and posts the forecast with a comment explaining it.

## How a question is forecast

1. **Plan.** An open-weight model (gpt-oss-120b) writes search queries, Wikipedia titles, prediction-market
   queries and data series to pull.
2. **Gather.** Every research source runs in parallel: web search, news, Wikipedia, Polymarket and Manifold
   prices, the pages named in the resolution criteria, and FRED / CoinGecko / Yahoo Finance series with
   summary statistics.
3. **Research brief.** GPT-6.1 Sol reads the gathered items and uses the same sources as tools to check the
   resolution source, verify key claims and find base rates. It writes a dated, sourced brief with no
   probability in it.
4. **Forecast.** GPT-6 Astra, GPT-6.1 Sol, Claude Opus 5.5, Claude Fable 5.1 and gpt-oss-120b forecast
   independently from the brief at high reasoning effort (gpt-oss at medium).
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
- A per-question cost cap and a daily budget; past the budget the bot uses the cheaper path.
- Alerts go to a webhook (`FENESH_ALERT_WEBHOOK`) when a question fails or closes unforecast.

## Models

All models run on Amazon Bedrock with a bearer key: Claude through the Converse API, GPT-6 models through
Mantle's OpenAI-compatible Responses API (`/openai/v1/responses`), and gpt-oss-120b through Mantle's
`/v1/responses`.

## Setup (first time on a machine)

Node 24 or newer runs the TypeScript directly; there is no build step.

```bash
npm ci
cp .env.example .env   # fill in METACULUS_TOKEN and AWS_BEARER_TOKEN_BEDROCK
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

`deploy/install.sh <release.tar.gz>` installs Node, Valkey (loopback, append-only) and the systemd unit
on an Ubuntu 24.04 host. The env file goes to `/etc/fenesh-bot/env` and is never committed.

## Tests

```bash
npm test          # integration tests; the queue test starts its own Valkey on a free port
npm run typecheck
```

## License

MIT. Parts of `src/numeric.ts` are ported from
[forecasting-tools](https://github.com/Metaculus/forecasting-tools) (MIT); see `NOTICE`.
