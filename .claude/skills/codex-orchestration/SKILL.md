---
name: codex-orchestration
description: Manage the local OpenAI Codex CLI as a delegated coding agent on the user's behalf — dispatching tasks in new sessions, waiting in the background, reviewing stop files and commits rigorously, writing replies, and resuming. Use whenever Claude hands work to Codex, answers a Codex stop file, reviews a Codex commit, or resumes a Codex session, in any project.
---

# Codex Orchestration

Claude manages Codex; the user talks only to Claude. Codex never asks the user
directly, and Claude never forwards a Codex question to the user unless the
answer is outside Claude's authority (see [Authority](#authority)).

Project-specific facts (handoff directory, stop-file names, test layers,
disk rules, remote hosts) come from the project's own instruction files and
its state file. This skill holds only the reusable procedure.

## Files

All communication is through Markdown files in the project's handoff
directory (ask once per project, then record it in the state file):

| File | Written by | Purpose |
| --- | --- | --- |
| `<date>-<task>-brief.md` | Claude | New task or new batch, from [templates/brief.md](templates/brief.md) |
| `<date>-<task>-codex-stop-<N>.md` | Codex | Why Codex stopped; starts with [templates/stop-summary.md](templates/stop-summary.md) |
| `<date>-<task>-claude-reply-<N>.md` | Claude | Ruling on a stop file, from [templates/reply.md](templates/reply.md) |
| `claude-codex-state.md` (stable name, no date) | Claude | **Current state only**, from [templates/state.md](templates/state.md). See [State file](#state-file) |

## State file

A new Claude session has no chat history, only files. An append-only handoff
log grew to 373 lines (46 KB) in one day and mixed kinds of content that
already have a better home. Keep each kind where it belongs:

| Content | Where it lives |
| --- | --- |
| Review findings, evidence, rulings | The reply file for that stop |
| User decisions | Project docs (ADR, Backlog) and memory |
| Procedure (how to launch, wait, review) | This skill |
| History (what happened when) | git log, stop and reply files |
| Facts a command can derive (HEAD, dirty files, Codex model, effort, tokens, newest stop/reply, item status) | Not stored; `scripts/codex-resume-context.sh` prints them |
| Goal, items, plan, progress, open user decisions, remaining roadmap, known limitations for the final report | The long-task directory, see [Goal, plan and progress](#goal-plan-and-progress) |
| Current batch (brief path and item IDs), session id, tab, next stop file, conditions to check at the next review | The state file |

Rules:

- Overwrite the whole file whenever state changes: batch start, stop handled,
  rework queued, decision opened or resolved. Never append a log.
- Budget: 60 lines. The script warns above that; move content out rather than
  raising the limit.
- Write the Codex session UUID and the next stop-file path verbatim; the
  script parses both.
- Resuming in a new Claude session is one command, then reading only the
  newest stop and reply files:

  ```bash
  bash ~/.claude/skills/codex-orchestration/scripts/codex-resume-context.sh <repo> <handoff-dir>/claude-codex-state.md
  ```

  If it reports that the next stop file exists, handle that stop first.
  It also prints `longtask.py status` when the repository has a long-task
  directory. Background wait ids do not survive a Claude session; start a new
  wait.

## Goal, plan and progress

Delegating to Codex makes every Codex task a full-mode long task: follow
[long-task-planning](../long-task-planning/SKILL.md). Its task directory
(`<repo>/.agents/tasks/<task>/`) holds the user's goal verbatim, the items
with their completion conditions, and the plan; whether an item is done comes
only from `longtask.py status`, computed from recorded evidence. This skill
covers how to talk to Codex, not what the goal or progress is.

- Every brief names the batch's item IDs and copies their `done_when`. The
  launcher takes the batch from the bullets in the brief's `范围` section that
  start with an item ID and refuses a brief without a valid batch (see
  [Sessions](#sessions)).
- Codex records its test evidence with `longtask.py record --by codex`
  (fingerprint computed on the test host after syncing and before the tests)
  and lists the evidence IDs in its stop file. Codex does not edit
  `goal.md`, `items.json` or `plan.md`.
- At every stop file, run `status` first, then follow long-task-planning's
  replanning steps. Work that matches no item is drift or new scope; new
  scope goes to the user before it enters the plan. Newly found problems go
  to the project's backlog first and become items only after triage.

## Sessions

- Model, reasoning effort and speed follow the user's standing preference in
  memory. Current preference (2026-10-03): `gpt-6.1-sol` with `ultra` and
  **fast** for all Codex work (coding, hard problems, documentation), on
  every launch and resume (`-m gpt-6.1-sol -c model_reasoning_effort="ultra"
  -c service_tier="fast"`), until the user says credits are tight. The
  model list in `~/.codex/models_cache.json` gives the levels low, medium,
  high, xhigh, max and ultra; `ultra` is described as maximum reasoning with
  automatic task delegation, so Codex may start its own sub-agents. Until
  that has been observed in a batch, say in the brief that sub-agents follow
  the same project rules (test host, no tests on forbidden machines, commit
  and push rules), and check the session log for sub-agent commands at
  review time. This replaced `max` + fast (2026-10-02) and the 2026-10-01
  split (`xhigh` for coding, `gpt-6-astra` for hard problems, `high` for
  docs). Speed, like effort, is fixed per turn:
  a running turn keeps its tier, so apply a change at the next stop by
  stopping and resuming, not with `codex queue`. State the chosen model,
  effort, speed and the reason in each brief.
- New task **or new batch** → new Codex session. Within one batch, answer
  stops by resuming the same session. A batch is a group of changes handed
  over together for review, normally no more than three independent defects.
- Launch in a visible terminal tab with `mcp__terminal__run_in_terminal`, one
  ASCII line from the repository root, so the user can watch. The launcher
  runs `longtask.py check-brief` first and does not start Codex when the
  brief's `范围` section has no bullet starting with an item ID of the active
  long task, has more than three, or names a withdrawn item; a withdrawn ID
  mentioned elsewhere only prints a warning:
  `bash ~/.claude/skills/codex-orchestration/scripts/codex-launch.sh <brief path> <first stop path> -- -m <model> -c model_reasoning_effort="<effort>" -c service_tier="fast"`
  (drop the last option when the user's speed preference is standard). A brief
  with a line `只读任务：是` outside any fenced code block skips the item check
  and prints `READ_ONLY_BRIEF`. With no open long task, the check passes with a
  note and Codex starts. With more than one open long task, the check picks the
  task whose items the brief's `范围` section fits, so `--task` is only needed
  when the brief matches none or more than one of them. To force a specific
  task, put `--task <task>` before the brief path: the launcher passes the
  value unchanged to `longtask.py check-brief --task`, so the brief is checked
  against that task.
  Resume: `codex resume <session-uuid> -m <model> -c model_reasoning_effort="<effort>" "Read <reply path> fully, then continue per its ruling. The next stop file is <path>."`
- Effort can change **per turn** inside one session: `codex resume` with a
  different `-c model_reasoning_effort` applies to every later turn, and the
  session keeps its context (verified 2026-09-29: one session went `high` →
  `xhigh` across a resume, recorded in each turn's `turn_context`). It cannot
  change inside a running turn, and Codex often finishes a whole batch in one
  turn. So split work that deserves a different effort into its own turn:
  after the code commits are reviewed, resume with `high` for "write the
  final report" or "reseal Runbooks". Keep the model fixed: switching models
  is expected (not verified) to lose the prompt cache for the whole context,
  which is where most token savings come from.
- After launching a new session, get its UUID and settings in one step
  (sandbox disabled): `scripts/codex-session.sh new <brief path>`. It waits
  for the first session log that started after the brief was written (the
  start time in the log's file name) and has a turn, then prints `status`.
  Since Codex 0.159 one launch can create two logs: the main thread
  (`"originator":"codex-tui"`, the requested model and effort) and an
  approval-review thread (`"model":"codex-auto-review"`, effort `low`); `new`
  skips the review thread. It also skips older sessions that are still being
  written, such as the user's own Codex Desktop work (on 2026-10-02 the
  earlier modification-time check picked one of those). Confirm the main
  thread with `grep -c '"model":"<model>"' <log>`.
- After every launch or resume, run
  `scripts/codex-session.sh status <uuid>` and check model, effort and the
  `service_tier` the user's current preference requires (fast since
  2026-10-01). Codex 0.159 records `-c service_tier="fast"` in the log as
  `"service_tier":"priority"` inside `thread_settings_applied`; `status`
  prints `priority` for fast (verified 2026-10-02 on a resumed session). A
  new session launched with `codex-launch.sh` may write no tier field to
  the log at all; `status` then prints `not in log`, and the TUI footer
  (`GPT-6.1-Sol xhigh fast`) is the evidence instead (seen 2026-10-02).

## Waiting

Never poll in the foreground and never ask the user whether Codex finished.
Start a background Bash task (sandbox disabled, because `lsof`/`ps` need it):

```bash
bash ~/.claude/skills/codex-orchestration/scripts/codex-wait.sh <repo> <uuid> <stop-file-relative-path>
```

It wakes on a stop file, a new commit, a Codex question, the Codex process
exiting, or 20 minutes without log activity. On wake, act, then start a new
wait unless the task is finished.

## Answering Codex questions

Codex can ask mid-task through its `request_user_input` /
`request_user_input_async` tool; the TUI shows "1 question, shift+← to
answer" and nobody but Claude may answer it. The wait script wakes on the
first such call after it started and prints the question title.

1. Read the full question and options from the session log
   (`grep -n request_user_input <log> | tail -1`).
2. Answer within Claude's [Authority](#authority); ask the user only when the
   answer is outside it. If the answer changes or extends a ruling, write it
   as a short addendum reply file (`claude-reply-<N>a.md`) so it is on record.
3. Deliver with `codex queue --thread <uuid> --message "<ASCII answer plus
   pointer to the addendum>"`. The queued message is delivered at Codex's next
   turn boundary, so confirm from the log afterwards that Codex received it.
4. Restart the wait: it only watches for questions asked after it started.

## Handling a stop file

1. Read the summary table first; read the rest only where needed. Run
   `longtask.py status` and check that the evidence IDs the stop file lists
   exist in `evidence.jsonl` and that `status` agrees with its claims.
2. Verify every claim that the ruling depends on yourself: read the cited code,
   rerun the cheapest discriminating check, read evidence files. Label each
   fact confirmed / partially confirmed / rejected / uncertain.
3. Rule within [Authority](#authority). Write the reply from the template,
   with conditions concrete enough to check at review time.
4. Deliver:
   - Default: `scripts/codex-session.sh stop <uuid>` (refuses unless the last
     event is `task_complete` and the log has been quiet for 30 seconds;
     `--force` only after confirming no test or build process is running;
     never stop Codex mid-test), then resume in a new terminal tab.
   - `codex queue --thread <uuid> --message "<ASCII pointer>"` (verified
     2026-09-29): the message is delivered only **after Codex's current turn
     ends**, and then starts a new turn immediately. Use it only for
     non-urgent notices while Codex works. Word the message so it stays
     correct whenever it arrives: never write "continue without stopping" —
     if it lands after Codex has stopped for a ruling, Codex may continue
     without one. Write "read this; it does not answer any pending stop
     file" instead.
5. Do long-task-planning's replanning steps (plan logs, next batch),
   overwrite the state file and restart the wait.

## Reviewing commits

Review each new commit while Codex continues with the next item; batch
non-critical rework into the next reply, stop Codex immediately only for
serious problems. Review standard does not drop:

- Read the production diff line by line; compare with the approved design.
- Confirm the red test failed for the stated reason before the fix
  (read the retained failing report, not the summary).
- Count every assertion in every report:
  `python3 ~/.claude/skills/codex-orchestration/scripts/vitest-summary.py <reports...>`
  (non-zero exit lists every non-passed assertion or count mismatch).
- When a test run's working-tree snapshot patch is claimed to match a commit,
  check it:
  `python3 ~/.claude/skills/codex-orchestration/scripts/snapshot-matches-commit.py <commit> <snapshot.patch>... -- <pathspec>`
  (non-zero exit on any file that differs or is missing). `git diff` omits
  untracked new files, so a new file shows as MISSING; compare it against
  Codex's separately saved copy, and ask in the brief for snapshots taken
  after `git add --intent-to-add` so new files are included.
- Check that the commit message states only the test layers actually run.
- Record the outcome as evidence:
  `longtask.py record --review --items <ids> --verdict approved|rejected --files <reviewed files> --by claude`.
- Do not delegate this review to `codex review`: the same model reviewing its
  own work shares its blind spots.

## Writing briefs

- One batch per brief, at most three items to work on, each on its own
  bullet in the `范围` section that starts with the item ID, with its
  `done_when` copied from `items.json`. Items that the same test run only
  verifies go on a bullet that does not start with an ID and do not count. State the minimum acceptance
  evidence precisely: which test layer, which test group, how many runs, on
  which revision. Ambiguous wording such as "run it three times" caused
  unnecessary full-suite runs.
- Ask Codex to record test evidence with `longtask.py record --by codex` as
  long-task-planning's "Recording evidence" section describes, and to list
  the evidence IDs in the stop file.
- Give a time budget and require a stop file when it is exceeded twice.
- Put durable project rules in the project's instruction file and link them
  from the brief; do not restate them in every reply.
- Paste the stop-summary template into the brief's appendix.

## Authority

Claude decides alone: design choices inside the task's scope, approving or
rejecting Codex proposals, rework, restarting Codex, test environments Codex
created, deleting rebuildable artifacts the task created (after checking they
are not referenced as evidence).

Ask the user first: new downloads or dependencies, deleting user-owned files,
remote or production operations, push/branch/PR, product decisions, relaxing
safety checks or timeouts, anything the project's instructions reserve for
the user.

### Pre-authorized changes

Approved by the user on 2026-09-29. Codex may implement a change without
stopping only when **all four** conditions hold; otherwise it must stop and
write a stop file:

1. It changes only internal call interfaces between the project's own code,
   such as adding a method to an existing internal port. No external
   interface changes (anything other programs, users or network peers call).
2. It does not touch the project's high-risk shared areas. The project lists
   them in its own instruction file (for example, the changes that require an
   early full test run). If the project lists none, treat database schema and
   migrations, network protocols, authentication, dependencies and build
   configuration as high-risk.
3. It relaxes no existing check, assertion, deadline or timeout.
4. It changes no user-visible product behavior.

Codex marks each such change as "预先授权改动" in the commit message and in
the stop-file summary. Claude reviews it line by line afterwards, like any
other commit. Paste these four conditions into every brief.

## Measuring

`scripts/codex-session.sh status <uuid>` prints cumulative input, cached and
output tokens. Record them with elapsed time in the reply that closes a batch,
so cost and duration can be compared across batches.

## Known pitfalls

- Do not give diagnostic (evidence-gathering) runs a "stop at the first
  failure" rule. Each failure is the data being collected; stopping after one
  sample cost a full stop/reply round trip on 2026-10-01. Ask for N runs that
  continue through failures and report the whole distribution; keep
  first-failure stops for acceptance runs, and even there say "let the test
  command finish, then stop": in one project's stop-45 Codex read "stop on any
  failure" as "kill it" and SIGTERMed `npm test` after one project failed, so
  the other four projects produced no reports. When the likely fix is already
  clear, pre-approve it in the same reply with measurable conditions, so Codex
  does not stop again just to ask.
- Codex may amend a local commit Claude already reviewed (seen 2026-09-29:
  `c64c621` → `59880a5`). `codex-wait.sh` wakes on the changed HEAD. Review
  only the delta with `git diff <reviewed> <new>` and record the new hash in
  the state file; briefs should ask for a follow-up commit instead of
  amending reviewed commits.

- `ps`, `kill`, `lsof` on Codex processes fail inside the Bash sandbox; run
  them with the sandbox disabled.
- A second `codex resume` fails while the old process still has the session
  open; stop the old one first.
- `mcp__terminal__stop_terminal_tab` refuses tabs the user has typed in; use
  `codex-session.sh stop` instead.
- zsh: `echo ====` fails (`=` expansion), unmatched globs abort the command,
  `$var:x` is parsed as a modifier (use `${var}`), `wc -l` pads with spaces.
- Codex's own approval reviewer also writes `task_complete` events, so a last
  `task_complete` alone does not prove Codex is idle. `codex-session.sh stop`
  also requires 30 seconds without log writes; when in doubt, read the last
  few log lines.
- Claude Code kills a background Bash task after about 30 minutes
  (observed 2026-10-02: `codex-wait.sh` reported `[killed]` while Codex was
  still running a long test layer). A killed wait is not a wake event: check
  `codex-session.sh status` and the stop file, then start a new wait. The
  limit is the default background `timeout` (30 minutes); start waits with
  `timeout: 7200000` (the maximum, 2 hours) so long test layers do not kill
  them.
