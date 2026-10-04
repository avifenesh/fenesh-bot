// Fast steps on the open-weight model: question classification for base rates, exact-match
// market selection, and a quick gut forecast that is logged (and only used once it earns it).

import { readFileSync } from 'node:fs';
import { config } from './config.ts';
import { call, lastJson } from './llm.ts';
import { log } from './log.ts';
import type { Question } from './metaculus.ts';
import { questionBlock, today } from './prompts.ts';
import { marketSearch, type MarketQuote } from './research/sources.ts';

interface Rate { yes: number; n: number }
const RATES = JSON.parse(readFileSync(new URL('./base-rates.json', import.meta.url), 'utf8')) as {
  source: string; overall: Rate; byTemplate: Record<string, Rate>; byTopic: Record<string, Rate>;
};

const pct = (r: Rate) => `${Math.round((100 * r.yes) / r.n)}% (${r.yes} of ${r.n})`;

export interface Classification { template?: string; topic?: string; baseRateText: string }

export async function classify(q: Question): Promise<Classification> {
  if (q.type !== 'binary') return { baseRateText: '' };
  const templates = Object.keys(RATES.byTemplate);
  const topics = Object.keys(RATES.byTopic);
  try {
    const r = await call(config.fastModel, `Classify this forecasting question.

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
    return { baseRateText: `Across ${RATES.overall.n} resolved yes/no questions in past Metaculus bot tournaments, ${pct(RATES.overall)} resolved Yes.` };
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
    const r = await call(config.fastModel, `Today is ${today()}. Does any of these prediction markets resolve on exactly the same event as the question, with the same threshold and essentially the same deadline? Be strict: a related market, a different deadline, a different threshold or a broader/narrower event is NOT a match.

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

// Gut forecast from the question and base rate alone, no research. Logged as a component.
export async function gut(q: Question, baseRate: string): Promise<{ pYes?: number; probs?: Record<string, number>; costUsd: number }> {
  if (q.type !== 'binary' && q.type !== 'multiple_choice') return { costUsd: 0 };
  try {
    const r = await call(config.fastModel, `Today is ${today()}. Give a quick forecast from what you already know; do not overthink.

${questionBlock(q)}

${baseRate}

Return only JSON: ${q.type === 'binary' ? '{"p_yes": <0-1>}' : `{"probabilities": {${q.options.map((o) => `"${o}": <p>`).join(', ')}}}`}`, { label: 'gut', effort: 'low', maxTokens: 3000 });
    const j = lastJson(r.text);
    if (q.type === 'binary') {
      const p = Number(j.p_yes);
      return Number.isFinite(p) && p >= 0 && p <= 1 ? { pYes: p, costUsd: r.usage.costUsd } : { costUsd: r.usage.costUsd };
    }
    return { probs: j.probabilities, costUsd: r.usage.costUsd };
  } catch (e: any) {
    log.warn('gut failed', { q: q.questionId, err: e.message });
    return { costUsd: 0 };
  }
}
