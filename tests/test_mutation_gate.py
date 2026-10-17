#!/usr/bin/env python3
"""tests/mutation-text-stats.py 的"变异体是否被抓住"判据测试。

v0.2-run2 的变异检查曾误报漏抓：三个变异体都让交付套件失败了，但判据要求
失败用例名以**固定名字**开头，而用例名是交付方自己起的（run2 叫
`test_ac15_…`、`test_ac16_…`、`test_bc13_…`），于是命中数恒为 0。
这里把新判据（套件失败 + 行为关键词命中）钉住，并用 run2 的真实用例名做回归。

运行: python -m unittest discover -s tests -p "test_*.py"
"""

import importlib.util
import re
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('mutation-text-stats.py')
_SPEC = importlib.util.spec_from_file_location('mutation_text_stats', SCRIPT)
MUTATION = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(MUTATION)

# v0.2-run2 变异检查输出的真实失败用例名（来自 docs/run-records/v0.2-run2-*/review-package/json/mutation.json）。
RUN2_FAILURES = {
    'quiet_errors_still_write_stderr': [
        'test_ac15_programmatic_errors_are_silent',
        'test_ac15_programmatic_errors_are_silent',
        'test_ac15_programmatic_errors_are_silent',
        'test_ac15_programmatic_errors_are_silent',
        'test_bc13_invalid_encoding_is_checked_before_the_input',
    ],
    'programmatic_help_prints_usage': [
        'test_ac16_programmatic_help_returns_zero_and_writes_nothing',
    ],
    'bad_encoding_without_path_is_success': [
        'test_ac14_unknown_encoding_name',
        'test_ac15_programmatic_errors_are_silent',
        'test_bc13_invalid_encoding_is_checked_before_the_input',
    ],
}


class MatchedFailuresTest(unittest.TestCase):
    def test_behaviour_keyword_matches_unrelated_names_do_not(self):
        matched = MUTATION.matched_failures(
            ['test_ac15_programmatic_errors_are_silent', 'test_sample_input_counts'], r'silent|quiet|stderr')
        self.assertEqual(matched, ['test_ac15_programmatic_errors_are_silent'])

    def test_empty_when_nothing_matches(self):
        self.assertEqual(MUTATION.matched_failures(['test_unrelated'], r'help|usage'), [])

    def test_empty_when_suite_passed(self):
        self.assertEqual(MUTATION.matched_failures([], r'encoding'), [])


class MutationDefinitionsTest(unittest.TestCase):
    def test_every_mutation_has_a_compilable_hint(self):
        self.assertEqual(len(MUTATION.MUTATIONS), 3)
        for mutation in MUTATION.MUTATIONS:
            self.assertTrue(mutation['why'], mutation['name'])
            self.assertTrue(mutation['find'], mutation['name'])
            re.compile(mutation['name_hint'])  # 非法正则会在这里抛错

    def test_hints_catch_the_run2_failures(self):
        # 回归锚点：run2 的三个变异体都被交付套件杀掉了，新判据必须认定"抓住"。
        for mutation in MUTATION.MUTATIONS:
            with self.subTest(mutation=mutation['name']):
                matched = MUTATION.matched_failures(RUN2_FAILURES[mutation['name']], mutation['name_hint'])
                self.assertTrue(matched, mutation['name'])

    def test_hint_no_longer_depends_on_fixed_test_names(self):
        # 判据只能引用行为关键词；出现 test_ 前缀说明又退回了固定用例名。
        for mutation in MUTATION.MUTATIONS:
            with self.subTest(mutation=mutation['name']):
                self.assertNotIn('test_', mutation['name_hint'])
                self.assertNotIn('expect_any_of', mutation)


if __name__ == '__main__':
    unittest.main()
