import os
import sys

MERGED = ('/bin', '/sbin', '/lib', '/lib64')


def merged(path):
    for prefix in MERGED:
        if path == prefix or path.startswith(prefix + '/'):
            return '/usr' + path
    return path


def inside(path, roots):
    return any(path == root or path.startswith(root.rstrip('/') + '/') for root in roots)


def reachable(path, roots):
    return inside(merged(path), [merged(root) for root in roots])


def chain(path, limit=40):
    hops = []
    while os.path.islink(path) and len(hops) < limit:
        target = os.readlink(path)
        path = target if target.startswith('/') else os.path.normpath(os.path.join(os.path.dirname(path), target))
        hops.append(path)
    return hops


def unreachable_commands(roots, directory='/usr/bin'):
    names = []
    for name in sorted(os.listdir(directory)):
        full = os.path.join(directory, name)
        if os.path.islink(full) and any(not reachable(hop, roots) for hop in chain(full)):
            names.append(name)
    return names


def main(argv):
    names = unreachable_commands(argv[1:])
    print('sandboxLinks=' + ('broken:' + ','.join(names[:40]) if names else 'ok'))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
