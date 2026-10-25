# Grok models

Read this file only when a batch runs, or is about to run, on a Grok model.
It adds what differs for Grok; the whole procedure stays in
[SKILL.md](../SKILL.md).

Improve this file during the work: when a Grok batch shows something new,
add it to [Known pitfalls](#known-pitfalls) with its date, opencode version
and evidence, and change the procedure when the pitfall shows it was wrong.
Facts measured once can change with a new opencode or xAI release; re-check
them when the version changes.

## Contents

- [Which models are allowed](#which-models-are-allowed)
- [Assigning batches between models](#assigning-batches-between-models)
- [Login and first check](#login-and-first-check)
- [Model facts](#model-facts)
- [Launching](#launching)
- [Usage limits](#usage-limits)
- [Trial batches and comparison](#trial-batches-and-comparison)
- [Known pitfalls](#known-pitfalls)

Two routes exist. Through opencode's `xai/` provider, follow this file
as written. Through the Claude Code Grok Build plugin, also read
[grok-plugin.md](grok-plugin.md) for setup, launching and waiting; there
[Login and first check](#login-and-first-check) and
[Launching](#launching) below do not apply. Use the route the project's
instructions name.

## Which models are allowed

Use only models of the `xai/` provider, which opencode reaches through the
user's own subscription login. Grok models resold by other providers (for
example `opencode-go/grok-*` or `opencode/grok-*`) are billed to a different
account; the user may forbid them, and a project's instructions say so when
they do. Never fall back to a resold Grok model when `xai/` fails; stop and
report instead.

Enforce this in two places:

1. Launch and resume only through [scripts/grok-launch.sh](../scripts/grok-launch.sh),
   which refuses every model that does not start with `xai/` before anything
   starts.
2. In the project's `.opencode/opencode.json`, add providers the project
   never uses to `disabled_providers`, so their Grok models disappear from
   `opencode models`. A provider whose other models are still needed cannot
   be disabled; rely on the launcher for it. Check the result with
   `opencode models --standalone | grep -i grok` from the project directory.

## Assigning batches between models

When the user lets Claude choose between a Grok model and another model
(for example a cheap pay-per-use model), assign each batch by what it needs.
Starting rules, from the batches observed so far (see the table); change
them when new batches disagree, and note the evidence:

- Implementation and long test cycles go to the cheaper pay-per-use model
  by default: it is not limited by a weekly pool, and a stalled or reworked
  batch costs little.
- A batch that can run read-only while another batch is changing files or
  running tests (planning, root-cause reading, measurement design) goes to
  whichever model is idle, so the two overlap without sharing the working
  tree. Design-heavy planning: try the reasoning variant of the newest Grok
  model; coding: the coding-agent model.
- When the same problem has failed twice on one model, give the next
  attempt to the other model with the failure notes, before asking the user.
- When the Grok pool reports a limit, move pending work to the other
  allowed model; never to a Grok model resold by another provider.
- Record each batch in the trial record (wall time, tool calls, rework,
  false claims, cost estimate) so the next assignment rests on data.

Times are first to last JSON event (`oc-events.py`).

| Date | Model | Batch kind | Wall time | Calls | Cost estimate | Review result |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-14 | `opencode-go/deepseek-v4.1-flash#high` | measurement plan (read and measure) | 48 min, about 26 of them waiting for a test run | 127 | USD 0.13 | thorough and measured; one wrong sentence about scheduling |
| 2026-10-14 | `xai/grok-build-0.1` | design plan with experiments on the test host | 8.5 min | 82 | USD 1.10 | experiments sound; proposed a fragile string edit that the review replaced; one attempted evidence deletion blocked by the deny list |
| 2026-10-14 | `xai/grok-4.7#high` | read-only design plan, no test host | 17.5 min | 187 | USD 7.07 | every checked line reference correct; one wrong kernel fact (`O_EMPTY_PATH`) and missed a simpler Node-only option that the review found with a 5-minute probe |

## Login and first check

The user logs in; Claude never handles the login. In opencode: `/connect`,
search xAI, choose the subscription option ("SuperGrok Subscription" in
opencode 2.0.27), and approve in the browser with the account that holds the
plan. A store-bought plan (for example through the App Store) works when the
same account approves.

Then Claude checks, outside the Bash sandbox:

```bash
opencode auth list            # a line "xAI ... stored"
opencode models | grep '^xai/'
```

and sends one tiny prompt from an empty scratch directory, with standard
input closed (see the stdin pitfall in [SKILL.md](../SKILL.md#known-pitfalls)):

```bash
opencode run --standalone --format json -m xai/<model> "Reply with: ok" < /dev/null
```

An `error` event with HTTP 403 means xAI refused the plan for API use; tell
the user, do not try another provider.

## Model facts

Measured with opencode 2.0.27 on 2026-10-14:

| Model | Variant suffix | Notes |
| --- | --- | --- |
| `xai/grok-build-0.1` | none; `#high`, `#medium`, `#low` fail at once with `provider.no-route` "Variant unavailable" | xAI's coding-agent model; launch it without a suffix |
| `xai/grok-4.7` | `#high` works | newest general model in the list |

Other models listed then: `grok-4.20-0309-reasoning`,
`grok-4.20-0309-non-reasoning`, `grok-4.20-multi-agent-0309`, `grok-4.3`,
`grok-4.5`, `grok-4.6`. Test a variant with one tiny prompt before a batch
uses it.

## Launching

Use [scripts/grok-launch.sh](../scripts/grok-launch.sh) exactly like
`oc-launch.sh`:

```bash
grok-launch.sh new <brief> <run prefix> xai/grok-build-0.1
grok-launch.sh resume <session id> <reply> <next stop file> <run prefix> xai/grok-build-0.1
```

It checks the model and then runs `oc-launch.sh`, so every startup check and
`oc-wait.sh` behave as with any other model. Write the model into the
brief's header line so the stop file and the review name the same model.

## Usage limits

Step events do carry `cost` and `tokens` (a 15-minute, 82-call
`grok-build-0.1` batch showed USD 1.10 on 2026-10-14; a one-line probe that
ended without a `step_finish` event showed none). The figure is opencode's
estimate at list price; whether the subscription is charged that amount or
only draws from its weekly pool shows only on the subscription's own
dashboard, so report it as an estimate.

- Record the batch's start and end time in the stop-file review, so the user
  can match it with the dashboard.
- An error that mentions a limit, quota, rate or HTTP 429 means the pool may
  be exhausted: stop the batch between tool calls, keep the session, report
  to the user with the error text, and add the exact text to
  [Known pitfalls](#known-pitfalls). Do not switch provider or model without
  the user's decision.

## Trial batches and comparison

When the user approves a trial of a Grok model, run one normal batch with
the same brief template, review standard and test rules as the current
model. After the final stop file, fill
[templates/grok-trial-record.md](../templates/grok-trial-record.md) in the project's
handoff directory, comparing with the current model's recent batches of
similar size, and report to the user with a recommendation. The user decides
whether the default model changes; record that decision where the project
records model choices.

Measure only what the review saw:

- wall time to the final stop file, and tool calls (`oc-events.py`);
- rework rounds and review findings, by severity;
- claims in stop files that the review found false (check runs, numbers,
  deletions);
- rule breaks (test host, deny-list hits, commit and push rules);
- usage as read from the dashboard, if the user provides it.

## Known pitfalls

- 2026-10-14, opencode 2.0.27: a per-provider `blacklist` in
  `opencode.json` was dropped silently (`opencode debug config` showed the
  provider as `{}`) and the models stayed listed; `disabled_providers`
  worked.
- 2026-10-14: `grok-build-0.1` accepts no variant suffix (see
  [Model facts](#model-facts)).
