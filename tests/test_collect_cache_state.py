#!/usr/bin/env python3
"""进程级测试：tests/collect-cache-state.py（确定性缓存快照工具）。

为什么起真进程：这个工具的定位是"确定性的、不调用模型的本地采集"，
它的价值全在"同样的文件状态必然得到同样的条目、且字段口径与编排层 normalizeCacheEntries 兼容"。
只在同进程里调函数证不了退出码、stdout 一行 JSON、`--out` 写盘编码（UTF-8 无 BOM、LF）这些对外契约。

覆盖：
  1. 采集真实文件：path/bytes/mtime_ms/sha256 四项与磁盘一致，sha256 等于按原始字节算的哈希；
  2. 字段口径：path 用正斜杠、bytes 与 mtime_ms 是整数、sha256 是小写十六进制（编排层按这四个字段比较）；
  3. 目录存在但没有 .pyc：entries 为空 + note 说明，仍退出 0（"没有缓存"不是错误）；
  4. 缓存目录不存在：entries 为空 + note 说明，退出 0；
  5. 只列 .pyc，忽略其他文件与子目录；
  6. `--out` 写盘：UTF-8 无 BOM、LF 行尾、内容与 stdout 解析结果一致；父目录不存在时自动创建；
  7. 确定性：同一状态跑两次，entries 逐字节一致（collected_at 属于易变字段，单独比较）；
  8. 参数错误：两个都给 / 都不给 / 未知参数 ⇒ 退出 4；
  9. 越界：`--cache-dir` 用 `..` 逃出仓库根 ⇒ 退出 12，且不写 --out 文件；
 10. 语义边界：mtime_ms 是"整数毫秒"，与编排层的 5 毫秒容差口径一致（同一文件两次采集 mtime 相同）。

运行：python -m unittest discover -s tests -p "test_*.py" -v
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
TOOL = os.path.join(HERE, 'collect-cache-state.py')
# 临时"仓库根"放在已 gitignore 的 tests/.scratch/ 下：系统临时目录在沙箱里未必可写。
SCRATCH_ROOT = os.path.join(HERE, '.scratch')

EXIT_OK = 0
EXIT_USAGE = 4
EXIT_OUTSIDE_REPO = 12

TARGET_REL = 'pkg'
CACHE_REL = 'pkg/__pycache__'


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


class CollectCacheStateTest(unittest.TestCase):
    def setUp(self):
        os.makedirs(SCRATCH_ROOT, exist_ok=True)
        self.repo = os.path.join(SCRATCH_ROOT, 'collect-cache-state-repo')
        shutil.rmtree(self.repo, ignore_errors=True)
        os.makedirs(os.path.join(self.repo, '.git'), exist_ok=True)  # 只作为仓库标记
        self.cache_dir = os.path.join(self.repo, CACHE_REL)
        os.makedirs(self.cache_dir, exist_ok=True)
        self.out_dir = os.path.join(SCRATCH_ROOT, 'collect-cache-state-out')
        shutil.rmtree(self.out_dir, ignore_errors=True)
        os.makedirs(self.out_dir, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.repo, ignore_errors=True)
        shutil.rmtree(self.out_dir, ignore_errors=True)

    def write_cache_file(self, name, payload):
        path = os.path.join(self.cache_dir, name)
        with open(path, 'wb') as handle:
            handle.write(payload)
        return path

    def run_tool(self, args):
        # 子进程 stdout 走管道时用 locale 编码（Windows 上是 cp936），而工具输出的是 UTF-8 JSON（含中文 note）。
        # 不强制 PYTHONIOENCODING 就会在父进程按 utf-8 解码时报替换字符，断言随之失真。
        env = dict(os.environ)
        env['PYTHONIOENCODING'] = 'utf-8'
        completed = subprocess.run(
            [sys.executable, TOOL] + args, env=env,
            capture_output=True, text=True, encoding='utf-8', errors='replace', cwd=self.repo)
        return completed

    def parse_stdout(self, completed):
        """工具打印一行 JSON；`--pretty` 时是多行。取最后一段从 `{` 开始的可解析 JSON。"""
        lines = completed.stdout.splitlines()
        starts = [index for index, line in enumerate(lines) if line.strip().startswith('{')]
        for start in reversed(starts):
            try:
                return json.loads('\n'.join(lines[start:]))
            except ValueError:
                continue
        return None

    # ---------------------------------------------------------------- 用例

    def test_collects_real_files_with_compatible_fields(self):
        first = self.write_cache_file('alpha.cpython-313.pyc', b'alpha-bytes')
        second = self.write_cache_file('beta.cpython-313.pyc', b'beta-bytes!')
        completed = self.run_tool(['--target-dir', TARGET_REL])
        self.assertEqual(completed.returncode, EXIT_OK, completed.stderr)
        payload = self.parse_stdout(completed)
        self.assertIsNotNone(payload, completed.stdout)
        self.assertEqual(payload['tool'], 'tests/collect-cache-state.py')
        self.assertEqual(payload['cache_dir'], CACHE_REL)
        self.assertEqual(len(payload['entries']), 2)
        entries = {entry['path']: entry for entry in payload['entries']}
        self.assertEqual(sorted(entries), ['pkg/__pycache__/alpha.cpython-313.pyc',
                                           'pkg/__pycache__/beta.cpython-313.pyc'])
        for path, source in (('pkg/__pycache__/alpha.cpython-313.pyc', first),
                             ('pkg/__pycache__/beta.cpython-313.pyc', second)):
            entry = entries[path]
            self.assertEqual(entry['bytes'], os.path.getsize(source))
            self.assertEqual(entry['sha256'], sha256_of(source))
            self.assertIsInstance(entry['bytes'], int)
            self.assertIsInstance(entry['mtime_ms'], int)
            self.assertEqual(len(entry['sha256']), 64)
            self.assertEqual(entry['sha256'], entry['sha256'].lower())
            self.assertNotIn('\\', entry['path'])

    def test_mtime_is_integer_milliseconds_and_stable(self):
        path = self.write_cache_file('stable.cpython-313.pyc', b'stable')
        first = self.parse_stdout(self.run_tool(['--target-dir', TARGET_REL]))
        second = self.parse_stdout(self.run_tool(['--target-dir', TARGET_REL]))
        self.assertEqual(first['entries'], second['entries'], '同一状态两次采集的条目必须一致')
        expected_ms = int(os.stat(path).st_mtime_ns // 1000000)
        self.assertEqual(first['entries'][0]['mtime_ms'], expected_ms)
        # 编排层的容差是 5 毫秒，用来吸收整数/浮点表示差；这里必须是整数毫秒，不能是秒或浮点。
        self.assertIsInstance(first['entries'][0]['mtime_ms'], int)

    def test_empty_cache_dir_is_success(self):
        completed = self.run_tool(['--target-dir', TARGET_REL])
        self.assertEqual(completed.returncode, EXIT_OK, completed.stderr)
        payload = self.parse_stdout(completed)
        self.assertEqual(payload['entries'], [])
        self.assertIn('没有 .pyc', payload['note'])

    def test_missing_cache_dir_is_success(self):
        shutil.rmtree(self.cache_dir)
        completed = self.run_tool(['--target-dir', TARGET_REL])
        self.assertEqual(completed.returncode, EXIT_OK, completed.stderr)
        payload = self.parse_stdout(completed)
        self.assertEqual(payload['entries'], [])
        self.assertIn('不存在', payload['note'])

    def test_ignores_non_pyc_and_subdirectories(self):
        self.write_cache_file('keep.cpython-313.pyc', b'keep')
        self.write_cache_file('notes.txt', b'not a pyc')
        os.makedirs(os.path.join(self.cache_dir, 'nested'), exist_ok=True)
        with open(os.path.join(self.cache_dir, 'nested', 'inner.pyc'), 'wb') as handle:
            handle.write(b'inner')
        payload = self.parse_stdout(self.run_tool(['--target-dir', TARGET_REL]))
        self.assertEqual([entry['path'] for entry in payload['entries']],
                         ['pkg/__pycache__/keep.cpython-313.pyc'])

    def test_out_file_is_utf8_without_bom_and_lf(self):
        self.write_cache_file('alpha.cpython-313.pyc', b'alpha')
        out_path = os.path.join(self.out_dir, 'deep', 'cache-postrun.json')
        completed = self.run_tool(['--target-dir', TARGET_REL, '--out', out_path, '--pretty'])
        self.assertEqual(completed.returncode, EXIT_OK, completed.stderr)
        self.assertTrue(os.path.isfile(out_path), '父目录不存在时必须自动创建')
        with open(out_path, 'rb') as handle:
            raw = handle.read()
        self.assertFalse(raw.startswith(b'\xef\xbb\xbf'), '不得写 BOM')
        self.assertNotIn(b'\r\n', raw, '行尾必须是 LF')
        written = json.loads(raw.decode('utf-8'))
        self.assertEqual(written['entries'], self.parse_stdout(completed)['entries'])

    def test_argument_errors_exit_4(self):
        both = self.run_tool(['--target-dir', TARGET_REL, '--cache-dir', CACHE_REL])
        self.assertEqual(both.returncode, EXIT_USAGE, both.stderr)
        neither = self.run_tool([])
        self.assertEqual(neither.returncode, EXIT_USAGE, neither.stderr)
        unknown = self.run_tool(['--target-dir', TARGET_REL, '--bogus'])
        self.assertEqual(unknown.returncode, EXIT_USAGE, unknown.stderr)

    def test_escape_outside_repo_exits_12_and_writes_nothing(self):
        outside = os.path.join('..', '..', '..', 'escape-__pycache__')
        out_path = os.path.join(self.out_dir, 'should-not-exist.json')
        completed = self.run_tool(['--cache-dir', outside, '--out', out_path])
        self.assertEqual(completed.returncode, EXIT_OUTSIDE_REPO, completed.stderr)
        self.assertFalse(os.path.exists(out_path), '越界时不得写 --out 文件')

    def test_reports_cache_dir_via_cache_dir_flag(self):
        self.write_cache_file('alpha.cpython-313.pyc', b'alpha')
        payload = self.parse_stdout(self.run_tool(['--cache-dir', CACHE_REL]))
        self.assertEqual(payload['cache_dir'], CACHE_REL)
        self.assertEqual(len(payload['entries']), 1)


if __name__ == '__main__':
    unittest.main()
