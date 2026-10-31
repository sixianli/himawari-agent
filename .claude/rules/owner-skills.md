<a id="owners-skills"></a>
# Andy 的技能

仓库不再保存 Andy 的技能副本（用户决定，2026-10-31，[ADR 0132](../../docs/adr/0132-owner-skills-from-the-claude-ai-account.md)）。技能是一个装着工作说明的文件夹，入口文件是 `SKILL.md`。会话只从以下几处获得技能：

- claude.ai 项目里的云端线程（在 claude.ai 云端运行的工作线程）加载 Andy 为 claude.ai 账号启用的技能。它们绝不加载仓库里的 `.claude/skills/`（[Claude Code 文档](https://code.claude.com/docs/en/claude-projects#what-threads-pick-up-from-your-repositories)）。
- Andy 的 Mac 上的会话加载 `~/.claude/skills/`，即原件。
- [document-governance.md](document-governance.md) 说明在本仓库中如何使用 `document-governance` 技能。

当一条指令提到的技能不在 Skill 工具（加载技能的工具）的列表里时，在计划或回复里说明这一点，并在指令自身文字所及的范围内照做。不得猜测这个技能的内容。值得上传给云端线程用的技能是 `verification-discipline` 和 `readable-output`；只有 Andy 能上传它们。

下表列出 Andy 的技能，好让会话分辨一条指令指的是哪一个。

| 技能 | 什么时候用 |
| --- | --- |
| `ai-gateway` | Vercel AI Gateway（Vercel 的模型调用网关）的设置、模型发现、身份验证、路由、备用模型、预算、花费报告，以及调试网关请求。 |
| `document-governance` | 创建、核对、校验、取代、归档或关闭 `docs/` 下受治理的文档，以及检查或封存 Runbook（操作手册）。 |
| `grill-me` | 通过一场追问式访谈，对一个想法、需求、计划或设计做压力测试。 |
| `grill-with-docs` | 同样的访谈，并通过 `document-governance` 把已敲定的术语和决定记进项目文档。 |
| `human-writing-zh` | 改写或起草自然、有活人感的中文文章，保留事实、条件和作者声线。 |
| `readable-output` | 每一份写给人看的回复：形式、平实写作规则、经过检查的 ASCII 图。 |
| `reflect` | 用户要求时，对当前任务做一次复盘。 |
| `siblog-blog-workflow` | 用于 Andy 的 SiBlog Hugo 博客的 `blog:*` 命令。 |
| `verification-discipline` | 任何改变可执行行为的功能、缺陷修复或重构：先写测试、端到端测试、先复现再修复、如实报告。 |
| `video-download` | 以可得的最高分辨率保存一个在线视频。 |
| `x-auto-post` | 通过 Buffer 撰写、排期并发布 X 帖子。排期需要 macOS。 |
