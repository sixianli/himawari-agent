# PR 353：Pi 二次开发规范

问题：Andy 要求写一份 Pi（@earendil-works/pi-*，Himawari 的 Agent 框架）二次开发规范，让编码代理在 Pi 上加功能时照官方写法，不自己发挥；官方没有好写法或有缺陷时才自己设计，并且先出方案给他看。查官方文档要用最新版本。

改动：只改文档和指令文件，不改代码。
- docs/pi-development-guide.md：每类需求的官方写法（代码摘自 @earendil-works/pi-coding-agent@1.5.1 包内 docs/ 和 examples/，写了文件和行号），现有 7 处偏离表（状态“待 Andy 定”），偏离流程。
- docs/adr/0203-follow-pi-official-extension-patterns.md：记录决定。
- AGENTS.md、.agents/instructions/pi-and-workspace.md：写明开工必读。

作者的说法：
1. 规范里对 Himawari 现状的描述（哪些照官方、7 处偏离的位置和做法）与 packages/runtime-pi/src 当前代码一致。
2. 规范里的规则和现有项目规则（.claude/rules/prompt-prefix.md、.claude/rules/owner-standing-rules.md、.agents/instructions/pi-and-workspace.md、ADR 0023、ADR 0165、ADR 0198）不矛盾。
3. 引用的官方原文出处取自 npm 包 @earendil-works/pi-coding-agent@1.5.1（复核环境不联网，可以只核对规范内部和对 Himawari 代码的描述）。

请重点看：规范里有没有会让后来的编码代理照着做错的说法（与代码或现有规则不符、互相矛盾、偏离表漏了或描述错了）。
