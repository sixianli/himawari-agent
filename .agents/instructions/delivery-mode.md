# Delivery Mode

The user decided on 2026-10-25 ([ADR 0073](../../docs/adr/0073-fast-delivery-mode.md)) that while the user is the only user and needs a complete product in front of investors, development must not wait on rehearsals and gates. The file `DELIVERY_MODE` at the repository root holds one word:

- `fast`: fast mode. The rules in [Fast mode](#fast-mode) replace the rules they name, for Claude, Codex, opencode, Grok, and every other agent.
- `full`, any other content, or no file: full mode. Every other project rule applies as written.

Only the user switches the mode. Change `DELIVERY_MODE` only when the user asks for it in their own words, in a commit of its own.

<a id="fast-mode"></a>

## Fast mode

Keep these basic checks for every change to product code, configuration, or tests:

1. The targeted tests for the change: the new or reproducing test and the files `python3 "$(git rev-parse --git-common-dir)/hooks/check-layer0-tests.py" derive` lists. A bug fix still starts by reproducing the bug in a test.
2. `npm run check` (format, lint, type checks, module boundaries, coverage and invariant checks, and the machine-secret scan).
3. `npm run build`.

Run them on the cloud server as `himawari-ci` or on Hermes, as [Test and Production Hosts](test-and-production-hosts.md) says; never on the MacBook. A failing basic check blocks the commit like before.

These rules are suspended in fast mode:

- [Test Trigger Timing](test-trigger-timing.md): no Layer 2 (whole affected Vitest projects), no Layer 3 (full `npm test`), no Layer 4 (installed product path on Hermes), no browser qualification, and no `require-quiet-host.sh` unless a run is a comparison measurement the user asked for. Run a wider test only when the change is risky in a way the basic checks cannot see (for example a database migration) and say so in one line.
- [ADR 0066](../../docs/adr/0066-layer0-related-tests-declared.md) commit lines: `Layer-0-tests:` lines are not required; the `commit-msg` and `pre-push` hooks print `DELIVERY_MODE_FAST_SKIP_LAYER0` and let the commit through. Commit messages list the basic checks that actually ran, on which host and revision, in one `Fast-mode-checks:` line.
- The `AGENTS.md` section "Code and Documentation Consistency" and the `document-governance` lifecycle: no strict validation, Runbook reseal, or document update is required before a commit, and the skill is not triggered by drift. Update a document only when the change makes it plainly wrong and the fix is quick. Commit messages that leave documents behind carry `Docs: deferred (fast mode)`.
- The GitHub merge gate: merging into `main` does not wait for `ci/required`. CI still runs; a red result is information, not a blocker. The user switches the ruleset with `scripts/delivery-mode/github-ruleset.sh fast|full`, which only the user runs.
- Production operation packets: no S0 readback, packet freeze, consistency review, Hermes rehearsal, per-deployment authorization round, or limited-host acceptance decision. A production change is the user running `bash scripts/delivery-mode/deploy.sh <frozen packet directory>` on the MacBook; running it is the user's authorization for that deployment. Checking the result after deployment is the user trying the product. To go back, the user runs `bash scripts/delivery-mode/rollback.sh <the same packet directory>`; running it is the user's approval of the rollback. It stops the service and, when the deployment had already changed the database, configuration or unit, writes the rollback approval file, sets the `authority.json` mirror back to the deployment row in the recovery point (the new release advances the fencing token, and the old release refuses a mirror ahead of its database), runs the packet's S2_INSPECT, optional S9_SIDECAR_TIDY, S9 restore and S9 control steps, and then starts the old release and checks that it keeps running. Everything written after the recovery point is lost.

These rules stay in force in fast mode: never run Himawari tests on the MacBook; Claude never logs in to the production server or reads production secrets, and the user runs production commands; the Hermes SSH wrappers and test-account boundaries; no code comments; exact dependency versions and the Pi-first principle; pushing every commit; the disk space rules.

<a id="back-to-full"></a>

## Switching back to full mode

When the user asks, commit `full` to `DELIVERY_MODE`, then in one catch-up task: run strict documentation validation and fix every error, review and reseal the Runbooks whose contract sources changed, update the documents left behind by `Docs: deferred (fast mode)` commits, run Layer 3 and the affected Layer 4 scenarios on Hermes for the current revision, and ask the user to run `scripts/delivery-mode/github-ruleset.sh full`.
