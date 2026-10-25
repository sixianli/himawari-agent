# Grok batches through the Grok Build plugin

Read this file only when the project sends Grok batches through the Claude
Code Grok Build plugin (`grok-build`) instead of opencode's `xai/`
provider. Briefs, stop files, reviews and replies stay exactly as in
[SKILL.md](../SKILL.md); only setup, launching and waiting differ.
[grok.md](grok.md) still applies for allowed models, batch assignment and
usage limits.

Facts below were measured on 2026-10-14 with plugin 0.2.1 and `grok`
1.0.52. Re-check them when either version changes.

## Contents

- [How the plugin runs Grok](#how-the-plugin-runs-grok)
- [Setup before the first batch](#setup-before-the-first-batch)
- [Launching, waiting and reading the result](#launching-waiting-and-reading-the-result)
- [Known pitfalls](#known-pitfalls)

## How the plugin runs Grok

The plugin's bridge script (`scripts/grok-bridge.mjs` under the plugin's
cache directory) starts the local `grok` CLI headless with
`--always-approve`: every tool call runs without a prompt. A read-only run
adds `--sandbox read-only`; a run with `--write` has no sandbox. Only
`deny` rules and hooks still stop a call, so the deny list is the safety
net. Grok uses the login of the `grok` CLI; `grok models` prints which
account is logged in and the model IDs, which differ from opencode's
`xai/` list (for example `grok-4.7`, `grok-4.7-build-fast`).

Call the bridge directly from Bash, outside the Bash sandbox. The
plugin's `/grok-build:delegate` command and `grok-build:grok-delegate`
subagent do the same through an extra forwarding model and return only
Grok's final text.

## Setup before the first batch

1. Check the CLI and login: `node <bridge> check --json` must show
   `"ready": true`, and `auth.detail` must name the account the user
   allowed.
2. Write the project's deny rules to `.grok/config.toml` under
   `[permission] deny = [...]`, mirroring `.opencode/opencode.json`:
   `Bash(<glob>)` for commands, `Read(<absolute path or **/glob>)` for
   files. A leading `~/` is literal text in a rule; write the absolute home
   path. Exclude `.grok/` through `.git/info/exclude` unless the project
   commits it.
3. Mark the repository trusted: `grok --trust -p "Reply with ok. Do not
   use any tools." --max-turns 1 < /dev/null` from the repository root.
   Without trust, headless Grok ignores the project's `.grok/config.toml`,
   `.claude/settings*.json` rules and `AGENTS.md` without any warning.
4. Confirm with `grok inspect`: `Project trusted: yes`, the project
   `AGENTS.md` under Project Instructions, and `.grok/config.toml` under
   Permissions.
5. Prove the rules with one live run through the bridge with `--write`:
   ask Grok to run a harmless command that each kind of rule should block
   (for example `node --version`, `echo <production host>`, `cat` of a fake
   `.pem` file in a scratch directory) and one allowed command with
   `$(...)`. Blocked calls report `Denied by permission policy: deny rule
   ... matching "<rule>"`.

## Launching, waiting and reading the result

```bash
node <bridge> run --background --write --model grok-4.7 --effort high \
  --prompt-file <brief>.md < /dev/null
node <bridge> runs <run id> --wait --timeout-ms <ms> < /dev/null
node <bridge> show <run id> < /dev/null
node <bridge> stop <run id> < /dev/null
```

- `run --background` returns at once with a run ID. Leave out `--write`
  only for plan batches that must not change files: the read-only sandbox
  then lets Grok's commands write only to temporary directories and
  `~/.grok`.
- Use the brief as the prompt file, or a one-line prompt that names the
  brief's path. Grok writes the stop file the brief names; the review
  reads that file, not only the final text.
- Wait with `scripts/grok-wait.sh <run id> <stop file> <handoff dir>
  <launch epoch>` from a background Bash command started in the directory
  the run was launched from. It wakes on a new stop file or a finished
  run phase, exits 2 when the bridge does not know the run, and runs the
  same evidence gate as `oc-wait.sh` (exit 3 on a violation). Completion
  shows `completed`, the duration and the Grok session ID in `runs`.
- The run log (path printed by `runs`) records only start, finish and the
  final text, not each tool call, so it cannot show liveness during a long
  batch. Check the test host and the stop file instead.
- To continue a batch, `run --resume-last` resumes the newest delegate
  thread of the repository; check with `runs` that it is the right one.

## Known pitfalls

- 2026-10-14, `grok` 1.0.52: before `grok --trust`, `grok inspect`
  listed neither the project `AGENTS.md` nor `.grok/config.toml`; after
  it, both loaded (54 rules). An untrusted repository runs with only the
  user-level rules.
- 2026-10-14, plugin 0.2.1: the bridge keeps its run list per working
  directory. A run launched from a git worktree was "not found" when
  `runs <id>` ran from the main checkout, and the background waiter
  exited at once as if the run had finished. Call `runs`, `show` and
  `stop` from the directory the run was launched from.
