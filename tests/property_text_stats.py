#!/usr/bin/env python3
"""有界、可复现的性质测试：用独立参考实现校验交付的文本统计程序。

本脚本包含**两类**检查，输出里分开计数，不得混为一谈：

  A. 已批准口径的固定示例（approved）：
     16 条固定示例的期望值是人工裁定的 RB-2 / RB-3 / RB-4 / RB-6 与相关计数
     （见 docs/REQUIREMENT-BASELINE.md 与 run 6 的 BC-01/BC-05/BC-08/BC-12），
     直接写在 FIXED_EXAMPLES 里，不经过参考实现。
     它**不覆盖** RB-1（显式 stdin_text 时静默返回）、RB-5（AC/BC 冲突编排门禁），
     也不覆盖 RB-2 的 CLI 输出路径本身——那几项由交付测试、编排回归与认领集成测试提供证据。

  B. 随机输入上的实现一致性（implementation consistency）：
     参考实现独立按字符扫描，但 `word_count` 的单词正则与连接符集合、`char_count` 的
     "只剥一个前导 BOM"都仍是**尚未逐条批准**的规则。因此随机部分证明的是"生产实现与这份
     参考读法一致"，不是"需求已被批准"。

  * 随机输入固定种子与用例数，附墙钟超时，失败时缩减为最小反例并给出复现命令；
  * 未批准的口径（数字算不算词、词中组合记号等）只统计次数，不作正确性结论；
  * 本脚本不断言"归一化幂等"：只剥一个前导 BOM 的归一化对 "\\ufeff\\ufeffabc" 并不幂等。

运行：python tests/property_text_stats.py
退出码：0 = 全部通过；1 = 有失败（会打印最小反例与复现命令）。
"""

import importlib.util
import json
import os
import random
import string
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
# 默认校验交付实现；`TLA_TEXT_STATS_PATH` 只用于反向验证（把故意改坏的副本喂进来，确认本脚本抓得住）。
MODULE_PATH = os.environ.get("TLA_TEXT_STATS_PATH") or os.path.join(
    REPO_ROOT, "examples", "text-stats", "text_stats.py")

SEEDS = (0, 1, 2, 3, 4, 5, 6, 7, 8, 9)
CASES_PER_SEED = 120
TIMEOUT_SECONDS = 60

LETTERS = set(string.ascii_letters)
JOINERS = set("-'") | {"\u2019"}
SEPARATORS = ["\u2028", "\u2029", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85"]
ALPHABET = list("abcXYZ019 \t\n\r-'\u2019" + "".join(SEPARATORS)) + ["\ufeff", "\u00e9", "\u0301", "\u2019"]

# RB-1 – RB-6 的固定示例（来自已裁定口径，不是从实现里抄的）。
FIXED_EXAMPLES = [
    # (输入, char_count, line_count, non_empty_line_count, word_count)
    ("", 0, 0, 0, 0),
    ("\n", 1, 1, 0, 0),
    ("a\n", 2, 1, 1, 1),
    ("a", 1, 1, 1, 1),
    ("a\nb", 3, 2, 2, 2),
    ("a\n\n", 3, 2, 1, 1),
    ("hello world\nfoo bar\n", 20, 2, 2, 4),
    ("hello world\nfoo bar\n\n", 21, 3, 2, 4),
    ("  \n\t\n", 5, 2, 0, 0),
    ("a\u2028b", 3, 1, 1, 2),
    ("cafe\u0301", 5, 1, 1, 1),
    ("caf\u00e9", 4, 1, 1, 1),
    ("\ufeffabc", 3, 1, 1, 1),
    ("\ufeff\ufeffabc", 4, 1, 1, 1),
    ("a\r\nb", 3, 2, 2, 2),
    ("a\rb", 3, 2, 2, 2),
]


def ref_normalise(text):
    """独立实现的归一化：只剥一个前导 BOM，然后 CRLF / CR → LF。"""
    out = text
    if out[:1] == "\ufeff":
        out = out[1:]
    out = out.replace("\r\n", "\n")
    out = out.replace("\r", "\n")
    return out


def ref_lines(text):
    """按"只有 LF 是行边界、末尾换行不产生额外空行"扫描切分（不用 split / pop）。"""
    normalised = ref_normalise(text)
    if normalised == "":
        return []
    lines = []
    start = 0
    index = 0
    length = len(normalised)
    while index < length:
        if normalised[index] == "\n":
            lines.append(normalised[start:index])
            start = index + 1
        index += 1
    if start < length:
        lines.append(normalised[start:])
    return lines


def ref_word_count(text):
    """独立实现的词计数：字母段 (连接符 字母段)*，连接符后必须紧跟字母才算同一个词。"""
    normalised = ref_normalise(text)
    count = 0
    index = 0
    length = len(normalised)
    while index < length:
        if normalised[index] not in LETTERS:
            index += 1
            continue
        cursor = index
        while cursor < length and normalised[cursor] in LETTERS:
            cursor += 1
        while cursor + 1 < length and normalised[cursor] in JOINERS and normalised[cursor + 1] in LETTERS:
            cursor += 1
            while cursor < length and normalised[cursor] in LETTERS:
                cursor += 1
        count += 1
        index = cursor
    return count


def ref_counts(text):
    normalised = ref_normalise(text)
    lines = ref_lines(text)
    return {
        "char_count": len(normalised),
        "line_count": len(lines),
        "non_empty_line_count": sum(1 for line in lines if line.strip() != ""),
        "word_count": ref_word_count(text),
    }


def load_production():
    spec = importlib.util.spec_from_file_location("text_stats_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def random_text(rng):
    length = rng.randrange(0, 40)
    return "".join(rng.choice(ALPHABET) for _ in range(length))


def shrink(text, production):
    """把反例缩到最小：删字符后仍然不一致就保留删除结果（有界：最多 O(len^2) 次，len <= 40）。"""
    current = text
    changed = True
    while changed and len(current) > 0:
        changed = False
        for index in range(len(current)):
            candidate = current[:index] + current[index + 1:]
            if not satisfied(candidate, production):
                current = candidate
                changed = True
                break
    return current


def mismatch(text, production):
    """返回不一致的 (字段, 参考值, 实际值) 列表；一致时返回空列表。"""
    expected = ref_counts(text)
    actual = production.count_text(text)
    problems = []
    for key in ("char_count", "line_count", "non_empty_line_count", "word_count"):
        if expected[key] != actual[key]:
            problems.append((key, expected[key], actual[key]))
    return problems


def satisfied(text, production):
    return not mismatch(text, production)


def property_violations(text, production):
    """已批准口径推出的性质（与参考实现无关的硬性不变量）。"""
    out = []
    actual = production.count_text(text)
    for key in ("char_count", "line_count", "non_empty_line_count", "word_count"):
        value = actual[key]
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            out.append("计数 " + key + " 必须是非负整数，实际 " + repr(value))
    if actual["non_empty_line_count"] > actual["line_count"]:
        out.append("non_empty_line_count 不得大于 line_count：" + repr(actual))
    return out


def repro_command(text):
    return ("python -c \"import sys; sys.path.insert(0, r'" + os.path.join(REPO_ROOT, "examples", "text-stats") +
            "'); import text_stats as t; print(t.count_text(" + repr(text) + "))\"")


def main():
    started = time.monotonic()
    production = load_production()
    failures = []
    checked = 0
    unapproved_notes = {"digits_as_words": 0, "mid_word_combining_marks": 0}

    for text, cc, lc, nc, wc in FIXED_EXAMPLES:
        checked += 1
        expected = {"char_count": cc, "line_count": lc, "non_empty_line_count": nc, "word_count": wc}
        actual = production.count_text(text)
        for key, want in expected.items():
            if actual[key] != want:
                failures.append({"input": text, "where": "fixed:" + key, "expected": want, "actual": actual[key]})

    for seed in SEEDS:
        rng = random.Random(seed)
        for case in range(CASES_PER_SEED):
            if time.monotonic() - started > TIMEOUT_SECONDS:
                print("超时：超过 " + str(TIMEOUT_SECONDS) + " 秒，已检查 " + str(checked) + " 组")
                return 1
            text = random_text(rng)
            checked += 1
            problems = mismatch(text, production)
            if problems:
                failures.append({"seed": seed, "case": case, "input": text, "problems": problems})
            for violation in property_violations(text, production):
                failures.append({"seed": seed, "case": case, "input": text, "problems": [("property", violation)]})
            # 未批准口径：仅记录现状，不作结论。
            if any(ch.isdigit() for ch in text) and production.count_text(text)["word_count"] > 0:
                unapproved_notes["digits_as_words"] += 1
            if "\u0301" in text:
                unapproved_notes["mid_word_combining_marks"] += 1
        print("种子 " + str(seed) + "：已检查 " + str(checked) + " 组，失败 " + str(len(failures)))

    # 长文本（有界）：一次 200_000 字符的混合输入。
    long_rng = random.Random(20261017)
    long_text = "".join(long_rng.choice(ALPHABET) for _ in range(200000))
    checked += 1
    problems = mismatch(long_text, production)
    if problems:
        failures.append({"input": "<长文本 200000 字符>", "problems": problems})
    print("长文本：检查完成，失败累计 " + str(len(failures)))

    if failures:
        first = failures[0]
        print("")
        print("失败数：" + str(len(failures)) + "（下面只打印前 5 条，避免刷屏）")
        for item in failures[:5]:
            print(json.dumps(item, ensure_ascii=False))
        if isinstance(first.get("input"), str) and len(first["input"]) <= 40:
            minimal = shrink(first["input"], production)
            print("最小反例：" + repr(minimal))
            print("复现：" + repro_command(minimal))
        return 1

    print("")
    print("通过：检查 " + str(checked) + " 组（固定示例 " + str(len(FIXED_EXAMPLES)) + " + 随机 " +
          str(len(SEEDS) * CASES_PER_SEED) + " + 长文本 1），种子 " + str(SEEDS) + "，耗时 " +
          format(time.monotonic() - started, ".1f") + " 秒")
    print("分类：(A) 已批准口径固定示例 " + str(len(FIXED_EXAMPLES)) + " 条；" +
          "(B) 随机+长文本上的实现一致性 " + str(checked - len(FIXED_EXAMPLES)) + " 组")
    print("覆盖边界：(A) 不含 RB-1 / RB-5，也不证明 RB-2 的 CLI 输出路径；" +
          "(B) 的单词正则、连接符与 BOM 归一化仍是未逐条批准的规则。")
    print("未批准口径的现状记录（不作正确性结论）：" + json.dumps(unapproved_notes, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
