"""Text statistics tool (Python standard library only).

Provides a pure function :func:`count_text` and a command line entry point
:func:`main`; both share exactly the same counting rules (BC-15).

Counting rules
--------------
char_count            ``len`` of the newline-normalised text, Unicode code
                      points (BC-01, BC-02).
line_count            ``len(text.splitlines())`` on the normalised text, minus
                      the U+2028/U+2029 characters that BC-02 does not
                      normalise; that is the single authoritative definition
                      (BC-02, BC-03).
non_empty_line_count  number of lines that still contain a non-whitespace
                      character after ``str.strip()`` (BC-04).
word_count            number of matches of ``[A-Za-z]+(?:[-'\\u2019][A-Za-z]+)*``
                      over the normalised text (BC-06 .. BC-10).

Entry point
-----------
``python text_stats.py [PATH] [--encoding NAME]`` writes exactly four
``<key>: <value>`` lines on success (exit code 0) and, on every handled error,
one ``error: `` line on standard error with empty standard output (exit code 1,
including usage errors with more than one positional argument, BC-13/BC-14).
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
USAGE_PREFIX = "usage: "

# Label order of the four output lines is part of the contract (BC-12).
CHAR_COUNT = "char_count"
LINE_COUNT = "line_count"
NON_EMPTY_LINE_COUNT = "non_empty_line_count"
WORD_COUNT = "word_count"
OUTPUT_KEYS = (CHAR_COUNT, LINE_COUNT, NON_EMPTY_LINE_COUNT, WORD_COUNT)

# BC-06 / BC-08: maximal ASCII-letter runs, optionally joined once or several
# times by a single internal hyphen, ASCII apostrophe or right single quotation
# mark (a doubled joiner such as "--" cannot match and therefore splits runs).
WORD_PATTERN = re.compile(r"[A-Za-z]+(?:[-'\u2019][A-Za-z]+)*")

# BC-02 fixes the newline normalisation to CRLF/CR only, so the line split of
# BC-03 must not treat the other characters that ``str.splitlines()`` knows
# about as line boundaries.  U+2028 LINE SEPARATOR and U+2029 PARAGRAPH
# SEPARATOR are therefore replaced by a private-use placeholder that cannot
# occur in decoded text before the split, and restored afterwards.
LINE_SEPARATOR = "\u2028"
PARAGRAPH_SEPARATOR = "\u2029"
PROTECTED_SEPARATOR = "\ue000"

# A faithful equivalent of the ``str.splitlines()`` boundary set used after the
# separators above have been neutralised: LF, VT, FF, FS, GS, RS and NEL.  A
# trailing boundary does not create a final empty line, exactly like
# ``str.splitlines()``.
LINE_BOUNDARY_PATTERN = re.compile(r"\n|\v|\f|\x1c|\x1d|\x1e|\x85")


def _normalize(text):
    """Strip a leading BOM and normalise newlines (BC-01, BC-02, BC-11).

    Only a single leading ``\\ufeff`` is removed, and only ``\\r\\n`` / ``\\r``
    are rewritten; every other character (including U+2028, U+2029, ``\\x0b``,
    ``\\x0c`` and ``\\x85``) is left untouched.
    """
    if text.startswith(BYTE_ORDER_MARK):
        text = text[len(BYTE_ORDER_MARK):]
    if CARRIAGE_RETURN in text:
        text = text.replace(CARRIAGE_RETURN_NEWLINE, NEWLINE)
        text = text.replace(CARRIAGE_RETURN, NEWLINE)
    return text


def _split_lines(text):
    """Split normalised *text* into lines following BC-03.

    The definition is Python's ``str.splitlines()`` semantics applied to the
    newline set that BC-02 leaves in place: ``""`` has no lines, ``"\\n"`` has
    one (empty) line, ``"a\\n"`` has one line, ``"a\\n\\n"`` has two, and
    ``"a\\u2028b"`` has one because U+2028 is never rewritten to ``"\\n"``.
    """
    if text == "":
        return []
    masked = text.replace(LINE_SEPARATOR, PROTECTED_SEPARATOR).replace(
        PARAGRAPH_SEPARATOR, PROTECTED_SEPARATOR
    )
    lines = LINE_BOUNDARY_PATTERN.split(masked)
    if lines and lines[-1] == "":
        lines.pop()
    return [line.replace(PROTECTED_SEPARATOR, LINE_SEPARATOR) for line in lines]


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
    """Render the four stable output lines (BC-12)."""
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
    # codecs.lookup raises LookupError for unknown encoding names (BC-13).
    codecs.lookup(name)
    return name


def _write(stream, text):
    """Write *text* to *stream*, never turning a diagnostic into a crash.

    Nothing escapes :func:`main`: a stream that cannot represent the characters
    of a path must not replace the documented exit code with a traceback.
    """
    try:
        stream.write(text)
    except (UnicodeError, OSError):
        pass


def _report_error(message):
    """Write one ``error: `` line to standard error (BC-13)."""
    _write(sys.stderr, ERROR_PREFIX + message + NEWLINE)


class _UsageErrorParser(argparse.ArgumentParser):
    """Argument parser whose usage errors follow the tool's error contract.

    ``argparse`` normally prints a usage error to standard error and terminates
    with exit code 2.  BC-13/BC-14 require the same behaviour on every error
    path: exit code 1, empty standard output and a standard-error line starting
    with ``error: ``.  Both :meth:`error` and :meth:`exit` therefore raise
    :class:`ValueError`, which :func:`main` converts into that contract, so no
    ``SystemExit`` escapes.
    """

    def error(self, message):
        raise ValueError(message)

    def exit(self, status=0, message=None):
        if status:
            raise ValueError((message or "").strip() or "invalid arguments")
        super().exit(status, message)


def _build_parser():
    parser = _UsageErrorParser(
        prog="text_stats.py",
        description=(
            "Print char/line/non-empty-line/word counts for text read from a "
            "PATH file or from standard input."
        ),
    )
    parser.add_argument(
        "path", nargs="?", help="file to read; omit to read standard input"
    )
    parser.add_argument(
        "--encoding",
        default=None,
        help="encoding used to decode the file (default: utf-8)",
    )
    return parser


def main(argv=None, stdin_text=None):
    """Run the command line tool and return the process exit code.

    :param argv: argument list without the program name (``None`` -> ``sys.argv``).
    :param stdin_text: text used instead of reading ``sys.stdin`` when no PATH is
        given; an explicitly empty string therefore reports nothing.  ``None``
        (the default) reads the whole of standard input.
    :returns: ``0`` on success, ``1`` on any handled error (BC-13, BC-14).
    """
    try:
        args = _build_parser().parse_args(argv)
    except ValueError as exc:
        _report_error(
            "{0}invalid arguments ({1}); expected at most one PATH".format(
                USAGE_PREFIX, exc
            )
        )
        return EXIT_ERROR
    except SystemExit as exc:
        # ``--help`` (and ``--version``) is a successful early exit: argparse has
        # already written the text, so only the status code has to be honoured.
        if exc.code in (None, EXIT_OK):
            return EXIT_OK
        _report_error("invalid arguments; expected at most one PATH")
        return EXIT_ERROR

    try:
        encoding = _resolve_encoding(args.encoding)
    except LookupError:
        _report_error("unknown encoding: {0}".format(args.encoding))
        return EXIT_ERROR

    if args.path is None:
        if stdin_text is None:
            # Real command-line run: read the whole of standard input (BC-11).
            _write(sys.stdout, _format_stats(count_text(sys.stdin.read())))
            return EXIT_OK
        # In-process run with an explicit text override (used by callers and
        # tests to exercise the pipeline without touching the process streams);
        # an empty override therefore writes nothing.
        text = stdin_text
        if text:
            _write(sys.stdout, _format_stats(count_text(text)))
        return EXIT_OK

    try:
        text = _read_file(args.path, encoding)
    except (OSError, UnicodeDecodeError) as exc:
        _report_error("{0}: {1}".format(args.path, exc))
        return EXIT_ERROR

    _write(sys.stdout, _format_stats(count_text(text)))
    return EXIT_OK

if __name__ == "__main__":
    sys.exit(main())
