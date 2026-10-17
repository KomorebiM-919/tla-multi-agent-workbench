"""Unit tests for text_stats (standard library ``unittest`` only).

Coverage map: every acceptance criterion AC-01 .. AC-29 and every boundary
condition BC-01 .. BC-30 of this round is covered by at least one test whose
name (or the comment above it) carries the criterion number.  The pure-function
criteria are checked against ``count_text`` directly; the command line criteria
are checked against a real subprocess so that exit code, standard output and
standard error are observed exactly as an operator would see them.

Facts pinned here, with the rules they come from:

* only LF, CR and CRLF end a line, so U+2028, U+2029, ``\\x0b``, ``\\x0c``,
  ``\\x1c``, ``\\x1d``, ``\\x1e`` and ``\\x85`` stay inside the line content and
  ``str.splitlines()`` is never the line counter (BC-04);
* normalisation drops one leading U+FEFF, then turns CRLF into LF, then turns
  the remaining lone CR into LF, and does nothing else (BC-03);
* the line count has one definition only: split on LF, drop the empty segment
  a trailing LF leaves behind, and an empty text has no line (BC-05, BC-06);
* a programmatic call - an explicit ``stdin_text`` argument, ``""`` included -
  prints nothing at all, while only a command line run prints the four lines
  (BC-02, BC-16, BC-17);
* every handled error is exit code 1 with exactly one ``error: `` line on the
  command line and complete silence programmatically, never argparse's default
  2 (BC-17, BC-25).

The DSH file sandbox denies writes outside the workspace (including the system
temporary directory), so transient fixtures are written as flat files into the
pre-existing scratch directory ``.test-scratch`` and removed by the owning test
(BC-27).
"""

import ast
import contextlib
import hashlib
import inspect
import io
import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import text_stats  # noqa: E402
from text_stats import count_text, main  # noqa: E402

SCRIPT = os.path.join(HERE, "text_stats.py")
SAMPLE_INPUT = os.path.join(HERE, "sample_input.txt")
README = os.path.join(HERE, "README.md")
SCRATCH_ROOT = os.path.join(HERE, ".test-scratch")
PYCACHE = os.path.join(HERE, "__pycache__")

# U+2019 RIGHT SINGLE QUOTATION MARK.  Spelled with an escape (or named by code
# point) everywhere in this file, in the module and in the README so that no
# bare, unidentifiable look-alike apostrophe ever appears (BC-01, AC-27).
RSQUO = "\u2019"

# A subprocess that hangs would be a bug; AC-03 requires finishing well inside
# five seconds, and every other subprocess gets the same ceiling.
CLI_TIMEOUT = 10

# The reference text delivered as sample_input.txt: 20 code points, 2 lines,
# 2 non-empty lines, 4 words (AC-04, AC-06, AC-08, AC-27, BC-29).
REFERENCE_TEXT = "hello world\nfoo bar\n"
REFERENCE_STATS = {
    "char_count": 20,
    "line_count": 2,
    "non_empty_line_count": 2,
    "word_count": 4,
}
REFERENCE_OUTPUT = (
    "char_count: 20\n"
    "line_count: 2\n"
    "non_empty_line_count: 2\n"
    "word_count: 4\n"
)
EMPTY_STATS = {
    "char_count": 0,
    "line_count": 0,
    "non_empty_line_count": 0,
    "word_count": 0,
}
EMPTY_OUTPUT = (
    "char_count: 0\n"
    "line_count: 0\n"
    "non_empty_line_count: 0\n"
    "word_count: 0\n"
)
# AC-05: the documented standard input example ("hello world" + LF).
STDIN_TEXT = "hello world\n"
STDIN_OUTPUT = (
    "char_count: 12\n"
    "line_count: 1\n"
    "non_empty_line_count: 1\n"
    "word_count: 2\n"
)
OUTPUT_KEY_ORDER = (
    "char_count",
    "line_count",
    "non_empty_line_count",
    "word_count",
)
OUTPUT_LINE_PATTERN = re.compile(
    r"^(char_count|line_count|non_empty_line_count|word_count): (0|[1-9][0-9]*)$"
)

# BC-04: the characters ``str.splitlines()`` would wrongly treat as line
# boundaries, and that must therefore stay inside the line content.
NON_BOUNDARY_CHARACTERS = (
    "\u2028",
    "\u2029",
    "\x0b",
    "\x0c",
    "\x1c",
    "\x1d",
    "\x1e",
    "\x85",
)

# BC-06: characters that ``str.strip()`` removes, i.e. that make a line empty
# even though several of them never end a line.
BLANK_CHARACTERS = (" ", "\t", "\x0b", "\x0c", "\u00a0", "\u3000")


def read_text(path):
    """Read a delivery file as text without newline translation."""
    with open(path, "r", encoding="utf-8", newline="") as handle:
        return handle.read()


def python_env(**overrides):
    """Environment for child interpreters: no bytecode, plus *overrides*."""
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.update(overrides)
    return env


def run_cli(args, stdin_text=""):
    """Run the module as a real command line and capture its three streams."""
    return subprocess.run(
        [sys.executable, SCRIPT] + list(args),
        input=stdin_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=HERE,
        env=python_env(),
        timeout=CLI_TIMEOUT,
    )


def run_cli_bytes(args, payload):
    """Run the module with *payload* bytes on standard input (AC-05)."""
    return subprocess.run(
        [sys.executable, SCRIPT] + list(args),
        input=payload,
        capture_output=True,
        cwd=HERE,
        env=python_env(),
        timeout=CLI_TIMEOUT,
    )


def run_python_source(source):
    """Run *source* in a child interpreter located in the delivery directory."""
    return subprocess.run(
        [sys.executable, "-c", source],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=HERE,
        env=python_env(),
        timeout=CLI_TIMEOUT,
    )


def parse_stats(output):
    """Turn the four ``<key>: <value>`` output lines back into a mapping."""
    stats = {}
    for line in output.splitlines():
        name, _, value = line.partition(": ")
        stats[name] = int(value)
    return stats


def pycache_snapshot():
    """Fingerprint every file of ``__pycache__`` (AC-28, BC-28)."""
    if not os.path.isdir(PYCACHE):
        return {}
    snapshot = {}
    for name in sorted(os.listdir(PYCACHE)):
        path = os.path.join(PYCACHE, name)
        if not os.path.isfile(path):
            continue
        with open(path, "rb") as handle:
            payload = handle.read()
        snapshot[name] = (
            len(payload),
            os.stat(path).st_mtime_ns,
            hashlib.sha256(payload).hexdigest(),
        )
    return snapshot


class _StreamMustNotBeRead(Exception):
    """Raised when a programmatic call touches the process standard input."""


class _ForbiddenStdin:
    """Stand-in for ``sys.stdin`` whose every read is a failure (BC-02)."""

    def read(self, *args, **kwargs):
        raise _StreamMustNotBeRead("programmatic call read sys.stdin")


_FORBIDDEN_STDIN = _ForbiddenStdin()


@contextlib.contextmanager
def patched_argv(values):
    """Install *values* as ``sys.argv`` for the duration of the block (BC-24)."""
    saved = sys.argv
    sys.argv = list(values)
    try:
        yield
    finally:
        sys.argv = saved


@contextlib.contextmanager
def working_directory(path):
    """Run the block with *path* as the current working directory."""
    saved = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(saved)


def call_main(argv=None, stdin_text=None, process_stdin=None):
    """Call ``main`` in-process; return ``(code, stdout, stderr)``."""
    out, err = io.StringIO(), io.StringIO()
    saved_stdin = sys.stdin
    try:
        if process_stdin is not None:
            # A string means "this content is the process stdin"; any other
            # object (e.g. _FORBIDDEN_STDIN) is installed as is, so a call that
            # reaches for it anyway fails loudly.
            sys.stdin = (
                io.StringIO(process_stdin)
                if isinstance(process_stdin, str)
                else process_stdin
            )
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(argv, stdin_text=stdin_text)
    finally:
        sys.stdin = saved_stdin
    return code, out.getvalue(), err.getvalue()


def scratch_path(name):
    """Return a unique, sandbox-writable fixture path (never creates it)."""
    return os.path.join(
        SCRATCH_ROOT, "test_text_stats_{0}_{1}".format(os.getpid(), name)
    )


@contextlib.contextmanager
def scratch_file(name, data, binary=False):
    """Write a flat fixture under ``.test-scratch`` and always remove it."""
    os.makedirs(SCRATCH_ROOT, exist_ok=True)
    path = scratch_path(name)
    mode = "wb" if binary else "w"
    kwargs = {} if binary else {"encoding": "utf-8", "newline": ""}
    with open(path, mode, **kwargs) as handle:
        handle.write(data)
    try:
        yield path
    finally:
        os.remove(path)


def scratch_argument(path):
    """Return a fixture path as the relative command line argument a user types."""
    return os.path.join(".test-scratch", os.path.basename(path))


class ErrorContractAssertions(unittest.TestCase):
    """Shared assertions for the command line error contract (BC-17)."""

    def assert_single_error_line(self, stderr):
        """stderr must be exactly one readable line starting with ``error: ``."""
        self.assertTrue(stderr.startswith("error: "), stderr)
        self.assertEqual(len(stderr.splitlines()), 1, stderr)
        self.assertNotIn("Traceback", stderr)


class CountTextContractTests(unittest.TestCase):
    """AC-08: the pure function's contract and its numbers."""

    def test_ac08_reference_text_returns_exactly_four_integer_keys(self):
        stats = count_text(REFERENCE_TEXT)
        self.assertIsInstance(stats, dict)
        self.assertEqual(set(stats), set(OUTPUT_KEY_ORDER))
        for key in OUTPUT_KEY_ORDER:
            self.assertIs(type(stats[key]), int, key)
        self.assertEqual(stats, REFERENCE_STATS)

    def test_ac08_empty_text_is_all_zeros(self):
        self.assertEqual(count_text(""), EMPTY_STATS)

    def test_ac08_count_text_reads_no_stream_and_no_file(self):
        saved_stdin = sys.stdin
        try:
            sys.stdin = _FORBIDDEN_STDIN
            self.assertEqual(count_text(REFERENCE_TEXT), REFERENCE_STATS)
        finally:
            sys.stdin = saved_stdin

    def test_ac08_count_text_ignores_missing_sys_stdin(self):
        saved_stdin = sys.stdin
        try:
            sys.stdin = None
            self.assertEqual(count_text(REFERENCE_TEXT), REFERENCE_STATS)
        finally:
            sys.stdin = saved_stdin


class NormalisationTests(unittest.TestCase):
    """AC-09 with BC-01, BC-03 and BC-12."""

    def test_bc01_notation_constants_are_the_documented_code_points(self):
        self.assertEqual("\n", chr(0x0A))          # LF
        self.assertEqual("\r", chr(0x0D))          # CR
        self.assertEqual("\r\n", "\r" + "\n")      # CRLF
        self.assertEqual("\ufeff", chr(0xFEFF))    # BOM
        self.assertEqual(RSQUO, chr(0x2019))       # U+2019
        self.assertEqual("\u00e9", chr(0x00E9))    # e acute
        self.assertEqual("\u0301", chr(0x0301))    # combining acute

    def test_ac09_one_leading_bom_is_dropped(self):
        self.assertEqual(count_text("\ufeffabc"), {
            "char_count": 3,
            "line_count": 1,
            "non_empty_line_count": 1,
            "word_count": 1,
        })

    def test_ac09_only_one_bom_is_dropped(self):
        self.assertEqual(count_text("\ufeff\ufeffabc")["char_count"], 4)

    def test_ac09_crlf_and_lone_cr_become_lf(self):
        self.assertEqual(count_text("a\r\nb")["char_count"], 3)
        self.assertEqual(count_text("a\r\nb")["line_count"], 2)
        self.assertEqual(count_text("a\rb")["char_count"], 3)
        self.assertEqual(count_text("a\rb")["line_count"], 2)

    def test_ac09_mixed_crlf_and_lone_cr(self):
        self.assertEqual(count_text("a\r\nb\rc"), {
            "char_count": 5,
            "line_count": 3,
            "non_empty_line_count": 3,
            "word_count": 3,
        })

    def test_bc03_crlf_is_replaced_before_lone_cr(self):
        # CRLF must be consumed as one newline; "\r\n\r" therefore becomes
        # "\n\n" (2 characters, 2 lines).  Rewriting every CR first would
        # yield three newlines instead, so this row pins the documented order.
        self.assertEqual(count_text("\r\n\r")["char_count"], 2)
        self.assertEqual(count_text("\r\n\r")["line_count"], 2)
        self.assertEqual(count_text("\n\r")["line_count"], 2)

    def test_bc12_no_unicode_normalisation_is_applied(self):
        composed = count_text("caf\u00e9")
        decomposed = count_text("cafe\u0301")
        self.assertEqual(composed["char_count"], 4)
        self.assertEqual(decomposed["char_count"], 5)
        self.assertEqual(composed["word_count"], 1)
        self.assertEqual(decomposed["word_count"], 1)

    def test_bc12_nbsp_and_ideographic_space_are_preserved(self):
        for character in ("\u00a0", "\u3000"):
            with self.subTest(character=hex(ord(character))):
                self.assertEqual(count_text("a" + character + "b")["char_count"], 3)


class LineBoundaryTests(unittest.TestCase):
    """AC-10 with BC-04: only LF, CR and CRLF end a line."""

    def test_ac10_ideographic_line_separator_is_not_a_newline(self):
        stats = count_text("a" + "\u2028" + "b")
        self.assertEqual(stats["line_count"], 1)
        self.assertEqual(stats["char_count"], 3)
        self.assertEqual(stats["non_empty_line_count"], 1)
        self.assertEqual(stats["word_count"], 2)

    def test_ac10_and_bc04_eight_characters_never_end_a_line(self):
        for character in NON_BOUNDARY_CHARACTERS:
            with self.subTest(character=hex(ord(character))):
                stats = count_text("a" + character + "b")
                self.assertEqual(stats["line_count"], 1)
                self.assertEqual(stats["char_count"], 3)

    def test_bc04_counting_source_never_uses_splitlines(self):
        self.assertNotIn("splitlines", read_text(SCRIPT))


class LineCountTests(unittest.TestCase):
    """AC-11 and AC-13 with BC-05 and BC-06: one split feeds both counters."""

    LINE_AND_NON_EMPTY_TABLE = [
        ("", (0, 0)),
        ("\n", (1, 0)),
        ("a\n", (1, 1)),
        ("a", (1, 1)),
        ("a\nb", (2, 2)),
        ("a\n\n", (2, 1)),
        ("hello world\nfoo bar\n", (2, 2)),
        ("hello world\nfoo bar\n\n", (3, 2)),
        ("  \n\t\n", (2, 0)),
    ]

    def test_ac11_line_count_table(self):
        for text, (lines, non_empty) in self.LINE_AND_NON_EMPTY_TABLE:
            with self.subTest(text=repr(text)):
                stats = count_text(text)
                self.assertEqual(stats["line_count"], lines)
                self.assertEqual(stats["non_empty_line_count"], non_empty)

    def test_ac13_whitespace_lines_are_lines_without_content(self):
        self.assertEqual(count_text("  \n\t\n"), {
            "char_count": 5,
            "line_count": 2,
            "non_empty_line_count": 0,
            "word_count": 0,
        })
        self.assertEqual(count_text("a\n\n")["line_count"], 2)
        self.assertEqual(count_text("a\n\n")["non_empty_line_count"], 1)

    def test_ac13_whitespace_crlf_text_is_five_characters(self):
        # The historical 6 was impossible: 7 raw code points minus the two CR
        # of the CRLF pairs is 5 (BC-03, BC-07).
        self.assertEqual(count_text("  \r\n \r\n"), {
            "char_count": 5,
            "line_count": 2,
            "non_empty_line_count": 0,
            "word_count": 0,
        })

    def test_bc05_trailing_lf_terminates_instead_of_adding_a_line(self):
        self.assertEqual(count_text("a\n")["line_count"], 1)
        self.assertEqual(count_text("a\n\n")["line_count"], 2)
        self.assertEqual(count_text("\n")["line_count"], 1)
        self.assertEqual(count_text("hello world\nfoo bar\n\n")["line_count"], 3)

    def test_bc05_empty_text_has_no_line(self):
        self.assertEqual(count_text("")["line_count"], 0)

    def test_bc06_blank_set_is_str_strip(self):
        for character in BLANK_CHARACTERS:
            with self.subTest(character=hex(ord(character))):
                stats = count_text(character + "\n")
                self.assertEqual(stats["line_count"], 1)
                self.assertEqual(stats["non_empty_line_count"], 0)

    def test_bc06_non_blank_character_keeps_the_line(self):
        stats = count_text("\u00e9\n")
        self.assertEqual(stats["line_count"], 1)
        self.assertEqual(stats["non_empty_line_count"], 1)

    def test_bc06_both_line_counters_share_one_split(self):
        # A single split result explains both numbers for every table row: the
        # non-empty count can never exceed the line count.
        for text, (lines, non_empty) in self.LINE_AND_NON_EMPTY_TABLE:
            with self.subTest(text=repr(text)):
                stats = count_text(text)
                self.assertLessEqual(stats["non_empty_line_count"], lines)
                self.assertEqual(stats["non_empty_line_count"], non_empty)


class CharCountTests(unittest.TestCase):
    """AC-12 with BC-07: the count is code points of the normalised text."""

    def test_ac12_character_count_table(self):
        table = [
            ("", 0),
            (REFERENCE_TEXT, 20),
            ("a\r\nb", 3),
            ("caf\u00e9", 4),
            ("cafe\u0301", 5),
            ("\ufeffabc", 3),
            ("  \r\n \r\n", 5),
        ]
        for text, expected in table:
            with self.subTest(text=repr(text)):
                self.assertEqual(count_text(text)["char_count"], expected)

    def test_bc07_character_count_is_code_points_not_bytes(self):
        # "caf\u00e9" is 4 code points but 5 UTF-8 bytes; the count is 4.
        self.assertEqual(count_text("caf\u00e9")["char_count"], 4)
        self.assertEqual(len("caf\u00e9".encode("utf-8")), 5)


class WordCountTests(unittest.TestCase):
    """AC-14, AC-15, AC-16 with BC-08, BC-09, BC-10, BC-11."""

    WORD_COUNT_TABLE = [
        ("hello world", 2),
        ("Hello hello HELLO", 3),
        ("well-known", 1),
        ("don't", 1),
        ("it" + RSQUO + "s", 1),
        ("a-b-c", 1),
        ("hello--world", 2),
        ("123 456", 0),
        ("abc123", 1),
        ("a1b", 2),
        ("a_b", 2),
        ("foo_bar baz", 3),
        ("caf\u00e9", 1),
        ("caf\u00e9-mocha", 2),
        ("cafe\u0301", 1),
        (" -abc", 1),
        ("abc- ", 1),
        ("'abc", 1),
    ]

    def test_ac14_word_count_basics(self):
        for text, expected in self.WORD_COUNT_TABLE[:7]:
            with self.subTest(text=repr(text)):
                self.assertEqual(count_text(text)["word_count"], expected)

    def test_ac14_case_is_never_folded(self):
        self.assertEqual(count_text("Hello hello HELLO")["word_count"], 3)

    def test_ac15_digits_underscore_and_non_ascii_letters(self):
        cases = self.WORD_COUNT_TABLE[7:15]
        for text, expected in cases:
            with self.subTest(text=repr(text)):
                self.assertEqual(count_text(text)["word_count"], expected)
        # BC-10: a combining acute accent is neither a word character nor a
        # joiner, so it splits nothing and adds nothing.
        self.assertEqual(count_text("cafe\u0301")["word_count"], 1)
        self.assertEqual(count_text("cafe\u0301")["char_count"], 5)

    def test_ac16_joiner_must_touch_letters_on_both_sides(self):
        for text, expected in self.WORD_COUNT_TABLE[15:]:
            with self.subTest(text=repr(text)):
                self.assertEqual(count_text(text)["word_count"], expected)

    def test_bc08_word_pattern_is_exactly_the_documented_regex(self):
        self.assertEqual(
            text_stats.WORD_PATTERN.pattern,
            "[A-Za-z]+(?:[-'\u2019][A-Za-z]+)*",
        )

    def test_bc09_digits_and_underscores_split_letter_runs(self):
        self.assertEqual(count_text("123 456")["word_count"], 0)
        self.assertEqual(count_text("abc123")["word_count"], 1)
        self.assertEqual(count_text("a1b")["word_count"], 2)
        self.assertEqual(count_text("a_b")["word_count"], 2)
        self.assertEqual(count_text("foo_bar baz")["word_count"], 3)

    def test_bc10_non_ascii_letters_and_combining_marks_never_join(self):
        self.assertEqual(count_text("caf\u00e9")["word_count"], 1)
        self.assertEqual(count_text("caf\u00e9-mocha")["word_count"], 2)
        self.assertEqual(count_text("cafe\u0301")["word_count"], 1)

    def test_bc11_joiners(self):
        self.assertEqual(count_text("well-known")["word_count"], 1)
        self.assertEqual(count_text("don't")["word_count"], 1)
        self.assertEqual(count_text("it" + RSQUO + "s")["word_count"], 1)
        self.assertEqual(count_text("a-b-c")["word_count"], 1)
        self.assertEqual(count_text("hello--world")["word_count"], 2)
        self.assertEqual(count_text(" -abc")["word_count"], 1)
        self.assertEqual(count_text("abc- ")["word_count"], 1)
        self.assertEqual(count_text("'abc")["word_count"], 1)


class ProgrammaticCallTests(unittest.TestCase):
    """AC-01, AC-02, AC-18, AC-21, AC-22, AC-23 with BC-02, BC-16, BC-19, BC-20."""

    def test_ac01_programmatic_empty_text_is_silent_zero(self):
        code, stdout, stderr = call_main([], stdin_text="")
        self.assertIs(type(code), int)
        self.assertEqual(code, 0)
        self.assertEqual(stdout, "")
        self.assertEqual(stderr, "")

    def test_ac01_programmatic_call_never_reads_process_stdin(self):
        code, stdout, stderr = call_main(
            [], stdin_text="", process_stdin=_FORBIDDEN_STDIN
        )
        self.assertEqual((code, stdout, stderr), (0, "", ""))

    def test_ac01_programmatic_call_tolerates_missing_sys_stdin(self):
        saved_stdin = sys.stdin
        try:
            sys.stdin = None
            code, stdout, stderr = call_main([], stdin_text="")
        finally:
            sys.stdin = saved_stdin
        self.assertEqual((code, stdout, stderr), (0, "", ""))

    def test_ac02_documented_programmatic_one_liner(self):
        result = run_python_source(
            "import text_stats as t; "
            "code = t.main([], stdin_text=''); "
            "print(callable(t.main), code, type(code).__name__)"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        # The single line comes from the outer print, not from main itself.
        self.assertEqual(result.stdout.splitlines(), ["True 0 int"])
        self.assertEqual(result.stderr, "")

    def test_ac18_programmatic_help_is_silent_zero(self):
        for stdin_text in ("", "anything"):
            with self.subTest(stdin_text=stdin_text):
                code, stdout, stderr = call_main(["--help"], stdin_text=stdin_text)
                self.assertEqual((code, stdout, stderr), (0, "", ""))

    def test_ac21_programmatic_errors_are_silent(self):
        cases = [
            (["missing-file-for-ac21.txt"], ""),
            (["--encoding", "no-such-encoding"], ""),
        ]
        with working_directory(HERE):
            for argv, stdin_text in cases:
                with self.subTest(argv=argv):
                    code, stdout, stderr = call_main(argv, stdin_text=stdin_text)
                    self.assertEqual((code, stdout, stderr), (1, "", ""))

    def test_ac22_invalid_encoding_is_checked_before_the_input(self):
        code, stdout, stderr = call_main(
            ["--encoding", "no-such-encoding"], stdin_text=""
        )
        self.assertEqual((code, stdout, stderr), (1, "", ""))
        cli = run_cli(["--encoding", "no-such-encoding"], stdin_text="")
        self.assertEqual(cli.returncode, 1)
        self.assertEqual(cli.stdout, "")
        self.assertTrue(cli.stderr.startswith("error: "), cli.stderr)

    def test_bc18_invalid_encoding_is_rejected_even_with_a_readable_file(self):
        # BC-18: codecs.lookup runs before any input is selected, so a bad
        # encoding name fails even when the PATH itself would decode fine.
        argv = ["--encoding", "no-such-encoding", "sample_input.txt"]
        with working_directory(HERE):
            code, stdout, stderr = call_main(argv, stdin_text="")
        self.assertEqual((code, stdout, stderr), (1, "", ""))
        cli = run_cli(argv, stdin_text="")
        self.assertEqual(cli.returncode, 1)
        self.assertEqual(cli.stdout, "")
        self.assertTrue(cli.stderr.startswith("error: "), cli.stderr)

    def test_ac23_programmatic_call_with_a_readable_path_is_silent(self):
        # PATH wins over the injected text, yet nothing is printed.
        with working_directory(HERE):
            code, stdout, stderr = call_main(
                ["sample_input.txt"], stdin_text="ignored text"
            )
        self.assertEqual((code, stdout, stderr), (0, "", ""))

    def test_bc02_explicit_empty_string_is_programmatic(self):
        # BC-02: the scope switch is the argument, not the text; the empty
        # string selects the silent scope just like any other text.
        code, stdout, stderr = call_main([], stdin_text="")
        self.assertEqual((code, stdout, stderr), (0, "", ""))
        # The same empty input on the command line prints four zeros (BC-21).
        cli = run_cli([], stdin_text="")
        self.assertEqual(cli.stdout.splitlines(), EMPTY_OUTPUT.splitlines())

    def test_bc16_programmatic_help_never_prints_usage(self):
        for stdin_text in ("", "some text"):
            with self.subTest(stdin_text=stdin_text):
                code, stdout, stderr = call_main(["--help"], stdin_text=stdin_text)
                self.assertEqual((code, stdout, stderr), (0, "", ""))
                self.assertNotIn("usage", stdout)

    def test_bc19_programmatic_call_with_a_missing_path_returns_one_silently(self):
        with working_directory(HERE):
            code, stdout, stderr = call_main(
                ["missing-file-for-bc19.txt"], stdin_text=""
            )
        self.assertEqual((code, stdout, stderr), (1, "", ""))

    def test_bc20_injected_text_is_the_input_but_never_a_return_value(self):
        code, stdout, stderr = call_main([], stdin_text="one two three")
        self.assertEqual((code, stdout, stderr), (0, "", ""))
        self.assertEqual(count_text("one two three")["word_count"], 3)

    def test_bc20_main_returns_an_int_and_no_statistics(self):
        result = main([], stdin_text=STDIN_TEXT)
        self.assertIs(type(result), int)
        self.assertEqual(result, 0)


class CommandLineSuccessTests(ErrorContractAssertions):
    """AC-03, AC-04, AC-05, AC-06, AC-07 with BC-13, BC-14, BC-21."""

    def test_ac03_immediate_eof_prints_four_zeros(self):
        result = run_cli_bytes([], b"")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.decode("utf-8").splitlines(),
            EMPTY_OUTPUT.splitlines(),
        )
        self.assertEqual(result.stderr, b"")

    def test_ac04_sample_file_as_path(self):
        result = run_cli(["sample_input.txt"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), REFERENCE_OUTPUT.splitlines())
        self.assertEqual(result.stderr, "")

    def test_ac05_standard_input(self):
        result = run_cli_bytes([], STDIN_TEXT.encode("utf-8"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.decode("utf-8").splitlines(),
            STDIN_OUTPUT.splitlines(),
        )
        self.assertEqual(result.stderr, b"")

    def test_ac06_file_and_stdin_paths_agree(self):
        from_file = run_cli(["sample_input.txt"])
        from_stdin = run_cli_bytes([], REFERENCE_TEXT.encode("utf-8"))
        self.assertEqual(parse_stats(from_file.stdout), REFERENCE_STATS)
        self.assertEqual(
            parse_stats(from_stdin.stdout.decode("utf-8")), REFERENCE_STATS
        )
        self.assertEqual(count_text(REFERENCE_TEXT), REFERENCE_STATS)

    def test_ac07_output_format_is_four_key_value_lines(self):
        result = run_cli(["sample_input.txt"])
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 4)
        self.assertEqual(
            [line.partition(": ")[0] for line in lines], list(OUTPUT_KEY_ORDER)
        )
        for line in lines:
            self.assertRegex(line, OUTPUT_LINE_PATTERN)
        self.assertFalse(result.stdout.endswith("\n\n"))

    def test_bc13_four_logical_lines_and_nothing_else(self):
        result = run_cli(["sample_input.txt"])
        # Exactly four LF-separated lines, one trailing LF and no fifth line.
        self.assertEqual(result.stdout.count("\n"), 4)
        self.assertEqual(result.stdout.splitlines(), REFERENCE_OUTPUT.splitlines())
        self.assertEqual(parse_stats(result.stdout), REFERENCE_STATS)

    def test_bc14_four_logical_lines_survive_host_newline_translation(self):
        # BC-14: the contract is four logical lines separated by LF.  A host
        # that writes CRLF must not be judged as a failure, so the comparison is
        # made on decoded text and on the LF-separated line count.
        result = run_cli_bytes(["sample_input.txt"], b"")
        decoded = result.stdout.decode("utf-8")
        self.assertEqual(len(decoded.splitlines()), 4)
        self.assertEqual(len(decoded.split("\n")), 5)
        self.assertTrue(decoded.endswith("\n"))

    def test_bc21_empty_standard_input_is_zero_lines_not_an_error(self):
        result = run_cli([])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), EMPTY_OUTPUT.splitlines())
        self.assertEqual(result.stderr, "")

    def test_bc21_zero_byte_file_prints_four_zeros(self):
        with scratch_file("empty.txt", b"", binary=True) as path:
            result = run_cli([scratch_argument(path)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), EMPTY_OUTPUT.splitlines())
        self.assertEqual(result.stderr, "")


class HelpTests(ErrorContractAssertions):
    """AC-17 with BC-15: help text belongs to the command line scope only."""

    def test_ac17_command_line_help(self):
        result = run_cli(["--help"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PATH", result.stdout)
        self.assertIn("--encoding", result.stdout)
        self.assertIn("usage", result.stdout.lower())
        self.assertEqual(result.stderr, "")

    def test_bc15_help_wins_over_extra_positional_arguments(self):
        result = run_cli(["--help", "a.txt", "b.txt"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("usage", result.stdout.lower())
        self.assertNotIn("char_count:", result.stdout)


class CommandLineErrorTests(ErrorContractAssertions):
    """AC-19, AC-20 with BC-17 and BC-25."""

    def assert_error_run(self, result):
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertEqual(result.stdout, "")
        self.assert_single_error_line(result.stderr)

    def test_ac19_missing_file(self):
        self.assert_error_run(run_cli(["missing-file-for-ac19.txt"]))

    def test_ac19_more_than_one_positional_argument(self):
        result = run_cli(["a.txt", "b.txt"])
        self.assert_error_run(result)
        # Never argparse's default 2 (BC-25).
        self.assertNotEqual(result.returncode, 2)

    def test_ac20_directory_as_path(self):
        self.assert_error_run(run_cli(["."]))

    def test_ac20_undecodable_file(self):
        with scratch_file("bad-bytes.bin", b"\xff", binary=True) as path:
            result = run_cli([scratch_argument(path)])
        self.assert_error_run(result)
        # The file exists: this must be a decode failure, not a missing path.
        self.assertNotIn("No such file", result.stderr)

    def test_ac20_unknown_encoding_name(self):
        self.assert_error_run(run_cli(["--encoding", "no-such-encoding"]))

    def test_bc17_every_error_is_one_readable_line_without_traceback(self):
        for args in (
            ["missing-file-for-bc17.txt"],
            [".", "--encoding", "utf-8"],
            ["a.txt", "b.txt"],
        ):
            with self.subTest(args=args):
                self.assert_error_run(run_cli(args))

    def test_bc17_dash_is_a_plain_filename_not_stdin(self):
        self.assert_error_run(run_cli(["-"]))

    def test_bc25_exit_codes_are_only_zero_or_one(self):
        cases = [
            (["sample_input.txt"], ""),
            ([], ""),
            (["--help"], ""),
            (["missing-file-for-bc25.txt"], ""),
            (["--encoding", "no-such-encoding"], ""),
            (["a.txt", "b.txt"], ""),
        ]
        for args, stdin_text in cases:
            with self.subTest(args=args):
                self.assertIn(run_cli(args, stdin_text=stdin_text).returncode, (0, 1))


class EncodingTests(unittest.TestCase):
    """BC-21, BC-22, BC-23: which stream --encoding may touch and when."""

    def test_bc22_encoding_option_decodes_a_utf16le_file(self):
        payload = "abc\n".encode("utf-16-le")
        with scratch_file("utf16le.txt", payload, binary=True) as path:
            result = run_cli(
                [scratch_argument(path), "--encoding", "utf-16-le"]
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.splitlines(),
            [
                "char_count: 4",
                "line_count: 1",
                "non_empty_line_count: 1",
                "word_count: 1",
            ],
        )

    def test_bc22_file_bytes_keep_their_newlines_for_count_text(self):
        with scratch_file("crlf-cr.txt", b"a\r\nb\rc", binary=True) as path:
            result = run_cli([scratch_argument(path)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            parse_stats(result.stdout),
            {"char_count": 5, "line_count": 3,
             "non_empty_line_count": 3, "word_count": 3},
        )

    def test_bc21_encoding_option_never_touches_standard_input(self):
        result = run_cli_bytes(["--encoding", "utf-16-le"], b"hello world\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            parse_stats(result.stdout.decode("utf-8")),
            {"char_count": 12, "line_count": 1,
             "non_empty_line_count": 1, "word_count": 2},
        )

    def test_bc21_standard_input_uses_the_host_stream_encoding(self):
        # ASCII bytes decode identically in every host encoding, so the four
        # numbers are stable; this pins that stdin is not decoded as UTF-16.
        result = run_cli_bytes([], b"abc\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            parse_stats(result.stdout.decode("utf-8")),
            {"char_count": 4, "line_count": 1,
             "non_empty_line_count": 1, "word_count": 1},
        )

    def test_bc23_file_and_stdin_values_match_for_the_same_decoded_text(self):
        payload = b"a\r\nb\rc"
        with scratch_file("same-text.txt", payload, binary=True) as path:
            from_file = run_cli([scratch_argument(path)])
        from_stdin = run_cli_bytes([], payload)
        self.assertEqual(from_file.returncode, 0, from_file.stderr)
        self.assertEqual(from_stdin.returncode, 0, from_stdin.stderr)
        self.assertEqual(
            parse_stats(from_file.stdout),
            parse_stats(from_stdin.stdout.decode("utf-8")),
        )


class ArgvTests(unittest.TestCase):
    """AC-25 with BC-24: ``argv=None`` means ``sys.argv[1:]``, no program name."""

    def test_ac25_explicit_argv_list_is_the_path(self):
        result = run_python_source(
            "import text_stats as t; "
            "raise SystemExit(t.main(['sample_input.txt']))"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), REFERENCE_OUTPUT.splitlines())

    def test_bc24_argv_none_reads_sys_argv_without_the_program_name(self):
        with working_directory(HERE):
            with patched_argv([SCRIPT, "sample_input.txt"]):
                code, stdout, _ = call_main()
        self.assertEqual(code, 0)
        self.assertEqual(stdout, REFERENCE_OUTPUT)

    def test_bc24_program_name_is_never_a_positional_argument(self):
        with working_directory(HERE):
            with patched_argv([SCRIPT]):
                code, stdout, _ = call_main(process_stdin=REFERENCE_TEXT)
        self.assertEqual(code, 0)
        self.assertEqual(stdout, REFERENCE_OUTPUT)

    def test_bc24_explicit_argv_never_includes_the_program_name(self):
        with working_directory(HERE):
            code, stdout, _ = call_main(["sample_input.txt"])
        self.assertEqual(code, 0)
        self.assertEqual(stdout, REFERENCE_OUTPUT)


class EntryPointTests(unittest.TestCase):
    """AC-24 with BC-24, BC-25: signature, one ``sys.exit`` and exit-code set."""

    def test_ac24_main_signature_defaults_are_none(self):
        parameters = inspect.signature(main).parameters
        self.assertEqual(list(parameters), ["argv", "stdin_text"])
        self.assertIsNone(parameters["argv"].default)
        self.assertIsNone(parameters["stdin_text"].default)

    def test_ac24_sys_exit_appears_once_inside_the_main_guard(self):
        source = read_text(SCRIPT)
        self.assertEqual(source.count("sys.exit("), 1)
        module = ast.parse(source)
        guards = [
            node
            for node in module.body
            if isinstance(node, ast.If)
            and "__main__" in ast.unparse(node.test)
        ]
        self.assertEqual(len(guards), 1)
        exits = [
            node
            for node in ast.walk(guards[0])
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "exit"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "sys"
        ]
        self.assertEqual(len(exits), 1)

    def test_ac24_main_never_raises_system_exit(self):
        for argv, stdin_text in (
            ([], ""),
            (["--help"], ""),
            (["--encoding", "no-such-encoding"], ""),
            (["missing-file-for-ac24.txt"], ""),
            (["a.txt", "b.txt"], ""),
        ):
            with self.subTest(argv=argv):
                self.assertIn(call_main(argv, stdin_text=stdin_text)[0], (0, 1))

    def test_ac24_importing_the_module_is_silent(self):
        result = run_python_source("import text_stats")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "")

    def test_bc25_usage_error_never_uses_argparse_default_two(self):
        result = run_cli(["a.txt", "b.txt"])
        self.assertEqual(result.returncode, 1)
        self.assertNotEqual(result.returncode, 2)


class DeliveryConstraintTests(ErrorContractAssertions):
    """AC-26 .. AC-29 with BC-26 .. BC-30."""

    ALLOWED_FILES = {
        ".gitignore",
        "README.md",
        "sample_input.txt",
        "test_text_stats.py",
        "text_stats.py",
    }
    ALLOWED_DIRECTORIES = {".test-scratch", "__pycache__"}
    DEPENDENCY_MANIFESTS = {
        "requirements.txt",
        "pyproject.toml",
        "setup.py",
        "Pipfile",
        "Pipfile.lock",
        "poetry.lock",
    }
    STANDARD_LIBRARY_MODULES = {
        "argparse", "ast", "codecs", "contextlib", "hashlib", "inspect", "io",
        "os", "pathlib", "re", "subprocess", "sys", "unittest",
    }

    def test_ac29_delivery_directory_holds_only_the_agreed_files(self):
        names = set(os.listdir(HERE))
        self.assertEqual(names - self.ALLOWED_DIRECTORIES - self.ALLOWED_FILES, set())
        for required in ("text_stats.py", "test_text_stats.py", "README.md",
                         "sample_input.txt"):
            self.assertTrue(os.path.isfile(os.path.join(HERE, required)), required)

    def test_ac26_no_dependency_manifest_is_delivered(self):
        self.assertEqual(
            set(os.listdir(HERE)) & self.DEPENDENCY_MANIFESTS, set()
        )

    def test_ac26_both_modules_import_only_the_standard_library(self):
        allowed = self.STANDARD_LIBRARY_MODULES | {"text_stats"}
        for file_name in ("text_stats.py", "test_text_stats.py"):
            with self.subTest(module=file_name):
                module = ast.parse(read_text(os.path.join(HERE, file_name)))
                imported = set()
                for node in ast.walk(module):
                    if isinstance(node, ast.Import):
                        imported.update(
                            alias.name.split(".")[0] for alias in node.names
                        )
                    elif isinstance(node, ast.ImportFrom) and node.module:
                        imported.add(node.module.split(".")[0])
                self.assertEqual(imported - allowed, set(), imported)

    def test_bc26_module_imports_named_standard_library_modules(self):
        self.assertEqual(
            set(text_stats.__dict__) & {"argparse", "codecs", "re", "sys"},
            {"argparse", "codecs", "re", "sys"},
        )

    def test_ac28_bytecode_cache_is_unchanged_by_a_cli_run(self):
        before = pycache_snapshot()
        result = run_cli(["sample_input.txt"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(pycache_snapshot(), before)

    def test_bc28_child_interpreters_run_without_bytecode(self):
        env = python_env()
        self.assertEqual(env["PYTHONDONTWRITEBYTECODE"], "1")

    def test_bc27_scratch_fixtures_are_flat_files_and_are_removed(self):
        with scratch_file("flat-check.txt", "payload") as path:
            self.assertEqual(os.path.dirname(path), SCRATCH_ROOT)
            self.assertTrue(os.path.isfile(path))
        self.assertFalse(os.path.exists(path))

    def test_bc27_scratch_root_is_inside_the_delivery_directory(self):
        self.assertEqual(os.path.dirname(SCRATCH_ROOT), HERE)

    def test_ac27_sample_input_is_twenty_lf_bytes(self):
        with open(SAMPLE_INPUT, "rb") as handle:
            payload = handle.read()
        self.assertEqual(payload, b"hello world\nfoo bar\n")
        self.assertEqual(len(payload), 20)

    def test_bc29_sample_input_content(self):
        with open(SAMPLE_INPUT, "rb") as handle:
            payload = handle.read()
        self.assertTrue(payload.endswith(b"\n"))
        self.assertEqual(payload.split(b"\n")[:-1], [b"hello world", b"foo bar"])

    def test_ac27_readme_reference_values_match_the_implementation(self):
        readme = read_text(README)
        for line in REFERENCE_OUTPUT.splitlines():
            self.assertIn(line, readme)
        for line in STDIN_OUTPUT.splitlines():
            self.assertIn(line, readme)
        self.assertEqual(count_text(REFERENCE_TEXT), REFERENCE_STATS)

    def test_ac27_readme_never_cites_a_missing_example_file(self):
        # A previous round shipped an example that read a file which did not
        # exist in the delivery directory; that must never come back.
        readme = read_text(README)
        self.assertNotIn("crlf" + "_cr.txt", readme)

    def test_ac27_no_bare_u2019_character_anywhere(self):
        for name in ("text_stats.py", "test_text_stats.py", "README.md"):
            with self.subTest(file=name):
                content = read_text(os.path.join(HERE, name))
                self.assertNotIn(RSQUO, content)

    def test_ac27_crlf_whitespace_value_is_five_never_six(self):
        readme = read_text(README)
        self.assertNotIn("char_count: 6", readme)
        self.assertEqual(count_text("  \r\n \r\n")["char_count"], 5)

    def test_ac27_documents_and_tests_cite_this_rounds_numbers(self):
        pattern = re.compile(r"(AC|BC)-(\d{2})")
        for name in ("test_text_stats.py", "README.md"):
            with self.subTest(file=name):
                content = read_text(os.path.join(HERE, name))
                for kind, number in pattern.findall(content):
                    limit = 29 if kind == "AC" else 30
                    self.assertLessEqual(int(number), limit, (kind, number))

    def test_ac27_every_criterion_number_is_referenced(self):
        # Method names spell their criterion as "ac09" while docstrings write
        # "AC-09", so both spellings are accepted; the search is lower case.
        content = read_text(os.path.join(HERE, "test_text_stats.py")).lower()

        def referenced(token):
            return token in content or token.replace("-", "") in content

        missing = []
        for number in range(1, 30):
            if not referenced("ac-{0:02d}".format(number)):
                missing.append("AC-{0:02d}".format(number))
        for number in range(1, 31):
            if not referenced("bc-{0:02d}".format(number)):
                missing.append("BC-{0:02d}".format(number))
        self.assertEqual(missing, [])

    def test_bc30_readme_declares_the_delivered_coverage(self):
        readme = read_text(README)
        self.assertIn("AC-01", readme)
        self.assertIn("AC-29", readme)
        self.assertIn("BC-01", readme)
        self.assertIn("BC-30", readme)


if __name__ == "__main__":
    unittest.main()
