---
name: readable-output
description: Make every response to the user easy to understand and check. Use for every reply written for a human, including answers, explanations, plans, reviews, debugging results, progress updates, and final task reports. It picks the form (plain text for conclusions and steps, a checked ASCII diagram for structure and flow, a published HTML page with its link in the response for content to explore; never Mermaid, never video) and gives writing rules adapted from ASD-STE100. Its writing rules also apply to documents written for people.
---

# Readable output

More and more of the user's work is checking results they did not produce. The form of a response decides how fast they can understand it and find what is wrong. This skill picks the form, then gives the rules for each form.

Apply it to every response to the user, from a one-line answer to a final task report. Once loaded, it stays in effect for the rest of the conversation.

If the user's or the project's own instructions say otherwise, follow them.

## 1. Pick the form

| The user needs to | Form |
| --- | --- |
| Know a conclusion, a decision, a number, or a fact to check; follow steps | Text in the response |
| See structure: parts and how they connect, data or control flow, states, layers, the order of messages | ASCII diagram in a `text` code block, with numbered notes under it |
| Explore: many items, several levels of detail, filters, parameters to change, a comparison too large for the terminal | Single-file HTML page published as an Artifact, with its link in the response |

- Text comes first. A diagram or a page supports the text. State the conclusion in the response itself, so the user can read the answer without opening anything.
- One diagram shows one idea. If it needs more than about 12 boxes, split it or move to a page.
- Never use Mermaid. Never produce a video, narration, or animation.
- A finished-looking diagram or page makes a wrong claim more convincing. Mark inferred or unverified claims in it exactly as you would in text.

## 2. Write text the user understands on one read

Apply these rules to chat replies and to documents for people. Copy code, identifiers, commands, paths, quoted errors, and numbers exactly; the rules never change them.

- The first sentence gives the answer or the result. Do not restate the question.
- One sentence carries one point. In steps, write one action per sentence and put the condition before the action: "如果构建失败，先看日志。"
- Name who acts: "脚本会删除旧文件", "你需要运行 `make test`". Avoid sentences with no actor.
- Use one word for one concept in a response or document. If you call it 检查, do not switch to 验证 or 校验 for the same thing.
- Explain a term at first use in a few words, for example "幂等（重复执行，结果不变）". Do not explain common product names such as Git, Python, or HTTP.
- State facts, not their importance. Delete 至关重要, 非常, 十分, 极其, 无缝, 强大, 全面, 显著, 稳健, 赋能, 值得注意的是, 简单地, 轻松; in English, crucial, robust, seamless, powerful, comprehensive, leverage, simply, it is worth noting.
- State known facts plainly with 会, 能, 必须. When something is uncertain, say what is unknown and which check would settle it. Do not scatter 可能, 也许, 应该, 大概 through the text.
- No decorative patterns: "不仅……更是……", three adjectives in a row, closing summaries such as 总之 or 综上所述.
- Never shorten error text, security warnings, or a confirmation before a destructive action.
- Headings, lists, and tables are for long answers that need scanning. A short answer is plain sentences.

Before sending, check the draft:

1. Find the three longest sentences. Split any that carries more than one point.
2. Search for the delete-list words and for 可能, 也许, 应该, 大概. Keep a hedge only where the uncertainty is real and named.
3. Confirm each concept uses one word throughout.
4. List every term not yet explained, then explain or replace each.

## 3. Draw an ASCII diagram

Do these steps without describing them in the reply:

1. Plan. List the boxes and the edges. Open [references/ascii-patterns.md](references/ascii-patterns.md) and pick the closest pattern. Decide each box's width and the column of every vertical line. Keep the total width at or under 80 columns.
2. Draw. Write the diagram to a file in the scratchpad directory, or in `$TMPDIR` when there is no scratchpad, starting from the pattern.
3. Check. Run:

   ```bash
   python3 <skill-dir>/scripts/check_ascii.py <file>
   ```

   It prints one `line:column: problem` per problem and exits 1, or prints `ok` and exits 0. It finds vertical lines out of column, a vertical line meeting `-` where a `+` belongs, a `+` with nothing joining it, arrows not attached to a line, wide characters such as Chinese, banned Unicode characters, tabs, and lines over 80 columns. Columns are display columns: a Chinese character counts as 2.
4. Fix and run the check again until it prints `ok`. Paste the file content into a `text` code block without retyping it.
5. Under the block, add numbered notes in Chinese that explain the labels and edges.

Drawing rules:

- Use only `+ - | < > ^ v / \`, ASCII letters, digits, and spaces. No `┌─┐│`, no `→`, no tabs.
- Box labels are one to three short ASCII words, or a number such as `[1]` that a note explains. Chinese goes in the notes because fonts do not agree on how wide a Chinese character is, so a box with Chinese in it can show misaligned.
- Corners and junctions are `+`. Put an arrow in the middle column of the box it points to.
- Put an edge label beside the edge: on the line above a horizontal edge, or to the right of a vertical one.
- The checker cannot tell whether the diagram is true or easy to read. Read it once as the user would before sending.

## 4. Publish an HTML page

1. Load the `artifact-design` skill before writing the page; the Artifact tool requires it. Write one self-contained HTML file in the scratchpad directory.
2. Lead the page with the conclusion. Put the evidence next to each claim: `file:line`, command output, test names. Label inferred or unverified claims visibly. Never invent data to fill the page. Write the page in the user's language.
3. Publish it with the Artifact tool. In the response, give the returned URL as a Markdown link with one sentence on what the page shows, for example `[登录流程排查](https://claude.ai/...)：每一步请求和失败点`. The response still states the conclusion in text.
4. The page is disposable. Do not commit it to a repository unless the user asks. To update it, edit the same file and publish again; the URL stays the same.
5. When the harness has no Artifact tool, write the file, give its absolute path, and say that no link could be made.

## 5. Check that replies are in Chinese

When the user requires every reply in Chinese, a written rule is not enough: replies drift into English after long stretches of English tool work, briefs, or documents. `scripts/check_chinese_reply.py` finds English prose in replies, and each harness runs it as hooks, commands the harness runs at fixed moments.

The hooks cannot take back text already shown. They make every slip visible at once and get it restated.

Only English sentences are reported, not English names and terms. A stretch of a line without Chinese characters counts as English when it has at least three words, one of them a common English function word such as `the` or `to`, and also looks like a sentence:

- it starts with a capital letter and ends with `.`, `!` or `?` (a leading list number or bullet is ignored), or
- it contains a word that only sentences use: an auxiliary verb (`is`, `will`, `can` …), a subject pronoun (`I`, `we`, `it` …), `let`, `please`, `now`, `then`, or a question word (`what`, `how` …), or
- it has at least four words, two function words and a verb ending in `-ing` or `-ed`, or
- it has at least six words and two function words.

So terms such as `ai agent`, `LLM as a judge`, `human in the loop` and `state of the art` pass inside a Chinese sentence. Words joined by hyphens count as one word (`LLM-as-a-judge`), and a title-case name without a final `.`, `!` or `?` passes (`Attention Is All You Need`). Code blocks, inline code, `>` quote lines, quoted text, Markdown links, and anything containing `/` are skipped. So put commands and identifiers in backticks, and put English that must be quoted in a code block or a `>` line. To check a draft or a document, run `python3 <skill-dir>/scripts/check_chinese_reply.py check <file>`, or pass `-` for standard input.

### In Claude Code

It runs as hooks that this folder ships as a plugin:

| Hook event | Command | Effect |
| --- | --- | --- |
| `MessageDisplay` | `record` | Keeps the text shown to the user in `${CLAUDE_PLUGIN_DATA}/reply-language/<session>.txt` until the next check. |
| `PostToolBatch` | `batch` | Checks the kept text after each batch of tool calls. English adds a request to restate it in Chinese before the next model call, and a notice for the user. |
| `Stop` | `stop` | Checks the kept text and the final message. English blocks the stop until Claude restates it in Chinese. |
| `PreToolUse`, matcher `AskUserQuestion` | `ask` | Denies a question whose text or options are in English, before the user sees it. |

The hooks are declared in `hooks/hooks.json`, next to the plugin manifest `.claude-plugin/plugin.json`. Do not copy them into `settings.json`:

- **Install**: put this folder, or a symbolic link to it, in `~/.claude/skills/`. Claude Code loads it in place as the plugin `readable-output@skills-dir`, enabled by default, and the skill keeps its plain name `readable-output`.
- **Turn off or on**: set `"readable-output@skills-dir": false` (or `true`) under `enabledPlugins` in `~/.claude/settings.json`, or use the `/plugin` menu. This switches all four hooks together.
- **After editing** `hooks/hooks.json`, run `/reload-plugins` or start a new session. Edits to the script apply on the next hook run.
- **Upgrading from manual hooks**: remove any `check_chinese_reply.py` entries from `settings.json` first, or every check runs twice.

Hooks that run inside a subagent are skipped, because the user does not see a subagent's text.

To check the installed plugin in a real session, run `python3 <skill-dir>/tests/plugin_session_e2e.py`. It starts `claude -p` with a prompt that asks for English, checks that the session loaded the plugin and that the `Stop` hook made Claude restate the reply in Chinese, and keeps the stream and a summary under `tests/verification/<date>/local/`. It uses the network and costs one short model call.

### In Codex

Codex runs the same script through two hooks declared in `~/.codex/hooks.json`:

| Hook event | Matcher | Command | Effect |
| --- | --- | --- | --- |
| `SessionStart` | `startup\|resume\|clear\|compact` | `start` | Tells the agent to read this `SKILL.md` before its first reply and to follow it for the rest of the session. |
| `Stop` | not used | `stop` | Checks the last reply. English blocks the stop until the agent restates it in Chinese. |

**Install**: the agent that installs this skill merges these two entries into `~/.codex/hooks.json` and keeps the entries already in the file. Write the absolute path of `<skill-dir>/scripts/check_chinese_reply.py` in `command`, and give `--state-dir` the absolute path of `<home>/.codex/reply-language`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "python3 <skill-dir>/scripts/check_chinese_reply.py start --state-dir <home>/.codex/reply-language",
            "timeout": 20
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 <skill-dir>/scripts/check_chinese_reply.py stop --state-dir <home>/.codex/reply-language",
            "timeout": 20
          }
        ]
      }
    ]
  }
}
```

**Trust**: Codex skips a hook until the user trusts its exact definition, and a changed entry needs a new review. After installing, run `/hooks` in an interactive Codex session and trust both entries. Editing only the script does not need a new trust review.

**Differences from Claude Code**: this skill adds no check while text is shown, no check after a batch of tool calls, and no check on questions before the user sees them. The `Stop` hook sees only the last reply of a turn (`last_assistant_message`), so English in an earlier message of the same turn, such as a progress line before a tool call, is not caught.

**End-to-end check**: run `python3 <skill-dir>/tests/codex_session_e2e.py`. It passes both hooks on the command line for one run and bypasses hook trust, so it tests the script in this folder rather than what is installed on the machine. It needs the network and costs one short model call.
