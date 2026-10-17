#!/usr/bin/env python3
"""变异检查：把已知缺陷逐个注入交付实现，确认交付测试会失败。

目的不是"再跑一遍测试"，而是证明回归确实锁住了这些缺陷：如果某个变异体
仍能让整套测试通过，说明对应回归是空的。

用法:
    python tests/mutation-text-stats.py [--repo-root .] [--json-out <path>]

每个变异体都在 `tests/.scratch/mutation-<名字>/` 的独立副本里运行，不改动交付文件。
退出码: 0 = 所有变异体都被测试抓住且基线通过; 1 = 有变异体漏网或基线失败。
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

TARGET_DIR = 'examples/text-stats'
MODULE_FILE = 'text_stats.py'
TEST_FILE = 'test_text_stats.py'
SCRATCH = Path(__file__).resolve().parent / '.scratch'

MUTATIONS = (
    {
        'name': 'quiet_errors_still_write_stderr',
        'why': '程序化调用的受控错误必须两个流都为空（R-09 / AC-12）',
        'find': '    if quiet:\n        return\n',
        'replace': '',
        'expect_any_of': ('test_ac12_programmatic_missing_file_is_a_silent_error',
                          'test_ac12_programmatic_unknown_encoding_is_a_silent_error',
                          'test_bc17_programmatic_path_and_encoding_still_participate'),
    },
    {
        'name': 'programmatic_help_prints_usage',
        'why': '程序化 --help 必须静默返回 0（R-11 / AC-09）',
        'find': '    if not quiet:\n        return parser.parse_args(argv)\n',
        'replace': '    return parser.parse_args(argv)\n',
        'expect_any_of': ('test_ac09_programmatic_help_returns_zero_and_writes_nothing',),
    },
    {
        'name': 'bad_encoding_without_path_is_success',
        'why': '非法 --encoding 必须先于输入选择被拒绝（R-13 / BC-14）',
        'find': '    except LookupError:\n        _report_error("unknown encoding: {0}".format(args.encoding), programmatic)\n        return EXIT_ERROR\n',
        'replace': '    except LookupError:\n        return EXIT_OK\n',
        'expect_any_of': ('test_ac12_programmatic_unknown_encoding_is_a_silent_error',
                          'test_bc17_programmatic_path_and_encoding_still_participate',
                          'test_bc14_invalid_encoding_is_rejected_before_reading_input'),
    },
)


def copy_delivery(repo, destination):
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(repo / TARGET_DIR, destination,
                    ignore=shutil.ignore_patterns('__pycache__', '.test-scratch'))
    return destination


def run_suite(directory):
    completed = subprocess.run(
        [sys.executable, '-m', 'unittest', TEST_FILE[:-3], '-v'],
        cwd=str(directory), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600)
    output = completed.stdout.decode('utf-8', 'replace')
    failed = re.findall(r'^(?:FAIL|ERROR): ([A-Za-z0-9_]+)', output, re.M)
    return completed.returncode, output, failed


def main(argv=None):
    parser = argparse.ArgumentParser(description='把已知缺陷注入交付实现，验证回归是否仍能抓住。')
    parser.add_argument('--repo-root', default='.')
    parser.add_argument('--json-out', default=None)
    args = parser.parse_args(argv)
    repo = Path(args.repo_root).resolve()
    scratch = SCRATCH / 'mutation-v02'
    if scratch.exists():
        shutil.rmtree(scratch)
    scratch.mkdir(parents=True)

    baseline = copy_delivery(repo, scratch / 'baseline')
    baseline_code, baseline_output, baseline_failed = run_suite(baseline)
    baseline_ok = baseline_code == 0 and not baseline_failed
    print('%s baseline | exit=%d failures=%d' %
          ('PASS' if baseline_ok else 'FAIL', baseline_code, len(baseline_failed)))

    results = []
    for mutation in MUTATIONS:
        directory = copy_delivery(repo, scratch / mutation['name'])
        source = (directory / MODULE_FILE).read_text(encoding='utf-8')
        if source.count(mutation['find']) != 1:
            results.append({'mutation': mutation['name'], 'applied': False,
                            'caught': False, 'failed': [], 'reason': '变异点匹配次数不为 1'})
            print('FAIL %s | 变异点匹配次数不为 1' % mutation['name'])
            continue
        (directory / MODULE_FILE).write_text(source.replace(mutation['find'], mutation['replace']),
                                             encoding='utf-8')
        code, output, failed = run_suite(directory)
        caught = [name for name in failed if any(name.startswith(expected) for expected in mutation['expect_any_of'])]
        ok = bool(caught)
        results.append({'mutation': mutation['name'], 'applied': True, 'caught': ok,
                        'why': mutation['why'], 'failed': failed,
                        'subset_of_expected': caught})
        print('%s %s | 失败的用例=%d 命中目标=%d' %
              ('PASS' if ok else 'FAIL', mutation['name'], len(failed), len(caught)))

    survived = [item['mutation'] for item in results if not item['caught']]
    print('\n%d/%d 个变异体被抓住; 基线%s' %
          (len(results) - len(survived), len(results), '通过' if baseline_ok else '失败'))
    if args.json_out:
        payload = {
            'tool': 'tests/mutation-text-stats.py',
            'method': 'inject known defects into a scratch copy of the delivered module and run the delivered suite',
            'baseline': {'exit': baseline_code, 'failed': baseline_failed, 'ok': baseline_ok},
            'mutations': results,
        }
        Path(args.json_out).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return 0 if baseline_ok and not survived else 1


if __name__ == '__main__':
    sys.exit(main())
