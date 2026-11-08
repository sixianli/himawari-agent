## 复核结论（3af08b66，仅核对 $1ccb...3af$ 增量）

本次增量共改动 11 个文件，实际是 4 处修改：`locateMaskedValues`（redaction.ts）、`mailBodyWindow` 抽取与邮件上报改造、后台记录按 runId 丢弃（sqlite）、`egressRunScoped` 透传（pi-model-transport）。逐处已对照代码。

### 问题清单（按严重度从高到低）

**1.（低）packages/sensitive-capture/src/redaction.ts:341-356 + packages/sensitive-capture/src/machine-secrets.ts:67-71 — 机器密钥配对在“同一值串在更早位置未被替换”时会错配**
- 问题：`machinePositions` 用 `input.indexOf(value, next)` 在原始输入里找 sighting 位置（redaction.ts:348），假设“该值第一次出现 = 实际被替换的位置”。但 `redactMachineSecrets` 按规则表顺序各跑一遍 `replace`（machine-secrets.ts:67-71），同一值串可能在一个位置因边界条件（`\b`、`\b...{16}\b` 的回溯）不匹配、在另一位置被替换。此时 sightings 排序依据（错误的首现位置）与占位符在遮盖后正文中的真实顺序可以不一致，两个机器密钥占位符会拿到对方 sighting。
- 证据：redaction.ts:341-356（indexOf 定位 + 按位置排序）；398 行的 `machineIndex !== ordered.length` 只能兜住数量不符，兜不住“数量相符但顺序错”。
- 影响：两种误配都发生在 `kind === "machine-secret"` 内部，`reportMasked` 的指纹是对 kind+value 哈希（model-egress.ts:494-498），被上报的 (kind,fingerprint) 集合不变，只有 DB 行的 `rule_id` 标签可能互换（记录的 dedupe key 也不含 ruleId，sqlite-sensitive-interception-operations.ts:61-75）。跨类型（机器密钥 vs 卡号/密码）交叠不会走到这里：机器密钥替换在先（redaction.ts:209），后续规则看到的是占位符，`(?!\[)`（216 行）和“尾号”护栏（260 行）在两种运行里行为一致——这些推断证实了作者对配对的三种质疑情形：非机器密钥每个出现位置有独立编号（tag 计数，371-376 行），同值多次出现按顺序配对，编号占位符若让后续规则行为不同，397 行的 `text !== redactForEgress(input).text` 必定返回 null（392-393 任何找不到的 tag 也返回 null）。
- 建议：对每个值先数它在 `input` 中的出现次数并与该值的 sighting 数比对，不等就返回 null 走近似回退；或按替换发生位置（在过滤后的字符串上重放匹配）而非原串 indexOf 定位。严重度低，不阻塞。

**2.（低，仅提示）packages/application/src/services/proactive-mail-check-service.ts:191-193 — `locateMaskedValues` 返回 null 时的回退仍会漏/多报窗口边界附近的值**
- 回退分支 `findSensitiveValues(windowMailBody(body, limit).text)` 与旧逻辑相同，在遮盖规则的上下文（如 CODE_WINDOW=40 的关键词窗口）跨头部/尾部切口时，记录与实际发送内容仍可能不一致。这是第 2 轮已承认的固有近似，本次未恶化，但正文恰好含有预存占位符（如正文里写了 `[密钥]`）就会永远走到回退路径，修复失效且无警告。
- 建议：在回退路径埋一次性日志/统计，便于发现回退被频繁触发。（推测：触发频率未知，未核实线上分布。）

### 核对作者的说法

**修改一（runId 后台记录丢弃）— “读代码证实”正确**
- sqlite-sensitive-interception-operations.ts:138-155：`threadId===null && runId` 才查 runs，查到 `undefined`（run 不存在）直接 skip；查到 thread 后还过 `threadExists` 复核；`run===null`（runs 行存在但 thread_id 为空）仍按原逻辑保留为未关联记录，与旧代码一致。
- 只有一处打开：`egressRunScoped: true` 全仓仅 production-model-composition.ts:335 一处，且 action-review 的 context 是 `threadId: null`（331 行）；邮件判断等辅助通道不带该标志（461-485 行无此字段）。pi-model-transport.ts:283-287 只在开关打开时把 `request.runId` 并入 context；model-egress.ts 里 context 只进 `#report`（127-135 行），不参与 requset body 的遮盖/序列化，不改变发出的字节。
- 测试：pi-model-transport.unit.test.ts:517-524 同一 body 两次调用，带开关的报告 context 带 runId、不带的不带；integration 测试改写为 `recorded:1, skipped:1` 且列表只剩 `[THREAD_ID]`——旧代码（`?? null` 后不丢弃）会产生 `[null, THREAD_ID]`，旧断言确实过不了，反向力成立。
- “邮件判断的 runId 是合成的、不带”：service-main.ts:1550-1552 mail-judgment context 证实。

**修改二（邮件截断偏差）— “读代码证实”正确，一处低严重度边缘（问题 1）**
- `proactiveMailView`（220-248 行）对正文是“先遮盖再截断”，`locateMaskedValues`（192 行）拿的是同一个 body；397 行的 final-text 等值守卫保证 `located.text` 与实际发给遮盖层的一句话逐字相同；`sentBodyValues` 的窗口（207-213 行）与视图用的 `mailBodyWindow` 同参数同函数（proactive-mail-body.ts:10-18, 20-31），占位符是原子串，按占位符首尾码点是否落在 head/tail 过滤与实际发送内容逐值一致（`pointAt` 映射 UTF-16 索引→码点索引，194-205 行）。#reportMasked 用的 bodyLimit 与组装 prompt 的相同（519/530 行 vs 268 行）。
- `[SI-3]` 反向力经静态推算成立：HEAD_SHARE=0.7（proactive-mail-body.ts:3），旧逻辑按原始正文窗口（约 3105 码点、head 273）统计，shiftpass99（约 390 码点处）和满 15 张卡号的计数断言都会失败。此推算未实际执行测试。

**四条“判为不成立”**
- 去重键迁移：0078 迁移文件确属本 PR 新增（c79..3af 的 diff 清单内），表未上线合理——代码证实，部署状态未核实。
- 清除迟到上报：遮盖/上报在 `#check` 时同步算好（530 行，先于 200ms 后的 `#drain`），写入时按当时的 runs 表丢弃——“读代码证实”成立。
- “第 5 条 try 缺测试”：`see` 包住 observe 异常（redaction.ts:178-185），`#reportMasked` 整体也有 try/catch（387 行），“会出错的输入先进不了模型请求”是合理推断——推测，未找到反例。
- “请求内合并测试实际撤修复跑过会失败”：未核实（工具不允许运行测试）；静态看 reportMasked 的按 kind+fingerprint 去重（model-egress.ts:493-502）与 recorder 的 key upsert 有对应断言。

### 必答问题

1. **不会改变模型已见过的请求开头。**本增量不改对话提示词组装、历史序列化和工具定义；`egressRunScoped` 只改上报用的 context（model-egress.ts 中 context 仅进 `#report`），`locateMaskedValues`/`sentBodyValues` 只产生记录不发请求。已在 prompt-prefix.compat.test.ts 中有 `[SI-2]` 用例断言“开了记录的请求字节与不开完全一致”及多条 REVERSE 用例。邮件判断是单次后台调用，固定指令在前、`now`（每轮会变的值）仍在最后一条消息（proactive-mail-check-service.ts:264-270）。
2. **不会。**`locateMaskedValues` 无时间、无随机、无集合遍历依赖（tag 计数器顺序生成、machine 位置走确定性 indexOf）；实际发送路径 `maskSensitiveText` 不带 known/table，逐字节确定；上报 sighting 顺序为数组序而非 Set 遍历。记录里的可变字段是写入时间与计数，只进数据库不进模型。
3. **有对应自动检查，反向力经静态核对成立。**redaction 单测 2 条（含预存占位符必须返回 null）、`[SI-3]` 集成测试（旧逻辑下卡号计数与 shiftpass99 断言失败）、pi-model-transport 的开关双向断言、sqlite 的 skip 断言（旧代码过不了）、prompt-prefix `[I-66]` 含 REVERSE 用例。因工具受限我未实际运行测试，此点标“未实际执行”。
