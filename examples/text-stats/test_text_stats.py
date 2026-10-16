"""Unit tests for text_stats (standard library ``unittest`` only).

Coverage map: every boundary condition BC-01 .. BC-24 has at least one test and
every acceptance criterion AC-01 .. AC-23 is exercised - the pure-function
criteria against ``count_text``, the command line criteria against a real
subprocess so that exit code, standard output and standard error are observed
exactly as an operator would see them.

The normative facts this file pins:

* the line boundary set is LF, CR and CRLF only, so ``"a\\n"`` is 1 line,
  ``"a\\nb"`` is 2 lines, ``"a\\n\\n"`` is 2 lines and ``"a\\n\\nb"`` is 3 lines,
  while U+2028, U+2029, ``\\x0b``, ``\\x0c``, ``\\x1c``, ``\\x1d``, ``\\x1e``
  and ``\\x85`` are ordinary line content (BC-01, BC-05);
* a programmatic call (an explicit ``stdin_text`` argument) prints nothing, and
  only a real command line run prints the four result lines (BC-15, BC-16);
* a usage error is exit code 1 with one ``error: `` line, never argparse's
  default 2 (BC-18).

The DSH file sandbox denies writes outside the workspace (including the system
temporary directory), so transient fixtures are written into the pre-existing
scratch directory ``.test-scratch`` and removed again by the owning test.
"""

import ast
import contextlib
import io
import os
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
# point) everywhere in this file and in the module so that no bare,
# unidentifiable look-alike apostrophe ever appears (AC-21).
RSQUO = "\u2019"

# The reference document delivered as sample_input.txt: 20 code points, 2 lines,
# 2 non-empty lines, 4 words (BC-05, BC-06, BC-09, AC-11, AC-22).
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
OUTPUT_KEY_ORDER = (
    "char_count",
    "line_count",
    "non_empty_line_count",
    "word_count",
)

# BC-01: the characters that str.splitlines() would wrongly treat as line
# boundaries, and that must therefore stay inside the line content.
NON_BOUNDARY_CHARACTERS = ("\u2028", "\u2029", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85")


def run_cli(args, stdin_text=""):
    """Run the module in a real subprocess and capture its three streams."""
    return subprocess.run(
        [sys.executable, SCRIPT] + list(args),
        input=stdin_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=HERE,
    )


def call_main(argv=None, stdin_text=None, process_stdin=None):
    """Call ``main`` in-process; return ``(code, stdout, stderr)``."""
    out, err = io.StringIO(), io.StringIO()
    use_fake_stdin = stdin_text is None and process_stdin is not None
    saved_stdin = sys.stdin
    try:
        if use_fake_stdin:
            sys.stdin = io.StringIO(process_stdin)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(argv, stdin_text=stdin_text)
    finally:
        sys.stdin = saved_stdin
    return code, out.getvalue(), err.getvalue()


def scratch_path(name):
    """Return a unique, sandbox-writable fixture path (never creates it)."""
    return os.path.join(SCRATCH_ROOT, "test_text_stats_{0}_{1}".format(os.getpid(), name))


def parse_stats(output):
    """Turn the four ``<key>: <value>`` output lines back into a mapping."""
    stats = {}
    for line in output.strip().split("\n"):
        name, _, value = line.partition(": ")
        stats[name] = int(value)
    return stats


@contextlib.contextmanager
def scratch_file(name, data, binary=False):
    """Write a transient fixture under ``.test-scratch`` and always remove it."""
    path = scratch_path(name)
    mode = "wb" if binary else "w"
    kwargs = {} if binary else {"encoding": "utf-8", "newline": ""}
    with open(path, mode, **kwargs) as handle:
        handle.write(data)
    try:
        yield path
    finally:
        os.remove(path)


class CountTextInterfaceTests(unittest.TestCase):
    """Pure interface: BC-20, AC-23."""

    def test_bc20_count_text_returns_exactly_the_four_integer_keys(self):
        stats = count_text(REFERENCE_TEXT)
        self.assertEqual(stats, REFERENCE_STATS)
        self.assertEqual(len(stats), 4)
        for key in OUTPUT_KEY_ORDER:
            self.assertIsInstance(stats[key], int, key)
        self.assertEqual(sorted(stats), sorted(OUTPUT_KEY_ORDER))

    def test_ac23_count_text_is_importable_and_callable_with_one_string(self):
        self.assertTrue(callable(text_stats.count_text))
        self.assertEqual(text_stats.count_text(""), EMPTY_STATS)

    def test_bc20_pure_call_writes_nothing_to_any_process_stream(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            stats = count_text(REFERENCE_TEXT)
        self.assertEqual(out.getvalue(), "")
        self.assertEqual(stats, REFERENCE_STATS)


class LineCountTests(unittest.TestCase):
    """BC-04, BC-05, BC-06 and AC-01, AC-05, AC-13, AC-14."""

    def test_ac01_trailing_lf_creates_no_extra_line(self):
        self.assertEqual(count_text("a\n")["line_count"], 1)

    def test_ac01_unterminated_last_line_is_a_line(self):
        self.assertEqual(count_text("a\nb")["line_count"], 2)

    def test_ac01_two_trailing_lfs_are_two_lines(self):
        self.assertEqual(count_text("a\n\n")["line_count"], 2)

    def test_ac01_reference_text_is_two_lines_not_three(self):
        self.assertEqual(count_text(REFERENCE_TEXT)["line_count"], 2)

    def test_bc04_bc05_empty_text_has_zero_lines(self):
        self.assertEqual(count_text("")["line_count"], 0)
        self.assertEqual(count_text(""), EMPTY_STATS)

    def test_bc05_lone_lf_is_one_empty_line(self):
        stats = count_text("\n")
        self.assertEqual(stats["line_count"], 1)
        self.assertEqual(stats["non_empty_line_count"], 0)

    def test_bc05_interior_empty_line_still_counts_as_a_line(self):
        stats = count_text("a\n\nb")
        self.assertEqual(stats["char_count"], 4)
        self.assertEqual(stats["line_count"], 3)
        self.assertEqual(stats["non_empty_line_count"], 2)

    def test_ac01_whitespace_only_lines_are_two_lines_none_non_empty(self):
        stats = count_text("  \n\t\n")
        self.assertEqual(stats["line_count"], 2)
        self.assertEqual(stats["non_empty_line_count"], 0)

    def test_ac05_line_and_non_empty_counts_come_from_one_split(self):
        # AC-05 gives this input char_count 5, not 6, and this asserts that
        # full mapping.  BC-02 normalises "  \r\n \r\n" (7 raw code points) to
        # "  \n \n" and BC-08 counts that as 5 code points, so 5 is the only
        # value consistent with both rules; the historical 6 no longer exists
        # in this round's requirements and this round's requirement_conflicts
        # is an empty array.  README.md carries the same 5.
        self.assertEqual(
            count_text("  \r\n \r\n"),
            {"char_count": 5, "line_count": 2, "non_empty_line_count": 0, "word_count": 0},
        )

    def test_bc03_line_and_non_empty_counts_come_from_one_split(self):
        stats = count_text("a\n\n")
        self.assertEqual((stats["line_count"], stats["non_empty_line_count"]), (2, 1))


class NormalisationTests(unittest.TestCase):
    """BC-01, BC-02, BC-03, BC-08 and AC-02, AC-03, AC-14."""

    def test_ac02_crlf_is_normalised_to_one_line_break(self):
        self.assertEqual(count_text("a\r\nb")["line_count"], 2)

    def test_ac02_lone_cr_is_normalised_to_one_line_break(self):
        stats = count_text("a\rb")
        self.assertEqual(stats["line_count"], 2)
        self.assertEqual(stats["non_empty_line_count"], 2)

    def test_ac02_mixed_crlf_and_lone_cr_are_three_lines(self):
        stats = count_text("a\nb\r\nc\r")
        self.assertEqual(stats["line_count"], 3)
        self.assertEqual(stats["non_empty_line_count"], 3)

    def test_ac02_mixed_line_breaks_count_five_characters_and_three_words(self):
        stats = count_text("a\r\nb\rc")
        self.assertEqual(stats["char_count"], 5)
        self.assertEqual(stats["line_count"], 3)
        self.assertEqual(stats["non_empty_line_count"], 3)
        self.assertEqual(stats["word_count"], 3)
        self.assertEqual(stats, {"char_count": 5, "line_count": 3,
                                 "non_empty_line_count": 3, "word_count": 3})

    def test_ac02_each_non_boundary_character_is_kept_inside_its_line(self):
        for character in NON_BOUNDARY_CHARACTERS:
            with self.subTest(character=hex(ord(character))):
                stats = count_text("a" + character + "b")
                self.assertEqual(stats["line_count"], 1)
                self.assertEqual(stats["char_count"], 3)
                self.assertEqual(stats["non_empty_line_count"], 1)

    def test_ac02_u2028_is_counted_as_a_character(self):
        self.assertEqual(count_text("a\u2028b")["char_count"], 3)

    def test_ac14_crlf_and_cr_file_decoded_from_raw_bytes(self):
        # The exact byte sequence of "a\r\nb\rc": no universal-newline
        # translation may happen before count_text sees it (BC-13).
        raw = bytes([97, 13, 10, 98, 13, 99]).decode("utf-8")
        self.assertEqual(
            count_text(raw),
            {"char_count": 5, "line_count": 3, "non_empty_line_count": 3, "word_count": 3},
        )

    def test_ac03_character_count_after_normalisation(self):
        self.assertEqual(count_text("")["char_count"], 0)
        self.assertEqual(count_text(REFERENCE_TEXT)["char_count"], 20)
        self.assertEqual(count_text("a\r\nb")["char_count"], 3)
        self.assertEqual(count_text("a\rb")["char_count"], 3)
        self.assertEqual(count_text("\ufeffabc")["char_count"], 3)
        self.assertEqual(count_text("\ufeff\ufeffabc")["char_count"], 4)
        self.assertEqual(count_text("caf\u00e9")["char_count"], 4)

    def test_bc02_only_one_leading_bom_is_stripped(self):
        self.assertEqual(count_text("\ufeff\ufeffa")["char_count"], 2)

    def test_bc08_character_count_is_code_points_not_grapheme_clusters(self):
        self.assertEqual(count_text("cafe\u0301")["char_count"], 5)

    def test_bc09_words_are_counted_on_the_normalised_text(self):
        self.assertEqual(count_text("\ufeffalpha\r\nbeta")["word_count"], 2)


class NonEmptyLineTests(unittest.TestCase):
    """BC-06, BC-07 and AC-04."""

    def test_ac04_single_trailing_blank_line(self):
        self.assertEqual(count_text("a\n\n")["non_empty_line_count"], 1)

    def test_ac04_two_text_lines(self):
        self.assertEqual(count_text("a\nb")["non_empty_line_count"], 2)

    def test_ac04_two_empty_lines(self):
        self.assertEqual(count_text("\n\n")["non_empty_line_count"], 0)

    def test_ac04_whitespace_only_lines(self):
        self.assertEqual(count_text("  \n\t\n")["non_empty_line_count"], 0)

    def test_ac04_one_text_line_and_one_whitespace_line(self):
        stats = count_text("  a  \n\t\n")
        self.assertEqual(stats["non_empty_line_count"], 1)
        self.assertEqual(stats["line_count"], 2)

    def test_bc06_blank_lines_use_str_strip(self):
        # BC-07 defers to Python's own str.strip(); U+00A0 and the characters
        # BC-01 keeps as line content are white space for strip() even though
        # they never end a line.
        for character in ("\u00a0",) + NON_BOUNDARY_CHARACTERS:
            with self.subTest(character=hex(ord(character))):
                self.assertEqual(character.strip(), "", character)
                stats = count_text(character + "\n")
                self.assertEqual(stats["line_count"], 1)
                self.assertEqual(stats["non_empty_line_count"], 0)

    def test_bc07_full_width_space_is_stripped_as_well(self):
        stats = count_text("\u3000\n")
        self.assertEqual(stats["line_count"], 1)
        self.assertEqual(stats["non_empty_line_count"], 0)

    def test_bc06_a_line_of_only_whitespace_is_empty_but_still_a_line(self):
        stats = count_text("alpha\n \t \nbeta\n")
        self.assertEqual(stats["line_count"], 3)
        self.assertEqual(stats["non_empty_line_count"], 2)


class WordCountTests(unittest.TestCase):
    """BC-09 .. BC-12 and AC-06 .. AC-09."""

    def test_ac06_plain_words(self):
        self.assertEqual(count_text("hello world")["word_count"], 2)
        self.assertEqual(count_text("Hello hello HELLO")["word_count"], 3)

    def test_ac06_joiner_keeps_two_letter_runs_as_one_word(self):
        self.assertEqual(count_text("well-known")["word_count"], 1)
        self.assertEqual(count_text("don't")["word_count"], 1)
        self.assertEqual(count_text("it" + RSQUO + "s")["word_count"], 1)
        self.assertEqual(count_text("a-b-c")["word_count"], 1)

    def test_ac06_doubled_joiner_splits_into_two_words(self):
        self.assertEqual(count_text("hello--world")["word_count"], 2)

    def test_ac06_adjacent_u2019_literal_from_the_constant_also_joins(self):
        self.assertEqual(count_text("it" + text_stats.RIGHT_SINGLE_QUOTATION_MARK + "s")["word_count"], 1)

    def test_ac07_non_ascii_letters_are_not_word_characters(self):
        self.assertEqual(count_text("caf\u00e9")["word_count"], 1)
        self.assertEqual(count_text("caf\u00e9")["char_count"], 4)

    def test_ac07_combining_mark_does_not_break_the_adjacent_letters(self):
        self.assertEqual(count_text("cafe\u0301")["word_count"], 1)
        self.assertEqual(count_text("cafe\u0301")["char_count"], 5)

    def test_ac07_non_ascii_letter_separates_the_word_runs(self):
        self.assertEqual(count_text("caf\u00e9-mocha")["word_count"], 2)

    def test_ac07_cjk_text_has_no_words(self):
        self.assertEqual(count_text("\u4f60\u597d")["word_count"], 0)

    def test_ac08_digits_are_not_word_characters(self):
        self.assertEqual(count_text("123 456")["word_count"], 0)
        self.assertEqual(count_text("abc123")["word_count"], 1)
        self.assertEqual(count_text("a1b")["word_count"], 2)

    def test_ac08_underscore_is_not_a_word_character(self):
        self.assertEqual(count_text("a_b")["word_count"], 2)
        self.assertEqual(count_text("foo_bar baz")["word_count"], 3)
        self.assertEqual(count_text("x_y z9")["word_count"], 3)

    def test_ac09_joiners_must_touch_ascii_letters_on_both_sides(self):
        self.assertEqual(count_text(" -abc")["word_count"], 1)
        self.assertEqual(count_text("abc- ")["word_count"], 1)
        self.assertEqual(count_text("'abc")["word_count"], 1)
        self.assertEqual(count_text("a-")["word_count"], 1)
        self.assertEqual(count_text("-a")["word_count"], 1)

    def test_ac09_leading_apostrophe_does_not_prefix_the_word(self):
        stats = count_text("'abc'")
        self.assertEqual(stats["word_count"], 1)
        self.assertEqual(stats["char_count"], 5)


class ProgrammaticCallTests(unittest.TestCase):
    """Scope rule a: BC-15 with AC-10, AC-19."""

    def test_ac10_empty_stdin_text_returns_zero_and_prints_nothing(self):
        self.assertEqual(call_main([], stdin_text=""), (0, "", ""))

    def test_ac10_non_empty_stdin_text_returns_zero_and_prints_nothing(self):
        self.assertEqual(call_main([], stdin_text=REFERENCE_TEXT), (0, "", ""))

    def test_ac10_path_with_programmatic_text_returns_zero_and_prints_nothing(self):
        self.assertEqual(call_main([SAMPLE_INPUT], stdin_text="a\nb"), (0, "", ""))

    def test_bc15_explicit_override_never_reads_the_process_stdin(self):
        code, out, err = call_main([], stdin_text="ignored text", process_stdin="")
        self.assertEqual((code, out, err), (0, "", ""))

    def test_ac19_missing_file_is_an_error_even_programmatically(self):
        code, out, err = call_main(["no/such/dir/missing.txt"], stdin_text="")
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertTrue(err.startswith("error: "), err)
        self.assertEqual(err.count("\n"), 1)

    def test_ac19_error_report_is_one_line_even_with_text_available(self):
        code, out, err = call_main(["a.txt", "b.txt"], stdin_text="content")
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertEqual(err.count("\n"), 1)
        self.assertTrue(err.startswith("error: "), err)

    def test_ac13_programmatic_empty_text_never_blocks_on_process_stdin(self):
        # AC-13 requires immediate EOF never to block.  A command line run gets
        # that from an empty stream; a programmatic run must not touch the
        # stream at all, so a sys.stdin that raises on any use proves it.
        class _StreamMustNotBeRead(Exception):
            pass

        class _ForbiddenStdin:
            def read(self, *args, **kwargs):
                raise _StreamMustNotBeRead("programmatic call read sys.stdin")

        saved_stdin = sys.stdin
        out, err = io.StringIO(), io.StringIO()
        try:
            sys.stdin = _ForbiddenStdin()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = main([], stdin_text="")
        except _StreamMustNotBeRead:
            self.fail("main([], stdin_text='') read sys.stdin")
        finally:
            sys.stdin = saved_stdin
        self.assertEqual((code, out.getvalue(), err.getvalue()), (0, "", ""))

    def test_ac19_unknown_encoding_is_an_error_even_programmatically(self):
        code, out, err = call_main(
            [SAMPLE_INPUT, "--encoding", "definitely-not-an-encoding"], stdin_text=""
        )
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertTrue(err.startswith("error: "), err)
        self.assertEqual(err.count("\n"), 1)

    def test_ac20_only_the_guard_calls_main_and_nothing_forwards_to_it(self):
        with open(SCRIPT, "r", encoding="utf-8", newline="") as handle:
            source = handle.read()
        tree = ast.parse(source)
        function_names = [node.name for node in tree.body
                          if isinstance(node, ast.FunctionDef)]
        self.assertNotIn("_main", function_names)
        self.assertNotIn("run", function_names)
        callers = [
            node.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and any(
                isinstance(inner, ast.Call)
                and isinstance(inner.func, ast.Name)
                and inner.func.id == "main"
                for inner in ast.walk(node)
            )
        ]
        self.assertEqual(callers, [])


class CommandLineSuccessTests(unittest.TestCase):
    """Scope rule b success path: BC-16, BC-17, BC-19, AC-11 .. AC-14."""

    def test_ac11_sample_file_prints_exactly_the_four_lines(self):
        result = run_cli([SAMPLE_INPUT])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, REFERENCE_OUTPUT)
        self.assertEqual(result.stderr, "")

    def test_ac11_sample_file_values_are_the_documented_ones(self):
        result = run_cli([SAMPLE_INPUT])
        self.assertEqual(
            result.stdout,
            "char_count: 20\nline_count: 2\nnon_empty_line_count: 2\nword_count: 4\n",
        )

    def test_ac12_standard_input_prints_exactly_the_four_lines(self):
        result = run_cli([], stdin_text="hello world\n")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            result.stdout,
            "char_count: 12\nline_count: 1\nnon_empty_line_count: 1\nword_count: 2\n",
        )
        self.assertEqual(result.stderr, "")

    def test_ac13_immediate_eof_prints_four_zeros(self):
        result = run_cli([], stdin_text="")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, EMPTY_OUTPUT)
        self.assertEqual(result.stderr, "")

    def test_ac14_crlf_and_cr_file_prints_three_lines(self):
        with scratch_file("crlf_cr.txt", "a\r\nb\rc") as path:
            result = run_cli([path])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            result.stdout,
            "char_count: 5\nline_count: 3\nnon_empty_line_count: 3\nword_count: 3\n",
        )
        self.assertEqual(result.stderr, "")

    def test_bc13_file_path_agrees_with_the_pure_function_on_raw_text(self):
        raw = "a\r\nb\rc"
        with scratch_file("same_raw.txt", raw) as path:
            from_file = run_cli([path])
        self.assertEqual(parse_stats(from_file.stdout), count_text(raw))

    def test_bc15_explicit_injected_text_is_never_newline_translated(self):
        # A caller injecting raw text hands count_text exactly those code
        # points: no universal-newline translation may rewrite "a\r\nb\rc"
        # first, because only count_text performs the normalisation (BC-02).
        raw = "a\r\nb\rc"
        code, out, err = call_main([], stdin_text=raw)
        self.assertEqual((code, out, err), (0, "", ""))
        self.assertEqual(count_text(raw)["char_count"], 5)
        self.assertEqual(count_text(raw)["line_count"], 3)

    def test_bc16_command_line_numbers_match_the_pure_function(self):
        result = run_cli([SAMPLE_INPUT])
        stats = count_text(REFERENCE_TEXT)
        expected = "".join(
            "{0}: {1}\n".format(key, stats[key]) for key in OUTPUT_KEY_ORDER
        )
        self.assertEqual(result.stdout, expected)

    def test_bc17_programmatic_call_is_silent_where_the_cli_prints(self):
        text = "hello world\n"
        cli = run_cli([], stdin_text=text)
        self.assertEqual(cli.stdout.count("\n"), 4)
        self.assertEqual(call_main([], stdin_text=text), (0, "", ""))

    def test_bc19_output_shape_is_key_colon_space_integer_lf(self):
        result = run_cli([SAMPLE_INPUT])
        lines = result.stdout.split("\n")
        self.assertEqual(lines[-1], "")
        self.assertEqual(len(lines), 5)
        for index, line in enumerate(lines[:-1]):
            name, separator, value = line.partition(": ")
            self.assertEqual(name, OUTPUT_KEY_ORDER[index])
            self.assertEqual(separator, ": ")
            self.assertTrue(value.isdigit(), line)

    def test_bc19_no_extra_text_or_blank_line_is_emitted(self):
        result = run_cli([SAMPLE_INPUT])
        self.assertNotIn("usage", result.stdout)
        self.assertEqual(result.stdout.count("\n"), 4)


class CommandLineErrorTests(unittest.TestCase):
    """Error contract: BC-14, BC-18 with AC-15 .. AC-18."""

    def test_ac15_missing_file_exits_with_one_and_one_error_line(self):
        result = run_cli(["missing-file.txt"])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertTrue(result.stderr.startswith("error: "), result.stderr)

    def test_ac16_unknown_encoding_name_exits_with_one_and_no_traceback(self):
        result = run_cli([SAMPLE_INPUT, "--encoding", "definitely-not-an-encoding"])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertTrue(result.stderr.startswith("error: "), result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_ac17_too_many_positional_arguments_exit_with_one_not_two(self):
        result = run_cli(["a.txt", "b.txt"])
        self.assertEqual(result.returncode, 1)
        self.assertNotEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertTrue(result.stderr.startswith("error: "), result.stderr)

    def test_ac18_help_exits_with_zero_and_shows_usage(self):
        result = run_cli(["--help"])
        self.assertEqual(result.returncode, 0)
        self.assertIn("usage", result.stdout.lower())

    def test_bc18_directory_argument_is_an_error(self):
        result = run_cli([SCRATCH_ROOT])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertTrue(result.stderr.startswith("error: "), result.stderr)

    def test_bc14_undecodable_file_is_an_error(self):
        with scratch_file("undecodable.bin", b"\xff\xfe\x00\x01", binary=True) as path:
            result = run_cli([path])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertTrue(result.stderr.startswith("error: "), result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_bc18_exit_codes_are_only_zero_or_one(self):
        self.assertEqual(run_cli([SAMPLE_INPUT]).returncode, 0)
        self.assertEqual(run_cli(["missing-file.txt"]).returncode, 1)
        self.assertEqual(run_cli(["a.txt", "b.txt"]).returncode, 1)
        self.assertEqual(run_cli(["--help"]).returncode, 0)

    def test_bc14_encoding_option_semantics_are_unchanged(self):
        with scratch_file("latin1.txt", "caf\xe9 plain\n".encode("latin-1"), binary=True) as path:
            with_option = run_cli([path, "--encoding", "latin-1"])
            without_option = run_cli([path])
        self.assertEqual(with_option.returncode, 0)
        self.assertEqual(
            with_option.stdout,
            "char_count: 11\nline_count: 1\nnon_empty_line_count: 1\nword_count: 2\n",
        )
        # Decoding utf-8 by default must fail on the latin-1 byte (BC-14).
        self.assertEqual(without_option.returncode, 1)


class DeliveryConstraintTests(unittest.TestCase):
    """BC-21, BC-22, BC-23, BC-24 and AC-19, AC-20, AC-21, AC-22."""

    def test_ac21_no_bare_u2019_literal_in_delivery_sources(self):
        for name in sorted(os.listdir(HERE)):
            if not name.endswith(".py"):
                continue
            path = os.path.join(HERE, name)
            if not os.path.isfile(path):
                continue
            with open(path, "r", encoding="utf-8", newline="") as handle:
                source = handle.read()
            if RSQUO not in source:
                continue
            for number, line in enumerate(source.split("\n"), start=1):
                if RSQUO in line and "\\u2019" not in line and "U+2019" not in line:
                    self.fail(
                        "{0}:{1} holds a bare U+2019 literal".format(name, number)
                    )

    def test_ac21_readme_names_the_joiner_by_code_point(self):
        with open(README, "r", encoding="utf-8", newline="") as handle:
            document = handle.read()
        self.assertIn("\\u2019", document)
        self.assertIn("U+2019", document)
        for number, line in enumerate(document.split("\n"), start=1):
            if RSQUO in line and "\\u2019" not in line and "U+2019" not in line:
                self.fail("README.md:{0} holds a bare U+2019 literal".format(number))

    def test_ac21_module_documents_the_joiner_by_code_point(self):
        with open(SCRIPT, "r", encoding="utf-8", newline="") as handle:
            source = handle.read()
        self.assertIn("\\u2019", source)
        self.assertIn("U+2019", source)

    def test_ac19_module_imports_only_standard_library_modules(self):
        with open(SCRIPT, "r", encoding="utf-8", newline="") as handle:
            source = handle.read()
        imported = set()
        for line in source.split("\n"):
            stripped = line.strip()
            if stripped.startswith("import "):
                imported.add(stripped[len("import "):].split()[0].split(".")[0])
            elif stripped.startswith("from "):
                imported.add(stripped[len("from "):].split()[0].split(".")[0])
        self.assertTrue(imported)
        for module_name in sorted(imported):
            self.assertIn(module_name, sys.stdlib_module_names, module_name)

    def test_ac19_no_dependency_manifest_in_delivery_directory(self):
        forbidden = {
            "requirements.txt",
            "pyproject.toml",
            "setup.py",
            "setup.cfg",
            "Pipfile",
            "poetry.lock",
        }
        self.assertEqual(sorted(forbidden & set(os.listdir(HERE))), [])

    def test_ac20_main_is_called_directly_by_the_script_guard(self):
        with open(SCRIPT, "r", encoding="utf-8", newline="") as handle:
            source = handle.read()
        self.assertIn('if __name__ == "__main__":', source)
        self.assertIn("sys.exit(main())", source)

    def test_bc21_no_module_function_is_a_one_line_forwarder(self):
        with open(SCRIPT, "r", encoding="utf-8", newline="") as handle:
            source = handle.read()
        self.assertNotIn("_split_lines", source)
        self.assertNotIn("_normalize", source)
        forwarders = []
        for function in ast.walk(ast.parse(source)):
            if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            body = [node for node in function.body if not isinstance(node, ast.Expr)]
            if len(body) != 1:
                continue
            statement = body[0]
            if not isinstance(statement, ast.Return) or statement.value is None:
                continue
            value = statement.value
            called = (
                value.func.id
                if isinstance(value, ast.Call) and isinstance(value.func, ast.Name)
                else None
            )
            if called is not None and called != function.name:
                forwarders.append(
                    "{0} -> {1} (line {2})".format(function.name, called, function.lineno)
                )
        self.assertEqual(forwarders, [])

    def test_ac22_sample_input_is_the_documented_reference_text(self):
        with open(SAMPLE_INPUT, "r", encoding="utf-8", newline="") as handle:
            raw = handle.read()
        self.assertEqual(raw, REFERENCE_TEXT)
        self.assertEqual(count_text(raw), REFERENCE_STATS)

    def test_ac22_readme_examples_match_the_sample_and_the_cli(self):
        with open(README, "r", encoding="utf-8", newline="") as handle:
            document = handle.read()
        expected = run_cli([SAMPLE_INPUT]).stdout
        self.assertEqual(expected, REFERENCE_OUTPUT)
        for line in expected.strip().split("\n"):
            self.assertIn(line, document, line)


if __name__ == "__main__":
    unittest.main()
