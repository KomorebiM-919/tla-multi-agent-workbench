"""Unit tests for text_stats (standard library ``unittest`` only).

Coverage map: every boundary condition BC-01 .. BC-15 has at least one test,
and the acceptance criteria AC-01 .. AC-13 are exercised where they can be
checked inside the test process.

The DSH file sandbox denies writes outside the workspace (including the system
temporary directory) and denies writes inside directories created during the
run, so the suite writes flat files into the pre-existing scratch directory
``.test-scratch`` and removes them again after each test.  Class
``TestScratchDirectoryContract`` guards that constraint.
"""

import io
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

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


def format_stats(stats):
    """Render stats the way the CLI must render them (BC-14)."""
    return "".join("{0}: {1}\n".format(key, stats[key]) for key in stats)


def run_cli(args, stdin_bytes=b""):
    """Run text_stats.py in a real subprocess; return (code, out, err).

    Stdout is decoded with universal newlines because the Windows console
    translates the program's ``\\n`` into ``\\r\\n`` when handing the text to
    PowerShell (BC-14 only fixes the characters the program itself writes).
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
    """AC-02 (with the BC-03 line rule) and AC-03."""

    def test_empty_text(self):
        # AC-03 / BC-03 / BC-13
        self.assertEqual(count_text(""), EMPTY_STATS)

    def test_two_line_text(self):
        # char/non-empty/word match AC-02 and AC-06; line_count follows BC-03,
        # which rejects the trailing-newline value quoted by those criteria.
        self.assertEqual(
            count_text(BASELINE_TEXT),
            {
                "char_count": 20,
                "line_count": 2,
                "non_empty_line_count": 2,
                "word_count": 4,
            },
        )

    def test_single_line_with_trailing_newline(self):
        # AC-07 / BC-03
        self.assertEqual(count_text(ONE_LINE_TEXT), ONE_LINE_STATS)


class TestCharacterAndNewlineRules(unittest.TestCase):
    """BC-01 / BC-02: code points and universal newline normalisation."""

    def test_character_count_uses_code_points(self):
        # BC-01
        self.assertEqual(count_text("a\u4e2d")["char_count"], 2)
        self.assertEqual(count_text("\U0001F600")["char_count"], 1)
        self.assertEqual(count_text("")["char_count"], 0)

    def test_crlf_is_normalised_to_one_character(self):
        # BC-02
        self.assertEqual(
            count_text("a\r\nb"),
            {
                "char_count": 3,
                "line_count": 2,
                "non_empty_line_count": 2,
                "word_count": 2,
            },
        )

    def test_lone_carriage_return_is_a_line_break(self):
        # BC-02
        self.assertEqual(count_text("a\rb")["char_count"], 3)
        self.assertEqual(count_text("a\rb")["line_count"], 2)


class TestLineCountingRules(unittest.TestCase):
    """BC-03 / BC-05: line counting."""

    def test_empty_text_has_zero_lines(self):
        self.assertEqual(count_text("")["line_count"], 0)

    def test_single_newline_is_one_line(self):
        self.assertEqual(count_text("\n")["line_count"], 1)

    def test_trailing_newline_does_not_add_a_line(self):
        self.assertEqual(count_text("a\n")["line_count"], 1)

    def test_two_lines_without_trailing_newline(self):
        self.assertEqual(count_text("a\nb")["line_count"], 2)

    def test_two_trailing_newlines_leave_two_lines(self):
        self.assertEqual(count_text("a\n\n")["line_count"], 2)

    def test_whitespace_only_text(self):
        # AC-04
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


class TestNonEmptyLineRules(unittest.TestCase):
    """BC-04: whitespace definition follows ``str.strip()``."""

    def test_ascii_whitespace(self):
        self.assertEqual(count_text("a\n \n")["non_empty_line_count"], 1)
        self.assertEqual(count_text("\t\n")["non_empty_line_count"], 0)

    def test_unicode_whitespace(self):
        self.assertEqual(count_text("\u3000\n")["non_empty_line_count"], 0)
        self.assertEqual(count_text("\u00a0x\n")["non_empty_line_count"], 1)


class TestWordRules(unittest.TestCase):
    """AC-05 / BC-06 .. BC-10: English word recognition."""

    def assert_word_count(self, text, expected):
        self.assertEqual(count_text(text)["word_count"], expected, msg=repr(text))

    def test_letter_runs_are_counted_per_occurrence(self):
        # BC-07
        self.assert_word_count("Hello hello HELLO", 3)
        self.assert_word_count("ABC", 1)

    def test_single_internal_joiner_keeps_one_word(self):
        # BC-08
        self.assert_word_count("well-known", 1)
        self.assert_word_count("don't", 1)
        self.assert_word_count("it\u2019s", 1)
        self.assert_word_count("rock'n", 1)
        self.assert_word_count("a-b-c", 1)

    def test_double_or_leading_joiner_does_not_join(self):
        # BC-08
        self.assert_word_count("hello--world", 2)
        self.assert_word_count("-abc", 1)

    def test_digits_are_not_word_characters(self):
        # BC-06
        self.assert_word_count("123 456", 0)
        self.assert_word_count("abc123", 1)
        self.assert_word_count("3rd", 1)
        self.assert_word_count("a1b", 2)

    def test_underscore_splits_words(self):
        # BC-10
        self.assert_word_count("a_b", 2)
        self.assert_word_count("foo_bar baz", 3)

    def test_ascii_letter_runs_inside_non_ascii_text(self):
        # BC-06 / BC-09: non-ASCII letters are not word characters.  The
        # combining accent of 'cafe\u0301' is likewise not a separator in the
        # ASCII sense, it only ends the letter run it follows.
        self.assert_word_count("cafe\u0301", 1)
        self.assert_word_count("naive", 1)
        self.assert_word_count("caf\u00e9", 1)
        self.assert_word_count("\u4e2d\u6587", 0)
        self.assert_word_count("abc\u4e2d\u6587def", 2)


class TestBomHandling(unittest.TestCase):
    """BC-11: a leading UTF-8 BOM is stripped before counting."""

    def test_pure_function_strips_bom(self):
        stats = count_text("\ufeffhi\n")
        self.assertEqual(stats["char_count"], 3)
        self.assertEqual(stats["line_count"], 1)
        self.assertEqual(stats["word_count"], 1)


class TestMainStdinPath(unittest.TestCase):
    """AC-07 / AC-08 / BC-13 / BC-15: standard input path."""

    def test_injected_stdin_text(self):
        code, out, err = run_main([], stdin_text=ONE_LINE_TEXT)
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(out, ONE_LINE_OUTPUT)

    def test_immediate_eof_yields_zeros(self):
        # BC-13: no blocking, all counters zero.
        code, out, err = run_main([], stdin_text="")
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(out, ZERO_OUTPUT)

    def test_cli_immediate_eof_subprocess(self):
        code, out, err = run_cli([], stdin_bytes=b"")
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(out, ZERO_OUTPUT)

    def test_cli_stdin_pipe(self):
        code, out, err = run_cli([], stdin_bytes=ONE_LINE_TEXT.encode("utf-8"))
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(out, ONE_LINE_OUTPUT)


class TestMainFilePath(ScratchFileMixin, unittest.TestCase):
    """AC-06 / AC-10 / BC-11 / BC-14 / BC-15: file input and output format."""

    def test_file_baseline_output(self):
        path = self.make_file(self._scratch_name("sample.txt"), BASELINE_TEXT)
        code, out, err = run_cli([path])
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(
            out,
            "char_count: 20\nline_count: 2\n"
            "non_empty_line_count: 2\nword_count: 4\n",
        )

    def test_cli_and_pure_function_agree(self):
        # BC-15: one single source of truth for both entry points.
        text = "Mixed\r\ncase  text\u3000\n\nend"
        path = self.make_file(self._scratch_name("mixed.txt"), text)
        code, out, err = run_main([path])
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(out, format_stats(count_text(text)))

    def test_bom_file(self):
        # AC-10
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
        # BC-11: --encoding changes decoding but the BOM rule still applies.
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
    """AC-09 / BC-12 / BC-13: every failure is one ``error: `` line, code 1."""

    def assert_error(self, argv):
        code, out, err = run_main(argv)
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertTrue(err.startswith("error: "), msg=err)
        self.assertNotIn("Traceback", err)
        return err

    def test_missing_file(self):
        self.assert_error([os.path.join(SCRATCH_ROOT, "does-not-exist.txt")])

    def test_missing_file_subprocess(self):
        code, out, err = run_cli(["does-not-exist.txt"])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertTrue(err.startswith("error: "), msg=err)

    def test_empty_string_path(self):
        # BC-13: an empty path is treated as a missing file.
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

    def test_extra_positional_arguments(self):
        # Open question 2: more than one path is a usage error.
        first = self.make_file(self._scratch_name("a.txt"), "a\n")
        second = self.make_file(self._scratch_name("b.txt"), "b\n")
        with self.assertRaises(SystemExit) as raised:
            main([first, second])
        self.assertNotEqual(raised.exception.code, 0)


class TestSpecificationConflicts(unittest.TestCase):
    """Pins the two requirement contradictions resolved in ``text_stats``.

    These tests document behaviour that cannot satisfy the quoted acceptance
    criteria and the boundary conditions at the same time.  They assert the
    implemented (boundary-condition) behaviour so a future change cannot alter
    it silently; the contradiction itself is reported in the coding report.
    """

    def test_trailing_newline_conflict(self):
        # AC-02/AC-06 quote line_count == 3 here, BC-03 and AC-07 require 1 for
        # the same trailing-newline shape.
        self.assertEqual(count_text(BASELINE_TEXT)["line_count"], 2)
        self.assertEqual(count_text(ONE_LINE_TEXT)["line_count"], 1)

    def test_precomposed_accent_conflict(self):
        # BC-09 quotes 1 word for 'caf\u00e9' (implemented); AC-05 also asserts
        # 'cafe\u0301' -> 2, which the BC-06 regex cannot produce (both forms
        # hold one ASCII letter run plus a non-ASCII accent), so AC-05 and
        # BC-09 cannot both hold.  BC-09's normative rule was implemented.
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
        self.addCleanup(
            lambda: os.path.isfile(path) and os.remove(path)
        )
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write("a\n")
        self.assertTrue(os.path.isfile(path))
        self.assertEqual(os.path.dirname(path), SCRATCH_ROOT)


if __name__ == "__main__":
    unittest.main()
