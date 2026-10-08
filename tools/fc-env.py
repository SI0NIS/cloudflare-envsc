#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""读取阿里云 FC 函数 envsc-marks-sync 的配置与环境变量（脱敏输出）。"""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _aliyun_env import ensure_aliyun_env          # 环境变量优先，缺失时自动读 .env.aliyun
ensure_aliyun_env()
from alibabacloud_tea_openapi.models import Config
from alibabacloud_fc20230330.client import Client as FC
from alibabacloud_fc20230330 import models as fm

AK = os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_ID', '')
SK = os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_SECRET', '')
ACC = os.environ.get('ALIBABA_CLOUD_ACCOUNT', '1355617125073513')
REGION = os.environ.get('ALIBABA_CLOUD_REGION', 'cn-hangzhou')
NAME = os.environ.get('FC_FUNCTION', 'envsc-marks-sync')

cfg = Config(access_key_id=AK, access_key_secret=SK,
             endpoint=f'{ACC}.{REGION}.fc.aliyuncs.com',
             connect_timeout=15000, read_timeout=60000)
from alibabacloud_tea_util.models import RuntimeOptions
RT = RuntimeOptions(connect_timeout=15000, read_timeout=60000)

c = FC(cfg)
r = c.get_function_with_options(NAME, fm.GetFunctionRequest(), None, RT)
f = r.body
print('functionName :', f.function_name)
print('runtime      :', f.runtime)
print('handler      :', f.handler)
print('memory/timeout:', f.memory_size, '/', f.timeout)
print('internet     :', f.internet_access)
print('env keys     :')
env = f.environment_variables or {}
for k in sorted(env):
    v = str(env[k])
    if k in ('CF_API_TOKEN', 'CNEMC_COOKIE'):
        v = v[:6] + '...' + (v[-4:] if len(v) > 10 else '')
    print('   %-22s = %s' % (k, v))

# 触发器
try:
    t = c.list_triggers_with_options(NAME, fm.ListTriggersRequest(), None, RT)
    for tr in (t.body.triggers or []):
        print('trigger      :', tr.trigger_name, tr.trigger_type, tr.trigger_config, 'enable=', tr.enable)
except Exception as e:
    print('trigger ERR:', str(e)[:200])
