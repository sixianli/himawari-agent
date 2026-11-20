from pathlib import Path


def target_paths(binding):
    paths = binding['paths']
    found = {paths[key] for key in ('newPrefix', 'newOperations', 'evidenceRoot') if key in paths}
    if 'transportRoot' in paths:
        found.add(str(Path(paths['transportRoot']).parent))
    found.add(binding['service']['newQualificationEvidenceRoot'])
    return sorted(found)


def allowed_parents(binding):
    paths = binding['paths']
    evidence_parent = Path(paths['evidenceRoot']).parent
    parents = {Path(paths['newPrefix']).parent, Path(paths['newOperations']).parent, evidence_parent, evidence_parent / 'qualification'}
    if 'transportRoot' in paths:
        parents.add(Path(paths['transportRoot']).parent.parent)
    return sorted(str(parent) for parent in parents)
