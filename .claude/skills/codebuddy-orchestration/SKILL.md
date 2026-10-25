---
name: codebuddy-orchestration
description: Delegate a well-scoped coding subtask (boilerplate, missing unit tests, mechanical refactors, a small bug with a reproducing test) to the local CodeBuddy Code CLI, the engine behind WorkBuddy, in an isolated git worktree, then verify scope and acceptance yourself and land the change unstaged. Use when the user asks to hand work to WorkBuddy or CodeBuddy, or when the project's instructions enable delegation to it, to save the orchestrating agent's tokens.
---

# CodeBuddy Orchestration

The coding agent that loads this skill is the orchestrator. The CodeBuddy
Code CLI (`codebuddy`, the engine behind WorkBuddy) is the worker. The
worker explores, edits and runs tests in a detached git worktree outside
the repository; the orchestrator spends its own tokens only on the brief,
the worker's structured report, the diff, and re-running acceptance itself.

In this file, `cb` means `scripts/cb-delegate.sh` in the directory that
contains this `SKILL.md`. Call it by absolute path, for example
`bash <skill-dir>/scripts/cb-delegate.sh start ...`, from inside the target
repository. The script needs `git`, `jq` and `codebuddy`, and runs under
macOS bash 3.2.

## Contents

- [When to delegate](#when-to-delegate)
- [Before the first delegation](#before-the-first-delegation)
- [Workflow](#workflow)
- [Acceptance](#acceptance)
- [Landing](#landing)
- [Review tasks](#review-tasks)
- [Rework and taking the task back](#rework-and-taking-the-task-back)
- [Reporting to the user](#reporting-to-the-user)
- [Configuration](#configuration)
- [Known pitfalls](#known-pitfalls)

## When to delegate

Delegate only when one of these holds:

- The user asked in this session to hand the work to WorkBuddy or CodeBuddy.
- The project's instruction files say delegation to CodeBuddy is allowed.

The worker sends the code to Tencent's model service. Do not delegate an
employer's or a third party's code without one of the permissions above.

Delegation pays off when the worker's exploration and retries cost far more
than writing the brief and checking the result:

| Delegate | Keep |
| --- | --- |
| CRUD, DTO and mapper code, configuration boilerplate | Architecture decisions and unclear requirements |
| Unit tests for existing code | Authentication, authorization, payment and other security-sensitive code |
| Mechanical refactors, renames, lint and type fixes | Concurrency, distributed and intermittent bugs |
| A small bug with a reproducing test | Work that depends on uncommitted changes |

Make a change of a few lines yourself.

## Before the first delegation

Run `cb doctor` once per session before the first `start`. It checks that
the CLI is installed and logged in, prints the model ids that
`codebuddy --help` mentions, and runs a one-turn structured-output smoke
test in `$CB_HOME/doctor` that prints the result's keys, cost and
structured output; the raw output stays there. If the CLI is missing, not logged
in, rejects the model id, or prints no JSON, stop and tell the user. Ask the
user to compare the credit balance of the account the CLI is logged in to
before and after the smoke test when the model is supposed to be free.

## Workflow

1. **Write the brief.** Copy [templates/brief.md](templates/brief.md) to a
   temporary file outside the repository and fill it in. Put it at an
   absolute path that every shell you use resolves to the same location, and
   do not put it under `$TMPDIR` (see [Known pitfalls](#known-pitfalls)).
   `## Allowed paths`
   is the only input to the scope check: list the narrowest globs that cover
   the change. `## Acceptance` holds commands that run from the repository
   root; each must finish within about two minutes, because the worker's
   command tool ends a command at 120 seconds, so narrow a long test suite
   with `-k` or similar and run the full suite yourself when you verify the
   delegation. List any file outside the repository the worker must read under
   `## References`; the worker rules forbid other outside reads. The
   worktree is built from `HEAD`, so files that are uncommitted or ignored
   by git are absent from it: list those in `## References` by absolute
   path. When the worker should only review and change no file, use
   [templates/review-brief.md](templates/review-brief.md) instead and see
   [Review tasks](#review-tasks).
2. **Choose the allow and deny lists.** By default the worker can read
   files, find files with Glob, write files only inside its worktree, and
   run read-only git commands, including `git grep` for search. Allow each
   command the acceptance needs with its own `--allow`, as narrowly as
   possible, for example
   `--allow 'Bash(./mvnw:*)'` or `--allow 'Bash(npm test:*)'`. A rule matches
   the whole command from its first word, so write each acceptance command as
   one plain command without `cd`, pipes or `&&`. Never allow
   `Bash` or `Bash(*)`. Add `--deny 'Read(<absolute path or ~/path>/**)'`
   for every place the project or the user forbids, for example production
   configuration or another project's checkout (see
   [Configuration](#configuration) for what is always denied).
3. **Start.** `cb start <id> <brief> --allow '<rule>' --deny '<rule>'`. Use `[a-z0-9._-]`
   for the id, for example `order-cancel-test`. A task belongs to the
   repository, not to the worktree that started it: from any worktree of the
   same repository, `status`, `check`, `land`, `clean` and `list` find it. An
   id is used once per repository: `clean` keeps the task directory and its
   logs, so to start over pick a new id. A run can take up to `CB_TIMEOUT`
   seconds (30 minutes by default): if the harness can run a shell command in
   the background and notify on completion, do that; otherwise run it in the
   foreground with a timeout longer than `CB_TIMEOUT`. Do not poll in a loop.
   Meanwhile, work only on files outside the task's allowed paths.
4. **Read the report.** At the end the script prints the worker's
   `structured_output`, every tool call whose path lies outside the
   worktree with `ok` or `failed`, every shell command the worker ran, the
   worktree's `git status`, the diff stat and the worktree path. Read only
   that, never the worker's transcript. When the output holds no
   conversation, the report says in a `!!` line that the read and command
   records are missing and gives the last line of the worker's stderr. Print
   it again later with `cb status <id>`. When, in a round, the worker did
   not run some `## Acceptance` command exactly as written, the report has a
   `!! acceptance command not run exactly as written in this round:` line for
   it, and the script automatically resumes the same session once (the note
   is saved as `rerun-<round>.md`, and the ledger marks the run `auto: true`);
   this automatic rerun does not count toward `CB_MAX_ROUNDS`. If the rerun
   still shows that line, run the acceptance command yourself and tell the
   user the worker did not.
5. **Accept** (see [Acceptance](#acceptance)), then either **land** (see
   [Landing](#landing)) or **rework** (see
   [Rework and taking the task back](#rework-and-taking-the-task-back)).

Tasks may run in parallel only when their allowed paths do not overlap.
Run at most three at a time.

## Acceptance

The worker's report is a claim, not evidence. Do all four steps; any
failure means the task is not accepted:

1. `cb check <id>`. It fails when the worker moved `HEAD` (committed or
   checked something out), changed a path outside `## Allowed paths`
   (renames count on both sides), or changed nothing. The last case is about
   a task that changes code; a review task is judged differently, see
   [Review tasks](#review-tasks).
2. Read the report's outside tool calls and shell commands. An `ok` read
   of a path that is neither in the brief's `## References` nor a system
   or toolchain file the task plausibly needs is a finding: tell the user
   which file was read, because its content was sent to Tencent's model
   service, and add a `--deny` rule for that place to later tasks. When
   the report says the records are missing, this step cannot be done: tell
   the user that the run left no record of what it read, so there is no
   way to know which files outside the worktree were sent to Tencent's
   model service.
3. Re-run every `## Acceptance` command inside the worktree and read only
   the tail of the output, for example
   `(cd <worktree> && ./mvnw -q -Dtest=OrderServiceTest test 2>&1 | tail -40)`.
4. Review the diff with `git -C <worktree> diff` and
   `git -C <worktree> status`. Read all of it up to about 400 changed lines;
   above that, read at least the core files and every change to a public
   API, configuration or build file. Look for removed or weakened tests and
   assertions, added skips, behavior changes outside the goal, and new
   dependencies.

## Landing

1. `cb land <id>` re-runs the scope check, then applies the worktree's
   changes as a patch, **unstaged**, to the worktree where the task was
   started, even when `land` runs from another worktree of the same
   repository; if that worktree is gone, `land` stops. If the patch does not
   apply, the script stops and keeps the patch; tell the user instead of
   forcing it.
2. Run the acceptance commands again in the worktree where the changes landed.
3. Stage and commit only under the project's and the user's own git rules.
   Delegation itself authorizes no commit, push or branch.
4. `cb clean <id>` removes the task's worktree and keeps its logs. When the
   worktree that started the task has been deleted, `cb clean <id>` still runs
   from any other worktree of the same repository.

## Review tasks

Use a review task when the worker should read code or documentation and
report problems, without changing any file. What it reads is still sent to
Tencent's model service, so the conditions under
[When to delegate](#when-to-delegate) apply here too.

Write the brief from [templates/review-brief.md](templates/review-brief.md).
A review brief needs no `## Allowed paths` section; one that is present is
ignored with a warning. List a file that is uncommitted or ignored by git by
absolute path under `## What to review` or `## References`. A review that
covers many files can need a larger `CB_MAX_TURNS`.

`cb start <id> <brief> --review [--allow '<rule>']...` starts a review task.
The worker gets no `Edit`, `MultiEdit`, `Write` or `NotebookEdit`: they are
denied. Its rules come from [templates/review-rules.md](templates/review-rules.md)
and its report format from
[templates/review.schema.json](templates/review.schema.json), so each
problem is one entry in `findings` with `file`, `lines`, `severity`,
`problem`, `evidence` and `suggestion`. Allow only the commands the brief's
`## Commands` section asks the worker to run.

Accept a review task like this:

1. `cb check <id>` passes only when `HEAD` has not moved and the worktree has
   no change at all; any changed path means the worker overstepped.
2. Read the outside tool calls as in step 2 of [Acceptance](#acceptance).
3. Treat every finding as the worker's claim: read the code it quotes and
   re-run the commands it cites yourself, and act on or relay a finding only
   after that check. When you report to the user, keep apart what you
   confirmed, what you refuted and what you could not verify.

`cb land` refuses a review task. `cb clean <id>` removes it without
`--discard`. Use `cb resume` as usual when you need more evidence.

## Rework and taking the task back

- When acceptance fails for a concrete, describable reason, write a short
  feedback file (the failing command, the few lines of error that matter,
  out-of-scope paths, what must change) and run `cb resume <id> <feedback>`
  in the background, as for `start`. It accepts no `--allow`, `--deny` or
  `--review`: the rules and the mode from `start` are reused. The script
  allows `CB_MAX_ROUNDS` resumes (2 by default).
- When the limit is reached, the worker reports `blocked`, or the problem
  needs a design judgment, take the task back: continue from the worktree's
  changes, or run `cb clean <id> --discard` and start over. Tell the user
  why before discarding.
- A non-zero exit, a timeout (exit 124) or a run without JSON shows the
  tail of the worker's stderr in the report, and `start` and `resume` then
  exit non-zero: with the worker's own exit code, or with 3 when the
  worker exited 0 without returning a result. Hitting `CB_MAX_TURNS` is
  the second case: the CLI exits 0, prints nothing on stdout and writes
  `Max turns (<n>) exceeded` to stderr, and its output holds no session
  id, so a first run that hits the limit cannot be resumed. Look at the
  changes already in the worktree, then take the task back and finish it
  yourself, or discard it and `start` again with a larger `CB_MAX_TURNS`.
  For login, quota or model errors, stop and tell the user; do not retry.
- A `429` frequency-limit error from the free model is a quota error. Stop
  and tell the user the reset time from the error; do not retry, and do
  not `resume`: the run has no session id, so `cb resume <id> <feedback>`
  exits 1 with `no session_id recorded for '<id>'; start a fresh task
  instead`. After the user agrees, run `cb clean <id> --discard`: it
  removes the worktree but keeps the task directory and its logs, so the
  same id cannot `start` again and the restart needs a new id. Then either
  `start` again with a new id after the reset time, or, once the user has
  confirmed another model is free for their account and it is on the
  allow list, `start` again with `CB_MODEL=<model>` and a new id.

## Reporting to the user

After a delegated task, report in a few lines: the task id and number of
worker rounds; each acceptance command and its result from your own re-run;
the landed files; the commit hash or "not committed"; open issues. Keep
what the worker reported apart from what you verified.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CB_MODEL` | `deepseek-v4.1-flash` | Worker model id; trust what `cb doctor` lists |
| `CB_ALLOWED_MODELS` | `$CB_HOME/allowed-models.txt` | File listing the models `CB_MODEL` may name |
| `CB_TIMEOUT` | `1800` | Seconds per worker run |
| `CB_MAX_TURNS` | `60` | Agent turns per worker run |
| `CB_MAX_ROUNDS` | `2` | Resumes allowed after the first run; automatic reruns are not counted |
| `CB_HOME` | `~/.cache/cb-delegate` | Worktrees, run logs and `ledger.jsonl` |
| `CB_BIN` | `codebuddy` | CLI executable |

The worker runs with `--permission-mode dontAsk`: only the allow list runs,
everything else is denied without a prompt. `Edit`, `MultiEdit` and `Write`
are allowed only by absolute-path rules for the task's worktree, so the
worker cannot write anywhere else. A review task does not get even these
rules: all four file-writing tools are denied. Reads cannot be limited the
same way: CodeBuddy allows `Read` and `Glob` on any path the user's account
can read, whatever the allow list says. Reads are therefore guarded in three
layers, as in the opencode-orchestration skill: the brief and the worker
rules say what to read; deny rules stop reads of credential stores (`~/.ssh`,
`~/.aws`, `~/.azure`, `~/.gnupg`, `~/.config`, `~/.docker`, `~/.kube`,
`~/.password-store`, `~/Library/Keychains`, the home folders of CodeBuddy and
the other agent harnesses listed in `scripts/cb-delegate.sh`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`)
and every `--deny` rule; and the report lists every outside read for
review. The `Grep` tool is removed because it ignores path rules; the worker
searches with `git grep`, which stays inside the repository, and
`git grep --no-index` and `git diff --no-index` are denied. The script's
deny list (commit, push, reset, checkout, stash, worktree, `rm`, `sudo`,
`curl`, `wget`, `ssh`, `DeferExecuteTool`, web access) is evaluated before
any allow rule, including allow rules in the user's own
`~/.codebuddy/settings.json`. The script never passes `--fallback-model`, so
a rate-limited free model cannot silently fall back to a paid one.

`doctor`, `start` and `resume` refuse to run, with exit code 2 and
`MODEL_NOT_ALLOWED`, when `CB_MODEL` is not allowed. The allowed models are
the lines of the file `CB_ALLOWED_MODELS` names, or else of
`$CB_HOME/allowed-models.txt` (one model id per line, `#` lines ignored).
Without either file only the default model runs. Add a model to the file
only after the user confirmed it is free for their account, for example
`hy3`. A `CB_ALLOWED_MODELS` file that does not exist stops the script with
`MODEL_LIST_MISSING`.

`$CB_HOME/ledger.jsonl` records every run, landing and discard with exit
code, duration, rounds and the reported cost. Use it when the user asks how
well delegation works, for example first-round acceptance rate and rework
rounds.

## Known pitfalls

- The worker starts from the main worktree's `HEAD` and cannot see
  uncommitted changes or files ignored by git, such as build output and
  local scratch folders; `cb start` warns when the main worktree is dirty,
  and warns about each relative path under `## References` that is missing
  from the worker's worktree.
- Some run environments execute part of their commands in a sandbox, and
  `$TMPDIR` inside the sandbox can differ from `$TMPDIR` outside it. On
  2026-10-22 a brief written to `$TMPDIR` inside a sandbox was not found by
  `cb start` run outside it. Keep the brief at an absolute path that both
  see; the error's `looked for` shows the path the script actually checked.
- The worker cannot delete files. It lists needed deletions in
  `open_issues`; make them after landing.
- Under `dontAsk`, writes to protected paths such as `.git`, `.mvn`,
  `.vscode`, `.idea` and `.codebuddy` are denied (CodeBuddy permission-mode
  documentation, checked 2026-10-22).
- Plain `-p` mode cannot deliver results of the worker's own background
  tasks, so the script sets `CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS=1`
  (CodeBuddy headless documentation, checked 2026-10-22).
- The WorkBuddy desktop app ships a `codebuddy` file under
  `Contents/Resources/app.asar.unpacked/cli/bin/`. It is not a usable CLI:
  on 2026-10-22 (bundled version 2.161.0) `--version` worked, but `--help`
  and every other command failed with `Cannot find module
  '../dist/codebuddy'`. Install the npm package instead and do not set
  `CB_BIN` to the bundled file.
- Checked on 2026-10-22 with CLI 2.172.1:
  - `-p --output-format json` prints a JSON array of the whole conversation,
    not one result object. The script keeps it as `run-<round>.out` and
    reads the last element whose `type` is `result`.
  - `--allowedTools` and `--disallowedTools` silently ignore a list packed
    into one argument, comma- or space-separated, although `--help` says
    such lists work: every tool is then denied. Pass each rule as its own
    argument, as the script does.
  - Path rules need absolute paths or `~/` paths: `Write(./**)` matched
    nothing.
  - `Bash(python3 -m unittest:*)` denied the worker's
    `cd <worktree> && python3 -m unittest ... | tail` although the allowed
    command was inside it. The worker rules therefore require running
    acceptance commands exactly as written.
  - `Read`, `Grep` and `Glob` run without being on the allow list. A
    `Read(<dir>/**)` deny rule stops `Read` only: `Grep` still printed the
    denied file's content, and `Grep(<dir>/**)` deny rules were ignored. A
    bare `Grep` deny rule removes the tool. `Glob` still lists file names
    in denied folders.
  - Without `CODEBUDDY_CODE_DISABLE_AUTO_MEMORY=1`, the CLI tells the worker
    to keep notes in a memory folder under `~/.codebuddy`, outside the
    worktree. The script sets it and `CODEBUDDY_DISABLE_AUTO_MEMORY=1`.
  - `deepseek-v4.1-flash` and `hy3` are listed in `codebuddy --help` and
    show a credit multiplier of `x0.00` in the interactive `/model` menu;
    smoke tests and real runs reported `total_cost_usd` 0. A community post
    says this lasts until 2026-11-01. Still ask the user to compare the
    credit balance.
- Checked on 2026-10-24 with CLI 2.173.0: a bare `Edit`, `MultiEdit` or
  `Write` deny rule removes those tools even when a `Write(<dir>/**)` allow
  rule is also given; with only the allow rule and the same prompt, the file
  was written. Review tasks rely on this to keep the worker from writing.
- `ToolSearch` lists tools that are not loaded, and `DeferExecuteTool` runs
  one of them by name. A worker used that path to call denied tools: on
  2026-10-22 `Grep` on a directory denied for reading, and on 2026-10-24
  `Write` while every file-writing tool was denied. Both calls were refused
  only because `DeferExecuteTool` was not on the allow list; the script now
  denies it explicitly.
- Checked on 2026-10-23 and 2026-10-24 with CLI 2.173.0: with
  `--output-format json`, a run that hits `--max-turns` exits 0, prints
  nothing on stdout and writes only `Max turns (<n>) exceeded` to stderr, so
  the conversation, the tool calls and the session id are all lost.
  `--output-format stream-json` writes one event per line as the run goes,
  starting with the session id, but after hitting the turn limit it wrote no
  result and the process did not exit for more than ten minutes and was
  stopped by hand, so the script still uses `json`.
- Checked on 2026-10-24 with CLI 2.173.0: the free model
  `deepseek-v4.1-flash` hitting its frequency limit prints only one line
  to stderr, `429 usage exceeds frequency limit, but don't worry, your
  usage will reset at <time>, alternatively, you can switch to the other
  models to continue using it. (<request ids>)`, then exits 0 after about
  five seconds with an empty stdout. In the two hours before that,
  `ledger.jsonl` logged eight `deepseek-v4.1-flash` runs for the same
  account from two projects; the reset time the error gave was about 7.5
  hours later, and `hy3` for the same account ran normally in the
  meantime. The script treats this as a run with no result: `start` exits
  3, the report's first line is
  `== cb-delegate report: <id> (round 0, exit 0) ==`, followed by a `!!`
  line reporting that the tool-call and command records are missing and
  ending with `(last stderr line: 429 usage exceeds ...)`, then a
  `-- worker produced no valid JSON. stderr tail:` line that shows the
  same line again; the worktree still exists but holds no change.
- Checked on 2026-10-24 with CLI 2.174.0:
  - The command tool ends a command at 120 seconds (the tool result shows
    `"signal": "SIGTERM"`, `"interrupted": true` and `"tool_error_code":
    "8013"` when no timeout was passed to the call).
  - A resume round may list the tool calls of the earlier rounds again with
    the same `callId` (two of three tasks checked on 2026-10-24 did, the
    third shared no `callId` with its first round), so the report's "tool
    calls outside the worktree" and "shell commands" lists can include the
    earlier rounds. The acceptance check counts only calls whose `callId` is
    not in the previous round's output, which gives the same answer in both
    cases.
  - In four tasks the worker (once `deepseek-v4.1-flash`, three times `hy3`)
    rewrote an acceptance command despite the worker rules, and twice gave up
    after a denial, so the script now checks and resumes automatically.
