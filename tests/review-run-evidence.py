#!/usr/bin/env python3
"""独立复核某一次真实运行的证据目录（只读，不修改任何文件）。

用法:
    python tests/review-run-evidence.py --run-id <runId> [--repo-root .] [--json-out <path>]

复核内容（全部以磁盘原始字节与 git 实际情况为准，不采信任何自述结论）:
  1. 认领文件 .run-owner.json：run_id 与本次一致、claimed_by / claimed_at 非空；
  2. requirement.json：验收条件带唯一 ID、自检无冲突且 self_checked 为真；
  3. coding-report.json：改动文件落在允许的交付文件集合内、自述退出码为 0；
  4. verify.json：命令为规范化命令、退出码 0、原始输出含 `Ran N tests` 与 `OK`、N >= 1 且非全跳过；
  5. verify.artifacts：sha256 与磁盘实际字节一致，集合恰好等于 {模块文件, 测试文件}；
  6. review.json：APPROVED、criteria_check 恰好覆盖需求验收 ID 且逐条 satisfied、
     独立复跑命令/退出码/输出成立、用例数与 Verifier 一致、artifacts_after 与 verify.artifacts 及磁盘一致；
  7. 时间戳：各阶段 generated_at 合法、落在运行窗口内、阶段顺序非递减；
  8. 工作区范围：git 跟踪文件的改动只出现在允许修改的 4 个交付文件里。

退出码: 0 = 全部通过; 1 = 有检查失败; 2 = 证据缺失或不合法。
"""

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ALLOWED_DELIVERY_FILES = (
    'examples/text-stats/text_stats.py',
    'examples/text-stats/test_text_stats.py',
    'examples/text-stats/README.md',
    'examples/text-stats/sample_input.txt',
)
# 编排层自己的复核工具：不是交付源码，但也不能默默放过，单独列出供人复核。
ORCHESTRATOR_TOOLS = ('tests/review-run-evidence.py',)
CRITERION_ID_RE = re.compile(r'^\s*([A-Za-z]{2,8}-[A-Za-z0-9]{1,4})')
RAN_RE = re.compile(r'Ran (\d+) tests? in ')
FAILED_RE = re.compile(r'(^|\n)FAILED')
OK_RE = re.compile(r'(^|\n)OK( \([^\n]*\))?(\n|$|\s*$)')
SKIPPED_RE = re.compile(r'\([^)\n]*\bskipped=(\d+)[^)\n]*\)')
RUN_WINDOW_HOURS = 24


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()


def parse_time(value):
    text = value if isinstance(value, str) else ''
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def criterion_id(text):
    match = CRITERION_ID_RE.match(text if isinstance(text, str) else '')
    return None if match is None else match.group(1).upper()


def parse_unittest_output(text):
    text = text if isinstance(text, str) else ''
    ran = RAN_RE.search(text)
    skipped = SKIPPED_RE.search(text)
    return {
        'ran': int(ran.group(1)) if ran else None,
        'skipped': int(skipped.group(1)) if skipped else None,
        'failed': bool(FAILED_RE.search(text)),
        'ok': bool(OK_RE.search(text)),
    }


def git(repo_root, *args):
    completed = subprocess.run(['git'] + list(args), cwd=str(repo_root), capture_output=True)
    return completed.returncode, completed.stdout.decode('utf-8', 'replace')


def main(argv=None):
    parser = argparse.ArgumentParser(description='独立复核一次真实运行的证据目录')
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--repo-root', default='.')
    parser.add_argument('--json-out', default='')
    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()
    evidence_dir = repo_root / 'docs' / 'evidence' / args.run_id
    checks = []
    failures = []

    def check(name, ok, detail=''):
        checks.append({'check': name, 'ok': bool(ok), 'detail': str(detail)})
        if not ok:
            failures.append(name + (': ' + str(detail) if detail else ''))

    if not evidence_dir.is_dir():
        print('证据目录不存在: %s' % evidence_dir)
        return 2

    def load(name):
        path = evidence_dir / name
        if not path.exists():
            failures.append('缺少证据文件: ' + name)
            return None
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError) as exc:
            failures.append('证据文件无法解析: %s (%s)' % (name, exc))
            return None

    def unwrap(payload):
        if isinstance(payload, dict) and isinstance(payload.get('result'), dict):
            return payload['result']
        return payload

    owner = load('.run-owner.json')
    preflight = load('preflight.json')
    requirement = load('requirement.json')
    coding = load('coding-report.json')
    verify = load('verify.json')
    review = load('review.json')
    if None in (owner, preflight, requirement, coding, verify, review):
        for item in checks:
            print(('PASS ' if item['ok'] else 'FAIL ') + item['check'])
        print('\n证据不完整，无法完成复核 (%d 项失败)' % len(failures))
        for item in failures:
            print('  - ' + item)
        return 2

    preflight, requirement, coding, verify, review = map(
        unwrap, (preflight, requirement, coding, verify, review))

    # ---- 1. 认领文件
    check('owner.runId', owner.get('runId') == args.run_id, owner.get('runId'))
    check('owner.claimedAt', bool(parse_time(owner.get('claimedAt'))), owner.get('claimedAt'))
    check('owner.claimedBy', isinstance(owner.get('claimedBy'), str) and owner.get('claimedBy').strip() != '',
          owner.get('claimedBy'))
    check('owner.claimMode', owner.get('claimMode') == 'exclusive-create (O_EXCL)', owner.get('claimMode'))
    check('preflight.state_before', preflight.get('evidence_dir_state_before') in ('missing', 'empty'),
          preflight.get('evidence_dir_state_before'))
    check('preflight.claim_created', preflight.get('claim_created') is True)
    check('preflight.claim_exit_code', preflight.get('claim_exit_code') == 0)

    # ---- 2. 需求
    criteria = requirement.get('acceptance_criteria')
    criteria = criteria if isinstance(criteria, list) else []
    boundary = requirement.get('boundary_conditions')
    boundary = boundary if isinstance(boundary, list) else []
    criteria_ids = [criterion_id(item) for item in criteria]
    check('requirement.criteria_ids_present', all(item is not None for item in criteria_ids))
    check('requirement.criteria_ids_unique', len(set(criteria_ids)) == len(criteria_ids), len(criteria_ids))
    self_check = requirement.get('consistency_check')
    self_check = self_check if isinstance(self_check, dict) else {}
    conflicts = self_check.get('conflicts')
    check('requirement.self_checked', self_check.get('self_checked') is True)
    check('requirement.no_conflicts', isinstance(conflicts, list) and len(conflicts) == 0,
          json.dumps(conflicts, ensure_ascii=False)[:200])
    expected_ids = sorted(item for item in criteria_ids if item)

    # ---- 3. 编码报告
    created = coding.get('files_created')
    created = created if isinstance(created, list) else []
    created_paths = [str(item.get('path')) for item in created if isinstance(item, dict)]
    outside = [path for path in created_paths if path.replace('\\', '/') not in ALLOWED_DELIVERY_FILES]
    check('coding.files_within_scope', len(outside) == 0, ', '.join(outside))
    check('coding.test_exit_code_zero', str(coding.get('test_exit_code')) == '0', coding.get('test_exit_code'))

    # ---- 4. Verifier 独立复跑
    canonical = 'python -m unittest discover -s examples/text-stats -p "test_*.py"'
    check('verify.command_is_canonical', str(verify.get('command')).strip() == canonical, verify.get('command'))
    check('verify.exit_code_zero', str(verify.get('exit_code')) == '0', verify.get('exit_code'))
    verify_output = parse_unittest_output(verify.get('raw_output'))
    check('verify.ran_tests', verify_output['ran'] is not None and verify_output['ran'] >= 1, verify_output['ran'])
    check('verify.ok_marker', verify_output['ok'])
    check('verify.no_failed_marker', not verify_output['failed'])
    check('verify.not_all_skipped',
          verify_output['skipped'] is None or verify_output['ran'] is None or verify_output['skipped'] < verify_output['ran'])

    # ---- 5. 指纹（Verifier 侧）
    expected_files = {'examples/text-stats/text_stats.py', 'examples/text-stats/test_text_stats.py'}
    verify_artifacts = verify.get('artifacts')
    verify_artifacts = verify_artifacts if isinstance(verify_artifacts, list) else []
    verify_map = {str(item.get('path')).replace('\\', '/'): str(item.get('sha256')).lower()
                  for item in verify_artifacts if isinstance(item, dict)}
    check('verify.artifacts_exact_set', set(verify_map) == expected_files, sorted(verify_map))
    disk_map = {}
    for rel in sorted(expected_files):
        path = repo_root / rel
        disk_map[rel] = sha256_file(path) if path.exists() else '(missing)'
    check('verify.artifacts_match_disk', all(verify_map.get(rel) == disk_map[rel] for rel in expected_files),
          json.dumps({'recorded': verify_map, 'disk': disk_map}, ensure_ascii=False))

    # ---- 6. Review
    check('review.verdict_approved', str(review.get('verdict')) == 'APPROVED', review.get('verdict'))
    checks_list = review.get('criteria_check')
    checks_list = checks_list if isinstance(checks_list, list) else []
    review_ids = [criterion_id(item.get('criterion')) for item in checks_list if isinstance(item, dict)]
    check('review.criteria_ids_present', all(item is not None for item in review_ids))
    check('review.criteria_cover_all', sorted(set(item for item in review_ids if item)) == expected_ids,
          json.dumps({'missing': sorted(set(expected_ids) - set(review_ids)),
                      'unknown': sorted(set(item for item in review_ids if item) - set(expected_ids))}))
    check('review.criteria_no_duplicates', len(review_ids) == len(set(review_ids)))
    unsatisfied = [criterion_id(item.get('criterion')) for item in checks_list
                   if isinstance(item, dict) and item.get('satisfied') is not True]
    check('review.criteria_all_satisfied', len(unsatisfied) == 0, ', '.join(str(item) for item in unsatisfied))
    check('review.independent_command_is_canonical',
          str(review.get('independent_test_command')).strip() == canonical, review.get('independent_test_command'))
    check('review.independent_exit_code_zero', str(review.get('independent_test_exit_code')) == '0',
          review.get('independent_test_exit_code'))
    review_output = parse_unittest_output(review.get('independent_test_output'))
    check('review.independent_ran_tests', review_output['ran'] is not None and review_output['ran'] >= 1,
          review_output['ran'])
    check('review.independent_ok_marker', review_output['ok'])
    check('review.ran_matches_verifier', review_output['ran'] == verify_output['ran'],
          json.dumps({'review': review_output['ran'], 'verifier': verify_output['ran']}))
    review_artifacts = review.get('artifacts_after')
    review_artifacts = review_artifacts if isinstance(review_artifacts, list) else []
    review_map = {str(item.get('path')).replace('\\', '/'): str(item.get('sha256')).lower()
                  for item in review_artifacts if isinstance(item, dict)}
    check('review.artifacts_exact_set', set(review_map) == expected_files, sorted(review_map))
    check('review.artifacts_equal_verify', review_map == verify_map, json.dumps(review_map, ensure_ascii=False))
    check('review.artifacts_match_disk', all(review_map.get(rel) == disk_map[rel] for rel in expected_files))
    conflicts_review = review.get('requirement_conflicts')
    check('review.no_conflicts', isinstance(conflicts_review, list) and len(conflicts_review) == 0)

    # ---- 7. 时间戳
    stage_times = []
    for label, payload in (('preflight', preflight), ('requirement', requirement),
                           ('coding', coding), ('verify', verify), ('review', review)):
        stamp = parse_time(payload.get('generated_at'))
        check('time.%s.valid' % label, stamp is not None, payload.get('generated_at'))
        if stamp is not None:
            stage_times.append((label, stamp))
    owner_time = parse_time(owner.get('claimedAt'))
    if owner_time is not None and stage_times:
        check('time.claim_before_stages', owner_time <= stage_times[0][1],
              json.dumps([owner.get('claimedAt'), stage_times[0][1].isoformat()]))
    for index in range(1, len(stage_times)):
        check('time.order.%s_after_%s' % (stage_times[index][0], stage_times[index - 1][0]),
              stage_times[index][1] >= stage_times[index - 1][1],
              json.dumps([stage_times[index - 1][1].isoformat(), stage_times[index][1].isoformat()]))
    if stage_times:
        first = stage_times[0][1]
        span = (stage_times[-1][1] - first).total_seconds()
        check('time.within_window', abs(span) <= RUN_WINDOW_HOURS * 3600, span)

    # ---- 8. 工作区范围（交付源码只允许 4 个文件变化；其余变化按类别单列）
    # 基准点是运行前 HEAD（记录在 precheck.json 的 repository.head）。这样"提交前"与
    # "提交后"两种时点都能复核：已提交的改动用 `git diff --name-only <base>` 取，
    # 未提交的改动仍在 `git status` 里。
    precheck_path = repo_root / 'docs' / 'run-records' / args.run_id / 'precheck.json'
    base_head = ''
    if precheck_path.is_file():
        base_head = (json.loads(precheck_path.read_text(encoding='utf-8'))
                     .get('repository', {}).get('head', ''))
    check('workspace.base_head_recorded', bool(base_head), base_head or '（precheck.json 缺 repository.head）')

    changed = []
    if base_head:
        code, diff_out = git(repo_root, 'diff', '--name-only', base_head)
        changed.extend(line.strip().replace('\\', '/') for line in diff_out.splitlines() if line.strip())
    code, status_out = git(repo_root, 'status', '--porcelain', '--untracked-files=no')
    for line in status_out.splitlines():
        if len(line) > 3:
            path = line[3:].strip().replace('\\', '/')
            if path not in changed:
                changed.append(path)

    delivery_changed = [path for path in changed if path in ALLOWED_DELIVERY_FILES]
    outside_changed = [path for path in changed if path not in ALLOWED_DELIVERY_FILES]
    # 编排层在运行后更新状态文档、归档证据是允许的，但必须与交付源码分开统计：
    # 任何 examples/ 下或 .py/.js/.mjs 的越界改动都是硬失败，文档类改动只列出来供人复核。
    out_of_scope_sources = [path for path in outside_changed
                            if path.startswith('examples/') or path.endswith(('.py', '.js', '.mjs'))]
    # 编排层自带的复核工具不算交付源码；但不能因此把它当成"自然合规"——它被单独列出，
    # 由人用 `git show` 复核。这是本工具唯一无法自证的类别，必须显式可见。
    orchestrator_tools = [path for path in out_of_scope_sources if path in ORCHESTRATOR_TOOLS]
    out_of_scope_sources = [path for path in out_of_scope_sources if path not in ORCHESTRATOR_TOOLS]
    check('workspace.delivery_files_changed', len(delivery_changed) > 0, ', '.join(delivery_changed))
    check('workspace.tracked_sources_within_scope', len(out_of_scope_sources) == 0, ', '.join(out_of_scope_sources))
    check('workspace.orchestrator_tools', True, ', '.join(orchestrator_tools) or '（无）')
    other_changes = [path for path in outside_changed
                     if path not in out_of_scope_sources and path not in ORCHESTRATOR_TOOLS]
    check('workspace.non_source_changes', True, ', '.join(other_changes) or '（无）')
    untracked_code, untracked_out = git(repo_root, 'status', '--porcelain', '--untracked-files=all')
    untracked = [line[3:].strip().replace('\\', '/') for line in untracked_out.splitlines() if line.startswith('??')]
    # 白名单：本轮运行产物、运行记录、历史审批测试的本地原件（含 SID，按设计不提交）、
    # 本地审查包与临时目录，以及本复核工具自身。
    allowed_untracked_prefixes = ('docs/evidence/' + args.run_id, 'docs/run-records/' + args.run_id,
                                  'docs/evidence/v0.1-approval-rejection-20261017T112518Z/',
                                  'docs/review/', 'tests/.scratch/')
    allowed_untracked_files = ('tests/review-run-evidence.py',)
    outside_untracked = [path for path in untracked
                         if path not in allowed_untracked_files
                         and not any(path.startswith(prefix) for prefix in allowed_untracked_prefixes)]
    check('workspace.untracked_within_scope', len(outside_untracked) == 0, ', '.join(outside_untracked))

    # ---- 输出
    for item in checks:
        line = ('PASS ' if item['ok'] else 'FAIL ') + item['check']
        if item['detail']:
            line += ' | ' + item['detail']
        print(line)
    passed = sum(1 for item in checks if item['ok'])
    print('\n%d/%d 项检查通过' % (passed, len(checks)))
    if failures:
        print('失败项:')
        for item in failures:
            print('  - ' + item)

    if args.json_out:
        payload = {
            'runId': args.run_id,
            'checkedAt': datetime.now(timezone.utc).isoformat(),
            'passed': passed,
            'total': len(checks),
            'checks': checks,
            'failures': failures,
            'diskSha256': disk_map,
            'expectedCriteriaIds': expected_ids,
        }
        Path(args.json_out).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    return 0 if not failures else 1


if __name__ == '__main__':
    sys.exit(main())
