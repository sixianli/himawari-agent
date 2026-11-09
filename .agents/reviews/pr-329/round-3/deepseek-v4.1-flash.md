## 复核范围

增量 `aa0b38f..a69b4a3` 只改了 `docs/agent-rulebook-inventory.md`（3 行改动）和 `.agents/reviews/pr-329/round-2/*` 复核记录；相对 `18cbf8a` 的累计改动也只有该文档和复核记录。没有代码、配置、迁移改动。

---

## 按严重度排列的问题

### 1. 中 — C 节新句子没有“写全”注入条件，和同节 M-3 冲突

- 文件:行：`docs/agent-rulebook-inventory.md:158`
- 问题：作者说法“C 节写全 rule 类记忆注入的条件”不成立。新句列了生效中、非待确认、未被取代、未过期、分类允许、未被主人设成“不带”，但漏了同节 M-3 的 2000 字预算，以及“原文读不到/为空”的过滤。满足新句全部条件仍可能因预算被丢进排队列表。“要……才会注入”也容易被读成“满足这些就一定注入”。
- 证据：
  - 文档 `:158`：“要生效中、不是待确认、未被取代、未过期、分类允许、主人没设成“不带”才会注入（M-4、M-5）”
  - 文档 `:146`（M-3）：“规则和档案共用 2000 字，规则先取，放不下的排进“排队”列表，那一轮模型就看不到它”
  - `packages/application/src/services/owner-profile-service.ts:170-187`：
    ```ts
    const limit = this.#options.characterBudget ?? OWNER_PROFILE_CHARACTER_BUDGET;
    ...
    if (!text) continue;
    if (text.length + 3 > remaining) {
      queued.push(memory.id);
      continue;
    }
    ```
- 建议：改为“要生效中、不是待确认、未被取代、未过期、分类允许、主人没设成‘不带’，且原文非空、放得进 2000 字预算（M-3），才**可能**注入”；或明确说明这些只是必要条件。

### 2. 低 — 新造“主人规则”块名，与文档和代码的“主人的要求”不一致

- 文件:行：`docs/agent-rulebook-inventory.md:158`（对照 `:145`、`packages/prompt-catalog/src/runtime.ts:43-50`）
- 问题：新句使用“「主人规则」块”，同一节 M-2 和实际提示词标记都叫“主人的要求”。同一文档出现两个名字。
- 证据：
  - 文档 `:145`（M-2）：“放进“主人的要求”资料块”
  - `packages/prompt-catalog/src/runtime.ts:43`：“‘主人的要求’资料块前面的标记”
  - `packages/prompt-catalog/src/runtime.ts:48`：`text("[Himawari 主人的要求 ")`
  - 代码中的块标识是 `kind = "owner-rules"`（`owner-profile-service.ts:33`）
- 建议：统一写成“主人的要求”资料块，或注明“代码里 kind 为 `owner-rules`，提示词标题是‘主人的要求’”。

### 3. 低 — “现在只写了这一条”与所引原文含两条要求不一致

- 文件:行：`docs/agent-rulebook-inventory.md:170`
- 问题：新 C-1 引用的原文含两条独立要求，后文却说“现在只写了这一条”；“原文只有一行”也可能被读成“只有一条规则”。全文按“54 条”计数，这里容易产生口径疑问。
- 证据：文档 `:170`：“原文只有一行：「修改或删除文件前先确认路径和内容；会覆盖或删除大量内容的操作，先向用户说明。」……现在只写了这一条”
- 建议：改成“这一行配置含两条要求”或“只有这一行”，并在计数口径上说明 C-1 按一个配置项统计。

### 4. 低 — “以后新产生的”把适用范围说窄了

- 文件:行：`docs/agent-rulebook-inventory.md:158`
- 问题：这些条件不只约束“新产生”的 rule 记忆；已存在的归档记忆恢复成 active 后同样适用。新句只提“以后新产生的”，容易被读成“旧的/恢复的不受这些条件约束”。
- 证据：
  - `packages/application/src/services/durable-memory-service.ts:349-365` 的 `recover` 只把 `status` 改成 `"active"`，`attributes`（含 `tentative`）保留。
  - `owner-profile-service.ts:162-169` 对 `listActive` 返回的所有记忆统一做 status/分类/`currentlyValid`/`choices` 过滤。
- 建议：改成“任何进入选择的 `rule` 记忆（新产生，或从回收站/归档恢复）……”。

### 5. 低 — 新句点名的“未被取代/未过期/非 active”没有真正的反向用例

- 文件:行：`packages/application/test/owner-profile-service.unit.test.ts:139`（及文档 `:147` 引用该测试）
- 问题：作者说法中隐含这些条件有测试守着，但现有测试无法在删掉 `supersededBy`、`validTo`、`status` 判断时失败。测试里唯一带 `validTo` 的记忆是 `event` 类，而 `event` 本来就不在 `PROFILE_SECTIONS` 里；即使去掉 `validTo` 过滤，它也进不了结果。全文没有 `supersededBy` 或非 `active` status 的断言。
- 证据：
  - 测试 `:139`：`memory("memory-trip", "event", 900, { validTo: "2026-10-07" })`
  - `owner-profile-service.ts:24-30` 的 `PROFILE_SECTIONS` 只含 `identity/preference/relationship/goal/project`，不含 `event`。
- 建议：补三条反向用例：`supersededBy` 非空；`validTo` 已过且 category 在 `PROFILE_SECTIONS`；mock `listActive` 返回 `trashed/archived`。这样删掉任一判断都会失败。

---

## 未核实

以下内容仓库内无法核对，我标“未核实”，不作为已证实缺陷：

- “2026-11-09 经 Andy 授权只读、并同意补进清单”以及生产 `systemInstruction` 的原文内容；仓库内只能看到测试夹具示例（`docs/runbooks/install-start-stop-runbook.md:463` 是示例值）。
- 生产库 3 行的实际值：日期、`deleted_verified`/`trashed`、待确认、700/750/850/950‰、使用次数 6/0/0、`private`、非推断、`memory:memory-capture:` 前缀。我只能确认这些字段/枚举/数字格式是代码接受的合法值，不能确认真实数据。
- H-9 里“生产配置为日本时间”是既有表述，不属于本次增量；它和新句“这次只查了 systemInstruction 以外的设置没查”不严格冲突（“这次”限定本次任务），但读者可能追问来源。

---

## 侧重检查

我按错误路径、不规范/不可信输入、安全、资源耗尽、不可撤销操作、规则文档与代码一致性逐项查了：

- **错误路径**：`currentlyValid` 对 `attributes` 缺失返回 false，并排除 `supersededBy !== null`、`tentative === true`、`validTo` 已过（`owner-profile-service.ts:97-102`）。`recover` 不改 `attributes`（`durable-memory-service.ts:359-364`），所以“trashed 那条恢复后仍是待确认、不确认不会注入”这句话是对的。
- **不规范/不可信输入**：表格里的状态是 `MemoryLifecycleStatus` 的合法枚举（`packages/domain/src/durable-state.ts:388-393`、`packages/application/src/ports/memory-projection.ts:58`）；千分制数字合法。没有发现 I-73 那种“清单里的值过不了后端校验”的问题。
- **安全**：新增的是生产 `systemInstruction` 原文，属于主人规则文本，不是密钥；文档里也没有出现凭据。
- **资源耗尽**：相关限制是 2000 字预算，新句漏了它（见问题 1）。
- **不可撤销操作**：`deleted_verified` 是终态（`durable-state.ts:411`），`trashed` 可恢复（`:409`）；文档只是描述现状，没有建议执行不可撤销操作，描述与代码一致。
- **规则/文档/代码一致性**：发现“主人规则”与“主人的要求”命名不一致（问题 2）、“写全”与 M-3 不一致（问题 1）、“只写了这一条”与两条要求不一致（问题 3）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会。本次只改文档和复核记录，没有改任何发给模型的内容。文档 C-1 描述的 `systemInstruction` 在 `apps/agent-service/src/production-run-policy.ts:116` 拼进系统提示：

```ts
`${HIMAWARI_IDENTITY}\n\n${policy.systemInstruction}\n\n${ANSWER_LANGUAGE_RULE}\n\n${capabilities}`
```

本次没有改这段代码或配置。记忆/规则块由 `packages/runtime-pi/src/runtime-environment-block.ts:12-13,30-43` 放进 `<himawari-context>`，属于最后一条用户消息。结论：仍然只在末尾追加，每轮会变的记忆选择、时间等都在最后一条消息里，不进入请求头。

**2. 同一段文字会不会在不同请求里变成不同字节？**

不会。文档本身不进入请求。代码侧相关选择顺序是确定的：`owner-profile-service.ts:104-114` 按 `pinned`、`importancePermille` 降序、`id` 升序排序；新增文字没有引入时间字段或无序集合。`currentlyValid` 依赖 `now`，但只影响最后一条用户消息里的资料块选择。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**

- 这个文档改动没有自动检查：仓库里没有测试引用 `docs/agent-rulebook-inventory.md`；提交说明写 `Layer-0-tests: none`，只跑了 `check:glossary`。`check:markdown-tables`/`check:glossary` 只能查格式和旧词，不能验证文档陈述与代码一致。
- 底层代码有 `[PA-2]`（待确认）、`[MEM-PIN]`（不带）、敏感分类、预算等用例，反向用例是真的会失败。
- 但新句点名的“未被取代/未过期/状态非 active”没有反向用例（问题 5），删掉这些判断测试不会失败。这是本次新增描述的覆盖缺口。

**4. 每个改动值的生产者和使用者是否匹配？**

- `deleted_verified`/`trashed`：`memory-projection.ts:58` 合法；`sqlite-memory-operations.ts:942-953` 的 `listActive` 只返回 `status = 'active'`，所以“这 3 条都不会注入”成立。
- `memory:memory-capture:` 前缀：`production-memory-capture.ts:585` 生成 `memory:${generation}:${ordinal}`，`:781` 的 generation 是 `memory-capture:${runId}`，与表格说法一致。
- `importancePermille`/`confidencePermille`/`useCount`/`recordedAt`：字段存在（`memory-projection.ts:28-71`），千分制格式合法。
- `/etc/himawari/config.json` 的 `runPolicy.systemInstruction`：`packages/platform-node/src/strict-configuration.ts:1125-1129` 接受并限制不超过 16384 字节，`:1161` 写入；`production-run-policy.ts:116` 消费，两端一致。
- “主人规则”这个清单项：代码里没有这个标识，实际是 `kind = "owner-rules"`、提示词标题“主人的要求”（`runtime.ts:48`），与文档新词不一致（问题 2）。
- 生产数据值和 Andy 授权：未核实。总体上没有发现 I-73 式“清单里的 id/值过不了后端校验”的问题。
