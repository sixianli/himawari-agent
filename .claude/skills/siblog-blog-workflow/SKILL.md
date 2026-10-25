---
name: siblog-blog-workflow
description: Use when the user invokes blog:header, blog:rename, blog:sync, blog:format, blog:upload, or blog:help in the SiBlog Hugo blog repository, or blog:tilian from any project thread to draft a SiBlog technical post from that thread's conversation.
argument-hint: "[blog:tilian <topic> | blog:header | blog:rename | blog:sync | blog:format | blog:upload | blog:help]"
---

# SiBlog Blog Workflow

## Scope

Use `blog:header`, `blog:rename`, `blog:sync`, `blog:format`, `blog:upload`, and `blog:help` only in the SiBlog Hugo blog
repository. They define the `blog:` command workflows for posts under `content/posts/` and repository-owned publishing
checks.

Use `blog:tilian` from any project repository. It drafts a SiBlog technical post from the current agent thread and never
writes into the SiBlog repository itself; the user places the reviewed draft with a command run in their own terminal.

The SiBlog repository defaults to `~/DoNotDeleteThis/documents/sxl_code_work_space/SiBlog`. Treat a directory as SiBlog
only when it contains `docs/post-metadata.md` and `content/posts/`; if the default fails that check, ask the user for the
path.

The helper scripts live in the `scripts/` directory next to this `SKILL.md`; `<scripts>` below stands for its absolute
path.

When the user's message is exactly or starts with one of the commands below, or this skill is invoked as
`/siblog-blog-workflow <command>` with one of them as its argument, treat it as a command invocation and execute
the matching workflow. Do not interpret `blog:` commands as general conversation.

## Shared Detection

For commands that operate on new or modified posts, detect untracked and tracked modified, added, renamed, copied, or
type-changed Markdown files under `content/posts/` with this macOS-compatible, NUL-safe command:

```bash
git status --porcelain=v1 -z --untracked-files=all content/posts/ |
  python3 -c '
import sys

records = sys.stdin.buffer.read().split(b"\0")
i = 0
while i < len(records):
    record = records[i]
    if not record:
        i += 1
        continue
    status = record[:2]
    path = record[3:].decode("utf-8", "surrogateescape")
    changed = status == b"??" or any(code in b"MARCT" for code in status)
    if changed and path.startswith("content/posts/") and path.endswith(".md"):
        print(path)
    i += 2 if b"R" in status or b"C" in status else 1
'
```

If no files match, tell the user `没有检测到新增或有改动的文章` and stop.

## Safety Rules

- Communicate with the user in Simplified Chinese.
- A command invocation authorizes its defined local operations within a clear scope: `blog:header` updates front matter, `blog:rename` renames posts, `blog:sync` writes faithful translation drafts (including missing siblings), and `blog:format` combines those operations with formatting. Preserve an explicit preview-only request or review checkpoint. These commands do not authorize unrelated prose rewrites or changes of meaning.
- `blog:tilian` authorizes reading the current thread's local transcript, writing working files to a temporary directory
  outside every repository, and web research for the topic. It does not authorize writing into SiBlog or the current
  project, committing, or publishing.
- Show relevant previews without pausing for a second generic approval. Ask for unresolved scope, conflicting edits, new taxonomy, replacement of an existing title unless already authorized, or a public URL change not already approved. Reuse approval for the same action and scope.
- Preserve the explicit human semantic-review gate for translations; permission to generate a draft is not approval of its meaning or permission to mark it reviewed.
- Follow the global local-commit policy after the requested local task is complete and its required checks pass. For `blog:upload`, complete local verification and commits before any remaining push approval. Push only when the concrete remote, branch, and outgoing change scope are authorized; reuse an existing authorization instead of asking again. A bare `blog:upload` requests publication preparation but is not approval of an as-yet-unreviewed outgoing change scope.
- Use non-interactive commands. For Git, use `git --no-pager` where relevant.
- Stop if a required command fails. Report the command and the meaningful error output.
- Do not commit `public/`; it is a Hugo build artifact and must remain ignored.
- Do not change taxonomy values during `blog:upload`; taxonomy changes belong in `blog:header`.
- Style changes must reference `docs/DESIGN-TOKENS.md`; hardcoded color values are prohibited.

## Translation Boundaries

Apply these rules during `blog:sync` and the pre-publication review in `blog:upload`. Chinese is the semantic source for
each Chinese-origin translation group.

- Translate every reader-facing heading, paragraph, list, table cell, caption, block quote, link text, reference
  annotation, and image alt text completely and faithfully. Preserve the article's order, coverage, claim strength, and
  technical meaning; do not summarize, expand, omit, weaken, strengthen, or reinterpret it.
- Judge each fenced code block by the role of its content. Translate reader-facing explanation inside a fence, including
  comments, architecture- or flow-diagram node labels, legends, and prose in `text` blocks. Preserve machine-facing
  content exactly: syntax, keywords, identifiers, APIs, imports, commands, flags, paths, environment variables,
  configuration keys and effective values, structured-data keys and values, regular expressions, protocol fields,
  version strings, hashes, IDs, executable output, and code-block topology.
- When translating an architecture or flow diagram, preserve its nodes, edges, ordering, IDs, and data flow. Translate
  only the visible explanatory labels; do not turn a diagram into a different design.
- Preserve inline code and other copyable technical tokens exactly. Keep formulas, variables, numeric values, units,
  external URLs, standards, product names, people names, and canonical taxonomy identifiers accurate and stable. Translate
  prose around them and link text, not the external URL itself.
- Point a same-site link at the corresponding target-language sibling when it exists. Do not treat its localized internal
  URL as an external URL difference. If no sibling exists, keep the original link and state the gap in the review.
- If a string inside a code block is ambiguous, preserve it unless its role is clearly reader-facing explanation. Ask for
  direction rather than changing a value that may affect execution, parsing, test expectations, or reproducibility.

## Commands

### blog:header

Prepare or update post front matter for new or modified posts.

1. Detect new or modified Markdown files under `content/posts/`.
2. Read the full article content for each file.
3. Read `docs/post-metadata.md` before generating taxonomy values.
4. Generate or update front matter using the existing front matter syntax whenever possible.
5. Use only `tags` and `categories` from the controlled taxonomy in `docs/post-metadata.md`.
6. If the article does not fit the current taxonomy, stop and ask before adding a new taxonomy item.
7. If front matter already exists, preserve `date` and `draft`.
8. Keep the current syntax unless the user explicitly asks to rewrite it.
9. Only update or add content-derived fields: `title`, `summary`, `description`, `tags`, `categories`, `slug`, and a stable `translationKey`.
10. Ask before overwriting an existing `title` unless its replacement is already authorized.
11. If the user approves a new taxonomy item, update `docs/post-metadata.md` first, then write the approved taxonomy back to the article front matter.
12. Show the generated front matter, then write the authorized fields without another confirmation. Pause only for the unresolved decisions above or an explicit review checkpoint.

### blog:rename

Rename new or modified post files based on article content.

1. Detect new or modified Markdown files under `content/posts/`.
2. Use the requested file scope. If multiple files are detected and the scope is unresolved, list them and ask which to rename; do not ask again when the scope is already clear.
3. For each selected file, read the full article content.
4. Generate a new filename that is concise, captures the core topic, uses 3-6 English words, is lowercase, uses hyphens between words, and ends with `.md`.
5. Show the rename plan in `old name -> new name` form. Check for destination collisions and effects on published URLs before writing; never overwrite an existing file. Ask only for an unresolved collision, an unapproved public URL change, or an explicit review checkpoint.
6. Within the authorized scope, check whether each source file is tracked with
   `git ls-files --error-unmatch -- "<old-path>"`:
   - If it is tracked, use `git mv -- "<old-path>" "<new-path>"` so Git can detect the rename.
   - If it is untracked, use `mv -- "<old-path>" "<new-path>"`; do not run `git mv` on it.
7. If front matter has a `slug` field, update it to match the new filename without `.md`.

### blog:sync

Synchronize semantic changes across the Simplified Chinese, English, and Japanese variants of each modified post.

1. Detect new or modified Markdown files under `content/posts/`.
2. If multiple translation groups are detected and the command scope is ambiguous, list every affected file and ask the
   user to confirm the scope.
3. Read the full changed variants, their sibling translations, the multilingual metadata contract in
   `docs/post-metadata.md`, and `docs/runbooks/multilingual-publishing-runbook.md`.
4. Group variants by `translationKey`. Treat the Chinese file, the `.en.md` file, and the `.ja.md` file with the same
   `translationKey` as one publication unit.
5. Compare every changed variant with its Git baseline and isolate semantic changes in `title`, `summary`, `description`,
   headings, prose, tables, captions, link text, image alt text, and other reader-facing content. Ignore formatting-only
   changes.
6. If more than one language contains independent edits, merge non-conflicting semantic changes. If the edits conflict or
   make the intended meaning ambiguous, show the conflict and stop for user direction.
7. Use the language containing each source edit to determine the intended change, then update the corresponding passages
   in the other two languages. Preserve meaning, claim strength, structure, and technical accuracy; do not summarize,
   expand, omit, weaken, strengthen, or reinterpret the edit.
8. Apply the Translation Boundaries above. Translate explanatory text inside fenced code blocks when appropriate, while
   preserving their machine-facing tokens and topology. Keep `translationKey`, `slug`, `date`, `draft`, `tags`, and
   `categories` consistent across all three variants.
9. If either sibling translation is missing, include and create the complete missing variant as an unreviewed translation draft within the selected group.
10. Show a three-language synchronization preview identifying the source edit and the corresponding sibling changes, then write the authorized drafts. Pause for conflicting meaning, unresolved scope, or an explicit review checkpoint; do not add a generic pre-write approval.
11. After writing, show the final three-language diff. Compare the selected group's heading sequence, prose coverage,
    link destinations, formulas, inline technical tokens, reference definitions, and each code block's structure and
    machine-facing content with the Chinese source. Confirm that code-block comments, diagram labels, and other
    reader-facing explanatory text were translated where appropriate. Treat any unapproved difference, untranslated
    explanation, lost diagram relationship, or changed machine-facing token as a blocker before human semantic review.
12. Wait for explicit human semantic-review approval before continuing to formatting or publication.
13. Only after that approval, run
    `python3 scripts/check_multilingual_content.py --print-source-hashes`, record the current Chinese source hash in the
    English and Japanese variants as `translationSourceHash`, and set their `translationReviewed` fields to `true`.
14. If semantic review is not approved, keep `translationReviewed = false`, do not refresh `translationSourceHash`, and
    stop.


### blog:format

Run the complete post-preparation workflow for new or modified posts:

```text
blog:header -> blog:rename -> blog:sync -> format-only
```

Execute `blog:header`, `blog:rename`, `blog:sync`, and the internal `format-only` stage in that order. The command authorizes these local operations within the selected scope. Preserve unresolved product decisions and the human semantic-review gate in `blog:sync`; previews alone do not create additional approval steps.

#### format-only

Reformat Markdown without changing content.

1. Detect new or modified Markdown files under `content/posts/`.
2. If multiple files are detected and the command scope is ambiguous, list them and ask the user to confirm.
3. For each selected file, strictly preserve all content while applying these formatting rules:
   - Ensure one blank line before and after headings.
   - Ensure one blank line before and after code blocks.
   - Use `-` for unordered lists.
   - Remove trailing whitespace.
   - Ensure the file ends with exactly one newline.
   - Normalize consecutive blank lines to a single blank line.
   - Do not rewrite, rephrase, add, or remove text content.
   - Do not alter taxonomy values, `tags`, `categories`, or `slug`.
   - Do not alter front matter content beyond formatting within the existing syntax if needed.
   - Do not change code block content.
4. Show a brief summary of formatting changes made to each file.

### blog:upload

Build, verify, commit, and push.

1. Detect all staged and unstaged changes, not limited to posts.
2. Before building, assess every new or modified post with the `blog:sync` rules. If any semantic change has not been
   synchronized to both sibling languages, reviewed against the Translation Boundaries, and explicitly approved, stop
   and execute `blog:sync` before continuing. Treat an untranslated reader-facing explanation, a changed machine-facing
   token, or a changed diagram relationship as a blocker. Do not treat a code-fence warning alone as a blocker when the
   only difference is an approved translation of comments, diagram labels, or other reader-facing explanatory text.
3. Check every new or modified post under `content/posts/` and verify it has an explicit `date` field in front matter.
4. If any post is missing `date`, show the file list and stop.
5. Before any build, commit, or push, preview safe Markdown bold-boundary fixes across every post:

```bash
./scripts/check_markdown_bold_syntax.sh --fix --dry-run
```

6. If the preview reports changes, show the exact before/after lines. Apply these deterministic spacing fixes when every affected file is within the authorized scope; if the all-post fixer would modify unrelated files, obtain approval for that expanded scope before running it:

```bash
./scripts/check_markdown_bold_syntax.sh --fix
```

7. Always rerun the check-only guard after the fix preview or application:

```bash
./scripts/check_markdown_bold_syntax.sh
```

8. The fixer must scan every Markdown file under `content/posts/`, only convert risky prose boundaries from `word**bold**word` to `word **bold** word`, and leave front matter, fenced code blocks, and inline code untouched. Stop if the check-only guard still finds any issue.
9. Run the strict multilingual publication gate:

```bash
python3 scripts/check_multilingual_content.py
```

10. Stop if any public page is missing a translation, lacks explicit human semantic review, has a stale source hash, or if English/Japanese remain disabled.

11. Before building, run the Formula Rendering Preflight below for every changed post containing display math and its affected sibling translations. Show exact original and corrected formula blocks for proposed edits, and use the authorization boundary in that preflight; do not ask again for an already authorized formula repair.
12. Run the Hugo production build:

```bash
hugo --gc --minify
```

13. Run the repository-owned math rendering guard:

```bash
python3 scripts/check_markdown_math_rendering.py
```

14. If the formula preflight, multilingual check, Markdown checks, or Hugo build fails, show the error output and stop. Do
    not commit or push.
15. If checks succeed, run a quick self-check:
   - Verify the `public/` directory was generated.
   - Verify the generated HTML files for new or modified posts exist in `public/`.
   - Spot-check that generated HTML is not empty and contains expected content such as the post title.
16. If the self-check passes, show the task-related files for the local commit and inspect all outgoing commits for the later push. The local commit scope must
    include every already staged path. If any staged path is outside the proposed scope, stop and ask the user to either
    include it or unstage it; never commit an unapproved staged change.
17. Before staging, check the confirmed scope for whitespace errors and conflict markers:

```bash
git --no-pager diff --check -- <confirmed-path-1> <confirmed-path-2> ...
git --no-pager diff --cached --check -- <confirmed-path-1> <confirmed-path-2> ...
```

    Stop if either command reports an issue.
18. Generate one Conventional Commit message that matches the confirmed scope and follows the repository's established
    style. For example, use `feat(posts): publish <topic>` for a new article, `docs(posts): update <topic>` for a
    correction to an existing article, or an appropriate `fix(<scope>): <subject>` for a site defect. Keep the subject
    concise and imperative. If the scope contains unrelated changes, stop and ask the user to split or narrow it rather
    than combining messages such as `post: ...; chore: ...`.
19. Show the exact task-scoped `git add` pathspecs and commit message. After the required checks pass, stage and commit under the global local-commit policy without a separate approval, unless the user requested review first. A pending push decision does not block this completed local work.
20. Use only the authorized pathspecs, review the final staged diff, and recheck it before committing:

```bash
git add -- <confirmed-path-1> <confirmed-path-2> ...
git --no-pager diff --cached --check -- <confirmed-path-1> <confirmed-path-2> ...
git commit -m "<task-scoped Conventional Commit message>"
```

21. Before pushing, verify the current branch, configured remote, destination branch, and all outgoing commits. Show the concrete destination and outgoing scope. Reuse existing approval for that exact publication; otherwise ask for it now. Never guess a destination, force-push, or include unrelated outgoing commits without authorization.
22. Run the authorized push only after its target and scope are approved and verification remains current. Report local commit hashes and the actual push result. If approval is pending or pushing fails, report local completion separately from the outstanding publication.

#### Formula Rendering Preflight

For every changed post containing display math, or whenever a user reports malformed formula output, inspect the Markdown
source before the Hugo build. Treat `$$...$$` and `\\[...\\]` as display-math blocks and preserve the mathematical meaning.

1. Inspect the changed formula blocks and the equivalent blocks in their English and Japanese sibling translations.
2. Never place a line containing only `=` or `-` inside a display-math block. Goldmark can interpret that line as a Setext
   heading underline, splitting the formula before KaTeX receives it.
3. Keep a simple equality on one expression line, for example:

   ```tex
   $$
   \theta_{t+1} = \theta_t - \eta \nabla_\theta L
   $$
   ```

   For genuinely multi-line equations, use valid LaTeX alignment such as `\\begin{aligned}` with `&=` rather than a bare
   equality-sign line. Preserve a blank line before and after every display-math block.
4. If a formula has this risk, report the exact source block, explain that the repair is Markdown layout only, and propose
   the smallest valid replacement. Do not alter symbols, operands, operators, or the equation's mathematical meaning.
5. Wait for confirmation before editing formula source, unless the user explicitly asked for the formula repair. Apply an
   approved layout-only repair consistently to sibling translations containing the same formula. Follow `blog:sync` if a
   semantic edit accompanies it.
6. After the Hugo build, inspect the generated HTML for each repaired formula. It must not create an unintended `h1`–`h6`
   heading from formula text, expose raw `$$` or LaTeX, or split a single equation across unrelated elements. If it does,
   stop, show the source block and generated HTML evidence, and propose a source-layout repair before publication.

### blog:tilian

Draft a Simplified Chinese technical post about one topic from the current agent thread: the original need and scene,
the problems met, the cause analysis and path to the fix, mainstream practice, and the final approach with its boundaries.
Usage: `blog:tilian <topic>`. If the topic is missing, ask for it before reading the transcript.

1. Locate the thread's transcript. Pass the agent you are running in:

```bash
python3 "<scripts>/thread_transcript.py" locate --agent <claude|codex>
```

   The script finds the file by `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`. Without an ID it falls back to the most
   recently modified session whose working directory is the current directory, skipping Codex review subagents, and
   reports `"method": "recent-cwd"` with other candidates. Show the user the method, start time, working directory,
   file path, and the first user message, plus any other candidates. Wait for the user to confirm this is the thread;
   use `--session-id <id>` for a candidate the user picks instead.
2. Choose a working directory outside every repository, such as the session scratchpad or a fresh directory under
   `$TMPDIR`, and export the conversation there:

```bash
python3 "<scripts>/thread_transcript.py" export --agent <claude|codex> --path "<transcript>" --output "<workdir>/conversation.md"
```

   The export keeps the user's words, the assistant's replies, and the user's answers to agent questions, numbered `#N`
   in time order. It omits tool calls, tool results, reasoning, subagent conversations, and injected system content by
   design. Entries marked `上下文压缩` are AI paraphrase: rely on the original messages before them, and cite a summary
   only when it is the sole record, labelled as a paraphrase. The last few turns can lag in the file; take them from
   your current context.
3. Collect material for the topic only. Search the export for the topic's terms, read the matching entries with their
   neighbours, and record `#N` references in five groups: the user's original need in their own words, symptoms and
   error messages, approaches tried and why each was kept or dropped, decisions with their reasons, and verification
   results. Use the assistant's own summaries of tool results; do not reconstruct tool traces. Record facts the export
   does not contain as material gaps; never fill them with guesses. Collect related commit hashes that the conversation
   names, or that `git --no-pager log` of the current project clearly ties to the work.
4. Research mainstream practice for the topic when the thread does not already establish it. Prefer authoritative
   English-language first-party sources such as official documentation and engineering publications, and link every
   source used. Keep what the project verified separate from what external sources claim.
5. Write the draft to `<workdir>/<file-name>.md` with these sections, omitting a section only when the material is
   absent and saying so in the report:
   1. 一句话摘要 — the problem and the final fix in one sentence.
   2. 背景与原始需求 — quote the user's original words where possible.
   3. 问题现象 — keep original error messages and symptoms so the post is searchable by them.
   4. 排查过程与根本原因 — include dead ends and why they were abandoned; mark each conclusion as reproduced,
      read from code, or inferred.
   5. 主流做法 — sourced from step 4, with links.
   6. 方案对比与取舍 — a table of options, pros, cons, and why each was chosen or rejected.
   7. 最终方案与边界 — what it covers, what it does not, its assumptions, and known limits.
   8. 验证方式 — the checks actually run and their results.
   9. 同类问题检查清单 — ordered checks for the next similar problem.
   10. 参考资料.

   Write for a reader without the thread: explain each technical term, English word, abbreviation, or project-internal
   name in plain Chinese at its first occurrence, and avoid vague summary phrases in place of explanation. Keep the
   thread's claim strength; do not present an unverified idea as a result. Use this front matter:

```yaml
---
title: "<specific Chinese title>"
date: "<current local time, e.g. 2026-09-27T10:00:00+09:00>"
draft: true
sourceAgent: "<claude|codex>"
sourceSessionId: "<session id>"
sourceProject: "<current project directory name>"
sourceCommits: ["<short hash>", "..."]
---
```

   Leave `tags`, `categories`, `summary`, `description`, `slug`, and `translationKey` to `blog:header`. Name the file
   with the `blog:rename` rule: 3-6 lowercase English words joined by hyphens, ending in `.md`. Pick the target
   directory by reading SiBlog's `docs/post-metadata.md` and the existing directories under `content/posts/`, and
   confirm the file name does not already exist there.
6. Check for sensitive content before handing off:

```bash
python3 "<scripts>/scan_sensitive.py" "<workdir>/<file-name>.md"
```

   Add your own review for what patterns cannot catch: private project or customer names, internal hostnames and URLs,
   personal information, credentials in prose, and pasted private code. Present every finding with its line, excerpt,
   and a suggested deletion or rewrite, including the `source*` fields. Wait for the user to decide each item; do not
   silently replace anything. Apply the decisions to the draft and rerun the scan.
7. Report the draft path, a short outline, the material gaps, and one command for the user to run in their own
   terminal. It copies the draft into SiBlog, refusing to overwrite an existing post, write outside `content/posts/`,
   or accept a draft without `draft: true`:

```bash
python3 "<scripts>/place_draft.py" "<workdir>/<file-name>.md" "content/posts/<category directory>/<file-name>.md"
```

   Pass `--siblog-root "<path>"` when SiBlog is not at the default path. Afterwards the user reviews the post in SiBlog
   and runs `blog:format` there for front matter, translations, and formatting. Do not commit anything.

### blog:help

Display this table:

```text
可用命令:

blog:header   — 为新增或有改动的文章自动生成/更新 Hugo front matter
blog:rename   — 基于文章内容重命名新增或有改动的文章文件
blog:sync     — 将任一语言的语义改动同步到同一文章的另外两种语言
blog:format   — 依次执行 front matter、重命名、三语同步和 Markdown 格式化工作流
blog:upload   — 全库加粗语法修复与复检 → 公式渲染预检与修复确认 → 构建验证 → 提交 → 推送
blog:tilian   — 在任意项目的 thread 里，把本 thread 中某个主题的讨论整理成 SiBlog 技术博客草稿
blog:help     — 显示本帮助信息
```
