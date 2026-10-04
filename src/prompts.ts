// Prompt text. Rules here come from measured misses of earlier tournament bots and from the
// Metaculus question census (base rates of past bot-tournament questions).

import type { Question } from './metaculus.ts';
import { fromLocation } from './numeric.ts';

export function today(): string { return new Date().toISOString().slice(0, 10); }

function fmtValue(q: Question, v: number): string {
  if (q.type === 'date') return new Date(v * 1000).toISOString().slice(0, 10);
  return Number.isInteger(v) ? String(v) : v.toPrecision(6);
}

export function questionBlock(q: Question): string {
  const lines = [
    `Title: ${q.title}`,
    `Type: ${q.type}`,
    `URL: ${q.url}`,
    `Forecast closes: ${q.closeTime} (your forecast is scored as of then)`,
    `Scheduled resolution: ${q.resolveTime}`,
  ];
  if (q.type === 'multiple_choice') lines.push(`Options: ${q.options.map((o) => `"${o}"`).join(', ')}`);
  if (q.scaling && q.type !== 'multiple_choice' && q.type !== 'binary') {
    const s = q.scaling;
    lines.push(
      `Range: ${fmtValue(q, s.rangeMin)} to ${fmtValue(q, s.rangeMax)}${q.unit ? ` (unit: ${q.unit})` : ''}${s.zeroPoint != null ? ' on a log scale' : ''}`,
      `Lower bound ${s.openLower ? 'is open (the outcome can fall below it)' : 'is closed (the outcome cannot fall below it)'}; upper bound ${s.openUpper ? 'is open (the outcome can exceed it)' : 'is closed (the outcome cannot exceed it)'}.`,
    );
    if (q.type === 'discrete') lines.push(`Discrete outcomes from ${fmtValue(q, fromLocation(s, 0.5 / (s.cdfSize - 1)))} to ${fmtValue(q, fromLocation(s, 1 - 0.5 / (s.cdfSize - 1)))}.`);
  }
  lines.push('', 'Background:', q.description || '(none)', '', 'Resolution criteria:', q.resolutionCriteria || '(none)', '', 'Fine print:', q.finePrint || '(none)');
  return lines.join('\n');
}

export function planPrompt(q: Question): string {
  return `Today is ${today()}. You are planning research for a forecasting question.

${questionBlock(q)}

Return only a JSON object with:
- "queries": 4-6 web/news search queries that would surface the most recent decisive facts (names, numbers, scheduled events, official statements). Mix specific and broad.
- "wiki_titles": 0-3 English Wikipedia article titles with useful background.
- "market_queries": 1-3 short phrases to find prediction markets on the same or a closely related event.
- "series": 0-3 data series that track the quantity in question, each {"kind": "fred"|"crypto"|"stock", "id": "..."} (FRED series id, CoinGecko coin id, or Yahoo Finance ticker). Only include series you are confident exist.`;
}

export function researchPrompt(q: Question, digest: string): string {
  return `Today is ${today()}. You are the research analyst for a forecasting team. Your job is to find and verify the facts that decide this question. You do not give a probability; the forecasters do that from your brief.

${questionBlock(q)}

Initial search results (titles, snippets and data gathered automatically):
${digest}

Use the tools to:
1. Read the resolution source itself if one is named, and record its current value or state.
2. Find the most recent facts that move the outcome (dates, numbers, official statements, scheduled events before the close and resolution dates).
3. Verify any key claim against a primary or second independent source. Note conflicts instead of picking a side.
4. Establish the status quo: what happens if nothing changes from today.
5. Find base rates: how often events of this kind happened in comparable past cases.
6. Check prediction markets on the same event and note their prices and volume.

Then write the brief in this format:

## Status quo
## Key facts (each with date and source URL)
## Scheduled events before resolution
## Base rates and reference classes
## Market and crowd signals
## Conflicting or uncertain evidence
## What would change the outcome

Be factual and dated. Do not include a probability for the question.`;
}

const RULES = `Rules that improved past tournament bots:
- The question is still open today. Do not treat it as already resolved unless the brief shows the resolution condition has been met in a way the resolution source will count.
- Read the resolution criteria and fine print literally: exact thresholds, dates, time zones, units and the named source decide it, not the spirit of the question.
- Start from the status quo and base rates, then adjust for specific evidence. In past bot tournaments about two thirds of yes/no questions resolved No, "will X happen by date D" questions resolved Yes about a quarter of the time, and the "nothing changes" outcome won about two thirds of the time.
- Announced, planned or expected events often slip. Treat a date that is not legally or contractually binding as soft.
- If a liquid prediction market asks the same question with the same deadline, give its price heavy weight; explain any deviation.
- Scoring is logarithmic against other forecasters: confident misses cost far more than confident hits earn. Avoid probabilities below 2% or above 98% unless the outcome is effectively settled.`;

function answerSpec(q: Question): string {
  if (q.type === 'binary') {
    return `End your answer with a JSON block:
\`\`\`json
{"p_yes": <probability the question resolves Yes, 0-1>, "p_no": <probability it resolves No, 0-1>, "summary": "<two sentences: the main reason>"}
\`\`\`
p_yes and p_no should add to 1; they are checked against each other.`;
  }
  if (q.type === 'multiple_choice') {
    return `Give every option a probability; the probabilities must add to 1. Options that are long shots still get at least 1%. An "Other"/"None of these" option rarely wins unless the evidence points to it.
End your answer with a JSON block:
\`\`\`json
{"probabilities": {${q.options.map((o) => `"${o.replace(/"/g, '\\"')}": <p>`).join(', ')}}, "summary": "<two sentences>"}
\`\`\``;
  }
  const unit = q.type === 'date' ? 'ISO dates (YYYY-MM-DD)' : `numbers in the question's unit${q.unit ? ` (${q.unit})` : ''}`;
  return `Give your full distribution as percentiles, values as ${unit}. Think about the tails: in past tournaments about 7% of numeric outcomes fell outside the question's range, and forecasters' 90% intervals covered the outcome only about 75-80% of the time, so make the 1st and 99th percentiles genuinely extreme. Values must increase with the percentile.
End your answer with a JSON block:
\`\`\`json
{"percentiles": {"1": <v>, "5": <v>, "10": <v>, "20": <v>, "30": <v>, "40": <v>, "50": <v>, "60": <v>, "70": <v>, "80": <v>, "90": <v>, "95": <v>, "99": <v>}, "summary": "<two sentences>"}
\`\`\``;
}

export function forecastPrompt(q: Question, brief: string, extra = ''): string {
  return `Today is ${today()}. You are a superforecaster on a forecasting team. Forecast this question.

${questionBlock(q)}

Research brief from the team's analyst:
${brief}
${extra ? `\n${extra}\n` : ''}
${RULES}

Reason step by step: outside view (base rates, status quo), then inside view (specific evidence), then reconcile. Keep the reasoning focused.

${answerSpec(q)}`;
}

export function supervisorPrompt(q: Question, brief: string, forecasts: string): string {
  return `Today is ${today()}. Several forecasters disagree on this question. Your job is to find the fact that explains the disagreement and settle it with evidence.

${questionBlock(q)}

Research brief they all read:
${brief}

Their forecasts and reasoning:
${forecasts}

Identify the one or two cruxes (facts or interpretations they disagree about). Use the tools to check each crux against primary sources, and check the resolution criteria wording. Then write an addendum for the forecasters:

## Cruxes
## What the evidence shows (with sources and dates)
## Resolution-criteria reading

Do not give a probability.`;
}
