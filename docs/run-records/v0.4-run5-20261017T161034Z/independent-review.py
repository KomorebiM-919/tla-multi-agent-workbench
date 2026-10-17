"""Independent re-check of AC-01..AC-29 for the run documented beside this file.

This script was written by the reviewer, not by the agents that produced the
delivery.  It re-derives every acceptance criterion from the requirement text
(``docs/run-records/v0.2-run1-20261017T121445Z/requirement-injected.txt``) and
from the delivered files, using only the Python standard library and a
deterministic sequence of probes: no network, no model calls, no clock reads.

Exit code 0 means every criterion was reproduced; 1 means at least one differs,
and the failing criterion ids are printed.

Usage (from the repository root)::

    python docs/run-records/v0.4-run5-20261017T161034Z/independent-review.py \
        --out docs/run-records/v0.4-run5-20261017T161034Z/independent-review.json
"""

import argparse
import ast
import io
import json
import os
import re
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
TOOL_DIR = os.path.join(REPO_ROOT, "examples", "text-stats")
TOOL = os.path.join(TOOL_DIR, "text_stats.py")
TESTS = os.path.join(TOOL_DIR, "test_text_stats.py")
README = os.path.join(TOOL_DIR, "README.md")
SAMPLE = os.path.join(TOOL_DIR, "sample_input.txt")
PYCACHE = os.path.join(TOOL_DIR, "__pycache__")

SAMPLE_BYTES = b"hello world\nfoo bar\n"
SAMPLE_STATS = {
    "char_count": 20,
    "line_count": 2,
    "non_empty_line_count": 2,
    "word_count": 4,
}
KEYS = ("char_count", "line_count", "non_empty_line_count", "word_count")
STATS_LINE = re.compile(r"^(char_count|line_count|non_empty_line_count|word_count): (0|[1-9][0-9]*)$")
ERROR_LINE = re.compile(r"^error: \S")
TRACEBACK_MARKER = "Traceback (most recent call last)"

# AC-10: eight characters that Unicode-aware line splitting would treat as line
# breaks but this requirement does not.
NON_LINE_BREAKS = ("\u2028", "\u2029", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85")

ALLOWED_MODIFIED = {
    "examples/text-stats/README.md",
    "examples/text-stats/test_text_stats.py",
    "examples/text-stats/text_stats.py",
}


def child_env():
    """Return a subprocess environment that cannot create bytecode anywhere."""
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.pop("PYTHONPATH", None)
    return env


def run_cli(args, stdin_bytes=b"", cwd=TOOL_DIR):
    """Run ``python text_stats.py <args>`` and return (code, stdout, stderr)."""
    completed = subprocess.run(
        [sys.executable, os.path.basename(TOOL)] + list(args),
        input=stdin_bytes,
        capture_output=True,
        cwd=cwd,
        env=child_env(),
    )
    return completed.returncode, completed.stdout, completed.stderr


def run_py(code):
    """Run a one-liner inside the delivery directory; return (code, out, err)."""
    completed = subprocess.run(
        [sys.executable, "-c", code],
        input=b"",
        capture_output=True,
        cwd=TOOL_DIR,
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


def parse_stats(stdout):
    """Parse the four output lines into a dict, or return None when malformed."""
    if isinstance(stdout, bytes):
        stdout = stdout.decode("utf-8", "replace")
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


def silent(code, out, err):
    """True when a probe returned *code* while writing to neither stream."""
    return code == 0 and out == b"" and err == b""


def one_error_line(code, out, err):
    """True for the documented handled-error shape: code 1, one ``error:`` line."""
    lines = err.decode("utf-8", "replace").splitlines()
    return (
        code == 1
        and out == b""
        and len(lines) == 1
        and bool(ERROR_LINE.match(lines[0]))
        and TRACEBACK_MARKER not in err.decode("utf-8", "replace")
    )


def count_cases():
    """Return the (text, expected) pairs the requirement states for count_text."""
    return [
        # AC-08 / AC-12 / AC-27
        (SAMPLE_BYTES.decode("utf-8"), SAMPLE_STATS),
        # AC-09 BOM and newline normalisation
        ("\ufeffabc", {"char_count": 3, "line_count": 1, "non_empty_line_count": 1, "word_count": 1}),
        ("\ufeff\ufeffabc", {"char_count": 4}),
        ("a\r\nb", {"char_count": 3, "line_count": 2}),
        ("a\rb", {"char_count": 3, "line_count": 2}),
        ("a\r\nb\rc", {"char_count": 5, "line_count": 3, "non_empty_line_count": 3, "word_count": 3}),
        # AC-11 line_count table
        ("", {"line_count": 0}),
        ("\n", {"line_count": 1}),
        ("a\n", {"line_count": 1}),
        ("a", {"line_count": 1}),
        ("a\nb", {"line_count": 2}),
        ("a\n\n", {"line_count": 2}),
        ("hello world\nfoo bar\n\n", {"line_count": 3}),
        ("  \n\t\n", {"line_count": 2, "non_empty_line_count": 0}),
        # AC-13 whitespace lines and the once-ambiguous figure
        ("  \r\n \r\n", {"char_count": 5, "line_count": 2, "non_empty_line_count": 0, "word_count": 0}),
        ("a\n\n", {"non_empty_line_count": 1}),
        # AC-12 code points, never bytes and never normalised
        ("caf\u00e9", {"char_count": 4, "word_count": 1}),
        ("cafe\u0301", {"char_count": 5, "word_count": 1}),
        # AC-14 word rules
        ("hello world", {"word_count": 2}),
        ("Hello hello HELLO", {"word_count": 3}),
        ("well-known", {"word_count": 1}),
        ("don't", {"word_count": 1}),
        ("it\u2019s", {"word_count": 1}),
        ("a-b-c", {"word_count": 1}),
        ("hello--world", {"word_count": 2}),
        # AC-15 digits, underscores, non-ASCII letters
        ("123 456", {"word_count": 0}),
        ("abc123", {"word_count": 1}),
        ("a1b", {"word_count": 2}),
        ("a_b", {"word_count": 2}),
        ("foo_bar baz", {"word_count": 3}),
        ("caf\u00e9-mocha", {"word_count": 2}),
        # AC-16 joiners must sit between two ASCII letters
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
    ok = code == 0 and stats == {"char_count": 0, "line_count": 0, "non_empty_line_count": 0, "word_count": 0} and err == b""
    return ok, "code={0} stats={1} err={2!r}".format(code, stats, err[:80])


def check_ac04():
    code, out, err = run_cli(["sample_input.txt"])
    stats = parse_stats(out)
    ok = code == 0 and stats == SAMPLE_STATS and err == b""
    return ok, "code={0} stats={1} err={2!r}".format(code, stats, err[:80])


def check_ac05():
    code, out, err = run_cli([], stdin_bytes=b"hello world\n")
    stats = parse_stats(out)
    ok = code == 0 and stats == {"char_count": 12, "line_count": 1, "non_empty_line_count": 1, "word_count": 2} and err == b""
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
        detail = "keys={0} first={1} stdin_none_ok={2}".format(payload["keys"], payload["first"], payload["second_ok"])
    return ok, detail


def check_count_cases():
    cases = count_cases()
    body = (
        "[{'text': %r, 'stats': __import__('text_stats').count_text(%r)} for text, _ in %r]"
        % ("", "", "")
    )
    del body  # replaced below: the case list is too large for a readable one-liner
    payload_lines = [
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
    code = "\n".join(payload_lines)
    code_exit, out, err = run_py(code)
    if code_exit != 0:
        return False, "runner failed code={0} err={1!r}".format(code_exit, err[:200])
    results = json.loads(out.decode("utf-8"))
    failures = [entry for entry in results if not entry["ok"]]
    return not failures, "{0}/{1} cases reproduced; failures={2}".format(len(results) - len(failures), len(results), failures[:4])


def check_ac09():
    # The count_text cases of AC-09 are covered by check_count_cases; this
    # probe additionally proves that the double-BOM text keeps its second BOM.
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
    return code_exit == 0 and out.decode("utf-8").splitlines() == ["[0]"] and err == b"", "code={0} out={1!r} err={2!r}".format(
        code_exit, out[:120], err[:120]
    )


def check_ac19():
    missing = run_cli(["missing-file.txt"])
    too_many = run_cli(["a.txt", "b.txt"], stdin_bytes=b"")
    ok = one_error_line(*missing) and one_error_line(*too_many) and missing[0] == 1 and too_many[0] == 1
    return ok, "missing={0}/{1!r} too_many={2}/{3!r}".format(missing[0], missing[2][:80], too_many[0], too_many[2][:80])


def check_ac20():
    directory = run_cli(["."])
    bad_encoding = run_cli(["--encoding", "no-such-encoding"], stdin_bytes=b"")
    handle, path = tempfile.mkstemp(prefix="invalid-utf8-", suffix=".bin")
    os.close(handle)
    try:
        with open(path, "wb") as stream:
            stream.write(b"\xff")
        invalid_utf8 = run_cli([path])
    finally:
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
    return ok, "programmatic={0}/{1!r} cli={2}".format(programmatic[1][:40], programmatic[2][:40], command_line[0])


def check_ac23():
    code_exit, out, err = run_programmatic(
        "(__import__('text_stats').main(['sample_input.txt'], stdin_text='ignored text'), )"
    )
    ok = code_exit == 0 and out.decode("utf-8").splitlines() == ["[0]"] and err == b""
    return ok, "code={0} out={1!r} err={2!r}".format(code_exit, out[:120], err[:120])


def check_ac24():
    probes = [
        run_cli([], stdin_bytes=b""),
        run_cli(["sample_input.txt"]),
        run_cli(["missing-file.txt"]),
        run_cli(["--encoding", "no-such-encoding"], stdin_bytes=b""),
    ]
    observed = {probe[0] for probe in probes}
    import_probe = run_py("import text_stats")
    with open(TOOL, "r", encoding="utf-8") as stream:
        tree = ast.parse(stream.read(), filename=TOOL)

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
    for path in (TOOL, TESTS):
        with open(path, "r", encoding="utf-8") as stream:
            tree = ast.parse(stream.read(), filename=path)
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names.add(node.module.split(".")[0])
        imported[os.path.basename(path)] = sorted(names)
    non_stdlib = {name: [module for module in modules if module not in stdlib] for name, modules in imported.items()}
    forbidden = [name for name in ("requirements.txt", "pyproject.toml", "setup.py", "Pipfile") if os.path.exists(os.path.join(TOOL_DIR, name))]
    ok = all(not module for module in non_stdlib.values()) and forbidden == []
    return ok, "imports={0} non_stdlib={1} forbidden_files={2}".format(imported, non_stdlib, forbidden)


def check_ac27():
    with open(SAMPLE, "rb") as stream:
        raw = stream.read()
    with open(README, "r", encoding="utf-8") as stream:
        readme = stream.read()
    ac_ids = {match for match in re.findall(r"AC-\d+", readme)}
    bc_ids = {match for match in re.findall(r"BC-\d+", readme)}
    ac_in_range = all(1 <= int(item.split("-")[1]) <= 29 for item in ac_ids)
    bc_in_range = all(1 <= int(item.split("-")[1]) <= 30 for item in bc_ids)
    forbidden = "char_count: 6" not in readme
    ok = (
        len(raw) == 20
        and raw == SAMPLE_BYTES
        and readme.count("char_count") > 0
        and forbidden
        and ac_in_range
        and bc_in_range
        and ("20" in readme and "non_empty_line_count: 2" in readme and "word_count: 4" in readme)
    )
    return ok, "sample_bytes={0} ac_refs={1} bc_refs={2} no_char_count_6={3}".format(
        len(raw), sorted(ac_ids)[:6], sorted(bc_ids)[:6], forbidden
    )


def list_pycache():
    """Return the observable __pycache__ state without creating anything."""
    if not os.path.isdir(PYCACHE):
        return None
    return sorted(
        (name, os.path.getsize(os.path.join(PYCACHE, name))) for name in os.listdir(PYCACHE)
    )


def check_ac28(before_pycache, after_pycache):
    completed = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", os.path.join("examples", "text-stats"), "-p", "test_*.py"],
        input=b"",
        capture_output=True,
        cwd=REPO_ROOT,
        env=child_env(),
    )
    output = completed.stdout.decode("utf-8", "replace") + completed.stderr.decode("utf-8", "replace")
    ran = re.search(r"Ran (\d+) tests?", output)
    ok = (
        completed.returncode == 0
        and output.rstrip().endswith("OK")
        and ran is not None
        and before_pycache == after_pycache
    )
    return ok, "code={0} ran={1} pycache_stable={2}".format(
        completed.returncode, ran.group(1) if ran else None, before_pycache == after_pycache
    )


def git_status():
    completed = subprocess.run(
        ["git", "status", "--porcelain"], capture_output=True, cwd=REPO_ROOT, env=child_env()
    )
    return [line for line in completed.stdout.decode("utf-8", "replace").splitlines() if line.strip()]


def check_ac29(status_before, status_after):
    modified = {
        line[3:].replace("\\", "/") for line in status_before if line[:2] == " M"
    }
    untracked = [line[3:].replace("\\", "/") for line in status_before if line[:2] == "??"]
    allowed_untracked = (
        line.startswith("docs/evidence/v0.1-approval-rejection-20261017T112518Z/")
        or line.startswith("docs/review/")
        or line.startswith("docs/evidence/v0.4-run5-20261017T161034Z/")
        or line.startswith("docs/run-records/v0.4-run5-20261017T161034Z/")
        for line in untracked
    )
    ok = (
        modified == ALLOWED_MODIFIED
        and all(allowed_untracked)
        and status_after == status_before
    )
    return ok, "modified={0} untracked={1} stable={2}".format(sorted(modified), untracked, status_after == status_before)


def main():
    parser = argparse.ArgumentParser(description="Re-check AC-01..AC-29 of run v0.4-run5 independently.")
    parser.add_argument("--out", help="write the JSON report to this path")
    cfg = parser.parse_args()

    status_before = git_status()
    pycache_before = list_pycache()

    checks = [
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
    ]

    results = []
    for name, probe in checks:
        ok, detail = probe()
        results.append({"criterion": name, "ok": ok, "detail": detail})

    # AC-28 runs the suite once and needs the bytecode state on both sides;
    # AC-29 must observe the working tree after every probe has run.
    ok28, detail28 = check_ac28(pycache_before, list_pycache())
    results.append({"criterion": "AC-28", "ok": ok28, "detail": detail28})
    status_after = git_status()
    ok29, detail29 = check_ac29(status_before, status_after)
    results.append({"criterion": "AC-29", "ok": ok29, "detail": detail29})

    failures = [row["criterion"] for row in results if not row["ok"]]
    report = {
        "tool": "docs/run-records/v0.4-run5-20261017T161034Z/independent-review.py",
        "run_id": "v0.4-run5-20261017T161034Z",
        "criteria_checked": len(results),
        "criteria_passed": len(results) - len(failures),
        "failed": failures,
        "results": results,
    }
    if cfg.out:
        with open(cfg.out, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n")

    for row in results:
        print(("{0:<18} {1}  {2}").format(row["criterion"], "PASS" if row["ok"] else "FAIL", row["detail"]))
    print("")
    print("checked {0}, passed {1}, failed {2}".format(len(results), len(results) - len(failures), len(failures)))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
