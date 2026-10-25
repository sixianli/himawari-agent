# 来源与设计取舍

核对日期：2026-10-06。使用官方规范、项目原文和编辑指南。
本包是独立整合的写作技能，不是 Humanizer 官方版本，不与上游自动同步。
规则、中文例句、模板、扫描器和案例是本次编写；不复制整份上游 SKILL.md。

## 主要依据

### S01 — Humanizer / blader

项目：https://github.com/blader/humanizer
技能原文：https://raw.githubusercontent.com/blader/humanizer/main/SKILL.md
许可：https://raw.githubusercontent.com/blader/humanizer/main/LICENSE

本次页面标示版本为 3.1.0；未固定到一个 commit，不承诺之后的 main 内容相同。
采纳的编辑原则：检查空泛结构，保留原意，根据真实样稿校准，再做一轮审校。
本包另行设计了中文适配、事实关系检查和默认只输出成稿的交付方式。
上游明确面向人类读者，而不是追求绕过检测器；本包维持这一边界。
MIT 许可声明保留在 THIRD_PARTY_NOTICES.md。

### S02 — Agent Skills specification

https://agentskills.io/specification

用于 name/description 元数据、目录约定和按需加载参考资料。
本包的静态检查是依据规范自行实现的检查，不冒充官方认证。

### S03 — Anthropic: Skill authoring best practices

https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices

采用聚焦任务、分层材料、输入输出示范和基于案例迭代的组织方式。
本包给出回归题，但未据此声称跨模型写作效果已经验证。

### S04 — Anthropic: Prompting best practices

https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices

用于选择少量相关、彼此不重复的示例，并清楚区分任务、素材和示范。
本包选择用真实样稿校准而非不断追加形容词；分隔标签不被视作安全机制。

### S05 — Google developer documentation: Voice and tone

https://developers.google.com/style/tone

参考其技术说明可以自然、友好，同时不能喧宾夺主的取向。
本包只把这一建议用于相近文体，没有把技术文档规范扩成所有中文文章的禁令。

### S06 — Mailchimp Content Style Guide: Voice and Tone

https://styleguide.mailchimp.com/voice-and-tone/

参考其区分相对稳定的声音与随场景变化的语气，以及不勉强制造幽默的原则。
本包没有模仿 Mailchimp 品牌人格，而是为用户的样稿保留位置。

### S07 — OpenAI Codex: Build skills

入口：https://developers.openai.com/codex/skills/
本次解析跳转：https://learn.chatgpt.com/docs/build-skills

用于核对 Codex 的 ~/.agents/skills、项目 .agents/skills、$skill-name 调用和可选 openai.yaml。
安装位置与 UI 行为可能随宿主更新；本包不宣称已在用户机器安装或完成运行验证。

### S08 — Claude Code: Extend Claude with skills

https://code.claude.com/docs/en/skills

用于核对 ~/.claude/skills、项目 .claude/skills 以及 /skill-name 调用方式。
本地 Claude Code 的安装目录不等同于网页、Cowork 或远程环境。

### S09 — Anthropic: Define success criteria and build evaluations

https://platform.claude.com/docs/en/test-and-evaluate/develop-tests

用于任务相关的成功标准、定性量表、边界案例和 A/B 对比。
本包的具体五维量表与回归题是独立设计，不是官方基准或经标定的评分体系。

## 对照阅读，未直接移植

### S10 — holygeek00/humanizer-zh-cn

https://github.com/holygeek00/humanizer-zh-cn
https://raw.githubusercontent.com/holygeek00/humanizer-zh-cn/main/SKILL.md

本次技能页面标示 2.9.1-zh.2。用于对照中文场景覆盖；没有逐项照搬其规则或例句。
其许可页在本次核对时也保留 Siqi Chen 的 MIT 声明，本包一并列明致谢。

### S11 — ccf/humanize

https://github.com/ccf/humanize

用于比较“编辑指南 + 可选扫描器”的组织方式。没有使用其代码、量化阈值或模型特征数据，
也没有独立验证其 README 引用的所有研究结果，因此不把那些数字作为本包依据。

## 刻意没有采用的做法

不把英语破折号、卷引号等规则机械迁移到中文。
不设统一禁词黑名单，不要求全篇固定短句比例，不假装某个分数等于“真人”。
不以随机错别字、粗口、口头禅、虚构亲历或数据来增强所谓真实感。
不要求每篇文章同时运行多个润色技能；本包默认一次起草/改写加一次审校。

来源支持的是设计原则和宿主使用方式。是否改善某个作者、模型和题材的文章，
仍须使用真实文章评估；流行度、stars 或 README 自述不能代替这一点。
