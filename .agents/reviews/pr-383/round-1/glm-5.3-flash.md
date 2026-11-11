# 复核报告：PR 383（P5-2 外部 agent 提议新记忆，MCP propose_memory）

## 结论摘要

通读全部改动（对照基准 1222bc2）并核对了作者的说法后，**没有发现高危问题**。作者的说法逐条与代码相符；发现的问题都是低severity（规范化字符清单不全、个别分支缺测试、一处与 ADR 文字不完全一致）。

---

## 问题清单（按严重度从高到低）

**1. 低 · apps/agent-service/src/production-mcp-memory-writer.ts:14 · 规范化漏掉部分“零宽字符”，与 ADR 文字不完全一致**
- 证据：`const INVISIBLE_FORMATTING = /[\p{Cc}​-‏‪-‮⁠-⁩﻿]/gu;`，覆盖了 C0/C1 控制符、U+200B–200F、U+202A–202E、U+2066–2069、U+FEFF，但漏了 U+2060（word joiner）、U+2061–2065、U+00AD（软连字符）等不可见字符。ADR 0225 决定 5 写的是“把控制字符、零宽字符和双向排版字符换成空格”，U+2060 属于零宽字符。
- 影响：这类字符会留在确认框文字和保存的正文里；**不会**造成双写或误报 CHANGED（规范化是纯函数，同一输入永远同一输出，见必答问题 2）。纯属清理不彻底。
- 建议：把 U+2060–U+2065、U+00AD 加进清单，并补一条单测。

**2. 低 · apps/agent-service/src/production-mcp-memory-writer.ts:203-206 · `keep()` 的 CONFLICT 重试分支没有确定性测试**
- 证据（读代码证实）：`catch` 里 `if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT) throw error; await this.#options.memory.applyProposal(proposalRecord, generationId, write);`。但 `durable-memory-service.ts:124-146` 对同 id 同内容直接返回已有记录、不抛 CONFLICT；真正抛 CONFLICT 需要两个并发事务都先读到“不存在”（`sqlite-memory-operations.ts:740-764` 事务内 read→insert，第二个事务对已有行抛 `PORT_CONFLICT`）。并发测试 `mcp-write.test.ts:246-278` 靠 `Promise.all` 时序，是否真的走到这个分支是运气（推测），没有强制触发它的用例。
- 建议：加一个直接抛 CONFLICT 的桩用例，证明“重试一次后返回已保存”这条路径。

**3. 低 · apps/agent-service/src/production-mcp-read.ts:223 · `MCP_WRITE_SECRET_REUSED` 检查无测试**
- 证据：`if (options.write && options.write.secret === options.secret) throw new Error("MCP_WRITE_SECRET_REUSED");` 全仓库仅此一处，无任何测试引用（已 grep）。配置层的同引用拒绝有反向测试（startup-configuration.unit.test.ts:1495-1526），但“两个不同 ref 解析出同一个值”这层兜底没测。
- 建议：补一条单测。

**4. 低 · apps/agent-service/src/production-mcp-read.ts:190-198 · `elicitationSupported` 把空对象视为支持 form，且该分支只测了“完全不支持”**
- 证据：`const modes = Object.keys(elicitation); return modes.length === 0 || modes.includes("form");`。客户端声明 `elicitation: {}` 会被当支持 form；只声明 `{"url":{}}` 会被正确拒绝。集成测试只覆盖 `elicitation === false` 一种反向（mcp-write.test.ts:280-289）。
- 建议：补 url-only 声明的用例（预期回 UNSUPPORTED）。

**5. 信息 · packages/prompt-catalog/src/trusted.ts:10-13 · 新增提示词进入模型出口遮盖的可信文字清单（机制核实，非违规）**
- 证据（读代码证实）：`TRUSTED_PROMPT_TEXTS` 收集 `tools.js` 全量导出，本 PR 新增的 12 条 MCP 提示词（tools.ts:261-372）全部进入该清单；`model-egress.ts:225` 和 `redaction.ts:248-250` 用它豁免 ≥24 字片段的敏感检查。因为这些字符串在本 PR 之前不存在于任何已发请求里，**既有对话的请求字节不会因此改变**；这正是规则 53「清单在一个构建内固定」的既定一次性代价。`trusted-prompt-egress.unit.test.ts:148-149` 会自动校验新增片段 ≥24 字。
- 建议：无需改动，部署时知悉即可。

**6. 信息 · 未核实项**
- `prompt-manifest.json` 里 12 条新增 sha256 是否与源文字一致——无法运行校验脚本，未核实。
- SDK `createRequestStateCodec` 的 HMAC/TTL 实现细节——依赖 `@modelcontextprotocol/server`，ADR 引用了 d.mts 原话；集成测试证明了篡改被拒、同令牌重发可通过，TTL 分支无测试（ADR 0225 自己已声明“没有自动测试的地方”）。

---

## 侧重检查

**走查的普通流程（写令牌，确认后保存）**：写令牌连 `/api/mcp/v1` → `admit()` 按 writeGate 鉴权+限流并注入 `authInfo{scopes:["himawari:write"]}` → `tools/list` 看到 4 个工具（read 3 + propose_memory，legacy era 不注册，测试证实）→ `propose_memory{text}` → 规范化/长度/分类校验 → `elicitationSupported` + `ready()` → 回 `input_required`（确认表单 + HMAC requestState）→ 主人勾选提交 → 客户端带原 state 重发 → 验签/TTL/bind（方法名+令牌种类）→ `argsHash` 比对 → `decided()` 先查两种账本 id 再查记忆 → `keep()`（latestGeneration → storeText → applyProposal → 账本 append，append 带 `ON CONFLICT (id) DO NOTHING`）→ 回「已保存」→ 投影后 `find_memories` 能找到。
- 有测试覆盖：这条主路径在 `test/integration/mcp-write.test.ts` 用真实 SQLite、真实记忆服务、官方 SDK 客户端端到端覆盖（含 3 种拒绝、不支持确认框、并发只写一条、键序不同同提议、篡改 state 抛错、state 配别的内容回 CHANGED、硬删除后重放不复活、拒绝记账失败回 FAILED、每日回顾+校准排除）。
- 无测试覆盖的代码路径：`keep()` 的 CONFLICT 重试分支（问题 2）；TTL 过期分支；`elicitationSupported` 的 url-only 分支；`MCP_WRITE_SECRET_REUSED`；生产 payload protector 对 `memory-content:mcp:*` ref 的深层校验（集成测试用的是 reference adapter，生产 keyring 校验未核实）。
- 文档一致性：ADR 0225 决定 1–8 逐条对照代码均相符；ADR 0219 只补了一行指向 0225 的链接；提示词清单 12 条与 tools.ts 一一对应。ADR 里「两个重发同时到达时，后到的那个撞上记忆主键冲突，重读一次」与代码 catch CONFLICT 后重跑 `applyProposal` 的行为一致。

---

## 必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？——不会（读代码证实）。**
本 PR 改的是外部 MCP 入口、决策记录、每日回顾、校准 SQL、控制中心 UI，全部不触碰 Himawari 发给模型的请求组装路径。唯一间接触点是 prompt-catalog 新增 12 条 → `TRUSTED_PROMPT_TEXTS`（模型出口遮盖的可信清单），但这些字符串此前不存在于任何已发内容，不可能出现在历史里，故历史遮盖字节不变（证据：trusted.ts:10-13、redaction.ts:248-250、model-egress.ts:225）。发给模型的内容仍然只追加、每轮变化值仍在最后一条消息的格局未被触碰；`check:prompt-prefix` 的被测对象没有任何改动。

**2. 会不会让同一段文字在不同请求里变成不同字节？——不会（读代码证实）。**
确认框文字 `renderPrompt` 的输入全部来自本次请求的确定值（client 名经 `CLIENT_NAME` 正则截取、规范化后的 text、category）；`argsHash` 用 `JSON.stringify([text, category])` 固定数组顺序（有“键序不同算同一提议”的测试证实）；`normalizeProposalText` 是纯函数，清单遗漏（问题 1）不影响确定性；账本里的时间戳是存储数据不是模型文字。校准 SQL 的 `LIKE 'mcp!_proposal!_%' ESCAPE '!'` 转义正确、无顺序依赖。

**3. 有没有对应的自动检查、反向用例会不会真失败？——有，且覆盖良好（读代码证实）；个别分支缺测。**
`mcp-write.test.ts` 的反向用例是集成级的：篡改 state 会被 SDK 验签拒绝（`rejects.toThrow(/requestState/u)`）、state 配别的内容回 CHANGED、不支持 elicitation 拒绝不写、拒绝记账失败回 FAILED 而非谎称已拒绝、只读/legacy 连接看不到写工具。配置层 `startup-configuration.unit.test.ts:1495-1526` 有 4 个反向输入。缺测的分支见问题 2、3、4 和 TTL（作者已在 ADR 声明）。

**4. 每个值的两端校验都能接受吗？——能（逐个核对过，读代码证实）。**
- `writeSecretRef`：产生于 strict-configuration.ts:1104-1113（拒绝与 secretRef 相同）+ 1466-1470（强制 purpose=mcp-write、唯一匹配）→ 消费于 service-main.ts:1769-1773（按 ref+purpose 查找，查不到则不启用写）→ 构造器再查两值不同（production-mcp-read.ts:222-224）。三层校验齐，有反向测试。
- 记忆 id `memory:mcp:<uuid>`：消费端 `assertMemoryShape`（sqlite-memory-operations.ts:631-677）不限前缀、只校验形状，通过；控制中心/报表/写端三处前缀字符串有一致性测试钉住（memory-source-report.test.ts:31-40）。
- contentRef `memory-content:mcp:<uuid>`：`PayloadRef` 是纯 string（ports/common.ts:15）；saveWithProjection 校验 payload 存在且分类一致（sqlite-memory-operations.ts:742-755），writer 先 `#storeText` 保证存在。通过。
- 账本写入：`validateLedgerWrite`（sqlite-decision-ledger-operations.ts:51-109）——id/reasonCode 长度、outcome 白名单（`kept`/`discarded` 都在 memory_candidate，decision-ledger.ts:44-52）、category 九类全在 DECISION_CATEGORIES（:85-96）、confidence 1000 在 0–1000、durationMs `Math.max(0,…)` 满足 ≤86400000。全部通过。
- 属性：importancePermille 500、sensitiveTopic ∈ {health, finance, other} 都在 CATEGORIES/SENSITIVE_TOPICS 白名单（sqlite-memory-operations.ts:138-159）。通过。
- `mcp_proposal_*` 原因码的消费方共三处（daily-review 跳过 declined、校准 SQL 排除前缀、测试过滤），无遗漏的穷举 switch；`approval_rejected` 等 reasonCode 的现有枚举（automatic-memory.ts:148-163）是抽取审计联合类型，与账本原因码无关，不需扩展。
