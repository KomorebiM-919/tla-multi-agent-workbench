"""Text statistics tool (Python standard library only).

The pure function :func:`count_text` and the command line entry point
:func:`main` apply exactly the same authoritative counting rules, so the four
numbers can never disagree between the two ways of running the tool (BC-20,
BC-21).

Counting rules
--------------
char_count            ``len`` of the normalised text in Unicode code points
                      (BC-08).
line_count            number of lines obtained by splitting the normalised text
                      on LF only; a trailing LF terminates the last line instead
                      of opening a new empty one (BC-04, BC-05).
non_empty_line_count  number of those lines that still hold a character after
                      ``str.strip()`` (BC-06, BC-07).
word_count            number of matches of
                      ``[A-Za-z]+(?:[-'\\u2019][A-Za-z]+)*`` over the normalised
                      text (BC-09 .. BC-12).

Normalisation is the single place where the raw text is rewritten, in this
order (BC-02): drop one leading U+FEFF, turn every CRLF into LF, turn every
remaining lone CR into LF.  Everything else - including U+2028, U+2029,
``\\x0b``, ``\\x0c``, ``\\x1c``, ``\\x1d``, ``\\x1e`` and ``\\x85`` - is left
alone: only LF, CR and CRLF end a line (BC-01).

Entry point
-----------
``python text_stats.py [PATH] [--encoding NAME]`` writes exactly four
``<key>: <value>`` lines on standard output on success with exit code 0, and on
every handled error writes at least one ``error: `` line on standard error with
empty standard output and exit code 1 (BC-18).  A usage error - more than one
positional argument - uses that same exit code 1 rather than argparse's default
2; ``--help`` still exits with 0.

A programmatic call - ``main(...)`` invoked with an explicit ``stdin_text``
argument, ``""`` included - only returns an exit code, writes nothing at all and
touches neither process stream, the injected text being the whole input (BC-15).

Worked example for the one input whose figure was once ambiguous
----------------------------------------------------------------
``"  \\r\\n \\r\\n"`` holds 7 raw code points; BC-02 rewrites it to
``"  \\n \\n"``, so BC-08 counts 5 of them - ``char_count`` is 5, never 6 (AC-05).
"""

import argparse
import codecs
import contextlib
import io
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

# Label order of the four output lines is part of the contract (BC-19).
CHAR_COUNT = "char_count"
LINE_COUNT = "line_count"
NON_EMPTY_LINE_COUNT = "non_empty_line_count"
WORD_COUNT = "word_count"
OUTPUT_KEYS = (CHAR_COUNT, LINE_COUNT, NON_EMPTY_LINE_COUNT, WORD_COUNT)

# BC-11: the only characters allowed to join two ASCII letter runs.  The third
# one is U+2019 RIGHT SINGLE QUOTATION MARK, a character that is visually
# identical to an ASCII apostrophe; it is named here by code point so that no
# reader has to guess which of the two look-alikes a literal means.
RIGHT_SINGLE_QUOTATION_MARK = "\u2019"
WORD_JOINERS = "-'" + RIGHT_SINGLE_QUOTATION_MARK

# BC-09: maximal ASCII letter runs, optionally joined internally by a single
# joiner.  A doubled joiner such as "--" cannot be absorbed by one match, so it
# splits the run in two (BC-11); a joiner at the start or the end of a run is
# not matched either (BC-11).
WORD_PATTERN = re.compile(r"[A-Za-z]+(?:[{0}][A-Za-z]+)*".format(WORD_JOINERS))


def count_text(text):
    """Count characters, lines, non-empty lines and English words in *text*.

    Pure programmatic interface: it takes already decoded text, reads no file
    and no process stream, and depends on its argument alone (BC-20).

    :param text: already decoded text.
    :returns: dict with exactly the four integer keys of :data:`OUTPUT_KEYS`.
    """
    # BC-02: one leading BOM is dropped, then CRLF and finally lone CR become
    # LF.  Splitting the normalised text on LF is the single split that both
    # line counters use, so they can never disagree (BC-03).
    if text.startswith(BYTE_ORDER_MARK):
        text = text[len(BYTE_ORDER_MARK):]
    if CARRIAGE_RETURN in text:
        text = text.replace(CARRIAGE_RETURN_NEWLINE, NEWLINE)
        text = text.replace(CARRIAGE_RETURN, NEWLINE)

    if text == "":
        # BC-04: empty text holds no line at all.
        lines = []
    else:
        lines = text.split(NEWLINE)
        if lines[-1] == "":
            # BC-05: a trailing LF ends the last line instead of starting one.
            lines.pop()

    return {
        CHAR_COUNT: len(text),
        LINE_COUNT: len(lines),
        NON_EMPTY_LINE_COUNT: sum(1 for line in lines if line.strip() != ""),
        WORD_COUNT: len(WORD_PATTERN.findall(text)),
    }


def _format_stats(stats):
    """Render the four output lines in ``<key>: <value>`` form (BC-19)."""
    return "".join(
        "{0}: {1}{2}".format(key, stats[key], NEWLINE) for key in OUTPUT_KEYS
    )


def _read_file(path, encoding):
    """Read *path* as text, preserving the original newline characters.

    Universal-newline translation is disabled (``newline=""``) so that
    :func:`count_text` receives the raw ``\\r\\n`` / ``\\r`` characters and is
    the single place performing the documented normalisation; that is what keeps
    the file path and the standard input path identical for the same raw text
    (BC-13).
    """
    with open(path, "r", encoding=encoding, newline="") as handle:
        return handle.read()


def _encoding_for(name):
    """Return the encoding to use, raising :class:`LookupError` when unknown.

    Without ``--encoding`` the tool decodes as UTF-8; an explicitly named
    encoding is validated with :func:`codecs.lookup`, which raises
    :class:`LookupError` for a name Python does not know (BC-14).
    """
    if name is None:
        return ENCODING_UTF8
    codecs.lookup(name)
    return name


def _write(stream, text):
    """Write *text* to *stream*, never turning a diagnostic into a crash.

    Nothing escapes :func:`main`: a stream that cannot represent what is being
    written must not replace the documented exit code with a traceback.
    """
    try:
        stream.write(text)
    except (UnicodeError, OSError):
        pass


def _report_error(message, quiet=False):
    """Write exactly one ``error: `` line to standard error (BC-18).

    A programmatic call (``stdin_text is not None``) stays silent on **both**
    streams (BC-15): the caller already gets the exit code, so the diagnostic is
    suppressed instead of leaking to a stream this call promised not to touch.
    """
    if quiet:
        return
    _write(sys.stderr, ERROR_PREFIX + message + NEWLINE)


class _ParserExit(Exception):
    """Raised by the argument parser instead of argparse's ``SystemExit``.

    ``argparse`` normally prints a usage error to standard error and exits with
    code 2, which BC-18 forbids.  Both :meth:`error` and :meth:`exit` of the
    parser below therefore raise this exception, which :func:`main` converts
    into the tool's own contract: exit code 1 with an ``error: `` line for usage
    errors, exit code 0 for ``--help``.
    """

    def __init__(self, status, message=""):
        super().__init__(message or "parser exit {0}".format(status))
        self.status = status


class _UsageErrorParser(argparse.ArgumentParser):
    """Argument parser whose exits follow this tool's documented contract."""

    def error(self, message):
        raise _ParserExit(EXIT_ERROR, message)

    def exit(self, status=EXIT_OK, message=None):
        raise _ParserExit(status, (message or "").strip())


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


def _parse_args(argv, quiet):
    """Parse *argv*, honouring the silent-scope rule for programmatic calls.

    A programmatic ``--help`` still ends with exit code 0, but scope rule a
    promises that such a call writes nothing: argparse's help text is written to
    a discarded buffer instead of the caller's standard output.  A command line
    call keeps the normal help text.
    """
    parser = _build_parser()
    if not quiet:
        return parser.parse_args(argv)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return parser.parse_args(argv)


def _read_stdin_text():
    """Read all of standard input, or ``None`` when it cannot be decoded.

    A ``UnicodeDecodeError`` here is BC-14's decoding failure, and the returned
    ``None`` is how that failure reaches :func:`main`; no other condition makes
    this function return ``None``.
    """
    try:
        return sys.stdin.read()
    except UnicodeDecodeError as exc:
        _report_error("standard input: {0}".format(exc))
        return None


def main(argv=None, stdin_text=None):
    """Run the tool and return the process exit code.

    Scope rule a (BC-15): as soon as the caller passes *stdin_text* explicitly -
    even the empty string - this is a programmatic call: the function only
    returns an exit code, never writes to standard output and never reads the
    process streams; the caller prints the result itself.

    Scope rule b (BC-16): when *stdin_text* is ``None`` this is a command line
    run - a PATH argument is read as a file, otherwise standard input is read -
    and a successful run writes exactly the four ``<key>: <value>`` lines in
    the order of :data:`OUTPUT_KEYS`.

    The two rules select the input and the output scope, not the exit code: a
    PATH or an ``--encoding`` that cannot be read or validated is still a
    handled error with exit code 1 in both call kinds (BC-18).  Only the
    diagnostic line differs - a command line run writes ``error: ...`` to
    standard error, a programmatic run keeps both streams empty because scope
    rule a promises it writes nothing at all (BC-15).

    An explicitly invalid ``--encoding`` is rejected before the input is
    chosen, so ``main(["--encoding", "bogus"], stdin_text="")`` returns 1 while
    still writing nothing.

    :param argv: argument list without the program name (``None`` -> ``sys.argv[1:]``).
    :param stdin_text: programmatic text override; ``None`` means command line mode.
    :returns: ``0`` on success and on ``--help``, ``1`` on every handled error (BC-18).
    """
    programmatic = stdin_text is not None
    try:
        args = _parse_args(argv, programmatic)
    except _ParserExit as exc:
        if exc.status == EXIT_OK:
            # --help: a command line run already wrote the usage text; a
            # programmatic run discarded it, so both simply return 0 here.
            return EXIT_OK
        _report_error("invalid arguments ({0})".format(exc), programmatic)
        return EXIT_ERROR

    try:
        # BC-14: an unknown --encoding name is an error on its own, before the
        # input is chosen - no PATH and empty injected text do not excuse it.
        encoding = _encoding_for(args.encoding)
    except LookupError:
        _report_error("unknown encoding: {0}".format(args.encoding), programmatic)
        return EXIT_ERROR

    if args.path is not None:
        try:
            text = _read_file(args.path, encoding)
        except (OSError, UnicodeDecodeError) as exc:
            _report_error("{0}: {1}".format(args.path, exc), programmatic)
            return EXIT_ERROR
        # Any named file must still be readable even in a programmatic call,
        # which is why this read happens before the scope split below.
    elif programmatic:
        # BC-15: the caller supplied the text, so report nothing at all.
        return EXIT_OK
    else:
        # BC-13: standard input is decoded exactly like a file, and only
        # count_text normalises what either path hands it.
        text = _read_stdin_text()
        if text is None:
            return EXIT_ERROR

    if not programmatic:
        _write(sys.stdout, _format_stats(count_text(text)))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
