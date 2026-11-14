---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0107-every-incident-gets-an-automatic-gate.md"
date: "2026-11-14"
---

# ADR 0269：线程开局只自动载入必需的规则，事故清单和只追加规则改为按需读

<a id="contents"></a>

## 阅读导航

- [前提](#premises)
- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [业界做法](#industry)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="premises"></a>

## 前提

1. 云端线程开局自动载入仓库根目录的 `CLAUDE.md`、`.claude/CLAUDE.md` 和 `.claude/rules/`，不载入带 `paths` 前缀的规则。来源：[Claude Code 文档 Projects 一页](https://code.claude.com/docs/en/claude-projects#what-threads-pick-up-from-your-repositories)，原话“`CLAUDE.md`, `.claude/CLAUDE.md`, and `.claude/rules/` at the repository root — Loaded from every repository when the thread starts. `CLAUDE.md` files in subdirectories and path-specific rules aren't loaded”。
2. `@` 引用的文件和引用它的 `CLAUDE.md` 一起全量载入，不省上下文。来源：[Claude Code 文档 memory 一页](https://code.claude.com/docs/en/memory)，原话“Imports help you organize a long file but don't reduce its context cost, because imported files load together with the CLAUDE.md that imports them”。
3. 本仓库根目录的 `CLAUDE.md` 只有一行 `@AGENTS.md`（`CLAUDE.md:1`）。
4. 改动前，事故规则要求每个线程开工时通读事故清单：`.claude/rules/incident-gates.md` 第 9 行（提交 `120fdd9`）原话“读 [docs/incidents-and-gates.md](../../docs/incidents-and-gates.md)。如果这次工作涉及某个有未结条目（状态为 `缺门槛` 或 `等 Andy`）的领域，在计划里说明。”；[ADR 0107](0107-every-incident-gets-an-automatic-gate.md) 决定 3 原话“每个线程开工时读，收尾时更新”。
5. 事故清单 `docs/incidents-and-gates.md` 的每一行写的是一个事故的完整经过（日期、现象、根因、次数、门槛、状态），绝大多数行的状态是“已落门槛”。
6. 改动前，只追加规则放在 `.claude/rules/prompt-prefix.md`，属于前提 1 里开局自动载入的范围（提交 `120fdd9`）。

<a id="context"></a>

## 背景

Andy 很在意 Claude Code 的额度，2026-11-14 让一个线程分析“每开一个线程，开局载入了哪些上下文、是不是全部一起载入”。分析发现：

- 开局自动载入的仓库内容里，篇幅最大的几份是 `AGENTS.md`、Andy 的全局指令和只追加规则。
- 事故规则还要求开工通读整份事故清单，而清单是全部仓库指令里最长的一份；开工时真正用得上的，只有还没关闭的那几条。
- 这些内容留在上下文里，之后每一轮请求都要重发。

只追加规则只在改发给模型的内容时才用得上，大多数线程（例如改界面、改上线脚本、写文档）用不到它。按字数估算的 token 数和提交统计写在 PR 495 的说明里，没有用分词器实测，这里不重复。

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-14 14:20（日本时间）：“我让你做这个事情，目的是让每一个线程刚开始的时候，不要有过多的无关内容占用太多的上下文空间，以此来减少 token 的花费”。
- 2026-11-14 14:32：“全部按照你的建议来做，我同意。”
- 2026-11-14 15:48，看到复核意见“ADR 0107 和新规则不一致”后：“补上吧，ADR 还是补上”。

<a id="decision"></a>

## 决定

本 ADR 修改 [ADR 0107](0107-every-incident-gets-an-automatic-gate.md) 的决定 3 里“每个线程开工时读”这一句，ADR 0107 的其他决定不变。

1. **开工时不通读事故清单。** 线程开工时运行 `node scripts/check-incident-gates.mjs --open`，它只打印没有关闭的条目（“缺门槛”“等 Andy”和“仓库外”）的编号、状态、日期和一句话现象，最后一行是 `INCIDENT_OPEN count=<条数> total=<总数>`。清单有任何一处通不过检查时，不列条目，只打印 `INCIDENT_OPEN unavailable errors=<错误数>`，因为这时列出来的可能不全。工作涉及其中某条的领域时，再去读清单里的那一行。
2. **判断重犯时按关键词搜。** 出了错要判断是不是重复发生时，按领域、文件名或报错关键词搜整份清单，包括已关闭的行（已关闭的事故又出现，说明它的门槛漏了），不必通读。清单本身一条不删，“第三次必须有硬门槛”仍由 `npm run check:incident-gates` 拦；这一步现在也跑 `test/tooling/incident-gates.test.mjs`。
3. **只追加规则改为按需读。** `.claude/rules/prompt-prefix.md` 移到 `.agents/instructions/prompt-prefix.md`。`AGENTS.md` 的“发给模型的内容只追加”一节保留三条核心原则，写明只要动到发给模型的上下文就必须先读这份规则，并列出 5 个用来判断“算不算动到”的问题。`npm run check:prompt-prefix` 照旧是阻断检查。
4. **`AGENTS.md` 只留触发条件。** “交付模式”“和 OpenCode 协作”“Pi 优先与工作区”三节只保留什么时候要读什么、读哪份文件，细节以 `.agents/instructions/delivery-mode.md`、`model-review.md`、`model-review-card.md` 和 `docs/pi-development-guide.md` 为准。

<a id="industry"></a>

## 业界做法

- Anthropic 的 Claude Code 文档建议每个 `CLAUDE.md` 不超过 200 行，只在部分场景用到的说明放进按需载入的地方；技能（skill）开局只载入描述，用到时才载入全文（[memory](https://code.claude.com/docs/en/memory)、[skills](https://code.claude.com/docs/en/skills)，原话“Unlike CLAUDE.md content, a skill's body loads only when it's used, so long reference material costs almost nothing until you need it”）。
- 本项目的做法和这一致：开局只放每个线程都要遵守的规则和“什么时候读什么”的指引，长的参考内容由线程按需打开。云端线程不载入带 `paths` 的规则，也不载入仓库里的技能（前提 1），所以按需的办法只能是“规则里写明什么时候读哪份文件”。

<a id="options"></a>

## 比较过的方案

- **给规则加 `paths` 前缀，让它按文件路径按需载入：** 不采用。云端线程完全不载入带 `paths` 的规则（前提 1），规则会彻底失效。
- **生成一份“未关闭条目”短表文件，开工时读它：** 不采用。多一份副本，就多一处会和原清单对不上的地方；现场用脚本读原清单不会过期。
- **把事故清单拆成“未关闭”“已关闭”两份文件：** 不采用。重犯判断要搜已关闭的条目；拆开以后，改状态时要在两份文件之间搬行，容易漏。
- **压缩 Andy 的全局指令：** 不采用。几乎每一节对每个线程都适用，只能省约 2k token，还要改 Andy 自己的原文。

<a id="consequences"></a>

## 后果

- 正面：开局自动载入的内容少了只追加规则和 `AGENTS.md` 里的细节，开工也不再通读事故清单；省下的上下文之后每一轮都不用再带（PR 495 说明里按字数估算，每个线程开局约少 6 万 token）。
- 负面：
  - 改发给模型内容的线程，要靠 `AGENTS.md` 里的那 5 个问题想起去读只追加规则。漏读时，还有 `npm run check:prompt-prefix` 和合并前复核的必问题“这个改动会不会改变模型已经见过的请求开头”兜底。
  - 线程开工时多跑一条命令。
- 后续：`docs/` 下指向只追加规则的链接已同步改成新路径 `.agents/instructions/prompt-prefix.md`。

<a id="references"></a>

## 关联文档

- [ADR 0107：每个事故落一道自动检查，同一错误第三次必须有硬门槛](0107-every-incident-gets-an-automatic-gate.md)
- [事故与门槛清单](../incidents-and-gates.md)
- [ADR 0149：发给模型的请求只追加](0149-append-only-model-requests.md)
- [模型请求的 KV 缓存规范](../kv-cache-guide.md)
