#!/usr/bin/env python3
"""排他认领本次运行的证据目录：用 O_EXCL 创建 `<evidence_dir>/.run-owner.json`。

为什么需要这个工具（复审要求二）：
- 证据目录是"两个运行共用就会互相覆盖证据"的资源。预检子代理自己拼写认领文件时，
  "先检查目录是否被占用、再写入认领文件"之间存在竞态：两个并发的运行可能都通过检查。
- 本工具用 `open(marker, "x")`（底层 O_EXCL）创建认领文件：内核保证**只有一个**进程能创建成功；
  已有认领一律拒绝，且**绝不覆写**已存在的认领文件。结论只由退出码表达，不靠自述。

退出码：
    0  本次运行认领成功（认领文件由本进程排他创建）
   10  该证据目录已被认领（拒绝覆写，不会修改任何文件）
   11  目录已存在且非空，但没有认领文件（拒绝在来历不明的目录里写证据）
   12  证据目录（解算后的真实路径）越出仓库根
    4  参数错误
    5  IO 错误

标准输出是一行 JSON（字段与预检产物一一对应）；无论成功失败都打印，便于直接抄进结构化结果。
"""

import argparse
import datetime
import json
import os
import re
import sys

EXIT_OK = 0
EXIT_ALREADY_CLAIMED = 10
EXIT_DIR_NOT_EMPTY = 11
EXIT_OUTSIDE_REPO = 12
EXIT_USAGE = 4
EXIT_IO = 5

MARKER_NAME = '.run-owner.json'
RUN_ID_PATTERN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
TOOL_PATH = 'tools/claim_evidence_dir.py'


class _Parser(argparse.ArgumentParser):
    """参数错误必须有自己的退出码：默认的 2 与本工具的结论码混在一起会无法区分。"""

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write('error: %s\n' % message)
        raise SystemExit(EXIT_USAGE)


def _parse_iso(text):
    """严格解析带时区的 ISO-8601；不合法返回 None。"""
    try:
        parsed = datetime.datetime.fromisoformat(text.replace('Z', '+00:00'))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed


def _now_iso():
    return datetime.datetime.now().astimezone().isoformat()


def _normalize_rel(value):
    """返回规范化后的仓库内相对路径；不合法（绝对路径/盘符/点段/反斜杠）返回 None。"""
    if value == '' or '\\' in value:
        return None
    if value.startswith('/') or re.match(r'^[A-Za-z]:', value):
        return None
    segments = [segment for segment in value.rstrip('/').split('/')]
    if not segments or any(segment in ('', '.', '..') for segment in segments):
        return None
    return '/'.join(segments)


def _under(root, child):
    root_norm = os.path.normcase(os.path.normpath(root))
    child_norm = os.path.normcase(os.path.normpath(child))
    return child_norm == root_norm or child_norm.startswith(root_norm + os.sep)


def _directory_state(path):
    if not os.path.exists(path):
        return 'missing'
    if not os.path.isdir(path):
        return 'not_a_directory'
    if os.listdir(path):
        return 'exists'
    return 'empty'


def _read_marker(path):
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def _emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + '\n')
    sys.stdout.flush()


def main(argv):
    # 输出统一用 UTF-8：本机控制台默认代码页会让中文/特殊字符直接抛 UnicodeEncodeError，
    # 而这份 JSON 是要被上层抄进结构化结果的，不能因为控制台代码页而丢字符。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass

    parser = _Parser(description='排他认领证据目录（O_EXCL 创建 .run-owner.json）')
    parser.add_argument('--repo-root', required=True, help='仓库根目录（. 表示当前目录）')
    parser.add_argument('--evidence-dir', required=True, help='相对仓库根的证据目录，例如 docs/evidence/v0.1-run6-20261016T154400Z')
    parser.add_argument('--run-id', required=True, help='本次运行的 runId')
    parser.add_argument('--run-started-at', required=True, help='本次运行的 runStartedAt（带时区的 ISO-8601）')
    parser.add_argument('--claimed-by', default='preflight', help='认领者标识（默认 preflight）')
    args = parser.parse_args(argv)

    payload = {
        'claim_tool': TOOL_PATH,
        'claim_created': False,
        'claimed_at': None,
        'run_id': args.run_id,
        'run_started_at': args.run_started_at,
        'claimed_by': args.claimed_by,
    }

    # ---- 参数校验（fail-closed：任何一项不成立都不写任何文件）
    reasons = []
    if not RUN_ID_PATTERN.match(args.run_id):
        reasons.append('run_id 非法：%r' % args.run_id)
    if _parse_iso(args.run_started_at) is None:
        reasons.append('run_started_at 不是合法的带时区 ISO-8601：%r' % args.run_started_at)
    if args.claimed_by.strip() == '':
        reasons.append('claimed_by 不得为空')
    relative = _normalize_rel(args.evidence_dir)
    if relative is None:
        reasons.append('evidence_dir 必须是仓库内相对路径（禁止绝对路径/盘符/反斜杠/`.`/`..`）：%r' % args.evidence_dir)
    if reasons:
        payload['reason'] = '；'.join(reasons)
        payload['claim_exit_code'] = EXIT_USAGE
        _emit(payload)
        return EXIT_USAGE

    repo_root = os.path.realpath(args.repo_root)
    if not os.path.isdir(repo_root):
        payload['reason'] = 'repo-root 不是已存在的目录：%r' % args.repo_root
        payload['claim_exit_code'] = EXIT_USAGE
        _emit(payload)
        return EXIT_USAGE

    evidence_abs = os.path.join(repo_root, *relative.split('/'))
    evidence_real = os.path.realpath(evidence_abs)
    marker_abs = os.path.join(evidence_abs, MARKER_NAME)
    payload['evidence_dir'] = relative
    payload['evidence_dir_realpath'] = evidence_real
    payload['owner_marker_path'] = relative + '/' + MARKER_NAME

    # 位置必须落在仓库根之内：预检自己算的 realpath 与本工具独立算的必须一致。
    if not _under(repo_root, evidence_real):
        payload['reason'] = '证据目录的真实路径越出仓库根：%s（repo=%s）' % (evidence_real, repo_root)
        payload['claim_exit_code'] = EXIT_OUTSIDE_REPO
        _emit(payload)
        return EXIT_OUTSIDE_REPO

    # ---- 已有认领：只读检查，直接拒绝（不触碰任何文件）
    if os.path.exists(marker_abs):
        existing = _read_marker(marker_abs)
        payload['evidence_dir_state_before'] = _directory_state(evidence_abs)
        payload['existing_claim'] = existing
        payload['reason'] = '该证据目录已被认领，拒绝覆写：%s' % marker_abs
        payload['claim_exit_code'] = EXIT_ALREADY_CLAIMED
        _emit(payload)
        return EXIT_ALREADY_CLAIMED

    state = _directory_state(evidence_abs)
    payload['evidence_dir_state_before'] = state
    if state == 'not_a_directory':
        payload['reason'] = '证据目录路径已存在且不是目录：%s' % evidence_real
        payload['claim_exit_code'] = EXIT_DIR_NOT_EMPTY
        _emit(payload)
        return EXIT_DIR_NOT_EMPTY
    if state == 'exists':
        payload['reason'] = '证据目录已存在且非空（且没有认领文件），拒绝在其中写入本次运行的证据：%s' % evidence_real
        payload['claim_exit_code'] = EXIT_DIR_NOT_EMPTY
        _emit(payload)
        return EXIT_DIR_NOT_EMPTY

    # ---- 排他创建：内核保证只有一个进程成功（这是"独占"的唯一依据）
    claimed_at = _now_iso()
    record = {
        'runId': args.run_id,
        'runStartedAt': args.run_started_at,
        'claimedAt': claimed_at,
        'claimedBy': args.claimed_by,
        'claimMode': 'exclusive-create (O_EXCL)',
        'claimTool': TOOL_PATH,
    }
    try:
        os.makedirs(evidence_abs, exist_ok=True)
        with open(marker_abs, 'x', encoding='utf-8') as handle:
            json.dump(record, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError:
        existing = _read_marker(marker_abs)
        payload['existing_claim'] = existing
        payload['reason'] = '排他创建失败：认领文件已存在（并发运行的另一个进程先创建成功），拒绝覆写：%s' % marker_abs
        payload['claim_exit_code'] = EXIT_ALREADY_CLAIMED
        _emit(payload)
        return EXIT_ALREADY_CLAIMED
    except OSError as error:
        payload['reason'] = '写入认领文件失败：%s' % error
        payload['claim_exit_code'] = EXIT_IO
        _emit(payload)
        return EXIT_IO

    payload['claim_created'] = True
    payload['claimed_at'] = claimed_at
    payload['evidence_dir_state_after'] = _directory_state(evidence_abs)
    payload['claim_exit_code'] = EXIT_OK
    _emit(payload)
    return EXIT_OK


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
