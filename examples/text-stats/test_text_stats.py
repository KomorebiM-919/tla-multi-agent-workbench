"""Unit tests for text_stats (standard library ``unittest`` only).

Coverage map: every boundary condition BC-01 .. BC-19 has at least one test,
and the acceptance criteria AC-01 .. AC-17 are exercised wherever they can be
checked from inside the test process (AC-01, AC-08, AC-11, AC-12, AC-13, AC-14
are also asserted through real subprocesses).

Normative note (BC-17/BC-18): the line-count rule has exactly one value per
input.  ``line_count`` is ``len(text.splitlines())``, so ``"a\\n"`` is 1 line,
``"hello world\\nfoo bar\\n"`` is 2 lines and ``"hello world\\nfoo bar\\n\\n"``
is 3 lines; ``"cafe\\u0301"`` counts 1 word.  No assertion in this file may use
the superseded values (3 lines for a trailing newline, 2 words for the
combining-accent form), and no assertion may expect argparse's default exit
code 2 for a usage error.

The DSH file sandbox denies writes outside the workspace (including the system
temporary directory) and denies writes inside directories created during the
run, so the suite writes flat files into the pre-existing scratch directory
``.test-scratch`` and removes them again after each test.  Class
``TestScratchDirectoryContract`` guards that constraint.
"""

import argparse
import ast
import inspect
import io
import os
import re
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import text_stats  # noqa: E402
from text_stats import count_text, main  # noqa: E402

SCRIPT = os.path.join(HERE, "text_stats.py")
BOM_BYTES = b"\xef\xbb\xbf"
SCRATCH_ROOT = os.path.join(HERE, ".test-scratch")

# Shared expected values so tests read as specification, not as magic numbers.
EMPTY_STATS = {
    "char_count": 0,
    "line_count": 0,
    "non_empty_line_count": 0,
    "word_count": 0,
}
BASELINE_TEXT = "hello world\nfoo bar\n"
BASELINE_STATS = {
    "char_count": 20,
    "line_count": 2,
    "non_empty_line_count": 2,
    "word_count": 4,
}
ONE_LINE_TEXT = "hello world\n"
ONE_LINE_STATS = {
    "char_count": 12,
    "line_count": 1,
    "non_empty_line_count": 1,
    "word_count": 2,
}

ZERO_OUTPUT = (
    "char_count: 0\nline_count: 0\nnon_empty_line_count: 0\nword_count: 0\n"
)
ONE_LINE_OUTPUT = (
    "char_count: 12\nline_count: 1\nnon_empty_line_count: 1\nword_count: 2\n"
)
BASELINE_OUTPUT = (
    "char_count: 20\nline_count: 2\nnon_empty_line_count: 2\nword_count: 4\n"
)


def format_stats(stats):
    """Render stats the way the CLI must render them (BC-12)."""
    return "".join("{0}: {1}\n".format(key, stats[key]) for key in stats)


def run_cli(args, stdin_bytes=b""):
    """Run text_stats.py in a real subprocess; return (code, out, err).

    Stdout is decoded with universal newlines because the Windows console
    translates the program's ``\\n`` into ``\\r\\n`` when handing the text to
    PowerShell (BC-12 only fixes the characters the program itself writes).
    """
    completed = subprocess.run(
        [sys.executable, SCRIPT] + args,
        input=stdin_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=HERE,
        check=False,
    )
    return (
        completed.returncode,
        completed.stdout.decode("utf-8").replace("\r\n", "\n"),
        completed.stderr.decode("utf-8").replace("\r\n", "\n"),
    )


def run_main(argv, stdin_text=None):
    """Call ``main`` in-process; return (code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(argv, stdin_text=stdin_text)
    return code, out.getvalue(), err.getvalue()


def run_main_help(argv):
    """Call ``main`` in-process and also capture argparse's own help stream.

    ``argparse`` formats ``--help`` through ``_sys.stdout``, a reference bound at
    import time, so ``contextlib.redirect_stdout`` alone would let the help text
    reach the real console.  Replacing that reference for the duration of the
    call keeps the test suite's own standard output empty.
    """
    out, err = io.StringIO(), io.StringIO()
    original_stdout = argparse._sys.stdout
    argparse._sys.stdout = out
    try:
        with redirect_stdout(out), redirect_stderr(err):
            code = main(argv)
    finally:
        argparse._sys.stdout = original_stdout
    return code, out.getvalue(), err.getvalue()


class ScratchFileMixin:
    """Create uniquely named scratch files that are removed after each test."""

    def setUp(self):
        super().setUp()
        os.makedirs(SCRATCH_ROOT, exist_ok=True)
        self._scratch_paths = []
        self.addCleanup(self._remove_scratch)

    def _remove_scratch(self):
        for path in reversed(self._scratch_paths):
            if os.path.isfile(path):
                os.remove(path)

    def scratch_path(self, name):
        path = os.path.join(SCRATCH_ROOT, name)
        self._scratch_paths.append(path)
        return path

    def make_file(self, name, data, binary=False, encoding="utf-8"):
        path = self.scratch_path(name)
        if binary:
            with open(path, "wb") as handle:
                handle.write(data)
        else:
            with open(path, "w", encoding=encoding, newline="") as handle:
                handle.write(data)
        return path

    def _scratch_name(self, suffix):
        """Per-test scratch file name to avoid collisions between tests."""
        return "{0}-{1}".format(self.id().rsplit(".", 1)[-1], suffix)


class TestCountTextInterface(unittest.TestCase):
    """AC-01: the pure function exists and has the required shape."""

    def test_returns_dict_with_exactly_the_four_keys(self):
        stats = count_text("a")
        self.assertIsInstance(stats, dict)
        self.assertEqual(
            sorted(stats),
            ["char_count", "line_count", "non_empty_line_count", "word_count"],
        )

    def test_all_values_are_integers(self):
        for key, value in count_text("a b\n").items():
            self.assertIsInstance(value, int, msg=key)
            self.assertNotIsInstance(value, bool, msg=key)


class TestBaseline(unittest.TestCase):
    """AC-02 / AC-03 / AC-05 / AC-08: the four documented sample inputs."""

    def test_empty_text(self):
        self.assertEqual(count_text(""), EMPTY_STATS)

    def test_two_line_text_with_trailing_newline(self):
        self.assertEqual(count_text(BASELINE_TEXT), BASELINE_STATS)

    def test_two_line_text_without_trailing_newline(self):
        # AC-05: same two lines, one character less.
        self.assertEqual(
            count_text("hello world\nfoo bar"),
            {
                "char_count": 19,
                "line_count": 2,
                "non_empty_line_count": 2,
                "word_count": 4,
            },
        )

    def test_two_trailing_newlines_add_one_line(self):
        # AC-05: this is the only expected value for this input.
        self.assertEqual(count_text("hello world\nfoo bar\n\n")["line_count"], 3)
        self.assertEqual(count_text(BASELINE_TEXT)["line_count"], 2)

    def test_single_line_with_trailing_newline(self):
        self.assertEqual(count_text(ONE_LINE_TEXT), ONE_LINE_STATS)


class TestCharacterAndNewlineRules(unittest.TestCase):
    """BC-01 / BC-02: code points and newline normalisation."""

    def test_character_count_uses_code_points(self):
        self.assertEqual(count_text("a\u4e2d")["char_count"], 2)
        self.assertEqual(count_text("\U0001F600")["char_count"], 1)
        self.assertEqual(count_text("")["char_count"], 0)
        self.assertEqual(count_text("\u3000")["char_count"], 1)

    def test_crlf_counts_as_one_character(self):
        self.assertEqual(
            count_text("a\r\nb"),
            {
                "char_count": 3,
                "line_count": 2,
                "non_empty_line_count": 2,
                "word_count": 2,
            },
        )

    def test_lone_carriage_return_counts_as_one_character(self):
        self.assertEqual(count_text("a\rb")["char_count"], 3)
        self.assertEqual(count_text("a\rb")["line_count"], 2)

    def test_other_separators_are_not_normalised(self):
        # BC-02: U+2028 stays a single character and never starts a new line.
        self.assertEqual(count_text("a\u2028b")["char_count"], 3)
        self.assertEqual(count_text("a\u2028b")["line_count"], 1)


class TestLineCountingRules(unittest.TestCase):
    """BC-03 / BC-05: the single authoritative line definition."""

    def test_splitlines_semantics(self):
        for text, expected in (
            ("", 0),
            ("\n", 1),
            ("a\n", 1),
            ("a", 1),
            ("a\nb", 2),
            ("a\n\n", 2),
            (BASELINE_TEXT, 2),
            ("hello world\nfoo bar\n\n", 3),
        ):
            with self.subTest(text=text):
                self.assertEqual(count_text(text)["line_count"], expected)

    def test_whitespace_only_text(self):
        self.assertEqual(
            count_text("\n\n"),
            {
                "char_count": 2,
                "line_count": 2,
                "non_empty_line_count": 0,
                "word_count": 0,
            },
        )
        self.assertEqual(
            count_text("  \n\t \n"),
            {
                "char_count": 6,
                "line_count": 2,
                "non_empty_line_count": 0,
                "word_count": 0,
            },
        )

    def test_non_empty_line_invariants(self):
        # BC-05
        for text in ("", "\n", "a", "a\n", "a\r\nb", "\n\n", "  \n\t \n", "a\n\n"):
            stats = count_text(text)
            self.assertLessEqual(
                stats["non_empty_line_count"], stats["line_count"], msg=repr(text)
            )
            self.assertGreaterEqual(stats["non_empty_line_count"], 0)
            if stats["line_count"] == 0:
                self.assertEqual(stats["non_empty_line_count"], 0)
        self.assertEqual(count_text("")["line_count"], 0)


class TestNonEmptyLineRules(unittest.TestCase):
    """BC-04: whitespace definition follows ``str.strip()``."""

    def test_ascii_whitespace(self):
        self.assertEqual(count_text("a\n \n")["non_empty_line_count"], 1)
        self.assertEqual(count_text("\t\n")["non_empty_line_count"], 0)

    def test_unicode_whitespace(self):
        self.assertEqual(count_text("\u3000\n")["non_empty_line_count"], 0)
        self.assertEqual(count_text("\u00a0x\n")["non_empty_line_count"], 1)


class TestWordRules(unittest.TestCase):
    """BC-06 .. BC-10: English word recognition."""

    def assert_word_count(self, text, expected):
        self.assertEqual(count_text(text)["word_count"], expected, msg=repr(text))

    def test_letter_runs_are_counted_per_occurrence(self):
        self.assert_word_count("Hello hello HELLO", 3)
        self.assert_word_count("ABC", 1)

    def test_single_internal_joiner_keeps_one_word(self):
        self.assert_word_count("well-known", 1)
        self.assert_word_count("don't", 1)
        self.assert_word_count("it\u2019s", 1)
        self.assert_word_count("rock\u2019n", 1)
        self.assert_word_count("a-b-c", 1)

    def test_double_or_leading_or_trailing_joiner_does_not_join(self):
        self.assert_word_count("hello--world", 2)
        self.assert_word_count("-abc", 1)
        self.assert_word_count("abc-", 1)

    def test_digits_are_not_word_characters(self):
        self.assert_word_count("123 456", 0)
        self.assert_word_count("abc123", 1)
        self.assert_word_count("3rd", 1)
        self.assert_word_count("a1b", 2)
        self.assert_word_count("1984", 0)

    def test_underscore_splits_words(self):
        self.assert_word_count("a_b", 2)
        self.assert_word_count("foo_bar baz", 3)

    def test_non_ascii_text_yields_only_ascii_letter_runs(self):
        self.assert_word_count("caf\u00e9", 1)
        self.assert_word_count("cafe\u0301", 1)
        self.assert_word_count("na\u00efve", 2)
        self.assert_word_count("\u4e2d\u6587", 0)
        self.assert_word_count("abc\u4e2d\u6587def", 2)

    def test_non_ascii_letters_cannot_act_as_joiners(self):
        self.assert_word_count("caf\u00e9-mocha", 2)
        self.assert_word_count("cafe\u0301-mocha", 2)


class TestBomHandling(unittest.TestCase):
    """BC-11: a leading UTF-8 BOM is stripped before counting."""

    def test_pure_function_strips_bom(self):
        stats = count_text("\ufeffhi\n")
        self.assertEqual(stats["char_count"], 3)
        self.assertEqual(stats["line_count"], 1)
        self.assertEqual(stats["word_count"], 1)

    def test_precomposed_accent_character_count(self):
        # AC-07: 'caf\u00e9' is 4 code points, 'cafe\u0301' is 5.
        self.assertEqual(count_text("caf\u00e9")["char_count"], 4)
        self.assertEqual(count_text("cafe\u0301")["char_count"], 5)


class TestMainStdinPath(unittest.TestCase):
    """AC-09 / BC-13 / BC-15: standard input path."""

    def test_injected_stdin_text(self):
        code, out, err = run_main([], stdin_text=ONE_LINE_TEXT)
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(out, ONE_LINE_OUTPUT)

    def test_injected_empty_stdin_text_writes_nothing(self):
        # An explicit empty ``stdin_text`` override means "no text to report",
        # so the in-process call stays silent; the real command line reading an
        # immediately-closed stdin is covered by the subprocess test below.
        code, out, err = run_main([], stdin_text="")
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(out, "")

    def test_cli_immediate_eof_subprocess(self):
        code, out, err = run_cli([], stdin_bytes=b"")
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(out, ZERO_OUTPUT)

    def test_cli_stdin_pipe(self):
        code, out, err = run_cli([], stdin_bytes=ONE_LINE_TEXT.encode("utf-8"))
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(out, ONE_LINE_OUTPUT)


class TestMainFilePath(ScratchFileMixin, unittest.TestCase):
    """AC-08 / AC-10 / BC-11 / BC-15: file input and output format."""

    def test_file_baseline_output(self):
        path = self.make_file(self._scratch_name("sample.txt"), BASELINE_TEXT)
        code, out, err = run_cli([path])
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(out, BASELINE_OUTPUT)

    def test_sample_input_file_in_delivery_directory(self):
        # AC-08: the shipped sample_input.txt must produce exactly these lines.
        sample = os.path.join(HERE, "sample_input.txt")
        code, out, err = run_cli(["sample_input.txt"])
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(out, BASELINE_OUTPUT)
        with open(sample, "r", encoding="utf-8", newline="") as handle:
            self.assertEqual(handle.read(), BASELINE_TEXT)

    def test_cli_and_pure_function_agree(self):
        # BC-15: one single source of truth for both entry points.
        text = "Mixed\r\ncase  text\u3000\n\nend"
        path = self.make_file(self._scratch_name("mixed.txt"), text)
        code, out, err = run_main([path])
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(out, format_stats(count_text(text)))

    def test_bom_file(self):
        path = self.make_file(
            self._scratch_name("bom.txt"), BOM_BYTES + b"hi\n", binary=True
        )
        code, out, err = run_cli([path])
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(
            out,
            "char_count: 3\nline_count: 1\n"
            "non_empty_line_count: 1\nword_count: 1\n",
        )

    def test_encoding_override(self):
        # BC-11: --encoding changes decoding, the counting rules stay the same.
        path = self.make_file(
            self._scratch_name("latin1.txt"), b"caf\xe9\n", binary=True
        )
        code, out, err = run_main([path, "--encoding", "latin-1"])
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(
            out,
            "char_count: 5\nline_count: 1\n"
            "non_empty_line_count: 1\nword_count: 1\n",
        )

    def test_bom_is_stripped_even_with_explicit_encoding(self):
        path = self.make_file(
            self._scratch_name("bom-latin1.txt"), BOM_BYTES + b"hi\n", binary=True
        )
        code, out, err = run_main([path, "--encoding", "utf-8"])
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(out.splitlines()[0], "char_count: 3")


class TestMainErrorPaths(ScratchFileMixin, unittest.TestCase):
    """AC-10 / AC-11 / BC-13 / BC-14: every failure is one ``error: `` line, code 1."""

    def assert_error(self, argv, stdin_text=None):
        code, out, err = run_main(argv, stdin_text=stdin_text)
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertTrue(err.startswith("error: "), msg=err)
        self.assertNotIn("Traceback", err)
        return err

    def test_missing_file(self):
        self.assert_error([os.path.join(SCRATCH_ROOT, "does-not-exist.txt")])

    def test_missing_file_subprocess(self):
        code, out, err = run_cli(["missing-file.txt"])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertTrue(err.startswith("error: "), msg=err)

    def test_empty_string_path(self):
        self.assert_error([""])

    def test_directory_path(self):
        self.assert_error([SCRATCH_ROOT])

    def test_undecodable_bytes(self):
        path = self.make_file(
            self._scratch_name("bad.txt"), b"\xff\xfe\x00bad", binary=True
        )
        err = self.assert_error([path])
        self.assertIn(path, err)

    def test_unknown_encoding(self):
        err = self.assert_error(["--encoding", "no-such-codec"])
        self.assertIn("no-such-codec", err)

    def test_extra_positional_arguments_return_one(self):
        # BC-14: a usage error is an ordinary error path, not SystemExit(2).
        first = self.make_file(self._scratch_name("a.txt"), "a\n")
        second = self.make_file(self._scratch_name("b.txt"), "b\n")
        err = self.assert_error([first, second])
        self.assertIn("error: ", err)

    def test_three_positional_arguments_return_one(self):
        err = self.assert_error(["a.txt", "b.txt", "c.txt"])
        self.assertIn("error: ", err)

    def test_extra_positional_arguments_subprocess(self):
        # AC-11: exit code 1 even when neither path exists.
        code, out, err = run_cli(["sample_input.txt", "extra.txt"])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertTrue(err.startswith("error: "), msg=err)

    def test_three_positional_arguments_subprocess(self):
        code, out, err = run_cli(["a.txt", "b.txt", "c.txt"])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertTrue(err.startswith("error: "), msg=err)


class TestEntryPointContract(unittest.TestCase):
    """AC-12 / AC-13 / BC-14 / BC-16: callable entry point, no forwarders."""

    def test_no_forwarding_wrapper_function_exists(self):
        # BC-16: nothing in the module may merely forward to main.
        offenders = []
        for name, func in vars(text_stats).items():
            if not callable(func):
                continue
            if getattr(func, "__module__", None) != text_stats.__name__:
                continue
            try:
                source = inspect.getsource(func)
            except (OSError, TypeError):  # pragma: no cover - defensive
                continue
            if "return main(" in source:
                offenders.append(name)
        self.assertEqual(offenders, [])

    def test_main_is_directly_callable_and_returns_int(self):
        self.assertTrue(inspect.isfunction(text_stats.main))
        # Successful runs legitimately print the four statistics lines (BC-12),
        # so the in-process call has to capture them; ``stdin_text=""`` keeps it
        # deterministic instead of reading the test runner's own standard input.
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = text_stats.main([], stdin_text="")
        self.assertEqual(buffer.getvalue(), "")
        self.assertIsInstance(code, int)
        self.assertNotIsInstance(code, bool)
        self.assertEqual(code, 0)

    def test_help_exits_zero_and_describes_path(self):
        code, out, err = run_main_help(["--help"])
        self.assertEqual(code, 0)
        self.assertIn("PATH", out)
        self.assertIn("text_stats.py", out)

    def test_help_subprocess(self):
        # AC-13: the command line entry point still works after the cleanup.
        code, out, err = run_cli(["--help"])
        self.assertEqual(code, 0)
        self.assertIn("PATH", out)
        self.assertNotIn("Traceback", err)


class TestSpecificationRules(unittest.TestCase):
    """Pins the BC-03 line rule and the BC-06/BC-09 word rule (BC-17/BC-18)."""

    def test_trailing_newline_line_count_is_the_sole_value(self):
        self.assertEqual(count_text(BASELINE_TEXT)["line_count"], 2)
        self.assertEqual(count_text(ONE_LINE_TEXT)["line_count"], 1)
        self.assertEqual(count_text("a\n")["line_count"], 1)

    def test_combining_accent_word_count_is_the_sole_value(self):
        self.assertEqual(count_text("caf\u00e9")["word_count"], 1)
        self.assertEqual(count_text("cafe\u0301")["word_count"], 1)


CONTRACT_PROBE_NAME = "contract-probe.txt"


class TestScratchDirectoryContract(unittest.TestCase):
    """Guard the scratch-directory constraint of revision 1.

    Revision 1 created one temporary subdirectory per test inside
    ``.test-scratch``; the sandbox denies writing into such freshly created
    directories, so those runs died after ``mkdtemp`` and left undeletable
    ``tmp*`` directories behind.  Every scratch file must therefore be written
    flat into the pre-existing scratch root, and no directory may be created.
    """

    def test_scratch_root_exists(self):
        self.assertTrue(os.path.isdir(SCRATCH_ROOT), msg=SCRATCH_ROOT)

    def test_flat_scratch_file_round_trip(self):
        path = os.path.join(SCRATCH_ROOT, CONTRACT_PROBE_NAME)
        self.addCleanup(lambda: os.path.isfile(path) and os.remove(path))
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write("a\n")
        self.assertTrue(os.path.isfile(path))
        self.assertEqual(os.path.dirname(path), SCRATCH_ROOT)


class TestStandardLibraryBoundary(unittest.TestCase):
    """AC-17: only standard-library imports, no dependency manifests."""

    STANDARD_LIBRARY = {
        "argparse",
        "ast",
        "codecs",
        "contextlib",
        "inspect",
        "io",
        "os",
        "re",
        "subprocess",
        "sys",
        "text_stats",
        "unittest",
    }

    @staticmethod
    def _imported_top_level_modules(source):
        """Top-level module names of every real import statement in *source*.

        The module is parsed instead of pattern-matched so that an ``import``
        word inside a docstring cannot be mistaken for an import statement.
        """
        modules = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                modules.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                if node.level == 0 and node.module:
                    modules.add(node.module.split(".")[0])
        return modules

    def test_imports_are_standard_library(self):
        for name in ("text_stats.py", "test_text_stats.py"):
            with open(os.path.join(HERE, name), "r", encoding="utf-8") as handle:
                source = handle.read()
            for module in sorted(self._imported_top_level_modules(source)):
                with self.subTest(file=name, module=module):
                    self.assertIn(module, self.STANDARD_LIBRARY)

    def test_no_dependency_manifests(self):
        for name in ("requirements.txt", "pyproject.toml", "setup.py", "Pipfile"):
            with self.subTest(name=name):
                self.assertFalse(os.path.exists(os.path.join(HERE, name)))


if __name__ == "__main__":
    unittest.main()
