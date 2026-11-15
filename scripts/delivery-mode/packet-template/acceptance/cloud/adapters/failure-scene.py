import hashlib
import json
import os
from pathlib import Path
import shutil
import stat

FAILURE_TEXT_SUFFIXES = ('.json', '.jsonl', '.log', '.txt', '.stdout', '.stderr', '.md')
FAILURE_TEXT_FILE_LIMIT = 1024 * 1024
FAILURE_TEXT_TOTAL_LIMIT = 50 * 1024 * 1024

def file_sha256(filename):
    digest = hashlib.sha256()
    with filename.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

def retain_failure_scene(scratch, evidence):
    copies = evidence / 'scratch-failure-files'
    copies.mkdir(mode=0o700)
    entries = []
    copied_bytes = 0
    skipped_text = []
    for parent, directories, files in os.walk(scratch, followlinks=False):
        directories.sort()
        for name in sorted(directories) + sorted(files):
            path = Path(parent) / name
            relative = str(path.relative_to(scratch))
            try:
                info = path.lstat()
                entry = {'path': relative, 'mode': oct(stat.S_IMODE(info.st_mode)), 'uid': info.st_uid}
                if stat.S_ISDIR(info.st_mode):
                    entry['type'] = 'directory'
                elif stat.S_ISLNK(info.st_mode):
                    entry.update({'type': 'symlink', 'target': os.readlink(path)})
                elif stat.S_ISREG(info.st_mode):
                    entry.update({'type': 'file', 'bytes': info.st_size, 'sha256': file_sha256(path)})
                    if name.endswith(FAILURE_TEXT_SUFFIXES) and 'node_modules' not in Path(relative).parts:
                        if info.st_size <= FAILURE_TEXT_FILE_LIMIT and copied_bytes + info.st_size <= FAILURE_TEXT_TOTAL_LIMIT:
                            target = copies / relative
                            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                            shutil.copyfile(path, target, follow_symlinks=False)
                            copied_bytes += info.st_size
                            entry['copied'] = True
                        else:
                            skipped_text.append(relative)
                else:
                    entry['type'] = 'other'
            except FileNotFoundError:
                entry = {'path': relative, 'type': 'vanished'}
            entries.append(entry)
    manifest_file = evidence / 'scratch-failure-manifest.json'
    with manifest_file.open('x') as handle:
        json.dump({'scratch': str(scratch), 'sceneLeftInPlace': True, 'entries': entries, 'textFilesSkippedForSize': skipped_text}, handle, indent=1)
        handle.write('\n')
    return {'scene': str(scratch), 'sceneLeftInPlace': True, 'manifest': str(manifest_file), 'manifestSha256': file_sha256(manifest_file), 'entries': len(entries), 'copiedTextBytes': copied_bytes, 'copiedTo': str(copies)}
