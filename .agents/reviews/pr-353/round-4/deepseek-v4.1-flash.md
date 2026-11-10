## 结论

本次增量 `b2531c34..88855859` 实际只改文档（另加复核记录），没有改代码、没有加测试。`node_modules/@earendil-works/*` 在当前 sparse checkout 中不存在，我也不能访问仓库外目录，所以**作者引用的 Pi 1.5.0/1.5.1 源码、`dist/core/cache-warmer.js`、`sdk.js`、`docs/models.md/extensions.md/sdk.md` 全部未能亲自核实**。下面的“已证实”只指 Himawari 代码和仓库内文档。

没有发现“当前会改变线上行为”的高危问题；但有一项**条件成立时属于高危**的安全问题：如果作者“暖机请求不经过 Himawari 的请求函数”这一说法为真，暖机会同时绕过出口遮盖和密钥注入，而不只是绕过准入和计费。

---

## 读代码证实的问题

### 中：`cache_warm` 用量条目的生产端与现有用量表契约不匹配

- 文件：`docs/pi-development-guide.md:331`、`docs/pi-development-guide.md:356`
- 问题：文档说“预热的用量 Pi 记成一条 `cache_warm` 会话条目……Himawari 从这里记进自己的用量表”。但现有用量表要求 `invocationId`、`purpose`、`source` 等字段，暖机条目不是一次准入调用，没有这些字段。
- 证据：
  - `packages/application/src/ports/model-usage.ts:18-33`：`ModelUsageObservation` 必填 `invocationId`、`purpose`、`source`、`provider`、`model`……
  - `packages/application/src/ports/model-usage.ts:16`：`source` 只有 `"model-port" | "agent-stream"`。
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:223`：`entry_appended` 现在被列入 `KNOWN_IGNORED_EVENTS`，即当前明确忽略。
- 建议：D7 方案里必须写清用量表的扩展方式（新增 source/purpose，或允许 `invocationId` 为空/合成），并从 `KNOWN_IGNORED_EVENTS` 中移出 `entry_appended`、加映射和测试。否则照文档实现会卡在契约校验，正是 I-73 那类“清单里的 id 能通过后端校验吗”。

### 中：D7 引入了没有出处的 `warm` 动作值

- 文件：`docs/pi-development-guide.md:356`（另见 `:331`、`:58`）
- 问题：正文只引用了官方“扩展回 `{ action: "stop" }` 就不续”，D7 却写成“按预算回 `warm` 或 `stop`”。“`warm`”这个枚举值没有出处，若 Pi 实际接受的是别的值，未来实现会得到无效动作。
- 证据：
  - `docs/pi-development-guide.md:331`：“扩展回 `{ action: "stop" }` 就不续（`docs/extensions.md` 第 912 行）”。
  - `docs/pi-development-guide.md:356`：“`cache_warming_decision` 按预算回 `warm` 或 `stop`”。
  - `docs/pi-development-guide.md:58`：本规范自己要求“引用时写清出处……再引一句原话”。
- 建议：在锁定 1.5.0 和 1.5.1 的源码/文档中确认动作枚举并补原话；确认前不要把 `warm` 写成规范。

### 中：resources 磁盘路径的授权说明缺少路径规范化/符号链接要求

- 文件：`docs/pi-development-guide.md:106`、`packages/runtime-pi/src/pi-runtime-adapter.ts:739-747`
- 问题：文档提醒“扩展路径上的文件会被 Pi 当代码加载”，方向正确；但它描述的唯一现有校验是“非空、不重复”。按原始字符串去重不能阻止 `a`、`./a`、符号链接指向同一文件，也没有 `realpath`、允许根目录包含关系、普通文件类型等检查。未来资源端口一旦实现，若只按文档做“路径非空、不重复”的授权，仍可能加载允许目录之外的文件。
- 证据：
  - `pi-runtime-adapter.ts:739-746`：只检查 `typeof path !== "string"`、`trim().length === 0`、`new Set(paths).size !== paths.length`，随后原样返回。
  - `pi-runtime-adapter.ts:1426-1431`：这些路径直接传给 `additionalExtensionPaths` 等。
  - 文档自己也承认“不检查路径在不在允许的目录里”。
- 建议：在“以后接这个端口必须先出方案”里明确要求：规范化/`realpath`、允许根目录包含检查、符号链接策略、普通文件检查、去重按规范化后的身份；适配器侧保留一次防御性检查。当前生产入口未接该端口，所以没有现时暴露。

### 低：`每轮新建 Pi 会话` 与代码不符

- 文件：`docs/pi-development-guide.md:332`
- 问题：代码是每次 **Run** 建一个会话，Run 内可多次请求模型并共享同一会话；不是每“轮”（turn）新建。描述偏差会影响对暖机窗口和费用的判断。
- 证据：
  - `pi-runtime-adapter.ts:1554-1615`：在 `run` 内 `sessionFactory(...)` 建会话。
  - `pi-runtime-adapter.ts:1621`：同一个 `session.agent.streamFunction` 被该 Run 内多次请求复用。
  - `pi-runtime-adapter.ts:1803-1823`：`waitForIdle()` 之后才在 `finally` 里 `session.dispose()`。
- 建议：改成“每次 Run 新建 Pi 会话、Run 结束关闭”。若想表达“两轮之间”，应明确是两次 Run 之间还是同一 Run 两次模型请求之间。

### 低：这次新增的规范声明没有自动检查

- 文件：`docs/pi-development-guide.md:330-332`、`:356`
- 问题：仓库里没有测试引用 `promptCache`、`cacheWarming`、`cache_warm`、`cache_warming_decision` 或 `additionalExtensionPaths`；`check:prompt-prefix` 也不覆盖暖机和资源路径。文档里的版本、事件名、行号漂移不会被任何检查发现。
- 证据：在 `packages/runtime-pi/test` 中搜索上述关键字均无结果；`docs/kv-cache-guide.md:97` 只说明 `check:prompt-prefix` 检查多轮请求前缀。
- 建议：至少加一条针对锁定 Pi 版本的契约测试：确认 `promptCache`/`cacheWarming`/`cache_warming_decision`/`cache_warm` 在锁定版本中存在且动作值合法；D7 实现时再加“超预算必须 stop”“暖机用量必须入账”的反向用例。

---

## 推测 / 未核实

### 条件成立时为高：暖机绕过的不只是准入和计费，还会绕过出口遮盖和密钥注入

- 文件：`docs/pi-development-guide.md:331`；`packages/runtime-pi/src/pi-runtime-adapter.ts:975-1090`
- 说明：作者称“预热请求由 Pi 直接调服务方，不经过 Himawari 替换的请求函数”。这一点无法从当前 checkout 的 Pi 源码核实。**如果成立**，由已读 Himawari 代码可推出暖机不会经过这些只在 `admitPiStream` 里做的事：
  - 出口遮盖：`egress.exchange(...)` 与 `exchange.wrapFetch(...)` 在 `admitPiStream` 内（`:1049-1058`），只有 `streamFunction` 调用它（`:1621-1650`）。
  - 遮盖占位说明：`normalizeContext(withPlaceholderLegend(context))` 也在 `admitPiStream` 内（`:975`）。
  - 密钥注入：`apiKey: secret` 只在 `admitPiStream` 调用原 Pi 流函数时传入（`:1085-1090`）；`sessionModelRuntime` 只是用 Proxy 谎报 `hasConfiguredAuth`（`:639-650`），Pi 的凭据库是空的（`configured-model-binding.ts:371-376`）。
  - 历史本身存的是遮盖前内容，发送时才遮盖（`docs/kv-cache-guide.md:60`；`prehydrateSession` 在 `:694-716` 原样把历史写入 Pi 会话）。
- 影响：一旦按文档给模型填 `promptCache` 开启暖机，可能把未遮盖的历史和用户内容直接发给服务方，并可能在 Pi 没有可用密钥时反复失败或走意外认证路径。这比文档写的“不能指望准入和计费”严重。
- 建议：D7 方案必须先回答“暖机如何经过 Himawari 的出口遮盖、密钥注入、占位说明和用量记录”。在这些完成前，不应把“预热要保留”落成代码；若 Pi 没有可用的暖机钩子，按规范第六节作为官方缺陷另行出方案。

### 未核实：锁定 1.5.0 是否具备这些暖机能力

- `docs/pi-development-guide.md:331` 对 `cache_warm` 明确引用的是 **1.5.1**；`packages/runtime-pi/package.json:10-11` 锁定的是 **1.5.0**。如果 `cache_warm`/`cache_warming_decision` 是 1.5.1 才有的，那么 D7 的“官方写法”在锁定版本上不能用，文档应先写“需先确认或升级”。当前无法读 Pi 源码，不能下结论。

### 未核实：`promptCache` 加进模型描述会影响审批续跑身份

- `pi-runtime-adapter.ts:1336-1347` 的 `identity` 对 `binding.descriptor` 做 `JSON.stringify`；`configured-model-binding.ts:258-284` 的 `providerModelConfig` 目前不含 `promptCache`。如果实现时把 `promptCache` 加进 Himawari 的 `ConfiguredPiModelDescriptor`，所有升级前保存的审批续跑快照都会在续跑时得到 `RUNTIME_CONTINUATION_BINDING_CHANGED`（`:1360-1361`）。若只加在 Pi 的 `ProviderModelConfig` 而不进 Himawari descriptor，可避免。这一点属于实现选择，文档没有说明。

### 未核实：其余 Pi 行为

- 1.5.0 默认 `"streaming"`、1.5.1 改成 `"idle"`。
- `cache_warming_decision` 事件是否存在、动作枚举是什么。
- `cache_warm` 条目和 `entry_appended` 事件（1.5.1 `cache-warmer.js` 第 188 行）。
- 暖机请求直连服务方（1.5.0 `cache-warmer.js` 第 238 行）。
- `session.dispose()` 是否会真正停止暖机定时器。
- `docs/models.md:106`、`docs/extensions.md:912`、`docs/sdk.md:112` 的原话和行号。
- DeepSeek 缓存保留时间的外部链接内容（仓库 `docs/kv-cache-guide.md:39,77` 的说法与文档一致，但网页本身未核实）。
- “Andy 2026-11-10 定缓存预热要保留”只有作者说法，仓库内无独立记录可查。

---

## 侧重检查

- **错误路径/不可信输入（resources 路径）**：生产入口 `apps/agent-service/src/production-run-composition.ts:403-450` 没有传 `resources`，适配器回落到 `EMPTY_RESOURCES`（`pi-runtime-adapter.ts:287-291,1281-1284`），所以当前没有暴露。未来一旦接入，路径会被 Pi 当代码加载；现有校验只有非空和原始字符串去重（`:739-747`），缺少规范化、根目录包含、符号链接和文件类型检查。属于中等安全设计缺口。
- **资源耗尽/费用**：当前没有 `promptCache`，也没有 `cacheWarming`（`configured-model-binding.ts:258-284`、`pi-runtime-adapter.ts:1405-1412`），所以不会产生暖机费用。文档的 D7 目标没有预算和用量实现；且暖机按作者说法绕过准入，若将来开启，费用控制只能依赖尚未实现的 `cache_warming_decision`。D7 状态“待 Andy 定”与这一点一致，但文档正文用了“Himawari 在这里按自己的预算决定”的现在时，容易被误读为已实现。
- **不可撤销操作**：本次改动没有新增。现有 `session.dispose()` 在 `finally` 中执行（`:1817-1823`），路径正确。
- **未知事件/异常输入**：适配器对未列入 `KNOWN_IGNORED_EVENTS` 的会话事件会抛 `PI_UNKNOWN_EVENT_TYPE`（`:2313-2317`）。`entry_appended` 已在忽略列表中；若 `cache_warming_decision` 实际是会话事件而不是扩展事件，当前会直接让 Run 失败。文档说它是扩展事件，未核实。
- **规则/文档/代码一致性**：磁盘路径一句与代码基本一致；“没设 `cacheWarming`、没填 `promptCache`”与代码一致；“每轮新建会话”不一致；暖机用量表与现有契约不一致；`warm` 动作与文档自己“引用要有出处”的规则不一致。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会改变现有聊天请求。本次只改文档，代码里发给模型的内容仍由 `himawariRequestContext` 使用冻结的系统提示和工具、过滤掉 system 消息（`pi-runtime-adapter.ts:652-667`），每轮变化的时间/资料仍在 `turnPrompt` 的最后一条用户消息里（`:610-628`）。
但新增的“暖机请求”不在这个保证内：如果它绕过 `streamFunction`，它既不走 `himawariRequestContext`，也不走 `admitPiStream` 的出口遮盖和占位说明，发出的字节可能和真正的聊天请求不同；它不会改写聊天请求的开头，但会产生一个额外且可能不同的服务方请求。

**2. 同一段文字会不会在不同请求里变成不同字节？**

本次改动本身不会。聊天请求的序列化路径未变；`cache_warming_decision` 按预算/时间变化只决定是否发一个独立暖机请求，不改变聊天请求内容。
风险在将来：`cache_warm` 条目若带时间戳并被写进会话条目，可能让审批续跑快照的字节随时间变化（缓冲区里已有 `entry_appended` 被忽略，说明当前不会进模型消息）；另外暖机若不经过 `himawariRequestContext`，它自己发出的前缀可能和聊天前缀不同，导致暖错缓存——这是“暖机无效”而非“聊天字节变化”。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**

没有。本次没有新增测试；仓库内没有测试引用 `promptCache`、`cacheWarming`、`cache_warm`、`cache_warming_decision` 或 `additionalExtensionPaths`。现有的 `check:prompt-prefix` 只检查聊天请求前缀（`docs/kv-cache-guide.md:97`），不覆盖暖机、预算、用量入账或资源路径授权。因此无法证明反向用例会失败。建议按上文补契约测试和 D7 的正反向用例。

**4. 每个产生/修改的值，使用它的地方都能接受吗？**

- `cacheWarming`：文档产生；当前唯一消费者是 Pi 的 `SettingsManager.inMemory`，Himawari 现有设置只有 `compaction`、`retry`、`defaultTools`（`pi-runtime-adapter.ts:1405-1412`）。锁定 1.5.0 是否接受该键未核实。
- `promptCache`：文档产生；消费者应是 Pi 的 `ProviderModelConfig`，但 `configured-model-binding.ts:258-284` 目前没有这个字段。若加进 Himawari 的模型描述，会成为续跑 `identity` 的一部分（`pi-runtime-adapter.ts:1336-1347`），可能让旧快照续跑失败；应优先只加在 `providerModelConfig`。
- `cache_warming_decision` / `warm` / `stop`：文档产生；当前 Himawari 没有任何处理器。`stop` 有文档出处，`warm` 没有出处，存在枚举值不被 Pi 接受的风险。
- `cache_warm` 条目 / `entry_appended`：Pi 产生；目标消费者是 Himawari 用量表，但 `entry_appended` 当前被忽略（`:223`），且用量表要求 `invocationId`/`purpose`/`source`（`model-usage.ts:18-33`），现有契约接不住。
- `additionalExtensionPaths` / `additionalSkillPaths` / `additionalPromptTemplatePaths`：未来 resources 端口产生；消费者是 Pi 资源加载器（`:1426-1431`）。适配器只做非空/原始字符串去重（`:739-747`），没有路径规范化、根目录包含、符号链接和类型校验；当前生产未接该端口，无现时暴露。
- `session.dispose()`：代码产生，当前使用正确（`:1817-1823`）；它是否停止 Pi 暖机定时器未核实。
