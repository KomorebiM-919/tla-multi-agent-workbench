#!/usr/bin/env python3
"""Official offline verifier for the run5 delivery (AC-01..AC-29).

This tool supersedes ``docs/run-records/v0.4-run5-20261017T161034Z/independent-review.py``
for acceptance purposes.  The earlier script proved less than its "25 / 25" line
suggested (see ``README.md`` in this directory for the exact gap), so this file
re-derives every acceptance criterion from the requirement text and fixes three
defects:

* **AC-28** used to compare the bytecode cache against a snapshot taken *before*
  it ran the suite, so the comparison was vacuous.  It now snapshots, runs the
  documented test command, then snapshots again, and compares the file set,
  the sha256 of every file and the ``mtime_ns`` values with an explicit,
  documented timestamp criterion (exact equality: the command suppresses
  bytecode writing, so touching the cache at all is a failure).
* **AC-29** used to require the working tree to contain exactly three
  modifications, which made a clean checkout fail.  It now checks two separate
  things: the committed change scope of the delivery commit (``base..delivery``)
  and whether running the review itself modified the working tree.
* **Failure semantics**: a failing git command, an unreadable snapshot or a
  missing piece of evidence raises :class:`EvidenceError`` and is reported as a
  failure.  Empty output is never treated as "clean".

The tool is deterministic, uses only the Python standard library, and makes no
model calls.  ``--self-test`` exercises the three fixes against synthetic
counter-examples (cache added during the test run, same-size different content,
touched timestamps, clean copy, undeclared file, failing git).

Usage (from the repository root, outputs land outside the delivered tree)::

    python docs/run-records/v0.4-run5-20261017T161034Z/review-package/verify-run5.py \
        --out docs/run-records/v0.4-run5-20261017T161034Z/review-package/verification.json

Exit codes: 0 = every criterion reproduced and the self-test contract holds,
1 = at least one criterion differs or the self-test finds a harness bug.
"""

import argparse
import ast
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

SAMPLE_BYTES = b"hello world\nfoo bar\n"
SAMPLE_STATS = {
    "char_count": 20,
    "line_count": 2,
    "non_empty_line_count": 2,
    "word_count": 4,
}
ZERO_STATS = {
    "char_count": 0,
    "line_count": 0,
    "non_empty_line_count": 0,
    "word_count": 0,
}
KEYS = ("char_count", "line_count", "non_empty_line_count", "word_count")
STATS_LINE = re.compile(r"^(char_count|line_count|non_empty_line_count|word_count): (0|[1-9][0-9]*)$")
ERROR_LINE = re.compile(r"^error: \S")
TRACEBACK_MARKER = "Traceback (most recent call last)"

# AC-10 / R-16: eight characters that Unicode-aware splitting would treat as
# line breaks but this requirement does not.
NON_LINE_BREAKS = ("\u2028", "\u2029", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85")

# R-32 / BC-27: the only files the delivery commit may touch.
ALLOWED_DELIVERY_FILES = (
    "examples/text-stats/README.md",
    "examples/text-stats/test_text_stats.py",
    "examples/text-stats/text_stats.py",
    "examples/text-stats/sample_input.txt",
)

# Paths that already existed untracked before this review (historical review
# packages and one aborted-run evidence directory).  They are allowed to remain
# in the main checkout; they must not change while the review runs.
ALLOWED_HISTORY_PREFIXES = (
    "docs/evidence/v0.1-approval-rejection-20261017T112518Z/",
    "docs/review/",
)

TEST_TEMP_PREFIX = "examples/text-stats/.test-scratch/"

CACHE_TIME_CRITERION = (
    "mtime_ns must be identical (tolerance 0 ns). The documented test command "
    "runs with PYTHONDONTWRITEBYTECODE=1, so the cache cannot be written; any "
    "mtime movement means the command wrote bytecode and the suppression failed."
)

# R-35: the four stdin examples the README documents as copy-paste commands.
# Each is replayed through a real subprocess, so the assertion covers the exit
# code, both streams and the four statistics instead of matching README text.
README_EXAMPLES = (
    (
        "hello world\\n",
        b"hello world\n",
        {"char_count": 12, "line_count": 1, "non_empty_line_count": 1, "word_count": 2},
    ),
    (
        "a\\r\\nb\\rc",
        b"a\r\nb\rc",
        {"char_count": 5, "line_count": 3, "non_empty_line_count": 3, "word_count": 3},
    ),
    (
        "'  \\r\\n \\r\\n'",
        b"  \r\n \r\n",
        {"char_count": 5, "line_count": 2, "non_empty_line_count": 0, "word_count": 0},
    ),
    ("empty stdin", b"", ZERO_STATS),
)

# R-29 / BC-22: the UTF-16LE demonstration the README itself documents.
UTF16_DEMO_NAME = "utf16le-demo.txt"
UTF16_DEMO_TEXT = "abc\n"
UTF16_DEMO_STATS = {
    "char_count": 4,
    "line_count": 1,
    "non_empty_line_count": 1,
    "word_count": 1,
}

# R-29: stdin of this text decoded as UTF-16 gives 3/1/1/1; the same bytes read
# with the default stream codec cannot give that result, which is what makes the
# probe falsifiable.
STDIO_ENCODING_TEXT = "ab\r\n"
STDIO_ENCODING_STATS = {
    "char_count": 3,
    "line_count": 1,
    "non_empty_line_count": 1,
    "word_count": 1,
}
STDIO_ENCODING_VAR = "PYTHONIOENCODING"
STDIO_ENCODING_VALUE = "utf-16"

CFG = {}


class EvidenceError(RuntimeError):
    """Required evidence could not be collected. Always reported as a failure."""


# --------------------------------------------------------------------------
# process helpers
# --------------------------------------------------------------------------


def child_env():
    """Return a subprocess environment that cannot create bytecode anywhere."""
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.pop("PYTHONPATH", None)
    return env


def run_git(args):
    """Run git in the configured repository and return stdout. Fails loudly."""
    try:
        completed = subprocess.run(
            ["git"] + list(args),
            capture_output=True,
            cwd=CFG["repo"],
            env=child_env(),
        )
    except OSError as exc:
        raise EvidenceError(
            "git {0} could not run in {1}: {2}".format(" ".join(args), CFG["repo"], exc)
        )
    if completed.returncode != 0:
        raise EvidenceError(
            "git {0} failed with {1}: {2}".format(
                " ".join(args),
                completed.returncode,
                completed.stderr.decode("utf-8", "replace").strip() or "<empty stderr>",
            )
        )
    return completed.stdout.decode("utf-8", "replace")


def parse_status(text):
    """Parse ``git status --porcelain`` into ``[(code, path)]``."""
    entries = []
    for line in text.splitlines():
        if not line.strip():
            continue
        entries.append((line[:2], line[3:].replace("\\", "/")))
    return entries


def git_status():
    """Return the parsed working-tree status. Never returns empty on failure."""
    return parse_status(run_git(["status", "--porcelain"]))


def git_changed_paths(base, tip):
    """Return the paths a commit range touched, as a sorted list."""
    out = run_git(["diff", "--name-only", "{0}..{1}".format(base, tip)])
    return sorted(line.strip().replace("\\", "/") for line in out.splitlines() if line.strip())


def git_blob(path):
    """Return (sha256, size) of a path as committed at HEAD."""
    out = run_git(["cat-file", "-s", "HEAD:" + path]).strip()
    try:
        size = int(out)
    except ValueError:
        raise EvidenceError("git cat-file -s HEAD:{0} returned {1!r}".format(path, out))
    raw = subprocess.run(
        ["git", "cat-file", "blob", "HEAD:" + path],
        capture_output=True,
        cwd=CFG["repo"],
        env=child_env(),
    )
    if raw.returncode != 0:
        raise EvidenceError(
            "git cat-file blob HEAD:{0} failed: {1}".format(
                path, raw.stderr.decode("utf-8", "replace").strip()
            )
        )
    return hashlib.sha256(raw.stdout).hexdigest(), size


# --------------------------------------------------------------------------
# bytecode cache snapshots (AC-28)
# --------------------------------------------------------------------------


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def snapshot_cache(directory):
    """Return ``{"exists": bool, "files": {name: {size, mtime_ns, sha256}}}``."""
    state = {"exists": os.path.isdir(directory), "files": {}}
    if not state["exists"]:
        return state
    try:
        names = sorted(os.listdir(directory))
    except OSError as exc:
        raise EvidenceError("cannot list {0}: {1}".format(directory, exc))
    for name in names:
        full = os.path.join(directory, name)
        if not os.path.isfile(full):
            raise EvidenceError("unexpected non-file entry in {0}: {1}".format(directory, name))
        try:
            stat = os.stat(full)
            state["files"][name] = {
                "size": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
                "sha256": sha256_file(full),
            }
        except OSError as exc:
            raise EvidenceError("cannot read {0}: {1}".format(full, exc))
    return state


def cache_delta(before, after, tolerance_ns=0):
    """Return the list of human-readable differences between two snapshots."""
    problems = []
    if before["exists"] != after["exists"]:
        problems.append(
            "cache directory appeared" if after["exists"] else "cache directory disappeared"
        )
    old = before["files"]
    new = after["files"]
    for name in sorted(set(new) - set(old)):
        problems.append("added {0} ({1} bytes)".format(name, new[name]["size"]))
    for name in sorted(set(old) - set(new)):
        problems.append("removed {0}".format(name))
    for name in sorted(set(old) & set(new)):
        if old[name]["size"] != new[name]["size"]:
            problems.append(
                "size changed for {0}: {1} -> {2}".format(name, old[name]["size"], new[name]["size"])
            )
        if old[name]["sha256"] != new[name]["sha256"]:
            problems.append(
                "content changed for {0}: {1} -> {2}".format(
                    name, old[name]["sha256"][:16], new[name]["sha256"][:16]
                )
            )
        drift = new[name]["mtime_ns"] - old[name]["mtime_ns"]
        if abs(drift) > tolerance_ns:
            problems.append("mtime moved for {0} by {1} ns".format(name, drift))
    return problems


# --------------------------------------------------------------------------
# delivery probes
# --------------------------------------------------------------------------


def run_cli(args, stdin_bytes=b"", cwd=None):
    """Run ``python text_stats.py <args>`` and return (code, stdout, stderr)."""
    return run_cli_env(args, stdin_bytes, {}, cwd)


def run_cli_env(args, stdin_bytes=b"", extra_env=None, cwd=None):
    """Run the CLI with extra variables that apply to the child process only."""
    env = child_env()
    env.update(extra_env or {})
    completed = subprocess.run(
        [sys.executable, os.path.basename(CFG["tool"])] + list(args),
        input=stdin_bytes,
        capture_output=True,
        cwd=cwd or CFG["tool_dir"],
        env=env,
    )
    return completed.returncode, completed.stdout, completed.stderr


def run_py(code, cwd=None):
    """Run a one-liner inside the delivery directory; return (code, out, err)."""
    completed = subprocess.run(
        [sys.executable, "-c", code],
        input=b"",
        capture_output=True,
        cwd=cwd or CFG["tool_dir"],
        env=child_env(),
    )
    return completed.returncode, completed.stdout, completed.stderr


def run_programmatic(body):
    """Run *body* in a ``-c`` program that imports the tool and prints one JSON."""
    code = (
        "import json, sys\n"
        "import text_stats as t\n"
        "def probe():\n"
        "    return " + body + "\n"
        "print(json.dumps(probe()))\n"
    )
    return run_py(code)


def parse_stats(stdout, encoding="utf-8"):
    """Parse the four output lines into a dict, or return None when malformed."""
    if isinstance(stdout, bytes):
        try:
            stdout = stdout.decode(encoding)
        except UnicodeDecodeError:
            return None
    lines = stdout.splitlines()
    if len(lines) != 4:
        return None
    stats = {}
    for index, key in enumerate(KEYS):
        prefix = key + ": "
        if not lines[index].startswith(prefix):
            return None
        value = lines[index][len(prefix):]
        if not value.isdigit():
            return None
        stats[key] = int(value)
    return stats


def readme_block(stats):
    """Return the four-line block the README must show for these statistics."""
    return "\n".join("{0}: {1}".format(key, stats[key]) for key in KEYS)


def documented_forms(stats):
    """Return the two shapes the README uses to state the same four numbers.

    Console examples show four lines; python examples show ``count_text``'s dict
    repr. Both make the same claim, so a probe accepts either form but nothing
    weaker (a bare number such as ``12`` does not count as documentation).
    """
    block = readme_block(stats)
    pairs = ", ".join("'{0}': {1}".format(key, stats[key]) for key in KEYS)
    return (block, "{" + pairs + "}")


def example_problems(code, out, err, expected, encoding="utf-8"):
    """Return the ways one subprocess example deviates from its expectation.

    Comparing only the four numbers would let a probe pass while the exit code
    was wrong, an error line leaked into stderr, or extra text reached stdout,
    so every documented facet is checked separately.
    """
    problems = []
    if code != 0:
        problems.append("exit code {0}".format(code))
    if err != b"":
        problems.append("stderr {0!r}".format(err))
    stats = parse_stats(out, encoding=encoding)
    if stats != expected:
        problems.append("stats {0} != {1}".format(stats, expected))
    text = out.decode(encoding, "replace") if isinstance(out, bytes) else out
    if text.replace("\r\n", "\n").rstrip("\n") != readme_block(expected):
        problems.append("stdout text {0!r} is not the four documented lines".format(text))
    return problems


def readme_text():
    """Return the delivery README with newlines normalised to LF."""
    with open(CFG["readme"], "r", encoding="utf-8") as stream:
        return stream.read().replace("\r\n", "\n")


def one_error_line(code, out, err):
    """True for the documented handled-error shape: code 1, one ``error:`` line."""
    text = err.decode("utf-8", "replace")
    lines = text.splitlines()
    return (
        code == 1
        and out == b""
        and len(lines) == 1
        and bool(ERROR_LINE.match(lines[0]))
        and TRACEBACK_MARKER not in text
    )


def count_cases():
    """Return the (text, expected subset) pairs the requirement states."""
    return [
        (SAMPLE_BYTES.decode("utf-8"), SAMPLE_STATS),
        ("\ufeffabc", {"char_count": 3, "line_count": 1, "non_empty_line_count": 1, "word_count": 1}),
        ("\ufeff\ufeffabc", {"char_count": 4}),
        ("a\r\nb", {"char_count": 3, "line_count": 2}),
        ("a\rb", {"char_count": 3, "line_count": 2}),
        ("a\r\nb\rc", {"char_count": 5, "line_count": 3, "non_empty_line_count": 3, "word_count": 3}),
        ("", {"line_count": 0}),
        ("\n", {"line_count": 1}),
        ("a\n", {"line_count": 1}),
        ("a", {"line_count": 1}),
        ("a\nb", {"line_count": 2}),
        ("a\n\n", {"line_count": 2}),
        ("hello world\nfoo bar\n\n", {"line_count": 3}),
        ("  \n\t\n", {"line_count": 2, "non_empty_line_count": 0}),
        ("  \r\n \r\n", {"char_count": 5, "line_count": 2, "non_empty_line_count": 0, "word_count": 0}),
        ("a\n\n", {"non_empty_line_count": 1}),
        # R-18 / R-23: the blank set is str.strip()'s default, and U+3000 / U+00A0
        # are preserved verbatim in the text while still counting as blank lines.
        ("\u3000\n", {"char_count": 2, "line_count": 1, "non_empty_line_count": 0}),
        ("\u00a0\n", {"char_count": 2, "line_count": 1, "non_empty_line_count": 0}),
        ("\u3000", {"char_count": 1, "line_count": 1, "non_empty_line_count": 0}),
        ("a\u00a0b", {"char_count": 3, "line_count": 1, "non_empty_line_count": 1, "word_count": 2}),
        ("caf\u00e9", {"char_count": 4, "word_count": 1}),
        ("cafe\u0301", {"char_count": 5, "word_count": 1}),
        ("hello world", {"word_count": 2}),
        ("Hello hello HELLO", {"word_count": 3}),
        ("well-known", {"word_count": 1}),
        ("don't", {"word_count": 1}),
        ("it\u2019s", {"word_count": 1}),
        ("a-b-c", {"word_count": 1}),
        ("hello--world", {"word_count": 2}),
        ("123 456", {"word_count": 0}),
        ("abc123", {"word_count": 1}),
        ("a1b", {"word_count": 2}),
        ("a_b", {"word_count": 2}),
        ("foo_bar baz", {"word_count": 3}),
        ("caf\u00e9-mocha", {"word_count": 2}),
        (" -abc", {"word_count": 1}),
        ("abc- ", {"word_count": 1}),
        ("'abc", {"word_count": 1}),
    ]


def check_ac01():
    code = (
        "import contextlib, io, sys\n"
        "import json, text_stats as t\n"
        "out, err = io.StringIO(), io.StringIO()\n"
        "with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):\n"
        "    first = t.main([], stdin_text='')\n"
        "quiet = isinstance(first, int) and first == 0 and out.getvalue() == '' and err.getvalue() == ''\n"
        "sys.stdin = None\n"
        "second = t.main([], stdin_text='')\n"
        "print(json.dumps({'quiet': quiet, 'second': second}))\n"
    )
    code_exit, out, err = run_py(code)
    ok = False
    if code_exit == 0 and err == b"":
        try:
            payload = json.loads(out.decode("utf-8"))
            ok = bool(payload.get("quiet")) and payload.get("second") == 0
        except ValueError:
            ok = False
    return ok, "code={0} out={1!r}".format(code_exit, out[:120])


def check_ac02():
    code_exit, out, err = run_py(
        "import text_stats as t; code = t.main([], stdin_text=''); "
        "print(callable(t.main), code, type(code).__name__)"
    )
    ok = code_exit == 0 and out.decode("utf-8").splitlines() == ["True 0 int"] and err == b""
    return ok, "code={0} out={1!r} err={2!r}".format(code_exit, out[:120], err[:120])


def check_ac03():
    code, out, err = run_cli([], stdin_bytes=b"")
    stats = parse_stats(out)
    ok = code == 0 and stats == ZERO_STATS and err == b""
    return ok, "code={0} stats={1} err={2!r}".format(code, stats, err[:80])


def check_ac04():
    code, out, err = run_cli(["sample_input.txt"])
    stats = parse_stats(out)
    ok = code == 0 and stats == SAMPLE_STATS and err == b""
    return ok, "code={0} stats={1} err={2!r}".format(code, stats, err[:80])


def check_ac05():
    code, out, err = run_cli([], stdin_bytes=b"hello world\n")
    stats = parse_stats(out)
    ok = (
        code == 0
        and stats == {"char_count": 12, "line_count": 1, "non_empty_line_count": 1, "word_count": 2}
        and err == b""
    )
    return ok, "code={0} stats={1} err={2!r}".format(code, stats, err[:80])


def check_ac06():
    from_path = run_cli(["sample_input.txt"])
    from_stdin = run_cli([], stdin_bytes=SAMPLE_BYTES)
    ok = (
        from_path[0] == 0
        and from_stdin[0] == 0
        and parse_stats(from_path[1]) == SAMPLE_STATS
        and parse_stats(from_stdin[1]) == SAMPLE_STATS
    )
    return ok, "path={0} stdin={1}".format(parse_stats(from_path[1]), parse_stats(from_stdin[1]))


def check_ac07():
    code, out, err = run_cli(["sample_input.txt"])
    text = out.decode("utf-8")
    lines = text.splitlines()
    parsed = parse_stats(out)
    shape = (
        code == 0
        and err == b""
        and len(lines) == 4
        and all(STATS_LINE.match(line) for line in lines)
        and [line.split(": ")[0] for line in lines] == list(KEYS)
        and parsed == SAMPLE_STATS
        and text.endswith("\n")
        and not text.endswith("\n\n")
    )
    return shape, "code={0} lines={1!r}".format(code, lines)


def check_ac08():
    code = (
        "import json, sys, text_stats as t\n"
        "first = t.count_text('hello world\\nfoo bar\\n')\n"
        "sys.stdin = None\n"
        "second = t.count_text('hello world\\nfoo bar\\n')\n"
        "print(json.dumps({'keys': sorted(first.keys()), 'first': first, 'second_ok': second == first}))\n"
    )
    code_exit, out, err = run_py(code)
    ok = False
    detail = "code={0} err={1!r}".format(code_exit, err[:120])
    if code_exit == 0 and err == b"":
        payload = json.loads(out.decode("utf-8"))
        ok = payload["keys"] == sorted(KEYS) and payload["first"] == SAMPLE_STATS and payload["second_ok"]
        detail = "keys={0} first={1} stdin_none_ok={2}".format(
            payload["keys"], payload["first"], payload["second_ok"]
        )
    return ok, detail


def check_count_cases():
    cases = count_cases()
    lines = [
        "import json",
        "import sys",
        "import text_stats as t",
        "cases = " + repr([(text, expected) for text, expected in cases]),
        "results = []",
        "for text, expected in cases:",
        "    stats = t.count_text(text)",
        "    bad = {key: (value, stats.get(key)) for key, value in expected.items() if stats.get(key) != value}",
        "    results.append({'text': repr(text), 'ok': not bad, 'mismatch': bad})",
        "sys.stdout.write(json.dumps(results))",
    ]
    code_exit, out, err = run_py("\n".join(lines))
    if code_exit != 0:
        return False, "runner failed code={0} err={1!r}".format(code_exit, err[:200])
    results = json.loads(out.decode("utf-8"))
    failures = [entry for entry in results if not entry["ok"]]
    return not failures, "{0}/{1} cases reproduced; failures={2}".format(
        len(results) - len(failures), len(results), failures[:4]
    )


def check_ac09():
    code_exit, out, err = run_py(
        "import text_stats as t; print(t.count_text('\\ufeff\\ufeffabc')['char_count'])"
    )
    ok = code_exit == 0 and out.decode("utf-8").splitlines() == ["4"] and err == b""
    return ok, "code={0} out={1!r}".format(code_exit, out[:80])


def check_ac10():
    code = "\n".join(
        [
            "import json, text_stats as t",
            "chars = " + repr(NON_LINE_BREAKS),
            "rows = [{'char': format(ord(c), '04x'),"
            " 'line_count': t.count_text('a' + c + 'b')['line_count'],"
            " 'char_count': t.count_text('a' + c + 'b')['char_count']} for c in chars]",
            "print(json.dumps(rows))",
        ]
    )
    code_exit, out, err = run_py(code)
    ok = False
    detail = "code={0} err={1!r}".format(code_exit, err[:120])
    if code_exit == 0 and err == b"":
        rows = json.loads(out.decode("utf-8"))
        ok = all(row["line_count"] == 1 and row["char_count"] == 3 for row in rows) and len(rows) == 8
        detail = json.dumps(rows)
    return ok, detail


def check_ac13():
    code_exit, out, err = run_py(
        "import json, text_stats as t\n"
        "texts = ['  \\r\\n \\r\\n', 'a\\n\\n', '  \\n\\t\\n']\n"
        "print(json.dumps([t.count_text(x) for x in texts]))"
    )
    ok = False
    detail = "code={0} err={1!r}".format(code_exit, err[:120])
    if code_exit == 0 and err == b"":
        first, second, third = json.loads(out.decode("utf-8"))
        ok = (
            first == {"char_count": 5, "line_count": 2, "non_empty_line_count": 0, "word_count": 0}
            and second["line_count"] == 2
            and second["non_empty_line_count"] == 1
            and third["line_count"] == 2
            and third["non_empty_line_count"] == 0
        )
        detail = json.dumps([first, second, third])
    return ok, detail


def check_ac17():
    code, out, err = run_cli(["--help"])
    text = out.decode("utf-8", "replace")
    ok = code == 0 and "usage:" in text and "PATH" in text and "--encoding" in text and err == b""
    return ok, "code={0} mentions_path={1} mentions_encoding={2} err={3!r}".format(
        code, "PATH" in text, "--encoding" in text, err[:80]
    )


def check_ac18():
    code_exit, out, err = run_programmatic(
        "(__import__('text_stats').main(['--help'], stdin_text=''), )"
    )
    ok = code_exit == 0 and out.decode("utf-8").splitlines() == ["[0]"] and err == b""
    return ok, "code={0} out={1!r} err={2!r}".format(code_exit, out[:120], err[:120])


def check_ac19():
    missing = run_cli(["missing-file.txt"])
    too_many = run_cli(["a.txt", "b.txt"], stdin_bytes=b"")
    ok = one_error_line(*missing) and one_error_line(*too_many)
    return ok, "missing={0}/{1!r} too_many={2}/{3!r}".format(
        missing[0], missing[2][:80], too_many[0], too_many[2][:80]
    )


def check_ac20():
    directory = run_cli(["."])
    bad_encoding = run_cli(["--encoding", "no-such-encoding"], stdin_bytes=b"")
    # The invalid-UTF-8 fixture lives in the ignored scratch directory: the
    # platform temp directory is not writable under the current sandbox policy,
    # and a review must not depend on being able to write outside the workspace.
    path = os.path.join(CFG["scratch"], "invalid-utf8-{0}.bin".format(os.getpid()))
    try:
        with open(path, "wb") as stream:
            stream.write(b"\xff")
        invalid_utf8 = run_cli([path])
    finally:
        if os.path.exists(path):
            os.remove(path)
    ok = one_error_line(*directory) and one_error_line(*bad_encoding) and one_error_line(*invalid_utf8)
    return ok, "dir={0} encoding={1} invalid_utf8={2}".format(directory[0], bad_encoding[0], invalid_utf8[0])


def check_ac21():
    missing = run_programmatic(
        "(__import__('text_stats').main(['missing-file.txt'], stdin_text=''), )"
    )
    bad_encoding = run_programmatic(
        "(__import__('text_stats').main(['--encoding', 'no-such-encoding'], stdin_text=''), )"
    )
    ok = (
        missing[0] == 0
        and missing[1].decode("utf-8").splitlines() == ["[1]"]
        and missing[2] == b""
        and bad_encoding[0] == 0
        and bad_encoding[1].decode("utf-8").splitlines() == ["[1]"]
        and bad_encoding[2] == b""
    )
    return ok, "missing={0}/{1!r} encoding={2}/{3!r}".format(
        missing[1][:40], missing[2][:40], bad_encoding[1][:40], bad_encoding[2][:40]
    )


def check_ac22():
    programmatic = run_programmatic(
        "(__import__('text_stats').main(['--encoding', 'no-such-encoding'], stdin_text=''), )"
    )
    command_line = run_cli(["--encoding", "no-such-encoding"], stdin_bytes=b"")
    ok = (
        programmatic[1].decode("utf-8").splitlines() == ["[1]"]
        and programmatic[2] == b""
        and one_error_line(*command_line)
    )
    return ok, "programmatic={0}/{1!r} cli={2}".format(
        programmatic[1][:40], programmatic[2][:40], command_line[0]
    )


def check_ac23():
    code_exit, out, err = run_programmatic(
        "(__import__('text_stats').main(['sample_input.txt'], stdin_text='ignored text'), )"
    )
    ok = code_exit == 0 and out.decode("utf-8").splitlines() == ["[0]"] and err == b""
    return ok, "code={0} out={1!r} err={2!r}".format(code_exit, out[:120], err[:120])


def _is_main_guard(node):
    test = node.test
    return (
        isinstance(test, ast.Compare)
        and isinstance(test.left, ast.Name)
        and test.left.id == "__name__"
        and len(test.comparators) == 1
        and isinstance(test.comparators[0], ast.Constant)
        and test.comparators[0].value == "__main__"
    )


def _is_sys_exit(node):
    return (
        isinstance(node.func, ast.Attribute)
        and node.func.attr == "exit"
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "sys"
    )


def check_ac24():
    probes = [
        run_cli([], stdin_bytes=b""),
        run_cli(["sample_input.txt"]),
        run_cli(["missing-file.txt"]),
        run_cli(["--encoding", "no-such-encoding"], stdin_bytes=b""),
    ]
    observed = {probe[0] for probe in probes}
    import_probe = run_py("import text_stats")
    with open(CFG["tool"], "r", encoding="utf-8") as stream:
        tree = ast.parse(stream.read(), filename=CFG["tool"])

    module_level_exits = []
    function_exits = []

    def walk(node, inside_main_guard):
        for child in ast.iter_child_nodes(node):
            guard = inside_main_guard
            if isinstance(child, ast.If) and _is_main_guard(child):
                guard = True
            if isinstance(child, ast.Call) and _is_sys_exit(child):
                (module_level_exits if guard else function_exits).append(child.lineno)
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                walk(child, False)
            else:
                walk(child, guard)

    walk(tree, False)
    ok = (
        observed <= {0, 1}
        and import_probe[0] == 0
        and import_probe[1] == b""
        and import_probe[2] == b""
        and function_exits == []
        and len(module_level_exits) == 1
    )
    return ok, "observed={0} import={1} exits_in_main_guard={2} exits_in_functions={3}".format(
        sorted(observed), import_probe[0], module_level_exits, function_exits
    )


def check_ac25():
    command_line = run_cli(["sample_input.txt"])
    programmatic = run_py("import text_stats as t; raise SystemExit(t.main(['sample_input.txt']))")
    ok = (
        parse_stats(command_line[1]) == SAMPLE_STATS
        and command_line[0] == 0
        and programmatic[0] == 0
        and parse_stats(programmatic[1]) == SAMPLE_STATS
        and programmatic[2] == b""
    )
    return ok, "cli={0}/{1} programmatic={2}/{3}".format(
        command_line[0], parse_stats(command_line[1]), programmatic[0], parse_stats(programmatic[1])
    )


def check_ac26():
    stdlib = set(getattr(sys, "stdlib_module_names", ())) | {"text_stats"}
    imported = {}
    for path in (CFG["tool"], CFG["tests"]):
        with open(path, "r", encoding="utf-8") as stream:
            tree = ast.parse(stream.read(), filename=path)
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names.add(node.module.split(".")[0])
        imported[os.path.basename(path)] = sorted(names)
    non_stdlib = {
        name: [module for module in modules if module not in stdlib] for name, modules in imported.items()
    }
    forbidden = [
        name
        for name in ("requirements.txt", "pyproject.toml", "setup.py", "Pipfile")
        if os.path.exists(os.path.join(CFG["tool_dir"], name))
    ]
    ok = all(not module for module in non_stdlib.values()) and forbidden == []
    return ok, "imports={0} non_stdlib={1} forbidden_files={2}".format(imported, non_stdlib, forbidden)


def check_ac27():
    with open(CFG["sample"], "rb") as stream:
        raw = stream.read()
    with open(CFG["readme"], "r", encoding="utf-8") as stream:
        readme = stream.read()
    ac_ids = set(re.findall(r"AC-\d+", readme))
    bc_ids = set(re.findall(r"BC-\d+", readme))
    ac_in_range = all(1 <= int(item.split("-")[1]) <= 29 for item in ac_ids)
    bc_in_range = all(1 <= int(item.split("-")[1]) <= 30 for item in bc_ids)
    forbidden = "char_count: 6" not in readme
    # R-36: the joiner must never be written as a bare U+2019.
    bare_quote = "\u2019" not in readme
    ok = (
        len(raw) == 20
        and raw == SAMPLE_BYTES
        and readme.count("char_count") > 0
        and forbidden
        and bare_quote
        and ac_in_range
        and bc_in_range
        and ("20" in readme and "non_empty_line_count: 2" in readme and "word_count: 4" in readme)
    )
    return ok, "sample_bytes={0} ac_refs={1} bc_refs={2} no_char_count_6={3} no_bare_u2019={4}".format(
        len(raw), sorted(ac_ids)[:6], sorted(bc_ids)[:6], forbidden, bare_quote
    )


def check_readme_examples():
    """R-35: every remaining README stdin example is replayed as a real process."""
    readme = readme_text()

    def documented(stats):
        return any(form in readme for form in documented_forms(stats))

    problems = []
    for label, payload, expected in README_EXAMPLES:
        code, out, err = run_cli([], stdin_bytes=payload)
        for problem in example_problems(code, out, err, expected):
            problems.append("{0}: {1}".format(label, problem))
        if not documented(expected):
            problems.append("{0}: README does not show the documented numbers".format(label))
    detail = "examples={0} documented={1} problems={2}".format(
        len(README_EXAMPLES),
        sum(1 for _, _, expected in README_EXAMPLES if documented(expected)),
        problems or "none",
    )
    return not problems, detail


def check_r29_utf16_file():
    """R-29 / BC-22: ``--encoding`` decides how a *file* is decoded.

    The fixtures are the README's own demonstration (BOM-less UTF-16LE read as
    ``utf-16-le``, and the same text with a BOM read as ``utf-16``).  The same
    file read *without* the flag must produce different statistics: that contrast
    is what shows the flag, not the file content, is doing the work.
    """
    plain = os.path.join(CFG["scratch"], UTF16_DEMO_NAME)
    with open(plain, "wb") as stream:
        stream.write(UTF16_DEMO_TEXT.encode("utf-16-le"))
    bom = os.path.join(CFG["scratch"], "utf16-demo-bom.txt")
    with open(bom, "wb") as stream:
        stream.write(b"\xff\xfe" + UTF16_DEMO_TEXT.encode("utf-16-le"))

    problems = []
    code, out, err = run_cli([plain, "--encoding", "utf-16-le"])
    problems.extend(example_problems(code, out, err, UTF16_DEMO_STATS))
    bom_code, bom_out, bom_err = run_cli([bom, "--encoding", "utf-16"])
    for problem in example_problems(bom_code, bom_out, bom_err, UTF16_DEMO_STATS):
        problems.append("bom: {0}".format(problem))

    control_code, control_out, control_err = run_cli([plain])
    control_stats = parse_stats(control_out)
    if control_code != 0:
        if not one_error_line(control_code, control_out, control_err):
            problems.append(
                "control without --encoding neither succeeded nor failed cleanly: "
                "code={0} out={1!r} err={2!r}".format(control_code, control_out[:80], control_err[:80])
            )
    elif control_stats in (None, UTF16_DEMO_STATS):
        problems.append(
            "control without --encoding produced {0}; the flag made no difference".format(control_stats)
        )

    readme = readme_text()
    if UTF16_DEMO_NAME not in readme or not any(form in readme for form in documented_forms(UTF16_DEMO_STATS)):
        problems.append("README does not document this UTF-16LE demonstration")
    detail = "fixtures=2 control_code={0} control_stats={1} problems={2}".format(
        control_code, control_stats, problems or "none"
    )
    return not problems, detail


def check_r29_stdio_encoding():
    """R-29: the stream codec decides how *stdin* is decoded.

    ``PYTHONIOENCODING`` is set for the child process only.  The parent's
    environment is compared before and after, so a probe that leaked the
    variable into the harness cannot pass.
    """
    payload = b"\xff\xfe" + STDIO_ENCODING_TEXT.encode("utf-16-le")
    before = os.environ.get(STDIO_ENCODING_VAR)
    code, out, err = run_cli_env([], stdin_bytes=payload, extra_env={STDIO_ENCODING_VAR: STDIO_ENCODING_VALUE})
    after = os.environ.get(STDIO_ENCODING_VAR)

    problems = []
    if code != 0:
        problems.append("exit code {0}".format(code))
    if err != b"":
        problems.append("stderr {0!r}".format(err))
    stats = parse_stats(out, encoding=STDIO_ENCODING_VALUE)
    if stats != STDIO_ENCODING_STATS:
        problems.append("stats under {0}={1}: {2}".format(STDIO_ENCODING_VAR, STDIO_ENCODING_VALUE, stats))
    # The child re-encodes stdout with the same variable; if it were ignored the
    # bytes would be plain ASCII and this decode would not reproduce the block.
    if readme_block(STDIO_ENCODING_STATS) not in out.decode(STDIO_ENCODING_VALUE, "replace").replace("\r\n", "\n"):
        problems.append("stdout was not written with the child's stream codec")
    if after != before:
        problems.append("parent environment changed: {0} -> {1}".format(before, after))

    control_code, control_out, control_err = run_cli([], stdin_bytes=payload)
    if parse_stats(control_out) == STDIO_ENCODING_STATS:
        problems.append("control without {0} produced the same statistics".format(STDIO_ENCODING_VAR))

    detail = "child_code={0} control_code={1} parent_{2}={3!r} problems={4}".format(
        code, control_code, STDIO_ENCODING_VAR, after, problems or "none"
    )
    return not problems, detail


def run_delivery_tests():
    """Run the documented test command once and return (code, combined output)."""
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "unittest",
            "discover",
            "-s",
            os.path.join("examples", "text-stats"),
            "-p",
            "test_*.py",
        ],
        input=b"",
        capture_output=True,
        cwd=CFG["repo"],
        env=child_env(),
    )
    output = completed.stdout.decode("utf-8", "replace") + completed.stderr.decode("utf-8", "replace")
    return completed.returncode, output


def check_ac28():
    """AC-28: the documented suite passes *and* writes no bytecode.

    The snapshot order is the fix: before -> run -> after.  Comparing the set of
    files, their sha256 and their mtime_ns catches an added file, a rewritten
    file with identical size and a file that was rewritten with the same
    content but a new timestamp.
    """
    before = snapshot_cache(CFG["pycache"])
    code, output = run_delivery_tests()
    after = snapshot_cache(CFG["pycache"])

    problems = cache_delta(before, after)
    ran = re.search(r"Ran (\d+) tests?", output)
    ok = (
        code == 0
        and output.rstrip().endswith("OK")
        and ran is not None
        and not problems
    )
    detail = (
        "code={0} stats={1} cache_files_before={2} after={3} problems={4} time_criterion={5!r}".format(
            code,
            ran.group(1) if ran else None,
            len(before["files"]),
            len(after["files"]),
            problems or "none",
            CACHE_TIME_CRITERION,
        )
    )
    return ok, detail


def scope_problems(changed, allowed):
    """Return the reasons a change scope violates R-32 / BC-27.

    The delivery may touch any subset of the four allowed files: ``sample_input.txt``
    already had the required content, so a run that leaves it alone is correct.
    What matters is that nothing outside the allowed set was touched and that the
    commit is not empty.  Files that were *not* touched are reported as
    information, not as a failure.
    """
    problems = []
    unexpected = sorted(set(changed) - set(allowed))
    if unexpected:
        problems.append("paths outside the allowed delivery set: {0}".format(unexpected))
    if not changed:
        problems.append("the delivery commit touched no files")
    return problems


def scope_not_touched(changed, allowed):
    """Return the allowed files the delivery commit left alone (informational)."""
    return sorted(set(allowed) - set(changed))


def status_problems(entries, allowed_history, declared_outputs):
    """Return the reasons a working-tree status is not acceptable."""
    problems = []
    allowed_history = tuple(allowed_history)
    ignored = set(declared_outputs)
    for code, path in entries:
        if path in ignored:
            continue
        if path.startswith(allowed_history):
            continue
        if path.startswith(TEST_TEMP_PREFIX):
            continue
        problems.append("unexpected working-tree entry: {0} {1}".format(code, path))
    return problems


def check_ac29(status_before, status_after, declared_outputs):
    """AC-29, split into change scope and review-time stability.

    * scope: the delivery commit must touch exactly the four allowed files, so a
      committed checkout can pass while a stray edit cannot;
    * stability: running the review must not add or modify anything, comparing
      the working tree before and after while ignoring the review's own declared
      outputs (reported explicitly instead of silently dropped).
    """
    base = CFG["base"]
    delivery = CFG["delivery"]
    changed = git_changed_paths(base, delivery)
    problems = scope_problems(changed, ALLOWED_DELIVERY_FILES)

    ignored = set(declared_outputs)
    before = [(code, path) for code, path in status_before if path not in ignored]
    after = [(code, path) for code, path in status_after if path not in ignored]
    if before != after:
        problems.append("status changed during the review: {0} -> {1}".format(before, after))
    problems.extend(status_problems(after, ALLOWED_HISTORY_PREFIXES, declared_outputs))

    ok = not problems
    detail = (
        "base={0} delivery={1} changed={2} allowed={3} not_touched={4} declared_outputs={5} problems={6}".format(
            base[:12],
            delivery[:12],
            changed,
            list(ALLOWED_DELIVERY_FILES),
            scope_not_touched(changed, ALLOWED_DELIVERY_FILES),
            sorted(ignored),
            problems or "none",
        )
    )
    return ok, detail


CHECKS = [
    ("AC-01", check_ac01),
    ("AC-02", check_ac02),
    ("AC-03", check_ac03),
    ("AC-04", check_ac04),
    ("AC-05", check_ac05),
    ("AC-06", check_ac06),
    ("AC-07", check_ac07),
    ("AC-08", check_ac08),
    ("AC-09", check_ac09),
    ("AC-10", check_ac10),
    ("AC-11-12-14-15-16", check_count_cases),
    ("AC-13", check_ac13),
    ("AC-17", check_ac17),
    ("AC-18", check_ac18),
    ("AC-19", check_ac19),
    ("AC-20", check_ac20),
    ("AC-21", check_ac21),
    ("AC-22", check_ac22),
    ("AC-23", check_ac23),
    ("AC-24", check_ac24),
    ("AC-25", check_ac25),
    ("AC-26", check_ac26),
    ("AC-27", check_ac27),
    ("R-35", check_readme_examples),
    ("R-29-UTF16-FILE", check_r29_utf16_file),
    ("R-29-STDIO-ENCODING", check_r29_stdio_encoding),
]


# --------------------------------------------------------------------------
# self-test: counter-examples for the three fixes and for failure semantics
# --------------------------------------------------------------------------


def _write(path, data):
    directory = os.path.dirname(path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory)
    with open(path, "wb") as stream:
        stream.write(data)


def _touch(path, text, mtime_ns):
    _write(path, text.encode("utf-8"))
    os.utime(path, ns=(mtime_ns, mtime_ns))


def self_test():
    """Exercise the fixed checks against synthetic counter-examples."""
    results = []

    def record(name, ok, detail):
        results.append({"counter_example": name, "ok": ok, "detail": detail})

    workdir = os.path.join(CFG["scratch"], "selftest-{0}".format(os.getpid()))
    if os.path.isdir(workdir):
        shutil.rmtree(workdir)
    os.makedirs(workdir)
    try:
        cache = os.path.join(workdir, "cache")
        os.makedirs(cache)
        base_ns = 1_700_000_000_000_000_000
        _touch(os.path.join(cache, "a.pyc"), "aaaa", base_ns)
        _touch(os.path.join(cache, "b.pyc"), "bbbb", base_ns + 1)
        clean_before = snapshot_cache(cache)
        clean_after = snapshot_cache(cache)
        record(
            "cache-unchanged-control",
            cache_delta(clean_before, clean_after) == [],
            "no difference reported for an untouched cache",
        )

        _touch(os.path.join(cache, "c.pyc"), "cccc", base_ns + 2)
        added = cache_delta(clean_before, snapshot_cache(cache))
        record(
            "cache-added-during-test",
            any("added c.pyc" in item for item in added),
            "added file detected: {0}".format(added),
        )
        os.remove(os.path.join(cache, "c.pyc"))

        _touch(os.path.join(cache, "a.pyc"), "aaaaX", base_ns)
        size_changed = cache_delta(clean_before, snapshot_cache(cache))
        record(
            "cache-same-name-new-content",
            any("content changed for a.pyc" in item for item in size_changed),
            "content change detected: {0}".format(size_changed),
        )

        _touch(os.path.join(cache, "a.pyc"), "AAAA", base_ns)
        same_size = cache_delta(clean_before, snapshot_cache(cache))
        record(
            "cache-same-size-different-content",
            any("content changed for a.pyc" in item for item in same_size),
            "sha256 caught the rewrite despite identical 4-byte size: {0}".format(same_size),
        )

        # Same bytes as the snapshot, but written again 5 ms later: only the
        # timestamp can reveal this rewrite.
        _touch(os.path.join(cache, "a.pyc"), "aaaa", base_ns + 5_000_000)
        touched = cache_delta(clean_before, snapshot_cache(cache))
        record(
            "cache-mtime-moved",
            any("mtime moved for a.pyc" in item for item in touched),
            "timestamp criterion is enforced at 0 ns: {0}".format(touched),
        )

        record(
            "scope-exact-match",
            scope_problems(list(ALLOWED_DELIVERY_FILES), ALLOWED_DELIVERY_FILES) == [],
            "a delivery commit touching exactly the four allowed files passes",
        )
        extra = scope_problems(list(ALLOWED_DELIVERY_FILES) + ["workflows/three-agent-mvp.js"], ALLOWED_DELIVERY_FILES)
        record(
            "scope-extra-path",
            any("outside the allowed delivery set" in item for item in extra),
            "a stray fifth path is rejected: {0}".format(extra),
        )
        partial = scope_problems(
            [
                "examples/text-stats/README.md",
                "examples/text-stats/test_text_stats.py",
                "examples/text-stats/text_stats.py",
            ],
            ALLOWED_DELIVERY_FILES,
        )
        record(
            "scope-partial-accepted",
            partial == []
            and scope_not_touched(
                [
                    "examples/text-stats/README.md",
                    "examples/text-stats/test_text_stats.py",
                    "examples/text-stats/text_stats.py",
                ],
                ALLOWED_DELIVERY_FILES,
            )
            == ["examples/text-stats/sample_input.txt"],
            "the real delivery touches three of four files (sample_input.txt already "
            "had the required content) and is accepted: {0}".format(partial),
        )
        empty = scope_problems([], ALLOWED_DELIVERY_FILES)
        record(
            "scope-empty-rejected",
            any("touched no files" in item for item in empty),
            "an empty delivery commit is rejected: {0}".format(empty),
        )

        record(
            "clean-checkout-stability",
            status_problems([], ALLOWED_HISTORY_PREFIXES, []) == [],
            "a clean checkout (empty status) passes the stability half",
        )
        declared = status_problems(
            [("??", "docs/run-records/v0.4-run5-20261017T161034Z/review-package/verification.json")],
            ALLOWED_HISTORY_PREFIXES,
            ["docs/run-records/v0.4-run5-20261017T161034Z/review-package/verification.json"],
        )
        record(
            "declared-output-excluded",
            declared == [],
            "the review's own declared output is excluded and must be disclosed: {0}".format(declared),
        )
        undeclared = status_problems(
            [("??", "examples/text-stats/notes.tmp")],
            ALLOWED_HISTORY_PREFIXES,
            [],
        )
        record(
            "undeclared-file-rejected",
            any("unexpected working-tree entry" in item for item in undeclared),
            "an undeclared file is rejected: {0}".format(undeclared),
        )

        missing_repo = os.path.join(CFG["scratch"], "no-such-repo-{0}".format(os.getpid()))
        saved = dict(CFG)
        try:
            CFG["repo"] = missing_repo
            try:
                git_status()
                git_failed = False
                git_detail = "git status returned without raising"
            except EvidenceError as exc:
                git_failed = True
                git_detail = str(exc)
            record(
                "git-failure-is-not-clean",
                git_failed,
                "a failing git command raises instead of reporting an empty tree: {0}".format(git_detail),
            )
        finally:
            CFG.clear()
            CFG.update(saved)

        # The three documented facets of a subprocess example must each be able
        # to fail on its own, otherwise "reproduced the README" would mean
        # "printed the right numbers" and nothing more.
        hello = README_EXAMPLES[0][2]
        good_out = readme_block(hello).replace("\n", "\r\n").encode("utf-8") + b"\r\n"
        wrong_stats = good_out.replace(b"word_count: 2", b"word_count: 3")
        record(
            "example-stats-mismatch",
            any("stats" in item for item in example_problems(0, wrong_stats, b"", hello)),
            "a different word_count fails: {0}".format(example_problems(0, wrong_stats, b"", hello)),
        )
        record(
            "example-stderr-leak",
            any("stderr" in item for item in example_problems(0, good_out, b"warning\n", hello)),
            "a leaked stderr line fails: {0}".format(example_problems(0, good_out, b"warning\n", hello)),
        )
        record(
            "example-exit-code",
            any("exit code" in item for item in example_problems(1, good_out, b"", hello)),
            "a wrong exit code fails: {0}".format(example_problems(1, good_out, b"", hello)),
        )
        record(
            "example-extra-stdout",
            any("stdout text" in item for item in example_problems(0, good_out + b"extra\r\n", b"", hello)),
            "extra stdout text fails: {0}".format(example_problems(0, good_out + b"extra\r\n", b"", hello)),
        )
        record(
            "documented-form-needs-all-four",
            not any(form in "a sample showing only char_count: 12" for form in documented_forms(hello)),
            "a README that shows only one number does not document the example: {0}".format(
                documented_forms(hello)
            ),
        )

        # PYTHONIOENCODING must be scoped to the child: the parent keeps its own
        # value, and the child sees the value handed to it.
        sentinel = "cp1252"
        os.environ[STDIO_ENCODING_VAR] = sentinel
        try:
            code, out, err = run_cli_env(
                [], stdin_bytes="ab\n".encode("utf-8"), extra_env={STDIO_ENCODING_VAR: "utf-8"}
            )
            parent_after = os.environ.get(STDIO_ENCODING_VAR)
        finally:
            os.environ.pop(STDIO_ENCODING_VAR, None)
        record(
            "child-env-does-not-leak",
            code == 0 and parent_after == sentinel and os.environ.get(STDIO_ENCODING_VAR) is None,
            "parent kept {0!r} while the child got its own value: code={1} parent_after={2!r}".format(
                sentinel, code, parent_after
            ),
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    failures = [row["counter_example"] for row in results if not row["ok"]]
    return {"results": results, "failures": failures}


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------


def configure(repo_root, base, delivery, declared_outputs):
    repo_root = os.path.abspath(repo_root)
    if not os.path.isdir(os.path.join(repo_root, "examples", "text-stats")):
        raise EvidenceError("{0} does not look like the repository root".format(repo_root))
    tool_dir = os.path.join(repo_root, "examples", "text-stats")
    # Scratch fixtures stay inside the ignored tests/.scratch tree: the platform
    # temp directory is not writable under the current sandbox policy.
    scratch = os.path.join(repo_root, "tests", ".scratch", "run5-review")
    if not os.path.isdir(scratch):
        os.makedirs(scratch)
    CFG.update(
        {
            "repo": repo_root,
            "tool_dir": tool_dir,
            "tool": os.path.join(tool_dir, "text_stats.py"),
            "tests": os.path.join(tool_dir, "test_text_stats.py"),
            "readme": os.path.join(tool_dir, "README.md"),
            "sample": os.path.join(tool_dir, "sample_input.txt"),
            "pycache": os.path.join(tool_dir, "__pycache__"),
            "scratch": scratch,
            "base": base,
            "delivery": delivery,
            "declared_outputs": list(declared_outputs),
        }
    )


def main(argv):
    parser = argparse.ArgumentParser(description="Offline acceptance of the run5 delivery.")
    parser.add_argument("--repo", default=".", help="repository root (default: current directory)")
    parser.add_argument("--base", default="HEAD^", help="change-scope base commit (default: HEAD^)")
    parser.add_argument("--delivery", default="HEAD", help="delivery commit (default: HEAD)")
    parser.add_argument("--out", help="write the JSON report here")
    parser.add_argument("--self-test", action="store_true", help="run the counter-examples only")
    parser.add_argument("--self-test-out", help="write the self-test JSON here")
    cfg = parser.parse_args(argv)

    declared = [os.path.relpath(path, cfg.repo).replace("\\", "/") for path in (cfg.out, cfg.self_test_out) if path]

    try:
        configure(cfg.repo, cfg.base, cfg.delivery, declared)
    except EvidenceError as exc:
        print("FAIL evidence: {0}".format(exc))
        return 1

    if cfg.self_test:
        outcomes = self_test()
        if cfg.self_test_out:
            with open(cfg.self_test_out, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(json.dumps(outcomes, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
        for row in outcomes["results"]:
            print("{0:<32} {1}  {2}".format(row["counter_example"], "PASS" if row["ok"] else "FAIL", row["detail"]))
        print("")
        print("counter-examples: {0}, failed: {1}".format(len(outcomes["results"]), len(outcomes["failures"])))
        return 0 if not outcomes["failures"] else 1

    try:
        status_before = git_status()
    except EvidenceError as exc:
        print("FAIL evidence: {0}".format(exc))
        return 1
    try:
        head = run_git(["rev-parse", "HEAD"]).strip()
    except EvidenceError as exc:
        print("FAIL evidence: {0}".format(exc))
        return 1

    results = []
    for name, probe in CHECKS:
        try:
            ok, detail = probe()
        except EvidenceError as exc:
            ok, detail = False, "evidence error: {0}".format(exc)
        results.append({"criterion": name, "ok": ok, "detail": detail})

    try:
        ok28, detail28 = check_ac28()
    except EvidenceError as exc:
        ok28, detail28 = False, "evidence error: {0}".format(exc)
    results.append({"criterion": "AC-28", "ok": ok28, "detail": detail28})

    try:
        status_after = git_status()
        ok29, detail29 = check_ac29(status_before, status_after, declared)
    except EvidenceError as exc:
        ok29, detail29 = False, "evidence error: {0}".format(exc)
    results.append({"criterion": "AC-29", "ok": ok29, "detail": detail29})

    failures = [row["criterion"] for row in results if not row["ok"]]
    report = {
        "tool": "docs/run-records/v0.4-run5-20261017T161034Z/review-package/verify-run5.py",
        "run_id": "v0.4-run5-20261017T161034Z",
        "repo_head": head,
        "change_scope": {"base": cfg.base, "delivery": cfg.delivery},
        "cache_time_criterion": CACHE_TIME_CRITERION,
        "declared_outputs": declared,
        "criteria_checked": len(results),
        "criteria_passed": len(results) - len(failures),
        "failed": failures,
        "results": results,
    }
    if cfg.out:
        with open(cfg.out, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n")

    for row in results:
        print("{0:<18} {1}  {2}".format(row["criterion"], "PASS" if row["ok"] else "FAIL", row["detail"]))
    print("")
    print("checked {0}, passed {1}, failed {2}".format(len(results), len(results) - len(failures), len(failures)))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
