#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 tools/scf-marks-sync/index.js 部署到阿里云函数计算 FC（3.0）。

凭据走环境变量（SDK 默认约定）：
    ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET
函数自身要用的环境变量用 FENV_ 前缀传入（不落盘）：
    FENV_CNEMC_COOKIE / FENV_CF_ACCOUNT_ID / FENV_CF_KV_NAMESPACE_ID /
    FENV_CF_API_TOKEN / FENV_BARK_KEY / FENV_CNPEMC_PSID / FENV_DAYS / FENV_ACCESS_TOKEN

用法：
    python fc-deploy.py                       # 建函数 + 建定时触发器
    python fc-deploy.py --update              # 只更新代码/配置
    python fc-deploy.py --invoke '{"dry":true,"date":"2026-09-26"}'
    python fc-deploy.py --endpoint fc.cn-shanghai.aliyuncs.com --region cn-shanghai
"""
import argparse, base64, io, json, os, sys, zipfile

from alibabacloud_fc20230330.client import Client as FCClient
from alibabacloud_fc20230330 import models as fm
from alibabacloud_tea_openapi.models import Config as OpenApiConfig
from alibabacloud_tea_util.models import RuntimeOptions

RT = RuntimeOptions(connect_timeout=15000, read_timeout=120000)   # SDK 默认读超时只有 10s，管理接口偶尔会超

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'scf-marks-sync', 'index.js')

DEFAULT_ENV = {
    'CNEMC_PSID': '654000000031',
    'DAYS': '2',
}
CRON = 'CRON_TZ=Asia/Shanghai 0 55 12 * * *'   # 北京时间每天 12:55


def build_zip():
    with open(SRC, 'r', encoding='utf-8') as f:
        code = f.read()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('index.js', code)
    return base64.b64encode(buf.getvalue()).decode('ascii')


def collect_env():
    env = dict(DEFAULT_ENV)
    for k, v in os.environ.items():
        if k.startswith('FENV_'):
            env[k[5:]] = v
    missing = [k for k in ('CNEMC_COOKIE', 'CF_ACCOUNT_ID', 'CF_KV_NAMESPACE_ID', 'CF_API_TOKEN') if not env.get(k)]
    if missing:
        sys.exit(f'缺少函数环境变量（用 FENV_ 前缀传入）：{missing}')
    return env


def make_client(region, endpoint):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from _aliyun_env import load_aliyun_env
    load_aliyun_env()   # 环境变量优先，缺失时自动读 tools/.env.aliyun
    ak = os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_ID')
    sk = os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_SECRET')
    if not (ak and sk):
        sys.exit('缺少阿里云凭据：请运行 python tools/rotate-aliyun-key.py --set <NEW_AK> <NEW_SK>'
                 ' 或 export ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET')
    cfg = OpenApiConfig(access_key_id=ak, access_key_secret=sk, region_id=region)
    cfg.endpoint = endpoint
    return FCClient(cfg)


def function_exists(client, name):
    try:
        client.get_function_with_options(name, fm.GetFunctionRequest(), None, RT)
        return True
    except Exception as e:
        if 'not exist' in str(e).lower() or 'NotFound' in str(e):
            return False
        raise


def ensure_function(client, name, env, update_only=False):
    body = fm.CreateFunctionInput(
        function_name=name,
        runtime='nodejs18',
        handler='index.handler',
        code=fm.InputCodeLocation(zip_file=build_zip()),
        memory_size=256,
        timeout=120,
        internet_access=True,          # 必须：要出公网抓企业端
        environment_variables=env,
        description='envsc 设备标记同步（企业端 -> Cloudflare KV）',
    )
    req = fm.CreateFunctionRequest(body=body)
    if update_only or function_exists(client, name):
        up = fm.UpdateFunctionInput(
            code=body.code, handler=body.handler, runtime=body.runtime,
            memory_size=body.memory_size, timeout=body.timeout,
            internet_access=True, environment_variables=env,
            description=body.description,
        )
        r = client.update_function_with_options(name, fm.UpdateFunctionRequest(body=up), None, RT)
        print(f'[ok] 更新函数 {name}')
        return r
    r = client.create_function_with_options(req, None, RT)
    print(f'[ok] 创建函数 {name}')
    return r


def ensure_trigger(client, name):
    try:
        lst = client.list_triggers_with_options(name, fm.ListTriggersRequest(), None, RT)
        existing = [t.trigger_name for t in (lst.body.triggers or [])]
    except Exception:
        existing = []
    if 'daily-1255' in existing:
        print('[skip] 定时触发器已存在')
        return
    cfg = fm.TimerTriggerConfig(cron_expression=CRON, enable=True, payload='')
    body = fm.CreateTriggerInput(
        trigger_type='timer',
        trigger_name='daily-1255',
        trigger_config=json.dumps(cfg.to_map(), ensure_ascii=False),
    )
    client.create_trigger_with_options(name, fm.CreateTriggerRequest(body=body), None, RT)
    print(f'[ok] 创建定时触发器 {CRON}')


def invoke(client, name, payload):
    body = payload.encode('utf-8')
    headers = fm.InvokeFunctionHeaders(x_fc_log_type='Tail')
    from alibabacloud_tea_util.models import RuntimeOptions
    # 本函数要抓 5 个监测点 × 2 天，实测 20~40 秒，SDK 默认读超时只有 10 秒，必须放宽
    r = client.invoke_function_with_options(
        name, fm.InvokeFunctionRequest(body=body), headers,
        RuntimeOptions(connect_timeout=15000, read_timeout=180000),
    )
    print('---- invoke result ----')
    b = r.body
    if hasattr(b, 'read'):
        b = b.read()
    print(b.decode('utf-8', 'replace') if isinstance(b, (bytes, bytearray)) else b)
    log = getattr(r.headers, 'x_fc_log_result', None)
    if log:
        try:
            print('---- log ----')
            print(base64.b64decode(log).decode('utf-8', 'replace'))
        except Exception:
            print(log)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--region', default=os.environ.get('ALIYUN_REGION', 'cn-hangzhou'))
    ap.add_argument('--endpoint', default=os.environ.get('ALIYUN_FC_ENDPOINT', ''))
    # FC 3.0 的接入地址必须带账号 UID：<uid>.<region>.fc.aliyuncs.com
    ap.add_argument('--account', default=os.environ.get('ALIYUN_ACCOUNT_ID', ''))
    ap.add_argument('--name', default=os.environ.get('FC_FUNCTION', 'envsc-marks-sync'))
    ap.add_argument('--update', action='store_true')
    ap.add_argument('--invoke', default='')
    a = ap.parse_args()

    endpoint = a.endpoint or (f'{a.account}.{a.region}.fc.aliyuncs.com' if a.account else f'fc.{a.region}.aliyuncs.com')
    client = make_client(a.region, endpoint)

    if a.invoke:                       # 只调用，不需要函数环境变量
        invoke(client, a.name, a.invoke)
        return

    env = collect_env()

    ensure_function(client, a.name, env, update_only=a.update)
    ensure_trigger(client, a.name)
    print('[done] 记得在控制台核对：环境变量 / 定时触发器 / 免费额度用量')


if __name__ == '__main__':
    main()
