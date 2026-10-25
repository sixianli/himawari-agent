# Test value, speed, isolation, and reporting

Checklists and templates behind the rules in [SKILL.md](../SKILL.md). Copy a
template into the delivery notes or the task brief as it stands; the project's
own instructions decide the tiers, hosts, and commands the answers name.

<a id="test-value"></a>

## Test value: six questions before a new test

Answer all six in the delivery notes or next to the test. One unanswered
question means the test is not added.

```text
Test value
- Entry point and observable result: which public entry point is called, and what the user or caller sees
- Bug or rule: the issue, regression commit, or rule section it protects; none means no test
- Gap: why the neighbouring tests do not cover this branch
- Smallest failing input: the smallest input, state, or timing that triggers the old defect
- Tier: which tier it belongs to, and why
- Measured time: how long the file takes to run alone
```

Stop adding cases when a new one shows no new outcome, error, permission,
persisted data, protocol, or timing difference. One minimal case per entry
point and outcome; further inputs as a table over the same assertions.

Tests that have no value and are deleted on review:

- a copy of a production constant, table, function, or UI fragment compared
  with the original;
- an assertion that a source file contains some text;
- an assertion that an internal function was called, with no check of the
  visible result;
- a case added to raise a coverage number.

<a id="speed"></a>

## Speed budget

| Rule | Measure |
| --- | --- |
| A new or rewritten unit test file runs alone within 5 seconds; over 10 seconds needs a written reason in the delivery notes | the file's own run time on the project's test host |
| The module under test is loaded once per file; no per-case module reset (`vi.resetModules()` or the equivalent); clean state comes from the production code's own reset function or from injected dependencies | one file went from 105 s to 7 s for the same 285 cases after dropping the per-case reset |
| No real wait of 100 ms or more; use fake timers or await the promise under test | search the file for sleeps and timers |
| Only a file that renders UI declares a browser environment | the file's environment setting |
| New cases join the existing file for the module; a new file pays its own setup cost | file count per module |
| A file that needs a real subprocess, network, database, or Git moves to the project's dedicated tier | the tier the project assigns |
| Changing worker counts or test grouping needs before-and-after measurements on the same machine and the same scope, not the fastest single run | two measured runs |

<a id="isolation"></a>

## Isolation checklist

- No external network, cloud service, or developer account in default unit
  tests.
- A test that needs a real socket binds the loopback address with a
  system-assigned port (`listen(0)`) and closes it at the end; no fixed port.
- Temporary files go in a unique directory created for the test under the
  system temporary directory and are removed at the end.
- No change to machine-level settings: global Git configuration, system
  proxy, environment the shell inherits.
- Only obviously invalid fake credentials; never read or copy the
  developer's home directory, configuration directories, or system
  credentials.
- A path default never falls back to the working directory or the
  repository root, so a test cannot write into the repository.
- Default unit tests run in several worktrees at the same time without
  interfering.
- An unmerged database migration runs only against an isolated database;
  historical state comes from a minimal fixture, never from rewriting or
  downgrading a developer's database.
- Never speed tests up by sharing process state or switching isolation off:
  one attempt gained 23 % and broke 150 files, and a mock that stopped
  working ran a real checkout that discarded uncommitted changes.

<a id="platform"></a>

## Platform differences

- Build path expectations with the platform's path functions; never
  hard-code `/` or `\`, and never replace separators in the output before
  comparing.
- To simulate another platform, inject the platform into the function under
  test or call that platform's own path functions; changing a platform flag
  alone keeps the host's functions in use.
- A skip names the missing capability (for example symbolic links on this
  host); the logic still runs on a CI platform that has it. "POSIX only" is
  not a reason.
- A platform not exercised is reported as unverified.

<a id="report"></a>

## Verification report

Each check is in one of three states: not run, failed, passed. Report:

```text
Verification
- Commands run: each exact command, where it ran, the revision, and the result ("12 passed, 0 failed, 3.2 s")
- Bug fixes: the red run (command, failure count) before the fix and the green run after it
- Not run: each check that did not run, and why
- From reading only: conclusions reached without running anything
- What the evidence proves and does not prove: for example "passes in the development environment, not evidence the production defect is fixed"
- Revision: the commit the evidence belongs to, and whether the worktree held uncommitted changes
- Platforms and themes not exercised: listed as unverified
- Unrelated CI failure: the failing test, its cause, and why it is unrelated
```

A result from before a later edit is void; rerun. A first failure stays in
the record. A test or launch command gets no pipe after it; write the output
to a file and record the exit status on its own.
