## 读代码证实的问题（按严重度）

### 中：第 5 轮修复 (1) 「先过滤敏感/受限再判截断」没有对应的自动检查

- 位置：`apps/agent-service/src/production-memory-control.ts:1387`、`apps/agent-service/test/production-memory-import-duplicates.unit.test.ts`
- 问题：代码本身是对的，但没有一条用例会在把这个顺序改回去时失败。现有截断用例两个已有记忆都不是敏感/受限；全敏感用例只有一个敏感记忆且 `existing.length` 始终为 0。两者都走不到「先读满 `limit` 条普通记忆、再遇到敏感记录」这条路径。
- 证据：
  - `production-memory-control.ts:1387-1393`
    ```ts
    for (const record of active) {
      if (record.dataClassification === "sensitive" || record.dataClassification === "restricted")
        continue;
      if (existing.length >= limit) {
        complete = false;
        break;
      }
    ```
  - `production-memory-capture.test.ts` 的截断用例只把 `maximumExistingMemories` 设成 1，两个记忆都是 private；全敏感用例只有一个 sensitive 记忆。
- 建议：补一条反向用例——已有记忆按 `updatedAt` 排成「1 条 private（新）+ 1 条 sensitive（旧）」，`maximumExistingMemories = 1`，候选与 private 那条不同，断言返回 `different`。旧顺序下 sensitive 旧记录会触发 `existing.length >= limit` 而返回 `skipped`，新顺序下应返回 `different`。这样才真正锁住第 5 轮修复。

### 低：新增顺序测试里「第一个请求单独发」的断言几乎是空的

- 位置：`apps/agent-service/test/production-memory-import-duplicates.unit.test.ts:134-152`
- 问题：测试名声称验证「first request alone」，但它在第一个 `decide` 被调用的瞬间检查 `active === 0`。即使实现改成 `Promise.all(jobs.map(run))` 全并发，第一次调用时 `active` 仍然是 0，断言照样通过。真正被锁住的只有后面的 `order`。
- 证据：
  ```ts
  if (order.length === 1) firstWasAlone = active === 0;
  active += 1;
  await Promise.resolve();
  active -= 1;
  ```
- 建议：在第一个桩里用一个 deferred 阻塞，确认第二个请求已经开始后再释放；或者记录「第二个请求开始时第一个是否仍未返回」。否则删除这条名不副实的断言，避免误以为覆盖了「先单独发第一个」。

### 低：ADR 把可配置的默认值写成了硬上限

- 位置：`docs/adr/0265-memory-import-duplicates-judged-by-the-model.md:51`、`:54`、`:87-89`；`packages/application/src/ports/configuration.ts:312-335`
- 问题：ADR 说「最多 1000 条」「一次查询最多发 150 个请求」「每天最多 1500 个请求」，读起来像硬上限；但配置范围允许 `maximumExistingMemories` 到 5000、`maximumRequests` 到 1000、`dailyMaximumRequests` 到 100000。实际代码只把 1000/150/1500 当默认值。
- 证据：
  ```ts
  maximumExistingMemories: [0, 5_000],
  maximumRequests: [1, 1_000],
  dailyMaximumRequests: [1, 100_000],
  ```
- 建议：把这几处改成「默认最多……，范围见 `IMPORT_DUPLICATE_RANGES`」，或把范围收窄到文档写的数。否则上线时调大配置就和 ADR 冲突。

### 低：词表门槛文档没有写明实现的两个盲区

- 位置：`docs/meaning-word-lists.md:22`；`scripts/check-meaning-word-lists.mjs:58-62`、`:14`
- 问题：文档说会找「含三个以上并列词的正则」，实现还额外要求正则里含中日文字符，或含 `ENGLISH_WORDS` 里那几个英文词。纯英文正则（例如只写 `always|never|sometimes`）不会被抓。作者说 Andy 已决定本轮不补，但文档没有任何提示；另外脚本跳过 `apps/control-center/src/i18n/`，文档「没有进来的地方」也没写。
- 证据：
  ```js
  const alternatives = body.split("|").filter(isNaturalAlternative);
  if (alternatives.length < ALTERNATIVES_MINIMUM) continue;
  if (!NATURAL.test(body) && !ENGLISH_WORDS.test(body)) continue;
  ```
  ```js
  const SKIPPED_PATHS = ["packages/prompt-catalog/", "apps/control-center/src/i18n/"];
  ```
- 建议：在文档里写明「纯英文正则只认少量枚举词」「i18n 不扫」，否则读者会以为门槛覆盖面比实际大。这与作者「不补」的决定不冲突，只是把已知局限写清楚。

### 低：确定性敏感的已有记忆仍会占用截断名额

- 位置：`apps/agent-service/src/production-memory-control.ts:1387-1397`；`apps/agent-service/src/production-memory-import-duplicates.ts:123-126`
- 问题：第 5 轮只把「记录级 sensitive/restricted」移到 `limit` 判断前；`deterministicallySensitive(text)` 的过滤仍在 `checker.check` 里、在截取之后。确定性敏感的已有记忆仍会被算进 `maximumExistingMemories`，可能让 `complete` 变 false，把本可回答的条目变成 `skipped`。
- 证据：
  ```ts
  const known = existing
    .filter(({ text }) => !deterministicallySensitive(text))
    .slice(0, this.#settings.maximumExistingMemories)
  ```
  而 `production-memory-control.ts` 在把它交给 checker 前已经按记录级分类截过一次。
- 影响：只会更保守（多判 `skipped`），不会把本该 `skipped` 的判成 `different`，所以不是正确性错误。但和「被挡掉的条数不算进读不全」的目标只完成了一半。
- 建议：如果希望彻底做到，可在读取每条已有记忆时就判断 `deterministicallySensitive`，只把可比较的计入 `limit`；代价是可能需要读到超过 `limit` 条记录，需在 ADR 里写明这个取舍。

### 低：ADR 第 9 条提到的 `normalizeMemoryText` 登记行在登记表里并不存在

- 位置：`docs/adr/0265-memory-import-duplicates-judged-by-the-model.md:58`；`docs/meaning-word-lists.md`
- 问题：ADR 说「`docs/meaning-word-lists.md` 里 `normalizeMemoryText` 那一行随之删除」，但本改动新增的登记表里从未有这一行。读者会去找一条不存在的记录。
- 建议：改成「不新增登记行」或删掉这半句。

## 推测 / 未核实

- **Jev 响应形状**：`parseImportDuplicateAnswers` 要求顶层 `body.model` 与配置的模型名完全相等，并要求每个 answer 有 `type: "choice"` 和 `name: "cN"`；`packages/platform-node/test/memory-import-duplicate-decision.unit.test.ts` 的桩是回显请求模型并自带 `name/type`。仓库里没有真实 Jev 响应样例，ADR 也只写了「返回 choice、confidence、probabilities」。如果真实网关省略或改写 `model`/`name`，所有请求都会失败并被安全地判成 `skipped`（功能整体失效，但不会误导入）。建议用真实网关响应补一条录制的夹具，或放宽 `model` 的校验。
- **候选敏感文本依赖客户端先分类**：`#checkImportDuplicates` 只根据 payload 的 `dataClassification` 和本次进程里的 `#sensitiveJudgments` 挡住候选；后者由 `memory.classify.read` 填充（`production-memory-control.ts:1308-1316`），而 checker 自身只过滤确定性敏感（`production-memory-import-duplicates.ts:121-122`）。控制中心总是先分类再判重，所以正常网页路径没问题；但如果另一个客户端直接调用 `memory.import.duplicates.read` 且跳过分类，只靠模型判断的敏感文本就可能被发给 Jev。是否可接受取决于网关调用方是否只有受信网页，我未能从代码里确认这一威胁模型。

## 侧重检查

- **错误路径**：`decide` 抛错/拒答 → 该批候选 `incomplete`，最终 `skipped`；`scan.complete=false` → 不返回 `different`；`readText` 失败 → 记录级读取失败置 `complete=false`；候选 ref 读不出会让整个查询抛错，控制中心按批 catch 后全部判 `skipped`。这些都与 ADR 第 5 条一致。
- **不可信输入**：`contentRefs` 复用 `machineString` 且限制 1..500；Jev 响应有 1 MiB 上限、逐块检查；answer 数量、模型名、选项 id、概率范围都有校验；`memoryId` 输出符合域里的 `MachineId` 同一字符集与长度限制。
- **资源耗尽**：候选最多 500、已有记忆默认 1000、单次最多 150 个请求、UTC 日 1500 个，响应 1 MiB，均有界；超出上限的条目被判 `skipped`。
- **敏感/受限出口**：已有记忆按记录分类挡住 sensitive/restricted，文本层再挡确定性敏感；候选按 payload 分类和分类缓存挡住；请求体经 `redactForExternalText`，`zeroDataRetention: true`，文件已在 `check-egress-redaction.mjs` 登记。
- **不可撤销操作**：新增的只有只读查询，`memory.import.commit`/`undo` 未改；无新增不可撤销写入。
- **规则/文档一致性**：核对 `.claude/rules/owner-standing-rules.md` 与 `docs/meaning-word-lists.md`、脚本，类别与登记方式一致；发现上面两处文档表述比实现宽。另外确认 `e13cbabd9` 删掉的 `parseAnswerLocaleSettingIntent` 在仓库中已无引用（全仓 grep 无结果），是死代码清理，不是遗漏调用方。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 新提示词 `MEMORY_IMPORT_DUPLICATE_QUESTION` 的 `layer` 是 `background`，只被 `packages/platform-node/src/memory-import-duplicate-decision.ts` 用于独立的后台 `/decisions` 请求；对话的系统提示、工具定义、历史、压缩路径均未改动。`prompt-manifest.json` 只是新增条目并重排了已有条目（运行时按对象读取，顺序无意义），已有提示词文字没有变。新增提示词会进入 `TRUSTED_PROMPT_TEXTS`，但没有日期、哈希或会触发遮盖变化的数字，且属于新增固定文字，不会改变已有历史的遮盖字节。新网关消息 `memory.import.duplicates.read/snapshot` 是独立查询，不进入任何对话请求。**发给对话模型的内容仍然只在末尾追加；这个改动不产生每轮变化的值放进请求头。** 后台请求体本身把固定指令放在 `questions`、数据放在 `input`，符合后台调用「固定在前、数据在后」的排列。
2. **不会在对话请求里造成同一段文字字节不同。** 判重请求里 `existing` 总是排在 `candidates` 前，`listActive` 按 `id` 排序后再按 `updatedAt` 稳定排序，`redactForExternalText` 的占位符只依赖同一请求里排在它前面的内容；没有时间、随机数或无序集合进入请求体（`now()` 只用于日限计数，不写入请求）。唯一可观察到的差异是：同一段文字若在不同判重请求中前面出现不同的敏感值，顺序占位符编号可能不同；但这只发生在后台调用，不进入对话历史，也不影响任何对话缓存前缀。
3. **大部分有自动检查，但第 5 轮修复 (1) 没有。** 判重请求顺序有单测，且该用例在旧顺序 `groups.flatMap(...)` 下确实会失败；解析、HTTP 错误、响应过大、全敏感、截断、控制中心默认不导入都有测试。缺少的是「已读满 limit 后遇到敏感记录不应算读不全」的反向用例；另外「第一个请求单独发」的断言按当前写法即使改成全并发也会通过，不能算有效反向用例。ADR 那两句纯文档改动不需要测试。
4. **逐个核对了新增的值和两端使用：未发现不兼容。**
   - `memory.import.duplicates.read/snapshot`：同时出现在 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、网关夹具、`PRODUCTION_MEMORY_OPERATIONS`、服务端 `query()` 分发和控制中心 `installedGatewayV2Operations` 判断里。
   - `contentRefs` 上限 500：服务端契约、控制中心 `CLASSIFY_BATCH=500`、`MAXIMUM_IMPORT_ITEMS=500` 一致。
   - `verdict` 四个值：契约枚举 = `ImportDuplicateVerdict` = 控制中心 `applyImportDuplicates` 和 i18n `importFlag` 的 select 分支一致。
   - `duplicateCheck` 四个值：产生于 `applyImportDuplicates`，只在 `memory-page.tsx` 使用，pending/clear/similar/unchecked 都有对应表现。
   - `memoryId`：服务端返回的是记录 id，域里的 `MemoryId` 校验与快照的 `machineString` 是同一字符集和长度，能通过后端校验。
   - 配置键 `runPolicy.importDuplicates`：`parseImportDuplicates` 的 `rejectUnknown`、范围整数校验、阈值顺序校验、`model`/`secretRef` 安全引用、`model-auth` 用途校验齐全，并由启动配置测试覆盖。
   - 提示词 id/parser、egress 文件登记、`packages/application`/`platform-node` 的导出都已串上。
   - 不一致的只有文档层面的默认值与范围（见上），不是运行时不接受。
