#!/usr/bin/env python3
"""tests/verify-cache-boundary.py 的进程级回归测试。

为什么必须先在离线把这条闭环测死：外层判定就是"工作流说自己 OK"和"最终确实没写缓存"
之间的那道闸门。闸门本身没被测过，就等于没有闸门。

覆盖 m11171 第一节要求的四个场景：
  1. 工作流内部 OK，但最终缓存改变 → 外层必须失败（NOT_CLEAN，退出码 10）；
  2. 最终快照缺失 → 不完整（INCOMPLETE，退出码 11），不能当通过；
  3. 全程观测一致 → 外层通过（CLEAN，退出码 0）；
  4. 采集工具本身不生成字节码（跑完采集，缓存目录仍然不存在 / 条目不变）。
另外补两个"身份不符"与"阶段观测点不可用"的用例，确认它们也落在 INCOMPLETE。

运行：python -m unittest discover -s tests -p "test_*.py"
"""

import io
import json
import os
import shutil
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
TOOL = os.path.join(REPO_ROOT, 'tests', 'verify-cache-boundary.py')
COLLECT = os.path.join(REPO_ROOT, 'tests', 'collect-cache-state.py')
WORK = os.path.join(REPO_ROOT, 'tests', '.scratch', 'cache-boundary')
RUN_ID = 'v9.9-synthetic-run-20260101T000000Z'
CACHE_DIR = 'examples/demo/__pycache__'
PYC_A = CACHE_DIR + '/demo.cpython-313.pyc'
PYC_B = CACHE_DIR + '/helper.cpython-313.pyc'
SHA_A = 'a' * 64
SHA_B = 'b' * 64
T0 = '2026-01-01T00:00:00+00:00'
T1 = '2026-01-01T00:05:00+00:00'
T2 = '2026-01-01T00:10:00+00:00'
T3 = '2026-01-01T00:20:00+00:00'


def entry(path, size, mtime_ms, sha):
    return {'path': path, 'bytes': size, 'mtime_ms': mtime_ms, 'sha256': sha}


def write_json(path, payload):
    parent = os.path.dirname(path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent)
    with io.open(path, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + '\n')


def snapshot(run_id, entries, collected_at, label):
    return {
        'collected_at': collected_at,
        'entries': entries,
        'cache_dir': CACHE_DIR,
        'tool': 'tests/collect-cache-state.py',
        'note': 'synthetic',
        'run_id': run_id,
        'snapshot_label': label,
    }


def stage_file(entries_before, entries_after, generated_at):
    return {
        'generated_at': generated_at,
        'bytecode_scope': {
            'cache_dir': CACHE_DIR,
            'env_applied': True,
            'env_variable': 'PYTHONDONTWRITEBYTECODE',
            'entries_before': entries_before,
            'entries_after': entries_after,
        },
    }


class CacheBoundaryTest(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(WORK, ignore_errors=True)
        os.makedirs(WORK)

    def tearDown(self):
        shutil.rmtree(WORK, ignore_errors=True)

    def fixture_dir(self, name):
        path = os.path.join(WORK, name)
        os.makedirs(path)
        return path

    def run_capture(self, command, tag):
        """用文件而不是管道捕获子进程输出：沙箱下管道可能不可用，文件不会骗人。"""
        stdout_path = os.path.join(WORK, tag + '.stdout.txt')
        stderr_path = os.path.join(WORK, tag + '.stderr.txt')
        env = dict(os.environ)
        env['PYTHONIOENCODING'] = 'utf-8'
        with io.open(stdout_path, 'w', encoding='utf-8', newline='\n') as out_handle, \
                io.open(stderr_path, 'w', encoding='utf-8', newline='\n') as err_handle:
            completed = subprocess.run(command, stdout=out_handle, stderr=err_handle, env=env)
        with io.open(stdout_path, encoding='utf-8') as handle:
            stdout = handle.read()
        with io.open(stderr_path, encoding='utf-8') as handle:
            stderr = handle.read()
        return completed.returncode, stdout, stderr

    def run_tool(self, args, tag='verdict'):
        return self.run_capture([sys.executable, TOOL] + args, tag)

    def verdict(self, out_path):
        with io.open(out_path, encoding='utf-8') as handle:
            return json.load(handle)

    def base_args(self, directory, baseline, postrun, out):
        return ['--run-id', RUN_ID, '--evidence-dir', directory,
                '--baseline', baseline, '--postrun', postrun, '--out', out]

    # ---------------------------------------------------------------- 场景 1

    def test_internal_ok_but_final_cache_changed_must_fail(self):
        directory = self.fixture_dir('changed')
        baseline = os.path.join(directory, 'cache-before.json')
        postrun = os.path.join(directory, 'cache-postrun.json')
        before = [entry(PYC_A, 100, 1000, SHA_A)]
        write_json(baseline, snapshot(RUN_ID, before, T0, 'cache-before'))
        # 阶段自报前后一致（工作流自己看到的是 OK），但最终快照里 mtime 已经变了。
        write_json(os.path.join(directory, 'coding-report.json'), stage_file(before, before, T1))
        write_json(postrun, snapshot(RUN_ID, [entry(PYC_A, 100, 9000, SHA_A)], T3, 'cache-postrun'))
        out = os.path.join(directory, 'verdict.json')
        code, stdout, stderr = self.run_tool(self.base_args(directory, baseline, postrun, out))
        self.assertEqual(code, 10, stdout + stderr)
        payload = self.verdict(out)
        self.assertEqual(payload['status'], 'NOT_CLEAN')
        kinds = [item['kind'] for item in payload['violations']]
        self.assertIn('mtime_changed', kinds)
        self.assertFalse(payload['coverage']['usesModelCalls'])

    def test_created_file_final_snapshot_must_fail(self):
        directory = self.fixture_dir('created')
        baseline = os.path.join(directory, 'cache-before.json')
        postrun = os.path.join(directory, 'cache-postrun.json')
        before = [entry(PYC_A, 100, 1000, SHA_A)]
        write_json(baseline, snapshot(RUN_ID, before, T0, 'cache-before'))
        write_json(os.path.join(directory, 'review.json'), stage_file(before, before, T1))
        write_json(postrun, snapshot(RUN_ID, before + [entry(PYC_B, 50, 2000, SHA_B)], T3, 'cache-postrun'))
        out = os.path.join(directory, 'verdict.json')
        code, stdout, stderr = self.run_tool(self.base_args(directory, baseline, postrun, out))
        self.assertEqual(code, 10, stdout + stderr)
        self.assertIn('created', [item['kind'] for item in self.verdict(out)['violations']])

    # ---------------------------------------------------------------- 场景 2

    def test_missing_final_snapshot_is_incomplete(self):
        directory = self.fixture_dir('missing')
        baseline = os.path.join(directory, 'cache-before.json')
        before = [entry(PYC_A, 100, 1000, SHA_A)]
        write_json(baseline, snapshot(RUN_ID, before, T0, 'cache-before'))
        write_json(os.path.join(directory, 'coding-report.json'), stage_file(before, before, T1))
        out = os.path.join(directory, 'verdict.json')
        code, stdout, stderr = self.run_tool(self.base_args(directory, baseline, os.path.join(directory, 'nope.json'), out))
        self.assertEqual(code, 11, stdout + stderr)
        payload = self.verdict(out)
        self.assertEqual(payload['status'], 'INCOMPLETE')
        self.assertIn('不存在', ' '.join(payload['problems']))

    def test_run_identity_mismatch_is_incomplete(self):
        directory = self.fixture_dir('identity')
        baseline = os.path.join(directory, 'cache-before.json')
        postrun = os.path.join(directory, 'cache-postrun.json')
        before = [entry(PYC_A, 100, 1000, SHA_A)]
        write_json(baseline, snapshot(RUN_ID, before, T0, 'cache-before'))
        write_json(os.path.join(directory, 'coding-report.json'), stage_file(before, before, T1))
        write_json(postrun, snapshot('another-run', before, T3, 'cache-postrun'))
        out = os.path.join(directory, 'verdict.json')
        code, stdout, stderr = self.run_tool(self.base_args(directory, baseline, postrun, out))
        self.assertEqual(code, 11, stdout + stderr)
        self.assertEqual(self.verdict(out)['status'], 'INCOMPLETE')

    def test_unusable_stage_observation_is_incomplete(self):
        directory = self.fixture_dir('bad-stage')
        baseline = os.path.join(directory, 'cache-before.json')
        postrun = os.path.join(directory, 'cache-postrun.json')
        before = [entry(PYC_A, 100, 1000, SHA_A)]
        write_json(baseline, snapshot(RUN_ID, before, T0, 'cache-before'))
        write_json(os.path.join(directory, 'coding-report.json'),
                   stage_file(before, [{'path': PYC_A}], T1))  # 缺字段
        write_json(postrun, snapshot(RUN_ID, before, T3, 'cache-postrun'))
        out = os.path.join(directory, 'verdict.json')
        code, stdout, stderr = self.run_tool(self.base_args(directory, baseline, postrun, out))
        self.assertEqual(code, 11, stdout + stderr)
        self.assertEqual(self.verdict(out)['status'], 'INCOMPLETE')

    # ---------------------------------------------------------------- 场景 3

    def test_consistent_timeline_passes(self):
        directory = self.fixture_dir('clean')
        baseline = os.path.join(directory, 'cache-before.json')
        postrun = os.path.join(directory, 'cache-postrun.json')
        before = [entry(PYC_A, 100, 1000, SHA_A), entry(PYC_B, 50, 2000, SHA_B)]
        write_json(baseline, snapshot(RUN_ID, before, T0, 'cache-before'))
        write_json(os.path.join(directory, 'coding-report.json'), stage_file(before, before, T1))
        write_json(os.path.join(directory, 'review.json'), stage_file(before, before, T2))
        write_json(postrun, snapshot(RUN_ID, list(reversed(before)), T3, 'cache-postrun'))
        out = os.path.join(directory, 'verdict.json')
        code, stdout, stderr = self.run_tool(self.base_args(directory, baseline, postrun, out))
        self.assertEqual(code, 0, stdout + stderr)
        payload = self.verdict(out)
        self.assertEqual(payload['status'], 'CLEAN')
        self.assertEqual(payload['violations'], [])
        # 时间线必须真的把基线、两个阶段的前后观测点、运行后快照都串起来（1 + 2×2 + 1 = 6），
        # 而不是只比首尾。
        self.assertEqual(len(payload['timeline']), 6)
        self.assertIn('不可观测', payload['coverage']['unobservedWindow'])

    # ---------------------------------------------------------------- 场景 4

    def test_collector_itself_writes_no_bytecode(self):
        repo = os.path.join(WORK, 'collector-repo')
        package = os.path.join(repo, 'demo')
        os.makedirs(os.path.join(repo, '.git'))
        os.makedirs(package)
        with io.open(os.path.join(package, 'demo.py'), 'w', encoding='utf-8', newline='\n') as handle:
            handle.write('VALUE = 1\n')
        cache_dir = os.path.join(package, '__pycache__')
        for label in ('cache-before', 'cache-postrun'):
            out = os.path.join(WORK, 'collector-' + label + '.json')
            code, stdout, stderr = self.run_capture(
                [sys.executable, COLLECT, '--target-dir', 'demo', '--repo-root', repo,
                 '--run-id', RUN_ID, '--snapshot-label', label, '--out', out],
                'collector-' + label)
            self.assertEqual(code, 0, stdout + stderr)
            self.assertFalse(os.path.isdir(cache_dir), '采集后不应出现 __pycache__ 目录')
            with io.open(out, encoding='utf-8') as handle:
                payload = json.load(handle)
            self.assertEqual(payload['entries'], [])
            self.assertEqual(payload['run_id'], RUN_ID)
            self.assertEqual(payload['snapshot_label'], label)


if __name__ == '__main__':
    unittest.main(verbosity=2)
