---
status: active
document_type: runbook
execution_risk: standard
contract_sha256: "sha256:<64-hex>"
supersedes: ""
superseded_by: ""
date: "2026-08-23"
---

# Contract Vector Runbook

<!-- runbook-contract:
- contract
-->

## Scope

Fixed cross-implementation fingerprint fixture.

## Authoritative Sources

The `contract/` fixture directory.

## Safety and Preconditions

Fixture only; no external effects.

## Live-State Preflight

Confirm this is an isolated test directory.

## Procedure

1. Calculate the static fingerprint.

## Verification

Compare with the committed expected digest.

## Evidence

Test process output only; no secrets.

## Rollback

Delete the disposable fixture copy.

## Stop Conditions

Stop on any unexpected file.

## Troubleshooting

Recreate the fixture from committed bytes.
