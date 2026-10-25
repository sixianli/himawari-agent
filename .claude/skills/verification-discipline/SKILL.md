---
name: verification-discipline
description: Testing and verification discipline for authorized implementation work - a test-value gate before any new test, test-first for isolated tests, end-to-end tests through real entry points as the main source of new coverage, reproduce bugs before fixing, speed budgets and machine isolation for tests, required tests for storage, recovery and model-facing changes, narrow runs during development and the full project suite before completion, retained verification artifacts, and honest reporting that separates not run, failed and passed. Use before and during any feature, bug fix, or refactor that changes executable behavior; project instructions take precedence where they differ.
---

# Verification Discipline

Apply these requirements to authorized implementation work. Preserve
read-only, design-only, and other explicit task boundaries. When the
project's own instructions (for example `AGENTS.md`, CI configuration, or a
Runbook) say where and when tests run, follow them; this skill supplies the
discipline, not the project's commands or hosts.


1. Before implementation, identify the expected behavior, affected
   contracts, and verification path. Inspect the project's instructions,
   existing tests, scripts, CI configuration, and relevant verification
   skills. Reuse established commands and harnesses; do not invent a
   verification command or introduce a parallel test system unnecessarily.

2. For every feature or bug fix, ensure repeatable automated tests cover
   the target behavior. Reuse existing tests when they demonstrably cover
   it. Derive expected results from requirements and observable contracts,
   never merely from the implementation's output.

   When unit tests or other isolated tests are necessary, FIRST enumerate
   the relevant failure modes, boundary cases, and invariants within the
   task's scope. THEN write the tests, and only then write or change the
   corresponding production code. Never implement a behavior first and
   then write unit tests to justify that implementation.

   For existing untested code, add characterization or regression tests
   before changing the behavior under test. Characterization tests must
   preserve intended behavior, not enshrine a known defect.

   Before adding a test, answer the six test-value questions in
   [references/test-value-and-hygiene.md](references/test-value-and-hygiene.md#test-value):
   the public entry point and the observable result, the bug or rule it
   protects, the gap in the existing tests, the smallest failing input, the
   tier it belongs to, and its measured run time. A test that cannot answer
   one of them is not added. Keep one case per entry point and outcome,
   express further inputs as a table, and stop adding cases when a new one
   shows no new outcome, error, permission, persisted data, protocol, or
   timing difference. Never copy a production constant, table, or function
   into a test and compare the copy with the original, never assert only
   that a source file contains some text, and delete a case that only
   asserts an internal function was called. Coverage numbers are not a
   goal: a project's coverage gate is a floor, not a reason to add tests
   that have no value.

3. Strongly prefer end-to-end (E2E) tests through real user or public system
   entry points. Prefer E2E as the sole source of new behavioral test
   coverage when it can reliably exercise the relevant behavior and failure
   modes. Do not add redundant unit or integration tests merely to populate
   multiple test layers. Preserve existing tests and required project checks.

   Add isolated unit, integration, or contract tests only when a relevant
   failure mode cannot be reliably triggered, observed, or diagnosed through
   E2E tests. Explain the specific coverage gap and follow the test-first
   requirement above. Do not mock away the behavior being verified.

   For complex features, verify a representative medium-to-hard scenario
   involving relevant interactions, state transitions, persistence, or
   failure recovery. A trivial happy-path or smoke test alone is insufficient.
   Choose complexity that can expose defects in the current change; do not
   add unrelated steps merely to make a scenario harder.

4. For bugs, whenever practical, run a reproducing test before changing
   production code. Confirm that it fails because of the reported defect,
   then run the same test after the fix. If it already passes, investigate
   whether it reaches the failing path. If failing-before evidence is
   impractical, explain why and retain the strongest available reproduction
   evidence; never invent a failed run. Record the red run (the exact
   command and the failure count before the fix) and the green run (the
   same command after it) in the delivery notes.

5. During development, run only the narrowest relevant E2E tests needed
   for the current change, plus any necessary focused tests for identified
   coverage gaps. Do not run the full E2E suite during the implementation
   loop. If final verification exposes a defect, return to focused tests
   while fixing it before repeating final verification.

6. For changes that affect executable behavior, run the full
   project-defined E2E suite during final verification, after focused tests
   pass. If the required suite cannot run, report the concrete blocker and
   unverified scope; do not treat focused test success as full verification.

   Before declaring completion, run the project's required verification
   commands and task-required regression and acceptance checks, including
   applicable lint, type, build, integration, and UI checks. Follow relevant
   verification skills within the agreed scope. Targeted test success does
   not replace required real-user-path or cleanup verification.
   Reuse passing results when relevant inputs and conditions are unchanged;
   rerun checks that subsequent changes or observed failures may invalidate.

7. Keep tests repeatable and isolated. Control fixtures, time, randomness,
   external dependencies, and test data where appropriate; avoid accidental
   execution-order dependencies. Wait for observable readiness or completion
   instead of arbitrary sleeps. Investigate intermittent failures rather
   than hiding them with retries or unjustified timeout increases.

   Give every test file a speed budget and keep tests off the machine's
   real state: the budget (a unit test file runs alone in 5 seconds; over
   10 seconds needs a written reason), load the module under test once
   instead of resetting modules per case, no real wait of 100 ms or more
   (fake timers or await the promise under test), merge new cases into the
   existing file, no fixed ports and no external network or developer
   accounts by default, unique temporary directories, obviously fake
   credentials, no fallback to the working directory or repository root,
   safe to run in several worktrees at once, unmerged migrations only on an
   isolated database. The checklists are in the reference's
   [speed](references/test-value-and-hygiene.md#speed) and
   [isolation](references/test-value-and-hygiene.md#isolation) sections.
   Move a test that needs a real subprocess, network, database, or Git into
   the project's dedicated tier instead of the default unit tier. Never
   speed tests up by sharing process state or disabling isolation, and
   measure before and after on the same machine before changing
   concurrency.

8. Some changes fix the test they need. A change to a storage format or a
   persisted data structure needs an upgrade test: a fixture in the old
   layout, and an assertion that the user can continue without doing
   anything; a fresh-install test does not count, and a clean rejection of
   old data is a failure. A change to retry, timeout, or reconnection logic
   needs a test with two or more clients sharing the same resource where
   one fails, asserting the others are unaffected; single-connection tests
   cannot show a recovery whose blast radius exceeds the fault. A change to
   prompts, tool definitions, model mapping, or usage metering proves only
   configuration pass-through with a fake model; measure the real effect
   with an evaluation script against the real model, run manually and
   outside CI, and report which metrics were measured and the conclusion.
   "Looks fine" and "should not matter" are not measurements.

9. Build path expectations with the platform's path functions; never
   hard-code `/` or `\`, and never normalize separators in the output
   before comparing, which hides a wrong path format. Simulating another
   platform injects the platform into the function under test or uses that
   platform's own path functions; changing a platform flag alone is not a
   simulation. A skip needs a concrete reason, not "POSIX only", and the
   logic still runs on a CI platform that supports the capability. Report a
   platform that was not exercised as unverified.

10. For browser UI behavior, prefer persistent Playwright tests while
    respecting an adequate established project framework. Explore unfamiliar
    flows with available browser tools when useful, then encode the relevant
    behavior in repeatable tests. Use semantic roles and labels, or stable
    test IDs where needed. For native UI, use platform-appropriate tools.
    Authorized feature and bug-fix work includes creating necessary test
    files, including @playwright/test specs; a separate request for test
    files is not needed. Browser exploration alone is not a regression test.
    For known UI flows, run or extend existing automated tests instead of
    repeating exploratory browser interactions. Use interactive browser tools
    when they resolve a specific unknown or an evidence gap.

    After a UI change, render it and look at the screenshots; a passing
    automated check is not a visual check. Cover every state the change
    touches in both the light and the dark theme, and when only one theme
    was looked at, say which. "Reused existing theme styles" is not "both
    themes verified". A changed UI file that no check loaded is reported as
    unverified. Never approve your own visual change on the strength of
    screenshots you generated; intended visual changes are confirmed by the
    project's owner. Keep screenshots out of the repository; attach them to
    the delivery or store them in a directory Git ignores.

11. Use mocks at appropriate boundaries without bypassing the behavior under
   test. Distinguish isolated test results from real integration evidence.
   When persistence or other side effects matter, verify the resulting
   state through an independent readback rather than only a success message.
   Report real-service checks separately when they are required.

12. Diagnose failures before changing implementation or tests. Do not delete,
    skip, weaken assertions, change expected values, suppress errors, or
    disable checks merely to obtain a pass. If a test is demonstrably wrong
    or the authorized contract has changed, explain the evidence and update
    the test to enforce the intended behavior.
    Inspect existing failure output and artifacts first. Add targeted
    instrumentation or interactive checks only when needed to distinguish
    causes, then rerun the same reproducing test.

    Never edit a gate's baseline, allowlist, or exception list to let your
    own change through. A new automated check proves itself by failing on a
    deliberately wrong example and passing on correct code, runs in
    report-only mode against history before it blocks, and an abnormal exit
    of the check is not "no findings". "The machine did not block it" is not
    "compliant". Deleting a test needs a listed reason, a check that the
    remaining tests still cover the same risk through the public entry
    point, and a review by someone other than the author.

13. Every E2E run must produce a retained verification artifact, whether
    it passes or fails. Use the existing test runner's report and attach
    supporting evidence as appropriate. Record the exact rerun command,
    code revision and relevant local changes, required environment and
    fixture setup, scenarios executed, assertion results, and artifact paths.

    Include evidence of the observable outcome, such as an output file,
    independent state readback, or a trace with assertions. A screenshot
    or success message alone is insufficient when it does not establish
    the expected result.

    Preserve useful failure logs, screenshots, network errors, and traces.
    Keep artifacts outside disposable cleanup directories, verify that
    cleanup retains them, and report their locations. Exclude credentials
    and sensitive data. Another developer must be able to inspect the
    evidence and rerun the scenario from the recorded instructions.

    Capture failure evidence deliberately: save reports, logs, state
    readbacks, and traces as separate files; never pack dependency
    directories, `.git`, or source identical to a commit (record the
    commit, lockfile digest, and a path/size/SHA-256 manifest instead);
    store an input shared by several runs once and reference it by path
    and SHA-256 elsewhere; justify any single evidence file over 50 MB.

14. Report checks actually run, their results, and unverified scope.
    Distinguish product defects, test defects, and environment blockers
    using evidence. If required coverage or execution is blocked, report
    the concrete gap; do not claim verification is complete. When the
    blocker requires user authorization not already granted, follow the
    pause-and-wait rule in Autonomy and Completion; do not continue other
    implementation work while awaiting explicit authorization. For other
    blockers, complete independent authorized work unless the user has
    instructed otherwise. Passing tests support only the behavior and
    environments they actually cover.

    Every check has one of three states: not run, failed, passed. Success
    needs an explicit signal (a pass count with zero failures, or the
    project's agreed ready marker); a hung, timed-out, or silent command is
    not a pass. Do not put a pipe after a test or launch command, because
    the pipe hides the command's exit status; write the output to a file and
    record the exit status separately. Run long tests in the background,
    and treat a result you could not wait for as not run, never as failed or
    passed; do not restart or kill a test that is still running normally.
    In the report, mark conclusions reached only by reading code, say what
    each piece of evidence proves and does not prove ("passes in the
    development environment" is not "fixed in production"), give the commit
    the evidence belongs to and whether the worktree was dirty, treat
    results from before a later edit as void, and when a CI failure is
    unrelated to the change, name the failing test, its cause, and the
    evidence. The report template is in the reference's
    [report](references/test-value-and-hygiene.md#report) section.

15. A reviewer reads the result and reruns the checks instead of trusting
    the author's report, whether the author is a person or an agent. Where a
    review is mandatory, a program enforces it; an instruction alone lets
    "I checked it myself" stand in for an independent review. Accept a
    review feature only after it finds defects planted in real samples.
    "The code path is connected" is not "the delivered result is right".

For behavior-preserving refactors, run relevant existing tests and add
coverage where needed. Documentation-only or formatting-only changes that
do not affect behavior may use direct inspection or existing checks.
