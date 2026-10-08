#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""阿里云 AccessKey 轮换辅助脚本。

所有本地脚本（kv-read.py / fc-deploy.py / fc-env.py / gql-invocations.py）
都通过 tools/_aliyun_env.py 读取凭据：环境变量优先，缺失时自动加载
tools/.env.aliyun（gitignore 已排除，不入库）。

用法：
    python tools/rotate-aliyun-key.py --set <NEW_AK> <NEW_SK>   # 写入新 key 并验证
    python tools/rotate-aliyun-key.py --check                   # 验证当前凭据有效性
    python tools/rotate-aliyun-key.py --show                    # 脱敏显示当前 key

--set 完整流程（配合阿里云控制台）：
    1. 控制台创建新 AccessKey
    2. 本脚本 --set 写入并验证新 key
    3. 确认各脚本工作正常（如 python tools/kv-read.py --list）
    4. 控制台【禁用并删除】旧 AccessKey —— 脚本不代做，防止误删唯一可用凭据
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _aliyun_env import ENV_FILE, KEYS, ensure_aliyun_env, load_aliyun_env, mask  # noqa: E402

import os  # noqa: E402


def verify():
    """用当前凭据调一次只读 API（FC ListFunctions）验证有效性。"""
    ensure_aliyun_env()
    from alibabacloud_fc20230330.client import Client as FC
    from alibabacloud_fc20230330 import models as fm
    from alibabacloud_tea_util import models as util
    from alibabacloud_tea_openapi import models as openapi_models

    cfg = openapi_models.Config(
        access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
        access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
    )
    uid = os.environ.get('ALIYUN_ACCOUNT_ID', '1355617125073513')
    region = os.environ.get('ALIYUN_REGION', 'cn-hangzhou')
    cfg.endpoint = f'{uid}.{region}.fc.aliyuncs.com'
    c = FC(cfg)
    rt = util.RuntimeOptions(connect_timeout=15000, read_timeout=30000)
    r = c.list_functions(fm.ListFunctionsRequest(prefix='envsc-marks-sync'))
    names = [f.function_name for f in (getattr(r.body, 'functions', None) or [])]
    return names


def main():
    ap = argparse.ArgumentParser(description='阿里云 AccessKey 轮换辅助')
    ap.add_argument('--set', nargs=2, metavar=('NEW_AK', 'NEW_SK'), help='写入新凭据并验证')
    ap.add_argument('--check', action='store_true', help='验证当前凭据')
    ap.add_argument('--show', action='store_true', help='脱敏显示当前凭据来源与 key')
    a = ap.parse_args()

    if a.set:
        new_ak, new_sk = a.set
        lines = [
            '# 阿里云凭据（本文件被 .gitignore 排除，勿提交）',
            f'ALIBABA_CLOUD_ACCESS_KEY_ID={new_ak}',
            f'ALIBABA_CLOUD_ACCESS_KEY_SECRET={new_sk}',
        ]
        ENV_FILE.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        print(f'[OK] 已写入 {ENV_FILE.name}（AK: {mask(new_ak)}）')
        # 强制用文件里的新值覆盖会话中可能残留的旧环境变量
        load_aliyun_env(force=True)
        for k in os.environ:
            if k in KEYS and k == 'ALIBABA_CLOUD_ACCESS_KEY_ID':
                print(f'[OK] 当前生效 AK: {mask(os.environ[k])}')
        try:
            names = verify()
            print(f'[OK] 新凭据验证通过（ListFunctions 只读调用成功，函数: {names or "无"}）')
            print()
            print('后续步骤：')
            print('  1. 跑一次实际链路确认：python tools/kv-read.py --list')
            print('  2. 去阿里云控制台 -> AccessKey 管理 -> 【禁用并删除】旧 AccessKey')
            print('     （脚本不代做，避免误删唯一可用凭据）')
        except Exception as e:
            print(f'[FAIL] 新凭据验证失败: {e}')
            print('请检查新 key 是否已激活、所属账号/区域是否正确。文件已写入，可修正后 --check 重试。')
            sys.exit(1)
        return

    if a.check:
        try:
            names = verify()
            print(f'[OK] 当前凭据有效（AK: {mask(os.environ["ALIBABA_CLOUD_ACCESS_KEY_ID"])}，函数: {names or "无"}）')
        except Exception as e:
            print(f'[FAIL] 当前凭据无效: {e}')
            sys.exit(1)
        return

    if a.show:
        src_file = load_aliyun_env()
        ak = os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_ID', '')
        if not ak:
            print('[--] 尚未配置凭据（环境变量与 .env.aliyun 均为空）')
            return
        src = f'{ENV_FILE.name} + 环境变量' if src_file else '环境变量'
        print(f'AK: {mask(ak)}   来源: {src}')
        return

    ap.print_help()


if __name__ == '__main__':
    main()
