#!/usr/bin/env python
"""一次运行的可复现复核套件：按固定命令跑完全部复核项，输出原始文本与 JSON 摘要。

用途：复核材料（原始输出）不应该靠人工重定向拼接，而应该由一条命令重新生成，
且输出统一为 UTF-8 / LF（Windows 上 PowerShell 重定向会写成 UTF-16LE + BOM，
那会让同一份输出在不同机器上字节不同、也无法复算哈希）。

用法：
    python tests/run-review-suite.py --run-id <runId> --out-dir <唯一目录> \\
        --parent-session <sessionId> --workflow-name <name> --since <ISO>

写入范围（准确表述，避免"只读"的误导）：
- 所有文本输出写到 `<out-dir>/text/`，所有 JSON 写到 `<out-dir>/json/`，
  汇总写到 `<out-dir>/suite-results.json`。`--out-dir` 会**原样传给每一个会写文件的子工具**
  （`review-run-evidence --json-out`、`probe --json-out`、`mutation --json-out`、
  `extract-native-events --out`），不是只改文本输出目录。
- `--out-dir` 已存在且非空时**拒绝运行**（exit 2），不覆盖既有归档；请换新目录。
- 不改写任何已提交文件；但子工具会在各自的临时目录（`tests/.scratch/`、
  `examples/text-stats/.test-scratch/`）写运行期文件，这些目录被 `.gitignore` 忽略。
- 子进程环境强制 `PYTHONDONTWRITEBYTECODE=1`（并记录在 suite-results 里），
  这样本套件自身不会新增/重写 `__pycache__/`。
- 每条命令都记录 argv、退出码、耗时、超时标记、输出路径与输出 sha256。
- 失败与超时都不中断：全部跑完后按 worst status 返回（0 全过 / 1 有失败或超时）。
- 输出里的仓库路径已由各工具自身脱敏；本脚本不做二次改写。
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
REVIEW_SCRIPT = 'tests/review-run-evidence.py'
DEFAULT_TIMEOUT_SECONDS = 1800
TIMEOUT_EXIT_CODE = 124

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
    'tests/preflight-claim-integration.test.mjs',
    'tests/review-run-evidence.py',
    'tests/test_mutation_gate.py',
)


def review_arguments(run_id, json_path):
    """复核工具的完整参数：运行目录 + 映射 + 逐条显式排除项 + JSON 输出。"""
    arguments = ['python', REVIEW_SCRIPT, '--run-id', run_id,
                 '--mapping', 'docs/run-records/{0}/requirement-mapping.json'.format(run_id),
                 '--json-out', json_path]
    for item in ALLOW_SCOPE:
        arguments.extend(['--allow-scope', item])
    return arguments


def commands(run_id, paths, options):
    """固定命令表；每个会写文件的子工具都拿到 <out-dir>/json 下的独立路径。"""
    return [
        ('01-delivery-unit-tests', ['python', '-m', 'unittest', 'discover',
                                    '-s', 'examples/text-stats', '-p', 'test_*.py']),
        ('02-review-run-evidence', review_arguments(run_id, paths['review'])),
        ('03-review-self-test', ['python', REVIEW_SCRIPT, '--self-test']),
        ('04-independent-probe', ['python', 'tests/probe-text-stats-requirement.py',
                                  '--json-out', paths['probe']]),
        ('05-mutation-check', ['python', 'tests/mutation-text-stats.py',
                               '--json-out', paths['mutation']]),
        ('06-workflow-logic', ['node', 'tests/workflow-logic.test.mjs']),
        ('07-bytecode-integration', ['node', 'tests/bytecode-integration.test.mjs']),
        ('08-preflight-claim', ['node', 'tests/preflight-claim-integration.test.mjs']),
        ('09-approval-evidence', ['node', 'tests/approval-rejection-evidence.test.mjs']),
        ('10-approval-mutation', ['node', 'tests/approval-evidence-mutation.test.mjs']),
        ('11-property-text-stats', ['python', 'tests/property_text_stats.py']),
        ('12-tests-unittest', ['python', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py']),
        ('13-native-events',
         ['node', 'tests/extract-native-events.mjs',
          '--parent', options.parent_session,
          '--workflow-name', options.workflow_name,
          '--since', options.since,
          '--evidence-dir', 'docs/evidence/' + run_id,
          '--script-file', 'docs/run-records/{0}/workflow-script-at-run.js'.format(run_id),
          '--out', paths['native']]),
    ]


def child_environment():
    """子进程环境：显式禁止写字节码，并把这一事实记录下来。"""
    env = os.environ.copy()
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    return env


def run_one(name, argv, out_dir, timeout_seconds):
    started = time.time()
    timed_out = False
    try:
        completed = subprocess.run(argv, cwd=str(REPO_ROOT), capture_output=True, text=True,
                                   encoding='utf-8', errors='replace',
                                   timeout=timeout_seconds, env=child_environment())
        code = completed.returncode
        stdout, stderr = completed.stdout, completed.stderr
    except subprocess.TimeoutExpired as exc:  # 超时必须记为失败，不能丢结果
        timed_out = True
        code = TIMEOUT_EXIT_CODE
        stdout = exc.stdout or ''
        stderr = '{0}\n超时：命令在 {1}s 后仍未结束，已终止。'.format(exc.stderr or '', timeout_seconds)
        if isinstance(stdout, bytes):
            stdout = stdout.decode('utf-8', 'replace')
        if isinstance(stderr, bytes):
            stderr = stderr.decode('utf-8', 'replace')
    except OSError as exc:  # 命令不存在等
        code, stdout, stderr = 127, '', '执行失败：{0}'.format(exc)
    duration = round(time.time() - started, 2)
    body = stdout
    if stderr.strip():
        body += '\n--- stderr ---\n' + stderr
    text = '# {0}\n# command: {1}\n# exit code: {2}\n# duration: {3}s\n# timed out: {4}\n\n{5}'.format(
        name, ' '.join(argv), code, duration, 'yes' if timed_out else 'no', body)
    # 统一成 LF：某些工具在 Windows 上会输出 CRLF
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    path = out_dir / (name + '.txt')
    path.write_bytes(text.encode('utf-8'))
    return {
        'name': name,
        'command': ' '.join(argv),
        'exitCode': code,
        'timedOut': timed_out,
        'durationSeconds': duration,
        'output': str(path.relative_to(REPO_ROOT)).replace('\\', '/'),
        'outputSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def prepare_out_dir(out_dir):
    """拒绝覆盖既有归档：目录已存在且非空时直接失败。"""
    if out_dir.exists():
        if not out_dir.is_dir():
            return 'out-dir 已存在且不是目录：{0}'.format(out_dir)
        if any(out_dir.iterdir()):
            return 'out-dir 已存在且非空，拒绝覆盖：{0}'.format(out_dir)
    (out_dir / 'text').mkdir(parents=True, exist_ok=True)
    (out_dir / 'json').mkdir(parents=True, exist_ok=True)
    return None


def main(argv=None):
    parser = argparse.ArgumentParser(description='生成一次运行的可复现复核套件输出')
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--out-dir', required=True)
    parser.add_argument('--parent-session', required=True)
    parser.add_argument('--workflow-name', required=True)
    parser.add_argument('--since', required=True, help='本地日志提取起点（ISO 8601，含时区）')
    parser.add_argument('--timeout', type=int, default=DEFAULT_TIMEOUT_SECONDS,
                        help='单条命令超时秒数；超时记为失败并继续')
    args = parser.parse_args(argv)

    out_dir = Path(args.out_dir)
    if not out_dir.is_absolute():
        out_dir = REPO_ROOT / out_dir
    problem = prepare_out_dir(out_dir)
    if problem is not None:
        print('错误：' + problem, file=sys.stderr)
        return 2

    paths = {
        'review': str((out_dir / 'json' / 'review-run-evidence.json').relative_to(REPO_ROOT)).replace('\\', '/'),
        'probe': str((out_dir / 'json' / 'probe.json').relative_to(REPO_ROOT)).replace('\\', '/'),
        'mutation': str((out_dir / 'json' / 'mutation.json').relative_to(REPO_ROOT)).replace('\\', '/'),
        'native': str((out_dir / 'json' / 'native-events.json').relative_to(REPO_ROOT)).replace('\\', '/'),
    }

    results = []
    for name, argv_one in commands(args.run_id, paths, args):
        print('[run] {0}'.format(name), flush=True)
        results.append(run_one(name, argv_one, out_dir / 'text', args.timeout))
        print('[{0}] exit={1}{2}'.format(
            name, results[-1]['exitCode'], ' (timeout)' if results[-1]['timedOut'] else ''), flush=True)

    failed = [item['name'] for item in results if item['exitCode'] != 0]
    manifest = {
        'runId': args.run_id,
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'outDir': str(out_dir.relative_to(REPO_ROOT)).replace('\\', '/'),
        'environment': {
            'PYTHONDONTWRITEBYTECODE': '1',
            'source': 'forced by run-review-suite for every child process',
        },
        'timeoutSeconds': args.timeout,
        'jsonOutputs': paths,
        'results': results,
        'failed': failed,
        'timedOut': [item['name'] for item in results if item['timedOut']],
    }
    manifest_path = out_dir / 'suite-results.json'
    manifest_path.write_bytes((json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    print('suite results: {0}'.format(manifest_path.relative_to(REPO_ROOT)))
    print('failed: {0}'.format(', '.join(failed) or '（无）'))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
