## 问题（按严重度）

### 1. 低 — `home.snapshot.upcoming[].text` 可能超过合约上限，导致整条 home 响应解析失败 【读代码证实；属于 PR 446 代码，合并未改动】
- 文件:行：`apps/agent-service/src/production-memory-control.ts:118-126`、`:537`；`apps/agent-service/src/production-home.ts:639`；`packages/gateway-contracts/src/contracts-v2.ts:755`
- 问题：`singleLine` 先按 Unicode 码点截到 2000，再 `join`；但 `boundedString(2000)` 校验的是 UTF-16 `length`。含 emoji 等增补平面字符时，2000 个码点最多是 4000 个 UTF-16 单元，合约会拒绝 `upcoming.text`。
- 证据：
  ```ts
  // production-memory-control.ts:118-126
  const singleLine = (text: string) =>
    [...text].map(...).join("").trim().slice(0, 2000);

  // production-memory-control.ts:537
  const text = memory ? singleLine(await this.readText(memory.contentRef).catch(() => "")) : "";

  // production-home.ts:639
  upcoming: feed.upcoming.map((entry) => ({ ...entry })),

  // contracts-v2.ts:755
  text: boundedString(2000),
  ```
  `boundedString` 的判定在 `packages/gateway-contracts/src/validation.ts:89-106`：`input.length > maximum`。
- 建议：在 `upcomingViews` 或 `ProductionHomeControl.query` 里按 UTF-16 长度再夹一次（例如 `text.slice(0, 2000)`），或把 `boundedString` 改成按码点计数；补一条含 emoji 的反向用例。
- 影响范围：当前 `ci/operations-pending.json:14` 说明 `home.read` 还没有生产调用方（Apple 第 3 步 / PR 404），所以目前主要影响测试和接入后的首页。

### 2. 低（测试稳定性，推测） — 数据导出集成测试按 3 秒轮询等异步构建
- 文件:行：`apps/agent-service/test/production-http-composition.unit.test.ts:1204`
- 备注：`for (let attempt = 0; attempt < 300 && exported.state === "running"; attempt += 1)`，每轮 `10ms`。这是 main 带来的测试；在负载高的 CI 上，构建耗时超过 3 秒会偶发失败。未运行测试，属于推测。
- 建议：改成带超时上限的 `waitFor`/指数退避，或注入可立即完成的 `build`。

### 3. 信息 — “这些修改没有涉及发给模型的内容”需要限定范围 【读 git diff 证实】
- 对**冲突解决涉及的 5 个文件**成立：`production-approval-gateway.ts`、`production-http-composition.ts`、`production-http-composition.unit.test.ts`、`contracts-v2.ts`、`home-feed.test.ts` 都是网关、合约、组合和测试，不组装模型输入。
- 但若“这些修改”指 `903ba9..030f` 整个增量，则不准确：该增量合入了 main 的 `packages/prompt-catalog/src/{chat,mail,memory,eval}.ts`、`packages/prompt-catalog/prompt-manifest.json`、`apps/agent-service/test/__prompt_golden__/*` 变更。
- 这些是 main 已有内容，不是本 PR 产生；相对基准 `8c9bd` 不改变模型请求开头。按 `.claude/rules/prompt-prefix.md` 第 6 条，已有对话的系统提示按对话冻结，只有新对话使用 main 的新文字。

### 4. 未核实 — 未逐一核对 890 个 main 文件的语义
- 合并增量很大，我重点核对了 5 个冲突文件、操作清单、合约映射、相关构造点和测试；其余 main 变更按“基准 `8c9bd` 已存在”处理，未逐文件复核。也未运行 lint/typecheck/测试，只读了提交说明和代码。

---

## 侧重检查

- **错误路径/不可信输入**：`data.export` 下载路由先查 `sec-fetch-site`（403），再认证 Owner（401），`exportId` 走 `DATA_EXPORT_ID_PATTERN`（400），未就绪 404，构建中 429，构建失败 500：`apps/agent-service/src/production-data-export.ts:379-401`。合约还校验 `downloadPath` 必须属于该 `exportId`：`packages/gateway-contracts/src/contracts-v2.ts:828-849`。未发现路径穿越或任意文件读取。
- **标识两端校验**：生成端 `data-export:${randomBytes(16).toString("base64url")}`（`production-data-export.ts:210`，22 字符）与合约正则 `/^data-export:[A-Za-z0-9_-]{22}$/`（`contracts-v2.ts:795`）、路由校验（`production-data-export.ts:388`）一致；`downloadPath` 生成端用 `encodeURIComponent`，合约端用 `URLSearchParams` 解码后比对，双向一致。
- **安全/授权**：`data.export.start` 要求 actor 是 owner 且 scope 匹配（`production-data-export.ts:339-351`）；`home.read`/`data.export.status.read` 走网关统一 owner/session 授权（`agent-gateway-v2-service.ts` 的 `authorize`）。未发现新增加的可绕过授权的入口。
- **资源耗尽**：导出上限 512MB（`production-data-export.ts:36`）、同一时刻一个构建任务、64 个幂等键上限（`:201`）、10 分钟保留；首页读取有 `sourceReadLimit`/`awaitingLimit` 等配置上限。没有发现明显无界放大。
- **不可撤销操作**：`data.export.start` 只生成只读归档；合并解决的 `unitOfWork` 包裹的是敏感审批写入，main 的 `production-memory-capture.test.ts` 有回滚用例（我读到用例存在，但未运行）。
- **规则/文档一致性**：本 PR 未改 `packages/prompt-catalog`；`ci/operations-pending.json:4-5,14` 的 `data.export.*`、`home.read` 都在合约里，且检查脚本要求“缺调用方就必须在 pending”（`scripts/check-operations.mjs:205-213`）。仓库里没找到 TypeScript 前端调用 `home.read`/`data.export.*`，所以 pending 是对的。

---

## 结论与作者说法核对

- **没有阻断性问题**。冲突解决是干净并集：`git diff 7700aa..030f` 只显示 main 侧新增，`git diff 8c9bd..030f` 只显示 PR 侧新增；两边条目都在。
- “分派链里 home.read 和 data.export.* 互不遮挡”：**成立**。`production-approval-gateway.ts:116-138` 先是精确 `home.read`，后面 `data.export.` 分支前没有任何会匹配 `data.export.` 的前缀；两者都到达各自 control。
- “合并后没有丢掉任何一边的条目”：**对作者列出的文件成立**。消息类型和 schema 映射在 `contracts-v2.ts:140-144`、`:2847-2851`；安装清单在 `production-http-composition.ts:701-702` 和 `production-approval-gateway.ts:283-284`；测试断言在 `production-http-composition.unit.test.ts:370-372`、`:1170-1180`、`:1190-1234`。整个 890 文件合并未逐一核对。
- “这些修改没有涉及发给模型的内容”：**对冲突解决成立，对 `903ba9..030f` 整个增量不成立**（见问题 3）；但不构成对模型请求前缀的回归。
- `home-feed.test.ts` 的 `unitOfWork: repository.unitOfWork()`（:193）是必要且正确的修复；`ProductionMemoryControl` 的 `unitOfWork` 在 `production-memory-control.ts:177` 已为必填，生产构造点在 `production-http-composition.ts:1081`。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   相对基准 main `8c9bd`：**不会**。本 PR 没有改 prompt-catalog、工具定义、历史或遮盖；`home.read` 与 `data.export.*` 是独立的网关查询/下载路径，不进入模型输入。合并解决本身也没有把每轮会变的值塞进系统提示或工具定义。
   合入 main 带来的 prompt-catalog 变更相对上一轮 `903ba9` 存在，但那是 main 的内容，已有对话按规则第 6 条冻结，只影响新对话。
   因此“发给模型的内容只在末尾追加、每轮变化值在最后一条消息”这一条没有被本改动破坏；本改动根本没有改模型输入路径。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   对**模型输入**：**不会**。本 PR 没有引入依赖前后文的遮盖、时间字段或无序列化。
   对**非模型输出**：`home.snapshot` 的 `generatedAt`/`revision`、数据导出 ZIP 的时间戳和 `exportedAt` 每次可能不同；但它们是展示/导出产物，不参与 KV 缓存。若以后把它们当提示词资料复用，需要另行处理。

3. **有没有对应自动检查，反向用例会失败吗？**
   **有**：`packages/gateway-contracts/test/gateway-v2.contract.test.ts` 用 `GATEWAY_V2_MESSAGE_TYPES` 做全量 fixture round-trip；`data-export-gateway.contract.test.ts` 覆盖非法 exportId、错误 downloadPath、未知 state、额外字段；`production-http-composition.unit.test.ts` 覆盖 home 与 data export 的成功路径及无会话 401；`test/integration/home-feed.test.ts` 和 `test/integration/data-export-http.test.ts` 覆盖集成行为；`scripts/check-operations.mjs` 校验安装清单和 pending 清单。
   反向用例方面：删掉 `home.read` 或 `data.export.` 分支后，对应查询会落到 `searchAuthorization.query`，后者对未知类型直接抛 `SEARCH_OPERATION_NOT_INSTALLED`（`public-search-authorization.ts`），所以现有测试会失败。**但没有专门制造“分派顺序遮蔽”的负数用例**；保护主要来自两条正向路径加兜底抛错。以上是读代码推断，未实际运行测试。

4. **每个产生/修改的值，使用它的地方都能接受吗？**
   - `home.read` / `data.export.start` / `data.export.status.read`：同时存在于 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、`PRODUCTION_*_OPERATIONS`、安装清单和 `ci/operations-pending.json`，`check-operations` 会校验安装项必须是合约操作、pending 项也必须在合约里；一致。
   - `data.export` 的 exportId：生成端 22 字符 base64url，合约、状态查询、下载路由三处都接受；`downloadPath` 生成与合约校验两端一致。
   - `unitOfWork`：生产构造点 `production-http-composition.ts:1081`、`production-run-composition.ts:538`（记忆采集）以及各集成测试都提供了；`apps/agent-service/test/production-memory-basis.unit.test.ts:54` 用 `as never` 绕过必填，但该测试不调用 `resolveSensitive`，属测试取巧，不是生产缺口。
   - `home` 与 `DataExportJobs`：同一个 `dataExportJobs` 实例同时交给 `ProductionDataExportControl`（`:1235-1237`）和下载路由（`:1283`），状态快照里的下载路径能被路由接受；如果分开构造，下载会 404。
   - **唯一发现的两端不一致**是问题 1 的 `upcoming.text`：生产端按码点截 2000，合约按 UTF-16 长度校验 2000。其余本次改动涉及的值未发现产生端与消费端校验不一致。
