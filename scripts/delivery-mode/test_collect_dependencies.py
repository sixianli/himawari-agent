import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / 'packet-template'
COLLECTOR = TEMPLATE / 'acceptance/helpers/collect-installer-dependencies.mjs'
PINNED_NODE = 'v22.22.3'


def git(root, *arguments):
    return subprocess.run(['git', '-C', str(root), *arguments], check=True, capture_output=True, text=True, env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.invalid', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@example.invalid', 'GIT_CONFIG_GLOBAL': '/dev/null'}).stdout.strip()


class CollectedDependenciesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        lock = {'name': 'probe', 'lockfileVersion': 3, 'packages': {'': {'name': 'probe'}, 'node_modules/left-pad': {'version': '1.3.0'}, 'node_modules/@scope/tool': {'version': '2.0.0'}}}
        (self.source / 'package.json').write_text(json.dumps({'name': 'probe'}))
        (self.source / 'package-lock.json').write_text(json.dumps(lock))
        (self.source / '.gitignore').write_text('node_modules\n')
        git(self.source, 'init', '-q')
        git(self.source, 'add', '.')
        git(self.source, 'commit', '-q', '-m', 'probe')
        self.head = git(self.source, 'rev-parse', 'HEAD')
        modules = self.source / 'node_modules'
        self.write(modules / 'left-pad/package.json', json.dumps({'name': 'left-pad', 'version': '1.3.0'}))
        self.write(modules / 'left-pad/index.js', 'module.exports = 1;\n')
        self.write(modules / '@scope/tool/package.json', json.dumps({'name': '@scope/tool', 'version': '2.0.0'}))
        self.write(modules / '.package-lock.json', '{}\n')
        (modules / '.bin').mkdir()
        os.symlink('../left-pad/index.js', modules / '.bin/left-pad')
        npm = self.root / 'npm/package'
        self.write(npm / 'package.json', json.dumps({'version': '11.8.0'}))
        self.write(npm / 'bin/npm-cli.js', 'process.stdout.write("{}\\n");\n')
        self.npm = npm / 'bin/npm-cli.js'
        self.preload = self.write(self.root / 'pin-node.mjs', 'Object.defineProperty(process, "version", { value: "' + PINNED_NODE + '" });\n')
        self.collector = self.write(self.root / 'collect.mjs', COLLECTOR.read_text().replace('__PKT_COMMIT__', self.head))

    def tearDown(self):
        self.directory.cleanup()

    def write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def collect(self, name):
        output = self.root / name
        child = subprocess.run(['node', '--import', str(self.preload), str(self.collector), '--source-root', str(self.source), '--modules-root', str(self.source / 'node_modules'), '--output', str(output), '--npm-cli', str(self.npm)], capture_output=True, text=True)
        return child, output

    def test_the_two_template_copies_are_the_same_file(self):
        self.assertEqual((TEMPLATE / 'install/collect-installer-dependencies.mjs').read_bytes(), COLLECTOR.read_bytes())

    def test_tool_caches_are_left_out_and_the_archive_is_the_same_each_time(self):
        self.write(self.source / 'node_modules/.vite/vitest/results.json', '{"run": 1}\n')
        self.write(self.source / 'node_modules/.vite-temp/config.mjs', 'export default 1;\n')
        first, first_output = self.collect('first')
        self.assertEqual(first.returncode, 0, first.stderr)
        self.write(self.source / 'node_modules/.vite/vitest/results.json', '{"run": 2, "duration": 17}\n')
        shutil.rmtree(self.source / 'node_modules/.vite-temp')
        second, second_output = self.collect('second')
        self.assertEqual(second.returncode, 0, second.stderr)
        record = json.loads((first_output / 'node-modules.json').read_text())
        paths = [entry['path'] for entry in record['entries']]
        self.assertNotIn('node_modules/.vite', paths)
        self.assertNotIn('node_modules/.vite-temp', paths)
        self.assertIn('node_modules/.bin/left-pad', paths)
        self.assertIn('node_modules/@scope/tool/package.json', paths)
        listed = subprocess.run(['tar', '-tzf', str(first_output / 'node-modules.tar.gz')], capture_output=True, text=True, check=True).stdout.split()
        self.assertEqual(sorted(name.rstrip('/') for name in listed), sorted(paths))
        digest = lambda output: hashlib.sha256((output / 'node-modules.tar.gz').read_bytes()).hexdigest()
        self.assertEqual(digest(first_output), digest(second_output))

    def test_an_entry_the_lock_does_not_name_is_refused(self):
        self.write(self.source / 'node_modules/stray/index.js', 'x\n')
        child, output = self.collect('stray')
        self.assertNotEqual(child.returncode, 0)
        self.assertIn('P5_MODULE_UNEXPECTED_ENTRY:node_modules/stray', child.stderr)


if __name__ == '__main__':
    unittest.main()
