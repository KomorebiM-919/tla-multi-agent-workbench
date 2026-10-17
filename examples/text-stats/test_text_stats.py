"""Unit tests for text_stats (standard library ``unittest`` only).

Coverage map: every acceptance criterion AC-01 .. AC-27 and every boundary
condition BC-01 .. BC-27 of this round is covered by at least one test whose
name (or the comment above it) carries the criterion number.  The pure-function
criteria are checked against ``count_text`` directly; the command line criteria
are checked against a real subprocess so that exit code, standard output and
standard error are observed exactly as an operator would see them.

Facts pinned here, with the rules they come from:

* only LF, CR and CRLF end a line, so U+2028, U+2029, ``\\x0b``, ``\\x0c``,
  ``\\x1c``, ``\\x1d``, ``\\x1e`` and ``\\x85`` stay inside the line content and
  ``str.splitlines()`` is never the line counter (BC-01);
* normalisation drops one leading U+FEFF, then turns CRLF into LF, then turns
  the remaining lone CR into LF, and does nothing else (BC-02, BC-03, BC-27);
* the line count has one definition only: split on LF, drop the empty segment
  a trailing LF leaves behind, and an empty text has no line (BC-04, BC-05);
* a programmatic call - an explicit ``stdin_text`` argument, ``""`` included -
  prints nothing at all, while only a command line run prints the four lines
  (BC-15, BC-16);
* every handled error is exit code 1 with exactly one ``error: `` line on the
  command line and complete silence programmatically, never argparse's default
  2 (BC-17, BC-18, BC-20, BC-21).

The DSH file sandbox denies writes outside the workspace (including the system
temporary directory), so transient fixtures are written as flat files into the
pre-existing scratch directory ``.test-scratch`` and removed by the owning test
(BC-25).
"""

import ast
import builtins
import contextlib
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

# U+2019 RIGHT SINGLE QUOTATION MARK.  Spelled with an escape (or named by code
# point) everywhere in this file, in the module and in the README so that no
# bare, unidentifiable look-alike apostrophe ever appears (AC-26).
RSQUO = "\u2019"

# A subprocess that hangs would be a bug; AC-03 requires finishing well inside
# ten seconds, and every other subprocess gets the same ceiling.
CLI_TIMEOUT = 10

# The reference text delivered as sample_input.txt: 20 code points, 2 lines,
# 2 non-empty lines, 4 words (AC-04, AC-07, AC-08, AC-25, BC-08).
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
# AC-22 / AC-25: the documented standard input example.
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

# BC-01: the characters ``str.splitlines()`` would wrongly treat as line
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

# BC-07: characters that ``str.strip()`` removes, i.e. that make a line empty
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
    """Run the module with *payload* bytes on standard input (AC-08)."""
    return subprocess.run(
        [sys.executable, SCRIPT] + list(args),
        input=payload,
        capture_output=True,
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


class _StreamMustNotBeRead(Exception):
    """Raised when a programmatic call touches the process standard input."""


class _ForbiddenStdin:
    """Stand-in for ``sys.stdin`` whose every read is a failure (BC-15)."""

    def read(self, *args, **kwargs):
        raise _StreamMustNotBeRead("programmatic call read sys.stdin")


_FORBIDDEN_STDIN = _ForbiddenStdin()


@contextlib.contextmanager
def patched_argv(values):
    """Install *values* as ``sys.argv`` for the duration of the block (BC-19)."""
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


class ErrorContractAssertions(unittest.TestCase):
    """Shared assertions for the command line error contract (BC-21)."""

    def assert_single_error_line(self, stderr):
        """stderr must be exactly one readable line starting with ``error: ``."""
        self.assertTrue(stderr.startswith("error: "), stderr)
        self.assertEqual(len(stderr.splitlines()), 1, stderr)
        self.assertNotIn("Traceback", stderr)


class CountTextInterfaceTests(unittest.TestCase):
    """BC-23 with AC-04 and AC-05."""

    def test_ac04_reference_text_returns_exactly_four_integer_keys(self):
        stats = count_text(REFERENCE_TEXT)
        self.assertIsInstance(stats, dict)
        self.assertEqual(set(stats), set(OUTPUT_KEY_ORDER))
        self.assertEqual(len(stats), 4)
        for key in OUTPUT_KEY_ORDER:
            self.assertIs(type(stats[key]), int, key)
        self.assertEqual(
            (
                stats["char_count"],
                stats["line_count"],
                stats["non_empty_line_count"],
                stats["word_count"],
            ),
            (20, 2, 2, 4),
        )

    def test_bc23_count_text_is_pure_and_reads_no_file_or_stream(self):
        # BC-23: count_text takes already decoded text; a file lookup or a
        # stream read from inside it would raise this assertion.
        original_open = builtins.open
        builtins.open = lambda *args, **kwargs: self.fail(
            "count_text must not open any file"
        )
        try:
            stats = count_text(REFERENCE_TEXT)
        finally:
            builtins.open = original_open
        self.assertEqual(stats, REFERENCE_STATS)

    def test_bc23_count_text_writes_nothing(self):
        out, err = io.StringIO(), io.StringIO()
        saved_stdin = sys.stdin
        try:
            sys.stdin = _FORBIDDEN_STDIN
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                count_text(REFERENCE_TEXT)
        finally:
            sys.stdin = saved_stdin
        self.assertEqual((out.getvalue(), err.getvalue()), ("", ""))

    def test_ac05_whitespace_lines_are_five_characters_never_six(self):
        # 7 raw code points minus the two CRs of the CRLF pairs = 5 (AC-05).
        stats = count_text("  \r\n \r\n")
        self.assertEqual(
            stats,
            {
                "char_count": 5,
                "line_count": 2,
                "non_empty_line_count": 0,
                "word_count": 0,
            },
        )
        self.assertNotEqual(stats["char_count"], 6)


class NormalisationTests(unittest.TestCase):
    """BC-01, BC-02, BC-03, BC-08, BC-27 with AC-14 and AC-17."""

    def test_bc01_non_boundary_characters_stay_inside_the_line(self):
        for character in NON_BOUNDARY_CHARACTERS:
            with self.subTest(character=hex(ord(character))):
                stats = count_text("a" + character + "b")
                self.assertEqual(stats["line_count"], 1)
                self.assertEqual(stats["char_count"], 3)
                self.assertEqual(stats["non_empty_line_count"], 1)

    def test_bc01_u2028_and_u2029_are_not_line_breaks(self):
        # AC-14 states this for U+2028; BC-01 states it for U+2029 as well.
        self.assertEqual(count_text("a\u2028b")["line_count"], 1)
        self.assertEqual(count_text("a\u2028b")["char_count"], 3)
        self.assertEqual(count_text("a\u2029b")["line_count"], 1)

    def test_bc01_line_count_is_not_str_splitlines(self):
        text = "a\u2028b"
        self.assertEqual(len(text.splitlines()), 2)
        self.assertEqual(count_text(text)["line_count"], 1)

    def test_bc02_crlf_is_replaced_before_lone_cr(self):
        # "\r\r\n" must first lose the CRLF pair, leaving one CR that becomes
        # LF: 2 code points and 2 lines.  Replacing CR first would give 3.
        stats = count_text("\r\r\n")
        self.assertEqual(stats["char_count"], 2)
        self.assertEqual(stats["line_count"], 2)

    def test_bc02_crlf_and_lone_cr_are_normalised_to_lf(self):
        crlf = count_text("a\r\nb")
        self.assertEqual(
            (crlf["char_count"], crlf["line_count"], crlf["word_count"]), (3, 2, 2)
        )
        self.assertEqual((crlf["non_empty_line_count"]), 2)
        lone_cr = count_text("a\rb")
        self.assertEqual(
            (lone_cr["char_count"], lone_cr["line_count"], lone_cr["word_count"]),
            (3, 2, 2),
        )

    def test_bc03_only_one_leading_bom_is_dropped(self):
        self.assertEqual(count_text("\ufeffabc")["char_count"], 3)
        self.assertEqual(count_text("\ufeff\ufeffabc")["char_count"], 4)
        # The second U+FEFF is neither white space nor a word character.
        self.assertEqual(count_text("\ufeff\ufeffabc")["word_count"], 1)

    def test_bc08_character_count_counts_code_points(self):
        self.assertEqual(count_text(REFERENCE_TEXT)["char_count"], 20)
        self.assertEqual(count_text("a\r\nb")["char_count"], 3)
        self.assertEqual(count_text("\ufeffabc")["char_count"], 3)
        self.assertEqual(count_text("cafe\u0301")["char_count"], 5)

    def test_ac14_bom_and_u2028_rules(self):
        self.assertEqual(count_text("\ufeffabc")["char_count"], 3)
        self.assertEqual(count_text("\ufeff\ufeffabc")["char_count"], 4)
        self.assertEqual(count_text("a\u2028b")["line_count"], 1)
        self.assertEqual(count_text("a\u2028b")["char_count"], 3)

    def test_ac17_character_counts_cover_the_documented_inputs(self):
        self.assertEqual(count_text(REFERENCE_TEXT)["char_count"], 20)
        crlf = count_text("a\r\nb")
        self.assertEqual(
            (
                crlf["char_count"],
                crlf["line_count"],
                crlf["non_empty_line_count"],
                crlf["word_count"],
            ),
            (3, 2, 2, 2),
        )
        self.assertEqual(count_text("caf\u00e9")["char_count"], 4)
        self.assertEqual(count_text("cafe\u0301")["char_count"], 5)

    def test_bc27_no_unicode_normalisation(self):
        precomposed = count_text("caf\u00e9")
        decomposed = count_text("cafe\u0301")
        self.assertEqual((precomposed["char_count"], precomposed["word_count"]), (4, 1))
        self.assertEqual((decomposed["char_count"], decomposed["word_count"]), (5, 1))

    def test_bc27_nbsp_and_ideographic_space_are_preserved(self):
        stats = count_text("\u3000\n")
        self.assertEqual(stats["char_count"], 2)
        self.assertEqual(stats["line_count"], 1)
        self.assertEqual(stats["non_empty_line_count"], 0)
        self.assertEqual(count_text("\u00a0")["char_count"], 1)


class LineCountTests(unittest.TestCase):
    """BC-04, BC-05 with AC-15 and AC-16."""

    def test_ac15_line_count_table(self):
        cases = (
            ("", 0),
            ("\n", 1),
            ("a", 1),
            ("a\n", 1),
            ("a\nb", 2),
            ("a\n\n", 2),
            ("hello world\nfoo bar\n", 2),
            ("hello world\nfoo bar\n\n", 3),
            ("  \n\t\n", 2),
        )
        for text, expected in cases:
            with self.subTest(text=repr(text)):
                self.assertEqual(count_text(text)["line_count"], expected)

    def test_bc04_split_rule(self):
        self.assertEqual(count_text("")["line_count"], 0)
        self.assertEqual(count_text("a")["line_count"], 1)
        self.assertEqual(count_text("\n")["line_count"], 1)
        self.assertEqual(count_text("a\n")["line_count"], 1)
        self.assertEqual(count_text("a\nb")["line_count"], 2)

    def test_bc05_consecutive_and_trailing_line_breaks(self):
        self.assertEqual(count_text("a\n\n")["line_count"], 2)
        self.assertEqual(count_text("hello world\nfoo bar\n\n")["line_count"], 3)
        self.assertEqual(count_text("  \n\t\n")["line_count"], 2)
        self.assertEqual(count_text("a\n\nb")["line_count"], 3)


class NonEmptyLineTests(unittest.TestCase):
    """BC-06, BC-07 with AC-16."""

    def test_ac16_line_and_non_empty_counts_come_from_one_split(self):
        self.assertEqual(
            count_text("  \n\t\n")["line_count"],
            2,
        )
        self.assertEqual(count_text("  \n\t\n")["non_empty_line_count"], 0)
        self.assertEqual(count_text("a\n\n")["line_count"], 2)
        self.assertEqual(count_text("a\n\n")["non_empty_line_count"], 1)

    def test_bc06_a_blank_line_is_empty_but_still_a_line(self):
        stats = count_text("alpha\n \t \nbeta\n")
        self.assertEqual(stats["line_count"], 3)
        self.assertEqual(stats["non_empty_line_count"], 2)
        self.assertEqual(count_text("\n\n")["non_empty_line_count"], 0)

    def test_bc07_blank_set_is_str_strip(self):
        for character in BLANK_CHARACTERS:
            with self.subTest(character=hex(ord(character))):
                self.assertEqual(character.strip(), "")
                stats = count_text(character + "\n")
                self.assertEqual(stats["line_count"], 1)
                self.assertEqual(stats["non_empty_line_count"], 0)

    def test_ac16_reference_text_has_two_non_empty_lines(self):
        self.assertEqual(count_text(REFERENCE_TEXT)["non_empty_line_count"], 2)


class WordCountTests(unittest.TestCase):
    """BC-09 .. BC-12 with AC-18 .. AC-21."""

    def test_bc09_words_use_the_documented_regular_expression(self):
        expected = "[A-Za-z]+(?:[-'" + RSQUO + "][A-Za-z]+)*"
        self.assertEqual(text_stats.WORD_PATTERN.pattern, expected)
        self.assertEqual(text_stats.RIGHT_SINGLE_QUOTATION_MARK, RSQUO)

    def test_ac18_basic_word_rules(self):
        self.assertEqual(count_text("hello world")["word_count"], 2)
        self.assertEqual(count_text("Hello hello HELLO")["word_count"], 3)
        self.assertEqual(count_text("well-known")["word_count"], 1)
        self.assertEqual(count_text("don't")["word_count"], 1)
        self.assertEqual(count_text("it" + RSQUO + "s")["word_count"], 1)
        self.assertEqual(count_text("a-b-c")["word_count"], 1)
        self.assertEqual(count_text("hello--world")["word_count"], 2)

    def test_ac19_digits_and_underscores_are_not_word_characters(self):
        """AC-19: digits and underscores are not word characters."""
        self.assertEqual(count_text("123 456")["word_count"], 0)
        self.assertEqual(count_text("abc123")["word_count"], 1)
        self.assertEqual(count_text("a1b")["word_count"], 2)
        self.assertEqual(count_text("a_b")["word_count"], 2)
        self.assertEqual(count_text("foo_bar baz")["word_count"], 3)

    def test_bc10_digits_and_underscores_split_letter_runs(self):
        """BC-10: digits and underscores split ASCII letter runs."""
        self.assertEqual(count_text("a1b")["word_count"], 2)
        self.assertEqual(count_text("foo_bar baz")["word_count"], 3)
        self.assertEqual(count_text("x_y z9")["word_count"], 3)

    def test_ac20_non_ascii_letters_are_not_word_characters(self):
        self.assertEqual(count_text("caf\u00e9")["word_count"], 1)
        self.assertEqual(count_text("caf\u00e9-mocha")["word_count"], 2)
        self.assertEqual(count_text("cafe\u0301")["word_count"], 1)
        # AC-20: "cafe" + U+0301 must never be reported as two words.
        for text in ("caf\u00e9", "cafe\u0301"):
            with self.subTest(text=repr(text)):
                self.assertNotEqual(count_text(text)["word_count"], 2)

    def test_bc11_non_ascii_letters_and_combining_marks_are_not_joiners(self):
        """BC-11: non-ASCII letters and combining marks are never joiners."""
        self.assertEqual(count_text("caf\u00e9")["word_count"], 1)
        self.assertEqual(count_text("caf\u00e9-mocha")["word_count"], 2)
        self.assertEqual(count_text("cafe\u0301")["word_count"], 1)
        self.assertEqual(count_text("\u4f60\u597d")["word_count"], 0)
        # An em dash is not one of the three joiners either.
        self.assertEqual(count_text("well\u2014known")["word_count"], 2)

    def test_bc12_combining_accent_words_are_never_two(self):
        decomposed = count_text("cafe\u0301")
        precomposed = count_text("caf\u00e9")
        self.assertEqual((decomposed["char_count"], decomposed["word_count"]), (5, 1))
        self.assertEqual((precomposed["char_count"], precomposed["word_count"]), (4, 1))
        self.assertNotEqual(decomposed["word_count"], 2)
        self.assertNotEqual(precomposed["word_count"], 2)

    def test_ac21_joiners_must_touch_ascii_letters_on_both_sides(self):
        self.assertEqual(count_text(" -abc")["word_count"], 1)
        self.assertEqual(count_text("abc- ")["word_count"], 1)
        self.assertEqual(count_text("'abc")["word_count"], 1)
        self.assertEqual(count_text("a-")["word_count"], 1)
        self.assertEqual(count_text("-a")["word_count"], 1)


class ProgrammaticCallTests(unittest.TestCase):
    """Scope rule a: BC-15, BC-17 with AC-01, AC-02, AC-09 and AC-12."""

    def test_ac01_programmatic_empty_text_returns_zero_int_silently(self):
        code, out, err = call_main([], stdin_text="")
        self.assertEqual((code, out, err), (0, "", ""))
        self.assertIs(type(code), int)

    def test_ac01_programmatic_call_with_devnull_stdin_returns_zero(self):
        # The same call with the process standard input attached to DEVNULL
        # still returns 0, proving the call never waits for or reads it.
        program = "import text_stats as t; print(t.main([], stdin_text=''))"
        result = subprocess.run(
            [sys.executable, "-c", program],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=HERE,
            env=python_env(),
            timeout=CLI_TIMEOUT,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.splitlines(), ["0"])
        self.assertEqual(result.stderr, "")

    def test_ac02_documented_programmatic_one_liner_prints_only_its_values(self):
        program = (
            "import text_stats as t; code = t.main([], stdin_text=''); "
            "print(callable(t.main), code, type(code).__name__)"
        )
        result = subprocess.run(
            [sys.executable, "-c", program],
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=HERE,
            env=python_env(),
            timeout=CLI_TIMEOUT,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.splitlines(), ["True 0 int"])
        self.assertEqual(result.stderr, "")

    def test_bc15_programmatic_call_never_reads_process_stdin(self):
        code, out, err = call_main(
            [], stdin_text="ignored text", process_stdin=_FORBIDDEN_STDIN
        )
        self.assertEqual((code, out, err), (0, "", ""))

    def test_bc15_programmatic_call_writes_nothing_whatever_the_text(self):
        for text in ("", REFERENCE_TEXT, "a\r\nb\rc"):
            with self.subTest(text=repr(text)):
                self.assertEqual(call_main([], stdin_text=text), (0, "", ""))

    def test_bc15_programmatic_call_with_a_readable_path_is_silent(self):
        self.assertEqual(call_main([SAMPLE_INPUT], stdin_text="ignored"), (0, "", ""))

    def test_ac09_programmatic_help_returns_zero_and_writes_nothing(self):
        self.assertEqual(call_main(["--help"], stdin_text=""), (0, "", ""))
        self.assertEqual(
            call_main(["--help"], stdin_text="", process_stdin=_FORBIDDEN_STDIN),
            (0, "", ""),
        )

    def test_ac12_programmatic_missing_file_is_a_silent_error(self):
        self.assertEqual(call_main(["missing-file.txt"], stdin_text=""), (1, "", ""))

    def test_ac12_programmatic_unknown_encoding_is_a_silent_error(self):
        self.assertEqual(
            call_main(["--encoding", "no-such-codec"], stdin_text=""), (1, "", "")
        )

    def test_bc17_programmatic_path_and_encoding_still_participate(self):
        self.assertEqual(call_main(["missing-file.txt"], stdin_text=""), (1, "", ""))
        self.assertEqual(call_main([HERE], stdin_text=""), (1, "", ""))
        self.assertEqual(
            call_main(["--encoding", "no-such-codec"], stdin_text=""), (1, "", "")
        )


class CommandLineSuccessTests(ErrorContractAssertions):
    """Scope rule b success paths: BC-16, BC-22, BC-24 with AC-03, AC-07, AC-08, AC-09."""

    def test_ac03_immediate_eof_prints_four_zeros(self):
        result = subprocess.run(
            [sys.executable, SCRIPT],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=HERE,
            env=python_env(),
            timeout=CLI_TIMEOUT,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.splitlines(), EMPTY_OUTPUT.splitlines())
        self.assertEqual(result.stderr, "")

    def test_ac07_command_line_reads_the_sample_file_as_path(self):
        result = run_cli(["sample_input.txt"])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.splitlines(), REFERENCE_OUTPUT.splitlines())
        self.assertEqual(result.stderr, "")

    def test_ac08_sample_bytes_on_standard_input_match_the_file_run(self):
        with open(SAMPLE_INPUT, "rb") as handle:
            payload = handle.read()
        result = run_cli_bytes([], payload)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            result.stdout.decode("utf-8").splitlines(),
            REFERENCE_OUTPUT.splitlines(),
        )
        self.assertEqual(result.stderr, b"")

    def test_ac09_help_text_mentions_path_and_encoding(self):
        result = run_cli(["--help"])
        self.assertEqual(result.returncode, 0)
        self.assertIn("usage", result.stdout.lower())
        self.assertIn("PATH", result.stdout)
        self.assertIn("--encoding", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_bc16_success_writes_four_lines_and_nothing_else(self):
        result = run_cli([SAMPLE_INPUT])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        self.assertEqual(len(result.stdout.splitlines()), 4)

    def test_bc22_output_format_is_key_colon_space_integer(self):
        result = run_cli([SAMPLE_INPUT])
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 4)
        for index, line in enumerate(lines):
            match = OUTPUT_LINE_PATTERN.match(line)
            self.assertIsNotNone(match, line)
            self.assertEqual(match.group(1), OUTPUT_KEY_ORDER[index], line)
            self.assertEqual(line.partition(": ")[0], OUTPUT_KEY_ORDER[index])

    def test_bc24_file_and_stdin_paths_agree_for_the_same_decoded_text(self):
        file_result = run_cli([SAMPLE_INPUT])
        stdin_result = run_cli([], stdin_text=REFERENCE_TEXT)
        self.assertEqual(file_result.stdout, stdin_result.stdout)
        self.assertEqual(parse_stats(file_result.stdout), REFERENCE_STATS)


class CommandLineErrorTests(ErrorContractAssertions):
    """Error contract: BC-14, BC-18, BC-20, BC-21 with AC-10, AC-11, AC-13."""

    def test_ac10_missing_file_is_one_error_line_with_exit_one(self):
        result = run_cli(["missing-file.txt"])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assert_single_error_line(result.stderr)

    def test_ac10_directory_path_is_one_error_line_with_exit_one(self):
        result = run_cli([HERE])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assert_single_error_line(result.stderr)

    def test_ac11_unknown_encoding_without_path_exits_one(self):
        result = run_cli(["--encoding", "no-such-codec"])
        self.assertEqual(result.returncode, 1)
        self.assertNotEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assert_single_error_line(result.stderr)

    def test_ac11_two_positional_arguments_exit_one_not_two(self):
        result = run_cli(["a.txt", "b.txt"])
        self.assertEqual(result.returncode, 1)
        self.assertNotEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assert_single_error_line(result.stderr)

    def test_ac11_undecodable_file_exits_one(self):
        with scratch_file("undecodable.bin", b"abc\xff", binary=True) as path:
            result = run_cli([path])
        self.assertEqual(result.returncode, 1)
        self.assertNotEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assert_single_error_line(result.stderr)

    def test_bc20_extra_positional_argument_is_a_usage_error(self):
        result = run_cli(["a.txt", "b.txt"])
        self.assertEqual(result.returncode, 1)
        self.assertIn("error: ", result.stderr)

    def test_bc21_every_error_is_exactly_one_readable_line(self):
        cases = {
            "missing file": ["missing-file.txt"],
            "directory": [HERE],
            "unknown encoding": ["--encoding", "no-such-codec"],
            "two positionals": ["a.txt", "b.txt"],
        }
        for label, args in cases.items():
            with self.subTest(case=label):
                result = run_cli(args)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assert_single_error_line(result.stderr)
        with scratch_file("bc21.bin", b"\xff", binary=True) as path:
            result = run_cli([path])
        self.assertEqual(result.returncode, 1)
        self.assert_single_error_line(result.stderr)

    def test_bc14_invalid_encoding_is_rejected_before_reading_input(self):
        result = run_cli(["--encoding", "no-such-codec"], stdin_text="hello\n")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assert_single_error_line(result.stderr)
        self.assertIn("no-such-codec", result.stderr)

    def test_bc14_utf8_bom_is_decoded_then_stripped(self):
        with scratch_file("bom.txt", b"\xef\xbb\xbfabc", binary=True) as path:
            result = run_cli([path])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(parse_stats(result.stdout)["char_count"], 3)

    def test_bc18_exit_codes_are_only_zero_or_one(self):
        observed = [
            run_cli([SAMPLE_INPUT]).returncode,
            run_cli(["--help"]).returncode,
            run_cli([], stdin_text="").returncode,
            run_cli(["missing-file.txt"]).returncode,
            run_cli(["a.txt", "b.txt"]).returncode,
            run_cli(["--encoding", "no-such-codec"]).returncode,
        ]
        self.assertEqual(set(observed), {0, 1})
        self.assertNotIn(2, observed)

    def test_ac13_main_returns_an_int_and_raises_no_system_exit(self):
        code = main([], stdin_text="")
        self.assertIs(type(code), int)
        self.assertEqual(code, 0)

    def test_ac13_the_module_guard_is_the_only_sys_exit(self):
        source = read_text(SCRIPT)
        self.assertIn('if __name__ == "__main__":', source)
        self.assertIn("sys.exit(main())", source)
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for inner in ast.walk(node):
                if (
                    isinstance(inner, ast.Call)
                    and isinstance(inner.func, ast.Attribute)
                    and inner.func.attr == "exit"
                    and isinstance(inner.func.value, ast.Name)
                    and inner.func.value.id == "sys"
                ):
                    self.fail("{0}() calls sys.exit".format(node.name))


class EncodingTests(unittest.TestCase):
    """BC-13, BC-14 with AC-22."""

    def test_ac22_encoding_option_decodes_a_utf16_file(self):
        with scratch_file("utf16.txt", REFERENCE_TEXT.encode("utf-16"), binary=True) as path:
            result = run_cli(["--encoding", "utf-16", path])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.splitlines(), REFERENCE_OUTPUT.splitlines())
        self.assertEqual(result.stderr, "")

    def test_ac22_encoding_option_does_not_change_standard_input_decoding(self):
        result = run_cli(["--encoding", "utf-16"], stdin_text=STDIN_TEXT)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            parse_stats(result.stdout),
            {
                "char_count": 12,
                "line_count": 1,
                "non_empty_line_count": 1,
                "word_count": 2,
            },
        )
        self.assertEqual(result.stderr, "")

    def test_ac22_default_file_decoding_is_utf8(self):
        with scratch_file(
            "latin1.txt", "caf\xe9 plain\n".encode("latin-1"), binary=True
        ) as path:
            explicit = run_cli([path, "--encoding", "latin-1"])
            default = run_cli([path])
        self.assertEqual(explicit.returncode, 0)
        self.assertEqual(
            parse_stats(explicit.stdout),
            {
                "char_count": 11,
                "line_count": 1,
                "non_empty_line_count": 1,
                "word_count": 2,
            },
        )
        self.assertEqual(default.returncode, 1)

    def test_bc13_stdin_uses_its_own_stream_encoding(self):
        # BC-13: standard input is decoded by sys.stdin itself; PYTHONIOENCODING
        # decides that decoding, and --encoding must not override it.
        payload = "caf\u00e9\n".encode("utf-8")
        result = subprocess.run(
            [sys.executable, SCRIPT, "--encoding", "utf-16"],
            input=payload,
            capture_output=True,
            cwd=HERE,
            env=python_env(PYTHONIOENCODING="utf-8"),
            timeout=CLI_TIMEOUT,
        )
        self.assertEqual(result.returncode, 0)
        stats = parse_stats(result.stdout.decode("utf-8"))
        self.assertEqual(stats["char_count"], 5)
        self.assertEqual(stats["word_count"], 1)


class ArgvTests(unittest.TestCase):
    """BC-19 with AC-06."""

    def test_ac06_argv_none_reads_sys_argv_without_the_program_name(self):
        with patched_argv(["text_stats.py", "missing-file.txt"]):
            from_sys_argv = call_main(process_stdin="")[0]
        from_explicit = call_main(["missing-file.txt"], stdin_text="")[0]
        self.assertEqual(from_sys_argv, 1)
        self.assertEqual(from_explicit, 1)
        self.assertEqual(from_sys_argv, from_explicit)

    def test_ac06_explicit_argv_value_is_the_path(self):
        with working_directory(HERE):
            code, out, err = call_main(["sample_input.txt"])
        self.assertEqual((code, out, err), (0, REFERENCE_OUTPUT, ""))

    def test_bc19_program_name_is_never_a_positional_argument(self):
        with patched_argv(["text_stats.py", SAMPLE_INPUT]):
            code, out, err = call_main(process_stdin="")
        self.assertEqual((code, out, err), (0, REFERENCE_OUTPUT, ""))
        # The program name is not counted: adding a real second positional is
        # what turns the call into a usage error.
        with patched_argv(["text_stats.py", SAMPLE_INPUT, "extra.txt"]):
            code_two, out_two, _ = call_main(process_stdin="")
        self.assertEqual(code_two, 1)
        self.assertEqual(out_two, "")


class DeliveryConstraintTests(ErrorContractAssertions):
    """BC-25, BC-26 with AC-23, AC-24, AC-25, AC-26, AC-27."""

    def test_ac23_all_imports_are_standard_library(self):
        allowed = set(sys.stdlib_module_names) | {"text_stats"}
        for path in (SCRIPT, os.path.abspath(__file__)):
            tree = ast.parse(read_text(path))
            names = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    names.update(alias.name.split(".")[0] for alias in node.names)
                elif (
                    isinstance(node, ast.ImportFrom)
                    and node.level == 0
                    and node.module is not None
                ):
                    names.add(node.module.split(".")[0])
            for name in sorted(names):
                with self.subTest(module=name):
                    self.assertIn(name, allowed, "{0} imports {1}".format(path, name))

    def test_ac23_no_dependency_manifest_is_delivered(self):
        forbidden = {
            "requirements.txt",
            "pyproject.toml",
            "setup.py",
            "setup.cfg",
            "Pipfile",
            "poetry.lock",
        }
        self.assertEqual(sorted(forbidden & set(os.listdir(HERE))), [])

    def test_ac24_nothing_is_created_outside_the_scratch_directory(self):
        before_delivery = set(os.listdir(HERE))
        before_scratch = set(os.listdir(SCRATCH_ROOT))
        with scratch_file("ac24.txt", "x\n") as path:
            self.assertTrue(os.path.isfile(path))
        run_cli([SAMPLE_INPUT])
        self.assertEqual(set(os.listdir(HERE)), before_delivery)
        self.assertEqual(set(os.listdir(SCRATCH_ROOT)), before_scratch)

    def test_bc25_fixtures_are_flat_and_always_removed(self):
        with scratch_file("bc25.txt", "a\n") as path:
            self.assertEqual(os.path.dirname(path), SCRATCH_ROOT)
            self.assertFalse(os.path.isdir(path))
            self.assertTrue(os.path.isfile(path))
        self.assertFalse(os.path.exists(path))

    def test_ac25_sample_input_is_twenty_lf_bytes_without_bom(self):
        with open(SAMPLE_INPUT, "rb") as handle:
            raw = handle.read()
        self.assertEqual(raw, b"hello world\nfoo bar\n")
        self.assertEqual(len(raw), 20)
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        self.assertEqual(count_text(raw.decode("utf-8")), REFERENCE_STATS)

    def test_ac25_readme_examples_are_self_consistent(self):
        document = read_text(README)
        for block in (REFERENCE_OUTPUT, STDIN_OUTPUT, EMPTY_OUTPUT):
            with self.subTest(block=block.splitlines()[0]):
                self.assertIn(block, document)
        self.assertIn('count_text("  \\r\\n \\r\\n")', document)
        self.assertIn(
            "{'char_count': 5, 'line_count': 2, "
            "'non_empty_line_count': 0, 'word_count': 0}",
            document,
        )
        self.assertNotIn("{'char_count': 6", document)
        self.assertEqual(count_text("  \r\n \r\n")["char_count"], 5)

    def test_bc26_joiners_are_documented_by_code_point(self):
        for path in (SCRIPT, README):
            text = read_text(path)
            with self.subTest(path=os.path.basename(path)):
                self.assertIn("\\u2019", text)
                self.assertIn("U+2019", text)

    def test_ac26_no_bare_u2019_character_is_delivered(self):
        for path in (SCRIPT, README, os.path.abspath(__file__)):
            text = read_text(path)
            for number, line in enumerate(text.splitlines(), start=1):
                if RSQUO in line and "\\u2019" not in line and "U+2019" not in line:
                    self.fail(
                        "{0}:{1} holds a bare U+2019".format(
                            os.path.basename(path), number
                        )
                    )

    def test_ac27_readme_declares_this_rounds_coverage(self):
        document = read_text(README)
        self.assertIn("BC-01 至 BC-27", document)
        self.assertIn("AC-01 至 AC-27", document)

    def test_ac27_every_criterion_label_appears_in_this_module(self):
        source = read_text(os.path.abspath(__file__))
        for number in range(1, 28):
            for prefix in ("AC", "BC"):
                label = "{0}-{1:02d}".format(prefix, number)
                with self.subTest(label=label):
                    self.assertIn(label, source)


if __name__ == "__main__":
    unittest.main()
