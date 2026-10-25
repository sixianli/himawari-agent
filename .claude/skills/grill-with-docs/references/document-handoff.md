# Hand Off Project Documents to Document Governance

Load the `document-governance` skill by name, then its SOP and applicable
workflow references. Apply its existing adoption, scope, and repository-rule
checks. The user's request to run this documented interview explicitly selects
Document Governance for the captured documents; it does not authorize migration
of unrelated legacy documents. A read-only instruction suppresses all writes.

## Glossary

Ask Document Governance to keep each definition in one authoritative place.
Reuse the relevant governed glossary if one exists. Otherwise it may create a
glossary under `docs/`, such as `docs/domain/glossary.md`, with the mandatory
`status`, `supersedes`, `superseded_by`, and `date` frontmatter. A generic glossary
does not require a new `document_type` value; do not invent an unsupported type.
Use separate context sections or files when terms have different meanings.

The body uses the upstream domain-modeling shape: context name and brief scope,
a Language section, canonical terms with short definitions, and `_Avoid_`
aliases. Document Governance decides the actual path and any repository-specific
conventions. Do not automatically create a root `CONTEXT.md` or context map.

An existing root glossary is evidence, not a valid local SOURCE target. Do not
silently duplicate or relocate it. Have Document Governance reconcile the
authoritative location within the authorized scope; surface any migration
decision that genuinely needs the user. All local SOURCE targets stay inside
`docs/`. Use ordinary Markdown links only for explanatory external-to-docs
context, not to disguise an authoritative dependency.

## Decisions and other captures

Document Governance chooses the appropriate artifact: an ADR for durable
decision rationale, a Spec for the current design, an Idea for an uncommitted
insight, or another existing governed document. Do not generate a full PRD,
Architecture, Spec, Plan, and Backlog suite for every interview.

For ADRs, use its template and all required frontmatter, including
`decision_status`. Keep proposed choices distinct from accepted decisions; a
recommendation is not acceptance. Do not record planned behavior as implemented.

If a recorded decision changes, preserve the old ADR's context, options,
decision, and consequences. Create a replacement ADR, get that decision
accepted, and let Document Governance update the reciprocal `supersedes` and
`superseded_by` links and lifecycle fields. Never rewrite or archive old ADRs.

## Verification and return to interview

Have Document Governance inspect the written files and run its validator using
the absolute path of its script, which is `scripts/validate_docs.py` inside the
`document-governance` skill's directory:

```text
python3 <document-governance skill directory>/scripts/validate_docs.py <project-root> --strict
```

Use its migration-friendly audit only during initial adoption; use strict mode
for governed-project completion. Report unrelated pre-existing failures rather
than silently fixing them or claiming a clean result. Read back captured content
to check its meaning: structural validation cannot prove semantic correctness.

Return document paths, changes, validation results, and any unresolved issue to
the interview. Continue asking only questions whose prerequisites are resolved.
