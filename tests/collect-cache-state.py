#!/usr/bin/env python3
"""确定性缓存快照工具：只读列出 `<targetDir>/__pycache__` 的指纹，写成 JSON。

为什么需要它（m10329 §一.4）：
- v0.2-run2 每轮都额外启动一个 "Cache Collector" 子代理，只为读一次文件指纹。
  那是**付费模型调用**：它正是 10 次调用超过批准 8 次的直接原因。
- 工作流脚本运行在宿主沙箱里，没有文件系统 API，无法自己读指纹；但"读指纹"本身不需要模型。
  因此把这件事交给确定性本地工具：不调用模型、不联网、不读写凭据。

定位：**事后补充采集**，不参与门禁判定。门禁仍以运行内三个阶段的 `bytecode_scope` 为准；
本工具的价值是把 "Review 返回之后" 那段未观测窗口用确定性证据补上（补不到也不改变运行结论）。

字段口径（必须与编排层 `normalizeCacheEntries` 兼容）：
    entries[].path      仓库内相对路径，正斜杠，例如 examples/text-stats/__pycache__/text_stats.cpython-313.pyc
    entries[].bytes     字节数（整数）
    entries[].mtime_ms  最后写入时间的 Unix 毫秒（整数）
    entries[].sha256    文件原始字节的 sha256（小写十六进制）

退出码：
    0  采集完成（目录不存在也算完成：entries 为空，note 说明原因）
    4  参数错误
    5  IO 错误
    12 目标目录（解算真实路径后）越出仓库根

标准输出是一行 JSON；同时按 `--out` 写到文件（UTF-8 无 BOM、LF）。
"""

import argparse
import datetime
import hashlib
import json
import os
import sys

EXIT_OK = 0
EXIT_USAGE = 4
EXIT_IO = 5
EXIT_OUTSIDE_REPO = 12

CACHE_DIR_NAME = '__pycache__'
TOOL_PATH = 'tests/collect-cache-state.py'


class _Parser(argparse.ArgumentParser):
    """参数错误要有独立退出码：默认的 2 和结论码混在一起就分不清失败原因。"""

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write('error: %s\n' % message)
        raise SystemExit(EXIT_USAGE)


def repo_root_of(start):
    """从 start 向上找 `.git`（目录或文件），找不到就返回 None。"""
    current = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(current, '.git')):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def inside_repo(repo_root, candidate):
    """candidate 的解算真实路径是否落在仓库根之内（含边界相等）。"""
    real_root = os.path.realpath(repo_root)
    real_candidate = os.path.realpath(candidate)
    if real_candidate == real_root:
        return True
    prefix = real_root if real_root.endswith(os.sep) else real_root + os.sep
    return real_candidate.startswith(prefix)


def posix_relative(repo_root, absolute):
    """仓库内相对路径，统一正斜杠（Windows 的反斜杠会让前端比对失败）。"""
    return os.path.relpath(absolute, repo_root).replace(os.sep, '/')


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def collect(repo_root, cache_dir):
    """采集缓存目录清单；目录不存在时返回空清单（不是错误：本来就可能没有缓存）。"""
    if not os.path.isdir(cache_dir):
        return [], '缓存目录不存在：%s' % posix_relative(repo_root, cache_dir)
    entries = []
    names = sorted(os.listdir(cache_dir))
    for name in names:
        absolute = os.path.join(cache_dir, name)
        if not os.path.isfile(absolute) or not name.endswith('.pyc'):
            continue
        stat = os.stat(absolute)
        entries.append({
            'path': posix_relative(repo_root, absolute),
            'bytes': int(stat.st_size),
            'mtime_ms': int(stat.st_mtime_ns // 1000000),
            'sha256': sha256_of(absolute),
        })
    entries.sort(key=lambda item: item['path'])
    if not entries:
        return [], '缓存目录存在但没有 .pyc 文件：%s' % posix_relative(repo_root, cache_dir)
    return entries, '缓存目录存在，列出 %d 个 .pyc 文件' % len(entries)


def main(argv):
    parser = _Parser(description='只读采集 <targetDir>/__pycache__ 的指纹清单（确定性工具，不调用模型）')
    parser.add_argument('--target-dir', default=None,
                        help='仓库内相对的目标目录（采集它下面的 __pycache__），例如 examples/text-stats')
    parser.add_argument('--cache-dir', default=None,
                        help='直接指定缓存目录（仓库内相对路径）；与 --target-dir 二选一')
    parser.add_argument('--repo-root', default=None, help='仓库根（默认从当前目录向上查找 .git）')
    parser.add_argument('--out', default=None, help='把结果 JSON 写到这个文件（UTF-8 无 BOM、LF）')
    parser.add_argument('--pretty', action='store_true', help='输出带缩进的 JSON（默认单行）')
    parser.add_argument('--run-id', default=None,
                        help='运行身份：写进快照，外层判定用它核对"这份快照属于这次运行"')
    parser.add_argument('--snapshot-label', default=None,
                        help='快照用途标签，例如 cache-before / cache-postrun')
    options = parser.parse_args(argv)

    if (options.target_dir is None) == (options.cache_dir is None):
        parser.error('--target-dir 与 --cache-dir 必须且只能给一个')

    repo_root = os.path.abspath(options.repo_root) if options.repo_root else repo_root_of(os.getcwd())
    if repo_root is None or not os.path.isdir(repo_root):
        sys.stderr.write('error: 找不到仓库根（用 --repo-root 指定）\n')
        return EXIT_USAGE

    if options.cache_dir is not None:
        cache_dir = os.path.abspath(os.path.join(repo_root, options.cache_dir))
    else:
        target = os.path.abspath(os.path.join(repo_root, options.target_dir))
        cache_dir = os.path.join(target, CACHE_DIR_NAME)

    if not inside_repo(repo_root, cache_dir):
        sys.stderr.write('error: 缓存目录的解算真实路径越出仓库根：%s\n' % cache_dir)
        return EXIT_OUTSIDE_REPO

    try:
        entries, note = collect(repo_root, cache_dir)
    except OSError as error:
        sys.stderr.write('error: 读取缓存目录失败：%s\n' % error)
        return EXIT_IO

    payload = {
        'collected_at': datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec='seconds'),
        'entries': entries,
        'cache_dir': posix_relative(repo_root, cache_dir),
        'tool': TOOL_PATH,
        'note': note,
        'run_id': options.run_id,
        'snapshot_label': options.snapshot_label,
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2 if options.pretty else None,
                      sort_keys=True)
    if options.out:
        try:
            parent = os.path.dirname(os.path.abspath(options.out))
            if parent and not os.path.isdir(parent):
                os.makedirs(parent)
            with open(options.out, 'w', encoding='utf-8', newline='\n') as handle:
                handle.write(text + '\n')
        except OSError as error:
            sys.stderr.write('error: 写入 %s 失败：%s\n' % (options.out, error))
            return EXIT_IO
    sys.stdout.write(text + '\n')
    return EXIT_OK


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
