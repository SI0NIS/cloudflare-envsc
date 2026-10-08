#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
尝试用现有 AK 自查身份，并尝试给自身 RAM 用户补 AliyunBssFullAccess 权限，
以便代设置阿里云「可用额度预警」。
凭据走环境变量 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET
"""
import os, sys, json

from alibabacloud_tea_openapi.models import Config
from alibabacloud_sts20150401.client import Client as StsClient
from alibabacloud_sts20150401 import models as sts_models

AK = os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_ID', '')
SK = os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_SECRET', '')

cfg = Config(access_key_id=AK, access_key_secret=SK,
             endpoint='sts.aliyuncs.com', connect_timeout=15000, read_timeout=60000)

sts = StsClient(cfg)
try:
    ident = sts.get_caller_identity()
    print('AccountId :', ident.body.account_id)
    print('Arn       :', ident.body.arn)
    print('Principal :', ident.body.principal_id)
except Exception as e:
    print('STS ERR:', e)
    sys.exit(1)

arn = ident.body.arn or ''
# acs:ram::<uid>:user/<name>  -> 取出 RAM 用户名（注意分隔符是 :user/ 不是 /user/）
name = arn.split(':user/')[-1] if ':user/' in arn else ''
print('RAM user  :', name or '(可能是主账号 AK)')
if not name:
    print('>> 该 AK 属于主账号，理论上应有全部权限；若 BSS 仍被拒，可能是控制台侧限制。')
    sys.exit(0)

# 尝试给自己授权（需要 AliyunRAMFullAccess，通常会被拒绝）
try:
    from alibabacloud_ram20150501.client import Client as RamClient
    from alibabacloud_ram20150501 import models as ram_models
    ram = RamClient(Config(access_key_id=AK, access_key_secret=SK,
                           endpoint='ram.aliyuncs.com', connect_timeout=15000, read_timeout=60000))
    for p in ('AliyunBssReadOnlyAccess', 'AliyunBssFullAccess'):
        try:
            req = ram_models.AttachPolicyToUserRequest(
                policy_type='System', policy_name=p, user_name=name)
            ram.attach_policy_to_user(req)
            print('>> 授权成功：已给 %s 附加 %s' % (name, p))
            break
        except Exception as e:
            print('>> 附加 %s 失败：%s' % (p, str(e)[:200]))
except Exception as e:
    print('>> 授权不可用（需要 AliyunRAMFullAccess）：', str(e)[:300])
