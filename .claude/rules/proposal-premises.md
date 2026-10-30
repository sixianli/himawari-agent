# Proposal Premises Cite the Source

The user decided on 2026-10-31 that every proposal states its premises with their sources. A thread once built a whole proposal on the coordinator's one-line summary of two project rules; the summary was wrong, and the proposal and an example given to the user were wrong with it ([the lesson](../../docs/lessons.md#trust-reported-checks)). Cloud threads load this file. It applies in fast mode and in full mode, to the coordinator and to every thread.

## Proposals

- Open every proposal with the premises it depends on. A premise includes what a project rule, document, or tool actually requires or does.
- Give each premise its source, a file path with line numbers or a URL, and quote the words it rests on.
- Do not reason from a premise that has no source. Mark it "not checked" and read the source before relying on it.
- A summary written by another Claude, the coordinator's brief, project memory, or an earlier reply is not a source. Open the document it summarizes.
- Before giving the user an example, confirm against the source that the example really fits.

## Briefs and Hand-offs

- When the coordinator's brief to a thread says what a rule requires, it gives the file path and the original words, or marks the claim "not checked; read the source before starting".
- Before passing a thread's proposal to the user, the coordinator checks that it opens with a list of premises and that each premise has a source. A proposal that fails this goes back to the thread instead of to the user.
