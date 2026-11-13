## 结论

未发现高严重度缺陷。第 3 轮的修复（多确认键、失败/过期不重放）与代码一致；但作者说明中的“保留期内都重放到同一编号”在**网页直接下载**介入时不成立，且网关忙时的 409 没有自动用例。以下按严重度排列。

## 一、读代码证实的问题

### 1. 中：网页直接下载会先丢掉已就绪的网关导出；网页生成失败也会丢掉

文件：`apps/agent-service/src/production-data-export.ts:176`、`:190-204`、`:219-227`、`:391-394`；`test/integration/data-export-http.test.ts:329-334`

问题：`buildNow()` 在开始构建前无条件丢弃任何非 `running` 的任务；网页直下（不带 `exportId`）调用的就是它。于是 iOS 已经拿到的 `resultRef` 会在保留期内被作废，所有已记录的确认键也一起丢失——同一个键重发会生成新编号。这与作者“保留期内都重放到同一编号”的说法不一致。更差的是，网页直下**构建失败**时，旧任务已经在构建前被丢掉，用户既拿不到网页结果，也失去了原先可下载的 iOS 结果（可重导，不是永久数据丢失）。

证据：

```ts
// production-data-export.ts:176
if (this.#job && this.#job.state !== "running") this.#discard();
```

```ts
// production-data-export.ts:391-394
if (options.jobs.busy) return reply.code(429).send();
try {
  built = await options.jobs.buildNow();
```

```ts
// data-export-http.test.ts:329-334：网页直下后，原来的网关导出直接变成 expired
const direct = await app.inject({ method: "GET", url: DATA_EXPORT_PATH, headers: asOwner });
...
expect((await status(exportId)).state).toBe("expired");
```

建议：网页直下遇到“已就绪、未过期”的现有任务时，复用它已生成的 archive（仍只有一份）；或新构建成功后再替换旧任务，失败时保留旧任务。若确实要保留当前行为，应把“网页直下会使网关导出提前失效”写进作者说明和接口文档。

### 2. 中低：网关忙返回 409 没有自动检查

文件：`apps/agent-service/src/production-data-export.ts:357-358`；`packages/platform-node/src/http-gateway-server.ts:883-891`

问题：代码把 `DATA_EXPORT_BUSY` 映射为 `PORT_CONFLICT`，HTTP 层再映射为 409，作者也更正了这是有意行为；但我在 `test/integration/data-export-http.test.ts` 和 `apps/agent-service/test/production-http-composition.unit.test.ts` 里只读到 429，没有 409 的断言。触发条件（网页直下正在构建时再走网关开始）没有任何用例守护。

证据：

```ts
// production-data-export.ts:357-358
if (error instanceof Error && error.message === DATA_EXPORT_BUSY)
  throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, DATA_EXPORT_BUSY);
```

```ts
// http-gateway-server.ts:883-891
if (error instanceof ApplicationPortError) {
  const statusCode = ... : 409;
```

建议：加一条用例：用一个挂起的直下构建占住 `#building`，再经 `ProductionDataExportControl.execute` 发 `data.export.start`，断言 `PORT_CONFLICT`/409。

### 3. 低：`idempotencyKeys` 在构建期间无上限

文件：`apps/agent-service/src/production-data-export.ts:145`、`:198-202`

问题：构建运行期间，每个新确认键都会被加入 Set，没有数量上限。构建可能持续较久（导出上限 512 MiB），已认证主人可不断用不同键请求，造成内存增长。键本身受 `machineString` 1-128 限制，但数量不受限。

证据：

```ts
readonly idempotencyKeys: Set<string>;
...
if (current.state === "running") {
  current.idempotencyKeys.add(idempotencyKey);
```

建议：给 Set 设上限（例如超过 N 个后拒绝并返回冲突/忙），或只保留最近若干个键；同时补一条资源上限用例。

### 4. 低：契约没有把 `downloadPath` 里的编号与 `payload.exportId` 绑定

文件：`packages/gateway-contracts/src/contracts-v2.ts:673-674`、`:693`；`packages/gateway-contracts/test/gateway-v2.fixture.ts:440`、`:448`

问题：`exportId` 有严格模式，`downloadPath` 只按 `boundedString(256)` 校验。第 3 轮把契约样例的下载地址改成由同一个编号生成，这正确；但契约本身仍不检查“路径里的 exportId 等于 payload.exportId”，将来再次漂移时契约测试不会失败（上一版样例正是这样漂移的）。生产行为由 `data-export-http.test.ts` 的真实下载间接守住，但契约层没有门槛。

证据：

```ts
export const DATA_EXPORT_ID_PATTERN = /^data-export:[A-Za-z0-9_-]{22}$/u;
...
downloadPath: boundedString(256),
```

```ts
// gateway-v2.fixture.ts:448
downloadPath: `/api/data-export/v1/archive?exportId=${encodeURIComponent("data-export:AAAAAAAAAAAAAAAAAAAAAA")}`,
```

建议：把 `data.export.status.snapshot` 的 `result` 改成自定义 schema，解析 `downloadPath` 的 `exportId` 查询参数并要求等于 `payload.exportId`；或在消费端加一条反向用例（样例中改错一个字符必须失败）。

## 二、推测 / 需确认

### 5. 低（文档一致性）：设备接口“不包含导出”与新网关操作的关系没有写清

文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:231`；`ci/operations-pending.json:4-5`

已读到：

```md
设备能做的就是这张表，不是网页能做的全部。比如设备接口里没有“改规则”“删记忆”“导出数据”，这些只在嵌入的网页里做，走网页会话
```

而 pending 名单写的是“调用方是 iOS 第 11 批原生页”。网关 v2 命令实际要求网页会话 cookie + CSRF（`http-gateway-server.ts:1084-1100`），所以如果“原生设置页”用的是嵌入网页会话，两者并不矛盾；但仓库里没有 iOS 调用方，无法核实。建议在设备设计或 ADR 里补一句：`data.export.*` 走网关 v2、要求网页会话，不是设备签名接口，并把新的导出/重放语义写进文档。

## 三、侧重检查

- **错误路径**：网页直下的 400（编号不合格）、401（未登录/换主人）、403（跨站）、404（编号不存在/未就绪/已过期/失败）、429（忙）、500（构建失败）都有用例；网关开始的 401/403 由公共鉴权覆盖，`DATA_EXPORT_OWNER_REQUIRED` 有用例；**409 忙无用例**（见问题 2）。失败任务不可下载、过期任务不可下载都有用例。
- **不合规范/不可信输入**：查询参数 `exportId` 先判 `typeof === "string"` 再用共享的 `DATA_EXPORT_ID_PATTERN`；重复参数变成数组会被 400；空串不匹配会被 400。网关里的 `exportId` 由契约模式校验，非法编号在进入控制层前被拒。`downloadPath` 只做长度/控制字符校验，存在上面问题 4 的跨字段缺口。
- **安全**：下载路由要求已认证主人会话、同源 `Sec-Fetch-Site`、`no-store`/`no-referrer`；网关路径经 `ProductionThreadGatewayAccessPolicy` 校验 owner、agent、活跃会话；导出编号是 128 位随机值，同时仍需会话，不能仅凭编号下载。错误日志只记录经过 `exportFailureCode` 过滤的代码，不写原始错误。压缩包条目名来自内部导出逻辑，不是用户输入；文件名来自内部时间戳，未发现头注入。
- **资源耗尽**：全局只有一个 `#building`，网页与网关共用，能限制同时构建一份，压缩包上限 512 MiB；但构建期间 `idempotencyKeys` 无上限（问题 3），且反复用新键开始会反复触发完整导出，网关命令层没有额外的速率限制。
- **不可撤销操作**：导出本身是只读；开始新导出会让旧结果失效，网页直下也会让旧结果提前失效（问题 1），但都可以重新导出恢复，没有删除数据。
- **规则/文档/代码一致性**：本次没有触碰 `prompt-prefix` 相关代码；`ci/operations-pending.json` 的“和网页同一套生成逻辑”与共享 `DataExportJobs` 的实现一致；`check:operations` 能按“缺调用方”保留这两项。设备设计文档与新网关操作的关系见问题 5。
- **未核实**：iOS 客户端如何使用 `resultRef`、`downloadPath`、`failureCode`（调用方不在仓库）；本次也**没有运行测试**（只用了只读工具），测试结论来自读代码和用 `git show` 对照旧实现。

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。改动只涉及网关 v2 消息类型/操作、数据导出 HTTP 接口、内存任务和契约样例；没有改系统提示、工具定义、历史消息或出口遮盖。新增的 `GATEWAY_V2_MESSAGE_TYPES` 和 `PRODUCTION_DATA_EXPORT_OPERATIONS` 只进入 `installedOperations`（入站操作校验）和 `installedGatewayV2Operations`（浏览器配置），不参与模型请求组装。发给模型的内容仍只在末尾追加；本轮会变的导出编号、状态、时间等都只存在于导出请求/响应中，不在模型请求头里。依据 `.claude/rules/prompt-prefix.md` 第 1、2、6 条。未核实 iOS 侧对这些值的展示方式（不在仓库）。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

对模型请求没有影响，因此不会。导出压缩包本身带 `exportedAt`（manifest 和 ZIP DOS 时间），同一份数据在不同时刻直接下载会产生不同字节和 `sha256`；但同一 `resultRef` 在保留期内重放返回的是缓存的同一个 archive，字节稳定。`idempotencyKeys` 是内存 `Set`，不序列化，不影响任何请求字节。`downloadPath` 使用 `encodeURIComponent` 固定编码。注意网页直下每次都会重建，所以两次直下的字节可能不同，这是既有行为且不影响模型缓存。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

有。`test/integration/data-export-http.test.ts` 里的 `[iOS]` 用例（父 describe 带 `[P1-6]`，由 `npm run check:data-export` 运行）覆盖开始、查进度、下载、失败、过期、忙、重复键；第 3 轮新增的 `[iOS] 生成中另一个确认键…` 会真正守住本轮修复：用 `git show c49e592b…` 读旧代码，旧实现只要键相同就无条件 `replayed: true`，且不记录生成中的第二个键，因此新用例在旧代码上会在“key-b 重放”“过期后用 key-a 重新生成”“失败后用 key-c 重新生成”三处失败。`data-export-gateway.contract.test.ts` 覆盖非法编号、未知状态、非法 sha、空包、负数、缺 expiry、多余字段等反向输入。缺口：409 忙没有用例；`downloadPath` 与 `exportId` 的一致性没有契约级反向用例。

### 4. 每个值产生处和使用处的校验都能接受吗？

逐个核对如下：

- `exportId`：产生于 `production-data-export.ts:208`（`data-export:` + `randomBytes(16).toString("base64url")`，22 字符），满足 `DATA_EXPORT_ID_PATTERN`（`contracts-v2.ts:673`）；查询 schema、快照 schema、网页路由（`production-data-export.ts:386`）三处使用同一模式；集成测试在 `:91` 用契约解析真实快照，能发现不匹配。可接受。
- `downloadPath`：产生于 `production-data-export.ts:325`，与 `exportId` 同源；网页路由解析后按同一模式校验。但契约只做 `boundedString(256)`（`contracts-v2.ts:693`），不核对路径内的编号，见问题 4。
- `state` / `failureCode` / `startedAt` / `finishedAt` / `expiresAt` / `sizeBytes` / `sha256` / `memories` / `rules` / `withheld`：产生处是 `view`/`#build`；快照 schema（`contracts-v2.ts:684-702`）要求状态枚举、可空时间、`failureCode` 机器字符串、`sizeBytes >= 1`、sha 64 位小写十六进制、计数非负、expiry 为规范时间。生成值均满足（archive 至少 22 字节、failureCode 大写且 ≤64、时间用 `toISOString()`）。可接受。
- 操作名 `data.export.start` / `data.export.status.read`：同时出现在契约列表、`PRODUCTION_DATA_EXPORT_OPERATIONS`、`installedOperations`、浏览器配置和 `ci/operations-pending.json`；`check:operations` 会检查“名单外缺项报错、名单内缺项要有理由”，当前缺“调用方”与名单一致。可接受。
- `idempotencyKeys`：产生和使用都在 `start` 内部，`view` 已剥离（`:255`），不进入契约或响应；校验只依赖命令 schema 的 `machineString`。功能上可接受，但存在无上限和跨 surface 丢失两点（问题 1、3）。
- 契约样例：`gateway-v2.fixture.ts:448` 已由同一个编号生成，当前正确；但没有测试强制这一点。
