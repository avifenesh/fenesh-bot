// Priors for the forecasters, built on the fast model: the question's base-rate class and an
// exact-match prediction market.

import { readFileSync } from 'node:fs';
import { asOfMs } from './asof.ts';
import { fast, lastJson } from './llm.ts';
import { log } from './log.ts';
import type { Question } from './metaculus.ts';
import { today } from './prompts.ts';
import { marketSearch, type MarketQuote } from './research/sources.ts';

interface Rate { yes: number; n: number }
type Rates = { source: string; overall: Rate; byTemplate: Record<string, Rate>; byTopic: Record<string, Rate> };
const LIVE_RATES = JSON.parse(readFileSync(new URL('./base-rates.json', import.meta.url), 'utf8')) as Rates;
// Backtests use rates from questions that resolved before the backtest window, so a question under
// test never feeds its own prior.
const BACKTEST_RATES = JSON.parse(readFileSync(new URL('./base-rates-spring.json', import.meta.url), 'utf8')) as Rates;

const pct = (r: Rate) => `${Math.round((100 * r.yes) / r.n)}% (${r.yes} of ${r.n})`;

export interface Classification { template?: string; topic?: string; baseRateText: string }

export async function classify(q: Question): Promise<Classification> {
  if (q.type !== 'binary') return { baseRateText: '' };
  const RATES = asOfMs() == null ? LIVE_RATES : BACKTEST_RATES;
  const templates = Object.keys(RATES.byTemplate);
  const topics = Object.keys(RATES.byTopic);
  try {
    const r = await fast(`Classify this forecasting question.

${q.title}
${q.resolutionCriteria.slice(0, 1500)}

Templates: ${templates.map((t) => `"${t}"`).join(', ')}
Topics: ${topics.map((t) => `"${t}"`).join(', ')}

Return only JSON: {"template": "<one template, verbatim>", "topic": "<one topic, verbatim>"}`, { label: 'classify', effort: 'low', maxTokens: 2000 });
    const j = lastJson(r.text);
    const template = templates.includes(j.template) ? j.template : undefined;
    const topic = topics.includes(j.topic) ? j.topic : undefined;
    const parts = [`Across ${RATES.overall.n} resolved yes/no questions in past Metaculus bot tournaments, ${pct(RATES.overall)} resolved Yes.`];
    if (template && RATES.byTemplate[template].n >= 8) parts.push(`Questions of the form "${template}": ${pct(RATES.byTemplate[template])} resolved Yes.`);
    if (topic && RATES.byTopic[topic].n >= 8) parts.push(`Questions on ${topic}: ${pct(RATES.byTopic[topic])} resolved Yes.`);
    parts.push('Use these as a weak starting point; specific evidence about this question matters more.');
    return { template, topic, baseRateText: parts.join(' ') };
  } catch (e: any) {
    log.warn('classify failed', { q: q.questionId, err: e.message });
    const R = asOfMs() == null ? LIVE_RATES : BACKTEST_RATES;
    return { baseRateText: `Across ${R.overall.n} resolved yes/no questions in past Metaculus bot tournaments, ${pct(R.overall)} resolved Yes.` };
  }
}

export interface MarketMatch { quote: MarketQuote; confidence: number }

// Pick a market that asks the same question with the same deadline, or none. The model sees the
// candidates in shuffled order with an explicit "none" option; dates are then checked in code.
export async function matchMarket(q: Question, queries: string[]): Promise<MarketMatch | null> {
  if (q.type !== 'binary') return null;
  const seen = new Set<string>();
  const quotes: MarketQuote[] = [];
  for (const res of await Promise.allSettled(queries.slice(0, 3).map(marketSearch))) {
    if (res.status !== 'fulfilled') continue;
    for (const m of res.value) if (!seen.has(m.url + m.question)) { seen.add(m.url + m.question); quotes.push(m); }
  }
  if (!quotes.length) return null;
  const shuffled = quotes.map((m) => ({ m, k: Math.random() })).sort((a, b) => a.k - b.k).map((x) => x.m).slice(0, 25);
  try {
    const r = await fast(`Today is ${today()}. Does any of these prediction markets resolve on exactly the same event as the question, with the same threshold and essentially the same deadline? Be strict: a related market, a different deadline, a different threshold or a broader/narrower event is NOT a match.

Question: ${q.title}
Closes for forecasting ${q.closeTime.slice(0, 10)}, resolves ${q.resolveTime.slice(0, 10)}.
Resolution criteria: ${q.resolutionCriteria.slice(0, 1500)}

Markets:
0. none of these
${shuffled.map((m, i) => `${i + 1}. ${m.question} (closes ${m.closeTime?.slice(0, 10) ?? '?'})`).join('\n')}

Return only JSON: {"choice": <number>, "confidence": <0-1>, "same_direction": <true if the market's Yes equals the question's Yes>}`, { label: 'market-match', effort: 'medium', maxTokens: 3000 });
    const j = lastJson(r.text);
    const i = Number(j.choice);
    if (!Number.isInteger(i) || i < 1 || i > shuffled.length) return null;
    const quote = { ...shuffled[i - 1] };
    if (j.same_direction === false) quote.probability = 1 - quote.probability;
    // Deadline check in code: the market must close within 10 days of the question's resolution date.
    const gap = Math.abs(Date.parse(quote.closeTime ?? '') - Date.parse(q.resolveTime)) / 86_400_000;
    if (!Number.isFinite(gap) || gap > 10) return null;
    return { quote, confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)) };
  } catch (e: any) {
    log.warn('market match failed', { q: q.questionId, err: e.message });
    return null;
  }
}
