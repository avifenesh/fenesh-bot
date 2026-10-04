# LAYA zero-shot on resolved census yes/no questions: noul vs a neutral two-option choice in both orders.
# Input: data/census/census_questions_full_raw.json. Output: data/laya/census_binary.jsonl (resumable).
# Run from the repo root on CPU, capped, e.g.:
#   USE_TF=0 systemd-run --user --scope -p CPUQuota=400% sidecar/.venv/bin/python sidecar/census_eval.py
import json, os, sys, time
os.environ.setdefault('USE_TF', '0')
import torch
torch.set_num_threads(int(os.environ.get('THREADS', '4')))
from laya import Router
rows = json.load(open('data/census/census_questions_full_raw.json'))
os.makedirs('data/laya', exist_ok=True)
out_path = 'data/laya/census_binary.jsonl'
done = set()
if os.path.exists(out_path):
    done = {json.loads(l)['qid'] for l in open(out_path)}
items = []
for r in rows:
    rec = r['record']
    if rec.get('practice') or rec.get('type') != 'binary' or rec.get('annulled'): continue
    if rec.get('resolution') not in ('yes', 'no'): continue
    items.append(rec)
print('items', len(items), 'done', len(done), flush=True)
router = Router(device='cpu')
Q = {
  'noul': {'type': 'noul', 'instructions': 'Will this forecasting question resolve Yes?'},
  'yn': {'type': 'choice', 'instructions': 'How will this forecasting question resolve?',
         'criteria': {'A': 'yes, it resolves Yes', 'B': 'no, it resolves No'}},
  'ny': {'type': 'choice', 'instructions': 'How will this forecasting question resolve?',
         'criteria': {'A': 'no, it resolves No', 'B': 'yes, it resolves Yes'}},
}
with open(out_path, 'a') as f:
    for rec in items:
        if rec['question_id'] in done: continue
        state = {
          'question': rec['title'],
          'today': (rec.get('open_time') or '')[:10],
          'forecast_closes': (rec.get('scheduled_close_time') or '')[:10],
          'resolves': (rec.get('scheduled_resolve_time') or '')[:10],
          'resolution_criteria': (rec.get('resolution_criteria') or '')[:1500],
          'fine_print': (rec.get('fine_print') or '')[:800],
          'background': (rec.get('description') or '')[:2500],
        }
        t = time.time()
        a = router.predict(state, Q, model='multilingual', max_len=2048)['answers']
        f.write(json.dumps({
          'qid': rec['question_id'], 'y': rec['resolution'] == 'yes', 'open': rec.get('open_time'),
          'template': rec.get('template'), 'topic': rec.get('coarse_topic'),
          'noul': a['noul']['noul'], 'yn': a['yn']['probabilities']['A'], 'ny': a['ny']['probabilities']['B'],
          'sec': round(time.time() - t, 2)}) + '\n')
        f.flush()
print('finished', flush=True)
