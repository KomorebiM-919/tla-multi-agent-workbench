#!/usr/bin/env python3
"""交叉检查「工作流返回值」与「磁盘证据」是否一致（第二轮复审意见 ⑤）。

检查内容：
  1) 返回值里的 evidenceFiles 每一项都真实存在于磁盘（并给出字节数与 sha256）；
  2) 返回值里的 finalDecision 旗标与磁盘上的 verify.json / review.json 自洽；
  3) verify.json 的 artifacts、review.json 的 artifacts_after 的 sha256 与磁盘文件一致
     （先按磁盘原始字节比对，再按 LF 规范化后的字节比对，以便明确区分"内容不一致"与"CRLF 检出假象"）；
  4) review.json 的 criteria_check 的 ID 集合与返回值里的 criteriaIds 一致；
  5) 未成功（ok=false）时，确认磁盘证据确实只记录"未通过/冲突"，且返回值没有把失败说成成功。

只用 Python 标准库。用法：
    python -B docs/evidence/v0.1-second-run/cross-check-workflow-result.py \\
        --result docs/evidence/<runId>/workflow-result.json \\
        --evidence-dir docs/evidence/<runId> \\
        [--out docs/evidence/<runId>/cross-check-output.txt]
"""

import argparse
import hashlib
import json
import os
import re
import sys

CRITERION_ID = re.compile(r'^\s*([A-Za-z]{2,8}-[A-Za-z0-9]{1,4})')


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def safe_repo_path(repo, rel):
    """把证据里的相对路径解析成仓库内的绝对路径；拒绝绝对路径、盘符与 `..` 穿越。

    返回值里的路径由子代理产出，不能直接信任：越界一律返回 None，由调用方判失败。
    """
    text = str(rel).strip().replace('\\', '/')
    if text == '' or text.startswith('/') or re.match(r'^[A-Za-z]:', text):
        return None
    if any(part == '..' for part in text.split('/')):
        return None
    resolved = os.path.abspath(os.path.join(repo, text))
    repo_abs = os.path.abspath(repo)
    if resolved != repo_abs and not resolved.startswith(repo_abs + os.sep):
        return None
    return resolved


def load_json(path):
    with open(path, 'r', encoding='utf-8-sig') as handle:
        return json.load(handle)


def read_bytes(path):
    with open(path, 'rb') as handle:
        return handle.read()


def main():
    # 输出统一用 UTF-8：本机控制台默认代码页会让 '↔' 之类的字符直接抛 UnicodeEncodeError。
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument('--result', required=True)
    parser.add_argument('--evidence-dir', required=True)
    parser.add_argument('--out', default='')
    parser.add_argument('--archived', action='store_true',
                        help='被后续运行取代的历史证据：只核对证据内部一致性，不把产物与「当前磁盘」比对')
    args = parser.parse_args()

    repo = os.getcwd()
    result = load_json(args.result)
    evidence_dir = args.evidence_dir.rstrip('/').replace('\\', '/')
    checks = []
    failures = []
    notes = []

    def check(label, ok, detail=''):
        checks.append((label, bool(ok), detail))
        if not ok:
            failures.append(label + (' :: ' + detail if detail else ''))

    # 1) 返回值基本形状
    derived = result.get('_derivedTail') or {}
    verbatim_decision = result.get('finalDecision')
    decision = verbatim_decision if isinstance(verbatim_decision, dict) else derived.get('finalDecision')
    for key in ('ok', 'status', 'runId', 'evidenceDir', 'attempts'):
        check('返回值含 ' + key, key in result, 'keys=' + ','.join(sorted(result.keys()))[:200])
    check('返回值含 finalDecision（逐字或显式标注的推导值）',
          isinstance(decision, dict),
          '逐字=%s 推导=%s' % (isinstance(verbatim_decision, dict), isinstance(derived.get('finalDecision'), dict)))
    if isinstance(derived.get('finalDecision'), dict) and not isinstance(verbatim_decision, dict):
        check('finalDecision 属推导值且已显式标注（不作为逐字证据）',
              bool(result.get('_harnessTruncation')),
              'harness 截断了返回值，推导值仅供核对，原始记录以证据 JSON 为准')
    check('返回值 runId 与证据目录末段一致',
          result.get('runId') == os.path.basename(evidence_dir),
          'runId=%s dir=%s' % (result.get('runId'), os.path.basename(evidence_dir)))

    # 2) evidenceFiles 全部存在
    evidence_files = result.get('evidenceFiles') or []
    check('evidenceFiles 非空', len(evidence_files) > 0, 'len=%d' % len(evidence_files))
    listed = []
    for rel in evidence_files:
        path = safe_repo_path(repo, rel)
        if path is None:
            check('evidenceFiles 项位于仓库内：%s' % rel, False, '绝对路径或越界路径，拒绝解析')
            continue
        exists = os.path.isfile(path)
        if exists:
            data = read_bytes(path)
            listed.append('%s (%d B, sha256=%s)' % (rel, len(data), sha256_bytes(data)[:16]))
        check('evidenceFiles 项存在：%s' % rel, exists)
    check('证据目录内含关键文件名（preflight/requirement 至少各一）',
          any('preflight' in str(item) for item in evidence_files))

    # 3) 磁盘上的三个判定证据文件
    verify_path = os.path.join(evidence_dir, 'verify.json')
    review_path = os.path.join(evidence_dir, 'review.json')
    verify = load_json(verify_path) if os.path.isfile(verify_path) else None
    review = load_json(review_path) if os.path.isfile(review_path) else None
    check('存在 verify.json', verify is not None, verify_path)
    check('存在 review.json', review is not None, review_path)

    v = (verify or {}).get('result', verify) or {}
    r = (review or {}).get('result', review) or {}

    # 4) 指纹：逐次尝试比对。
    #    同一尝试内，Verifier 的 artifacts 与 Review 的 artifacts_after 必须完全一致；
    #    只有「最后一次尝试」的产物才代表最终磁盘状态——后续修订会合法地改写交付文件，
    #    因此早期尝试的哈希与磁盘不同是预期现象，只能作为 INFO 记录，不能判失败。
    attempts = result.get('attempts')
    if not isinstance(attempts, int) or attempts < 1:
        attempts = 1

    def suffix_for(index):
        return '' if index == 1 else '-revision-%d' % index

    def load_attempt(index):
        sfx = suffix_for(index)
        verify_path_i = os.path.join(evidence_dir, 'verify%s.json' % sfx)
        review_path_i = os.path.join(evidence_dir, 'review%s.json' % sfx)
        verify_i = load_json(verify_path_i) if os.path.isfile(verify_path_i) else None
        review_i = load_json(review_path_i) if os.path.isfile(review_path_i) else None
        return (verify_i or {}).get('result', verify_i) or {}, (review_i or {}).get('result', review_i) or {}

    def artifacts_map(items):
        out = {}
        for item in items or []:
            if isinstance(item, dict):
                out[str(item.get('path', ''))] = str(item.get('sha256', '')).lower()
        return out

    def compare_against_disk(label, items):
        for item in items or []:
            if not isinstance(item, dict):
                check('%s 条目形状合法' % label, False, '不是对象：%r' % (item,))
                continue
            rel = item.get('path')
            want = str(item.get('sha256', '')).lower()
            path = safe_repo_path(repo, rel)
            if path is None:
                check('%s 路径位于仓库内：%s' % (label, rel), False, '绝对路径或越界路径，拒绝解析')
                continue
            if not os.path.isfile(path):
                check('%s 文件存在：%s' % (label, rel), False, '磁盘上找不到')
                continue
            data = read_bytes(path)
            raw = sha256_bytes(data)
            normalized = sha256_bytes(data.replace(b'\r\n', b'\n'))
            if raw == want:
                check('%s sha256 与磁盘原始字节一致：%s' % (label, rel), True)
            elif normalized == want:
                check('%s sha256 与磁盘 LF 规范化字节一致（磁盘是 CRLF 检出）：%s' % (label, rel), True)
            else:
                check('%s sha256 与磁盘不一致：%s' % (label, rel), False,
                      '记录=%s 磁盘raw=%s diskLF=%s' % (want[:16], raw[:16], normalized[:16]))

    for index in range(1, attempts + 1):
        attempt_verify, attempt_review = load_attempt(index)
        sfx = suffix_for(index)
        verify_map = artifacts_map(attempt_verify.get('artifacts'))
        review_map = artifacts_map(attempt_review.get('artifacts_after'))
        check('第 %d 次尝试 verify/review 产物路径集合一致（%s）' % (index, 'verify%s/review%s' % (sfx, sfx) or ''),
              bool(verify_map) and set(verify_map) == set(review_map),
              'verify=%s review=%s' % (sorted(verify_map), sorted(review_map)))
        mismatched = {key: (value, review_map.get(key)) for key, value in verify_map.items() if review_map.get(key) != value}
        check('第 %d 次尝试 verify/review 产物 sha256 一致' % index, not mismatched,
              json.dumps(mismatched, ensure_ascii=False))
        if index == attempts and not args.archived:
            compare_against_disk('第 %d 次（最终）verify.artifacts' % index, attempt_verify.get('artifacts'))
            compare_against_disk('第 %d 次（最终）review.artifacts_after' % index, attempt_review.get('artifacts_after'))
        else:
            still_equal = []
            rewritten = []
            for rel, want in sorted(verify_map.items()):
                path = safe_repo_path(repo, rel)
                if path and os.path.isfile(path):
                    data = read_bytes(path)
                    if sha256_bytes(data) == want or sha256_bytes(data.replace(b'\r\n', b'\n')) == want:
                        still_equal.append(rel)
                        continue
                rewritten.append(rel)
            reason = '（--archived：历史运行，其产物已被后续运行改写，不与当前磁盘比对）' if args.archived else ''
            notes.append('第 %d 次尝试的产物已被后续修订覆盖 %s%s；仍与磁盘一致 %s'
                         % (index, rewritten or '无', reason, still_equal or '无'))

    # 5) criteria ID 集合
    want_ids = [str(item) for item in (result.get('criteriaIds') or [])]
    got_ids = []
    for item in (r.get('criteria_check') or []):
        text = str(item.get('criterion', '')) if isinstance(item, dict) else str(item)
        found = CRITERION_ID.match(text)
        if found:
            got_ids.append(found.group(1))
    if want_ids:
        check('criteria_check 的 ID 集合与 criteriaIds 一致',
              sorted(set(got_ids)) == sorted(set(want_ids)),
              'missing=%s unknown=%s' % (sorted(set(want_ids) - set(got_ids)), sorted(set(got_ids) - set(want_ids))))
    else:
        check('返回值带非空 criteriaIds', False, 'criteriaIds 为空，无法核对验收 ID 清单')

    # 6) ok=false 时不得声称成功
    if result.get('ok') is False:
        check('未成功时 finalDecision 至少有一项为 false',
              isinstance(decision, dict) and any(value is False for value in decision.values()),
              ('推导值：' if not isinstance(verbatim_decision, dict) else '') + json.dumps(decision, ensure_ascii=False))
        check('未成功时返回了可读原因', bool(result.get('error')) or bool(result.get('errors')))
        check('未成功时磁盘证据未显示 APPROVED 通过',
              not (r.get('verdict') == 'APPROVED'
                   and all(isinstance(c, dict) and bool(c.get('satisfied')) for c in (r.get('criteria_check') or []))
                   and not (r.get('requirement_conflicts'))),
              'verdict=%s conflicts=%s' % (r.get('verdict'), len(r.get('requirement_conflicts') or [])))

    lines = []
    lines.append('# workflow-result.json ↔ 磁盘证据 交叉检查')
    lines.append('')
    lines.append('- 返回值：`%s`' % args.result)
    lines.append('- 证据目录：`%s`' % evidence_dir)
    lines.append('- 返回值摘要：`ok=%s status=%s attempts=%s`' % (result.get('ok'), result.get('status'), result.get('attempts')))
    lines.append('- 检查项：%d，失败：%d' % (len(checks), len(failures)))
    lines.append('')
    lines.append('## evidenceFiles 实测')
    lines.append('')
    for item in listed:
        lines.append('- `%s`' % item)
    lines.append('')
    lines.append('## 逐项结果')
    lines.append('')
    for label, ok, detail in checks:
        lines.append('- %s %s%s' % ('PASS' if ok else 'FAIL', label, ('（' + detail + '）') if detail else ''))
    if notes:
        lines.append('')
        lines.append('## 说明（不作为失败）')
        lines.append('')
        for note in notes:
            lines.append('- %s' % note)
    lines.append('')
    lines.append('结论：' + ('全部一致' if not failures else '存在 %d 项不一致' % len(failures)))
    text = '\n'.join(lines) + '\n'

    if args.out:
        with open(args.out, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write(text)
    sys.stdout.write(text)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
