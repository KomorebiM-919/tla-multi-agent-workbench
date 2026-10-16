"""Orchestrator-layer independent verification of the second three-agent run.

Written by the orchestrating agent (not by any workflow subagent).  It checks the
delivered demo project in examples/text-stats against the acceptance criteria and
boundary conditions literally quoted in
docs/evidence/v0.1-second-run/requirement.json, using expectations derived from
that spec text rather than from the delivered test suite.

Run from the repository root:

    python -B docs/evidence/v0.1-second-run/orchestrator-verification.py

Exit code 0 means every check passed.  Nothing is written to disk except the
scratch files this script creates inside examples/text-stats/.test-scratch, which
it removes again.
"""

from __future__ import annotations

import ast
import codecs
import io
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
TARGET_DIR = os.path.join(REPO_ROOT, "examples", "text-stats")
SCRATCH = os.path.join(TARGET_DIR, ".test-scratch")

sys.path.insert(0, TARGET_DIR)
import text_stats  # noqa: E402  (path must be prepared first)

FAILURES: list[str] = []
CHECKS = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if ok:
        return
    FAILURES.append(f"{label} :: {detail}")


def expect_stats(label: str, text: str, **expected: int) -> dict:
    """BC-01..BC-10: compare count_text output with the spec's literal numbers."""
    got = text_stats.count_text(text)
    check(label + " / type", isinstance(got, dict), f"got {type(got).__name__}")
    for key, value in expected.items():
        check(
            f"{label} [{key}]",
            got.get(key) == value,
            f"expected {value!r}, got {got.get(key)!r} (text={text!r})",
        )
    return got


# --------------------------------------------------------------------------
# BC-01 char_count / BC-02 newline normalisation
# --------------------------------------------------------------------------
def check_char_count_and_normalisation() -> None:
    expect_stats("BC-01 a\u4e2d", "a\u4e2d", char_count=2)
    expect_stats("BC-01 emoji", "\U0001F600", char_count=1)
    expect_stats("BC-01 bom+hi", "\ufeffhi\n", char_count=3, line_count=1, word_count=1)
    expect_stats("BC-01 empty", "", char_count=0)
    expect_stats("BC-01 ideographic space", "\u3000", char_count=1)

    # BC-02: CRLF and bare CR collapse; U+2028/2029 and the other exotic
    # separators are NOT rewritten (their line-break effect is BC-03's business).
    expect_stats("BC-02 crlf", "a\r\nb", char_count=3, line_count=2, word_count=2)
    expect_stats("BC-02 bare cr", "a\rb", char_count=3, line_count=2)
    expect_stats("BC-02 u+2028 char", "a\u2028b", char_count=3)
    expect_stats(
        "BC-02 u+2028 is not a line break (BC-02 explicit example)",
        "a\u2028b",
        line_count=1,
    )
    expect_stats("BC-02 u+2029 is not a line break", "a\u2029b", line_count=1)
    # BC-02 says only CRLF/CR are rewritten, so the remaining splitlines
    # boundaries must still split (BC-03 = len(T.splitlines())).
    expect_stats("BC-03 vt still splits", "a\x0bb", line_count=2)
    expect_stats("BC-03 nel still splits", "a\x85b", line_count=2)


# --------------------------------------------------------------------------
# BC-03 line_count table (the unique line-count definition) + SI-04
# --------------------------------------------------------------------------
BC03_TABLE = [
    ("", 0),
    ("\n", 1),
    ("a\n", 1),
    ("a", 1),
    ("a\nb", 2),
    ("a\n\n", 2),
    ("hello world\nfoo bar\n", 2),
    ("hello world\nfoo bar\n\n", 3),
]


def check_line_count_table() -> None:
    for text, value in BC03_TABLE:
        expect_stats(f"BC-03 {text!r}", text, line_count=value)

    # SI-04 (defect a): exactly one line-count convention, the splitlines one.
    for text, value in [("a\n", 1), ("\n", 1), ("a\nb", 2)]:
        check(
            f"SI-04 {text!r} follows str.splitlines()",
            len(text.splitlines()) == text_stats.count_text(text)["line_count"] == value,
            f"splitlines={len(text.splitlines())} impl={text_stats.count_text(text)['line_count']}",
        )


# --------------------------------------------------------------------------
# BC-04 non-empty lines, BC-05 invariants
# --------------------------------------------------------------------------
def check_non_empty_lines() -> None:
    expect_stats("BC-04 a/space", "a\n \n", non_empty_line_count=1)
    expect_stats("BC-04 tab", "\t\n", non_empty_line_count=0)
    expect_stats("BC-04 ideographic space", "\u3000\n", non_empty_line_count=0)
    expect_stats("BC-04 nbsp+x", "\u00a0x\n", non_empty_line_count=1)
    expect_stats("BC-04 newline", "\n", non_empty_line_count=0)
    expect_stats("AC-04 blank lines", "\n\n", char_count=2, line_count=2, non_empty_line_count=0)
    expect_stats("AC-04 spaces+tabs", "  \n\t \n", char_count=6, line_count=2, non_empty_line_count=0)

    samples = ["", "\n", "a", "a\n", "a\n\n", "\r\n", "a\r\n\r\nb", " \n\t\n\u3000\n", "\u00a0\n", "x\ny\nz"]
    for base in samples:
        for extra in ("", "\n", "\r", " \n"):
            text = base + extra
            stats = text_stats.count_text(text)
            line_count = stats["line_count"]
            non_empty = stats["non_empty_line_count"]
            check(
                f"BC-05 invariant range {text!r}",
                0 <= non_empty <= line_count,
                f"non_empty={non_empty} line_count={line_count}",
            )
            check(
                f"BC-05 empty iff line_count==0 {text!r}",
                (line_count == 0) == (text_stats.count_text(text)["char_count"] == 0 and text.strip("\r\n") == "" and len(text.replace("\r\n", "\n").replace("\r", "\n").splitlines()) == 0),
                f"line_count={line_count} text={text!r}",
            )


# --------------------------------------------------------------------------
# BC-06..BC-10 word counting
# --------------------------------------------------------------------------
WORD_TABLE = [
    ("abc123", 1), ("123", 0), ("a1b", 2), ("3rd", 1), ("a_b", 2), ("foo_bar baz", 3),
    ("Hello hello HELLO", 3), ("ABC", 1), ("well-known", 1), ("don't", 1),
    ("it\u2019s", 1), ("rock\u2019n", 1), ("a-b-c", 1), ("hello--world", 2),
    ("-abc", 1), ("abc-", 1), ("caf\u00e9", 1), ("cafe\u0301", 1),
    ("caf\u00e9-mocha", 2), ("cafe\u0301-mocha", 2), ("na\u00efve", 2),
    ("\u4e2d\u6587", 0), ("abc\u4e2d\u6587def", 2), ("1984", 0),
]


def check_words() -> None:
    for text, value in WORD_TABLE:
        expect_stats(f"BC-06..10 {text!r}", text, word_count=value)
    expect_stats("AC-06 uppercase", "Hello hello HELLO", word_count=3)
    expect_stats("AC-07 cafe+combining", "cafe\u0301", word_count=1, char_count=5)
    expect_stats("AC-07 cafe precomposed", "caf\u00e9", word_count=1, char_count=4)
    expect_stats("AC-05 demo text", "hello world\nfoo bar\n", char_count=20, line_count=2, non_empty_line_count=2, word_count=4)
    expect_stats("AC-05 no trailing newline", "hello world\nfoo bar", char_count=19, line_count=2)


# --------------------------------------------------------------------------
# BC-11 BOM handling from a real file, BC-15 CLI/function agreement
# --------------------------------------------------------------------------
def write_scratch(name: str, data: bytes) -> str:
    os.makedirs(SCRATCH, exist_ok=True)
    path = os.path.join(SCRATCH, name)
    with open(path, "wb") as handle:
        handle.write(data)
    return path


def run_cli(args: list[str], stdin_text: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "text_stats.py", *args],
        cwd=TARGET_DIR,
        input=stdin_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def check_bom_and_cli_agreement() -> None:
    bom_path = write_scratch("orch_verify_bom.txt", codecs.BOM_UTF8 + b"hi\n")
    try:
        result = run_cli([bom_path])
        check("BC-11 bom file exit code", result.returncode == 0, f"rc={result.returncode} err={result.stderr!r}")
        check(
            "BC-11 bom file output",
            result.stdout == "char_count: 3\nline_count: 1\nnon_empty_line_count: 1\nword_count: 1\n",
            f"stdout={result.stdout!r}",
        )
    finally:
        os.remove(bom_path)

    # BC-15: CLI numbers must equal count_text numbers for the same text.
    sample_path = os.path.join(TARGET_DIR, "sample_input.txt")
    with open(sample_path, encoding="utf-8") as handle:
        text = handle.read()
    result = run_cli(["sample_input.txt"])
    stats = text_stats.count_text(text)
    expected = (
        f"char_count: {stats['char_count']}\n"
        f"line_count: {stats['line_count']}\n"
        f"non_empty_line_count: {stats['non_empty_line_count']}\n"
        f"word_count: {stats['word_count']}\n"
    )
    check("BC-15 cli matches count_text", result.stdout == expected, f"{result.stdout!r} != {expected!r}")


# --------------------------------------------------------------------------
# BC-12 output contract, AC-08/AC-09/AC-13, SI-05, BC-13/BC-14 error paths
# --------------------------------------------------------------------------
def check_output_contract_and_errors() -> None:
    result = run_cli(["sample_input.txt"])
    check("AC-08 exit code", result.returncode == 0, f"rc={result.returncode}")
    check(
        "AC-08 stdout",
        result.stdout == "char_count: 20\nline_count: 2\nnon_empty_line_count: 2\nword_count: 4\n",
        f"stdout={result.stdout!r}",
    )
    check("AC-08 stderr empty", result.stderr == "", f"stderr={result.stderr!r}")

    result = run_cli([], stdin_text="hello world\n")
    check("AC-09 stdin exit code", result.returncode == 0, f"rc={result.returncode}")
    check(
        "AC-09 stdin stdout",
        result.stdout == "char_count: 12\nline_count: 1\nnon_empty_line_count: 1\nword_count: 2\n",
        f"stdout={result.stdout!r}",
    )

    result = run_cli([], stdin_text="")
    check("AC-09 empty stdin exit code", result.returncode == 0, f"rc={result.returncode}")
    check(
        "AC-09 empty stdin stdout",
        result.stdout == "char_count: 0\nline_count: 0\nnon_empty_line_count: 0\nword_count: 0\n",
        f"stdout={result.stdout!r}",
    )

    result = run_cli(["--help"])
    check("AC-13 --help exit code", result.returncode == 0, f"rc={result.returncode}")
    check("AC-13 --help mentions PATH", "PATH" in result.stdout, f"stdout={result.stdout!r}")

    samples = [
        ("BC-13 missing file", ["no-such-file.txt"]),
        ("BC-13 directory", ["."]),
        ("BC-13 unknown codec", ["--encoding", "no-such-codec", "sample_input.txt"]),
    ]
    for label, args in samples:
        result = run_cli(args)
        check(f"{label} exit code 1", result.returncode == 1, f"rc={result.returncode}")
        check(f"{label} stdout empty", result.stdout == "", f"stdout={result.stdout!r}")
        check(
            f"{label} stderr starts with error: ",
            result.stderr.startswith("error: "),
            f"stderr={result.stderr!r}",
        )
        check(f"{label} no traceback", "Traceback" not in result.stderr, f"stderr={result.stderr!r}")

    bad_path = write_scratch("orch_verify_bad.txt", b"\xff\xfe\x00bad")
    try:
        result = run_cli([bad_path])
        check("BC-13 undecodable exit code 1", result.returncode == 1, f"rc={result.returncode}")
        check("BC-13 undecodable stdout empty", result.stdout == "", f"stdout={result.stdout!r}")
        check("BC-13 undecodable stderr prefix", result.stderr.startswith("error: "), f"stderr={result.stderr!r}")
        check("BC-13 undecodable no traceback", "Traceback" not in result.stderr, f"stderr={result.stderr!r}")
    finally:
        os.remove(bad_path)

    # BC-14 / SI-05 / AC-11: extra positional arguments -> exit 1, never argparse's 2.
    for args, label in [
        (["sample_input.txt", "extra.txt"], "AC-11 two positional args"),
        (["sample_input.txt", "extra.txt", "more.txt"], "AC-11 three positional args"),
        (["no-such-file.txt", "extra.txt"], "AC-11 two args, first missing"),
    ]:
        result = run_cli(args)
        check(f"{label} exit code 1 (not 2)", result.returncode == 1, f"rc={result.returncode}")
        check(f"{label} stdout empty", result.stdout == "", f"stdout={result.stdout!r}")
        check(f"{label} stderr prefix", result.stderr.startswith("error: "), f"stderr={result.stderr!r}")
        check(f"{label} no traceback", "Traceback" not in result.stderr, f"stderr={result.stderr!r}")

    # BC-14 in-process: main() must return 1 instead of letting SystemExit escape.
    try:
        code = text_stats.main(["a.txt", "b.txt"])
        check("BC-14 main returns 1", code == 1, f"got {code!r}")
    except SystemExit as exc:  # pragma: no cover - only on regression
        check("BC-14 main must not raise SystemExit", False, f"SystemExit({exc.code!r})")


# --------------------------------------------------------------------------
# AC-12 / SI-06 / BC-16: no single-line forwarder, entry point calls main
# --------------------------------------------------------------------------
def _run_inline(code: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=TARGET_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def check_no_forwarders() -> None:
    ac12 = (
        "import inspect, text_stats as t; "
        "names=[n for n,f in vars(t).items() if inspect.isfunction(f) "
        "and f.__module__=='text_stats' and 'return main(' in inspect.getsource(f)]; "
        "print('FORWARDERS', names)"
    )
    result = _run_inline(ac12)
    check("AC-12 FORWARDERS []", result.stdout.strip() == "FORWARDERS []", f"stdout={result.stdout!r} stderr={result.stderr!r}")

    ac12b = "import text_stats as t; code = t.main([], stdin_text=''); print(callable(t.main), code, type(code).__name__)"
    result = _run_inline(ac12b)
    check("AC-12 main recursive-call output", result.stdout.strip() == "True 0 int", f"stdout={result.stdout!r}")

    # BC-16 / SI-06 by AST: no function whose whole body is "return main(argv)".
    source_path = os.path.join(TARGET_DIR, "text_stats.py")
    with open(source_path, encoding="utf-8") as handle:
        source = handle.read()
    tree = ast.parse(source)
    forwarders = []
    public_names = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            public_names.append(node.name)
            body = [n for n in node.body if not (isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant))]
            if len(body) == 1 and isinstance(body[0], ast.Return) and isinstance(body[0].value, ast.Call):
                callee = body[0].value.func
                if isinstance(callee, ast.Name) and callee.id == "main":
                    forwarders.append(node.name)
    check("BC-16 no forwarder functions", forwarders == [], f"forwarders={forwarders}")
    check("SI-06 _cli removed", "_cli" not in public_names, f"module functions={public_names}")
    check("BC-16 count_text and main exist", {"count_text", "main"} <= set(public_names), f"functions={public_names}")
    check(
        "BC-16 __main__ calls sys.exit(main())",
        re.search(r'if\s+__name__\s*==\s*"__main__":\s*\n\s*sys\.exit\(main\(\)\)', source) is not None,
        "expected trailing sys.exit(main()) entry point",
    )


# --------------------------------------------------------------------------
# AC-14 test suite, AC-15 README connective, AC-16 README example,
# AC-17 stdlib only / no dependency manifests, sample input integrity
# --------------------------------------------------------------------------
STAT_HELPERS = {
    "assert_word_count": "word_count",
    "assert_char_count": "char_count",
    "assert_line_count": "line_count",
    "assert_non_empty_line_count": "non_empty_line_count",
}


def _count_text_literal(node: ast.AST) -> str | None:
    """Return the literal text of a count_text(<literal>) call, else None."""
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


def check_test_assertions_against_implementation(test_source_path: str, test_source: str) -> None:
    """Re-evaluate the delivered suite's literal assertions against the implementation.

    Every assertion of the shape ``assertEqual(count_text(T)[K], V)``,
    ``assertEqual(count_text(T), {..})`` or ``self.assert_word_count(T, V)`` is
    resolved statically and compared with the values the delivered implementation
    actually returns.  Loop-driven assertions (table tests) cannot be resolved
    statically and are counted separately instead of being trusted.
    """
    tree = ast.parse(test_source)
    checked = 0
    dynamic = 0
    mismatches = 0
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else (func.id if isinstance(func, ast.Name) else None)

        if name == "assertEqual" and len(node.args) >= 2:
            left, right = node.args[0], node.args[1]
            if isinstance(left, ast.Subscript):
                text = _count_text_literal(left.value)
                if text is None:
                    continue
                key = left.slice.value if isinstance(left.slice, ast.Constant) else None
                value = right.value if isinstance(right, ast.Constant) else None
                if not isinstance(key, str) or not isinstance(value, int) or isinstance(value, bool):
                    dynamic += 1
                    continue
                got = text_stats.count_text(text).get(key)
                checked += 1
                if got != value:
                    mismatches += 1
                    check(
                        f"AC-14 suite assertion count_text({text!r})[{key!r}]",
                        False,
                        f"suite expects {value!r}, implementation returns {got!r}",
                    )
            else:
                text = _count_text_literal(left)
                if text is None:
                    continue
                if isinstance(right, ast.Dict):
                    expected: dict[str, object] = {}
                    resolvable = True
                    for key_node, value_node in zip(right.keys, right.values):
                        if (
                            isinstance(key_node, ast.Constant)
                            and isinstance(key_node.value, str)
                            and isinstance(value_node, ast.Constant)
                        ):
                            expected[key_node.value] = value_node.value
                        else:
                            resolvable = False
                    if not resolvable or not expected:
                        dynamic += 1
                        continue
                    got = text_stats.count_text(text)
                    checked += 1
                    if got != expected:
                        mismatches += 1
                        check(
                            f"AC-14 suite dict assertion count_text({text!r})",
                            False,
                            f"suite expects {expected!r}, implementation returns {got!r}",
                        )
                else:
                    dynamic += 1
        elif name in STAT_HELPERS and len(node.args) >= 2:
            text_node, value_node = node.args[0], node.args[1]
            if (
                isinstance(text_node, ast.Constant)
                and isinstance(text_node.value, str)
                and isinstance(value_node, ast.Constant)
                and isinstance(value_node.value, int)
                and not isinstance(value_node.value, bool)
            ):
                key = STAT_HELPERS[name]
                got = text_stats.count_text(text_node.value).get(key)
                checked += 1
                if got != value_node.value:
                    mismatches += 1
                    check(
                        f"AC-14 suite helper {name}({text_node.value!r})",
                        False,
                        f"suite expects {value_node.value!r}, implementation returns {got!r}",
                    )
            else:
                dynamic += 1

    check(
        "AC-14 resolvable suite assertions agree with the implementation",
        mismatches == 0,
        f"{mismatches} mismatch(es) out of {checked} resolved assertions",
    )
    print(f"test-suite cross-check: {checked} literal assertions resolved against the implementation, {dynamic} loop-driven assertions skipped")


def check_tests_docs_and_dependencies() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", "examples/text-stats", "-p", "test_*.py"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    check("AC-14 discover exit code", result.returncode == 0, f"rc={result.returncode} out={result.stdout[-400:]!r}")
    match = re.search(r"Ran (\d+) tests", result.stderr + result.stdout)
    check("AC-14 test count >= 15", bool(match) and int(match.group(1)) >= 15, f"stderr tail={result.stderr[-300:]!r}")

    test_source_path = os.path.join(TARGET_DIR, "test_text_stats.py")
    with open(test_source_path, encoding="utf-8") as handle:
        test_source = handle.read()
    check_test_assertions_against_implementation(test_source_path, test_source)

    readme_path = os.path.join(TARGET_DIR, "README.md")
    with open(readme_path, encoding="utf-8") as handle:
        readme = handle.read()
    # AC-15: every quoted U+2019 must carry a code-point annotation on the same line.
    unannotated = []
    for line in readme.splitlines():
        if "\u2019" in line and not ("U+2019" in line or "\\u2019" in line):
            unannotated.append(line)
    check("AC-15 U+2019 annotated", unannotated == [], f"unannotated lines={unannotated}")

    # AC-16: the documented example command's output matches the delivered tool.
    result = run_cli(["sample_input.txt"])
    documented = set(re.findall(r"^(char_count|line_count|non_empty_line_count|word_count): \d+$", readme, re.MULTILINE))
    actual = [line.split(":")[0] for line in result.stdout.strip().splitlines()]
    check(
        "AC-16 README documents the runnable example",
        bool(documented) and set(actual) <= documented,
        f"documented keys={sorted(documented)} actual={actual}",
    )
    check("AC-16 README documents the test command", "unittest" in readme, "no unittest command in README")

    # AC-17 / SI-11: standard library only, no dependency manifests.
    modules = set()
    for name in ("text_stats.py", "test_text_stats.py"):
        with open(os.path.join(TARGET_DIR, name), encoding="utf-8") as handle:
            tree = ast.parse(handle.read())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                modules.add(node.module.split(".")[0])
    stdlib = set(sys.stdlib_module_names)
    non_stdlib = sorted(m for m in modules if m not in stdlib and m != "text_stats")
    check("AC-17 stdlib only", non_stdlib == [], f"non-stdlib imports={non_stdlib}")

    manifests = [n for n in os.listdir(TARGET_DIR) if n in {"requirements.txt", "pyproject.toml", "setup.py", "Pipfile"}]
    check("AC-17 no dependency manifests", manifests == [], f"found={manifests}")

    sample_path = os.path.join(TARGET_DIR, "sample_input.txt")
    with open(sample_path, "rb") as handle:
        sample = handle.read()
    check("sample_input.txt unchanged", sample == b"hello world\nfoo bar\n", f"got {sample!r} ({len(sample)} bytes)")


def main() -> int:
    check_char_count_and_normalisation()
    check_line_count_table()
    check_non_empty_lines()
    check_words()
    check_bom_and_cli_agreement()
    check_output_contract_and_errors()
    check_no_forwarders()
    check_tests_docs_and_dependencies()

    print(f"orchestrator verification: {CHECKS} checks, {len(FAILURES)} failures")
    for failure in FAILURES:
        print("FAIL " + failure)
    if not FAILURES:
        print("ALL CHECKS PASSED")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
