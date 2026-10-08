#!/usr/bin/env python
# 查 envsc Worker 今日 UTC 调用分布（GraphQL analytics），定位 06:00 幽灵触发来源
import json, os, sys, urllib.request
sys_path = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, sys_path)
from _aliyun_env import ensure_aliyun_env          # 环境变量优先，缺失时自动读 .env.aliyun
ensure_aliyun_env()
# 复用 kv-read 的 token 获取
import importlib.util
spec = importlib.util.spec_from_file_location('kvread', os.path.join(sys_path, 'kv-read.py'))
kv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kv)
tok = kv.get_cf_token()
ACC = 'df42e87e7315eea710e3b9e21a954619'
H = {'Authorization': f'Bearer {tok}', 'Content-Type': 'application/json'}
q = ('{viewer{accounts(filter:{accountTag:"' + ACC + '"}){workersInvocationsAdaptive('
     'limit:100,filter:{scriptName:"envsc",datetime_geq:"2026-10-08T00:00:00Z",datetime_leq:"2026-10-08T08:30:00Z"},'
     'orderBy:[datetime_ASC]){dimensions{datetime}sum{requests}}}}}')
req = urllib.request.Request('https://api.cloudflare.com/client/v4/graphql', data=json.dumps({'query': q}).encode(), headers=H)
d = json.loads(urllib.request.urlopen(req, timeout=40).read().decode())
if d.get('errors'):
    print('GQL_ERR', json.dumps(d['errors'], ensure_ascii=False)[:800])
rows = (d.get('data') or {}).get('viewer', {}).get('accounts', [{}])[0].get('workersInvocationsAdaptive') or []
for x in rows:
    print(x['dimensions']['datetime'], '->', x['sum']['requests'], 'invocations')
if not rows:
    print('（该时段无调用记录）')
