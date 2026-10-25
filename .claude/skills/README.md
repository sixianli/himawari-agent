# 仓库内的 Claude skill

这里放的是 Andy 在自己 Mac 上的 Claude Code 里启用的 skill（给 Claude 的一套做事说明，每个目录一个，入口是 `SKILL.md`）。

云端怎么用到它们：

- claude.ai 项目里的云端线程（也就是 Projects 里每个任务开出的云端会话）不会加载仓库里 `.claude/skills/` 下的 skill，只会读仓库根目录的 `CLAUDE.md`、`.claude/CLAUDE.md` 和 `.claude/rules/`（[官方说明](https://code.claude.com/docs/en/claude-projects#what-threads-pick-up-from-your-repositories)）。所以 [`.claude/rules/owner-skills.md`](../rules/owner-skills.md) 列出了每个 skill 的名字和用途，并要求线程在任务对得上时用 Read 工具读对应的 `SKILL.md` 照做。
- 其他会话（Mac 上在本仓库里打开的会话、不属于项目的云端会话）会按 Claude Code 的规则直接加载这里的 skill。Mac 上 `~/.claude/skills/` 里有同名 skill 时，用的是本机那份（[官方说明](https://code.claude.com/docs/en/skills)：个人目录优先于项目目录）。
- 另一条官方路子是把 skill 上传到 claude.ai 账号里启用，云端线程就会像内置 skill 一样自动加载；这需要 Andy 自己在 claude.ai 的 skill 设置里操作。

这些目录是快照，不是源头。改 skill 请到源头改，再按下面的步骤重新复制，不要直接改这里。

## 来源

| skill | 源头 |
| --- | --- |
| codebuddy-orchestration、codex-orchestration、document-governance、grill-me、grill-with-docs、human-writing-zh、long-task-planning、opencode-orchestration、readable-output、verification-discipline、video-download | `sixianli/agent-skills` 仓库同名目录，快照时的提交是 `fa8a4e6c44cf02b6b24f3d17c2ff5a04f8998633` |
| reflect | `sixianli/agent-skills` 仓库 `shoshin/skills/reflect`，同一提交 |
| ai-gateway | Vercel 发布的 skill，本机 `~/.claude/skills/ai-gateway` |
| siblog-blog-workflow、x-auto-post | 本机 `~/.claude/skills/` 下的同名目录 |

快照与源头的差别：

- 没有复制 `tests/verification/`（以前验证时留下的日志和对话记录）、`FEEDBACK.md`（各项目写给 skill 的问题记录）、`__pycache__/`、`.ruff_cache/` 和 `.DS_Store`。
- `ai-gateway/references/routing.md` 和 `ai-gateway/references/evaluation.md` 里的 `process.env.ANTHROPIC_API_KEY`、`process.env.AI_GATEWAY_API_KEY` 改写成了 `process.env["..."]`。两种写法在 JavaScript 里意思相同，改写只是为了不让仓库的密钥扫描 `scripts/scan-machine-secrets.mjs` 把读取环境变量的示例误判成写死的密钥。
- `document-governance/assets/templates/` 下的 `adr`、`architecture`、`prd`、`spec` 四个模板去掉了行尾空格和文件末尾多余的空行，因为提交前的 `git diff --cached --check` 会因此报错；模板内容没有变。
- 删掉了 8 行代码注释，因为仓库的提交前检查 `check-new-comments.py` 不接受新增注释：`codebuddy-orchestration/scripts/cb-delegate.sh` 里的 `# shellcheck disable=SC2053`（给 Shell 脚本检查工具 shellcheck 的忽略指令，本仓库不跑 shellcheck），`document-governance/scripts/runbook.py` 里 `EXCLUDED_DIRECTORY_NAMES` 上方的 4 行说明，`human-writing-zh/scripts/review_text.py` 的 2 处说明，`video-download/scripts/download.py` 的 1 处说明。代码本身没有改。

故意不放进来的：

- `hermes-ssh`：含 Hermes 服务器的内部地址和主机名，skill 自己写明只留在本机、不进任何 git 仓库。
- Claude 账号里同步下来的 skill（`pdf`、`docx`、`xlsx`、`pptx`、`docs`、`deep-research` 等）：云端会话通过同一个账号本来就有。
- 插件带来的 skill（`frontend-design`、`grok-build`）：属于插件，不属于这个仓库；`grok-build` 还依赖本机的 Grok 命令行工具。

## 重新复制

在 Mac 上、仓库根目录运行：

```bash
rsync -aL --delete --exclude 'tests/verification/' --exclude '__pycache__/' --exclude '.DS_Store' --exclude '.ruff_cache/' --exclude 'FEEDBACK.md' --exclude '*.before-*' --exclude '*.pyc' --exclude 'synced/' --exclude 'hermes-ssh/' --exclude 'README.md' --exclude '.claude/' ~/.claude/skills/ .claude/skills/
```

复制后重做上面“快照与源头的差别”里的改写，并把“来源”表里的提交号换成 `sixianli/agent-skills` 当时的提交。增加、删除 skill 或某个 skill 的 `description` 变了时，同步改 [`.claude/rules/owner-skills.md`](../rules/owner-skills.md) 里的表。

## 在云端会话里的限制

- `codex-orchestration`、`opencode-orchestration`、`codebuddy-orchestration` 需要本机装好的 Codex、opencode、CodeBuddy 命令行工具，云端没有这些工具时用不了。
- `long-task-planning` 在本机还靠 `~/.claude/settings.json` 里的会话启动钩子（每次会话开始时自动运行的命令）提示进行中的任务；云端没有这个钩子，需要按 `SKILL.md` 手动运行 `scripts/longtask.py`。
- `siblog-blog-workflow` 默认 SiBlog 博客仓库在 `~/DoNotDeleteThis/documents/sxl_code_work_space/SiBlog`，`x-auto-post` 的定时发布依赖 macOS 的 launchd（系统自带的定时任务服务），两者在云端都只能用到写稿部分。
- skill 里写的 `~/.claude/skills/<名字>/...` 路径在云端不存在，对应文件在本目录 `.claude/skills/<名字>/...`。
- Andy 的两份全局指令（`~/.agents/AGENTS.md` 和 `~/.claude/CLAUDE.md`）合并后放在 [`.claude/rules/owner-global-instructions.md`](../rules/owner-global-instructions.md)，云端线程启动时会自动读到。本机这两份改了以后，要同步改那份文件。
