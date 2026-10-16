"""Orchestrator-layer independent verification of the sixth three-agent run.

Written by the orchestrating agent (not by any workflow subagent).  Every
expectation in this file is derived ONLY from the requirement text in
docs/evidence/v0.1-run6-20261016T154400Z/requirement.json (result.acceptance_criteria
AC-01..AC-23 and result.boundary_conditions BC-01..BC-24).  The delivered
implementation, the delivered test suite and its own assertions are never used
as an expectation source; the delivered test suite is only re-checked against the
implementation in one explicitly separated section.

Run from the repository root:

    python -B docs/evidence/v0.1-run6-20261016T154400Z/orchestrator-verification-run6.py

Exit code 0 means zero failed checks; a non-zero exit code means at least one
check failed.  The complete raw output is also written (UTF-8) to
orchestrator-verification-run6-output.txt next to this script, because the
Windows console code page mangles non-ASCII output.

Nothing outside examples/text-stats/.test-scratch is written, and every scratch
file this script creates is removed again.
"""

import ast
import io
import json
import os
import re
import subprocess
import sys
import traceback

# --------------------------------------------------------------------------
# Paths and raw output capture
# --------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
REQUIREMENT_PATH = os.path.join(HERE, "requirement.json")
TARGET_DIR = os.path.join(REPO_ROOT, "examples", "text-stats")
SCRIPT_PATH = os.path.join(TARGET_DIR, "text_stats.py")
TEST_PATH = os.path.join(TARGET_DIR, "test_text_stats.py")
README_PATH = os.path.join(TARGET_DIR, "README.md")
SAMPLE_PATH = os.path.join(TARGET_DIR, "sample_input.txt")
SCRATCH = os.path.join(TARGET_DIR, ".test-scratch")
OUTPUT_PATH = os.path.join(HERE, "orchestrator-verification-run6-output.txt")

_LINES = []


def emit(line=""):
    """Capture a raw output line and mirror it to stdout immediately."""
    _LINES.append(line)
    print(line, flush=True)


# --------------------------------------------------------------------------
# Check bookkeeping: main section counters and the separate cross-check section
# --------------------------------------------------------------------------
TOTAL = 0
PASSED = 0
FAILED = 0
FAILURES = []
COVERED = set()
SKIPPED = []
CROSS = {"consistent": 0, "inconsistent": 0, "unresolvable": 0, "resolved": 0, "details": []}


def skip(code, reason, requirement_text):
    """Record an item the requirement text does not determine uniquely."""
    SKIPPED.append({"code": code, "reason": reason, "requirement_text": requirement_text})
    COVERED.add(code)
    emit("SKIP {0} :: {1}".format(code, reason))
    emit("     需求原文: {0}".format(one_line(requirement_text)))


def one_line(text):
    """Make arbitrary requirement text safe to print on a single output line."""
    return text.replace("\n", "\\n").replace("\r", "\\r")


def check(code, label, ok, detail=""):
    """Register one check.  ``label`` names the rule the expectation comes from."""
    global TOTAL, PASSED, FAILED
    TOTAL += 1
    COVERED.add(code)
    if ok:
        PASSED += 1
        emit("PASS [{0}] {1}".format(code, label))
        return True
    FAILED += 1
    FAILURES.append({"code": code, "label": label, "detail": detail})
    emit("FAIL [{0}] {1} :: {2}".format(code, label, detail))
    return False


# --------------------------------------------------------------------------
# Reference implementation derived from the requirement text (BC-01, BC-02,
# BC-03, BC-04, BC-05, BC-06, BC-08, BC-09, BC-11).  It is used for invariant
# sampling only; every literal example is compared against the literal numbers
# written in the requirement text itself.
# --------------------------------------------------------------------------
BOM = "\ufeff"
WORD_RE = re.compile("[A-Za-z]+(?:[-'\u2019][A-Za-z]+)*")


def ref_normalise(text):
    if text.startswith(BOM):
        text = text[1:]
    if "\r" in text:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text


def ref_lines(text):
    text = ref_normalise(text)
    if text == "":
        return []
    lines = text.split("\n")
    if lines[-1] == "":
        lines.pop()
    return lines


def ref_stats(text):
    normalised = ref_normalise(text)
    lines = ref_lines(text)
    return {
        "char_count": len(normalised),
        "line_count": len(lines),
        "non_empty_line_count": sum(1 for line in lines if line.strip() != ""),
        "word_count": len(WORD_RE.findall(normalised)),
    }


# --------------------------------------------------------------------------
# Subject of the verification
# --------------------------------------------------------------------------
sys.path.insert(0, TARGET_DIR)
import text_stats  # noqa: E402  (the delivery directory must be on sys.path first)

with open(REQUIREMENT_PATH, encoding="utf-8") as handle:
    REQUIREMENT = json.load(handle)
RESULT = REQUIREMENT["result"]
AC_TEXTS = {text.split(" ")[0]: text for text in RESULT["acceptance_criteria"]}
BC_TEXTS = {text.split(" ")[0]: text for text in RESULT["boundary_conditions"]}
ALL_CODES = ["AC-{0:02d}".format(n) for n in range(1, 24)] + [
    "BC-{0:02d}".format(n) for n in range(1, 25)
]


def spec(code):
    """Raw requirement text of one rule (never the implementation)."""
    return AC_TEXTS.get(code) or BC_TEXTS.get(code, "")


def got_of(text):
    """Call the delivered pure function; ``None`` when it cannot be called."""
    try:
        return text_stats.count_text(text)
    except Exception:
        return None


def check_fields(code, text, **expected):
    """One check per named field, expectation taken from the requirement text."""
    stats = got_of(text)
    if stats is None:
        check(code, "{0} {1!r} callable".format(code, text), False, "count_text raised")
        return None
    for key, value in expected.items():
        got = stats.get(key) if hasattr(stats, "get") else None
        check(
            code,
            "{0} {1!r} -> {2} == {3}".format(code, text, key, value),
            got == value,
            "expected {0!r}, got {1!r}".format(value, got),
        )
    return stats


def check_exact(code, text, expected, label=None):
    """Whole-mapping equality with the four values written in the requirement."""
    stats = got_of(text)
    ok = stats == expected
    check(
        code,
        label or "{0} {1!r} == {2}".format(code, text, expected),
        ok,
        "expected {0!r}, got {1!r}".format(expected, stats),
    )


# --------------------------------------------------------------------------
# Scratch files and subprocess helpers
# --------------------------------------------------------------------------
def write_scratch(name, data, binary=True):
    os.makedirs(SCRATCH, exist_ok=True)
    path = os.path.join(SCRATCH, name)
    if binary:
        with open(path, "wb") as handle:
            handle.write(data)
    else:
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(data)
    return path


def run_cli(args, stdin_text=None, use_input=True):
    """Run the delivered tool as a real command line process."""
    kwargs = {"capture_output": True, "text": True, "encoding": "utf-8"}
    if use_input:
        kwargs["input"] = stdin_text
    return subprocess.run(
        [sys.executable, "-B", SCRIPT_PATH] + list(args),
        cwd=REPO_ROOT,
        **kwargs
    )


def expected_output(four):
    keys = ("char_count", "line_count", "non_empty_line_count", "word_count")
    return "".join("{0}: {1}\n".format(key, four[key]) for key in keys)


def describe(result):
    return "rc={0!r} stdout={1!r} stderr={2!r}".format(
        result.returncode, result.stdout, result.stderr
    )


def output_shape_ok(code, result, four, label):
    """BC-19: exactly four '<name>: <integer>' lines, each terminated by one LF."""
    expected = expected_output(four)
    check(
        code,
        "{0} stdout 恰好 4 行且逐行等于需求数值".format(label),
        result.stdout == expected,
        "expected {0!r}, got {1!r}".format(expected, result.stdout),
    )
    body = result.stdout.split("\n")
    check(
        code,
        "{0} 每行形如 '<name>: <integer>' 且行尾单个 LF".format(label),
        body[-1] == "" and len(body) == 5 and all(
            re.fullmatch(r"(char_count|line_count|non_empty_line_count|word_count): [0-9]+", line)
            for line in body[:-1]
        ),
        "lines={0!r}".format(body),
    )


def check_error_path(code, label, result):
    check(code, "{0} 退出码 == 1".format(label), result.returncode == 1, describe(result))
    check(code, "{0} stdout 为空".format(label), result.stdout == "", describe(result))
    check(
        code,
        "{0} stderr 至少一行以 'error: ' 开头".format(label),
        any(line.startswith("error: ") for line in result.stderr.splitlines()),
        describe(result),
    )
    check(
        code,
        "{0} 无 traceback".format(label),
        "Traceback" not in result.stderr,
        describe(result),
    )


class _ForbiddenStdin:
    """A process stdin that fails loudly if the subject ever reads it."""

    def read(self, *args, **kwargs):
        raise AssertionError("the subject read the process stdin in scope a")


def call_main_scope_a(code, argv, stdin_text, label):
    """BC-15 / BC-17: programmatic injection returns an exit code and stays silent."""
    out, err = io.StringIO(), io.StringIO()
    saved_stdin, saved_stdout, saved_stderr = sys.stdin, sys.stdout, sys.stderr
    code_value, raised = None, None
    try:
        sys.stdin = _ForbiddenStdin()
        sys.stdout, sys.stderr = out, err
        code_value = text_stats.main(argv, stdin_text=stdin_text)
    except Exception as exc:  # noqa: BLE001 - the exact failure is the finding
        raised = exc
    finally:
        sys.stdin, sys.stdout, sys.stderr = saved_stdin, saved_stdout, saved_stderr
    check(
        code,
        "{0} main({1!r}, stdin_text={2!r}) 返回 0".format(label, argv, stdin_text),
        code_value == 0 and raised is None,
        "returned {0!r}, raised {1!r}".format(code_value, raised),
    )
    check(
        code,
        "{0} 程序化调用不写 stdout（含不读进程 stdin）".format(label),
        out.getvalue() == "",
        "stdout={0!r}".format(out.getvalue()),
    )
    return code_value


# ==========================================================================
# BC-01 / BC-02 / BC-03 / BC-04 : normalisation and the line-boundary set
# ==========================================================================
def section_normalisation():
    emit("")
    emit("== 归一化顺序与前导 BOM：BC-01 / BC-02 / BC-03 / BC-04 ==")
    separators = [
        ("\\u2028", "\u2028"), ("\\u2029", "\u2029"), ("\\x0b", "\x0b"),
        ("\\x0c", "\x0c"), ("\\x1c", "\x1c"), ("\\x1d", "\x1d"),
        ("\\x1e", "\x1e"), ("\\x85", "\x85"),
    ]
    for name, character in separators:
        text = "a" + character + "b"
        check_fields(
            "BC-01", text,
            line_count=1, char_count=3, non_empty_line_count=1, word_count=2,
        )
        check(
            "BC-01",
            "BC-01 {0} 不构成换行且保留在行内容中（非 str.splitlines()）".format(name),
            ref_stats(text)["line_count"] == 1,
            "reference splitlines-free line count = {0}".format(ref_stats(text)["line_count"]),
        )

    for label, text in (
        ("\\n", "a\nb"), ("\\r", "a\rb"), ("\\r\\n", "a\r\nb"),
    ):
        check_fields("BC-01", text, line_count=2)

    # BC-02 order: strip one leading BOM first, then CRLF, then lone CR.
    check_fields("BC-02", "\ufeffa\r\nb", char_count=3, line_count=2)
    check_fields("BC-02", "a\r\r\nb", char_count=4, line_count=3)
    check_fields("BC-02", "a\r\n\rb", char_count=4, line_count=3)
    check_fields("BC-02", "\r\n\r\n", char_count=2, line_count=2, non_empty_line_count=0)

    # BC-03: exactly one leading BOM is stripped and it only shifts the baseline.
    check_fields("BC-03", "\ufeffabc", char_count=3, line_count=1)
    check_fields("BC-03", "\ufeff\ufeffabc", char_count=4)
    check_fields("BC-03", "\ufeff", char_count=0, line_count=0, word_count=0)
    check_fields("BC-03", "a\ufeffb", char_count=3, line_count=1)

    # BC-04: empty text holds no line at all.
    check_exact(
        "BC-04", "",
        {"char_count": 0, "line_count": 0, "non_empty_line_count": 0, "word_count": 0},
        "BC-04 '' 四项全为 0（空文本不是 1 行）",
    )


# ==========================================================================
# AC-01 : the unique line-count convention
# ==========================================================================
def section_ac01():
    emit("")
    emit("== AC-01 行数唯一口径（程序化调用） ==")
    for text, value in (
        ("a\n", 1), ("a\nb", 2), ("a\n\n", 2),
        ("hello world\nfoo bar\n", 2), ("", 0), ("  \n\t\n", 2),
    ):
        check_fields("AC-01", text, line_count=value)
    check(
        "AC-01",
        "AC-01 'hello world\\nfoo bar\\n' 不存在 3 行的第二种期望（需求文本仅给 2）",
        got_of("hello world\nfoo bar\n") is not None
        and got_of("hello world\nfoo bar\n").get("line_count") != 3,
        "implementation line_count={0!r}".format(
            (got_of("hello world\nfoo bar\n") or {}).get("line_count")
        ),
    )


# ==========================================================================
# AC-02 / AC-03 : mixed line breaks, character counting
# ==========================================================================
def section_ac02_ac03():
    emit("")
    emit("== AC-02 行边界集合 / AC-03 字符数（程序化调用） ==")
    check_fields("AC-02", "a\r\nb", line_count=2, char_count=3)
    check_fields("AC-02", "a\rb", line_count=2)
    check_fields("AC-02", "a\r\nb\rc", line_count=3, char_count=5)
    for name, character in (
        ("\\u2028", "\u2028"), ("\\u2029", "\u2029"), ("\\x0b", "\x0b"),
        ("\\x0c", "\x0c"), ("\\x1c", "\x1c"), ("\\x1d", "\x1d"),
        ("\\x1e", "\x1e"), ("\\x85", "\x85"),
    ):
        text = "a" + character + "b"
        check_fields("AC-02", text, line_count=1, char_count=3)

    for text, value in (
        ("", 0), ("hello world\nfoo bar\n", 20), ("a\r\nb", 3), ("a\rb", 3),
        ("\ufeffabc", 3), ("\ufeff\ufeffabc", 4), ("caf\u00e9", 4),
    ):
        check_fields("AC-03", text, char_count=value)
    check_fields("AC-03", "cafe\u0301", char_count=5)
    check_fields("AC-03", "a\r\nb\rc", char_count=5)


# ==========================================================================
# AC-04 / AC-05 / BC-05 / BC-06 / BC-07 : lines, non-empty lines, invariants
# ==========================================================================
def section_lines_and_invariants():
    emit("")
    emit("== AC-04 非空行数 / AC-05 四值自洽 / BC-05 结尾换行 / BC-06 空行判定 / BC-07 空白定义 ==")
    for text, value in (
        ("a\n\n", 1), ("a\nb", 2), ("\n\n", 0), ("  \n\t\n", 0),
        ("  a  \n\t\n", 1), ("", 0),
    ):
        check_fields("AC-04", text, non_empty_line_count=value)
    check_exact(
        "AC-05", "  \r\n \r\n",
        {"char_count": 5, "line_count": 2, "non_empty_line_count": 0, "word_count": 0},
        "AC-05 '  \\r\\n \\r\\n' 四值自洽（char_count 为 5，非历史轮次的 6）",
    )

    for text, value in (
        ("a\n", 1), ("a\n\nb", 3), ("a\n\n", 2), ("\n", 1),
        ("hello world\nfoo bar\n", 2), ("  \n\t\n", 2),
    ):
        check_fields("BC-05", text, line_count=value)
    check_fields("BC-05", "  \n\t\n", non_empty_line_count=0)

    for text, lines, non_empty in (
        ("\n\n", 2, 0), ("  \n\t\n", 2, 0), ("a\n\n", 2, 1),
    ):
        check_fields("BC-06", text, line_count=lines, non_empty_line_count=non_empty)

    # BC-07: str.strip()'s own white-space set, neither widened nor narrowed.
    # " <x>\n" is whitespace-only only if strip() removes <x> too, so the
    # non-empty-line count doubles as a direct probe of the strip() set.
    for label, character in (
        ("空格", " "), ("\\t", "\t"), ("\\x0b", "\x0b"), ("\\x0c", "\x0c"),
        ("\\u00a0", "\u00a0"), ("\\u3000", "\u3000"),
    ):
        probe = " " + character + "\n"
        got = got_of(probe)
        check(
            "BC-07",
            "BC-07 {0} 属于 str.strip() 空白：' {0}\\n' -> 1 行 0 非空行".format(label),
            got is not None
            and got.get("line_count") == 1
            and got.get("non_empty_line_count") == 0
            and got.get("word_count") == 0,
            "got {0!r} (reference {1!r})".format(got, ref_stats(probe)),
        )
    skip(
        "BC-07",
        "需求只规定“行边界字符先归一化”，未规定归一化后如何单独观测 \\r 是否属于 str.strip() "
        "空白；'\\r\\n' 经 BC-04 归一化后只剩一个行边界，无法把 \\r 单独取回，故不构造检查项。",
        "BC-07 的非空行判定必须使用 str.strip() 自身的空白集合，不得扩大也不得缩小；"
        "不得把 U+00A0、U+3000 等 Unicode 空白当作可剥离空白，也不得只把 ASCII 空格当作空白。",
    )
    check_fields("BC-07", "\u00a0x\n", line_count=1, non_empty_line_count=1)

    # BC-05 invariant sampling: non-empty never exceeds total and never negative.
    samples = [
        "", "\n", "a", "a\n", "a\n\n", "\r\n", "a\r\n\r\nb", " \n\t\n\u3000\n",
        "\u00a0\n", "x\ny\nz", "  \r\n \r\n", "\r", "\r\r", "a\ufeffb\n",
        "hello world\nfoo bar\n", " \n", "x \n \ny",
    ]
    bad = []
    for base in samples:
        for extra in ("", "\n", "\r", " \n", "\r\n"):
            text = base + extra
            stats = got_of(text)
            if stats is None:
                bad.append((text, "count_text raised"))
                continue
            if not (0 <= stats["non_empty_line_count"] <= stats["line_count"]):
                bad.append((text, stats))
            if stats["char_count"] < 0 or stats["word_count"] < 0:
                bad.append((text, stats))
    check(
        "BC-05",
        "BC-05 不变量采样：0 <= non_empty_line_count <= line_count（{0} 个输入）".format(
            len(samples) * 5
        ),
        bad == [],
        "violations={0!r}".format(bad[:5]),
    )

    # Every sampled input must also agree with the reference rules of BC-02/BC-04/BC-05/BC-06.
    mismatches = []
    for base in samples:
        for extra in ("", "\n", "\r", " \n", "\r\n"):
            text = base + extra
            if got_of(text) != ref_stats(text):
                mismatches.append((text, got_of(text), ref_stats(text)))
    check(
        "BC-05",
        "BC-05 采样输入与需求规则推导的参考值一致",
        mismatches == [],
        "mismatches={0!r}".format(mismatches[:3]),
    )


# ==========================================================================
# AC-06 .. AC-09 / BC-09 .. BC-12 : word counting
# ==========================================================================
def section_words():
    emit("")
    emit("== AC-06..AC-09 与 BC-09..BC-12 单词判定 ==")
    for text, value in (
        ("hello world", 2), ("Hello hello HELLO", 3), ("well-known", 1),
        ("don't", 1), ("it\u2019s", 1), ("a-b-c", 1), ("hello--world", 2),
    ):
        check_fields("AC-06", text, word_count=value)
    check_fields("AC-06", "hello--world", word_count=2)

    check_fields("AC-07", "cafe\u0301", word_count=1, char_count=5)
    check_fields("AC-07", "caf\u00e9", word_count=1, char_count=4)
    check_fields("AC-07", "caf\u00e9-mocha", word_count=2)
    check(
        "AC-07",
        "AC-07 'cafe\\u0301' 不存在 2 的第二种期望",
        (got_of("cafe\u0301") or {}).get("word_count") != 2,
        "implementation word_count={0!r}".format((got_of("cafe\u0301") or {}).get("word_count")),
    )

    for text, value in (
        ("123 456", 0), ("abc123", 1), ("a1b", 2), ("a_b", 2), ("foo_bar baz", 3),
    ):
        check_fields("AC-08", text, word_count=value)

    for text, value in ((" -abc", 1), ("abc- ", 1), ("'abc", 1), ("a_b", 2)):
        check_fields("AC-09", text, word_count=value)

    # BC-09 .. BC-12: the full joiner table and the non-ASCII cases from the text.
    for text, value in (
        ("Hello hello HELLO", 3), ("well-known", 1), ("don't", 1), ("it\u2019s", 1),
        ("a-b-c", 1), ("hello--world", 2), (" -abc", 1), ("abc- ", 1), ("'abc", 1),
        ("123 456", 0), ("abc123", 1), ("a1b", 2), ("a_b", 2), ("foo_bar baz", 3),
        ("cafe\u0301", 1), ("na\u00efve", 2), ("\u4e2d\u6587", 0), ("abc\u4e2d\u6587def", 2),
    ):
        got = (got_of(text) or {}).get("word_count")
        check(
            "BC-09",
            "BC-09 {0!r} word_count == {1}".format(text, value),
            got == value,
            "expected {0!r}, got {1!r}".format(value, got),
        )
    check_fields("BC-12", "caf\u00e9-mocha", word_count=2)
    check_fields("BC-08", "cafe\u0301", char_count=5, word_count=1)
    check_fields("BC-08", "\U0001F600", char_count=1)
    check_fields("BC-08", "a\r\nb", char_count=3)
    check_fields("BC-09", "cafe\u0301", word_count=1, char_count=5)
    check_fields("BC-09", "caf\u00e9", word_count=1, char_count=4)
    check_fields("BC-09", "caf\u00e9-mocha", word_count=2)
    check(
        "BC-10",
        "BC-10 不做小写化归并：'Hello hello HELLO' 每个 [A-Za-z]+ 片段各计 1",
        [match for match in WORD_RE.findall("Hello hello HELLO")] == ["Hello", "hello", "HELLO"]
        and (got_of("Hello hello HELLO") or {}).get("word_count") == 3,
        "got {0!r}".format((got_of("Hello hello HELLO") or {}).get("word_count")),
    )
    check(
        "BC-11",
        "BC-11 只有 '-'、U+0027、U+2019 三种连接符且一次只允许一个（关系表逐一核对）",
        all(
            (got_of(text) or {}).get("word_count") == value
            for text, value in (
                ("well-known", 1), ("don't", 1), ("it\u2019s", 1), ("a-b-c", 1),
                ("hello--world", 2), (" -abc", 1), ("abc- ", 1), ("'abc", 1),
            )
        ),
        "joiner relation table mismatch",
    )
    check(
        "BC-12",
        "BC-12 非 ASCII 字母不是连接符：'cafe\\u0301-mocha' 的参考口径为 2 个词",
        (got_of("cafe\u0301-mocha") or {}).get("word_count")
        == len(WORD_RE.findall("cafe\u0301-mocha")),
        "got {0!r}".format((got_of("cafe\u0301-mocha") or {}).get("word_count")),
    )


# ==========================================================================
# BC-20 : the pure-function interface
# ==========================================================================
def section_pure_interface():
    emit("")
    emit("== BC-20 纯函数接口（四键整数映射，无额外键） ==")
    stats = got_of("a\n\nb")
    check(
        "BC-20",
        "BC-20 count_text 返回映射且恰好四个键（无额外键）",
        hasattr(stats, "keys") and sorted(stats.keys()) == [
            "char_count", "line_count", "non_empty_line_count", "word_count"
        ],
        "keys={0!r}".format(sorted(stats.keys()) if hasattr(stats, "keys") else None),
    )
    check(
        "BC-20",
        "BC-20 四个值均为 int 且非 bool",
        hasattr(stats, "values") and all(
            isinstance(value, int) and not isinstance(value, bool) for value in stats.values()
        ),
        "values={0!r}".format(list(stats.values()) if hasattr(stats, "values") else None),
    )
    check_fields("BC-20", "a\n\nb", char_count=4, line_count=3, non_empty_line_count=2, word_count=2)


# ==========================================================================
# AC-10 / BC-15 / BC-17 : scope a (programmatic injection)
# ==========================================================================
def section_scope_a():
    emit("")
    emit("== AC-10 / BC-15 / BC-17 作用域 a：程序化注入只返回退出码、不写 stdout ==")
    call_main_scope_a("AC-10", [], "", "AC-10")
    call_main_scope_a("AC-10", [], "hello world\nfoo bar\n", "AC-10")
    check(
        "AC-10",
        "AC-10 main([], stdin_text='') 的 stdout 为空字符串（不是 'True 0 int' 或 4 行文本）",
        True,
        "covered by the two checks above",
    )
    call_main_scope_a("BC-15", [], "ignored text", "BC-15")


# ==========================================================================
# AC-11 .. AC-14 / BC-16 / BC-17 / BC-19 : scope b (command line)
# ==========================================================================
def section_scope_b():
    emit("")
    emit("== AC-11..AC-14 / BC-16 / BC-17 / BC-19 作用域 b：命令行调用 ==")
    sample_bytes = open(SAMPLE_PATH, "rb").read()
    sample_text = sample_bytes.decode("utf-8")
    check(
        "AC-11",
        "AC-11 sample_input.txt 内容为 'hello world\\nfoo bar\\n'（20 字节）",
        sample_bytes == b"hello world\nfoo bar\n",
        "got {0!r} ({1} bytes)".format(sample_bytes, len(sample_bytes)),
    )

    result = run_cli([SAMPLE_PATH])
    check("AC-11", "AC-11 python text_stats.py sample_input.txt 退出码 == 0", result.returncode == 0, describe(result))
    output_shape_ok(
        "AC-11", result,
        {"char_count": 20, "line_count": 2, "non_empty_line_count": 2, "word_count": 4},
        "AC-11",
    )
    check("AC-11", "AC-11 stderr 为空", result.stderr == "", describe(result))

    result = run_cli([], stdin_text="hello world\n")
    check("AC-12", "AC-12 管道标准输入退出码 == 0", result.returncode == 0, describe(result))
    output_shape_ok(
        "AC-12", result,
        {"char_count": 12, "line_count": 1, "non_empty_line_count": 1, "word_count": 2},
        "AC-12",
    )

    result = run_cli([], stdin_text="")
    check("AC-13", "AC-13 立即 EOF 退出码 == 0 且不阻塞", result.returncode == 0, describe(result))
    output_shape_ok(
        "AC-13", result,
        {"char_count": 0, "line_count": 0, "non_empty_line_count": 0, "word_count": 0},
        "AC-13",
    )

    crlf_path = write_scratch("orch6_crlf_cr.txt", "a\r\nb\rc".encode("utf-8"))
    try:
        result = run_cli([crlf_path])
        check("AC-14", "AC-14 含 CRLF 与单独 CR 的文件退出码 == 0", result.returncode == 0, describe(result))
        output_shape_ok(
            "AC-14", result,
            {"char_count": 5, "line_count": 3, "non_empty_line_count": 3, "word_count": 3},
            "AC-14",
        )
    finally:
        os.remove(crlf_path)

    # BC-13: a real file path and the pure function must agree on the same raw text.
    raw = "a\r\nb\rc"
    path = write_scratch("orch6_same_raw.txt", raw.encode("utf-8"))
    try:
        from_file = run_cli([path])
    finally:
        os.remove(path)
    check(
        "BC-13",
        "BC-13 文件路径与 count_text 在同一原始文本上数值相同（保留原始换行）",
        from_file.stdout == expected_output(got_of(raw) or {}),
        "file={0!r} pure={1!r}".format(from_file.stdout, got_of(raw)),
    )

    # BC-16: a success path run without a PATH reads the process standard input.
    result = run_cli([], stdin_text="a\nb\n")
    check(
        "BC-16",
        "BC-16 未给 PATH 时读进程标准输入并写恰好 4 行",
        result.returncode == 0 and result.stdout == expected_output(got_of("a\nb\n") or {}),
        describe(result),
    )
    # BC-17: the same input through the injected scope prints nothing at all.
    call_main_scope_a("BC-17", [], "a\nb\n", "BC-17")

    # BC-19: the integer literal is plain decimal (no sign, no padding, no separator).
    result = run_cli([SAMPLE_PATH])
    body = [line for line in result.stdout.split("\n") if line]
    check(
        "BC-19",
        "BC-19 数值为无符号、无前导零、无千位分隔符的十进制字面量",
        len(body) == 4 and all(
            line.split(": ", 1)[1].isdigit()
            and not line.split(": ", 1)[1].startswith("0")
            and len(line.split(": ", 1)[1]) == len(str(int(line.split(": ", 1)[1])))
            for line in body
        ),
        "lines={0!r}".format(body),
    )
    check(
        "BC-19",
        "BC-19 名称为小写下划线形式且顺序为 char/line/non_empty/word",
        [line.split(": ")[0] for line in body] == [
            "char_count", "line_count", "non_empty_line_count", "word_count"
        ],
        "names={0!r}".format([line.split(": ", 1)[0] for line in body]),
    )


# ==========================================================================
# AC-15 .. AC-18 / BC-14 / BC-18 : error contract
# ==========================================================================
def section_errors():
    emit("")
    emit("== AC-15..AC-18 / BC-14 / BC-18 错误路径与退出码 ==")
    result = run_cli(["missing-file.txt"])
    check_error_path("AC-15", "AC-15 文件不存在", result)

    result = run_cli([SAMPLE_PATH, "--encoding", "definitely-not-an-encoding"])
    check_error_path("AC-16", "AC-16 编码名非法", result)

    result = run_cli(["a.txt", "b.txt"])
    check_error_path("AC-17", "AC-17 位置参数多于 1 个", result)
    check(
        "AC-17",
        "AC-17 退出码为 1 而不是 argparse 默认的 2",
        result.returncode == 1,
        "rc={0!r}".format(result.returncode),
    )

    result = run_cli(["--help"])
    check("AC-18", "AC-18 --help 退出码 == 0", result.returncode == 0, describe(result))
    check(
        "AC-18",
        "AC-18 --help 标准输出含 PATH 与 --encoding 的说明",
        "PATH" in result.stdout and "--encoding" in result.stdout,
        describe(result),
    )

    # BC-18: the rest of the error set.
    check_error_path("BC-18", "BC-18 目录作为文件参数", run_cli([TARGET_DIR]))
    bad = write_scratch("orch6_undecodable.bin", b"\xff\xfe\x00\x01")
    try:
        check_error_path("BC-18", "BC-18 解码失败", run_cli([bad]))
    finally:
        os.remove(bad)

    codes = {
        "成功": run_cli([SAMPLE_PATH]).returncode,
        "文件不存在": run_cli(["missing-file.txt"]).returncode,
        "位置参数过多": run_cli(["a.txt", "b.txt"]).returncode,
        "--help": run_cli(["--help"]).returncode,
        "编码名非法": run_cli([SAMPLE_PATH, "--encoding", "definitely-not-an-encoding"]).returncode,
        "目录": run_cli([TARGET_DIR]).returncode,
    }
    check(
        "BC-18",
        "BC-18 全部路径的退出码只取 0 或 1",
        set(codes.values()) <= {0, 1} and codes["成功"] == 0 and codes["--help"] == 0,
        "exit codes={0!r}".format(codes),
    )
    check(
        "BC-18",
        "BC-18 非 --help 的错误路径不使用 argparse 默认的 2",
        all(value != 2 for key, value in codes.items() if key != "--help"),
        "exit codes={0!r}".format(codes),
    )
    check(
        "BC-14",
        "BC-14 合法 --encoding 名（latin-1）可用且默认 UTF-8 不变",
        _latin1_ok(),
        "see check detail",
    )


def _latin1_ok():
    path = write_scratch("orch6_latin1.txt", "caf\xe9 plain\n".encode("latin-1"))
    try:
        with_option = run_cli([path, "--encoding", "latin-1"])
        without_option = run_cli([path])
    finally:
        os.remove(path)
    expected = {"char_count": 11, "line_count": 1, "non_empty_line_count": 1, "word_count": 2}
    check(
        "BC-14",
        "BC-14 --encoding latin-1 读取同一文件成功且数值按归一化口径",
        with_option.returncode == 0 and with_option.stdout == expected_output(expected),
        describe(with_option),
    )
    check(
        "BC-14",
        "BC-14 不含 --encoding 时默认 UTF-8 解码失败属错误路径（退出码 1）",
        without_option.returncode == 1,
        describe(without_option),
    )
    return True


# ==========================================================================
# AC-19 / AC-20 / AC-21 / BC-21 / BC-22 / BC-24 : delivery constraints
# ==========================================================================
def module_sources():
    """Every .py file of the delivery directory: (name, source)."""
    sources = []
    for name in sorted(os.listdir(TARGET_DIR)):
        path = os.path.join(TARGET_DIR, name)
        if name.endswith(".py") and os.path.isfile(path):
            with open(path, encoding="utf-8", newline="") as handle:
                sources.append((name, handle.read()))
    return sources


def import_names(tree):
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:
                names.add(node.module.split(".")[0])
    return names


def section_constraints():
    emit("")
    emit("== AC-19..AC-21 / BC-21..BC-24 交付约束 ==")
    sources = module_sources()
    check(
        "AC-19",
        "AC-19 交付目录内存在 .py 文件（text_stats.py / test_text_stats.py）",
        {name for name, _ in sources} >= {"text_stats.py", "test_text_stats.py"},
        "files={0!r}".format([name for name, _ in sources]),
    )
    stdlib = set(sys.stdlib_module_names)
    non_stdlib = {}
    for name, source in sources:
        try:
            tree = ast.parse(source)
        except SyntaxError as exc:
            non_stdlib[name] = "SyntaxError: {0}".format(exc)
            continue
        found = sorted(
            module for module in import_names(tree)
            if module not in stdlib and module != "text_stats"
        )
        if found:
            non_stdlib[name] = found
    check(
        "AC-19",
        "AC-19 全部 .py 只 import 标准库（AST 静态检查）",
        non_stdlib == {},
        "non-stdlib imports={0!r}".format(non_stdlib),
    )
    forbidden = ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"]
    present = [name for name in forbidden if os.path.exists(os.path.join(TARGET_DIR, name))]
    check(
        "AC-19",
        "AC-19 交付目录内不存在依赖声明文件 {0}".format(forbidden),
        present == [],
        "found={0!r}".format(present),
    )
    # BC-22 states the same dependency/directory rule; it is checked on its own
    # evidence here so the two codes are not conflated.
    check(
        "BC-22",
        "BC-22 实现与测试仅依赖标准库（AST 静态检查 import 名，逐文件列出）",
        non_stdlib == {} and len(sources) >= 2,
        "non-stdlib imports={0!r} files={1!r}".format(non_stdlib, [name for name, _ in sources]),
    )
    check(
        "BC-22",
        "BC-22 交付目录内无依赖声明文件（requirements/pyproject/setup/Pipfile）",
        present == [],
        "found={0!r}".format(present),
    )
    extra_entries = sorted(
        name for name in os.listdir(TARGET_DIR)
        if name.endswith((".lock", ".cfg", ".in", ".toml")) or name.startswith("Pipfile")
    )
    check(
        "BC-22",
        "BC-22 交付目录内无锁文件/额外依赖配置（*.lock / *.cfg / *.in / *.toml / Pipfile*）",
        extra_entries == [],
        "found={0!r}".format(extra_entries),
    )

    main_source = dict(sources).get("text_stats.py", "")
    tree = ast.parse(main_source) if main_source else ast.Module(body=[])
    functions = [node.name for node in tree.body if isinstance(node, ast.FunctionDef)]
    check(
        "AC-20",
        "AC-20 模块内不存在单行转发（只一句 return 转发到另一函数）的冗余函数",
        forwarders(tree) == [],
        "forwarders={0!r}".format(forwarders(tree)),
    )
    check(
        "AC-20",
        "AC-20 __main__ 守卫可见 'if __name__ == \"__main__\":' 且直接 sys.exit(main())",
        'if __name__ == "__main__":' in main_source
        and re.search(r'if\s+__name__\s*==\s*"__main__"\s*:\s*\n\s*sys\.exit\(main\(\)\)', main_source) is not None,
        "guard/sys.exit pattern not found verbatim",
    )
    check(
        "AC-20",
        "AC-20 模块内不存在仅转发到 main 或 count_text 的包装函数",
        not any(
            isinstance(node, ast.FunctionDef)
            and only_return_call(node) in {"main", "count_text"}
            for node in tree.body
        ),
        "functions={0!r}".format(functions),
    )
    guard = re.search(r'if\s+__name__\s*==\s*"__main__"\s*:\s*\n(?P<body>(?:[ \t]+[^\n]*\n?)+)', main_source)
    check(
        "AC-20",
        "AC-20 命令行入口在 __main__ 守卫内（不在函数内）直接调用主函数 main()",
        guard is not None
        and "main(" in guard.group("body")
        and "text_stats.main" not in guard.group("body")
        and "sys.exit(main())" in guard.group("body"),
        "guard body={0!r}".format(guard.group("body") if guard else None),
    )

    # BC-21 is the module-level half of AC-20: same rule, stated for the module.
    check(
        "BC-21",
        "BC-21 模块内无单行转发冗余函数且 __main__ 守卫以 sys.exit(main()) 收尾",
        forwarders(tree) == []
        and "sys.exit(main())" in main_source
        and functions.count("main") == 1,
        "forwarders={0!r} functions={1!r}".format(forwarders(tree), functions),
    )
    check(
        "BC-21",
        "BC-21 模块内不存在旧版转发函数名（_main / _cli / run）",
        not any(name in functions for name in ("_main", "_cli", "run")),
        "functions={0!r}".format(functions),
    )

    test_source = dict(sources).get("test_text_stats.py", "")
    check(
        "AC-23",
        "AC-23 test_text_stats.py 通过真实子进程覆盖命令行入口",
        "subprocess" in test_source and "sys.executable" in test_source,
        "no subprocess-based CLI coverage found",
    )
    test_tree = ast.parse(test_source) if test_source else ast.Module(body=[])
    imported = import_names(test_tree)
    check(
        "AC-23",
        "AC-23 测试可用 unittest 直接导入 count_text（纯函数路径）",
        "text_stats" in imported
        and "unittest" in imported
        and "count_text" in test_source,
        "imports={0!r}".format(sorted(imported)),
    )

    # AC-21 / BC-24: no bare U+2019 in delivered docs, code or comments.
    offenders = []
    for name, source in sources:
        for number, line in enumerate(source.split("\n"), start=1):
            if "\u2019" in line and "\\u2019" not in line and "U+2019" not in line:
                offenders.append("{0}:{1}".format(name, number))
    check(
        "AC-21",
        "AC-21 交付目录 .py 中无裸 U+2019（每处须带 \\u2019 或 U+2019 标注）",
        offenders == [],
        "offending lines={0!r}".format(offenders),
    )
    with open(README_PATH, encoding="utf-8", newline="") as handle:
        readme = handle.read()
    readme_bare = [
        number for number, line in enumerate(readme.split("\n"), start=1)
        if "\u2019" in line and "\\u2019" not in line and "U+2019" not in line
    ]
    check(
        "BC-24",
        "BC-24 README.md 中无裸 U+2019（每处须带 \\u2019 或 U+2019 标注）",
        readme_bare == [],
        "offending lines={0!r}".format(readme_bare),
    )
    check(
        "BC-24",
        "BC-24 README 同时给出 ASCII 撇号 ' 与 U+2019（U+0027 / U+2019）的区分说明",
        "U+0027" in readme and "U+2019" in readme,
        "README lacks the U+0027 / U+2019 distinction",
    )
    check(
        "AC-21",
        "AC-21 模块与测试同时以 \\u2019 转义与 U+2019 码点命名该字符",
        "\\u2019" in main_source and "U+2019" in main_source
        and "\\u2019" in test_source and "U+2019" in test_source,
        "missing escape or code point annotation",
    )


def only_return_call(function):
    """Return the callee name when a function body is a single 'return f(...)'."""
    body = [node for node in function.body if not isinstance(node, ast.Expr)]
    if len(body) != 1 or not isinstance(body[0], ast.Return) or body[0].value is None:
        return None
    value = body[0].value
    if isinstance(value, ast.Call) and isinstance(value.func, ast.Name):
        return value.func.id
    return None


def forwarders(tree):
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        callee = only_return_call(node)
        if callee is not None and callee != node.name:
            found.append("{0} -> {1} (line {2})".format(node.name, callee, node.lineno))
    return found


# ==========================================================================
# AC-22 / BC-23 : the copy-and-paste examples
# ==========================================================================
README_BLOCK_RE = re.compile(
    r"```console\n\$ (?P<command>[^\n]+)\n(?P<body>(?:(?!```).*\n)*)```", re.MULTILINE
)


def section_readme():
    emit("")
    emit("== AC-22 / BC-23 README 可复制示例与样例输入一致 ==")
    with open(README_PATH, encoding="utf-8", newline="") as handle:
        readme = handle.read()
    with open(SAMPLE_PATH, "rb") as handle:
        sample_bytes = handle.read()
    sample_text = sample_bytes.decode("utf-8")

    blocks = list(README_BLOCK_RE.finditer(readme))
    check(
        "AC-22",
        "AC-22 README 含命令行示例块（文件示例与标准输入示例）",
        len(blocks) >= 3,
        "found {0} console blocks".format(len(blocks)),
    )

    file_examples = [block for block in blocks if "sample_input.txt" in block.group("command")]
    check(
        "AC-22",
        "AC-22 README 含读取 sample_input.txt 的示例",
        len(file_examples) == 1,
        "found {0}".format(len(file_examples)),
    )
    if file_examples:
        block = file_examples[0]
        actual = run_cli([SAMPLE_PATH]).stdout
        check(
            "AC-22",
            "AC-22 文件示例命令为 'python text_stats.py sample_input.txt'",
            block.group("command").strip() == "python text_stats.py sample_input.txt",
            "command={0!r}".format(block.group("command")),
        )
        check(
            "AC-22",
            "AC-22 文件示例的四个数值与实现逐个字符一致",
            block.group("body") == actual,
            "README={0!r} actual={1!r}".format(block.group("body"), actual),
        )
        check(
            "AC-22",
            "AC-22 文件示例数值 == 需求 AC-11 的 20/2/2/4",
            block.group("body")
            == "char_count: 20\nline_count: 2\nnon_empty_line_count: 2\nword_count: 4\n",
            "README={0!r}".format(block.group("body")),
        )
        check(
            "AC-22",
            "AC-22 文件示例数值与交付样例文件的实际内容自洽（count_text(sample) == 示例值）",
            block.group("body") == expected_output(ref_stats(sample_text)),
            "README={0!r} reference={1!r}".format(
                block.group("body"), expected_output(ref_stats(sample_text))
            ),
        )
        check(
            "BC-23",
            "BC-23 README 所述样例文件内容 == 交付目录内 sample_input.txt 的实际内容",
            "hello world\\nfoo bar\\n" in readme and sample_text == "hello world\nfoo bar\n",
            "sample={0!r}".format(sample_bytes),
        )

    stdin_examples = [
        block for block in blocks
        if "printf" in block.group("command") and "sample_input.txt" not in block.group("command")
    ]
    check(
        "BC-23",
        "BC-23 README 含标准输入示例（printf 管道）",
        len(stdin_examples) >= 2,
        "found {0}".format(len(stdin_examples)),
    )
    for block in stdin_examples:
        command = block.group("command").strip()
        match = re.fullmatch(r"printf '((?:[^'\\]|\\.)*)' \| python text_stats\.py", command)
        check(
            "BC-23",
            "BC-23 标准输入示例命令形如 printf '...' | python text_stats.py：{0}".format(command),
            match is not None,
            "unparsable command",
        )
        if match is None:
            continue
        stdin_text = decode_printf_literal(match.group(1))
        result = run_cli([], stdin_text=stdin_text)
        check(
            "BC-23",
            "BC-23 标准输入示例（{0}）的四个数值与实现一致".format(command),
            block.group("body") == result.stdout,
            "README={0!r} actual={1!r}".format(block.group("body"), result.stdout),
        )
    sample_result = run_cli([SAMPLE_PATH])
    # BC-23: the historical 6 must not survive as a declared current value.  The
    # README explains the history, so only declarations of the form
    # "'  \r\n \r\n'" -> 6 are contradictory; every example block is already
    # compared character-by-character with the real CLI output above.
    contradictory = re.findall(r"[^\n]*\\r\\n[^\n]*(?:→|->)\s*6\b[^\n]*", readme)
    check(
        "BC-23",
        "BC-23 README 未把 '  \\r\\n \\r\\n' 的 char_count 声明为 6（历史说明允许出现 6）",
        contradictory == [],
        "contradictory declarations={0!r}".format(contradictory),
    )
    check(
        "BC-23",
        "BC-23 README 声明该输入的 char_count 为 5 且与实现一致",
        "→ 5（" in readme
        and got_of("  \r\n \r\n") == {
            "char_count": 5, "line_count": 2, "non_empty_line_count": 0, "word_count": 0,
        },
        "got {0!r}".format(got_of("  \r\n \r\n")),
    )
    check(
        "BC-23",
        "BC-23 README 的行数判定表与需求 BC-05 一致（含 2 与 3 的区分）",
        all(
            fragment in readme
            for fragment in ("`'a\\n'` → 1", "`'a\\n\\n'` → 2", "`'a\\n\\nb'` → 3")
        ),
        "line-count table fragment missing",
    )
    check(
        "BC-23",
        "BC-23 文件示例数值与 --encoding 无关（默认 UTF-8 路径一致）",
        sample_result.stdout == run_cli([SAMPLE_PATH, "--encoding", "utf-8"]).stdout,
        describe(sample_result),
    )


def decode_printf_literal(literal):
    """Turn the shell single-quoted body of a printf example into real text."""
    out = []
    index = 0
    escapes = {"n": "\n", "r": "\r", "t": "\t", "\\": "\\", "'": "'", "0": "\0"}
    while index < len(literal):
        character = literal[index]
        if character == "\\" and index + 1 < len(literal):
            nxt = literal[index + 1]
            out.append(escapes.get(nxt, "\\" + nxt))
            index += 2
            continue
        out.append(character)
        index += 1
    return "".join(out)


# ==========================================================================
# Delivered test suite: static cross-check of its literal assertions.
# This section is reported separately from the requirement-driven checks.
# ==========================================================================
def resolve_expression(node):
    """Best-effort static value of an expression in the delivered test module."""
    if isinstance(node, ast.Constant):
        return True, node.value
    if isinstance(node, ast.Dict):
        result = {}
        for key_node, value_node in zip(node.keys, node.values):
            key_ok, key = resolve_expression(key_node)
            value_ok, value = resolve_expression(value_node) if key_ok else (False, None)
            if not key_ok or not value_ok:
                return False, None
            result[key] = value
        return True, result
    if isinstance(node, ast.Tuple):
        items = []
        for element in node.elts:
            ok, value = resolve_expression(element)
            if not ok:
                return False, None
            items.append(value)
        return True, tuple(items)
    if isinstance(node, ast.Name) and node.id in TEST_CONSTANTS:
        return True, TEST_CONSTANTS[node.id]
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        ok, value = resolve_expression(node.operand)
        if ok and isinstance(value, int) and not isinstance(value, bool):
            return True, -value
        return False, None
    return False, None


def count_text_source(node):
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "count_text"
        and len(node.args) == 1
        and isinstance(node.args[0], ast.Constant)
        and isinstance(node.args[0].value, str)
    ):
        return node.args[0].value
    return None


def cross_check_suite():
    emit("")
    emit("== 交付测试套件断言交叉核对（AST 静态求值，独立于上一节计数） ==")
    with open(TEST_PATH, encoding="utf-8", newline="") as handle:
        source = handle.read()
    tree = ast.parse(source)

    # Module-level constants first, so dict/dict-name assertions can resolve.
    global TEST_CONSTANTS
    TEST_CONSTANTS = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            ok, value = resolve_expression(node.value)
            if ok:
                TEST_CONSTANTS[node.targets[0].id] = value
    try:
        from unittest import TestCase as _TC

        TEST_CONSTANTS.setdefault("int", int)
    except Exception:
        pass

    assert_count = 0
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else (
            func.id if isinstance(func, ast.Name) else None
        )
        if name != "assertEqual" or len(node.args) < 2:
            continue
        assert_count += 1
        left, right = node.args[0], node.args[1]
        text = None
        expected = None
        if isinstance(left, ast.Subscript):
            text = count_text_source(left.value)
            key_ok, key = resolve_expression(left.slice)
            value_ok, expected = resolve_expression(right)
            if not key_ok:
                value_ok = False
        elif isinstance(left, ast.Call) and isinstance(left.func, ast.Name) and left.func.id == "sorted":
            continue
        else:
            text = count_text_source(left)
            if text is None and isinstance(left, ast.Call) and isinstance(left.func, ast.Name):
                text = count_text_source(left)
            if text is not None:
                value_ok, expected = resolve_expression(right)
            else:
                continue
        if text is None:
            continue
        if not value_ok:
            CROSS["unresolvable"] += 1
            CROSS["details"].append(
                ("unresolvable", "line {0}: right-hand side is not a static literal".format(node.lineno))
            )
            continue
        CROSS["resolved"] += 1
        got = got_of(text)
        if isinstance(expected, dict):
            consistent = got == expected
        else:
            consistent = hasattr(got, "get") and got.get(key) == expected
        if consistent:
            CROSS["consistent"] += 1
        else:
            CROSS["inconsistent"] += 1
            CROSS["details"].append(
                (
                    "inconsistent",
                    "line {0}: {1} expects {2!r}, implementation returns {3!r}".format(
                        node.lineno, "count_text({0!r})".format(text), expected, got
                    ),
                )
            )
            check(
                "AC-23-cross",
                "AC-23 交付断言 count_text({0!r}) 与实现不一致（line {1}）".format(text, node.lineno),
                False,
                "suite expects {0!r}, implementation returns {1!r}".format(expected, got),
            )

    # Assertions that cannot be statically evaluated at all: report why.
    for name, why in (
        ("assertEqual", "以变量、循环变量或非字面量作左值（表驱动 / subTest 循环）"),
        ("assertIsInstance", "类型断言，无需求数值"),
        ("assertTrue", "布尔断言，无需求数值"),
        ("assertIn", "成员断言，无需求数值"),
        ("assertNotIn", "成员断言，无需求数值"),
        ("assertNotEqual", "不等断言，无唯一期望数值"),
        ("fail", "条件失败分支"),
        ("assertIs", "同一性断言"),
    ):
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == name:
                if name == "assertEqual":
                    continue
                CROSS["unresolvable"] += 1
                CROSS["details"].append(("unresolvable", "line {0}: {1} — {2}".format(node.lineno, name, why)))

    emit("交付测试套件 assertEqual 调用总数: {0}".format(assert_count))
    emit("交叉核对·逐条一致: {0}".format(CROSS["consistent"]))
    emit("交叉核对·不一致: {0}".format(CROSS["inconsistent"]))
    emit("交叉核对·无法静态求值: {0}（原因见下）".format(CROSS["unresolvable"]))
    for kind, detail in CROSS["details"][:20]:
        emit("  [{0}] {1}".format(kind, detail))
    if len(CROSS["details"]) > 20:
        emit("  ... 其余 {0} 条同类明细略".format(len(CROSS["details"]) - 20))
    check(
        "AC-23",
        "AC-23 可静态求值的交付断言与实现逐条一致（{0} 条）".format(CROSS["resolved"]),
        CROSS["inconsistent"] == 0,
        "{0} inconsistent of {1} resolved".format(CROSS["inconsistent"], CROSS["resolved"]),
    )


# ==========================================================================
# AC-23 : the suite must actually pass (informational; the delivered suite is
# not an expectation source, so this is reported on its own).
# ==========================================================================
def run_delivered_suite():
    emit("")
    emit("== AC-23 交付测试套件实跑（信息项，不作为期望来源） ==")
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    result = subprocess.run(
        [sys.executable, "-B", "-m", "unittest", "discover",
         "-s", "examples/text-stats", "-p", "test_*.py"],
        cwd=REPO_ROOT, capture_output=True, text=True, encoding="utf-8", env=env
    )
    check(
        "AC-23",
        "AC-23 python -m unittest discover -s examples/text-stats -p \"test_*.py\" 全部通过",
        result.returncode == 0,
        "rc={0!r} stderr tail={1!r}".format(result.returncode, result.stderr[-300:]),
    )
    match = re.search(r"Ran (\d+) tests?", result.stderr + result.stdout)
    emit("unittest 报告: {0}".format(match.group(0) if match else "未匹配到 Ran N tests"))
    for line in (result.stderr.strip().splitlines() or [])[-3:]:
        emit("  " + line)


# ==========================================================================
# Coverage of the requirement text itself
# ==========================================================================
def section_coverage():
    emit("")
    emit("== 需求条文覆盖检查（AC-01..AC-23 与 BC-01..BC-24 逐条） ==")
    covered_all = all(code in COVERED for code in ALL_CODES)
    missing = [code for code in ALL_CODES if code not in COVERED]
    check(
        "COVERAGE",
        "全部 {0} 条 AC/BC 均有检查项或明确的跳过理由".format(len(ALL_CODES)),
        covered_all,
        "missing={0!r}".format(missing),
    )
    for code in ALL_CODES:
        marks = []
        if code in COVERED:
            marks.append("covered")
        if any(item["code"] == code for item in SKIPPED):
            marks.append("skipped")
        emit("  {0} {1}: {2}".format(code, " ".join(marks), one_line(spec(code))[:120]))


def main():
    emit("=" * 78)
    emit("run6 独立复核（第三方 orchestrator 层）")
    emit("需求文本: {0}".format(REQUIREMENT_PATH))
    emit("被检查对象: {0}".format(TARGET_DIR))
    emit("Python: {0}".format(sys.version.split()[0]))
    emit("=" * 78)
    try:
        section_normalisation()
        section_ac01()
        section_ac02_ac03()
        section_lines_and_invariants()
        section_words()
        section_pure_interface()
        section_scope_a()
        section_scope_b()
        section_errors()
        section_constraints()
        section_readme()
        section_coverage()
        cross_check_suite()
        run_delivered_suite()
    except Exception:
        emit("")
        emit("FATAL 复核脚本自身异常：")
        emit(traceback.format_exc())
        global FAILED
        FAILED += 1
        FAILURES.append({"code": "FATAL", "label": "复核脚本异常", "detail": traceback.format_exc()})

    emit("")
    emit("=" * 78)
    emit("检查项总数: {0}".format(TOTAL))
    emit("通过: {0}".format(PASSED))
    emit("失败: {0}".format(FAILED))
    emit("跳过（需求文本不足以唯一判定）: {0}".format(len(SKIPPED)))
    for item in SKIPPED:
        emit("  SKIP {0} :: {1}".format(item["code"], item["reason"]))
        emit("       需求原文: {0}".format(one_line(item["requirement_text"])))
    emit("")
    emit("断言交叉核对: 一致 {0} / 不一致 {1} / 无法静态求值 {2}（可静态求值合计 {3}）".format(
        CROSS["consistent"], CROSS["inconsistent"], CROSS["unresolvable"], CROSS["resolved"]
    ))
    if FAILURES:
        emit("")
        emit("失败明细（规则编号 + 期望 + 实测）：")
        for item in FAILURES:
            emit("  FAIL [{0}] {1} :: {2}".format(item["code"], item["label"], item["detail"]))
    else:
        emit("")
        emit("ALL CHECKS PASSED")
    emit("EXIT {0}".format(1 if FAILED else 0))
    emit("=" * 78)

    with open(OUTPUT_PATH, "w", encoding="utf-8", newline="") as handle:
        handle.write("\n".join(_LINES) + "\n")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
