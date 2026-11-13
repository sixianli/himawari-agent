# PR 477 复核报告

## 一、读代码证实的问题（按严重度）

### 1. 中 — 单个对话标题读不出来会让整个文件列表失败
- 位置：`apps/agent-service/src/production-files-control.ts:70-74`；`apps/agent-service/src/classified-thread-title.ts:42-52`
- 问题：文件列表对每页每个不同对话调用一次 `threadTitle`，而 `threadTitle` 内部直接 `payloads.get`、`TextDecoder({fatal:true})`、`protector.unprotect`，没有任何 `try/catch`。任何一条标题荷载缺失/损坏、解密失败或不是合法 UTF-8，都会抛到 `query` 外，导致整页 `files.list.read` 失败，而不是把该条的 `threadTitle` 置空。
- 证据：
  - `production-files-control.ts:71-73`
    ```ts
    for (const threadId of new Set(page.items.map((artifact) => artifact.threadId))) {
      const title = await this.#options.threadTitle(threadId);
      titles.set(threadId, title === null ? null : displayText(title));
    }
    ```
  - `classified-thread-title.ts:49-51`
    ```ts
    const title = new TextDecoder("utf-8", { fatal: true }).decode(
      await options.protector.unprotect({ ownerId, agentId, payload }),
    );
    ```
  - 对照：审批展示路径会兜底，`production-approval-display.ts:75-79` 有 `try { ... } catch { title = null }`。新的文件列表消费方没有。
- 建议：对每个 title 读取单独 `try/catch`，失败按 `null` 处理并记诊断；补一条“标题读取抛错时整页仍然成功、该行 `threadTitle:null`”的反向用例。

### 2. 中 — `login.devices.revoke_others` 不是原子操作，中途失败会留下已退出设备且不回滚
- 位置：`apps/agent-service/src/production-login-devices-control.ts:97-110`；`packages/persistence-sqlite/src/sqlite-durable-operations.ts:5064-5068`
- 问题：先 `listDevices(ownerId, false)`，再用列表里拿到的 `revision` 逐台 `revokeDevice`。`revokeDevice` 在每个设备自己的事务里要求 `revision` 匹配且状态仍为 `active`；任意一台在列表之后被并发更新（例如重新登录）就会抛 `PORT_CONFLICT`，前面已退出的设备不会回滚。退出设备是不可逆操作（需要重新配对/登录）。
- 证据：
  - `production-login-devices-control.ts:107-109`
    ```ts
    const revokedAt = this.#options.clock.now();
    for (const device of others)
      await this.#options.state.revokeDevice(device.id, device.revision, revokedAt);
    ```
  - `sqlite-durable-operations.ts:5066-5067`
    ```ts
    if (current.revision !== input.expectedRevision || current.status !== "active") {
      this.fail("PORT_CONFLICT", `Device ${input.deviceId} cannot be revoked`);
    }
    ```
- 说明：作者已明说“中途某台失败时前面已退出的不回滚”，所以这是有意取舍，不是隐藏行为；但当前没有任何测试覆盖“循环中途失败”的路径。
- 建议：增加一个存储层的批量操作（例如 `revokeDevicesExcept(ownerId, exceptDeviceId, revokedAt)`），在单个 `immediate` 事务里完成；若不改存储层，至少对 stale revision 做有限重读重试，并返回结构化的部分成功结果。补一条中途冲突的反向用例。

### 3. 低 — 取消无法中断同步打包；“packing”阶段实际上不可观察，现有测试用的是假 build
- 位置：`apps/agent-service/src/production-data-export.ts:333-337`；`test/integration/data-export-http.test.ts:700-728`；`packages/persistence-sqlite/src/data-export/export.ts:124-...`
- 问题：`onProgress({stage:"packing"...})` 之后紧接着同步执行 `createStoredZip` 和 `Buffer.from`，中间没有 `await`。Node 单线程下，取消请求或状态查询不可能在这段同步代码中间被处理；因此：
  1. 真实的“打包中途取消”不会生效，取消只能在进入打包前的异步读取阶段生效；
  2. 客户端实际上看不到 `stage:"packing"`（状态请求只能在打包结束后才被处理，之后状态已是 ready，`progress` 被置 `null`）。
  测试 `[iOS] 打包快结束时取消` 使用的是注入的 `build: async () => { await finished; ... }`，并不走真实的 `createStoredZip`，所以不能证明打包阶段可取消。
- 证据：
  - `production-data-export.ts:333-337`
    ```ts
    onProgress({ stage: "packing", ...read });
    signal.throwIfAborted();
    const zip = createStoredZip(result.files, result.manifest.exportedAt);
    signal.throwIfAborted();
    const archive = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
    ```
  - `data-export-http.test.ts:711-721` 的假 `build` 实现。
- 建议：如果产品要求“打包阶段也能取消/显示进度”，需要把打包改成可分片或让出事件循环，并在分片之间检查 `signal`；否则在接口/文案中明确“取消只在读取阶段生效”，并考虑不要宣称 `packing` 阶段可见。若要保留该测试意图，应使用真实 `buildPortableExport` + 大数据的打包路径。

### 4. 低 — `start`/`cancel` 在作业被替换后的幂等语义有缺口
- 位置：`apps/agent-service/src/production-data-export.ts:214-228`、`274-293`
- 问题：
  - `start` 只在当前作业是 `running` 或 `ready` 时按 idempotency key 重放。作业被取消后，用同一个 key 重发 `data.export.start` 会创建**新的**导出，而不是重放原请求。
  - `cancel` 只看当前 `#job`。如果旧导出已被新的 `start` 替换，重发旧 `exportId` 的取消得到 `DATA_EXPORT_NOT_FOUND`（404），而不是 `replayed`。
  这两点不影响作者描述的正常流程，但在“响应丢失后重试”“跨设备重试”等场景下与幂等预期不一致。
- 证据：
  - `production-data-export.ts:215-227`：只有 `running`/`ready` 才进入重放/复用分支。
  - `production-data-export.ts:276-281`：`job.exportId !== exportId` 直接 `DATA_EXPORT_NOT_FOUND`。
- 建议：为 `start`/`cancel` 保存有界时间窗的幂等结果（或持久化回执），或至少在文档中写明“取消后同一 key 的 start 会重新导出、旧导出被替换后 cancel 返回 404”。补“取消后同 key 重发 start”“新 start 后重发旧 cancel”两条测试。

### 5. 低 — 文件列表标题和审批标题的展示管线不同（是否应遮敏感值需确认）
- 位置：`apps/agent-service/src/production-files-control.ts:73,85`；`apps/agent-service/src/production-approval-display.ts:85`；`packages/application/src/services/approval-display.ts:24-31`
- 问题：同一个对话标题，审批展示会经过 `approvalBodyPreview` → `maskSensitiveText`，而文件列表只经过 `displayText`（替换控制字符并截断到 256），不会遮掉认出的密码/卡号等值。ADR 0183 说内部存储和界面展示用原文，因此这可能是**有意**的；但同一个标题在两个面向主人的界面里处理不同，至少需要明确取舍。
- 证据：
  - 审批：`production-approval-display.ts:85` 调用 `approvalBodyPreview(title, 120)`，`approval-display.ts:27` 内部 `maskSensitiveText(text)`。
  - 文件列表：`production-files-control.ts:73` 只有 `displayText(title)`。
- 建议：确认产品要求。如果文件页也应遮敏感值，在 `ProductionFilesControl` 里复用同一套展示函数；如果按 ADR 0183 有意显示原文，在规格或注释里写明并补一条用例固定这个行为。

### 6. 低 — 若干反向用例缺失，作者声称“去掉会失败”的只有部分被真正覆盖
- 位置：`apps/agent-service/src/classified-thread-title.ts:43-48`；`test/integration/sqlite-thread-artifacts.test.ts:420-441`；`test/integration/data-export-http.test.ts:700-728`
- 具体缺口：
  - `contentType !== "text/plain"` 分支没有反向用例：测试里所有标题都是 `contentType: "text/plain"`（`sqlite-thread-artifacts.test.ts:431`），删掉这个判断测试仍会通过。
  - 没有“`unprotect` 抛错 / 非法 UTF-8 时文件列表如何处理”的用例。
  - “每页按对话去重读取”没有调用次数断言；删掉去重逻辑测试也不会失败。
  - `revoke_others` 没有“循环中途某台失败”的用例。
  - 真实打包阶段的取消没有用例（见问题 3）。
- 建议：补上述反向用例；至少让“删除对应检查后测试变红”这一点对 `text/plain` 过滤和去重也成立。

### 7. 低 — 作者“导出包只有记忆和规则”的说法与代码不一致
- 位置：`packages/persistence-sqlite/src/data-export/types.ts:14-32`；`packages/persistence-sqlite/src/data-export/export.ts:600-613`
- 问题：最终导出还包含 `people`、`importBatches`、`consolidations`、`conversationReviews`、`decisions`/`decisionSignals`、`rules`/`ruleHistory`、`externalProposals` 等（与 ADR 0200/0233 一致）。作者说“只有记忆和规则”是不准确的。关键部分“不带对话”是对的：`base..head` 对 `packages/persistence-sqlite/src/data-export/chats.ts`、ADR 0235 的净改动为零，最终 `production-data-export.ts` 也没有线程/消息计数字段。
- 建议：把说明改成“记忆、决定记录、人物、导入批次、整理记录、规则等，不导出对话”；代码无需改。

## 二、推测 / 未核实

- **未核实**：iOS 第 11 批客户端是否接受新增的必填字段 `files.list.snapshot.files[].threadTitle`、`data.export.status.snapshot.payload.progress`，以及新命令 `data.export.cancel` / `login.devices.revoke_others`。仓库里没有对应 Swift 调用方；`ci/operations-pending.json` 也把两者标为“缺调用方”，所以这一端的验收无法在本仓库核到。
- **未核实**：标题荷载是否可能在真实数据里损坏或超长。生成路径把自动标题限制在 120 字符（`production-thread-titles.ts:97`），但我没有继续追完 owner 手动重命名路径的荷载大小上限；问题 1 的“单个坏标题拖垮整页”在机制上成立，触发概率取决于数据来源。
- **未核实（未运行测试）**：我没有运行测试，只读了代码。因此“反向用例会失败”是代码推理，不是执行结果。
- **推测**：问题 3 中真实 `createStoredZip` 的耗时/内存取决于导出大小；ADR 0200 已说明网页导出在内存里生成、打包同步、限制 512 MB，因此“打包不可取消”在大库上会变成取消后仍长时间占用内存/CPU。

## 三、侧重检查

- **错误路径**：检查了 `data.export.cancel` 的未找到/过期/已取消/已失败分支（`production-data-export.ts:274-293`，控制层 429、431-435）、abort 后成功/失败回调的状态保护（250-269）、`files.list` 标题读取异常（问题 1）、审批标题异常兜底（`production-approval-display.ts:75-79`）、`revoke_others` 最近验证失败/非本 agent（`production-login-devices-control.ts:97-110`）。
- **不合规范或不可信输入**：检查了 `exportId` 的 `DATA_EXPORT_ID_PATTERN`（`contracts-v2.ts:803`，生成值 `randomBytes(16).toString("base64url")` 正好 22 字符且字符集匹配）；`recentAuthenticationRef` 的 `machineString`（真实 session ref 为 `sha256:<64 hex>`，允许冒号、长度 71，能通过）；文件列表标题的控制字符/bidi 清洗（`production-files-control.ts:19-26`）与契约 `nullable(boundedString(256))`（`contracts-v2.ts:916`）的长度和空串要求一致；契约对象拒绝额外字段。
- **安全**：检查了 `data.export.cancel` 和 `revoke_others` 的 owner/agent/actor 校验（`production-data-export.ts:408-418`、`production-login-devices-control.ts:46-62`）；批量退出要求最近验证且有测试；文件标题只取 `public`/`private` 且 `text/plain`；标题值在审批与文件页的遮盖差异见问题 5；没有发现新的越权读取或跨 owner 访问。
- **资源耗尽**：文件列表每页最多 100 条，按不同对话顺序解密标题（最多约 100 次解密，且理论上标题明文无上限，直到 `displayText` 截断）；导出取消不能打断正在进行的 `unprotect`（只能在其返回后观察到 abort），也不能打断同步打包；`revoke_others` 的设备数量没有硬上限，逐台串行。均未发现新增的无限循环或明显放大路径，但大库/坏标题下值得注意。
- **不可撤销操作**：`revoke_others` 的部分失败不回滚（问题 2）；取消已生成导出会丢弃内存中的 archive，但可重新导出，不造成数据丢失。
- **规则/文档一致**：`prompt-prefix` 规则未被触碰；ADR 0200/0235 最终净改动为零，ADR 0263 已完全移除且无残留引用（全仓库搜索 `0263` 无结果）；`ci/operations-pending.json` 的两条理由与代码一致；`check:operations` 的扫描逻辑确认这两个操作当前只会被判定为“缺调用方”，因此留在待办名单是合规的。

## 四、逐条回答必答问题

1. **会不会改变模型已经见过的请求开头？**
   - **不会。** 本次净改动只涉及网关设置页的导出/文件/登录设备、数据导出实现和契约，没有修改 `packages/prompt-catalog`、`packages/runtime-pi`、模型出口遮盖或线程提示组装。`classifiedThreadTitleReader` 只被用于文件列表和审批展示（`production-http-composition.ts:1251`、`service-main.ts:1615`），不进模型请求。发给模型的内容仍然只在末尾追加；每轮变化的值仍在最后一条消息里。导出包也不导出对话（对 `chats.ts`/ADR 0235 的净改动为零）。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   - **不会（就模型内容而言）。** 标题读取对同一份数据库和同一荷载是确定的：解密 + `trim` + `displayText` 都是纯函数；`Set`/`Map` 保持插入顺序，不依赖哈希顺序。新增的非模型响应里确实有随请求变化的 `generatedAt`，导出 zip 里也有既有的 `exportedAt`，但都不进入模型请求。没有引入依赖前后文的遮盖或新的无序集合序列化。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   - **有较完整的检查，但有几处缺口。** 已有：进度契约（非 running 带进度、`textsRead > textsTotal`、未知 total/stage/百分比、额外字段）、取消命令契约（缺 exportId、非法 id、额外字段）、文件标题契约（缺字段、控制字符、超长）、`revoke_others` 契约（缺字段、额外 deviceId、带空格的 ref）；集成/单元测试覆盖了真实进度计数、取消运行中/已生成/已失败/未知 id、取消重发 replayed、取消后重新开始、成功/失败回调不覆盖 cancelled、标题的 public/private/sensitive/restricted/空白、批量退出的成功/无其他设备/最近验证失败/非本 agent。
   - **作者声称“去掉任何一个对应用例都失败”的四项**（成功回调不改状态、循环里的取消检查、进度回调、快照只在 running 给进度）经代码核对都确实有能变红的用例。**缺口**：`text/plain` 过滤、标题解密/UTF-8 失败、每页去重调用次数、`revoke_others` 中途失败、真实打包路径的取消、取消后同 key 重发 start / 新 start 后重发旧 cancel。另外我没有运行测试，以上是读代码判断。

4. **每个产生/修改的值，两端都能接受吗？**
   - 逐项核对如下：
     - 操作名 `data.export.cancel`、`login.devices.revoke_others`：已同时出现在 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、`PRODUCTION_*_OPERATIONS`、`ci/operations-pending.json` 和测试/夹具中；路由前缀 `data.export.` / `login.` 能到达对应控制层；无其他硬编码清单遗漏。
     - 状态 `cancelled`：契约 `DATA_EXPORT_STATES`、`DataExportJobView`、状态快照、Web 下载路由（非 ready 即 404）一致。
     - `progress.stage/read/total`：产生于 `buildPortableExport`/`DataExportJobs`，控制层只在 running 时输出，契约枚举与 `integer(0)` 匹配。
     - `threadTitle`：产生方 `displayText` 保证非空、≤256 code units、控制字符已替换，满足 `nullable(boundedString(256))`；集成测试用 `gatewayV2MessageSchema` 解析真实输出。
     - `data.export.cancel.payload.exportId`：生成值 `data-export:` + 22 位 base64url，匹配 `DATA_EXPORT_ID_PATTERN`；Web 下载路径也用同一模式。
     - `login.devices.revoke_others.payload.recentAuthenticationRef`：`machineString` 接受真实值 `sha256:<64 hex>`；控制层把它原样交给 `RecentAuthenticationGuard`，类型为 `string | null`。
     - `data.export.cancel` / `revoke_others` 的 `resultRef`：分别是 exportId 和 deviceId，如果是命令结果的 `machineString` 校验也能通过（字符集、长度均符合）。
   - **唯一需要确认的“使用端接受度”** 是标题在文件页的展示是否应像审批页一样遮敏感值（问题 5），以及 iOS 端是否按新契约解析（仓库内无 iOS 代码，未核实）。除此之外没有发现 I-73 式的“产生值通过、使用端校验不接受”的硬冲突。

## 五、结论

改动没有触碰模型请求内容，导出只增进度/取消、不改变导出范围，契约与实现的主要值两端一致；但文件列表的标题读取缺少单条失败隔离，批量退出不是原子操作，真实打包阶段无法取消，且若干反向用例缺失。建议至少修复问题 1、2，并对问题 3/4 的语义和文案做出明确取舍。
