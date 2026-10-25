# Consulting opencode and cross-review

Read this whenever Claude writes code itself: before Claude settles a design
or a fix, and before Claude runs, freezes or commits code it wrote. The rule
is symmetric: code is reviewed only by the side that did not write it, so
Claude's code always gets opencode's review, as opencode's code always gets
Claude's. Skip it only when opencode implements every line of the change.

## Contents

- [When to consult](#when-to-consult)
- [Asking for an independent proposal](#asking-for-an-independent-proposal)
- [Comparing the two proposals](#comparing-the-two-proposals)
- [opencode reviewing Claude's code](#opencode-reviewing-claudes-code)
- [When to bring it to the user](#when-to-bring-it-to-the-user)

## When to consult

Consult on a design or fix for a protocol between processes, an interface
several modules share, a complex core module, or a defect whose cause is
still unknown. Do not consult on a mechanical edit whose change is already
clear; the round trip costs more than it finds.

## Asking for an independent proposal

1. Write Claude's own proposal to a file first, before reading anything
   opencode writes. Reading the other model's answer first anchors the
   comparison, and the point is two independent attempts. Keep that file
   where opencode cannot read it (Claude's scratchpad, not the handoff
   directory or the repository) until its stop file arrives, then copy it
   to the handoff directory for the record. Tests or code Claude writes
   in the shared working tree while the consult runs are visible too, so
   start the consult first, and say in the comparison what the agent
   could have seen. On 2026-10-17 a proposal left in the handoff
   directory was read by the consulted session, whose stop file said so,
   and the agreement between the two no longer counted as independent.
2. Start a new session with the project's model rules and the higher
   reasoning variant. The brief gives the problem, the observed evidence
   with paths, the constraints and invariants that must hold, the files
   to read, and the acceptance tests. It does not include Claude's
   proposal or preferred direction.
3. Ask for: the root cause or the design goal in its own words; two or
   three options with what each changes, how each can fail, and what
   would show it failing; the recommended option and why; facts it relied
   on, each marked probed (with the command and output path) or
   unverified; and the tests that would prove the result.
4. Forbid edits to tracked files, commits and pushes; the only file it
   writes is its stop file. Read-only probes on the test host follow the
   usual brief rules.

## Comparing the two proposals

- List where the two agree, where they differ, and what each missed.
  Agreement is not proof: check every claim both rely on against the code
  or a probe.
- Settle each disagreement with the smallest check that tells the two
  apart (a code reference, a probe on the test host, a failing test), not
  by preference.
- Take the best parts of either. Record in the plan or the commit message
  which ideas came from which proposal, which were rejected, and the
  evidence that decided it. Copy opencode's stop file into the task's
  handoff directory so the comparison can be checked later.

## opencode reviewing Claude's code

- Before committing code Claude wrote, start a review session: give the
  commit range or a patch file with its SHA-256, the requirement and the
  tests that ran. Ask for findings only, each with `file:line`, the inputs
  that trigger it, the wrong result, and a suggested check; no edits.
- Code that is never committed needs the same review before it runs or is
  frozen: operation packet tools, entry scripts that reach a production
  host, one-off scripts on a test host. List each file with its SHA-256 and
  the version it was derived from, and ask the reviewer to diff the two;
  a script that "only renames" an approved one is still reviewed, because a
  copied script also carries the old version's data and wording. On
  2026-10-18 a renamed packet still held the previous deployment's real
  readbacks and a sentence claiming the old approval applied.
- Claude's own reading of its code is not the review. When opencode's
  review session cannot run (every allowed model rate-limited or out of
  allowance), keep the code unrun and uncommitted and say so in the
  handoff; do not substitute a self-review.
- A design proposal session may not review the code built from its own
  proposal; start a new session for the review.
- Treat each finding as a hypothesis. Confirm it with a reading of the
  code or a reproducing test before changing anything; record rejected
  findings with the reason.
- When the change adds or tightens a check, ask the reviewer to state, for
  each place the check runs, whether an effect (a file write, a commit, a
  sent message) has already happened by then. A check that fires after the
  effect turns a refusal into "done but reported as failed". On 2026-10-17
  a reviewer listed exactly that case as a mere suggestion, because it did
  not follow the call order across two functions; the severity a reviewer
  gives is a hypothesis too.
- Fixes Claude makes after the review follow the usual test layers. A
  change large enough to alter the design goes back for a second review.

## When to bring it to the user

Bring a technical question to the user only when the two proposals still
conflict after the discriminating checks, or when the choice changes the
product, an external interface, or the agreed scope. Give the options, the
evidence for each and a recommendation. Decisions that need the user's
authorization anyway (production steps, downloads, reducing evidence,
system changes) are collected and asked together once.
