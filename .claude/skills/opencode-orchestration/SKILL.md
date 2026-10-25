---
name: opencode-orchestration
description: Let Claude Code delegate coding and testing to the local opencode CLI and stay the planner and strict reviewer - setting a deny-list safety net, writing briefs, launching and resuming sessions, detecting silent failures, reviewing every change, and answering stop files; also asking opencode for an independent design proposal and for a review of code Claude wrote. Use whenever Claude hands work to opencode, reviews opencode output, or resumes an opencode session, in any project.
---

# opencode Orchestration

Claude plans, reviews and drives the task; opencode writes code and runs
tests. The user talks only to Claude. opencode never asks the user anything,
and Claude forwards an opencode question to the user only when the answer is
outside Claude's authority (see [Authority](#authority)).

Project facts (handoff directory, test hosts, test layers, production
boundaries, model choice) come from the project's instruction files and its
long-task directory. This skill holds only the reusable procedure and what
has been learned about opencode itself. Improve it whenever a delegation
teaches something new: add the observation to [Known pitfalls](#known-pitfalls)
with its date and evidence, and change the procedure when the pitfall shows
the procedure was wrong.

When opencode, Grok, or Claude makes the same mistake a third time, a longer
brief is not the fix: the earlier reminders already failed twice. Pause that
line of work, find the root cause, and add a constraint the agent cannot
skip: a `bash` deny pattern, a commit hook in the shared `.git`, a check in
`oc-wait.sh` or another script that runs on every batch, or a test. Show it
blocking a reproduction of the mistake before resuming.

When the delegated model is a Grok model, or Claude chooses between a Grok
model and another one, read [references/grok.md](references/grok.md) first;
skip it otherwise.

Whenever Claude writes code itself, read
[references/consult-and-cross-review.md](references/consult-and-cross-review.md)
before settling a design or fix and before running, freezing or committing
that code: opencode reviews every line Claude writes, just as Claude reviews
every line opencode writes.

## Contents

- [Before the first delegation in a project](#before-the-first-delegation-in-a-project)
- [Files](#files)
- [Goal, plan and progress](#goal-plan-and-progress)
- [Launching and resuming](#launching-and-resuming)
- [Watching and steering](#watching-and-steering)
- [Waiting and liveness](#waiting-and-liveness)
- [Writing briefs](#writing-briefs)
- [Preventing rework](#preventing-rework)
- [Reviewing](#reviewing)
- [Handling a stop file](#handling-a-stop-file)
- [Authority](#authority)
- [Known pitfalls](#known-pitfalls)

## Before the first delegation in a project

1. Check the CLI and the model: `opencode --version`, then
   `opencode models | grep <model>`. Run opencode commands outside the Bash
   sandbox: it writes its log and database under the user's home directory
   and fails with `FileSystem.open` errors inside it.
2. Write the deny list. opencode reads a project file
   `<repo>/.opencode/opencode.json`; keep it local by adding `.opencode/`
   to `.git/info/exclude` unless the project wants it committed. Shape:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "permission": {
       "bash": { "*": "allow", "*<production host>*": "deny", "sudo *": "deny" },
       "read": { "*": "allow", "~/.ssh/**": "deny" },
       "external_directory": { "*": "allow", "~/.ssh/**": "deny" }
     }
   }
   ```

   The last matching pattern wins, so `"*"` goes first. `*` matches any
   characters. Deny what the project forbids: production hosts and their
   wrappers, local test runners on machines where tests must not run,
   force pushes and history rewrites, credential stores, `sudo`. `--auto`
   approves everything not explicitly denied, so the deny list is the only
   hard stop; the brief's rules are the main control and the list is the
   safety net.
3. Run `opencode reload`, then `opencode debug config` and check that the
   project file appears with its rules. Environment variables such as
   `OPENCODE_CONFIG` are not read by opencode 2.0.27 (verified 2026-10-12).
4. Run one tiny prompt with the chosen model (see
   [Launching and resuming](#launching-and-resuming)) before the first real
   brief. It catches account and model problems in seconds instead of after
   a long silent wait.

## Files

Every message is a Markdown file in the project's handoff directory, kept as
the record. Claude also delivers its messages to a running session (see
[Watching and steering](#watching-and-steering)), so files no longer mean
waiting for the agent to stop:

| File | Written by | Purpose |
| --- | --- | --- |
| `<date>-<task>-oc-brief.md` | Claude | New task or batch, from [templates/brief.md](templates/brief.md) |
| `<date>-<task>-oc-stop-<N>.md` | opencode | Why it stopped; starts with [templates/stop-summary.md](templates/stop-summary.md) |
| `<date>-<task>-oc-reply-<N>.md` | Claude | Ruling on a stop file, from [templates/reply.md](templates/reply.md) |
| `<date>-<task>-oc-<N>.jsonl` | launcher | The run's JSON event stream, kept as review evidence |
| `<date>-<task>-oc-steer-<N>.md` | Claude | A correction or answer sent to a running session with `oc-steer.sh` |
| `<date>-<task>-oc-<N>.steer.log` | `oc-steer.sh` | When each message was sent, how, and to which session |
| `oc-server/` | `oc-server.sh` | The task server's address, password (mode 600), pid and log; never commit or print the password |

## Goal, plan and progress

A delegated batch is by itself a light-mode task under
[long-task-planning](../long-task-planning/SKILL.md): its brief and stop file
in the handoff directory are its record. When the batch belongs to a task
that is in full mode (an open-ended goal, more than three verified
acceptance items, or the user asked for it), the goal (user's words), items
with completion conditions, and the plan live in
`<repo>/.agents/tasks/<task>/`, whether an item is done comes only from
`longtask.py status`, and each brief names at most three item IDs as
bullets in its `范围` section and copies their `done_when`; run
`longtask.py check-brief <brief>` before launching. A batch that changes no
file at all (reading code for a report, reviewing a document Claude wrote)
needs no item: put a line that is exactly `只读任务：是` in the brief, outside
fenced code, and `oc-launch.sh new` skips the check and prints
`READ_ONLY_BRIEF`; every other check still runs. When the repository has more
than one open long task, `check-brief` picks the task whose items the brief's
`范围` section fits, so `new --task <task>` is only needed when the brief matches
none or more than one of them; the value goes unchanged to
`longtask.py check-brief --task`.
opencode records test evidence with `longtask.py record --by opencode` and
never edits `goal.md`, `items.json` or `plan.md`.

## Launching and resuming

Launch and resume with [scripts/oc-launch.sh](scripts/oc-launch.sh). It
starts, or reuses, the task's own opencode server through
[scripts/oc-server.sh](scripts/oc-server.sh) (127.0.0.1 only, a random
password in a mode-600 file, state in `<handoff>/oc-server/`) and runs
`opencode run --server <url>`, so Claude can message a running session (see
[Watching and steering](#watching-and-steering)). Do not use `--standalone`:
it gives each run a private server that takes no messages from outside, so a
run going the wrong way could be corrected only after it stopped. Do not use
the shared background service either: through it a provider error was
swallowed and the run printed nothing until an outer timeout killed it after
240 seconds (2026-10-12). On 2026-10-15 the task server returned a
`provider.no-route` error in one second, refused a command matching the
directory's deny rule, and ran the control command. Stop the server when the
task ends: `oc-server.sh stop <handoff>/oc-server`.

When the user sets which models may be used, put the IDs in
`.opencode/allowed-models.txt` in the directory you launch from, one per
line (`#` lines are comments), or name another file in `OC_ALLOWED_MODELS`.
`oc-launch.sh` then refuses any other model, compared without its
`#variant` and as a whole line, with `MODEL_NOT_ALLOWED` before it checks
the brief or starts anything; that covers `oc-steer.sh --interrupt` too,
which resumes through it. opencode's own per-provider `whitelist` did not
narrow the model list in v2.0.27, so the launcher is the gate. A paid model
whose ID is the start of a free one's (`opencode/deepseek-v4.1-flash`
against `opencode/deepseek-v4.1-flash-free`) is exactly what the
whole-line match stops. The started line ends with `model=<id>`; report
the model, the time, and why it was chosen when the project asks for it.

When the directory you launch from keeps a guard plugin under
`.opencode/plugins/` (opencode loads it into every session started there,
and a check in the plugin's `tool.execute.before` hook can refuse a tool
call before it runs), list it in `.opencode/required-plugins.txt`, one
`<SHA-256>  <relative path>` line per file. `oc-launch.sh` then refuses to
start, exit code 2, when a listed file is missing
(`REQUIRED_PLUGIN_MISSING`), its digest differs (`REQUIRED_PLUGIN_CHANGED`),
a line is not a digest and a relative path inside the directory
(`REQUIRED_PLUGIN_BAD_LINE`), or the list names nothing
(`REQUIRED_PLUGIN_LIST_EMPTY`). Without the list nothing changes. Every
worktree you launch from needs its own copy of the plugin and the list;
after changing the plugin, update every copy and every list, or the next
launch from an old copy is refused. A plugin added while a session runs
was loaded by that session at once in v2.0.32, so a guard can refuse the
session that is still writing it.

New session (one batch = one session):

```bash
<skill>/scripts/oc-launch.sh new <brief path> <handoff>/<date>-<task>-oc-<N> '<provider/model>#<variant>' "<task>-<batch>"
```

When the repository has more than one open long task, `check-brief` picks the
task whose items the brief's `范围` section fits, so add `--task <task>` right
after `new` only when the brief matches none or more than one of them; it is
passed unchanged to `longtask.py check-brief --task` and never reaches
opencode.

The run prefix always starts with the handoff directory. The task server's
state goes next to the prefix (`<prefix dir>/oc-server/`), so on 2026-10-16
a prefix without a directory started a second server in the repository root,
beside the task's real one, and left the run files there. `oc-launch.sh`
now refuses a prefix whose directory is the current one (`run-01`,
`./run-01`, the same directory as an absolute path, or through `..`) with
`PREFIX_WITHOUT_DIRECTORY` before it starts anything, even when
`OC_SERVER_DIR` points elsewhere.

Pick a reasoning level with a variant suffix, `-m '<provider/model>#<variant>'`
(for example `#high`), quoted so the shell leaves `#` alone. The variants a
model offers change with opencode releases, so never take them from a
recorded list: `oc-launch.sh` asks the task's server (`GET /api/model`) at
every start, prints `LIVE_VARIANTS model=<id> variants=<list>`, and refuses a
variant that is not in the live list with `VARIANT_UNAVAILABLE` (a model the
server does not list with `MODEL_NOT_SERVED`, an unreadable list with
`VARIANT_LIST_UNAVAILABLE`); the refusal shows the live list to choose from.
When a project sets a lowest allowed variant per model, it writes
`.opencode/variant-floor.txt` (lines `<provider/model> <variant>`, or a file
named in `OC_VARIANT_FLOOR`) in the launch directory, and the launcher refuses
a lower or missing variant with `VARIANT_BELOW_FLOOR`, a floor that is not a
live variant with `VARIANT_FLOOR_UNKNOWN`, and ignores the floor of a model
whose live list is empty with a `VARIANT_FLOOR_IGNORED` line.
Choose the variant per batch when its session starts, by difficulty: the
higher level for causes that are unknown or may span layers, security,
sandbox, storage or protocol code, unexplained or intermittent failures,
plan-first batches, and tasks that already failed once on the lower level;
the lower level for edits the brief spells out, verification runs and
evidence collection, documentation, cleanup and small test fixes whose
approach the brief gives. Do not assume a middle level exists: on
2026-10-21 (opencode v2.0.32) the DeepSeek and GLM models offered `#low`,
`#high` and `#max` and no `#medium`, while on 2026-10-15 the free DeepSeek
model had no `#max`; the launcher's live list is the only current answer.
Keep the variant for the whole session unless the project allows changing
it; to change it anyway, stop opencode between two tool calls (no test
command running), then resume the same session with the new `-m`; the
session keeps its work.

To stop a run, kill the `opencode run` process itself, not only the
launcher's wrapper: the `<prefix>.pid` file holds the wrapper shell, and on
2026-10-13 killing it left `opencode run` alive with parent 1, still working.
Find it with `pgrep -af "opencode run.*<sessionID>"`, kill it, and confirm
with `ps -p <pid>` before resuming the session.

Every JSON event carries `sessionID`; take it from the first line. Resume
within the same batch, with a new run prefix:

```bash
<skill>/scripts/oc-launch.sh resume <sessionID> <reply path> <next stop file> <new run prefix> '<provider/model>#<variant>'
```

A run is finished only when its stop file is. On 2026-10-18 the third
opencode run in a week ended its turn while its test job on the host was
still going, saying it would continue later, so nothing was left to wake it
and the batch sat idle until Claude noticed. The launcher now enforces this:

- A new session needs a brief that names exactly one stop file not yet
  written, a path ending in `stop.md` or `stop-<N>.md`.
  [scripts/stop-file.py](scripts/stop-file.py) `pick` finds it; none, two,
  or one that already exists ends the launch with `STOP_FILE_UNCLEAR`
  (exit 2). A resume whose stop file already exists ends with
  `STOP_FILE_EXISTS`.
- [scripts/oc-run.sh](scripts/oc-run.sh) runs opencode. When it exits with
  code 0 and the stop file is missing, empty, or still holds a placeholder
  (`待填写`, `待补充`, `TBD`, a section left as `本节…填写`, or a pending
  mark `待补` or `待填` that opens a line, a list item, a bracket or a
  `：` value, or closes a bracket, as in `（待补。）`, `（待补：…）`,
  `（运行中；结果…待补。）` or `结果：待补`), it resumes the
  same session with a message telling the agent to wait for its job and
  write the stop file, and logs `AUTO_RESUME <n>` in `<prefix>.err`. It
  tries `OC_AUTO_RESUMES` times (default 2); then it writes
  `<prefix>.unfinished`, and `oc-watch.py` reports the exit as
  `EXITED ... UNFINISHED`.

On `UNFINISHED`, read the last events and the host's job state before
resuming by hand: the agent stopped twice more without finishing, so the
brief or the wait it is using is the likelier fault.

A manual `opencode run` needs `--server "$(cat <handoff>/oc-server/url)"`,
`OPENCODE_PASSWORD` read from `<handoff>/oc-server/password`, and closed
standard input (`< /dev/null`).

Run launches as a background Bash task (sandbox disabled, `timeout` at the
2-hour maximum) so Claude keeps working and is notified when the run exits.

Two batches that share a working tree may overlap only while at most one
of them changes files or runs tests: they share the index and the test
host's checkout and CPUs, so one can commit the other's files or skew its
timings. To run batches in parallel, give each its own `git worktree`
(detached, no commits until its turn on the branch), its own checkout on
the test host, and its own deny-list copy: the agents' project config
files are untracked, so a new worktree has none until you copy them in
and, for Grok, trust the worktree path. Let only one batch commit to the
shared branch at a time; the others hand over patches or wait. Put heavy
test steps of different batches on different hosts, or tell each batch to
check for the other's test processes before a heavy step and to poll
rather than end its turn while it waits (2026-10-14: a Grok run ended its
turn to wait for a busy host and wrote no stop file).
Check the local machine's free space before adding a worktree or a source
bundle for a parallel batch, and tell each batch to delete its local bundle
once the test host has cloned it. On 2026-10-14 two worktrees and two
92 MB bundles took a nearly full laptop disk to zero; an opencode run died
without writing its exit code and every local command failed until old
build packages were deleted.
The same holds between you and an agent: while an agent works in the
checkout you commit from, it may have staged files. Before each of your
commits there, list `git diff --cached --name-only` and unstage what is
not yours. On 2026-10-14 a commit meant for one instruction file also
carried a documentation file the agent had staged, including two entries
not yet reviewed; it was pushed, so only a later commit message could
correct the record.

## Watching and steering

Read the run while it works instead of only at its stop file. On 2026-10-15
a batch reported six fixture defects only after its long test runs had
finished; an early look would have redirected it an hour sooner and saved
the tokens it spent going the wrong way.

Watch every run with a monitor (the Monitor tool, 30-minute expiry, re-armed
until the run ends) running [scripts/oc-watch.py](scripts/oc-watch.py):

```bash
H=<handoff dir>; python3 -u <skill>/scripts/oc-watch.py $H/<run prefix> \
  --stop-file $H/<stop file> \
  [--signal '<regex for a project-specific alarm>'] [--quiet-seconds 900]
```

Set variables with `;` before the command. `H=<dir> python3 ... $H/...`
expands `$H` before the assignment: on 2026-10-15 a re-armed watch
followed `/<run prefix>` and would have stayed silent for the rest of the
batch. Read the first line after every arm: `WATCHING <file> ...` names the
file and where reading starts, and a prefix or stop file in a missing
directory ends the watch with `WATCH_ERROR`. A re-armed watch resumes from
the byte the last one reached (kept in `<prefix>.watchpos`), so events
written while it was down still arrive; `--from-start` reads the whole log
again.

Each printed line is a notification:

| Line | Act |
| --- | --- |
| `CHECKPOINT: ...` | judge the plan before the long step starts; steer at once if it is wrong |
| `QUESTION: ...` | answer with a steer message; the agent goes on with its stated default meanwhile |
| `EDIT: <tool> <path>` | read the diff of that file now, not at the stop file |
| `SAYS: ...` | check the direction |
| `SIGNAL: <match>; <match> xN (<tool>: <command>)`, `TOOL_ERROR:`, `RUN_ERROR:` | look at once; one line per tool call with repeated matches counted, and the command shown without its leading `cd <dir> &&`, so it tells which run the match came from; a match in a log the agent is only reading back is not a new failure |
| `STALL:` | check the test host before calling it stuck (see [Waiting and liveness](#waiting-and-liveness)) |
| `STOP_FILE` / `EXITED` | handle the stop file or the exit; `EXITED ... UNFINISHED` means the automatic resumes ran out without a finished stop file |

A tool call emits its event only when it returns, so the start of a long
command is invisible; the `CHECKPOINT:` line the brief demands before every
step expected to take over five minutes is the only chance to stop a wrong
long step before it runs. On 2026-10-15 the default failure-count pattern
first read `passed 34 failed 2` as 34 failures; the patterns now skip a count
that follows `passed` and catch `failed <n>`.

Correct a run with [scripts/oc-steer.sh](scripts/oc-steer.sh). Write the
message to a file first; the file is the record, and each send is logged in
`<prefix>.steer.log`. Stop files stay for the end of a batch and for
decisions outside the brief's defaults.

- `oc-steer.sh <prefix> <message file>` delivers the message after the
  current step, and the run continues without restarting. A step that is
  one long command finishes first: on 2026-10-15 a message sent during a
  45-second `sleep` was followed when the sleep ended.
- `oc-steer.sh <prefix> <message file> --interrupt <next stop> <next prefix> <model>`
  stops the current step at once and resumes the same session with the
  message. Use it when the running step itself is the waste. On 2026-10-15
  an interrupt stopped a `sleep 40` within a second, the run ended with exit
  code 1 and an `aborted` "Step interrupted" event, and the resumed session
  followed the correction eight seconds later without rerunning the sleep.
  A steer message sent before the interrupt, even with `resume=true` on the
  interrupt call, stayed undelivered in the session inbox, so the script
  sends the message only through the resume.

Interrupting opencode does not stop jobs it started detached on a test host;
say in the message whether to stop them and how. A message that changes the
code makes every detached run on the old code worthless: say so, and have
it stopped. A queued message arrives only after the current step, so the
agent may start such a run in between; on 2026-10-15 a Layer 2 run started a
minute before a correction arrived. If the run has already reported
failures, have its logs copied to the evidence directory before its output
is deleted, so the failures can still be named.

Before an interrupt, look at what is running on the test host and decide
once what should happen to it. On 2026-10-15 Claude interrupted a run to
stop a rerun that was meant to paper over a failure, then saw that the
rerun was a useful second sample and its follow-up Layer 2 still valid,
and sent a contrary message a minute later; the two messages raced, and
only luck kept the agent from killing the run first.

## Waiting and liveness

Silence is not progress. On every wake, and at least every 20 minutes:

- the process has exited → read the last events of the JSONL; when the last
  events are an `"type":"error"` event, the run failed whatever the exit
  code says, but an error event followed by more steps was retried and did
  not end the run (see [Known pitfalls](#known-pitfalls)), so judge it by the
  stop file;
- the stop file exists → handle it;
- the JSONL has not grown for 20 minutes while the process lives → read the
  last events, check whether a test command is legitimately running on the
  test host, and only then decide to stop it.

Never stop opencode while a test command it started is still running unless
continuing would cause damage; partial reports force a full rerun.

Every wake also runs the evidence gate (`scripts/evidence-gate.sh`, called
by `oc-wait.sh` and `grok-wait.sh`). It checks what arrived since the run
started in the handoff directory and in each root listed in
`<handoff dir>/evidence-roots.txt`: one root per line, either a local path
or `<command>|<remote path>`, where the command runs
`python3 - --since <epoch> '<path>'` with the checker on standard input
(for example `ssh -o BatchMode=yes testhost|/data/evidence`). New
`node_modules` or `.git` directories, archives holding them, and files over
50 MB fail the gate unless an `EVIDENCE-REASONS.txt` beside them names them
as `<name>: <reason>`; an unreachable root fails it too. A failed gate makes
the waiter exit 3 and print each `EVIDENCE_VIOLATION`: do not accept the
batch until the evidence is fixed or the reason is written. Added on
2026-10-14 after agents and Claude packed dependency trees, source copies
and rebuildable packages into evidence more than three times. Tell the
agent about the gate and the reasons file in the brief.

A remote root is not checked while a guarded test run is in progress on
that host: when `$HOME/.agent-quiet-run` there names a live process
(`<pid> <label>`), the gate prints `EVIDENCE_REMOTE_DEFERRED` and fails
instead of starting `python3`. Wrappers that start whole-suite or timing
runs and watch the host for foreign processes should write that file at
start and remove it on exit, so that a waiter waking mid-run cannot void
the run. Rerun `evidence-gate.sh <handoff dir> <since>` after the run ends.
Added on 2026-10-16 after the gate's remote `python3` landed inside a
95-minute guarded run and the run had to be thrown away.

A shell call emits no JSON event until it returns, so a long remote command
looks exactly like a hang. On 2026-10-13 a wait-and-retry loop script ran for
over 50 minutes with no new event while working normally. Before calling a
run stuck, list the processes on the test host (`ps -eo pid,etime,args`) and
look at the files the command writes; set the waiter's quiet threshold above
the longest command the brief allows (60 minutes for such loops).

opencode itself ends a session whose single shell call stays silent for
about an hour: on 2026-10-13 the run ended with an `aborted` error event
"Session interrupted: inactivity", while the remote loop it had started
kept running. Do not ask opencode to sit inside a wait of more than about
45 minutes. Have it start such loops as a detached job on the test host
that writes its result file, write the stop file, and let Claude (or a
later resume) read the result.

The rule has to be in the brief, not only here: later the same day a brief
asked for two back-to-back full test runs (about an hour) without saying
to start them detached, and the session was interrupted the same way. The
brief template now carries the rule, so keep that line when filling it.

A written rule was not enough: on 2026-10-15 an agent followed the brief,
started the run detached, and then waited for it inside one shell call with
a 400 x 10-second loop and a 70-minute tool timeout; the session was
interrupted a third time. Enforce the limit where the agent cannot skip it:
every wrapper the agent may use to reach a test host runs each remote
command under a fixed `timeout 300` (no override) and prints how to start
long work detached instead; the agent's local deny rules block direct
`ssh`, `scp` and `rsync` to the host and its address, so the wrappers are
the only way in. Prove both sides when adding such a wrapper: a long loop
through it ends at the limit, a detached job started through it returns at
once and keeps running, and a direct `ssh` from the agent is refused.

Give the detached form exactly: `setsid -f bash <script> > <log> 2>&1 <
/dev/null`, with any `cd` inside the script. The tempting one-liner
`cd <dir> && setsid nohup <command> > <log> 2>&1 &` blocks the wrapper
until the command ends, because the shell backgrounds the whole `&&` list
as a subshell whose own output is still the SSH channel. It was written
that way twice by 2026-10-16; reproduced the same day, `cd <dir>;
setsid nohup …` and `setsid -f` both returned within a second. Make the
wrappers refuse it before connecting rather than waiting for a third time:
reject a remote command whose part after the last `;` contains `&&` and
ends in a single `&`, name `setsid -f` in the refusal, and name `setsid -f`
in the time-limit hint too. Test the refusal with a stand-in `ssh` first
on `PATH` that only prints a marker, so the check never reaches a host
that may be busy with a measured run; include allowed look-alikes such as
`a && tail log`, `cmd > log 2>&1` and `cd <dir>; setsid nohup … &`.

Poll a detached job through its result file: have the script write a
final line (an exit code or a marker such as `CAND_OK`) and test for that
line, and judge liveness by a PID the job records when it starts. Do not
poll by command-line text, whether with `pgrep -f`, a `/proc/*/cmdline`
scan or `ps … | grep`: a wrapper that runs the remote command as
`bash -c '<command>'` puts the pattern on that shell's command line, so the
check finds itself. On 2026-10-16 a candidate build finished in two minutes
while such a loop kept reporting it as running until it was stopped seven
minutes later; on 2026-10-18 a `/proc` scan kept a session waiting ten
minutes for a host that was already idle. Refusing `pgrep -f` alone did
not stop it, because each new spelling of the check repeated the mistake.
Remove the cause in the wrapper instead: send the command base64-encoded
and decode it in the remote shell
(`bash -c 'eval "$(printf %s <encoded> | base64 -d)"'`), so no remote
command line carries the command's text, and test it with a stand-in
`ssh` that runs the remote string and checks `ps -p $$ -o args=`. Text
matching can still hit unrelated processes that mention the same text (a
`tail` of the job's log, another run of the same script), which is why
the PID stays the test of liveness.

Two sessions can share one test host when each brief names its own result
directories and scratch prefix and forbids touching the other session's
directories, processes and shared inputs. Name any shared read-only input
(for example a prepared runtime copy) in both briefs and say which session
may delete it, and when.

## Writing briefs

Use [templates/brief.md](templates/brief.md). Rules that matter more with a
fast, cheaper model than with a frontier one (starting assumptions; confirm or
revise them from experience):

- One concrete outcome per item, with the exact files to touch, the exact
  commands to run and where, and the exact evidence that counts as done.
- Paste project rules that the work can break (test host, forbidden hosts,
  commit and push rules, disk hygiene) into the brief; a link alone may not
  be followed.
- Say what not to do, especially relaxing checks, changing expected values,
  editing unrelated files, and touching production.
- Give a time budget and require a stop file when it is exceeded.
- Name the batch's one stop file by its full path, and no other path ending
  in `stop.md`: the launcher refuses a brief that names none or several
  (see [Launching and resuming](#launching-and-resuming)).
- For a read-only batch, write the line `只读任务：是` on its own, outside
  fenced code, so the launcher skips the long-task item check; a brief that
  lets the agent edit any file must not carry it.
- Require the six test-value answers for every new test file (entry point
  and observable result, bug or rule, gap, smallest failing input, tier,
  measured time) and the three-state result (not run, failed, passed) with
  red and green runs for a fix; the brief template carries the wording and
  the stop summary has the rows. The rules are the
  [verification-discipline](../verification-discipline/SKILL.md) skill's.
- Paste [templates/stop-summary.md](templates/stop-summary.md) into the
  appendix.
- Name every cleanup target by exact path, never by kind ("superseded
  builds under `.ci-output/`"), and require each run's logs, the red run
  of a fix included, to be copied to the evidence directory before its
  output directory goes; the stop file lists each deleted path as
  "copied to <evidence path>" or "rebuildable from <commit>". On
  2026-10-15 a cleanup message named a kind, and opencode deleted the red
  run of a product fix, leaving only the failure counts it had written
  down; the same day it had deleted a Layer 2 log before naming its
  failures.
- Forbid deleting evidence or result directories explicitly, including its
  own earlier failed results, and require a new run number for every rerun.
  On 2026-10-12 opencode deleted a failed result directory, locally and on
  the test host, just to reuse its run number; back the rule with `bash`
  deny patterns for the evidence paths.
- Say how to capture failure evidence, not only that it must be kept. Agents
  that are told to keep a failure tend to pack the whole scratch directory:
  on 2026-10-14 six packs held about 1.2 GiB, mostly `node_modules` and
  source copies, and two runs each kept their own copy of the same 352 MB
  input. Require reports, logs, state readbacks, and traces as separate
  files; no `node_modules`, `.git`, or source identical to a commit (record
  the commit, lockfile digest, and a path/size/SHA-256 manifest instead);
  one stored copy of an input shared by several runs, with reference files
  holding its path and SHA-256 elsewhere; and a stop-file note for any
  evidence file over 50 MB or any run over 100 MB saying what it holds and
  why it is needed.
- Name-based `bash` deny patterns also block harmless commands such as
  `ls` or `grep` on a file whose name or path matches. Put a line starting
  with `本地禁止规则：` in the brief (and in a resume reply) that names each
  such text and tells the agent to read and search those files with its
  read, glob and grep tools. `oc-launch.sh` refuses to start with
  `BRIEF_NAMES_DENIED_TEXT` when the brief or reply contains the text of a
  `*text*` deny pattern in `.opencode/opencode.json` (no spaces or other
  wildcards: paths, file names, addresses) and no such line names it. A
  written reminder failed three times: two reviews of one production
  packet and the plan for the next were each denied 4 to 6 shell reads
  of the packet before the agent switched tools (2026-10-17).
- Deny patterns match the whole command text, so a pattern meant for the
  local machine (for example `node *`) also blocks the same word inside an
  `ssh host '...'` string. Tell it to put remote steps in a script file on
  the remote host and call the script.
- To let an agent reach a host only as one account, keep every command
  that names the host's address denied and give the agent a small local
  wrapper script that always logs in as that account. An allow rule is not
  enough: in Grok's configuration a matching deny wins over an allow.
- Do not start a Claude Code shell with its working directory inside a
  tree that will be hashed or frozen: the harness may leave empty
  `.claude/.cc-writes` directories there. Check for and remove them before
  a freeze.
- Give exact values you already know (paths, sizes, SHA-256, IDs) in a table
  and ask it to re-verify them rather than derive them; let it derive only
  what needs a run it performs.
- Cap retries of any step that depends on an outside service, give a start
  condition (for example several consecutive healthy probes), and require
  cleanup of each failed run's scratch before the next one. On 2026-10-13
  opencode reran a flaky-network rehearsal five times back to back and left
  about 4 GiB of failure scratch on a shared host's root disk.
- Copy the environment of the last passing run of the same test kind into
  the brief, variable by variable, from that run's script rather than from
  memory. On 2026-10-15 a brief for one integration test file gave the
  scratch variables but not the two that point the tests at a prepared
  runtime package; every run on the test host failed before reaching the
  test, and the batch had to move hosts.
- When the work is a bug fix, order the steps as: change the test, run it
  and keep the failing output, change production code, rerun.
- Never let two batches that run at the same time edit or test the same
  directory. Give each batch its own copy, and after both pass run one
  combined check on the merged tree. On 2026-10-13 one batch copied a shared
  packet to the test host while another batch was still editing it; the
  first batch's full run failed on the second batch's half-written file and
  needed a rerun after both stopped.

## Preventing rework

Do not assume the delegated model is as capable as Claude. On 2026-10-12
and 2026-10-13 Claude sent 13 rulings on opencode stop files. About half
of the rework traced back to the brief: a wrong step, two batches editing
one packet, a missing read of the target's current state, one instance of
a defect class fixed per round, and a brief that let opencode pick the
layer to fix. The other half fell into four recurring opencode errors:
suppressing a symptom instead of fixing its cause, a test whose expected
value came from the code under test or whose environment merged two things
that differ in production, ignoring written procedure rules, and reporting
a result it had not checked. Long briefs make the third worse: the model
keeps the main task and drops peripheral rules.

Before writing the brief:

- Search the whole tree or packet for every instance of the defect class
  and list them all in the brief. On 2026-10-13 two identical leftover
  `db status` calls in one script were found and fixed in two separate
  rounds.
  The same applies when a delegated plan names a defect found in passing:
  search again before approving it. On 2026-10-14 a plan fixed a
  probe-then-release port race in one test and missed the same helper in
  the shared product-path harness.
- List what differs between production and the test (accounts, umask,
  whether the service is running, separate release directories) and
  require the fixture to keep each difference. A directory created under
  `umask 077` by root and read by a service account passed a fixture that
  ran everything as one account.
- Read the target's current state before briefing a tool that acts on it.
- Trace the change down to the code that finally enforces it before fixing
  the design in the brief. On 2026-10-13 a brief ordered a policy rule to
  return ALLOW, but the sandbox later demands a real Grant plus an approved
  approval, so the design could not work; opencode's plan stop caught it.
  The next brief, written after reading the sandbox's read allowlist, named
  the single line to change and the two look-alike lines that must stay.
- Look for an existing precedent in the codebase that already solves the
  same shape of problem, and point the brief at it rather than inventing a
  new mechanism.
- Before ruling a product fix in a reply or a steer, follow the new value
  through every check and consumer: search the tree for the field or
  reason code and read each validator that sees it. On 2026-10-15 Claude
  ruled that a command whose host reported contradictory exit codes should
  record its effect as `not_asserted`; the facts contract accepts that
  effect only after a normal exit, so the Worker threw, and a recovery path
  rebuilt the call as a success. Two product-path rounds went to a fix
  that could not work; reading the contract's effect checks, and the
  deadline failure that already solved the same shape, took ten minutes.
- Check that every instruction can run under the deny list. A brief told
  opencode to `git commit --amend` while the deny list blocked it.
- Before writing a stop condition ("if X, stop and ask"), look for a
  project rule that already decides X: a spec paragraph, a decision record,
  an earlier change of the same shape. On 2026-10-14 a brief told Grok to
  stop if a new error code would be stored and later read back with a
  strict enum; the project spec had already settled that case for a larger
  change to the same schema, so the stop cost a round trip and a ruling
  that only quoted the spec.

In the brief:

- Name the forbidden fixes as well as the goal, for example "do not
  swallow errors by HTTP status in the client". A brief that allowed a fix
  "in the client, or in the server if the cause is there" got a client-side
  catch-all that hid real failures.
- For any change whose cause could sit in more than one layer, or that
  touches authorization, sandboxing, path checks or stored data, make the
  first stop a plan file: no edits and no test runs, only the root cause
  with evidence, the chosen layer with `file:line`, the alternatives it
  rejected and why, and the test list with each expected value and its
  source. Reviewing a plan takes minutes; a wrong direction costs a full
  test cycle on the test host. Skip this step for mechanical edits, and
  for small test-only fixes whose approach the brief can state outright
  (for example "bind port 0 and read the bound port instead of probing a
  free port first"); review of the diff catches the rest. The user
  approved this on 2026-10-14 to save one round trip per item.
- A plan that rests on an operating-system or runtime fact (what a flag
  does, what a library call can do) must either show a small probe on the
  test host or mark the fact as unverified. Before approving, probe the
  facts the design depends on yourself. 2026-10-14: a read-only plan
  asserted a Linux flag that does not exist and proposed a new native
  helper; a 5-minute probe on the test host showed plain Node could do the
  same job, which removed the helper and a packaging change.
- Require an expected-value source table in the final stop file (each new
  assertion, its expected value, and where that value comes from: a
  decision record, a spec paragraph, another component's `file:line`, a
  real readback). Return a stop file without it.
- Require every number in a stop file (passes, errors, free space) to come
  with the command that produced it and the output path.
- Keep a batch to one item and about two hours of work.

After a rule is broken twice, stop repeating it in prose: turn it into a
deny pattern or a check that fails on its own. Patterns added on
2026-10-13 after repeat violations: `deno *`, `tsc *`, `*git gc*`,
`*reflog expire*`.

## Reviewing

Every line of code is reviewed by the side that did not write it: Claude
reviews every opencode change itself, line by line, before accepting it, and
opencode reviews every line Claude writes (see
[references/consult-and-cross-review.md](references/consult-and-cross-review.md#opencode-reviewing-claudes-code)).
An author's review of their own code never counts as the review. Do not
delegate the review of opencode's change back to opencode or to the same
model. When one change mixes both authors' lines, split it by author and
have each part reviewed by the other side.

- Read the full diff of every commit or working-tree change; compare it with
  the brief. Anything outside the brief's files is drift until explained.
- Read the JSONL for every shell command opencode ran: confirm no command
  touched a forbidden host or ran tests where they must not run, and that
  claimed test runs really happened on the stated revision.
- Rerun the cheapest discriminating check yourself. Count assertions in test
  reports rather than trusting a summary line.
- Redo every hash-based or count-based check on a clean copy of the
  commit (`git archive HEAD | tar -x -C <new temp dir>`), never in the
  working tree: untracked files such as `.DS_Store` change directory
  hashes. On 2026-10-13 opencode reported documentation errors "down from
  6 to 2" from a working tree; a clean checkout went from 2 to 4, because
  it had resealed Runbooks with `.DS_Store` files inside their directory
  sources. Guard the temp directory: `d=$(mktemp -d ...); [ -d "$d" ] ||
  exit 1`. The same day a failed `mktemp` left `$d` empty and turned an
  `rsync` target into `/`; only the sandbox stopped it.
- Check that a new assertion gives the same result on every host the
  suite runs on. On 2026-10-14 a policy-drift test compared worker counts
  computed from the CPU count: it failed as intended on the 4-core test
  host and would have passed silently on an 8-core machine.
- Before approving the deletion of a test file or a registration, look
  for a backlog item or rule that explains why such files are kept. The
  same day a plan proposed deleting a registered child fixture that the
  accepted CI policy still requires to exist.
- Check that expected values were derived from requirements, that no
  assertion was weakened, and that no check was skipped to get a pass.
  A fixture that builds its "real world" input from the constants of the
  code under test only proves the code agrees with itself. Require literal
  values taken from the real contract (a captured report, the message string
  in the other component's source), plus a check that reads the other
  component and fails when the two drift. On 2026-10-13 a publisher's
  expected failure code had an extra word, and its fixture, which reused
  that constant, still passed; only line-by-line review caught it.
- A failure the agent calls pre-existing or environmental counts as such
  only when the same test files fail the same way on the base revision.
  Ask for that run and for both logs in the evidence directory. On
  2026-10-15 opencode called five unit failures pre-existing after their
  log had been deleted. A timeout is a defect to diagnose, not environment.
- A base-revision comparison counts only when both sides run the same way:
  dependencies installed from the base revision's own lockfile (compare the
  lockfile digests), the same command and environment, and each side run
  alone. On 2026-10-15 a base checkout borrowed `node_modules` from another
  checkout whose lockfile differed, while the failing cases exercised one
  of the packages that differ.
- A test that passes alone and fails in a group is not a flake to rerun.
  Name the timing it depends on, then reproduce deterministically by
  pushing that timing past its threshold once. On 2026-10-15 a
  contradiction case passed three times alone and failed once in a group;
  a fixture held the host's final message about 3.7 seconds there against
  0.6 alone, and the product ends a host 5 seconds after its early
  completion report. One run with a 7-second hold reproduced the failure
  and showed the held message was never sent: the fixture had turned the
  case into the host-crash case, which the product handled as designed.
- A fixture that delays or holds a message must stay inside the product's
  own timers (cleanup, force-kill, deadlines); find them before accepting
  the hold, or the test checks a different scenario than its name.
- Check that a test's input is a record the product can actually write.
  On 2026-10-15 a projection test gave a fixed read an `unknown` effect,
  which the Worker never records for fixed reads. When a parametrized test
  already covers the same rule, add a case to it instead of a parallel
  block; the existing negative cases then cover the new case too.
- Diff the touched tree against a baseline copy you took before launch
  (for files outside version control), not only against git.
- Record the outcome: `longtask.py record --review --items <ids> --verdict
  approved|rejected --files <reviewed files> --by claude`. `--by` names the
  reviewer, never the author: an item whose code Claude wrote is recorded
  `--by opencode` after opencode's review, with its review stop file in
  `--note`.

## Handling a stop file

1. Read the summary table, run `longtask.py status`, and check that the
   evidence IDs listed exist and agree with the claims.
   Then list the test processes on the test host: on 2026-10-13 a stop file
   arrived three minutes into an `npm test` that opencode had started, said
   the run's output directory had been deleted while that test was still
   writing to it, and pointed to a missing appendix for the result. Wait for
   such a test to finish and read its result yourself before ruling.
2. Verify each claim the ruling depends on: confirmed, partially confirmed,
   rejected or uncertain, with the code location or evidence path.
3. Rule within [Authority](#authority) and write the reply from
   [templates/reply.md](templates/reply.md), with conditions concrete enough
   to check at the next review.
4. Resume the same session with the reply, or start a new session for the
   next batch.

## Authority

Claude decides alone: design choices inside the task's scope, approving or
rejecting opencode's proposals, rework, restarting opencode, test
environments opencode created, deleting rebuildable artifacts the task
created after checking they are not evidence.

Ask the user first: new downloads or dependencies, deleting user-owned
files, production or other remote operations the project reserves, push,
branch or PR rules beyond the project's standing ones, product decisions,
relaxing checks or timeouts, account settings, and anything the project's
instructions reserve for the user. Production steps are never delegated.

## Known pitfalls

- 2026-10-12, opencode 2.0.27: a Go-plan model failed with
  `provider.invalid-request` "This Go model requires Global regions"; the
  user's workspace privacy setting must allow Global regions. This is an
  account setting: ask the user to change it, do not try another model
  without asking.
- 2026-10-12: through the shared background service the same failure
  produced no output at all; the task server used since 2026-10-15 reports
  it at once (see [Launching and resuming](#launching-and-resuming)).
- 2026-10-12: `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT` were ignored;
  only the project file plus `opencode reload` showed up in
  `opencode debug config`.
- 2026-10-12: the shell tool is named `shell` in JSON events
  (`part.tool`); `bash` permission rules still govern it.
- 2026-10-12: one `--standalone` launch hung for 180 seconds without ever
  creating a session, and the identical relaunch worked. Treat a launch with
  no session event after the startup timeout as a stall, kill it and
  relaunch once; [scripts/oc-launch.sh](scripts/oc-launch.sh) does this
  check.
- 2026-10-14, opencode 2.0.27: a manual `opencode run` from a shell whose
  standard input stayed open waited for that input and printed nothing,
  with or without `--standalone`. Close it (`< /dev/null`) on every manual
  run. `oc-launch.sh` runs opencode in the background, which gives it an
  empty input; a test keeps it that way.
- 2026-10-17, opencode 2.0.32: in the middle of a review run a
  `provider.transport` error event ("Connection lost while reading the
  response: ECONNRESET") did not end the run. opencode retried the step,
  went on for 24 more events, and wrote a complete stop file, yet the
  process still exited with code 1. Neither the error event nor the exit
  code alone decides whether a run failed; read what follows the error and
  the stop file.
- 2026-10-18: a fourth run ended its turn while its host test job was still
  going, and the auto-resume above did not catch it. Its stop file was
  written in advance with sections reading `（运行中；结果…待补。）`,
  `（待补：…）` and `（待补。）`; the placeholder pattern then knew only
  `待填写` and `待补充`, so `oc-run.sh` took the file as finished, and the
  job's result sat unread for 18 minutes. The pattern now also catches a
  bare `待补` or `待填` in a slot position, and a test reproduces this stop
  file. A run of the new pattern over 305 earlier stop files from one
  project flagged only this file and one draft that was meant to be
  unfinished; mentions inside prose, such as `本次待补的两个保证`, still
  pass. When a run's stop file uses another way to say "not yet", add it to
  `PLACEHOLDER` in [scripts/stop-file.py](scripts/stop-file.py) with a test.
- 2026-10-20: a brief that only asked opencode to read code and write a
  report was refused by `check-brief`, because every brief had to name a
  long-task item; four read-only review sessions then ran from a copy of
  the launcher with the check removed. The `只读任务：是` line now gives
  such briefs a proper way through (see
  [Launching and resuming](#launching-and-resuming)).
- 2026-10-22: during a review run in another real project,
  `opencode/deepseek-v4.1-flash-free#high` kept sending text parts that held
  only a zero-width space (U+200B). Python's `strip()` does not remove it,
  so `oc-watch.py` printed a bare `SAYS:` line for each one and woke Claude
  more than a dozen times with nothing to act on; the user saw Claude
  spinning. That run's event stream had 42 such parts out of 44 text parts.
  `oc-watch.py` now prints `SAYS` only when a line still has text after
  removing whitespace and U+200B, U+200C, U+200D, U+2060 and U+FEFF; the text
  it prints is unchanged. A test feeds it zero-width-only, mixed and plain
  text, and a replay of that stream dropped the 42 empty lines and left
  every other line the same.
- 2026-10-23, opencode 2.0.32: the same account started three free
  models in about 40 seconds via `oc-launch.sh new`:
  `opencode/deepseek-v4.1-flash-free#high`,
  `opencode/glm-5.3-flash-free#high` and
  `opencode/mimo-v2.6-flash-free`. Each session's first event was the same
  error:
  `{"type":"error",...,"error":{"type":"provider.quota","message":"Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go","status":429,...}}`
  The response body names the error type `FreeUsageLimitError`.
  `oc-launch.sh` prints `first events contain an error:` and that line
  within about a second, then exits with code 4; in `<prefix>.rc`
  opencode's own exit code is 1. All three failed the same way, so the
  free quota is shared by the whole account, not per model: when one
  free model reports `provider.quota` or `FreeUsageLimitError`, do not
  retry on another free model; stop and tell the user. Whether to switch
  to a paid model or hand the work to another agent is the user's call
  (using a paid model needs the user's approval first anyway, see
  [Authority](#authority)).
- Observed cost, for planning: a 14-minute batch with about 40 tool calls on
  `deepseek-v4.1-flash` cost about USD 0.10, mostly cached input.
