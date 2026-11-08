## 发现（按严重度从高到低）

### 1. 中：[读代码证实] 点击后重读失败或新快照里没有这条记忆时，没有“来源已不可查”的针对性反馈，可能静默无反应，甚至直接关掉详情
- 文件:行：`apps/control-center/src/memory.ts:131-141`；`apps/control-center/src/components/memory-page.tsx:524-529`、`1438-1439`、`1654-1667`
- 问题：`checkSource` 在查询抛错、返回类型不对、或新快照里 `find` 不到这条记忆时都返回 `null`。点击处理器只有 `fresh?.sourceThreadId && fresh.sourceMessageId` 才跳转，没有 `else` 分支。结果是：
  - 查询返回非 `memory.overview.snapshot`：既不 `setFailed` 也不改详情，点了完全没反应；
  - 查询抛错：顶部显示通用的“当前不可用”，详情仍保留“跳到原话”，没有说来源状态；
  - 新快照没有这条记忆（例如概览跳过读不出文字的记忆、已归档/回收站超过 `INACTIVE_SHOWN=500`）：`setOverview` 后 `byId` 里没有它，`opened` 变成 `undefined`，整个详情抽屉直接消失。
- 证据：
  ```ts
  // memory.ts:131-141
  checkSource: async (memoryId) => {
    try {
      const result = await client.query(queryMessage(configuration, "memory.overview.read", {}));
      if (result.type !== "memory.overview.snapshot") return null;
      setOverview(result.payload);
      setFailed(false);
      return result.payload.memories.find((item) => item.memoryId === memoryId) ?? null;
    } catch {
      setFailed(true);
      return null;
    }
  },
  ```
  ```tsx
  // memory-page.tsx:524-528
  onClick={() => {
    void memory.checkSource(item.memoryId).then((fresh) => {
      if (fresh?.sourceThreadId && fresh.sourceMessageId)
        onOpenThread(fresh.sourceThreadId, fresh.sourceMessageId);
    });
  }}
  ```
  ```tsx
  // memory-page.tsx:1438-1439, 1654-1657
  let opened = openId ? byId.get(openId) : undefined;
  while (opened?.supersededBy) opened = byId.get(opened.supersededBy);
  ...
  {opened ? <MemoryDetail ... item={opened} ... /> : null}
  ```
- 建议：让 `checkSource` 返回可区分的结果（成功 / 来源已消失 / 读取失败 / 快照里没有该记忆），分别处理；读取失败时保留详情并在按钮附近提示；快照里没有该记忆时不要无解释地关抽屉。补一条反向用例：查询拒绝或返回非快照时，界面必须给出可见反馈且不跳转。

### 2. 中：[读代码证实] 重复点击和乱序响应没有防护，可能用旧概览覆盖新概览，并放大 expensive 的全量概览读取
- 文件:行：`apps/control-center/src/memory.ts:75-95`、`131-141`；`apps/control-center/src/components/memory-page.tsx:524-529`
- 问题：`checkSource` 没有 `busy`/禁用/中止/请求序号。每次点击都发一次 `memory.overview.read`，而概览读取会读全部记忆文字、历史、`findOwnerMessages`、提醒、人物等。两次点击或“点击 + 5 分钟自动刷新”可并发，两个 `setOverview` 谁后返回谁生效，没有 `generatedAt` 或序号比较，旧响应可能覆盖新响应。
- 证据：
  ```ts
  // memory.ts:75-95
  useEffect(() => {
    ...
    void client.query(queryMessage(configuration, "memory.overview.read", {}))
      .then((result) => {
        ...
        setOverview(result.payload);
        setFailed(false);
      })
  ```
  与 `checkSource` 里同样的 `setOverview(result.payload)` 并存，二者无先后判断。
- 建议：给概览读取加请求序号或 `generatedAt` 比较；`checkSource` 在请求中禁用按钮或复用 `busy`；或让点击只查一个轻量“来源还在不在”的接口，避免每次全量概览。补一个并发/乱序用例（先发旧请求、后发新请求、旧请求后返回）。

### 3. 低：[读代码证实] “常量 512 合成一个共享常量”的说法不成立，脚本仍是独立字面量，ADR 的“同名常量”说法也不实
- 文件:行：`scripts/operations/memory-source-report.mjs:16`；`docs/adr/0186-memory-jumps-to-the-owners-original-message.md:76`；`packages/gateway-contracts/src/contracts-v2.ts:19`
- 问题：网关侧确实只剩一个 `MEMORY_SOURCE_REF_MAX_LENGTH = 512`，但脚本仍有自己的 `SOURCE_REF_MAX_LENGTH = 512`，并不是同一个共享常量；ADR 写“脚本的同名常量”也不准确（名字不同）。新增测试只锁了两个导出常量的数值相等，没有锁脚本 SQL 真的使用了这个常量。
- 证据：
  ```js
  // scripts/operations/memory-source-report.mjs:16
  export const SOURCE_REF_MAX_LENGTH = 512;
  ```
  ```md
  <!-- ADR:76 -->
  ...`MEMORY_SOURCE_REF_MAX_LENGTH` 在网关契约里只写一处，脚本的同名常量由 `memory-source-report.test.ts` 锁定相等。
  ```
- 建议：要么让脚本从共享定义生成/导入，要么把 ADR 改成“脚本保留独立常量，由测试锁定数值相等”；同时补一个脚本行为用例，验证长度为 `SOURCE_REF_MAX_LENGTH` 与 `+1` 的引用分别落入预期类别，而不只是比较声明值。

### 4. 低：[读代码证实差异，实际影响为推测] 脚本 SQL 的 `length()` 与网关/JS 的 `.length` 计数单位不同
- 文件:行：`scripts/operations/memory-source-report.mjs:28`；`apps/agent-service/src/production-memory-control.ts:313`、`348`；`packages/gateway-contracts/src/validation.ts:84`
- 问题：SQLite 的 `length(text)` 按字符（Unicode code point）计，JS 的 `ref.length` 按 UTF-16 code unit 计。对含非 BMP 字符（如 emoji、部分扩展汉字）的引用，长度接近 512 时页面和脚本可能一个算“超长”、另一个算“未超长”，破坏“同一套分类”的承诺。当前来源引用多为 `payload-...`/`memory-content:reminder:...` 这类 ASCII，实际影响预计很小。
- 证据：
  ```js
  // memory-source-report.mjs:28
  AND t.message_status = 'committed' AND length(p.source_id) <= ${SOURCE_REF_MAX_LENGTH}
  ```
  ```ts
  // production-memory-control.ts:313
  for (const ref of sourceRefs) if (ref.length <= MEMORY_SOURCE_REF_MAX_LENGTH) refs.add(ref);
  ```
  ```ts
  // validation.ts:84
  input.length > maximum
  ```
- 建议：统一计数口径（例如 JS 用 `[...ref].length`，或在 SQL 里按 UTF-16/字节比较）；补一个刚好在边界、含非 BMP 字符的用例。

### 5. 低：[推断/需场景] `takeMessageFocus` 先消费请求再找 DOM，目标消息不在当前详情里时跳转会静默丢失，之后不会重试
- 文件:行：`apps/control-center/src/components/chat-history.tsx:114-128`；`apps/control-center/src/message-focus.ts:14-24`；`apps/control-center/test/message-focus.unit.test.ts:143-153`
- 问题：`takeMessageFocus` 一旦看到线程 id 匹配就清空全局请求，随后才查 DOM；如果此时详情还是旧快照、目标消息尚未在 DOM 中，请求就被吞掉。后续消息到达、`focusMessages` 变化时也不会再处理。ADR 说“对话加载多慢都不丢”，这只对“线程还没就绪”成立，对“线程已就绪但目标消息还没在 DOM 里”不成立。
- 证据：
  ```ts
  // chat-history.tsx:117-122
  const request = takeMessageFocus(focusThreadId);
  if (!request) return;
  const target = [...(scrollRef.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])]
    .find((element) => element.dataset["messageId"] === request.messageId);
  if (!target) return;
  ```
- 建议：先找目标，找不到时保留 pending（或恢复请求），等 `focusMessages`/DOM 更新后再试；或者按 `messageId` 判断消息是否已在 `focusMessages` 中，再决定是否消费。补一个“详情先挂载旧消息、目标稍后出现”的用例。

### 6. 低：[读代码证实] ADR 仍硬编码“512”，与代码使用常量不一致
- 文件:行：`docs/adr/0186-memory-jumps-to-the-owners-original-message.md:39`；`packages/gateway-contracts/src/contracts-v2.ts:19`
- 问题：代码已改为 `MEMORY_SOURCE_REF_MAX_LENGTH`，ADR 决策 1 仍写“超过 512 个字符”。以后改常量时文档会悄悄过时。
- 证据：ADR:39“过长（超过 512 个字符）的引用不参与匹配”。
- 建议：ADR 改为“超过 `MEMORY_SOURCE_REF_MAX_LENGTH`（当前 512）”。

---

## 读代码证实的与推测分开

**读代码证实的：**
- `checkSource` 的 catch、非快照返回、`fresh` 为 null 的路径确实没有在详情里给出“来源已不可查”的处理（发现 1）。
- `MemoryBrowser` 的 `opened` 来自最新 `overview.memories`，新快照缺这条记忆时抽屉会消失（发现 1）。
- `checkSource` 与自动刷新共用 `setOverview`，没有序号/中止/禁用（发现 2）。
- 脚本确有独立的 `SOURCE_REF_MAX_LENGTH = 512`，ADR 的“同名常量”与事实不符（发现 3）。
- SQL `length()` 与 JS `.length` 的计量单位不同（发现 4）。
- `takeMessageFocus` 在找到 DOM 目标之前就清空 pending（发现 5）。
- ADR 中 512 仍为硬编码（发现 6）。
- 新增浏览器夹具的 `NODE_ENV=production` 只作用于 `vite build` 子进程，不修改 `process.env`，不影响其他测试（见“侧重检查”）。
- `MEMORY_SOURCE_REF_MAX_LENGTH` 已从 `packages/gateway-contracts/src/index.ts` 的 `export *` 暴露，agent-service 和测试的 import 路径可解析；schema 中 `boundedString` 与服务端过滤都按 `.length`，同为 512，正常 ASCII 引用两端一致。

**推测（未运行测试、未核实外部消费者）：**
- 发现 4 的实际影响依赖数据库里是否存在非 BMP 的来源引用；当前机器生成的引用看起来是 ASCII。
- 发现 5 的触发需要“同一线程已有旧详情、点击跳转时详情尚未刷新到包含目标消息”的场景；如果线程详情总是先加载完整再挂载，影响会小很多。
- 我没有验证 `memory.overview.read` 在生产环境是否另有服务端缓存；从本仓库代码看，`ProductionMemoryControl.query` 每次重新查 DB，没有看到缓存层。

---

## 侧重检查

- **错误路径**：检查了 `checkSource` 的 reject、非快照返回、`fresh === null`、详情抽屉依赖 `byId` 的路径，结论见发现 1。读失败时至少顶部会出现“当前不可用”，但不是针对“跳到原话”的反馈；非快照和“快照缺记忆”两种路径没有明确反馈。
- **不合规范/不可信输入**：`checkSource` 的 `memoryId` 来自服务端快照；查询 payload 为空；脚本中的常量是数字插值，不来自用户输入。未发现注入或越权路径。
- **安全**：改动只暴露 `sourceMessageId`（消息 id）和过滤后的 `sourceRefs`，没有新增秘密或日志输出；控制中心与服务端同属 owner 自己的数据。
- **资源耗尽**：每次点击触发一次全量 `memory.overview.read`，没有并发限制或按钮禁用；重复点击可并发多次，且概览读取包含读全部记忆文字、历史和 `findOwnerMessages`。见发现 2。
- **不可撤销的操作**：`checkSource` 本身只读，但 `ProductionMemoryControl.query` 会先调用 `#purgeExpiredTrash()`（`production-memory-control.ts:279`），该函数会真正删除过期回收站记忆。点击路径因此会额外触发既有的清理副作用；这不是本次新增的删除逻辑，但点击频率增加会让清理更频繁地发生。未发现新的不可逆操作。
- **规则/文档一致性**：提示词相关规则文件未改动；ADR 0186 有两处与代码/作者说法不一致（发现 3、6）。ADR 中关于“历史读不出文字”和“回收站脚本分类”的更新与代码一致，已核对。
- **夹具环境变量**：`test/integration/memory-source-browser.test.ts:43-46` 只在 `spawn` 的 `env` 中设置 `NODE_ENV=production`，没有改动父进程环境；其他浏览器测试仍自行 `spawn`，不受影响。未发现跨测试污染。
- **反向用例**：
  - 新增的“点击时来源被清掉”单元用例：若恢复旧行为直接跳转会因 `opened` 被调用而失败；若 `checkSource` 永远返回 null，会因详情仍含“跳到原话”而失败，反向有效。
  - 超长引用用例：若去掉 512 过滤，`sourceRefs` 会包含 `longRef`、`sourceMessageId` 会变成 `message-long`，断言失败，反向有效。
  - 浏览器高亮正向用例：若 `data-focused` 不再设置会失败；“直接打开无高亮”反向用例若高亮逻辑完全坏掉反而会通过，但它与正向用例配合可覆盖。
  - 常量相等测试只能锁声明值；脚本 SQL 若改成硬编码字面量而常量仍相等，不会被这条测试发现（见发现 3）。
  - 未发现针对“读取失败”“非快照返回”“重复点击/乱序响应”的自动检查。

---

## 对作者说法的核对

1. **“点击时重新读一次记忆概览，核对来源还在不在（替代把来源匹配纳入 revision）”**：核对属实。`memory-page.tsx:524-528` 调 `checkSource`，`memory.ts:131-141` 重新查询；`revision()`（`production-memory-control.ts:221-259`）没有加入来源匹配。但失败/缺失路径处理不完整（发现 1）。
2. **“常量 512 合成一个共享常量”**：不属实。脚本仍保留独立的 `SOURCE_REF_MAX_LENGTH = 512`（发现 3）；只能说“网关侧合并为一个常量，脚本靠测试锁值”。
3. **“补了超长引用的网关侧用例和真实浏览器高亮用例”**：属实。`production-memory-capture.test.ts` 新增超长/恰好上限用例；`memory-source-browser.test.ts` 新增高亮断言和“直接打开不高亮”用例。但浏览器夹具的概览是静态的，没有端到端覆盖“点击时重新读取后发现来源消失”的场景，只由单元测试的 mock 覆盖。
4. **“浏览器夹具构建固定 NODE_ENV=production”**：属实，且只影响该测试的构建子进程，不影响其他测试。
5. **“ADR 相应措辞更新”**：部分属实。差异说明和决策 2 已更新，但决策 1 仍写死“512”，后果部分把脚本常量称为“同名常量”（发现 3、6）。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本增量改的是控制中心界面、网关记忆概览、运维脚本和测试；`git diff --stat` 里没有 `packages/prompt-catalog`、`runtime-pi` 或提示组装代码。记忆召回走的是 `memory.search`（`production-run-memory.ts:350-382`），不是这个记忆概览快照。因此发给模型的内容仍然只在末尾追加，没有新的每轮变化值进入系统提示、工具定义或历史；这条改动的语义是控制面只读查询。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会影响模型请求的字节。新增的 `sourceMessageId` 由 `earliestSourceMessage` 按线程内 `sequence` 排序取最小（`production-memory-control.ts:103-115`），是确定的；`sourceRefs` 过滤保留原顺序。脚本的 `SOURCE_REF_MAX_LENGTH` 与网关常量数值一致，不涉及提示序列化。唯一发现的“同一概念不同计量”是脚本 SQL 的 `length()` 与 JS `.length`（发现 4），但它只影响运维报表分类，不影响模型输入。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有新增检查：点击时重读的单元用例、超长/恰好上限的 SQLite 集成用例、真实浏览器高亮正反用例、脚本常量相等测试。按代码静态判断，主要反向用例确实会失败（见“侧重检查”）。缺口是：没有覆盖 `checkSource` 读失败/非快照返回、重复点击/乱序响应；脚本测试只锁常量值，不验证 SQL 实际使用该常量；点击时重读没有真实浏览器级用例。另，我未运行测试，因此“会失败”是基于代码路径的静态判断。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   - `MEMORY_SOURCE_REF_MAX_LENGTH`：定义于 `contracts-v2.ts:19`，用于 schema（`:942`）、`production-memory-control.ts:313/348`、两个集成测试。值为 512，`boundedString` 与服务端过滤都按 `.length`，ASCII 引用两端一致；通过 `index.ts` 的 `export *` 可用。
   - `sourceMessageId`：服务端产生（`earliestSourceMessage`），契约中是 `nullable(machineString)`；界面用于 `onOpenThread`，`ChatHistory` 用同名字段和 `thread.detail` 的 `messageId` 比较，两者都是 `machineString`，可接受。
   - `sourceRefs`：服务端先过滤再交给 `array(boundedString(512))`，不会出现超长导致 schema 失败；空字符串问题由存储层原有校验兜底。
   - `data-message-id`/`data-focused`：只用于界面选择和高亮，`data-message-id` 来自 `thread.detail` 的消息 id，与 `sourceMessageId` 同域。
   - `SOURCE_REF_MAX_LENGTH`：脚本独立值，与网关值相等由测试保证；但 SQL 使用该常量这一点没有测试锁定（发现 3），且 SQL 与 JS 计量不同（发现 4）。
   - `sourceMessageId` 加入的是 `gateway.v2` 记忆概览的必填可空字段，仓库内 schema、fixture、控制中心都已同步；是否存在仓库外消费者未核实。
