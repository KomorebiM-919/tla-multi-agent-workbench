#!/usr/bin/env python3
"""外层缓存边界判定（确定性工具，不调用任何模型、不启动子代理）。

为什么需要它：工作流脚本没有文件系统 API，它能看到的最远一个缓存观测点是
Review Agent 自报的"执行后清单"。Review 返回之后、外层测试/导入开始之前的写入，
工作流自己看不见。所以工作流内部的 `ok: true` 只能叫"运行内暂定结果"。

本工具把三样东西串成一条时间线后判定：
  1. 运行前基线（任何子代理启动之前，由 tests/collect-cache-state.py 采集）；
  2. 各阶段自报的观测点（证据目录里各 JSON 的 bytecode_scope.entries_before/after）；
  3. 运行后快照（最后一个子代理结束后、其他测试或导入开始之前采集的 cache-postrun.json）。

任何一个观测点之间出现"新增 / 删除 / 内容变化 / 超出容差的 mtime 变化"，都不给完整通过；
最终快照缺失、读取失败、路径或运行身份不符，判 INCOMPLETE（不完整 ≠ 通过）。

退出码：0 = CLEAN；10 = NOT_CLEAN；11 = INCOMPLETE；4 = 参数错误；5 = IO 错误。
"""

import argparse
import datetime
import hashlib
import io
import json
import os
import sys

TOOL = 'tests/verify-cache-boundary.py'
TOOL_VERSION = '1.0.0'
# 只吸收"同一时间戳的整数/浮点毫秒表示差"；真实重写的时间差远大于它。
MTIME_TOLERANCE_MS = 5
EXIT_OK = 0
EXIT_NOT_CLEAN = 10
EXIT_INCOMPLETE = 11
EXIT_USAGE = 4
EXIT_IO = 5
# 与编排层的同一判据保持字面一致：内容身份优先，mtime 只作容差比较。
OBSERVATION_KEYS = ('path', 'bytes', 'mtime_ms', 'sha256')


class SnapshotError(Exception):
    """快照不可用：缺失、读不出来、结构不对、身份不符。"""


def utcnow_iso():
    return datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec='seconds')


def parse_time(value):
    """解析 ISO-8601；解析不了返回 None（不猜时间）。"""
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    try:
        return datetime.datetime.fromisoformat(text)
    except ValueError:
        return None


def is_hex64(value):
    if not isinstance(value, str) or len(value) != 64:
        return False
    return all(char in '0123456789abcdef' for char in value.lower())


def validate_entries(raw, cache_dir, label):
    """校验一份清单：路径相对、位于同一缓存目录、字段完整；不合格就抛 SnapshotError。"""
    if not isinstance(raw, list):
        raise SnapshotError('%s 的 entries 不是数组' % label)
    seen = {}
    normalized = []
    for index, item in enumerate(raw):
        where = '%s 的第 %d 个条目' % (label, index + 1)
        if not isinstance(item, dict):
            raise SnapshotError('%s 不是对象' % where)
        missing = [key for key in OBSERVATION_KEYS if key not in item]
        if missing:
            raise SnapshotError('%s 缺少字段：%s' % (where, ', '.join(missing)))
        path = item['path']
        if not isinstance(path, str) or not path:
            raise SnapshotError('%s 的 path 不可用：%r' % (where, path))
        posix = path.replace('\\', '/')
        if posix.startswith('/') or ':' in posix.split('/')[0]:
            raise SnapshotError('%s 的 path 是绝对路径：%s' % (where, path))
        if '..' in posix.split('/'):
            raise SnapshotError('%s 的 path 含 ..：%s' % (where, path))
        if not posix.startswith(cache_dir.rstrip('/') + '/'):
            raise SnapshotError('%s 的 path 不在缓存目录 %s 下：%s' % (where, cache_dir, path))
        if not isinstance(item['bytes'], int) or isinstance(item['bytes'], bool) or item['bytes'] < 0:
            raise SnapshotError('%s 的 bytes 不是非负整数：%r' % (where, item['bytes']))
        if not isinstance(item['mtime_ms'], int) or isinstance(item['mtime_ms'], bool):
            raise SnapshotError('%s 的 mtime_ms 不是整数毫秒：%r' % (where, item['mtime_ms']))
        if not is_hex64(item['sha256']):
            raise SnapshotError('%s 的 sha256 不是 64 位十六进制' % where)
        if posix in seen:
            raise SnapshotError('%s 出现重复路径：%s' % (label, posix))
        seen[posix] = True
        normalized.append({
            'path': posix,
            'bytes': item['bytes'],
            'mtime_ms': item['mtime_ms'],
            'sha256': item['sha256'].lower(),
        })
    normalized.sort(key=lambda entry: entry['path'])
    return normalized


def load_snapshot(path, label, run_id, cache_dir):
    """读一份快照并核对身份；任何不确定都抛 SnapshotError（不降级为"通过"）。"""
    if not path:
        raise SnapshotError('%s 的路径没有给出' % label)
    absolute = os.path.abspath(path)
    if not os.path.isfile(absolute):
        raise SnapshotError('%s 不存在：%s' % (label, path))
    try:
        with io.open(absolute, encoding='utf-8') as handle:
            payload = json.load(handle)
    except (OSError, ValueError) as error:
        raise SnapshotError('%s 读取失败：%s' % (label, error))
    if not isinstance(payload, dict):
        raise SnapshotError('%s 的顶层不是 JSON 对象' % label)
    snapshot_run = payload.get('run_id')
    if snapshot_run is not None and snapshot_run != run_id:
        raise SnapshotError('%s 的运行身份不符：快照属于 %r，本次是 %r' % (label, snapshot_run, run_id))
    snapshot_cache = payload.get('cache_dir')
    if not isinstance(snapshot_cache, str) or not snapshot_cache:
        raise SnapshotError('%s 没有 cache_dir：无法确认路径身份' % label)
    if snapshot_cache.replace('\\', '/').rstrip('/') != cache_dir.rstrip('/'):
        raise SnapshotError('%s 的缓存路径不符：快照是 %s，本次是 %s' % (label, snapshot_cache, cache_dir))
    entries = validate_entries(payload.get('entries'), cache_dir, label)
    return {
        'label': label,
        'path': path,
        'run_id': snapshot_run,
        'cache_dir': snapshot_cache,
        'collected_at': payload.get('collected_at'),
        'tool': payload.get('tool'),
        'snapshot_label': payload.get('snapshot_label'),
        'entries': entries,
    }


def find_stage_observations(evidence_dir, skip_paths):
    """从证据 JSON 里抽取各阶段的 entries_before / entries_after（按 generated_at 排序）。"""
    observations = []
    problems = []
    if not os.path.isdir(evidence_dir):
        return observations, ['证据目录不存在：%s' % evidence_dir]
    skip = set(os.path.abspath(item) for item in skip_paths if item)
    for name in sorted(os.listdir(evidence_dir)):
        if not name.endswith('.json'):
            continue
        path = os.path.join(evidence_dir, name)
        if os.path.abspath(path) in skip:
            continue
        try:
            with io.open(path, encoding='utf-8') as handle:
                payload = json.load(handle)
        except (OSError, ValueError) as error:
            problems.append('证据文件读不出来（%s）：%s' % (name, error))
            continue
        for scope, where in iter_scopes(payload):
            stage = {
                'file': name,
                'where': where,
                'generated_at': payload.get('generated_at') if isinstance(payload, dict) else None,
                'cache_dir': scope.get('cache_dir'),
                'env_applied': scope.get('env_applied'),
                'entries_before': scope.get('entries_before'),
                'entries_after': scope.get('entries_after'),
            }
            observations.append(stage)
    observations.sort(key=lambda item: (parse_time(item['generated_at']) or datetime.datetime.min.replace(
        tzinfo=datetime.timezone.utc), item['file'], item['where']))
    return observations, problems


def iter_scopes(payload, depth=0):
    """递归找 bytecode_scope（有的阶段把它放在 result 信封里，有的放在顶层）。"""
    if depth > 3 or not isinstance(payload, dict):
        return
    scope = payload.get('bytecode_scope')
    if isinstance(scope, dict) and 'entries_before' in scope and 'entries_after' in scope:
        yield scope, 'bytecode_scope'
        return
    for value in payload.values():
        if isinstance(value, dict):
            for item in iter_scopes(value, depth + 1):
                yield item


def compare_points(earlier, later, tolerance_ms):
    """比较两个观测点：返回违规列表（空列表 = 一致）。"""
    violations = []
    before = {entry['path']: entry for entry in earlier['entries']}
    after = {entry['path']: entry for entry in later['entries']}
    for path in sorted(set(before) - set(after)):
        violations.append({
            'kind': 'removed', 'path': path,
            'from': earlier['label'], 'to': later['label'],
            'detail': '缓存文件在运行期消失',
        })
    for path in sorted(set(after) - set(before)):
        violations.append({
            'kind': 'created', 'path': path,
            'from': earlier['label'], 'to': later['label'],
            'detail': '运行期出现新的缓存文件',
        })
    for path in sorted(set(before) & set(after)):
        old = before[path]
        new = after[path]
        if old['bytes'] != new['bytes'] or old['sha256'] != new['sha256']:
            violations.append({
                'kind': 'content_changed', 'path': path,
                'from': earlier['label'], 'to': later['label'],
                'detail': '内容身份变化：%d B/%s → %d B/%s' % (
                    old['bytes'], old['sha256'][:12], new['bytes'], new['sha256'][:12]),
            })
            continue
        delta = abs(new['mtime_ms'] - old['mtime_ms'])
        if delta > tolerance_ms:
            violations.append({
                'kind': 'mtime_changed', 'path': path,
                'from': earlier['label'], 'to': later['label'],
                'detail': '内容相同但 mtime 相差 %d 毫秒（容差 %d）' % (delta, tolerance_ms),
            })
    return violations


def run(argv):
    parser = argparse.ArgumentParser(
        description='外层缓存边界判定（确定性工具，不调用模型）：基线 + 阶段观测点 + 运行后快照')
    parser.add_argument('--run-id', required=True, help='运行 id；必须与两份快照里的 run_id 一致')
    parser.add_argument('--evidence-dir', required=True, help='证据目录（含各阶段 JSON）')
    parser.add_argument('--baseline', required=True, help='运行前基线快照（cache-before.json）')
    parser.add_argument('--postrun', required=True, help='运行后快照（cache-postrun.json）')
    parser.add_argument('--target-dir', default=None, help='目标目录（默认从快照的 cache_dir 推断）')
    parser.add_argument('--tolerance-ms', type=int, default=MTIME_TOLERANCE_MS,
                        help='mtime 表示精度容差（默认 %d 毫秒）' % MTIME_TOLERANCE_MS)
    parser.add_argument('--out', required=True, help='判定结果 JSON 的输出路径')
    parser.add_argument('--pretty', action='store_true', help='输出带缩进的 JSON')
    options = parser.parse_args(argv)

    if options.tolerance_ms < 0:
        parser.error('--tolerance-ms 不能为负')

    checks = []
    problems = []
    violations = []
    timeline = []

    def check(name, ok, detail):
        checks.append({'check': name, 'ok': bool(ok), 'detail': detail})
        if not ok:
            problems.append('%s：%s' % (name, detail))
        return bool(ok)

    cache_dir = None
    try:
        baseline_probe = None
        try:
            with io.open(os.path.abspath(options.baseline), encoding='utf-8') as handle:
                baseline_probe = json.load(handle)
        except (OSError, ValueError):
            baseline_probe = None
        if isinstance(baseline_probe, dict) and isinstance(baseline_probe.get('cache_dir'), str):
            cache_dir = baseline_probe['cache_dir'].replace('\\', '/').rstrip('/')
        if not cache_dir and options.target_dir:
            cache_dir = options.target_dir.replace('\\', '/').rstrip('/') + '/__pycache__'
        if not cache_dir:
            raise SnapshotError('无法确定缓存目录：基线里没有 cache_dir，也没有给 --target-dir')

        baseline = load_snapshot(options.baseline, '运行前基线', options.run_id, cache_dir)
        postrun = load_snapshot(options.postrun, '运行后快照', options.run_id, cache_dir)
        check('baseline_present', True, '运行前基线可读，%d 个条目' % len(baseline['entries']))
        check('postrun_present', True, '运行后快照可读，%d 个条目' % len(postrun['entries']))
        check('run_identity', baseline['run_id'] == options.run_id and postrun['run_id'] == options.run_id,
              '基线 run_id=%r，快照 run_id=%r，本次 %r' % (baseline['run_id'], postrun['run_id'], options.run_id))
    except SnapshotError as error:
        payload = {
            'schemaVersion': 1,
            'tool': TOOL,
            'toolVersion': TOOL_VERSION,
            'generated_at': utcnow_iso(),
            'run_id': options.run_id,
            'status': 'INCOMPLETE',
            'statusMeaning': '证据不完整：不能给出完整通过，也不能当作通过',
            'tolerance_ms': options.tolerance_ms,
            'cache_dir': cache_dir,
            'inputs': {'baseline': options.baseline, 'postrun': options.postrun,
                       'evidence_dir': options.evidence_dir},
            'checks': checks + [{'check': 'snapshot_available', 'ok': False, 'detail': str(error)}],
            'problems': problems + [str(error)],
            'violations': [],
            'timeline': [],
            'coverage': {
                'observedWindows': [],
                'unobservedWindow': '两次采集点之间的写入；采集点之间的瞬时写入不可观测',
            },
        }
        write_payload(payload, options)
        return EXIT_INCOMPLETE

    stages, stage_problems = find_stage_observations(options.evidence_dir, [options.baseline, options.postrun])
    for item in stage_problems:
        problems.append(item)
    check('stage_observations_found', len(stages) > 0,
          '证据里找到 %d 个阶段观测点' % len(stages))

    earlier_point = {
        'label': '运行前基线（外层采集）',
        'source': os.path.basename(options.baseline),
        'collected_at': baseline['collected_at'],
        'entries': baseline['entries'],
    }
    timeline.append(earlier_point)
    stage_usable = True
    for stage in stages:
        for side in ('entries_before', 'entries_after'):
            label = '%s %s（%s）' % (stage['file'], '执行前' if side == 'entries_before' else '执行后', stage['where'])
            try:
                entries = validate_entries(stage[side], cache_dir, label)
            except SnapshotError as error:
                stage_usable = False
                problems.append('阶段观测点不可用：%s' % error)
                continue
            point = {
                'label': label,
                'source': stage['file'],
                'collected_at': stage['generated_at'],
                'env_applied': stage['env_applied'],
                'entries': entries,
            }
            timeline.append(point)
            violations.extend(compare_points(earlier_point, point, options.tolerance_ms))
            earlier_point = point

    final_point = {
        'label': '运行后快照（外层采集）',
        'source': os.path.basename(options.postrun),
        'collected_at': postrun['collected_at'],
        'entries': postrun['entries'],
    }
    timeline.append(final_point)
    violations.extend(compare_points(earlier_point, final_point, options.tolerance_ms))

    postrun_time = parse_time(postrun['collected_at'])
    last_stage_time = parse_time(earlier_point['collected_at'])
    if postrun_time is not None and last_stage_time is not None:
        check('postrun_after_last_observation', postrun_time >= last_stage_time,
              '快照采集时间 %s，最后一个观测点 %s' % (postrun['collected_at'], earlier_point['collected_at']))
    else:
        check('postrun_after_last_observation', False, '时间戳不可解析，无法确认快照晚于最后一个观测点')

    check('stage_observations_usable', stage_usable, '每个阶段观测点都能解析出合法条目')
    check('no_violations', len(violations) == 0, '观测点之间的差异：%d 条' % len(violations))

    if not stage_usable or not all(item['ok'] for item in checks if item['check'] != 'no_violations'):
        status = 'INCOMPLETE'
        meaning = '证据不完整：不能给出完整通过，也不能当作通过'
    elif violations:
        status = 'NOT_CLEAN'
        meaning = '不完整通过不得给出：运行期缓存出现新增/删除/内容变化/超容差 mtime 变化'
    else:
        status = 'CLEAN'
        meaning = '所有观测点一致：运行期没有观察到缓存写入（不可观测窗口见 coverage）'

    payload = {
        'schemaVersion': 1,
        'tool': TOOL,
        'toolVersion': TOOL_VERSION,
        'generated_at': utcnow_iso(),
        'run_id': options.run_id,
        'status': status,
        'statusMeaning': meaning,
        'tolerance_ms': options.tolerance_ms,
        'cache_dir': cache_dir,
        'inputs': {'baseline': options.baseline, 'postrun': options.postrun,
                   'evidence_dir': options.evidence_dir},
        'checks': checks,
        'problems': problems,
        'violations': violations,
        'timeline': [{
            'label': point['label'],
            'source': point['source'],
            'collected_at': point['collected_at'],
            'entries': point['entries'],
            'sha256': sha256_of_entries(point['entries']),
        } for point in timeline],
        'coverage': {
            'observedWindows': [point['label'] for point in timeline],
            'unobservedWindow': '两次采集点之间的写入；采集点之间"写完又改回原样且 mtime 变化不超过 %d 毫秒"的瞬时写入不可观测'
                                % options.tolerance_ms,
            'usesModelCalls': False,
        },
    }
    write_payload(payload, options)

    if status == 'CLEAN':
        return EXIT_OK
    if status == 'NOT_CLEAN':
        return EXIT_NOT_CLEAN
    return EXIT_INCOMPLETE


def sha256_of_entries(entries):
    """给时间线每个观测点一个内容指纹，便于人工复核"是不是同一份清单"。"""
    canonical = json.dumps(entries, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def write_payload(payload, options):
    text = json.dumps(payload, ensure_ascii=False, indent=2 if options.pretty else None, sort_keys=True)
    parent = os.path.dirname(os.path.abspath(options.out))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent)
    with io.open(options.out, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(text + '\n')
    summary = '%s: %s' % (payload['status'], payload['statusMeaning'])
    sys.stdout.write('缓存边界判定：%s\n' % summary)
    if payload['violations']:
        for item in payload['violations']:
            sys.stdout.write('  - %s %s（%s → %s）：%s\n' % (
                item['kind'], item['path'], item['from'], item['to'], item['detail']))
    for item in payload['problems']:
        sys.stdout.write('  问题：%s\n' % item)


def main(argv):
    try:
        return run(argv)
    except OSError as error:
        sys.stderr.write('error: %s\n' % error)
        return EXIT_IO


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
