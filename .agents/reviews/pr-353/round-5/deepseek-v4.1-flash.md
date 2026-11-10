## 复核范围

本轮增量 `8885585..ad462d1` 的产品改动只有 `docs/pi-development-guide.md` 的 3 行；其余是 `.agents/reviews/pr-353/` 的复核记录。作者说的“这一轮修改都在 docs/pi-development-guide.md”对产品文件成立。

## 读代码证实的问题

### 中：预热“照样遮盖、照样带密钥”的结论过宽，网关路径上直接不成立

- 文件:行：`docs/pi-development-guide.md:331`
- 问题：文档写“预热请求……沿用那次请求的选项……其中有 Himawari 传入的出口遮盖 `fetch` 和密钥，所以照样遮盖、照样带密钥”。按作者自己写的机制（Pi 原样存下选项），网关模型上的 `fetch` 是**单次使用**的，第二次请求会抛错，而不是“照样”。
- 证据：
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:1057-1061`：
    - `const cacheFields = observeCacheFields(exchange.wrapFetch(options?.fetch ?? globalThis.fetch));`
    - `if (gateway !== undefined) { withoutAmbientApiKey.fetch = gateway.fetch; ... }`
  - `packages/runtime-pi/src/gateway-observation.ts:149-153`：
    - `if (sent) { repeated = true; throw new Error("AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN"); }`
- 影响：如果 Pi 真的原样复用选项，`provider === "vercel-ai-gateway"` 的预热会在第二次请求抛 `AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN`；如果 Pi 没有原样复用，那么“照样遮盖、照样带密钥”就没有依据，存在绕过出口遮盖或密钥的风险。当前没有开启预热（仓库源码里没有 `promptCache`/`cacheWarming`，`SettingsManager.inMemory` 也没设，`pi-runtime-adapter.ts:1405-1412`），所以不是现存故障，但会误导 D7 的实现方案。
- 建议：按 provider 限定这句话；D7 方案里为预热单独提供可重复使用、仍走遮盖的 `fetch` 和密钥解析，或明确网关模型不预热；用“连续两次请求都经过遮盖且都带密钥”的测试锁住，而不是只测一次。

### 中：新增的路径授权最低要求存在“检查后换路径”的时间窗

- 文件:行：`docs/pi-development-guide.md:106`
- 问题：新增要求是“解析成真实路径（跟随符号链接）后检查在允许的目录里、是普通文件、按真实路径去重，适配器侧再查一次”。但适配器最终交给 Pi 的是**原始路径字符串**，Pi 稍后才加载；检查和加载之间可以把符号链接换到别处（TOCTOU），而扩展路径会被当作代码执行。
- 证据：
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:739-747`：`authorizedPaths` 只检查非空和字符串重复，最后 `return [...paths];`
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:1426-1431`：把 `authorizedPaths(...)` 的结果传给 `additionalExtensionPaths` 等。
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:1516`：`await resourceLoader.reload();` 之后 Pi 才真正使用这些路径。
- 影响：当前 `resources` 端口没有实现、生产入口没有接（`pi-runtime-adapter.ts:288-290` 默认空列表；全仓除了接口定义和导出没有其它 `PiRuntimeResourcePort` 使用），所以没有现存暴露。但这条新要求本身不足以完成授权。
- 建议：把解析后的真实路径作为交给 Pi 的路径；允许目录本身也要解析并确保非授权方不可写；尽量让“检查”和“加载”原子化（打开文件后按 fd/文件描述符校验，或至少在紧邻加载前重新解析比对）；对扩展路径单独给出更强的要求。

### 低：“扩展用量表”没有覆盖所有会拒绝新 source/purpose 的地方

- 文件:行：`docs/pi-development-guide.md:331`
- 问题：文档说“记预热用量要先扩展用量表”。但新增 `source` 或 `purpose` 不只是改类型：持久化层有硬编码校验和 SQL `CHECK`，只改 `ModelUsageSource` 会在 `record()` 时失败。
- 证据：
  - `packages/application/src/ports/model-usage.ts:16`：`export type ModelUsageSource = "model-port" | "agent-stream";`
  - `packages/persistence-sqlite/src/sqlite-model-usage-operations.ts:20-35`，尤其第 23 行：`(input.source === "model-port" || input.source === "agent-stream") &&`
  - `packages/persistence-sqlite/src/migrations/0068_model_usage_observations.sql:6-12`：`purpose TEXT NOT NULL CHECK (...)`、`source TEXT NOT NULL CHECK (source IN ('model-port', 'agent-stream')),`
- 建议：D7 方案里把迁移、SQL `CHECK`、`valid()`、TypeScript 联合类型和契约测试一起列出；加反向用例：迁移前新 source 必须被拒绝，迁移后必须能写入。

### 低：`entry_appended` 现在被直接丢弃，光扩展用量表收不到预热用量

- 文件:行：`docs/pi-development-guide.md:331`
- 问题：文档说“Himawari 现在把 `entry_appended` 列为忽略的事件”，这是对的；但结论“所以记预热用量要先扩展用量表”漏了事件入口：当前事件映射会把 `entry_appended` 直接吞掉，必须在 D7 里同时决定用扩展事件还是会话事件，并改映射；如果只从忽略列表删掉而不加对应分支，默认分支会抛错。
- 证据：
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:219-233`：`KNOWN_IGNORED_EVENTS` 包含 `"entry_appended"`。
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:2313-2317`：default 分支在事件不在忽略列表时 `throw new Error("PI_UNKNOWN_EVENT_TYPE:${eventType}")`。
- 建议：D7 方案明确预热用量的入口（`pi.on("entry_appended")` 还是会话事件映射），并加测试；保留未知事件抛错的行为。

## 未核实与推测

- **Pi 源码完全未读到**：本检出没有 `node_modules`（`glob node_modules/@earendil-works/**` 无命中），所以以下都标“未核实”，不据此判作者说法成立：
  - `dist/core/sdk.js` 第 199、269 行是否真的把选项原样存下；
  - `dist/core/cache-warmer.js` 第 238 行是否真的重放上一次请求；
  - 1.5.1 `dist/core/cache-warmer.js` 第 188 行是否真的发 `cache_warm` 条目和 `entry_appended`；
  - `docs/extensions.md` 第 912、929 行原话；
  - `docs/models.md` 第 106 行；
  - `cacheWarming` 1.5.0 默认 `"streaming"`、1.5.1 默认 `"idle"`；
  - `cache_warming_decision` 是扩展事件还是会话事件；
  - `additionalExtensionPaths` 等是否只接受普通文件。
- 作者说 Pi 1.5.0 源码在 `node_modules/@earendil-works/pi-coding-agent` 下，本检出读不到；无法判断完整环境里是否能读到。
- 第 4 轮 `judgments.md` 中“两条判为不成立”的原文未读到：`git show` 该 records 路径被环境拒绝，标“未核实”。
- “预热沿用遮盖 fetch 和密钥”只有 Himawari 侧“传了什么 fetch/key”的代码证据，Pi 是否复用仍未核实；见上一条中级问题。
- “每次运行新建 Pi 会话、跑完关掉”读代码证实：`pi-runtime-adapter.ts:1523-1524` 在 `run()` 内取 `sessionFactory`，`1554-1615` 创建会话，`1817-1822` 的 `finally` 调 `session.dispose()`。这条作者说法成立。

## 侧重检查

- **错误路径**：网关预热的单次 `fetch` 包装器会在第二次请求抛错；D7 若只按文档实现，可能先得到运行期错误，而不是可用预热。见中级问题 1。
- **不合规范或不可信输入**：`resources` 路径当前只查非空和字符串重复，不查目录、真实路径、符号链接；新文档把它写成未来要求，但与当前实现一致（文档也说明了当前只查这两项）。生产入口确实没有接，默认空列表。
- **安全**：出口遮盖和密钥是否覆盖预热是本次最关键的安全断言，但依赖未读到的 Pi 源码；网关路径上已有代码证据表明“照样”不成立。路径授权还存在检查后换符号链接的时间窗。见中级问题 1、2。
- **资源耗尽**：预热会花钱，当前 Himawari 没有预算判断也没有用量记录；文档承认这一点并把它推给 D7，本次没有新增缓解措施。当前预热是关闭的。
- **不可撤销操作**：本轮没有运行时改动，无。
- **规则、说明文档和代码一致性**：文档对 `KNOWN_IGNORED_EVENTS`、`ModelUsageSource`、`session.dispose()`、`authorizedPaths` 的描述与代码一致；新增的 realpath/普通文件/按真实路径去重没有代码实现，文档已标为“以后接这个端口”的要求，不是虚假陈述。未运行任何检查命令，文档链接和表格检查的结果未核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本轮只有文档改动，没有代码路径变化；系统提示、工具定义、历史消息、遮盖结果的组装代码都没动。缓存预热是额外的重放请求，不改正常请求的前缀；文档也没有要求把每轮会变的值挪进系统提示或工具定义。发给模型的内容仍只在末尾追加、每轮会变的值仍应在最后一条消息里；但预热请求实际复用哪些选项依赖未读到的 Pi 源码，标“未核实”。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。本轮没有改序列化、遮盖规则、工具顺序或列表顺序。未来如果实现“按真实路径去重”，必须保持输入顺序，否则会引入顺序不确定性；当前只是文档要求，没有实现。预热如果沿用旧密钥或旧遮盖规则，鉴权头可能变，但正文遮盖是否逐字节相同依赖 Pi 是否复用同一 `fetch`，未核实。

3. **有没有对应的自动检查？反向用例会真的失败吗？**
   没有针对本轮内容的事实性自动检查。`npm run check:docs-links`、`check:markdown-tables`、`check:instruction-links` 只查链接、表格和指令链接是否存在，不核对 `entry_appended`、`model-port`、`agent-stream`、Pi 行号这些说法。反向用例不存在，所以不会失败。建议 D7 实现时补两类测试：连续两次预热都经过出口遮盖且都带密钥；新用量 source 在迁移前被数据库和 `valid()` 拒绝、迁移后被接受。

4. **改动产生或修改的每个值，每一处使用它的地方都能接受吗？**
   - `entry_appended`：生产方按文档是 Pi（未核实）；消费方 `KNOWN_IGNORED_EVENTS` 接受并忽略（`pi-runtime-adapter.ts:219-233`），当前能接受，但也意味着用量不会进入 Himawari。
   - `model-port` / `agent-stream`：类型定义接受（`model-usage.ts:16`），持久化 `valid()` 接受（`sqlite-model-usage-operations.ts:23`），SQL `CHECK` 接受（迁移 0068 第 12 行）。
   - 预热用量若引入新的 `source`/`purpose`：**当前两端都不接受**。这是上面的低级问题 3。
   - `KNOWN_IGNORED_EVENTS`：名字和值都存在（`pi-runtime-adapter.ts:219`），`entry_appended` 在其中。
   - `pi-runtime-adapter.ts`、`packages/application/src/ports/model-usage.ts`：路径存在，引用成立。
   - `resources.extensionPaths/skillPaths/promptTemplatePaths`：生产方端口未实现；消费方适配器用 `authorizedPaths` 只接受非空、不重复的字符串（`pi-runtime-adapter.ts:739-747`），默认空列表（`288-290`）。文档新增的真实路径、普通文件、按真实路径去重目前没有任何一端实现。
   - Pi 源码行号、`docs/extensions.md` 第 912/929 行、`docs/models.md` 第 106 行：未核实。
