import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('untested_claims', HERE / 'untested-claims.py')
claims = importlib.util.module_from_spec(spec)
spec.loader.exec_module(claims)

SHA_A = 'a' * 40
SHA_B = 'b' * 40


def codes(message):
    return [code for code, _ in claims.message_problems(message)]


class MessageRuleTest(unittest.TestCase):
    def test_plain_message_passes(self):
        self.assertEqual(codes('fix: thing\n\nLayer-0-tests: none\n'), [])

    def test_prose_claim_without_structured_line_is_rejected(self):
        for phrase in ('Not covered by a test: the real sandbox path', '- Unexplained: why the call hangs', '没有测试：沙箱路径', '未覆盖：真实沙箱', '原因不明：为什么超时'):
            with self.subTest(phrase=phrase):
                self.assertEqual(codes('fix: x\n\n' + phrase + '\n'), ['UNTESTED_CLAIM_NOT_STRUCTURED'])

    def test_structured_line_satisfies_the_rule(self):
        self.assertEqual(codes('fix: x\n\nNot covered by a test: sandbox\nUntested-critical-path: sandbox prewarm in the real job host\n'), [])

    def test_empty_structured_line_is_rejected(self):
        self.assertEqual(codes('fix: x\n\nUntested-critical-path:   \n'), ['UNTESTED_CLAIM_EMPTY'])

    def test_phrase_in_the_middle_of_a_sentence_is_not_a_claim(self):
        self.assertEqual(codes('docs: x\n\nThe rule rejects text such as "Not covered by a test" in messages.\n'), [])


class UnresolvedTest(unittest.TestCase):
    def test_claim_without_proof_is_unresolved(self):
        commits = [(SHA_A, 'fix: x\n\nUntested-critical-path: sandbox\n')]
        self.assertEqual([sha for sha, _ in claims.unresolved(commits)], [SHA_A])

    def test_same_commit_proof_or_waiver_resolves(self):
        for line in ('Real-env-proof: ran r2l6 on Hermes, see /mnt/x', 'Waiver: Andy approved in chat cmsg_1'):
            with self.subTest(line=line):
                self.assertEqual(claims.unresolved([(SHA_A, 'fix: x\n\nUntested-critical-path: sandbox\n' + line + '\n')]), [])

    def test_empty_proof_does_not_resolve(self):
        self.assertEqual(len(claims.unresolved([(SHA_A, 'fix: x\n\nUntested-critical-path: s\nReal-env-proof:  \n')])), 1)

    def test_later_commit_can_resolve_by_prefix(self):
        commits = [(SHA_B, 'test: prove\n\nResolves-untested: ' + SHA_A[:8] + '\nReal-env-proof: ran it\n'), (SHA_A, 'fix: x\n\nUntested-critical-path: sandbox\n')]
        self.assertEqual(claims.unresolved(commits), [])

    def test_resolution_without_proof_or_for_another_commit_does_not_count(self):
        commits = [(SHA_B, 'test: t\n\nResolves-untested: ' + SHA_A[:8] + '\n'), (SHA_A, 'fix: x\n\nUntested-critical-path: s\n')]
        self.assertEqual(len(claims.unresolved(commits)), 1)
        commits = [(SHA_B, 'test: t\n\nResolves-untested: deadbeef\nReal-env-proof: ran\n'), (SHA_A, 'fix: x\n\nUntested-critical-path: s\n')]
        self.assertEqual(len(claims.unresolved(commits)), 1)

    def test_short_resolution_prefix_is_rejected(self):
        commits = [(SHA_B, 'test: t\n\nResolves-untested: aa\nReal-env-proof: ran\n'), (SHA_A, 'fix: x\n\nUntested-critical-path: s\n')]
        self.assertEqual(len(claims.unresolved(commits)), 1)


class RangeTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous = os.getcwd()
        os.chdir(self.directory.name)
        for args in (['init', '-q', '-b', 'main'], ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 'n']):
            subprocess.run(['git', *args], check=True)

    def tearDown(self):
        os.chdir(self.previous)
        self.directory.cleanup()

    def commit(self, message):
        subprocess.run(['git', 'commit', '-q', '--allow-empty', '-m', message], check=True)
        return subprocess.run(['git', 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True).stdout.strip()

    def test_only_commits_after_the_deployed_one_are_scanned(self):
        old = self.commit('fix: old\n\nUntested-critical-path: already deployed')
        new = self.commit('fix: new\n\nUntested-critical-path: not yet deployed')
        head = self.commit('chore: tail')
        found = claims.commits_between(old, head, repo=self.directory.name)
        self.assertEqual([sha for sha, _ in found], [head, new])
        self.assertEqual([sha for sha, _ in claims.unresolved(found)], [new])

    def test_check_range_refuses_with_the_commit_named(self):
        old = self.commit('base')
        new = self.commit('fix: new\n\nUntested-critical-path: sandbox')
        problem = claims.check_range(old, new, repo=self.directory.name)
        self.assertIn(new[:12], problem)
        self.assertIsNone(claims.check_range(old, old, repo=self.directory.name))


if __name__ == '__main__':
    unittest.main()
