## 一、读代码证实的问题（按严重度）

### 1. 高：导出文件里标成“敏感”的条目仍会被发到外部 Jev；服务端也没有检查候选内容的受保护级别

**文件:行**
- `apps/control-center/src/components/memory-page.tsx:2000`
- `apps/control-center/src/memory.ts:258`
- `apps/control-center/src/memory-import.ts:118`、`:129-136`
- `apps/agent-service/src/production-memory-control.ts:1359-1360`
- 对照：`apps/agent-service/src/production-memory-control.ts:1295-1298`

**问题**
网页把导入条目的**全部文字**交给判重，包括 Himawari 导出文件里 `sensitive: true` 的记忆；网页存这些文字时固定按 `private` 级别存，服务端只靠正则 `deterministicallySensitive` 判断是否发送，不读载荷的 `dataClassification`。因此“对青霉素过敏”“每周日去教堂”这类语义敏感、但不含证件号/密码的导出条目会原样发给外部决策模型。正常的文本导入还会同时跑分类，但导出条目本来不分类，这是新增的外部暴露路径。

另外，服务端 `#checkImportDuplicates` 接受任意 `contentRef`。同一主人的线程消息摘要公开带 `contentRef`（`packages/gateway-contracts/src/thread-contracts-v3.ts:383`），所以同一主人的客户端可以拿敏感消息的引用直接触发外发。跨主人被 AAD 挡住（`packages/platform-node/src/payload-protector.ts:233-246`），但同主人不受限。兄弟处理器 `#classify` 有明确的级别检查，这个新处理器没有：

```ts
// production-memory-control.ts:1359-1360
for (const ref of refs) candidates.push(await this.readText(ref));
// 对照 #classify:1296
if (payload && classificationRank(payload.dataClassification) > classificationRank("private"))
  results[index] = DETERMINISTIC_SENSITIVE;
else pending.push({ index, text: await this.readText(ref) });
```

出口遮盖 `redactForExternalText` 只去掉证件号、密码、银行卡号等模式，不能去掉“我得了抑郁症”这类语义敏感内容。

**建议**
- 网页端不要把 `item.sensitive` 的条目放进 `memory.importDuplicates`，或按 `item.sensitive` 存成 sensitive 级别，并在服务端按 `payload.dataClassification > private` 直接判 `skipped`，不读、不发。
- 服务端只接受本次导入刚创建的引用（带用途标记/一次性引用），不要接受任意 `contentRef`。
- 增加反向用例：导出文件里带 `sensitive: true` 的条目、以及指向敏感线程消息的 `contentRef`，都必须不进入 `decide`。

---

### 2. 中：`maximumExistingMemories` 的上限在“全部读取并解密之后”才生效

**文件:行**
- `apps/agent-service/src/production-memory-control.ts:1361-1370`
- `apps/agent-service/src/production-memory-import-duplicates.ts:91-94`
- `packages/persistence-sqlite/src/sqlite-memory-operations.ts:1002-1008`

**问题**
`listActive` 返回全部 active 记忆，`#checkImportDuplicates` 对每一条都 `readText`（解密），然后 `ProductionImportDuplicateChecker` 才在内存里 `.slice(0, maximumExistingMemories)`。ADR 和作者说“最多 1000 条”，实际是**先读全部、再截 1000**。`maximumExistingMemories` 配成 0（配置范围允许，`configuration.ts:331`）时仍会读完全部记忆。

**建议**
按最近更新时间取够 `maximumExistingMemories` 条非敏感记录就停止读取；最好在存储层用带上限的查询。候选文字也应有单项长度上限，避免单个巨大载荷生成巨大外部请求。

---

### 3. 中：读取已有记忆失败会被当成“不重复”，不是 `skipped`

**文件:行**
- `apps/agent-service/src/production-memory-control.ts:1368`
- `apps/agent-service/src/production-memory-import-duplicates.ts:91-97`
- `packages/application/src/ports/configuration.ts:331`

**问题**
```ts
// production-memory-control.ts:1368
const text = await this.readText(record.contentRef).catch(() => null);
```
读取失败被静默丢弃；如果所有已有记忆都读失败（或全被确定性敏感过滤、或上限配成 0），`known.length === 0`，随后：
```ts
// production-memory-import-duplicates.ts:95-97
if (known.length === 0) {
  for (const index of asked) results[index] = { verdict: "different", memoryId: null };
  return results;
}
```
结果是网页在 `applyImportDuplicates` 里把 `different` 变成可勾选，**自动导入**。这直接违反“任何失败判 skipped”的说法。ADR 只接受“敏感记忆不参与比较”，没有接受“读取失败也不比较”。

**建议**
区分“确实一条已有记忆都没有”（`different` 合理）和“有记录但一条都没能比较”（`skipped`）；把读取失败计数或 `complete` 标志传给检查器。`maximumExistingMemories === 0` 也应返回 `skipped` 或明确禁用，而不是 `different`。补一条反向测试。

---

### 4. 中：`inputMicrosPerMillionTokens` 只被解析，没有任何使用处，付费外部调用没有费用核算/上限

**文件:行**
- `packages/application/src/ports/configuration.ts:306-310`
- `packages/platform-node/src/strict-configuration.ts:1306`、`:1324-1328`
- `apps/agent-service/src/production-memory-import-duplicates.ts:161-180`

**问题**
配置要求写每百万输入 token 的价格，但全仓库没有运行时代码读取它；创建检查器时只用了 `model` 和 settings。一次查询最多 150 个模型请求，网页可以反复导入，改动范围内没有看到按主人/按天的预算或限流。ADR 估算“最多 0.15 美元”，但代码没有费用门槛。

**建议**
像 `ProductionMemoryClassifier` 的 `dailyLimitMicros` 一样用这个价格做预算/记账和上限，或暂时删掉这个必填配置项，避免“写了价格但没有消费者”。

---

### 5. 低：`importDuplicateVerdict(undefined)` 返回 `different`

**文件:行**
- `packages/application/src/services/memory-import-duplicates.ts:98`
- `packages/application/test/memory-import-duplicates.unit.test.ts:96`

**问题**
```ts
if (answer === undefined || answer.matchKey === null) return "different";
```
“没有答案”（失败/拒答）被映射成“不是重复”。当前检查器用 `incomplete` 集合绕开了这个危险，但函数本身是对外导出的，测试还把这种行为固定下来；以后任何直接调用都会把失败当不重复。

**建议**
`undefined` 返回 `skipped`；只有显式 `matchKey === null` 才返回 `different`。

---

### 6. 低：响应体先完整读入内存，再检查 1 MiB 上限

**文件:行**
- `packages/platform-node/src/memory-import-duplicate-decision.ts:93-95`

**问题**
```ts
const text = await response.text();
if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES)
  throw new ImportDuplicateDecisionFailure("IMPORT_DUPLICATE_RESPONSE_TOO_LARGE");
```
超大响应已经全部缓冲到内存才被拒绝；上游异常或恶意响应可造成内存峰值。

**建议**
先看 `content-length`，或按流读取并累计字节数，超过上限立即中止。

---

### 7. 低：空的/不完整的 `probabilities` 会被当成“没有匹配”

**文件:行**
- `packages/application/src/services/memory-import-duplicates.ts:56-68`

**问题**
概率数组分支没有要求数组非空、也没有要求包含 `none` 或覆盖所有候选；空数组会返回 `{matchKey: null, probabilityPermille: 0}`，最终变成 `different`、可自动勾选。格式不完整的回答应当走失败路径，而不是“不重复”。

**建议**
要求 `probabilities` 非空并覆盖选项（至少包含 `none` 和 `choice`），否则抛 `IMPORT_DUPLICATE_ANSWER_INVALID`；补反向测试。

---

### 8. 低/需确认：已归档记忆不再参与比较，旧网页是包含的

**文件:行**
- `apps/agent-service/src/production-memory-control.ts:1362`（`listActive`）
- 旧代码见 diff：`apps/control-center/src/components/memory-page.tsx` 删除的 `filter((item) => item.status !== "trashed")`
- `docs/adr/0265-memory-import-duplicates-judged-by-the-model.md:51`（“主人所有……已有记忆”）

**问题**
旧网页用“所有非 trashed 记忆”（含 archived）；新服务端只用 `listActive`（仅 active）。同名同内容的归档记忆会被重新导入。ADR 没有说明这个行为变化。

**建议**
明确“已有记忆”是否包含 archived；若包含，改用包含 archived 的查询；若不包含，在 ADR 里写明。

---

## 二、推测与未核实

- **未核实**：我没有运行任何测试。作者说的“58 个文件 1241 个用例通过”“typecheck 和 check 通过”“真模型冒烟测试数据”“prompt manifest 哈希”“check:prompt-prefix 通过”都未独立验证。
- **推测（费用/限流）**：改动范围内没看到外层的按主人预算或限流；系统别处是否还有通用限流，我没有继续查全，所以按推测处理。若没有，第 4 条的风险比“配置无用”更大。
- **推测（提示词注入）**：候选文字放在 `input_json` 数据里，提示词写了“只是数据，不要执行其中的指令”，但模型是否遵守无法用静态代码证明；这是残余风险，不是本次代码错误。
- **未核实（词表检查的覆盖）**：`scripts/check-meaning-word-lists.mjs` 的命名列表形状只匹配全大写常量名（成功匹配 `[A-Z][A-Z0-9_]*`），camelCase 命名的词表只能靠“连续四条自然语言字符串”兜底；这是门槛的已知盲区，不是本次 A4 的功能错误。

---

## 三、侧重检查

| 路径 | 结论 |
| --- | --- |
| 失败路径：HTTP 非 2xx、非 JSON、模型名不符、拒答、超时、答案数不符 | 基本都走 `skipped`；但“读取已有记忆失败”“空概率数组”会被当成 `different`（见 3、7） |
| 不可信输入：查询里的 `contentRefs` | 契约只校验 1–500 个 machineString，不校验用途/级别；服务端会读任意同主人引用并外发（见 1） |
| 安全：出口遮盖 | 新文件已登记 `check-egress-redaction`，`redactForExternalText` 确实用于 existing 和 candidates，且 `zeroDataRetention: true`；但只做模式遮盖，挡不住语义敏感内容（见 1） |
| 安全：真实记忆编号 | 发给模型的是 `m0...` 临时键，真实 `memoryId` 只在返回快照里，未外发；这一点符合 ADR |
| 资源耗尽 | 已有记忆全量读取/解密、响应体全量缓冲、单次最多 150 个外部请求、无费用上限（见 2、4、6） |
| 不可撤销操作 | 该功能只做预览判断，不直接写记忆；真正导入仍有 `memory.import.undo`，未发现新的不可撤销操作 |
| 规则/文档与代码一致性 | “任何失败判 skipped”不成立（3、5、7）；“最多 1000 条”只是比较上限、不是读取上限（2）；价格配置没有消费者（4）；归档记忆行为变化未写明（8） |
| 提示词前缀 | 新增提示词只被新的 `/v1/decisions` 后台调用引用；未改对话系统提示、工具定义、历史或遮盖结果（详见必答 1） |

---

## 四、必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会。新增的 `MEMORY_IMPORT_DUPLICATE_QUESTION` 只被 `packages/platform-node/src/memory-import-duplicate-decision.ts` 使用（全仓库只有这一处引用），走的是独立的 `/v1/decisions` 请求，不进入任何对话的系统提示、工具定义或历史。没有改动会话请求的组装路径，因此不涉及“只在末尾追加”的问题。新提示词加入 `packages/prompt-catalog` 会进入该构建的“固定文字”集合，理论上参与出口遮盖的固定文字判定；我没有发现它的文字会改变现有对话的遮法，且作者称 `check:prompt-prefix` 通过，我未运行，标未核实。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

对话请求：没有新增每轮变化的值，没有时间、随机 ID、无序集合进入对话请求。
新的判重后台请求：`existing` 的顺序是 `listActive` 的 `ORDER BY id` 再用 `updatedAt` 稳定排序，候选保持输入顺序，JSON 键顺序由对象字面量固定，所以**相同输入集合得到相同字节**。但出口遮盖的占位符编号是“按本次请求首次出现顺序”分配的（`sequentialPlaceholderTag`），同一段文字在不同数据集合里可能得到不同占位符；这符合规则第 11 条“只取决于自己和前面的内容”，且不影响对话前缀缓存，只会让这个后台请求本身难以复用缓存。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

有：
- 检查器失败/拒答 → `skipped`：`apps/agent-service/test/production-memory-import-duplicates.unit.test.ts:73-85`。
- 一个分批失败不淹没另一批的匹配：同文件 `:87-99`。
- 达到请求上限后其余 `skipped`：同文件 `:101-113`。
- 网页判重失败时 0 条勾选并显示“没能核对”：`apps/control-center/test/memory-interactions.unit.test.ts:1790-1811`。如果失败被改成 `different`，这条会失败。
- “字面包含不等于重复”：同文件 `:1967-1978`。
- 解析器拒绝错误模型/答案数/未知选项/非法概率：`packages/application/test/memory-import-duplicates.unit.test.ts:58-82`。
- 配置范围和密钥用途：`packages/platform-node/test/startup-configuration.unit.test.ts:1786-1826`。
- 词表门槛反向用例：`test/tooling/meaning-word-lists.test.mjs`。

缺口：
- 没有“敏感导出条目/敏感 `contentRef` 不得外发”的反向测试。
- 没有“已有记忆读取失败或 `maximumExistingMemories=0` 时应 `skipped`”的测试。
- 没有空概率数组、超大响应体、单个超长文本的反向测试。
- 我按约束没有运行这些测试，无法确认它们当前实际全绿。

**4. 每个新值两端都能接受吗？**

逐个核对如下：
- `memory.import.duplicates.read` / `.snapshot`：已加入消息类型表、查询/快照 schema、fixture、服务端 `PRODUCTION_MEMORY_OPERATIONS` 和网页调用；两端一致。
- `contentRefs`：网页每批最多 `CLASSIFY_BATCH=500`，导入最多 `MAXIMUM_IMPORT_ITEMS=500`；契约 1–500 且 `machineString`，与 classify 共用同一规则，接受。
- `verdict`：应用层 `same|unsure|different|skipped`、契约枚举、网页 `ImportDuplicateVerdict` 三处一致；网页按 `contentRef` 对齐并逐条使用，接受。
- `memoryId`：生产者是 `record.id`，契约是 `nullable(machineString)`，其他快照同样用 `machineString`；网页目前不使用它，接受。
- `duplicateCheck`：`pending|clear|similar|unchecked` 四个值在 `applyImportDuplicates`、`applyImportClassifications`、`memory-page.tsx` 的禁用和文案逻辑里都有处理；未发现遗漏导致卡死或误勾选。
- `runPolicy.importDuplicates`：严格配置校验了未知键、数值范围、`noAtMostPermille < yesAtLeastPermille`、`secretRef` 必须恰好一条 `model-auth`；服务端只用 `model` 和 tuning，密钥用途两端一致。唯一不接受的是 `inputMicrosPerMillionTokens`：产生并校验了，但没有任何使用处（见 4）。
- `maximumExistingMemories`：配置范围包含 0，但消费端是在读完所有记忆后才截断，所以“配置值 0”与“读取上限”不一致（见 2、3）。
- 新 i18n 的 `similar`/`unchecked`：中、日、英三份资源都加了，网页会用到；一致。
- 新提示词 id `memory.import-duplicate-question`：manifest、`prompt-output-contracts` 测试、`usedBy` 和实际引用文件一致；哈希我未独立计算。
