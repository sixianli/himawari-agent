# Incidents Get Automatic Gates

The user decided on 2026-10-29 ([ADR 0107](../../docs/adr/0107-every-incident-gets-an-automatic-gate.md), superseding ADR 0060) that every incident must end in an automatic check, and that a mistake seen three times must be blocked by a hard gate. Cloud threads load this file, so this is how every session reaches the rule. It applies in fast mode and in full mode.

## When a Thread Starts

Read [docs/incidents-and-gates.md](../../docs/incidents-and-gates.md). If the work touches an area with an open entry (state `缺门槛` or `等 Andy`), say so in the plan.

## What Counts

- An incident is a production failure, a failed or rolled-back release, a problem blocked only late in packet generation, or a defect the user found that a check could have caught.
- A gate is a check that runs on its own and blocks when it fails: a `deploy.sh` preflight, a packet check (`run-packet-checks.py`, `make-packet.py` refusals), a test, a step of `npm run check`, a commit or push hook, or a script that checks itself on every use. A document, casebook case, memory note, or reminder is not a gate.
- An incident is closed only when its gate exists and is shown to fail on a reproduction of the incident and pass once the cause is removed. Record that evidence in the commit message.
- The third occurrence of the same mistake, whether an incident or an agent's own error, needs a hard gate before work on that mistake resumes. When only the user can make the change, prepare it, ask once with the concrete proposal, and mark the entry `等 Andy`.

## Keeping the List

- Each row: id, date (JST), symptom, root cause, occurrence count, gate (files in backticks, or the command), state. States: `已落门槛`, `缺门槛`, `等 Andy`, `仓库外` (the cause is outside this repository, with the substitute practice written down).
- Add a row for a new incident; for a repeat, raise the count and extend the row instead of adding one.
- `npm run check:incident-gates` (part of `npm run check`) refuses a closed row whose gate file does not exist, a row with a count of 3 or more that has no hard gate, and malformed rows.
- Agent mistakes keep their detailed history in `docs/lessons.md`; add a row here only when such a mistake caused an incident.

## Delivery Reports

Name each incident the thread handled, the gate added (file or command) or why no gate was needed, and the list row updated.
