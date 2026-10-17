#!/usr/bin/env python3
"""独立复核 v0.2 需求（R-01 – R-37）在交付实现里的可观察行为。

与交付测试套件**互相独立**：本工具从需求原文重新推导期望值，不导入
`examples/text-stats/test_text_stats.py`，也不复用它的断言表；它只观察交付实现
（`examples/text-stats/text_stats.py`）和命令行行为。

用法:
    python tests/probe-text-stats-requirement.py [--repo-root .] [--json-out <path>]

输出: 每个检查一行 `PASS/FAIL <criterion> <name> ...`，最后一行汇总。
退出码: 0 = 全部通过; 1 = 有失败。
"""

import argparse
import hashlib
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

TARGET_DIR = 'examples/text-stats'
MODULE_FILE = 'text_stats.py'
SAMPLE_TEXT = 'hello world\nfoo bar\n'
STAT_KEYS = ['char_count', 'line_count', 'non_empty_line_count', 'word_count']


class _NoReadStdin(io.StringIO):
    def read(self, *args, **kwargs):
        raise AssertionError('programmatic call must not read process stdin')

    def readline(self, *args, **kwargs):
        raise AssertionError('programmatic call must not read process stdin')


def load_module(path):
    spec = importlib.util.spec_from_file_location('probed_text_stats', str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def call_programmatic(module, argv, stdin_text=''):
    out, err = io.StringIO(), io.StringIO()
    saved = sys.stdin
    sys.stdin = _NoReadStdin()
    try:
        with redirect_stdout(out), redirect_stderr(err):
            passed = list(argv) if argv is not None else None
            code = module.main(passed, stdin_text=stdin_text)
    finally:
        sys.stdin = saved
    return code, out.getvalue(), err.getvalue()


def run_cli(repo, argv, stdin_bytes=b''):
    completed = subprocess.run(
        [sys.executable, MODULE_FILE] + list(argv),
        cwd=str(repo / TARGET_DIR), input=stdin_bytes,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    return completed.returncode, completed.stdout, completed.stderr


class Probe:
    def __init__(self):
        self.results = []

    def check(self, criterion, name, ok, detail=''):
        self.results.append({'criterion': criterion, 'name': name, 'ok': bool(ok), 'detail': str(detail)[:300]})

    def equal(self, criterion, name, actual, expected):
        self.check(criterion, name, actual == expected, 'actual=%r expected=%r' % (actual, expected))


def probe_text_layer(module, probe):
    textual_cases = [
        ('AC-04', 'reference_text', SAMPLE_TEXT, (20, 2, 2, 4)),
        ('AC-05', 'whitespace_only_lines', '  \r\n \r\n', (5, 2, 0, 0)),
        ('AC-17', 'crlf_pair', 'a\r\nb', (3, 2, 2, 2)),
        ('AC-17', 'latin1_accent', 'caf\u00e9', (4, 1, 1, 1)),
        ('AC-17', 'combining_accent', 'cafe\u0301', (5, 1, 1, 1)),
        ('BC-08', 'code_points_not_bytes', '\u4f60\u597d', (2, 1, 1, 0)),
        ('AC-14', 'single_bom', '\ufeffabc', (3, 1, 1, 1)),
        ('AC-14', 'double_bom', '\ufeff\ufeffabc', (4, 1, 1, 1)),
        ('BC-03', 'bom_twice_not_blank', '\ufeff\ufeff', (1, 1, 1, 0)),
        ('BC-01', 'line_separator_u2028', 'a\u2028b', (3, 1, 1, 2)),
        ('BC-01', 'paragraph_separator_u2029', 'a\u2029b', (3, 1, 1, 2)),
        ('BC-01', 'vertical_tab_is_not_a_break', 'a\x0bb', (3, 1, 1, 2)),
        ('BC-01', 'form_feed_is_not_a_break', 'a\x0cb', (3, 1, 1, 2)),
        ('BC-01', 'next_line_85_is_not_a_break', 'a\x85b', (3, 1, 1, 2)),
        ('BC-02', 'lone_cr_becomes_lf', 'a\rb', (3, 2, 2, 2)),
        ('BC-02', 'crlf_then_lone_cr', 'a\r\nb\rc', (5, 3, 3, 3)),
        ('AC-15', 'empty_text', '', (0, 0, 0, 0)),
        ('AC-15', 'only_lf', '\n', (1, 1, 0, 0)),
        ('AC-15', 'single_char', 'a', (1, 1, 1, 1)),
        ('AC-15', 'trailing_lf', 'a\n', (2, 1, 1, 1)),
        ('AC-15', 'trailing_two_lf', 'a\n\n', (3, 2, 1, 1)),
        ('AC-15', 'two_lines', 'a\nb', (3, 2, 2, 2)),
        ('BC-04', 'two_trailing_breaks', 'hello world\nfoo bar\n\n', (21, 3, 2, 4)),
        ('BC-05', 'blank_and_tab_lines', '  \n\t\n', (5, 2, 0, 0)),
        ('BC-06', 'non_empty_from_same_split', 'a\n\nb\n', (5, 3, 2, 2)),
        ('BC-07', 'ideographic_space_is_blank', '\u3000\n', (2, 1, 0, 0)),
        ('BC-07', 'nbsp_is_blank', '\u00a0\n', (2, 1, 0, 0)),
        ('BC-27', 'nbsp_and_ideographic_preserved', 'a\u00a0b\u3000c', (5, 1, 1, 3)),
        ('AC-18', 'basic_words', 'hello world', (11, 1, 1, 2)),
        ('AC-18', 'case_insensitive_count_separate', 'Hello hello HELLO', (17, 1, 1, 3)),
        ('AC-18', 'hyphenated', 'well-known', (10, 1, 1, 1)),
        ('AC-18', 'apostrophe', "don't", (5, 1, 1, 1)),
        ('AC-18', 'typographic_apostrophe', 'it\u2019s', (4, 1, 1, 1)),
        ('AC-18', 'double_hyphen_splits', 'hello--world', (12, 1, 1, 2)),
        ('AC-18', 'triple_hyphen_single_word', 'a-b-c', (5, 1, 1, 1)),
        ('AC-19', 'digits_only', '123 456', (7, 1, 1, 0)),
        ('AC-19', 'digits_split', 'abc123', (6, 1, 1, 1)),
        ('AC-19', 'digits_inside', 'a1b', (3, 1, 1, 2)),
        ('AC-19', 'underscore_splits', 'a_b', (3, 1, 1, 2)),
        ('AC-19', 'underscore_mixed', 'foo_bar baz', (11, 1, 1, 3)),
        ('AC-20', 'non_ascii_single', 'caf\u00e9', (4, 1, 1, 1)),
        ('AC-20', 'non_ascii_splits', 'caf\u00e9-mocha', (10, 1, 1, 2)),
        ('AC-21', 'leading_space_hyphen', ' -abc', (5, 1, 1, 1)),
        ('AC-21', 'trailing_space_hyphen', 'abc- ', (5, 1, 1, 1)),
        ('BC-09', 'quote_prefix', "'abc", (4, 1, 1, 1)),
        ('BC-12', 'combining_never_two_words', 'cafe\u0301', (5, 1, 1, 1)),
    ]
    for criterion, name, text, expected in textual_cases:
        result = module.count_text(text)
        keys = sorted(result) if isinstance(result, dict) else result
        probe.check(criterion, name + '.keys', keys == STAT_KEYS, 'actual_keys=%r' % (keys,))
        actual = tuple(result.get(key) for key in STAT_KEYS) if isinstance(result, dict) else None
        probe.equal(criterion, name + '.values', actual, expected)
        probe.check(criterion, name + '.types',
                    isinstance(result, dict) and all(
                        isinstance(result[key], int) and not isinstance(result[key], bool) for key in STAT_KEYS),
                    '%r' % (result,))


def probe_programmatic(module, repo, probe):
    code, out, err = call_programmatic(module, [])
    probe.equal('AC-01', 'empty_text_exit', (code, out, err), (0, '', ''))
    probe.check('AC-01', 'empty_text_exit_int', isinstance(code, int) and not isinstance(code, bool), type(code).__name__)

    example = ('import text_stats as t; code = t.main([], stdin_text=""); '
               'print(callable(t.main), code, type(code).__name__)')
    completed = subprocess.run([sys.executable, '-c', example], cwd=str(repo / TARGET_DIR),
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    probe.equal('AC-02', 'documented_one_liner',
                (completed.returncode, completed.stdout.decode().splitlines(), completed.stderr.decode()),
                (0, ['True 0 int'], ''))

    code, out, err = call_programmatic(module, ['--help'])
    probe.equal('AC-09', 'programmatic_help', (code, out, err), (0, '', ''))
    probe.check('AC-09', 'programmatic_help_has_no_usage', 'usage' not in out.lower(), out[:80])

    for name, argv in (('missing_file', ['missing-file.txt']),
                       ('unknown_encoding_no_path', ['--encoding', 'no-such-codec']),
                       ('two_positional', ['a.txt', 'b.txt']),
                       ('directory_path', [TARGET_DIR])):
        code, out, err = call_programmatic(module, argv)
        probe.equal('AC-12', 'programmatic_' + name, (code, out, err), (1, '', ''))

    code, out, err = call_programmatic(module, ['--encoding', 'utf-8'], stdin_text=SAMPLE_TEXT)
    probe.equal('BC-15', 'programmatic_with_valid_encoding', (code, out, err), (0, '', ''))
    probe.check('BC-15', 'programmatic_text_still_countable',
                module.count_text(SAMPLE_TEXT) == {'char_count': 20, 'line_count': 2,
                                                   'non_empty_line_count': 2, 'word_count': 4},
                repr(module.count_text(SAMPLE_TEXT)))

    saved_argv = sys.argv
    try:
        sys.argv = [MODULE_FILE, 'missing-file.txt']
        code, out, err = call_programmatic(module, None)
    finally:
        sys.argv = saved_argv
    probe.equal('BC-19', 'argv_none_uses_sys_argv_without_program_name', (code, out, err), (1, '', ''))

    saved_argv, saved_cwd = sys.argv, os.getcwd()
    try:
        os.chdir(repo / TARGET_DIR)
        sys.argv = [MODULE_FILE, 'sample_input.txt']
        code, out, err = call_programmatic(module, None)
    finally:
        sys.argv = saved_argv
        os.chdir(saved_cwd)
    probe.equal('AC-06', 'argv_none_reads_path_from_sys_argv', (code, out, err), (0, '', ''))


def probe_command_line(repo, probe):
    code, out, err = run_cli(repo, [], b'')
    probe.equal('AC-03', 'empty_stdin', (code, out.decode().splitlines(), err.decode()),
                (0, ['char_count: 0', 'line_count: 0', 'non_empty_line_count: 0', 'word_count: 0'], ''))

    code, out, err = run_cli(repo, ['sample_input.txt'])
    probe.equal('AC-07', 'sample_file_as_path', (code, out.decode().splitlines(), err.decode()),
                (0, ['char_count: 20', 'line_count: 2', 'non_empty_line_count: 2', 'word_count: 4'], ''))

    code, out, err = run_cli(repo, [], SAMPLE_TEXT.encode())
    probe.equal('AC-08', 'sample_bytes_on_stdin', (code, out.decode().splitlines(), err.decode()),
                (0, ['char_count: 20', 'line_count: 2', 'non_empty_line_count: 2', 'word_count: 4'], ''))

    code, out, err = run_cli(repo, [], b'hello world\n')
    probe.equal('BC-22', 'output_format', (code, out.decode().splitlines(), err.decode()),
                (0, ['char_count: 12', 'line_count: 1', 'non_empty_line_count: 1', 'word_count: 2'], ''))

    code, out, err = run_cli(repo, ['--help'])
    probe.check('AC-09', 'cli_help_exit_zero', code == 0 and err == b'', (code, err[:80]))
    usage = out.decode()
    probe.check('AC-09', 'cli_help_mentions_path_and_encoding', 'PATH' in usage and '--encoding' in usage, usage[:200])
    probe.check('AC-09', 'cli_help_has_no_traceback', 'Traceback' not in usage, usage[:120])

    for name, argv in (('missing_file', ['missing-file.txt']),
                       ('directory', [TARGET_DIR]),
                       ('unknown_encoding_without_path', ['--encoding', 'no-such-codec']),
                       ('two_positional', ['a.txt', 'b.txt'])):
        code, out, err = run_cli(repo, argv, b'')
        lines = err.decode().splitlines()
        probe.check('AC-10', 'cli_error_' + name,
                    code == 1 and out == b'' and len(lines) == 1 and lines[0].startswith('error: ')
                    and 'Traceback' not in lines[0], (code, out[:60], lines[:2]))

    broken = repo / TARGET_DIR / '.probe-broken-utf8.txt'
    broken.write_bytes(b'abc\xff')
    try:
        code, out, err = run_cli(repo, [broken.name])
        lines = err.decode().splitlines()
        probe.check('AC-11', 'undecodable_file', code == 1 and out == b'' and len(lines) == 1
                    and lines[0].startswith('error: '), (code, lines[:2]))
    finally:
        broken.unlink()

    scratch = repo / TARGET_DIR / '.test-scratch'
    scratch.mkdir(exist_ok=True)
    utf16 = scratch / 'probe-utf16.txt'
    utf16.write_bytes(SAMPLE_TEXT.encode('utf-16'))
    try:
        code, out, err = run_cli(repo, ['--encoding', 'utf-16', str(utf16)])
        probe.equal('AC-22', 'utf16_file', (code, out.decode().splitlines(), err.decode()),
                    (0, ['char_count: 20', 'line_count: 2', 'non_empty_line_count: 2', 'word_count: 4'], ''))
        code, out, err = run_cli(repo, ['--encoding', 'utf-16'], b'hello world\n')
        probe.equal('AC-22', 'encoding_does_not_change_stdin', (code, out.decode().splitlines(), err.decode()),
                    (0, ['char_count: 12', 'line_count: 1', 'non_empty_line_count: 1', 'word_count: 2'], ''))
    finally:
        utf16.unlink()

    code, out, err = run_cli(repo, ['--encoding', 'utf-8'], SAMPLE_TEXT.encode())
    probe.equal('BC-13', 'explicit_utf8_stdin', (code, out.decode().splitlines(), err.decode()),
                (0, ['char_count: 20', 'line_count: 2', 'non_empty_line_count: 2', 'word_count: 4'], ''))


def probe_delivery_files(repo, probe):
    target = repo / TARGET_DIR
    module_source = (target / MODULE_FILE).read_text(encoding='utf-8')
    test_source = (target / 'test_text_stats.py').read_text(encoding='utf-8')
    scratch = re.findall(r'^\s*(?:from|import)\s+([A-Za-z_][\w.]*)', module_source + '\n' + test_source, re.M)
    foreign = sorted({name.split('.')[0] for name in scratch} - set(sys.stdlib_module_names) - {'text_stats'})
    probe.check('AC-23', 'imports_are_standard_library', not foreign, foreign)
    probe.check('AC-23', 'no_dependency_manifest',
                not any((target / name).exists() for name in
                        ('requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile')), 'none')

    guard = module_source.count('sys.exit(')
    probe.check('AC-13', 'module_guard_is_the_only_sys_exit', guard == 1 and 'sys.exit(main())' in module_source, guard)
    probe.check('AC-13', 'main_returns_int_no_systemexit', 'raise SystemExit' not in module_source, 'no raise SystemExit')

    sample = (target / 'sample_input.txt').read_bytes()
    probe.equal('AC-25', 'sample_is_twenty_lf_bytes', (sample, len(sample)), (b'hello world\nfoo bar\n', 20))

    readme = (target / 'README.md').read_text(encoding='utf-8')
    for label in ('char_count: 20', 'line_count: 2', 'non_empty_line_count: 2', 'word_count: 4',
                  'char_count: 12', 'char_count: 0'):
        probe.check('AC-25', 'readme_has_' + label.replace(': ', '_').replace(' ', '_'), label in readme, label)
    stale = [line for line in readme.splitlines()
             if 'char_count: 6' in line and not any(word in line for word in ('曾', '历史', '不再是', '不得'))]
    probe.check('AC-25', 'readme_has_no_stale_char_count_six', not stale, stale[:1])
    probe.check('AC-26', 'no_bare_u2019', '\u2019' not in module_source and '\u2019' not in readme,
                'bare U+2019 occurrences')
    probe.check('AC-27', 'readme_declares_coverage', 'AC-01' in readme and 'BC-01' in readme, 'signature present')


def main(argv=None):
    parser = argparse.ArgumentParser(description='独立复核 v0.2 需求在交付实现中的行为。')
    parser.add_argument('--repo-root', default='.')
    parser.add_argument('--json-out', default=None)
    args = parser.parse_args(argv)

    repo = Path(args.repo_root).resolve()
    module = load_module(repo / TARGET_DIR / MODULE_FILE)
    probe = Probe()
    probe_text_layer(module, probe)
    probe_programmatic(module, repo, probe)
    probe_command_line(repo, probe)
    probe_delivery_files(repo, probe)

    failed = [item for item in probe.results if not item['ok']]
    for item in probe.results:
        if not item['ok']:
            print('FAIL %s %s | %s' % (item['criterion'], item['name'], item['detail']))
    for item in probe.results:
        if item['ok']:
            print('PASS %s %s' % (item['criterion'], item['name']))
    print('\n%d/%d checks passed' % (len(probe.results) - len(failed), len(probe.results)))

    if args.json_out:
        payload = {
            'tool': 'tests/probe-text-stats-requirement.py',
            'method': 'independent derivation from the approved requirement text; the delivered test file is never imported',
            'target': str(repo / TARGET_DIR / MODULE_FILE),
            'moduleSha256': hashlib.sha256((repo / TARGET_DIR / MODULE_FILE).read_bytes()).hexdigest(),
            'checks': probe.results,
            'passed': len(probe.results) - len(failed),
            'total': len(probe.results),
        }
        Path(args.json_out).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
