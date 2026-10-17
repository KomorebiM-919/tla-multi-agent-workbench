#!/usr/bin/env python
"""一次运行的可复现复核套件：按固定命令跑完全部复核项，输出原始文本与 JSON 摘要。

用途：复核材料（原始输出）不应该靠人工重定向拼接，而应该由一条命令重新生成，
且输出统一为 UTF-8 / LF（Windows 上 PowerShell 重定向会写成 UTF-16LE + BOM，
那会让同一份输出在不同机器上字节不同、也无法复算哈希）。

用法：
    python tests/run-review-suite.py --run-id v0.2-run1-20261017T121445Z

- 只读：不修改仓库里任何被跟踪文件，只写 `docs/run-records/<runId>/review-package/`。
- 每条命令都会记录 argv、退出码、耗时、输出路径与输出 sha256。
- 失败不会中断：全部跑完后按 "worst status" 返回（0 全过 / 1 有失败）。
- 输出里的仓库路径已由各工具自身脱敏；本脚本不做二次改写。
"""

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
REVIEW_SCRIPT = 'tests/review-run-evidence.py'
MAPPING = 'docs/run-records/{run_id}/requirement-mapping.json'

# 运行结束后被人工授权改动的工作树路径（本收口轮新增的编排/测试工具）。
# 逐条显式列出，复核工具会原样打印，不做静默跳过。
ALLOW_SCOPE = (
    'tests/workflow-harness.mjs',
    'tests/workflow-logic.test.mjs',
    'workflows/three-agent-mvp.js',
    'tests/bytecode-integration.test.mjs',
    'tests/extract-native-events.mjs',
    'tests/mutation-text-stats.py',
    'tests/probe-text-stats-requirement.py',
    'tests/run-review-suite.py',
)


def review_arguments(run_id):
    """复核工具的完整参数：运行目录 + 映射 + 逐条显式排除项。"""
    arguments = ['python', REVIEW_SCRIPT, '--run-id', run_id,
                 '--mapping', MAPPING.format(run_id=run_id)]
    for item in ALLOW_SCOPE:
        arguments.extend(['--allow-scope', item])
    return arguments


def commands(run_id):
    return [
        ('01-delivery-unit-tests', ['python', '-m', 'unittest', 'discover',
                                    '-s', 'examples/text-stats', '-p', 'test_*.py']),
        ('02-review-run-evidence', review_arguments(run_id)),
        ('03-review-self-test', ['python', REVIEW_SCRIPT, '--self-test']),
        ('04-independent-probe', ['python', 'tests/probe-text-stats-requirement.py']),
        ('05-mutation-check', ['python', 'tests/mutation-text-stats.py']),
        ('06-workflow-logic', ['node', 'tests/workflow-logic.test.mjs']),
        ('07-bytecode-integration', ['node', 'tests/bytecode-integration.test.mjs']),
        ('08-preflight-claim', ['node', 'tests/preflight-claim-integration.test.mjs']),
        ('09-approval-evidence', ['node', 'tests/approval-rejection-evidence.test.mjs']),
        ('10-approval-mutation', ['node', 'tests/approval-evidence-mutation.test.mjs']),
        ('11-property-text-stats', ['python', 'tests/property_text_stats.py']),
        ('12-tests-unittest', ['python', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py']),
        ('13-native-events',
         ['node', 'tests/extract-native-events.mjs',
          '--parent', 'session-3f96bf08-83ae-48d6-a239-0223d4b1c12c',
          '--workflow-name', 'tla-v02-run1',
          '--since', '2026-10-17T12:00:00Z',
          '--evidence-dir', 'docs/evidence/' + run_id,
          '--script-file', 'docs/run-records/{run_id}/workflow-script-at-run.js'.format(run_id=run_id),
          '--out', 'docs/run-records/{run_id}/native-events.json'.format(run_id=run_id)]),
    ]


def run_one(name, argv, out_dir):
    started = time.time()
    try:
        completed = subprocess.run(argv, cwd=str(REPO_ROOT), capture_output=True, text=True,
                                   encoding='utf-8', errors='replace', timeout=1800)
        code = completed.returncode
        stdout, stderr = completed.stdout, completed.stderr
    except OSError as exc:  # 命令不存在等
        code, stdout, stderr = 127, '', '执行失败：{0}'.format(exc)
    duration = round(time.time() - started, 2)
    body = stdout
    if stderr.strip():
        body += '\n--- stderr ---\n' + stderr
    text = '# {0}\n# command: {1}\n# exit code: {2}\n# duration: {3}s\n\n{4}'.format(
        name, ' '.join(argv), code, duration, body)
    # 统一成 LF：某些工具在 Windows 上会输出 CRLF
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    path = out_dir / (name + '.txt')
    path.write_bytes(text.encode('utf-8'))
    return {
        'name': name,
        'command': ' '.join(argv),
        'exitCode': code,
        'durationSeconds': duration,
        'output': str(path.relative_to(REPO_ROOT)).replace('\\', '/'),
        'outputSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description='生成一次运行的可复现复核套件输出')
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--out-dir', default='')
    args = parser.parse_args(argv)

    out_dir = Path(args.out_dir) if args.out_dir else (
        REPO_ROOT / 'docs' / 'run-records' / args.run_id / 'review-package' / 'test-output')
    out_dir.mkdir(parents=True, exist_ok=True)

    results = []
    for name, argv_one in commands(args.run_id):
        print('[run] {0}'.format(name), flush=True)
        results.append(run_one(name, argv_one, out_dir))
        print('[{0}] exit={1}'.format(name, results[-1]['exitCode']), flush=True)

    manifest = {
        'runId': args.run_id,
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'results': results,
        'failed': [item['name'] for item in results if item['exitCode'] != 0],
    }
    manifest_path = out_dir.parent / 'suite-results.json'
    manifest_path.write_bytes((json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    print('suite results: {0}'.format(manifest_path.relative_to(REPO_ROOT)))
    print('failed: {0}'.format(', '.join(manifest['failed']) or '（无）'))
    return 0 if not manifest['failed'] else 1


if __name__ == '__main__':
    sys.exit(main())
