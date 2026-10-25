---
name: grill-with-docs
description: Sharpen a plan or design through an interview while capturing resolved terminology and decisions in project documents. Use for grill-with-docs or requests to interview and document as you go. Delegate every project-document write to Document Governance; use grill-me for an interview without documentation.
---

# Grill with Docs

Use the installed `grill-me` skill for the upstream interview and read
[references/domain-modeling.md](references/domain-modeling.md) for terminology,
concept boundaries, concrete counterexamples, and ADR selection.

## One interview, one document owner

Load the `grill-me` and `document-governance` skills by name, the way the
current agent harness loads skills, and follow their loaded instructions. If the
harness cannot load a skill by name, find it in the harness's skill list and read
its `SKILL.md`. Do not guess installation paths or read copies from another
agent's skill directory. Follow
`grill-me`'s bundled upstream interview as the single interview workflow.

**Document Governance owns every project-document mutation in this workflow.**
Before creating, updating, moving, superseding, or deleting any project
document, switch to its workflow. It decides paths, document classification,
templates, lifecycle fields, SOURCE links, supersession, and validation. There
is no direct-write fallback using upstream CONTEXT or minimal ADR templates.

This is a skill handoff by the executing agent, not a requirement to launch a
second agent or process. Hand over the resolved content and evidence, execute
Document Governance's applicable workflow, then resume the same interview.

## During each round

1. Inspect the relevant existing glossary, documents, and code; resolve facts
   before questions that depend on them. Respect context boundaries.
2. Run the ready interview frontier through `grill-me`. Challenge unclear
   terms and relationships using the domain-modeling reference.
3. As soon as a term or decision is settled, hand Document Governance the
   agreed wording, rationale, alternatives, evidence, affected context, and
   any unresolved assumptions. Persist it before the next dependent round;
   do not postpone all documentation until the interview ends.
4. Use [references/document-handoff.md](references/document-handoff.md) for
   adoption, glossary placement, decision history, and validation boundaries.
5. Report what was captured and continue. At the end, summarize shared
   understanding, unresolved decisions, document paths, and verification.
   Obtain confirmation before implementing the resulting design.

Explicit invocation or a request to interview **and save documents** authorizes
in-scope live capture using Document Governance for this task. A casual idea
mention does not. An explicit read-only or discussion-only instruction wins:
keep the interview in chat and do not create files. Do not adopt governance
across unrelated documents or launch implementation merely because documents
are being captured.

If either required skill is unavailable, report the missing dependency. An
available interview may continue within scope, but do not claim documents
were saved or bypass Document Governance. When requirements conflict, preserve
user instructions and existing governance rules rather than weakening them.
