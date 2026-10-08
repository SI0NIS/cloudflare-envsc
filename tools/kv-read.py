#!/usr/bin/env python
# 从阿里云函数配置里取回 CF_API_TOKEN，再直接读 Cloudflare KV。
# 用途：wrangler OAuth 过期后，仍能读写 KV（不打印 token 明文）。
import io, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _aliyun_env import load_aliyun_env          # 凭据自动加载：环境变量优先，缺失时读 .env.aliyun
load_aliyun_env()
from alibabacloud_fc20230330.client import Client as FC
from alibabacloud_fc20230330 import models as fm
from alibabacloud_tea_util import models as util
import alibabacloud_tea_util, urllib.request, urllib.parse
from alibabacloud_tea_util import models as util
from alibabacloud_tea_openapi import models as openapi_models

UID='1355617125073513'; REGION='cn-hangzhou'; NAME='envsc-marks-sync'
NS='2f5ad113e1d24eb6b76ce6a95d3dc804'
RT=util.RuntimeOptions(connect_timeout=15000, read_timeout=60000)
_CF_ACC=[None]
_TOK=[None]

def cf_account(tok):
    """CF 账号 ID 与阿里云 UID 无关（曾误用 UID 导致 404），这里动态解析一次并缓存。"""
    if _CF_ACC[0]: return _CF_ACC[0]
    req=urllib.request.Request('https://api.cloudflare.com/client/v4/accounts',
                               headers={'Authorization':f'Bearer {tok}'})
    with urllib.request.urlopen(req, timeout=30) as r:
        accs=json.loads(r.read().decode()).get('result',[])
    if not accs: raise RuntimeError('该 token 看不到任何 CF 账号')
    _CF_ACC[0]=accs[0]['id']
    return _CF_ACC[0]

def fc_client():
    cfg=openapi_models.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
        access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'])
    cfg.endpoint=f'{UID}.{REGION}.fc.aliyuncs.com'
    return FC(cfg)

def get_cf_token():
    c=fc_client()
    r=c.get_function_with_options(NAME, fm.GetFunctionRequest(), None, RT)
    env = (getattr(r.body, 'environment_variables', None) or {})
    return env.get('CF_API_TOKEN') or env.get('cf_api_token')

def kv_get(tok, key):
    url=f'https://api.cloudflare.com/client/v4/accounts/{cf_account(tok)}/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}'
    req=urllib.request.Request(url, headers={'Authorization':f'Bearer {tok}'})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode('utf-8')

def kv_url(key):
    return f'https://api.cloudflare.com/client/v4/accounts/{cf_account(_TOK[0])}/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}'

def kv_put(tok, key, value):
    _TOK[0] = tok
    req = urllib.request.Request(kv_url(key), data=value.encode('utf-8'), method='PUT',
                                 headers={'Authorization': f'Bearer {tok}',
                                          'Content-Type': 'text/plain; charset=utf-8'})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode('utf-8')

def kv_list(tok, prefix=None):
    url=f'https://api.cloudflare.com/client/v4/accounts/{cf_account(tok)}/storage/kv/namespaces/{NS}/keys'
    if prefix: url += '?prefix=' + urllib.parse.quote(prefix, safe='')
    req=urllib.request.Request(url, headers={'Authorization':f'Bearer {tok}'})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode('utf-8'))

if __name__=='__main__':
    tok=get_cf_token()
    if not tok:
        print('NO_TOKEN'); sys.exit(1)
    if sys.argv[1:2] == ['--list']:
        d=kv_list(tok, sys.argv[2] if len(sys.argv)>2 else None)
        for it in d.get('result',[]):
            print(it['name'])
        sys.exit(0)
    if sys.argv[1:2] == ['--put']:
        key = sys.argv[2]
        src = sys.argv[3]
        with open(src, 'rb') as f:
            body = f.read()
        if key == '-':
            key = json.loads(body.decode('utf-8')).get('key')
        kv_put(tok, key, body.decode('utf-8'))
        print(f'PUT_OK {key} ({len(body)} bytes)')
        sys.exit(0)
    for key in sys.argv[1:]:
        try:
            print(f'=== {key} ==='); print(kv_get(tok, key))
        except Exception as e:
            print(f'=== {key} === ERR {e}')
