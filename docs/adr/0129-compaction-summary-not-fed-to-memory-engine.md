---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-30"
covers: "apps/agent-service/test/production-titled-runtime.unit.test.ts, packages/runtime-pi/src/pi-runtime-adapter.ts, test/integration/memory-episodes.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0129：Pi 压缩摘要不再交给记忆引擎，记忆只来自逐轮抽取

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [业界做法](#industry)
- [决定](#decision)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Pi 在对话超过「模型窗口 − 16384」token 时自动压缩（`compaction: { enabled: true }`，`packages/runtime-pi/src/pi-runtime-adapter.ts`），产出一份摘要。此前代码把这份摘要作为来源为 `compaction` 的“对话片段”写进记忆引擎（`production-titled-runtime.ts` 收到 `runtime.compaction_proposed` 后调用 [recordCompaction](https://github.com/sixianli/himawari-agent/blob/d5f184e03548ce1c749d631c31d3bbbe886cef0a/apps/agent-service/src/production-memory-episodes.ts)，写入 `memory_episodes`）。这条路径来自 2026-10-25 参考 Cindy 的设计。

2026-10-30 21:56（日本时间），Andy 明确说：不要把压缩交给记忆引擎。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

Anthropic 记忆工具文档（2026-10-30 打开）：“compaction keeps the active context small … and memory preserves the information that must survive summarization”。记忆是单独记录的，不是从压缩摘要里提炼出来的；Claude 的当前记忆也是“saves memory as a set of individual topics as you chat, rather than summarizing conversations after they end”（Claude 帮助中心）。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 压缩摘要不再进入记忆引擎。删除 `runtime.compaction_proposed` 的处理，以及 ProductionMemoryEpisodes.recordCompaction 和 MemoryEpisodeService.recordCompaction。
2. 记忆只来自两路：每轮后台抽取（`memory-capture`）和每天一次的对话日摘要（`day_summary`）。
3. Pi 的压缩本身不变：压缩仍在运行中发生，结果随原生历史保存（`captureHistory`），下一轮恢复；摘要仍作为受保护的运行产物保存（`proposeCompaction`），只是不再写进记忆。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 数据库里已有的来源为 `compaction` 的片段保持原样，仍可被检索；`memory_episodes` 的取值检查（`day_summary`、`compaction`）不改，旧数据不用迁移。
- 少了一路可能补漏的材料：压缩摘要里有、逐轮抽取漏掉的事实不会再进记忆。是否漏记，需要“该记的话有没有被记下”的评测来衡量（见后续评测工作），目前未测量。
- 门槛：`test/integration/memory-episodes.test.ts` 断言搜索结果里不再出现 `compaction` 来源；`apps/agent-service/test/production-titled-runtime.unit.test.ts` 的运行时接口不再含 [recordCompaction](https://github.com/sixianli/himawari-agent/blob/d5f184e03548ce1c749d631c31d3bbbe886cef0a/apps/agent-service/src/production-memory-episodes.ts)（类型检查会拦住重新接入）。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0128：每次模型请求都记下缓存命中](0128-record-cache-usage-of-every-model-request.md)
- [架构文档：Pi compaction](../architecture-v0.1.md)

[↑ 返回阅读导航](#contents)
