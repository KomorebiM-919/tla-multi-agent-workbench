#!/usr/bin/env python3
"""进程级测试：tools/claim_evidence_dir.py 的排他认领语义。

为什么必须起真进程：认领的排他性来自内核的 O_EXCL（`open(..., "x")`），同一进程里的重复调用
证明不了这一点；复审要求二明确写了"补实际重复认领及并发测试，不能只模拟 claimed=true"。
所以这里用 subprocess 真起进程，并发用例用 8 个进程同时抢同一个证据目录。

运行：python -m unittest discover -s tests -p "test_*.py" -v
"""

import json
import os
import subprocess
import sys
import unittest
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
TOOL = os.path.join(REPO_ROOT, 'tools', 'claim_evidence_dir.py')
# 临时"仓库根"放在仓库内的 tests/.scratch/（已 gitignore）：系统临时目录在沙箱/新机器上
# 可能对新建子目录不可写，而每次运行都要现造一个仓库根，放在仓库内才能保证测试可复现。
SCRATCH_ROOT = os.path.join(HERE, '.scratch')

WORKERS = 8
RUN_ID = 'v0.1-test-20261016T040000Z'
RUN_ID_LOSER = 'v0.1-test-20261016T040001Z'
RUN_STARTED_AT = '2026-10-16T04:00:00Z'
MARKER_NAME = '.run-owner.json'

EXIT_OK = 0
EXIT_ALREADY_CLAIMED = 10
EXIT_DIR_NOT_EMPTY = 11
EXIT_USAGE = 4


def build_command(repo_root, evidence_rel, run_id=RUN_ID, run_started_at=RUN_STARTED_AT, claimed_by='unittest'):
    return [
        sys.executable, TOOL,
        '--repo-root', repo_root,
        '--evidence-dir', evidence_rel,
        '--run-id', run_id,
        '--run-started-at', run_started_at,
        '--claimed-by', claimed_by,
    ]


def parse_payload(stdout):
    """取输出里最后一行 JSON（工具只打印一行，但保留容错以便错误信息混入时仍能断言退出码）。"""
    payload = None
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith('{') and line.endswith('}'):
            try:
                payload = json.loads(line)
            except ValueError:
                payload = None
    return payload


def run_tool(repo_root, evidence_rel, **kwargs):
    completed = subprocess.run(
        build_command(repo_root, evidence_rel, **kwargs),
        capture_output=True, text=True, encoding='utf-8', errors='replace', cwd=repo_root)
    return completed.returncode, parse_payload(completed.stdout), completed


class ClaimEvidenceDirTest(unittest.TestCase):
    def setUp(self):
        os.makedirs(SCRATCH_ROOT, exist_ok=True)
        # 不用 tempfile.mkdtemp：它按 0o700 建目录，Windows 上这会把目录的 DACL 收窄成
        # 只有所有者，连本进程自己都无法在其中再建子目录（WinError 5，实测 icacls 都无法读取）。
        # 本测试每次都要现造一个"仓库根"并在其下建目录，所以用默认权限的 os.makedirs。
        self.temp_root = os.path.join(SCRATCH_ROOT, 'claim-%d-%s' % (os.getpid(), uuid.uuid4().hex[:12]))
        os.makedirs(self.temp_root)
        self.addCleanup(self._cleanup)
        self.evidence_rel = 'docs/evidence/v0.1-test-20261016T040000Z'
        self.evidence_abs = os.path.join(self.temp_root, 'docs', 'evidence', 'v0.1-test-20261016T040000Z')
        self.marker_abs = os.path.join(self.evidence_abs, MARKER_NAME)

    def _cleanup(self):
        import shutil
        shutil.rmtree(self.temp_root, ignore_errors=True)

    def read_marker_text(self):
        with open(self.marker_abs, 'r', encoding='utf-8') as handle:
            return handle.read()

    # ---- 首次认领：排他创建成功 ------------------------------------------------
    def test_first_claim_creates_marker_exclusively(self):
        code, payload, completed = run_tool(self.temp_root, self.evidence_rel)
        self.assertEqual(code, EXIT_OK, completed.stderr)
        self.assertIsNotNone(payload)
        self.assertTrue(payload['claim_created'])
        self.assertEqual(payload['claim_exit_code'], EXIT_OK)
        self.assertEqual(payload['evidence_dir_state_before'], 'missing')
        self.assertEqual(payload['evidence_dir_state_after'], 'exists')
        self.assertEqual(payload['owner_marker_path'], self.evidence_rel + '/' + MARKER_NAME)
        self.assertEqual(payload['claim_tool'], 'tools/claim_evidence_dir.py')
        self.assertTrue(os.path.isfile(self.marker_abs))
        marker = json.loads(self.read_marker_text())
        self.assertEqual(marker['runId'], RUN_ID)
        self.assertEqual(marker['runStartedAt'], RUN_STARTED_AT)
        self.assertIn('exclusive-create', marker['claimMode'])

    # ---- 重复认领：拒绝且绝不覆写 ----------------------------------------------
    def test_second_claim_is_refused_and_marker_is_untouched(self):
        first_code, first_payload, _ = run_tool(self.temp_root, self.evidence_rel)
        self.assertEqual(first_code, EXIT_OK)
        original_text = self.read_marker_text()

        second_code, second_payload, completed = run_tool(
            self.temp_root, self.evidence_rel, run_id=RUN_ID_LOSER,
            run_started_at='2026-10-16T04:00:01Z', claimed_by='intruder')
        self.assertEqual(second_code, EXIT_ALREADY_CLAIMED, completed.stderr)
        self.assertIsNotNone(second_payload)
        self.assertFalse(second_payload['claim_created'])
        self.assertIsNone(second_payload['claimed_at'])
        self.assertEqual(second_payload['claim_exit_code'], EXIT_ALREADY_CLAIMED)
        self.assertEqual(second_payload['existing_claim']['runId'], RUN_ID)
        # 逐字节不变：认领时间、认领者都不能被后到的运行改写
        self.assertEqual(self.read_marker_text(), original_text)
        marker = json.loads(self.read_marker_text())
        self.assertEqual(marker['runId'], RUN_ID)
        self.assertEqual(marker['claimedAt'], first_payload['claimed_at'])
        self.assertEqual(marker['claimedBy'], 'unittest')

    def test_same_run_id_cannot_reclaim(self):
        run_tool(self.temp_root, self.evidence_rel)
        original_text = self.read_marker_text()
        code, payload, _ = run_tool(self.temp_root, self.evidence_rel)
        self.assertEqual(code, EXIT_ALREADY_CLAIMED)
        self.assertFalse(payload['claim_created'])
        self.assertEqual(self.read_marker_text(), original_text)

    # ---- 真实并发：8 个进程抢同一个证据目录，只能有一个成功 ----------------------
    def test_concurrent_claims_only_one_process_wins(self):
        processes = []
        for index in range(WORKERS):
            processes.append(subprocess.Popen(
                build_command(self.temp_root, self.evidence_rel,
                              run_id='v0.1-test-20261016T0400%02dZ' % index,
                              run_started_at='2026-10-16T04:00:%02dZ' % index,
                              claimed_by='worker-%02d' % index),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                encoding='utf-8', errors='replace', cwd=self.temp_root))

        results = []
        for index, process in enumerate(processes):
            stdout, stderr = process.communicate(timeout=120)
            results.append((index, process.returncode, parse_payload(stdout), stderr))

        winners = [item for item in results if item[1] == EXIT_OK]
        # 输家的失败码有两种，且都算"被拒绝"：10 = 认领文件已存在（读到了赢家写的 marker）；
        # 11 = 目录已存在且非空但没有认领文件——竞态下这是真实可能的结果：赢家先把目录建出来、
        # 还没写 marker，此时输家看到的是"非空目录"而不是"已认领目录"。把 11 判成失败会得到一个
        # 随机偶发的测试（首次出现即本机 8 进程真并发时），而不是更严格的断言：
        # 真正要锁住的性质是"只有一个成功"，其余无论走哪条拒绝路径都不得创建认领文件。
        refused = [item for item in results if item[1] in (EXIT_ALREADY_CLAIMED, EXIT_DIR_NOT_EMPTY)]
        self.assertEqual(len(winners), 1, '并发认领必须只有一个成功：%r' % (results,))
        self.assertEqual(len(refused), WORKERS - 1, '其余进程必须被拒绝：%r' % (results,))
        for _, code, payload, _ in refused:
            self.assertFalse(payload['claim_created'])
            self.assertIsNone(payload['claimed_at'])
            if code == EXIT_ALREADY_CLAIMED:
                self.assertEqual(payload['existing_claim']['runId'],
                                 'v0.1-test-20261016T0400%02dZ' % winners[0][0])
            else:
                self.assertEqual(payload['evidence_dir_state_before'], 'exists')

        marker = json.loads(self.read_marker_text())
        self.assertEqual(marker['runId'], 'v0.1-test-20261016T0400%02dZ' % winners[0][0])
        self.assertEqual(marker['claimedBy'], 'worker-%02d' % winners[0][0])
        self.assertEqual(len(os.listdir(self.evidence_abs)), 1, '证据目录里只能有认领文件')

    # ---- 目录状态：非空但无认领 ⇒ 拒绝；空目录 ⇒ 可认领 ------------------------
    def test_non_empty_unclaimed_directory_is_refused(self):
        os.makedirs(self.evidence_abs)
        stray = os.path.join(self.evidence_abs, 'left-over.json')
        with open(stray, 'w', encoding='utf-8') as handle:
            handle.write('{}\n')

        code, payload, _ = run_tool(self.temp_root, self.evidence_rel)
        self.assertEqual(code, EXIT_DIR_NOT_EMPTY)
        self.assertFalse(payload['claim_created'])
        self.assertEqual(payload['evidence_dir_state_before'], 'exists')
        self.assertFalse(os.path.exists(self.marker_abs), '拒绝时不得写入认领文件')
        self.assertEqual(sorted(os.listdir(self.evidence_abs)), ['left-over.json'])

    def test_empty_existing_directory_can_be_claimed(self):
        os.makedirs(self.evidence_abs)
        code, payload, _ = run_tool(self.temp_root, self.evidence_rel)
        self.assertEqual(code, EXIT_OK)
        self.assertEqual(payload['evidence_dir_state_before'], 'empty')
        self.assertTrue(payload['claim_created'])

    def test_file_at_evidence_path_is_refused(self):
        os.makedirs(os.path.dirname(self.evidence_abs))
        with open(self.evidence_abs, 'w', encoding='utf-8') as handle:
            handle.write('not a directory\n')
        code, payload, _ = run_tool(self.temp_root, self.evidence_rel)
        self.assertEqual(code, EXIT_DIR_NOT_EMPTY)
        self.assertEqual(payload['evidence_dir_state_before'], 'not_a_directory')

    # ---- 参数与路径：fail-closed ----------------------------------------------
    def test_absolute_and_traversal_paths_are_rejected(self):
        for bad in ('../outside-repo', 'docs/../secrets', '/etc/passwd', 'C:/Windows/Temp/x', 'docs\\evidence\\x', '', '.'):
            with self.subTest(evidence_dir=bad):
                code, payload, _ = run_tool(self.temp_root, bad)
                self.assertEqual(code, EXIT_USAGE, 'evidence_dir=%r 必须被拒绝' % bad)
                self.assertFalse(payload['claim_created'])
                self.assertFalse(os.path.exists(os.path.join(self.temp_root, 'outside-repo')))

    def test_invalid_run_id_and_timestamp_are_rejected(self):
        cases = [
            {'run_id': 'bad id with spaces'},
            {'run_id': ''},
            # 以 '-' 开头的取值会被 argparse 当成选项，工具在参数层就拒绝（退出码 4，不打印 JSON）
            {'run_id': '-leading-dash'},
            {'run_started_at': '2026-10-16 04:00:00'},
            {'run_started_at': '2026-02-30T04:00:00Z'},
            {'run_started_at': '2026-10-16T04:00:00'},
        ]
        for overrides in cases:
            with self.subTest(**overrides):
                code, payload, _ = run_tool(self.temp_root, self.evidence_rel, **overrides)
                self.assertEqual(code, EXIT_USAGE, overrides)
                if payload is not None:
                    self.assertFalse(payload['claim_created'])
                    self.assertEqual(payload['claim_exit_code'], EXIT_USAGE)
        self.assertFalse(os.path.exists(self.marker_abs))
        self.assertFalse(os.path.exists(self.evidence_abs))

    def test_missing_arguments_exit_with_usage_code(self):
        completed = subprocess.run([sys.executable, TOOL, '--repo-root', self.temp_root],
                                   capture_output=True, text=True, encoding='utf-8', errors='replace')
        self.assertEqual(completed.returncode, EXIT_USAGE)

        completed = subprocess.run([sys.executable, TOOL, '--repo-root', self.temp_root,
                                    '--evidence-dir', self.evidence_rel, '--run-id', RUN_ID,
                                    '--run-started-at', RUN_STARTED_AT, '--unknown-flag', 'x'],
                                   capture_output=True, text=True, encoding='utf-8', errors='replace')
        self.assertEqual(completed.returncode, EXIT_USAGE)

    # ---- 认领文件本身不得泄漏本机路径 ------------------------------------------
    def test_marker_records_only_relative_paths(self):
        code, _, _ = run_tool(self.temp_root, self.evidence_rel)
        self.assertEqual(code, EXIT_OK)
        text = self.read_marker_text()
        self.assertNotIn(self.temp_root.replace('\\', '\\\\'), text)
        self.assertNotIn('\\\\', text)
        marker = json.loads(text)
        self.assertEqual(sorted(marker.keys()),
                         ['claimMode', 'claimTool', 'claimedAt', 'claimedBy', 'runId', 'runStartedAt'])


if __name__ == '__main__':
    unittest.main()
