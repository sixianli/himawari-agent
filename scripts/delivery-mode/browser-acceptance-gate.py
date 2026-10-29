import json
from pathlib import Path
import sys

REQUIRED_SCENARIOS = (
    'accept-homepage',
    'accept-search-toggle',
    'accept-news-search',
    'accept-long-answer',
    'accept-run-command',
    'accept-unrelated-no-memory',
    'accept-memory-page',
    'accept-phone-layout',
    'accept-after-restart',
)
WALKTHROUGH = Path('browser-acceptance') / 'walkthrough.json'


def problems(packet):
    walkthrough_path = packet / WALKTHROUGH
    if not walkthrough_path.is_file():
        return ['BROWSER_ACCEPTANCE_MISSING ' + str(walkthrough_path)]
    walkthrough = json.loads(walkthrough_path.read_text())
    expected = json.loads((packet / 'inputs' / 'bindings.json').read_text())['candidate']['archiveSha256']
    found = []
    if walkthrough.get('schema') != 'himawari-browser-acceptance.v1':
        found.append('BROWSER_ACCEPTANCE_SCHEMA ' + str(walkthrough.get('schema')))
    if walkthrough.get('artifactSha256') != expected:
        found.append('BROWSER_ACCEPTANCE_OTHER_ARTIFACT walked=' + str(walkthrough.get('artifactSha256')) + ' packet=' + expected)
    statuses = {}
    for result in walkthrough.get('results', []):
        statuses.setdefault(result.get('scenario'), []).append(result.get('status'))
    for scenario in REQUIRED_SCENARIOS:
        if statuses.get(scenario) != ['passed']:
            found.append('BROWSER_ACCEPTANCE_NOT_PASSED ' + scenario + ' ' + json.dumps(statuses.get(scenario)))
    return found


def main():
    found = problems(Path(sys.argv[1]).resolve())
    for problem in found:
        print(problem)
    print('BROWSER_ACCEPTANCE ' + ('failed' if found else 'passed'))
    return 1 if found else 0


if __name__ == '__main__':
    sys.exit(main())
