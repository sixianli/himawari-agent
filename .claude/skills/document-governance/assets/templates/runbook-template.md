---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:<64-hex>"
supersedes: ""
superseded_by: ""
date: "YYYY-MM-DD"
---

# Runbook Title

<!-- runbook-contract:
- <repo-relative-authoritative-path>
-->

## Scope

Define the exact operation, targets, environments, and exclusions.

## Authoritative Sources

List the repository contracts and protected configuration readbacks that
govern this procedure. Use the governed SOURCE syntax for authoritative
document references after replacing its path with a real project document.

## Safety and Preconditions

- State required access, backups, locks, protections, cost boundaries, and
  rollback prerequisites.
- State the first target mutation and its authorization requirement.

## Live-State Preflight

List target-read-only commands that read back the exact host/environment,
identity, deployed source/version, configuration, provider/model, mounts,
health, protections, and rollback prerequisites. Stop on any mismatch. Do not
print secret values.

## Procedure

1. Run the static Runbook check and current Git/worktree readback.
2. Complete target-read-only preflight and determine effective risk.
3. At the required mutation boundary, report the exact target, action, risk,
   cost, and side effects and obtain the required authorization.
4. Execute bounded mutation steps without widening scope.

## Verification

Define observable success criteria and commands that prove the final target
state without relying only on command exit status.

## Evidence

Require a project-approved protected evidence root and a unique per-run ID.
Record redacted static check, preflight, commands and exit status, verification,
stop/rollback state, and conclusion. Fail closed if no approved root exists.
Never record secrets or raw secret-bearing configuration.

## Rollback

Define the exact rollback trigger, prerequisites, bounded steps, and
post-rollback verification. Do not promise an unavailable rollback.

## Stop Conditions

- Stop on static mismatch, ambiguous target, failed readback, missing
  protection, missing evidence root, unexpected cost, or scope change.
- Stop instead of automatically changing provider, target, or recovery scope.

## Troubleshooting

| Symptom | Safe diagnosis | Stop or bounded remediation |
| --- | --- | --- |
| Example | Target-read-only check | Stop and reconcile before retrying |
