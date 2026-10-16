#!/usr/bin/env python3
"""一次性脱敏：把证据 JSON 里的本机绝对路径替换为 `<repo>` / `<home>`。

为什么保留脚本：脱敏会改变文件字节，必须在证据说明里说清"改了哪些文件、改了什么"；
脚本留着，任何人事后都能复算同一结果（把本目录作为参数再跑一次即可，幂等）。

替换目标**不写死在脚本里**，而是从脚本自身位置与用户主目录推导：
  * 仓库根（`docs/evidence/<run>/` 往上三级）及其**祖先目录前缀**（覆盖被宿主截断的残缺路径）→ `<repo>`
  * 用户主目录（`~`）→ `<home>`
同时匹配原生反斜杠、正斜杠与 JSON 转义（双反斜杠）三种写法。

处理范围：目录下的 `.json` / `.txt` / `.md`（`.diff` 是提交的逐字对照，改写会让它不再对应提交，明确跳过；
本文件和 `README.md` 也跳过）。脱敏后逐一重新解析每个 .json，解析失败即非零退出（绝不写出坏 JSON）。
"""

import json
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# 祖先前缀（例如仓库在 `<盘符>:\<父目录>\tla-multi-agent-workbench` 时取 `<盘符>:\<父目录>`）：
# 用于替换被宿主截断或只被引用了一部分的路径片段。
ANCESTOR = os.path.dirname(os.path.dirname(REPO_ROOT))
HOME_DIR = os.path.expanduser('~')


def _variants(path, allow_suffix):
    """同一路径的多种写法：原生反斜杠 / 正斜杠 / JSON 转义（双反斜杠）。"""
    native = re.escape(path)
    forward = re.escape(path.replace('\\', '/'))
    escaped = re.escape(path.replace('\\', '\\\\'))
    suffix = r'(?:[\\/]+[A-Za-z0-9_.\-]*)?' if allow_suffix else ''
    return [native + suffix, forward + suffix, escaped + suffix]


REPO_PATTERNS = _variants(REPO_ROOT, allow_suffix=False) + _variants(ANCESTOR, allow_suffix=True)
HOME_PATTERNS = _variants(HOME_DIR, allow_suffix=False)


def sanitize(text):
    changed = 0
    for pattern in REPO_PATTERNS:
        text, n = re.subn(pattern, '<repo>', text)
        changed += n
    for pattern in HOME_PATTERNS:
        text, n = re.subn(pattern, '<home>', text)
        changed += n
    return text, changed


def read_text(path):
    """按 BOM 判定编码读取；返回 (文本, 编码名)。UTF-16 证据无法用 utf-8 解码，必须显式识别。"""
    with open(path, 'rb') as handle:
        raw = handle.read()
    if raw.startswith(b'\xff\xfe') or raw.startswith(b'\xfe\xff'):
        return raw.decode('utf-16'), 'utf-16'
    if raw.startswith(b'\xef\xbb\xbf'):
        return raw.decode('utf-8-sig'), 'utf-8-sig'
    return raw.decode('utf-8'), 'utf-8'


def main():
    target_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    # 只处理数据/文本类证据：.diff 是提交的逐字对照，改写会让它不再对应提交，明确跳过。
    suffixes = ('.json', '.txt', '.md')
    total = 0
    for name in sorted(os.listdir(target_dir)):
        path = os.path.join(target_dir, name)
        if not os.path.isfile(path) or not name.endswith(suffixes):
            continue
        if name == '.run-owner.json' or name == 'README.md':
            continue
        original, encoding = read_text(path)
        updated, changed = sanitize(original)
        # 顺带把 UTF-16 / 带 BOM 的证据统一成无 BOM 的 UTF-8：仓库里应当是可直接 diff 的文本。
        normalize = encoding != 'utf-8'
        if changed == 0 and not normalize:
            print('%-34s unchanged' % name)
            continue
        with open(path, 'w', encoding='utf-8', newline='') as handle:
            handle.write(updated)
        # 脱敏后必须仍是合法 JSON：解析失败就让整个脚本失败，绝不留下坏文件。
        if name.endswith('.json'):
            with open(path, 'r', encoding='utf-8') as handle:
                json.load(handle)
        note = ', %s -> utf-8' % encoding if normalize else ''
        print('%-34s %d replacement(s)%s' % (name, changed, note))
        total += changed
    print('total replacements: %d' % total)
    return 0


if __name__ == '__main__':
    sys.exit(main())
