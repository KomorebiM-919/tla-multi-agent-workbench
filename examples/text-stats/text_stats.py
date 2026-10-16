"""Text statistics tool (Python standard library only).

Provides a pure function :func:`count_text` and a command line entry point
:func:`main`; both share exactly the same counting rules (BC-15).

Counting rules
--------------
char_count            ``len`` of the newline-normalised text (Unicode code
                      points, BC-01).
line_count            0 for the empty string, otherwise the number of segments
                      produced by splitting the normalised text on ``"\\n"``
                      (BC-03).
non_empty_line_count  number of lines that still contain a non-whitespace
                      character after ``str.strip()`` (BC-04).
word_count            number of maximal runs of ASCII letters, where single
                      internal ``-``, ``'`` or ``'`` characters may join two
                      letter runs (BC-06 .. BC-10).

Two examples in the requirement's own acceptance criteria contradict its
normative ``boundary_conditions`` text (AC-02/AC-06 versus BC-03 for a trailing
newline, and AC-05 versus BC-06/BC-09 for accented letters).  ``scope_in``
designates BC-01 .. BC-11 as the sole authority for implementation and
acceptance, so the boundary conditions win; the contradicting values are pinned
by ``test_text_stats.py`` (class ``TestSpecificationConflicts``) and documented
in ``README.md``.
"""

import argparse
import codecs
import re
import sys

# --- named constants (no magic values) -------------------------------------

ENCODING_UTF8 = "utf-8"
BYTE_ORDER_MARK = "\ufeff"
NEWLINE = "\n"
CARRIAGE_RETURN = "\r"
CARRIAGE_RETURN_NEWLINE = "\r\n"

EXIT_OK = 0
EXIT_ERROR = 1

ERROR_PREFIX = "error: "

# Label order of the four output lines is part of the contract (BC-14).
CHAR_COUNT = "char_count"
LINE_COUNT = "line_count"
NON_EMPTY_LINE_COUNT = "non_empty_line_count"
WORD_COUNT = "word_count"
OUTPUT_KEYS = (CHAR_COUNT, LINE_COUNT, NON_EMPTY_LINE_COUNT, WORD_COUNT)

# BC-06 / BC-08: maximal ASCII-letter runs, optionally joined once or several
# times by a single internal hyphen, apostrophe or right single quotation mark
# (a doubled joiner such as "--" cannot match and therefore splits the runs).
WORD_PATTERN = re.compile(r"[A-Za-z]+(?:[-'\u2019][A-Za-z]+)*")


def _normalize(text):
    """Strip a leading BOM and normalise newlines (BC-02, BC-11)."""
    if text.startswith(BYTE_ORDER_MARK):
        text = text[len(BYTE_ORDER_MARK):]
    if CARRIAGE_RETURN in text:
        text = text.replace(CARRIAGE_RETURN_NEWLINE, NEWLINE)
        text = text.replace(CARRIAGE_RETURN, NEWLINE)
    return text


def _split_lines(text):
    """Split normalised *text* into lines following BC-03.

    The empty string has no lines at all, and a trailing newline does not
    create an extra empty line, so a single trailing empty segment is dropped.
    """
    if text == "":
        return []
    lines = text.split(NEWLINE)
    if lines[-1] == "":
        lines.pop()
    return lines


def _count_lines(text):
    """Return ``(line_count, non_empty_line_count)`` for normalised text."""
    lines = _split_lines(text)
    non_empty = sum(1 for line in lines if line.strip() != "")
    return len(lines), non_empty


def count_text(text):
    """Count characters, lines, non-empty lines and English words.

    :param text: already decoded text.
    :returns: dict with exactly the four integer keys of :data:`OUTPUT_KEYS`.
    """
    normalized = _normalize(text)
    line_count, non_empty_line_count = _count_lines(normalized)
    return {
        CHAR_COUNT: len(normalized),
        LINE_COUNT: line_count,
        NON_EMPTY_LINE_COUNT: non_empty_line_count,
        WORD_COUNT: len(WORD_PATTERN.findall(normalized)),
    }


def _format_stats(stats):
    """Render the four stable output lines (BC-14)."""
    return "".join(
        "{0}: {1}{2}".format(key, stats[key], NEWLINE) for key in OUTPUT_KEYS
    )


def _read_file(path, encoding):
    """Read *path* as text, translating I/O and decoding failures.

    Universal-newline decoding is disabled so that ``count_text`` receives the
    original ``\\r\\n`` / ``\\r`` characters and performs the single documented
    normalisation itself (BC-02).  That keeps the command line counts identical
    to calling ``count_text`` on the same raw text (BC-15).
    """
    with open(path, "r", encoding=encoding, newline="") as handle:
        return handle.read()


def _resolve_encoding(name):
    """Validate an encoding name, raising :class:`LookupError` when unknown."""
    if name is None:
        return ENCODING_UTF8
    # codecs.lookup raises LookupError for unknown encoding names (BC-12).
    codecs.lookup(name)
    return name


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="text_stats.py",
        description="Print char/line/non-empty-line/word counts for text.",
    )
    parser.add_argument("path", nargs="?", help="file to read (default: stdin)")
    parser.add_argument(
        "--encoding",
        default=None,
        help="encoding used to decode the file (default: utf-8)",
    )
    return parser


def main(argv=None, stdin_text=None):
    """Run the command line tool and return the process exit code.

    :param argv: argument list without the program name (``None`` -> ``sys.argv``).
    :param stdin_text: text used instead of reading ``sys.stdin``.
    :returns: ``0`` on success, ``1`` on any handled error (BC-12, BC-13).
    """
    args = _build_parser().parse_args(argv)

    try:
        encoding = _resolve_encoding(args.encoding)
    except LookupError:
        sys.stderr.write(
            "{0}unknown encoding: {1}{2}".format(ERROR_PREFIX, args.encoding, NEWLINE)
        )
        return EXIT_ERROR

    if args.path is None:
        if stdin_text is None:
            stdin_text = sys.stdin.read()
        text = stdin_text
    else:
        try:
            text = _read_file(args.path, encoding)
        except (OSError, UnicodeDecodeError) as exc:
            sys.stderr.write(
                "{0}{1}: {2}{3}".format(ERROR_PREFIX, args.path, exc, NEWLINE)
            )
            return EXIT_ERROR

    sys.stdout.write(_format_stats(count_text(text)))
    return EXIT_OK


def _cli(argv=None):
    """Return the process exit code for the ``__main__`` entry point."""
    return main(argv)


if __name__ == "__main__":
    sys.exit(_cli())
