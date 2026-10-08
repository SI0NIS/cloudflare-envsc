#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""阿里云凭据统一加载（轮换友好）。

读取顺序：环境变量优先；缺失时自动加载 tools/.env.aliyun。
.env.aliyun 格式（每行 KEY=VALUE，# 注释）：
    ALIBABA_CLOUD_ACCESS_KEY_ID=LTAI...
    ALIBABA_CLOUD_ACCESS_KEY_SECRET=...
该文件被 .gitignore 的 `.env.*` 规则排除，不入库。

换 key 只需改 tools/.env.aliyun 一个文件（或运行
`python tools/rotate-aliyun-key.py --set <AK> <SK>`），所有脚本自动生效：
    kv-read.py / fc-deploy.py / fc-env.py / gql-invocations.py
"""
import os
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent / '.env.aliyun'
KEYS = ('ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET')


def load_aliyun_env(force=False):
    """从 .env.aliyun 加载凭据到 os.environ。

    force=True 时文件值覆盖已有环境变量；默认只补缺失项。
    返回 True 表示文件存在（无论是否实际注入）。
    """
    if not force and all(os.environ.get(k) for k in KEYS):
        return False
    if not ENV_FILE.exists():
        return False
    for line in ENV_FILE.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, _, v = line.partition('=')
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k in KEYS and (force or not os.environ.get(k)):
            os.environ[k] = v
    return True


def ensure_aliyun_env():
    """确保凭据可用：自动加载后仍缺失则报错退出。"""
    load_aliyun_env()
    missing = [k for k in KEYS if not os.environ.get(k)]
    if missing:
        raise SystemExit(
            '缺少阿里云凭据: ' + ', '.join(missing) +
            '\n请运行: python tools/rotate-aliyun-key.py --set <NEW_AK> <NEW_SK>'
            '\n或 export ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET'
        )


def mask(key):
    """脱敏显示 AccessKey（前 6 位 + ***）。"""
    k = str(key or '')
    return (k[:6] + '***') if len(k) > 6 else '***'
