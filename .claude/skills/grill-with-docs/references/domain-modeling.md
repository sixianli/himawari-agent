# Domain Modeling During an Interview

Adapted from the pinned upstream `domain-modeling` workflow. This reference
supplies the modeling method; Document Governance supplies all file operations.

Actively sharpen the domain model, rather than merely reading a glossary:

- **Challenge conflicting terms.** When a term conflicts with the existing
  glossary, surface both meanings and ask which applies.
- **Sharpen fuzzy language.** Propose a canonical term for an overloaded word.
  For example, distinguish the paying Customer from the User operating the app.
- **Discuss concrete scenarios.** Invent edge cases that test relationships
  and boundaries: can one order have several invoices, or be partly cancelled?
- **Cross-reference code.** If a stated rule conflicts with implementation,
  show the evidence and distinguish intended design from current behavior.
- **Capture immediately.** Once a term is resolved, hand it to Document
  Governance now. Keep definitions to one or two sentences. Define what it IS,
  not what it does. Select a canonical name, and list confusing alternatives
  under `_Avoid_`. Include domain-specific
  concepts, not general programming vocabulary. Group natural clusters.
- **Keep vocabulary focused.** The glossary contains definitions and context
  boundaries, not implementation inventory, scratch notes, or project state.

Read an existing `CONTEXT-MAP.md` or `CONTEXT.md` as relevant evidence. In a
multi-context project, identify which context owns each term and record
relationships without forcing distinct meanings into one global definition.
If ownership is unresolved, ask before documenting it as settled.

Offer a new ADR sparingly, when all three upstream criteria apply:

1. Reversal has a meaningful cost.
2. A future reader would be surprised without the rationale.
3. Real alternatives and a trade-off produced the decision.

Examples include architectural shape, context integration patterns, technology
lock-in, ownership boundaries, deliberate deviations, non-obvious constraints,
and rejected alternatives whose rationale would otherwise be lost.

These criteria guide new ADR proposals; they do not override Document
Governance's obligation to supersede an existing decision when it changes.
Use its full ADR template and lifecycle, never the upstream one-paragraph
template. Follow [document-handoff.md](document-handoff.md) for all persistence.
