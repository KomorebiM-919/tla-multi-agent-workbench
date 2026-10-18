# tests/test_run_review_suite.py
#
# `tests/run-review-suite.py` 的离线管线测试（不调用真实模型、不跑整轮复核）：
#   1. `--out-dir` 已存在且非空时必须拒绝运行（exit 2），不得覆盖既有归档；
#   2. `--out-dir` 必须真正传到每个会写文件的子工具（`--json-out` / `--out`），
#      不是只把文本输出换个目录；
#   3. 子进程环境显式带 `PYTHONDONTWRITEBYTECODE=1`，并记录在 suite-results 里；
#   4. 单条命令超时记为失败（exit 124）且**继续收尾**：其余结果与 suite-results.json 仍然落盘；
#   5. 收尾状态：有失败命令时 main() 返回 1，无失败时返回 0。

import importlib.util
import io
import json
import shutil
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SUITE_PATH = REPO_ROOT / 'tests' / 'run-review-suite.py'
SCRATCH = REPO_ROOT / 'tests' / '.scratch' / 'run-review-suite'


def load_suite():
    """按路径加载连字符命名的脚本模块（不能直接 import）。"""
    spec = importlib.util.spec_from_file_location('run_review_suite', SUITE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PrepareOutDirTests(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(SCRATCH, ignore_errors=True)
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.suite = load_suite()

    def test_refuses_non_empty_directory(self):
        target = SCRATCH / 'archive'
        target.mkdir()
        (target / 'existing.txt').write_bytes(b'keep me')
        problem = self.suite.prepare_out_dir(target)
        self.assertIsNotNone(problem)
        self.assertIn('拒绝覆盖', problem)
        self.assertEqual(sorted(p.name for p in target.iterdir()), ['existing.txt'])

    def test_creates_text_and_json_subdirs(self):
        target = SCRATCH / 'fresh'
        self.assertIsNone(self.suite.prepare_out_dir(target))
        self.assertTrue((target / 'text').is_dir())
        self.assertTrue((target / 'json').is_dir())

    def test_rejects_file_at_out_dir(self):
        target = SCRATCH / 'file'
        target.write_bytes(b'x')
        self.assertIsNotNone(self.suite.prepare_out_dir(target))


class CommandTableTests(unittest.TestCase):
    def setUp(self):
        self.suite = load_suite()
        self.paths = {
            'review': 'out/json/review-run-evidence.json',
            'probe': 'out/json/probe.json',
            'mutation': 'out/json/mutation.json',
            'native': 'out/json/native-events.json',
        }

    def test_every_writer_receives_out_dir_path(self):
        table = self.suite.commands('demo-run', self.paths, type('O', (), {
            'parent_session': 'parent', 'workflow_name': 'wf', 'since': '2026-10-17T00:00:00Z'})())
        by_name = dict(table)
        self.assertIn(self.paths['review'], by_name['02-review-run-evidence'])
        self.assertIn(self.paths['probe'], by_name['04-independent-probe'])
        self.assertIn(self.paths['mutation'], by_name['05-mutation-check'])
        self.assertIn('--out', by_name['13-native-events'])
        self.assertIn(self.paths['native'], by_name['13-native-events'])

    def test_review_arguments_include_mapping_and_allow_scope(self):
        argv = self.suite.review_arguments('demo-run', self.paths['review'])
        self.assertIn('--mapping', argv)
        self.assertIn('--json-out', argv)
        self.assertIn('--allow-scope', argv)
        self.assertEqual(argv[argv.index('--json-out') + 1], self.paths['review'])

    def test_no_command_writes_outside_out_dir_for_json(self):
        table = self.suite.commands('demo-run', self.paths, type('O', (), {
            'parent_session': 'parent', 'workflow_name': 'wf', 'since': '2026-10-17T00:00:00Z'})())
        for name, argv in table:
            for flag in ('--json-out', '--out'):
                if flag in argv:
                    value = argv[argv.index(flag) + 1]
                    self.assertTrue(value.startswith('out/json/'), name + ' 的 ' + flag + ' 不在 out-dir 下：' + value)


class ChildEnvironmentTests(unittest.TestCase):
    def test_forbids_bytecode_writing(self):
        suite = load_suite()
        self.assertEqual(suite.child_environment().get('PYTHONDONTWRITEBYTECODE'), '1')


class TimeoutTests(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(SCRATCH, ignore_errors=True)
        (SCRATCH / 'text').mkdir(parents=True, exist_ok=True)
        self.suite = load_suite()

    def test_timeout_is_recorded_and_does_not_drop_results(self):
        result = self.suite.run_one('99-timeout', ['python', '-c',
                                                  'import time; time.sleep(5)'],
                                    SCRATCH / 'text', 0.2)
        self.assertEqual(result['exitCode'], self.suite.TIMEOUT_EXIT_CODE)
        self.assertTrue(result['timedOut'])
        written = REPO_ROOT / result['output']
        body = written.read_text(encoding='utf-8')
        self.assertIn('timed out: yes', body)
        self.assertIn('超时', body)

    def test_main_finishes_and_reports_failure_after_timeout(self):
        out_dir = SCRATCH / 'out'
        original = self.suite.commands
        self.suite.commands = lambda run_id, paths, options: [
            ('01-sleep', ['python', '-c', 'import time; time.sleep(5)']),
            ('02-ok', ['python', '-c', 'print("ok")'])]
        try:
            code = self.suite.main(['--run-id', 'demo-run', '--out-dir', str(out_dir),
                                    '--parent-session', 'p', '--workflow-name', 'w',
                                    '--since', '2026-10-17T00:00:00Z', '--timeout', '1'])
        finally:
            self.suite.commands = original
        self.assertEqual(code, 1)
        manifest = json.loads((out_dir / 'suite-results.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['failed'], ['01-sleep'])
        self.assertEqual(manifest['timedOut'], ['01-sleep'])
        self.assertEqual(len(manifest['results']), 2)
        self.assertEqual(manifest['results'][1]['exitCode'], 0)
        self.assertEqual(manifest['environment']['PYTHONDONTWRITEBYTECODE'], '1')

    def test_main_returns_two_when_out_dir_is_archived(self):
        out_dir = SCRATCH / 'archived'
        out_dir.mkdir()
        (out_dir / 'suite-results.json').write_bytes(b'{}')
        code = self.suite.main(['--run-id', 'demo-run', '--out-dir', str(out_dir),
                                '--parent-session', 'p', '--workflow-name', 'w',
                                '--since', '2026-10-17T00:00:00Z'])
        self.assertEqual(code, 2)


if __name__ == '__main__':
    unittest.main()
