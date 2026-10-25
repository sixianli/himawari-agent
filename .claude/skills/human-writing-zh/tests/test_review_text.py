"""Tests for the optional scanner, not for LLM behavior or writing quality."""
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'review_text.py'
spec = importlib.util.spec_from_file_location('review_text', MODULE_PATH)
assert spec is not None and spec.loader is not None
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)


class ScannerTests(unittest.TestCase):
    def test_empty_text(self):
        report = m.review('', '')
        self.assertEqual(report['style_hint_count'], 0)
        self.assertEqual(report['comparison'], {})
        self.assertEqual(report['metrics']['sentence_characters_approx']['count'], 0)

    def test_identical_text(self):
        text = '仅本地测试：P95 610 ms。[S1]'
        self.assertEqual(m.review(text, text)['comparison'], {})

    def test_style_hint(self):
        self.assertTrue(m.review('值得注意的是，工具已经更新。')['style_hints'])

    def test_code_fence_not_style_checked(self):
        text = '```text\n赋能，未来可期。\n```\n正文。'
        self.assertEqual(m.review(text)['style_hint_count'], 0)

    def test_tilde_fence_not_style_checked(self):
        self.assertEqual(m.review('~~~text\n未来可期\n~~~')['style_hint_count'], 0)

    def test_unclosed_fence_protected(self):
        text = '正文。\n```text\n未来可期'
        self.assertEqual(m.review(text)['style_hint_count'], 0)
        self.assertEqual(len(m.parse_regions(text).fenced_code), 1)

    def test_longer_closing_fence(self):
        self.assertEqual(len(m.parse_regions('```txt\nx\n````\n正文').fenced_code), 1)

    def test_inline_code_not_style_checked(self):
        self.assertEqual(m.review('变量 `赋能` 保留。')['style_hint_count'], 0)

    def test_double_backtick_inline(self):
        self.assertEqual(m.parse_regions('``x ` y``').inline_code, ['``x ` y``'])

    def test_frontmatter_not_style_checked(self):
        self.assertEqual(m.review('---\ntitle: 未来可期\n---\n正文')['style_hint_count'], 0)

    def test_quotes_not_style_checked(self):
        self.assertEqual(m.review('不要滥用“赋能”和「未来可期」。')['style_hint_count'], 0)

    def test_blockquote_not_style_checked(self):
        self.assertEqual(m.review('> 未来可期\n\n正文')['style_hint_count'], 0)

    def test_line_numbers_preserved(self):
        text = '```txt\nx\n```\n值得注意的是，这里改变了。'
        self.assertEqual(m.review(text)['style_hints'][0]['line'], 4)

    def test_number_change_is_advisory(self):
        report = m.review('耗时 800 ms。', '耗时 200 ms。')
        self.assertIn('numbers_with_units', report['comparison'])
        self.assertFalse(report['protected_literal_changes'])

    def test_number_spacing_normalized(self):
        self.assertNotIn('numbers_with_units', m.review('200ms', '200 ms')['comparison'])

    def test_number_multiplicity(self):
        self.assertIn('numbers_with_units', m.review('20 ms', '20 ms 和 20 ms')['comparison'])

    def test_unit_change(self):
        self.assertIn('numbers_with_units', m.review('100 MB', '100 MiB')['comparison'])

    def test_scope_change(self):
        self.assertIn('scope_cues', m.review('已经上线。', '可能上线。')['comparison'])

    def test_object_swap_known_blind_spot(self):
        before = 'A 方案延迟 20 ms，B 方案延迟 80 ms。'
        after = 'A 方案延迟 80 ms，B 方案延迟 20 ms。'
        report = m.review(after, before)
        self.assertEqual(report['comparison'], {})
        self.assertTrue(any('对象绑定' in x for x in report['limitations']))

    def test_code_change_is_protected(self):
        self.assertTrue(m.review('```sh\nx 2\n```', '```sh\nx 1\n```')['protected_literal_changes'])

    def test_inline_change_is_protected(self):
        self.assertTrue(m.review('`API_TOKEN`', '`API_KEY`')['protected_literal_changes'])

    def test_frontmatter_change_is_protected(self):
        self.assertTrue(m.review('---\nx: 2\n---\n正文', '---\nx: 1\n---\n正文')['protected_literal_changes'])

    def test_link_target_change(self):
        report = m.review('[说明](./b.md#x)', '[说明](./a.md#x)')
        self.assertIn('link_targets', report['comparison'])
        self.assertTrue(report['protected_literal_changes'])

    def test_link_label_change_allowed(self):
        self.assertEqual(m.review('[使用说明](./a.md)', '[说明](./a.md)')['comparison'], {})

    def test_bare_url_change(self):
        self.assertTrue(m.review('https://example.org/b', 'https://example.org/a')['protected_literal_changes'])

    def test_reference_link_change(self):
        self.assertIn('link_targets', m.review('[guide]: ./b.md', '[guide]: ./a.md')['comparison'])

    def test_citation_loss(self):
        self.assertTrue(m.review('某个主张。', '某个主张。[S1]')['protected_literal_changes'])

    def test_footnote_marker_loss(self):
        self.assertIn('citation_markers', m.review('说明。', '说明。[^note]')['comparison'])

    def test_quote_change_is_advisory(self):
        report = m.review('他说：“可以删。”', '他说：“不要删。”')
        self.assertIn('quoted_spans', report['comparison'])
        self.assertFalse(report['protected_literal_changes'])

    def test_hint_limit(self):
        result = m.review('未来可期。\n' * 120)
        self.assertEqual(len(result['style_hints']), 100)
        self.assertEqual(result['style_hint_count'], 120)
        self.assertTrue(result['style_hints_truncated'])

    def test_unicode_bom(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'utf8.txt'
            path.write_bytes(b'\xef\xbb\xbf' + '中文'.encode())
            self.assertEqual(m.read_text(path), '中文')

    def test_size_limit(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'large.txt'
            path.write_bytes(b'x' * (m.MAX_BYTES + 1))
            with self.assertRaises(ValueError):
                m.read_text(path)

    def test_cli_json_and_read_only(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'candidate.md'
            path.write_text('值得注意的是，更新了。', encoding='utf-8')
            before = path.read_bytes()
            output = io.StringIO()
            with redirect_stdout(output):
                code = m.main([str(path), '--json'])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(output.getvalue())['schema_version'], '1.0')
            self.assertEqual(before, path.read_bytes())
            self.assertEqual(sorted(p.name for p in Path(d).iterdir()), ['candidate.md'])

    def test_cli_missing_file(self):
        with tempfile.TemporaryDirectory() as d, redirect_stderr(io.StringIO()):
            self.assertEqual(m.main([str(Path(d) / 'missing.md')]), 2)

    def test_cli_bad_encoding(self):
        with tempfile.TemporaryDirectory() as d, redirect_stderr(io.StringIO()):
            path = Path(d) / 'bad.md'
            path.write_bytes(b'\xff\xfe')
            self.assertEqual(m.main([str(path)]), 2)

    def test_cli_strict_exit(self):
        with tempfile.TemporaryDirectory() as d, redirect_stdout(io.StringIO()):
            source, candidate = Path(d) / 'source.md', Path(d) / 'candidate.md'
            source.write_text('`API_KEY`', encoding='utf-8')
            candidate.write_text('`API_TOKEN`', encoding='utf-8')
            self.assertEqual(m.main([str(candidate), '--source', str(source), '--strict-protected']), 1)
            self.assertEqual(m.main([str(candidate), '--source', str(source)]), 0)

    def test_cli_strict_requires_source(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as ctx:
            m.main(['unused.md', '--strict-protected'])
        self.assertEqual(ctx.exception.code, 2)

    def test_cli_numeric_difference_not_strict_failure(self):
        with tempfile.TemporaryDirectory() as d, redirect_stdout(io.StringIO()):
            source, candidate = Path(d) / 'source.md', Path(d) / 'candidate.md'
            source.write_text('20 ms', encoding='utf-8')
            candidate.write_text('30 ms', encoding='utf-8')
            self.assertEqual(m.main([str(candidate), '--source', str(source), '--strict-protected']), 0)


if __name__ == '__main__':
    unittest.main()
