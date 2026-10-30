# Owner's Skills

The repository no longer keeps copies of the owner's skills (user decision, 2026-10-31, [ADR 0132](../../docs/adr/0132-owner-skills-from-the-claude-ai-account.md)). A skill is a folder of working instructions with `SKILL.md` as its entry point. Sessions get skills from these places only:

- Cloud threads in a claude.ai project load the skills the owner enabled for the claude.ai account. They never load a repository's `.claude/skills/` ([Claude Code docs](https://code.claude.com/docs/en/claude-projects#what-threads-pick-up-from-your-repositories)).
- Sessions on the owner's Mac load `~/.claude/skills/`, the originals.
- [document-governance.md](document-governance.md) says how to use the `document-governance` skill in this repository.

When an instruction names a skill that the Skill tool does not list, say so in the plan or the reply, and follow the instruction's own words as far as they go. Do not guess the skill's content. Skills worth uploading for cloud threads are `verification-discipline`, `long-task-planning`, and `readable-output`; only the owner can upload them.

The table lists the owner's skills so that a session can tell which one an instruction means.

| Skill | Use it when |
| --- | --- |
| `ai-gateway` | Vercel AI Gateway setup, model discovery, authentication, routing, fallbacks, budgets, spend reporting, and debugging gateway requests. |
| `codebuddy-orchestration` | Delegate a well-scoped coding subtask to the local CodeBuddy Code CLI. Needs the owner's Mac. |
| `codex-orchestration` | Manage the local OpenAI Codex CLI as a delegated coding agent. Needs the owner's Mac. |
| `document-governance` | Create, reconcile, validate, supersede, archive, or close governed documents under `docs/`, and check or seal Runbooks. |
| `grill-me` | Stress-test an idea, requirement, plan, or design through a grilling interview. |
| `grill-with-docs` | The same interview, recording resolved terms and decisions in project documents through `document-governance`. |
| `human-writing-zh` | 改写或起草自然、有活人感的中文文章，保留事实、条件和作者声线。 |
| `long-task-planning` | Pick light or full mode at the start of every hands-on task, and keep a long task's goal, plan, and done state from drifting. |
| `opencode-orchestration` | Delegate coding and testing to the local opencode CLI and review its output. Needs the owner's Mac. |
| `readable-output` | Every reply written for a human: form, plain writing rules, checked ASCII diagrams. |
| `reflect` | A retrospective of the current task when the user asks for one. |
| `siblog-blog-workflow` | The `blog:*` commands for the owner's SiBlog Hugo blog. |
| `verification-discipline` | Any feature, bug fix, or refactor that changes executable behavior: test-first, end-to-end tests, reproduce before fixing, honest reporting. |
| `video-download` | Save an online video at the highest available resolution. |
| `x-auto-post` | Write, schedule, and publish X posts through Buffer. Scheduling needs macOS. |
