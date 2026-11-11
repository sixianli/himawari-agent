import hashlib
import json
import os
import re
import stat
import sys

MANIFEST_SCHEMA = 'himawari-embedding-artifact.v1'
REQUIRED_FILES = ('model.onnx', 'tokenizer.json', 'tokenizer_config.json')
OPTIONAL_FILES = ('model.onnx_data',)
SAFE_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]*')


def digest(path):
    hasher = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def regular(path, owner):
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode):
        return 'symlink'
    if not stat.S_ISREG(info.st_mode):
        return 'not-a-file'
    if info.st_uid != owner:
        return 'owner'
    return None


def problem(state_root, model, artifact_sha256, dimensions):
    if not SAFE_NAME.fullmatch(model) or not re.fullmatch(r'[0-9a-f]{64}', artifact_sha256) or not re.fullmatch(r'[1-9][0-9]{0,4}', dimensions):
        return 'target-invalid'
    owner = os.lstat(state_root).st_uid
    directory = os.path.join(state_root, 'models', model, artifact_sha256)
    for path in (os.path.join(state_root, 'models'), os.path.join(state_root, 'models', model), directory):
        if not os.path.lexists(path):
            return 'missing'
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode):
            return 'symlink'
        if not stat.S_ISDIR(info.st_mode):
            return 'not-a-directory'
    manifest_path = os.path.join(directory, 'manifest.json')
    if not os.path.lexists(manifest_path):
        return 'missing'
    reason = regular(manifest_path, owner)
    if reason:
        return reason
    if digest(manifest_path) != artifact_sha256:
        return 'manifest-digest'
    with open(manifest_path, 'rb') as handle:
        manifest = json.loads(handle.read())
    files = manifest.get('files')
    if manifest.get('schema') != MANIFEST_SCHEMA or manifest.get('model') != model or not isinstance(files, dict) or not set(REQUIRED_FILES) <= set(files) or not set(files) <= set(REQUIRED_FILES + OPTIONAL_FILES):
        return 'manifest-shape'
    if type(manifest.get('dimensions')) is not int or manifest['dimensions'] != int(dimensions):
        return 'manifest-dimensions'
    for name, expected in sorted(files.items()):
        if not SAFE_NAME.fullmatch(name) or not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
            return 'manifest-shape'
        path = os.path.join(directory, name)
        if not os.path.lexists(path):
            return 'missing-file:' + name
        reason = regular(path, owner)
        if reason:
            return reason + ':' + name
        if digest(path) != expected:
            return 'file-digest:' + name
    return None


if __name__ == '__main__':
    try:
        found = problem(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
    except (OSError, ValueError) as error:
        found = 'unreadable:' + type(error).__name__
    print('embeddingArtifact=' + (found or 'ok'))
