#!/usr/bin/env python3
"""生成 REVIEW-MANIFEST.md：审查材料清单 + 逐文件哈希（字节数 / sha256 / git blob SHA-1）。

为什么要同时给两种哈希：
  * sha256  —— 便于任意工具核对内容；
  * git blob SHA-1 —— 与 `git rev-parse HEAD:<path>` 得到的对象 ID 直接可比，
    从而证明"审查材料 = 该提交里的那个文件"。

同时报告每个文件里的 CRLF 数量：`core.autocrlf=true` 的检出会把 LF 变成 CRLF，
导致哈希与仓库内容不一致（本项目实测过该假象），所以清单里必须留下这个证据。

只用 Python 标准库，不写入被测文件之外的内容。

用法（在仓库根目录执行）：
    python -B docs/evidence/v0.1-second-run/make-review-manifest.py \\
        --repo . \\
        --baseline "%TEMP%\\tla-5034985-tree" \\
        --baseline-label "5034985" \\
        --out docs/evidence/v0.1-second-run/REVIEW-MANIFEST.md
"""

import argparse
import hashlib
import os
import sys

# 固定材料：工作流脚本、回归测试、角色提示词、演示项目、本轮新增文档、编排层工具。
FIXED_MATERIALS = [
    'README.md',
    'docs/ARCHITECTURE.md',
    'docs/ROADMAP.md',
    'workflows/three-agent-mvp.js',
    'workflows/README.md',
    'tests/workflow-logic.test.mjs',
    'tests/README.md',
    'agents/README.md',
    'agents/requirement-agent.md',
    'agents/coding-agent.md',
    'agents/review-agent.md',
    'agents/verifier-agent.md',
    'examples/text-stats/text_stats.py',
    'examples/text-stats/test_text_stats.py',
    'examples/text-stats/README.md',
    'examples/text-stats/sample_input.txt',
    'examples/text-stats/.gitignore',
    'docs/REQUIREMENT-CALIBER.md',
]

EVIDENCE_SUFFIXES = ('.json', '.md', '.py', '.mjs', '.txt', '.diff')
SKIP_NAMES = ('REVIEW-MANIFEST.md',)


def git_blob_sha1(data):
    header = ('blob %d\0' % len(data)).encode('utf-8')
    return hashlib.sha1(header + data).hexdigest()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def describe(root, rel):
    path = os.path.join(root, rel.replace('/', os.sep))
    if not os.path.isfile(path):
        return None
    with open(path, 'rb') as handle:
        data = handle.read()
    crlf = data.count(b'\r\n')
    # 提交内容：core.autocrlf=true 时 git 会把工作区的 CRLF 规范化成 LF 后入库，
    # 因此提交内容的哈希必须在 LF 规范化后的字节上计算（否则会得到仓库里不存在的哈希）。
    committed = data.replace(b'\r\n', b'\n')
    return {
        'bytes': len(committed),
        'sha256': sha256(committed),
        'blob': git_blob_sha1(committed),
        'crlf': crlf,
    }


def evidence_materials(repo):
    """证据目录下的所有可读材料（按路径排序）。"""
    found = []
    base = os.path.join(repo, 'docs', 'evidence')
    if not os.path.isdir(base):
        return found
    for dirpath, _dirnames, filenames in os.walk(base):
        for name in sorted(filenames):
            if name in SKIP_NAMES or not name.endswith(EVIDENCE_SUFFIXES):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, repo).replace(os.sep, '/')
            found.append(rel)
    return sorted(found)


def table(root, materials):
    lines = []
    missing = []
    crlf_files = []
    for rel in materials:
        info = describe(root, rel)
        if info is None:
            missing.append(rel)
            continue
        if info['crlf']:
            crlf_files.append(rel)
        lines.append('| `%s` | %d | `%s` | `%s` | %d |' % (rel, info['bytes'], info['sha256'], info['blob'], info['crlf']))
    if not lines:
        lines.append('| （该根目录下没有匹配到材料） |  |  |  |')
    return lines, missing, crlf_files


def display_path(path, repo):
    """把本机绝对路径换成本仓库可公开的写法：清单会进公开仓库，不该带作者机器的目录结构。"""
    relative = os.path.relpath(path, repo)
    if not relative.startswith('..'):
        return relative.replace(os.sep, '/')
    return '<外部检出目录>/' + os.path.basename(path.rstrip('\\/'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True, help='仓库根目录（必填：不提供默认值，避免在错误目录下生成清单）')
    parser.add_argument('--baseline', default='')
    parser.add_argument('--baseline-label', default='基线提交')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    repo = os.path.abspath(args.repo)
    # fail-closed：确认传入的确实是本项目仓库根，否则清单会安静地对错目录算哈希。
    for marker in ('workflows/three-agent-mvp.js', 'docs/evidence', 'agents'):
        if not os.path.exists(os.path.join(repo, marker.replace('/', os.sep))):
            sys.stderr.write('error: --repo 不像本项目仓库根（缺少 %s）：%s\n' % (marker, repo))
            return 2
    materials = list(FIXED_MATERIALS) + evidence_materials(repo)

    current_rows, current_missing, current_crlf = table(repo, materials)

    out = []
    out.append('# REVIEW-MANIFEST — 审查材料清单与逐文件哈希')
    out.append('')
    out.append('本清单由 `make-review-manifest.py` 生成（只用 Python 标准库）。哈希口径：**提交内容**——`core.autocrlf=true` 时 git 会先把工作区的 CRLF 规范化成 LF 再入库，')
    out.append('所以字节数与哈希都在 LF 规范化后的字节上计算，可直接与 `git rev-parse HEAD:<path>` / `git cat-file blob HEAD:<path>` 比对；')
    out.append('最后一列给出工作区磁盘上的 CRLF 行数（非 0 表示磁盘字节与提交内容不同，仅影响"对磁盘文件直接算哈希"的场景）。')
    out.append('')
    out.append('## 1. 当前工作树（即将提交的审查材料）')
    out.append('')
    out.append('| 文件 | 字节数（提交内容） | sha256（提交内容） | git blob SHA-1 | 磁盘 CRLF 行数 |')
    out.append('| --- | --- | --- | --- | --- |')
    out.extend(current_rows)
    out.append('')
    if current_missing:
        out.append('未找到（当前工作树）：' + ', '.join('`%s`' % item for item in current_missing))
        out.append('')

    if args.baseline:
        baseline_root = os.path.abspath(args.baseline)
        if os.path.isdir(baseline_root):
            rows, missing, crlf = table(baseline_root, materials)
            out.append('## 2. 基线 %s 处的同名材料（用于确认"证据里验证的就是提交里的文件"）' % args.baseline_label)
            out.append('')
            out.append('| 文件 | 字节数（提交内容） | sha256（提交内容） | git blob SHA-1 | 磁盘 CRLF 行数 |')
            out.append('| --- | --- | --- | --- | --- |')
            out.extend(rows)
            out.append('')
            if missing:
                out.append('基线中不存在（本轮新增）：' + ', '.join('`%s`' % item for item in missing))
                out.append('')
        else:
            out.append('## 2. 基线检出')
            out.append('')
            out.append('未找到基线检出目录 `%s`；如需比对基线哈希，请先执行：' % display_path(baseline_root, repo))
            out.append('')
            out.append('```powershell')
            out.append('git -c core.autocrlf=false worktree add --detach "$env:TEMP\\tla-5034985-tree" 5034985')
            out.append('```')
            out.append('')

    if current_crlf:
        out.append('## 3. 警告')
        out.append('')
        out.append('以下文件的**工作区磁盘字节**含 CRLF（多由子代理写入工具在 Windows 上产生）。上表已按提交内容（LF 规范化）计算哈希，')
        out.append('因此上表仍可与仓库对象直接比对；但若要"对磁盘文件直接算哈希"，必须先做 LF 规范化或改用 `core.autocrlf=false` 的检出：')
        out.append('')
        for rel in current_crlf:
            out.append('- `%s`' % rel)
        out.append('')
    else:
        out.append('## 3. LF 一致性')
        out.append('')
        out.append('本次列出的所有材料均为纯 LF 字节流（CRLF 计数为 0），因此上表的 sha256 / git blob SHA-1 可直接与仓库对象比对。')
        out.append('')

    with open(args.out, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write('\n'.join(out))
    sys.stdout.write('wrote %s (%d materials)\n' % (args.out, len(materials)))


if __name__ == '__main__':
    main()
