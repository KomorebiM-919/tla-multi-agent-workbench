"""编排层独立复核脚本（由工作流编排者编写，非三个 Agent 的产物）。

目的：不依赖 Coding Agent 自带的单元测试，独立验证 `examples/text-stats` 的实际行为。

期望值来源（两类，均不读取被测代码的实现细节）：
  1. 需求工件 `requirement.json` 中逐条列出的示例（BC-01/02/03/04/05/11/14 的 "例子"）；
  2. 编排者按需求文字独立推导的输入（含 POSIX `wc -l` 语义对照）。

首轮运行曾在 4 处报 FAIL，经与 BC-01/02/03/04 原文核对确认为**编排者期望值写错**
（CRLF 归一化后的 char_count、'\n' 的行数、两处字符数算术），实现本身符合需求；
本版已按需求原文更正。

用法：python -B docs/evidence/v0.1-first-run/orchestrator-verification.py
退出码：0 = 全部通过；1 = 存在失败项。
"""

import ast
import os
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DEMO_DIR = os.path.join(REPO_ROOT, "examples", "text-stats")
sys.path.insert(0, DEMO_DIR)

import text_stats  # noqa: E402  (路径在上方注入)

FAILURES = []
CHECKS = 0


def check(label, actual, expected):
    global CHECKS
    CHECKS += 1
    ok = actual == expected
    if not ok:
        FAILURES.append(label)
    print(f"[{'PASS' if ok else 'FAIL'}] {label}: actual={actual!r} expected={expected!r}")


def counts(text):
    stats = text_stats.count_text(text)
    return (
        stats["char_count"],
        stats["line_count"],
        stats["non_empty_line_count"],
        stats["word_count"],
    )


def cli(args, stdin_text=""):
    proc = subprocess.run(
        [sys.executable, "-B", os.path.join(DEMO_DIR, "text_stats.py")] + args,
        input=stdin_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=REPO_ROOT,
        check=False,
    )
    return proc.returncode, proc.stdout, proc.stderr


print("== A. 任务示例（正常路径） ==")
check("normal text 'hello world\\nfoo bar\\n'", counts("hello world\nfoo bar\n"), (20, 2, 2, 4))

print("== B. 需求 BC 官方示例 ==")
check("BC-01 char_count('a中')", text_stats.count_text("a中")["char_count"], 2)
check("BC-01 char_count('\\U0001F600')", text_stats.count_text("\U0001f600")["char_count"], 1)
check("BC-02 count_text('a\\r\\nb')", counts("a\r\nb"), (3, 2, 2, 2))
check("BC-03 count_text('')['line_count']", text_stats.count_text("")["line_count"], 0)
check("BC-03 count_text('\\n')['line_count']", text_stats.count_text("\n")["line_count"], 1)
check("BC-03 count_text('a\\n')['line_count']", text_stats.count_text("a\n")["line_count"], 1)
check("BC-03 count_text('a\\nb')['line_count']", text_stats.count_text("a\nb")["line_count"], 2)
check("BC-03 count_text('a\\n\\n')['line_count']", text_stats.count_text("a\n\n")["line_count"], 2)
check("BC-04 non_empty('a\\n \\n')", text_stats.count_text("a\n \n")["non_empty_line_count"], 1)
check("BC-04 non_empty('\\t\\n')", text_stats.count_text("\t\n")["non_empty_line_count"], 0)
check("BC-04 non_empty('\\u3000\\n')", text_stats.count_text("\u3000\n")["non_empty_line_count"], 0)
check("BC-04 non_empty('\\u00a0x\\n')", text_stats.count_text("\u00a0x\n")["non_empty_line_count"], 1)
check("BC-11 count_text('\\ufeffhi\\n')", counts("\ufeffhi\n"), (3, 1, 1, 1))

print("== C. 边界条件（编排者独立推导） ==")
check("empty text", counts(""), (0, 0, 0, 0))
check("leading blank lines '\\n\\na'", counts("\n\na"), (3, 3, 1, 1))
check("blank lines inside 'a\\n\\n\\nb'", counts("a\n\n\nb"), (5, 4, 2, 2))
check("trailing CRLF 'a\\r\\n' (normalised, 2 code points)", counts("a\r\n"), (2, 1, 1, 1))
check("CRLF multi 'a\\r\\nb\\r\\n'", counts("a\r\nb\r\n"), (4, 2, 2, 2))
check("bare CR 'a\\rb'", counts("a\rb"), (3, 2, 2, 2))
check("whitespace-only line 'a\\n   \\nb'", counts("a\n   \nb"), (7, 3, 2, 2))
check("BOM-only '\\ufeff' (BC-11 strip, then BC-03 empty text)", counts("\ufeff"), (0, 0, 0, 0))

print("== D. BC-05 不变量 0 <= non_empty <= line（穷举小样本） ==")
alphabet = ["a", "\n", " ", "\t", "\r", "\u3000", "\ufeff", "中"]
samples = [""]
for first in alphabet:
    for second in alphabet:
        for third in alphabet:
            samples.append(first + second + third)
violations = []
for sample in samples:
    stats = text_stats.count_text(sample)
    if not (0 <= stats["non_empty_line_count"] <= stats["line_count"]):
        violations.append((sample, stats))
check(f"invariant over {len(samples)} samples", violations, [])

print("== E. 单词规则 ==")
check("underscore 'a_b'", text_stats.count_text("a_b")["word_count"], 2)
check("hyphen 'well-known'", text_stats.count_text("well-known")["word_count"], 1)
check("double hyphen 'hello--world'", text_stats.count_text("hello--world")["word_count"], 2)
check("apostrophe \"don't\"", text_stats.count_text("don't")["word_count"], 1)
check("typographic apostrophe 'don\\u2019t'", text_stats.count_text("don\u2019t")["word_count"], 1)
check("digits 'abc123'", text_stats.count_text("abc123")["word_count"], 1)
check("CJK '中文'", text_stats.count_text("中文")["word_count"], 0)
check("accented precomposed 'caf\xe9'", text_stats.count_text("caf\xe9")["word_count"], 1)

print("== F. CLI（BC-14 输出格式 / 退出码） ==")
EXPECTED_OUTPUT = "char_count: 20\nline_count: 2\nnon_empty_line_count: 2\nword_count: 4\n"
rc, out, err = cli([], "hello world\nfoo bar\n")
check("stdin exit code", rc, 0)
check("stdin stdout exactly 4 lines in order", out, EXPECTED_OUTPUT)
check("stdin stderr empty", err, "")

rc, out, err = cli([os.path.join("examples", "text-stats", "sample_input.txt")])
check("file arg exit code", rc, 0)
check("file arg output == stdin output for same text", out, EXPECTED_OUTPUT)
check("file arg stderr empty", err, "")

rc, out, err = cli([os.path.join("examples", "text-stats", "does-not-exist.txt")])
check("missing file exit code", rc, 1)
check("missing file stdout empty", out, "")
check("missing file stderr prefix 'error: '", err.startswith("error: "), True)

rc, out, err = cli(["--encoding", "no-such-codec"], "abc\n")
check("bad encoding exit code", rc, 1)
check("bad encoding stderr prefix 'error: '", err.startswith("error: "), True)

rc, out, err = cli(["-h"])
check("help exit code", rc, 0)
check("help text non-empty", len(out) > 0, True)

print("== G. 依赖与入口（仅标准库） ==")
with open(os.path.join(DEMO_DIR, "text_stats.py"), encoding="utf-8") as handle:
    tree = ast.parse(handle.read())
imported = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        imported.update(alias.name.split(".")[0] for alias in node.names)
    elif isinstance(node, ast.ImportFrom) and node.module:
        imported.add(node.module.split(".")[0])
check("stdlib-only imports", sorted(imported), ["argparse", "codecs", "re", "sys"])

print()
print(f"checks={CHECKS} failures={len(FAILURES)}")
if FAILURES:
    for name in FAILURES:
        print(f"  FAILED: {name}")
    sys.exit(1)
print("ALL ORCHESTRATOR CHECKS PASSED")
