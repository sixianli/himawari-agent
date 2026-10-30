# Runbook Governance and Execution Workflow

Use this reference whenever creating, reconciling, sealing, checking, using,
snapshotting, superseding, or retiring a Runbook. A Runbook is an operational
contract, not an authorization token.

## Trust Model

An active Runbook is usable only after it proves both of these facts for the
current execution:

1. its static repository contract matches the current Runbook and repository
   sources; and
2. a fresh, target-read-only Live-State Preflight matches its safety
   assumptions.

`status: active` is necessary but is never sufficient. A passing static check
does not prove live applicability and does not authorize production, deletion,
restore, migration, paid calls, provider/model changes, identity changes, or
any other external mutation.

Runbooks do not use `last_reviewed`, `review_after`, periodic review windows,
or refreshed dates as a trust signal. The common `date` field is document
metadata only. Idea and Backlog review fields are a separate workflow and are
not affected by this rule.

## Active Contract

Every active Runbook under `docs/runbooks/` must set `execution_risk` to one
of `standard`, `high`, or `critical`. For example, a production Runbook uses:

```yaml
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:<64 lowercase hex characters>"
```

It must contain exactly one contract selector outside fenced code:

```markdown
<!-- runbook-contract:
- infra/production/release.sh
- infra/production/docker-compose.yml
- apps/api/src/example
-->
```

It must contain exactly one of each of these ten required level-two headings:

- `Scope`
- `Authoritative Sources`
- `Safety and Preconditions`
- `Live-State Preflight`
- `Procedure`
- `Verification`
- `Evidence`
- `Rollback`
- `Stop Conditions`
- `Troubleshooting`

The validator proves structure, not operational correctness. Reconcile the
meaning against current code, configuration, tests, protected inputs, and live
readback before sealing or execution.

## Execution Risk Is a Protection Floor

`execution_risk` describes the highest plausible consequence of the written
mutation steps, not document quality:

| Value | Typical consequences | Mutation gate |
| --- | --- | --- |
| `critical` | production, deletion/restore, migration, identity or security boundaries, real secrets, paid model/provider changes, release pointers, shared hosts | Target-read-only preflight may run first. Immediately before the first target mutation, report the exact target, action, risk, cost, and side effects and obtain explicit authorization for that action. |
| `high` | staging, shared infrastructure, or other non-production external side effects | Require authorization that accurately covers the target and action, fresh preflight, isolated evidence, rollback, and stop conditions. Do not repeat a confirmation when the current request already covers them precisely. |
| `standard` | local, read-only, or directly recoverable work | Still run the static check and applicable preflight. A current explicit request can cover local recoverable writes. |

The effective risk is the highest of the declared value, the actual commands
and effects, and the target identified by live preflight. Unknown or unreliable
classification is `critical`. A declaration can only raise protection; it can
never lower risk inferred from commands or the target.

Static tools validate only the declared field. At execution time the agent must
apply the higher actual risk. For a target-read-only preflight, no target
mutation authorization is requested merely because the Runbook is critical.
At the mutation boundary, critical work always requires immediate, action- and
target-specific authorization.

`runbook.py check` does not infer risk from shell commands, prose, or a live
target, and a successful static check must never be treated as a risk decision.
Before any mutation, the executing agent must independently classify the actual
commands and effects plus the target discovered by preflight. It then applies
the highest of those classifications and the declared floor through the
authorization policy below. If any classification is unknown or unreliable,
use `critical`.

The mutation boundary is the first action that changes the governed target,
external system, data, permissions, billing, provider/model identity, or
runtime state. Writing bounded, redacted preflight records into an already
approved, protected, per-run evidence directory is evidence bookkeeping, not a
target mutation. It must remain isolated and must not change the governed
target.

## Versioned Static Fingerprint

`scripts/runbook.py` owns fingerprint version 1. Implementations that mirror it
must use this exact algorithm and a shared fixed test vector:

1. Start SHA-256 with the ASCII domain bytes
   `document-governance/runbook-contract/v1` followed by one NUL byte.
2. Normalize Runbook CRLF and CR newlines to LF. Replace only the unique
   `contract_sha256` field in the opening frontmatter with
   `contract_sha256: "sha256:<runbook-contract>"`. Body text that happens to
   mention the field name is not replaced.
3. Feed the Runbook record, then contract records sorted by UTF-8 POSIX path
   and object type. Each record contains path, type, executable flag, and
   payload. Each field is framed as an unsigned eight-byte big-endian length
   followed by the raw bytes.
4. Types are `runbook`, `directory`, `file`, and `symlink`. The executable flag
   is ASCII `1` when any `0o111` bit is set, otherwise ASCII `0`. File payloads
   are raw bytes. Directory payloads are empty. Symlink payloads are the raw
   UTF-8 link-target string; symlinks are not traversed. A change to the link
   target therefore invalidates the seal; target content must be selected
   separately when it is authoritative.
5. A selected directory includes itself and every safe descendant in
   deterministic order. Safe additions, deletions, renames, contents, object
   types, and executable-bit changes affect the digest. Overlapping selectors
   are deduplicated by normalized path and type.
6. When the project root is inside a Git work tree, a descendant counts only
   when `git ls-files --cached --others --exclude-standard` lists it (tracked,
   or untracked and not ignored) or when it is a directory above such a file.
   Ignored files, ignored directories, and empty directories are skipped, so a
   work tree with local leftovers hashes exactly like a copy of the listed
   files. Local ignore rules (`.git/info/exclude`, `core.excludesFile`) count
   too; they decide only about untracked files, which exist in that one work
   tree alone. Outside a Git work tree every safe descendant counts. A project
   root that the enclosing repository ignores, such as a copy made below an
   ignored output directory, holds nothing that repository tracks, so it is
   treated as outside Git, also when only a local rule
   (`.git/info/exclude`, `core.excludesFile`) ignores it; once the repository
   tracks files below it, the Git rule applies again. A clean checkout selects the same records under both
   rules, so the fixed test vector and seals made from clean checkouts stay
   valid under version 1.
   Variables inherited from a hook or a parent Git command that change where
   Git looks, which configuration applies, or how paths match in this one
   call are not used: `GIT_DIR` and the other location variables,
   `GIT_CEILING_DIRECTORIES`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT` with
   its `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`, and
   `GIT_GLOB_PATHSPECS`, `GIT_ICASE_PATHSPECS`, `GIT_LITERAL_PATHSPECS`, and
   `GIT_NOGLOB_PATHSPECS`. The project root alone decides which repository
   applies. In a Git work tree the contract is rejected when a clean checkout
   could not reproduce it or the digest would silently miss files:
   - a selector is ignored by Git, or a selected directory holds no listed
     file in the work tree;
   - Git lists one entry where the work tree holds a directory: a submodule
     or nested repository below a selector, whose files Git does not list, or
     a tracked file replaced by a directory;
   - Git lists a path that exists on disk only under another spelling, because
     letter case or Unicode normalization differs between the disk and the
     index.
   When the project root or one of its parent directories holds a `.git`
   entry but Git is missing or cannot inspect the repository, the contract
   fails instead of falling back to the rule for directories outside Git.
   This includes an empty or stale `.git` entry that Git itself ignores; the
   error names the entry so it can be repaired or removed.

Selectors must be repository-relative POSIX paths. Reject absolute paths,
Windows drive syntax, backslashes, `..`, missing paths, the repository root,
unsupported object types, broken links, and links that resolve outside the
repository.

Real secrets and credentials are rejected, including `.env`, non-example
`.env.*`, private-key formats, common private-key names, and explicit
credentials/secrets JSON files. `.env.example`, `.env.sample`, and
`.env.template` are allowed. VCS metadata, evidence roots, build output, and
caches cannot be selected. When a known cache, build, VCS, or evidence-named
subtree occurs below an otherwise safe selected source directory, traversal
skips it deterministically. Fixed host metadata such as `.DS_Store` is skipped
by the same rule. A real secret found elsewhere inside the selected
directory fails the whole contract rather than being silently omitted. This
includes a secret that Git ignores: files skipped under rule 6 are checked by
name only and never read.

The fingerprint excludes mtime, the current date, and unrelated Git commits.
It cannot cover external services or live target state; Live-State Preflight
owns that proof.

## Reconciliation and Seal

Reconcile and reseal only after an event that can change operational truth:

- create or materially edit a Runbook;
- change the Runbook or a selected contract source;
- find a static fingerprint mismatch;
- find live identity, version, configuration, or safety assumptions that do
  not match;
- change an external contract that cannot be fingerprinted;
- learn from a failure, incident, stop, or rollback that the procedure is
  incomplete.

Inspect the relevant diff and current facts, correct the Runbook, and run the
relevant tests before sealing. Then run:

```text
runbook.py seal ROOT RUNBOOK
runbook.py seal ROOT RUNBOOK --confirm-reconciled --apply
runbook.py check ROOT RUNBOOK
```

The first command is dry-run. Writing requires both confirmation and `--apply`
and changes only `contract_sha256`. There is no force, renewal, review-date, or
automatic validator write path. Sealing attests that semantic reconciliation
was performed; computing a hash alone cannot prove that work happened.

## Per-Execution Gate

For every actual use, in this order:

1. Confirm the entry is under `docs/runbooks/` and has `status: active`. If the
   supplied entry is archived or superseded, stop. When it names exactly one
   repository-valid `superseded_by` candidate, report that candidate as the
   possible active entry, but never follow or execute it automatically; a user
   who chooses it must begin again at gate 1.
2. Run `runbook.py check ROOT RUNBOOK` and stop on every finding.
3. Read the current Git HEAD, worktree state, selected sources, and protected
   configuration. Do not reuse a cached conclusion from another task.
4. Run only the target-read-only `Live-State Preflight`. Read back the exact
   host/environment, account, workspace/tenant, privileges, deployed version
   or image digest, release/source identity, configuration, model/provider,
   mounts, network and resources, backups, locks, health, protections, and
   rollback prerequisites that apply.
5. Stop if access is unavailable, evidence is incomplete, identity is
   ambiguous, or any readback conflicts with the Runbook.
6. Compute effective risk from declaration, commands/effects, and live target.
   Report the exact target, action, risk, cost, and side effects. Apply the
   corresponding mutation authorization gate.
7. Execute bounded steps without silently changing provider, widening scope,
   or bypassing a stop condition.
8. Verify the result and close the isolated evidence record.

If the Runbook, sources, worktree, or live target changes after its gate, rerun
the affected gate. Archived and superseded Runbooks are historical evidence
and are never executable.

## Evidence, Stop, and Rollback

The `Evidence` section defines a project-approved protected evidence root and
a unique run ID. Critical and high executions use a new isolated directory;
never reuse a prior run. If the project does not provide an approved root,
fail closed rather than inventing a personal host path.

Preserve redacted static-check results, target identity and preflight, actual
commands and exit status, verification, stop/rollback state, and final
conclusion. Do not record tokens, passwords, private keys, raw environment
files, or unredacted secret-bearing command output. Raw evidence does not
belong in a Runbook, Idea, Backlog, `docs/lessons.md`, or chat. Chat reports
only the necessary conclusion and protected evidence path.

Every Runbook names conditions that stop execution before further attempts and
defines bounded rollback prerequisites and verification. Do not promise a
rollback that has not been proven available by live readback.

## Snapshot, Supersession, and Retirement

`docs/runbooks/` contains only active stable entry paths.
`docs/archive/runbooks/` contains `status: archived` history. New archive files
are dated; unique legacy undated files remain readable for compatibility.

Use only these mutually exclusive archive operations:

```text
archive_doc.py ROOT RUNBOOK --snapshot --archive-date YYYY-MM-DD [--dry-run]
archive_doc.py ROOT RUNBOOK --superseded-by ACTIVE_PATH --archive-date YYYY-MM-DD [--dry-run]
archive_doc.py ROOT RUNBOOK --retire --reason TEXT --archive-date YYYY-MM-DD [--dry-run]
```

- Snapshot copies the current stable entry to a dated archive, makes that
  archive its direct predecessor, and keeps the stable path active for the
  forthcoming major revision.
- Supersession moves the old Runbook to archive and adds reciprocal lineage to
  a distinct active successor.
- Retirement moves it to archive with a one-line `archive_reason` and no
  successor.

The tool validates every path, lifecycle, target, conflict, and existing
reverse link before writing. It uses same-directory atomic file replacement
plus compensating restoration for ordinary process-level failures; multiple
filesystem writes cannot provide database-level crash atomicity.

Snapshot and successor modes change an active Runbook's frontmatter and thus
invalidate its seal. The archive tool never reseals it. Reconcile the active
Runbook and explicitly seal it before any execution. Existing archives are not
recomputed against current sources.
