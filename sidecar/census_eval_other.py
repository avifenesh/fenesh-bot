# LAYA zero-shot on resolved census multiple-choice questions (both option orders) and numeric/discrete
# questions (noul "at most v" at five range locations), the same asks src/laya.ts makes.
# Input: data/census/census_questions_full_raw.json. Output: data/laya/census_other.jsonl (resumable).
# Run like census_eval.py.
import json, math, os, time
os.environ.setdefault('USE_TF', '0')
import torch
torch.set_num_threads(int(os.environ.get('THREADS', '4')))
from laya import Router
rows = json.load(open('data/census/census_questions_full_raw.json'))
os.makedirs('data/laya', exist_ok=True)
out_path = 'data/laya/census_other.jsonl'
done = {json.loads(l)['qid'] for l in open(out_path)} if os.path.exists(out_path) else set()
LOCS = [0.1, 0.3, 0.5, 0.7, 0.9]
def from_loc(rec, x):
    lo, hi, z = rec['range_min'], rec['range_max'], rec['zero_point']
    if z is None: return lo + (hi - lo) * x
    ratio = (hi - z) / (lo - z)
    return lo + (hi - lo) * (ratio ** x - 1) / (ratio - 1)
def fmt(v): return str(int(round(v))) if abs(v) >= 100 else ('%.4g' % v)
def base_state(rec):
    return {'question': rec['title'], 'today': (rec.get('open_time') or '')[:10],
            'forecast_closes': (rec.get('scheduled_close_time') or '')[:10],
            'resolves': (rec.get('scheduled_resolve_time') or '')[:10],
            'resolution_criteria': (rec.get('resolution_criteria') or '')[:1500],
            'fine_print': (rec.get('fine_print') or '')[:800],
            'background': (rec.get('description') or '')[:2500]}
router = Router(device='cpu')
items = [r['record'] for r in rows if not r['record'].get('practice') and r['record'].get('resolution') not in (None, '', 'annulled', 'ambiguous')
         and (r['record']['type'] == 'multiple_choice' and r['record'].get('resolved_option_index') is not None
              or r['record']['type'] in ('numeric', 'discrete') and r['record'].get('resolution_position_in_range') is not None)]
print('items', len(items), 'done', len(done), flush=True)
keys = [chr(65 + i) for i in range(26)]
with open(out_path, 'a') as f:
    for rec in items:
        if rec['question_id'] in done: continue
        t = time.time(); st = base_state(rec)
        if rec['type'] == 'multiple_choice':
            opts = [o.strip() for o in rec['options'].split(' | ')]
            if len(opts) != rec['n_options'] or len(opts) > 20: continue
            fwd = {keys[i]: o for i, o in enumerate(opts)}
            rev = {keys[i]: o for i, o in enumerate(reversed(opts))}
            Q = {'fwd': {'type': 'choice', 'instructions': 'Which option will this forecasting question resolve to?', 'criteria': fwd},
                 'rev': {'type': 'choice', 'instructions': 'Which option will this forecasting question resolve to?', 'criteria': rev}}
            a = router.predict(st, Q, model='multilingual', max_len=2048)['answers']
            pf = [a['fwd']['probabilities'][keys[i]] for i in range(len(opts))]
            pr = [a['rev']['probabilities'][keys[len(opts) - 1 - i]] for i in range(len(opts))]
            row = {'qid': rec['question_id'], 'type': 'mc', 'k': len(opts), 'y': rec['resolved_option_index'], 'fwd': pf, 'rev': pr}
        else:
            unit = f" {rec['unit']}" if rec.get('unit') else ''
            Q = {f't{i}': {'type': 'noul', 'instructions': f'Will the value this question resolves to be at most {fmt(from_loc(rec, x))}{unit}?'} for i, x in enumerate(LOCS)}
            a = router.predict(st, Q, model='multilingual', max_len=2048)['answers']
            row = {'qid': rec['question_id'], 'type': rec['type'], 'pos': rec['resolution_position_in_range'], 'locs': LOCS,
                   'p': [a[f't{i}']['noul'] for i in range(len(LOCS))]}
        row['sec'] = round(time.time() - t, 2)
        f.write(json.dumps(row) + '\n'); f.flush()
print('finished', flush=True)
