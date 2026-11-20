### 1. 高：PR 回退了首页 binding 的测试修复，home-urgency 用例会因多出 `binding` 字段而失败

**文件:行**：`test/integration/home-urgency.test.ts:824-841`、`:953-960`；`apps/agent-service/src/production-home.ts:151`、`:884`；`packages/gateway-contracts/src/contracts-v2.ts:937`

**问题**：改动删除了三处 `binding: expect.stringMatching(/^b1\./)`，但生产代码仍然为每个按钮写入 `binding`，合约 schema 也仍然要求这个字段。测试用 `toEqual` 逐字段比较，实际对象会多出 `binding`，因此会失败；这不是无关紧要的清理，而是回退了 `291279677d` 为修复 main 上 3 条失败用例所做的修改。

**证据（读代码证实）**：
```ts
// production-home.ts:151
binding: options.command ? encodeHomeBinding(options.command) : null,
// production-home.ts:884
actions: item.actions.map((entry) => ({ ...entry })),
// contracts-v2.ts:937
binding: nullable(boundedString(HOME_BINDING_MAXIMUM)),
```
```ts
// test/integration/home-urgency.test.ts:824
expect(item?.actions).toEqual([
  {
    action: "approved",
    label: "发出去",
    // 没有 binding
```
审批动作由 `action(..., { command: approvalCommand(...) })` 生成（`production-home.ts:618-629`），`approvalCommand` 永远返回对象（`production-home-binding.ts:79-91`），所以 `binding` 不会是“缺失”而是明确的 `b1.…` 字符串。

**建议**：恢复这三处 `binding` 期望；如果确实要改返回值，必须在同一 PR 里改生产代码和合约，并说明理由。不要在本 PR 中夹带无关测试回退。

### 2. 中：真实文件 id 含冒号，文件下载路由只认未编码的原始路径，标准 URL 编码会把它挡在路由外，测试没有覆盖

**文件:行**：`packages/platform-node/src/device-api-routes.ts:68`、`:98`、`:110-115`、`:529-536`；`apps/agent-service/src/service-main.ts:290`；`apps/agent-service/src/production-thread-artifacts.ts:334`；`apps/control-center/src/gateway-client.ts:743-744`；`test/integration/device-download.test.ts:127`、`:142`

**问题**：文件 id 的实际格式是 `thread-artifact:<uuid>`（含冒号）。客户端的标准做法会用 `encodeURIComponent(fileId)`，路径变成 `thread-artifact%3A<uuid>`。但设备路由的 `onRequest` 白名单直接拿未解码的 `requestPath(request)` 去匹配 `THREAD_ID_SEGMENT`，该正则不允许 `%`，请求会在 Fastify 解析 `:fileId` 之前就被 `rejectNotAllowed()` 拒绝。测试用的是假的 `file-download-1`，不包含冒号，所以这个两端不一致没有被测出来。

**证据（读代码证实）**：
```ts
// device-api-routes.ts:68
const THREAD_ID_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";
// device-api-routes.ts:113
`^${route.path.replace("{threadId}", THREAD_ID_SEGMENT).replace("{runId}", THREAD_ID_SEGMENT).replace("{fileId}", THREAD_ID_SEGMENT)}$`
```
```ts
// service-main.ts:290
next: (namespace: string) => `${namespace}:${randomUUID()}`,
// production-thread-artifacts.ts:334
id: this.#ids.next("thread-artifact"),
```
```ts
// control-center/src/gateway-client.ts:743-744
export function fileContentUrl(fileId: string, download = false): string {
  return `/api/files/v1/content/${encodeURIComponent(fileId)}${download ? "?download=1" : ""}`;
```
```ts
// test/integration/device-download.test.ts:127
id: "file-download-1",
```

**建议**：不要用 `THREAD_ID_SEGMENT` 直接校验文件 id 的原始路径。可以允许 `%` 并校验解码后的 `request.params.fileId`，或统一要求客户端使用未编码的原始冒号路径。测试应至少覆盖真实的 `thread-artifact:<uuid>` 和它编码后的形式。

### 3. 中：PR 回退了 SI-4 的时区修复，CI 在 UTC 零点附近会再次失败

**文件:行**：`test/integration/sensitive-interceptions-browser.test.ts:159-162`

**问题**：本次删除了 `middayTimezone()` 和页面选项里的 `timezoneId`。`291279677d` 的提交说明已经写明：假数据是“20 到 300 分钟前”，在 UTC 零点后 20 分钟内运行会把最新一条归到前一天，导致“今天/昨天”断言失败；修复办法就是让页面固定落在当地中午前后。本 PR 把该修复整段回退。

**证据（读代码证实）**：
```ts
// 当前代码
const page = await browser.newPage({
  viewport: { width: 1280, height: 820 },
  colorScheme: "light",
});
```
`git show 291279677d` 的提交说明明确记录了这一失败和“改法：这一页用 Etc/GMT 时区，让当前时间落在当地中午前后”。

**建议**：恢复 `middayTimezone()` 和 `timezoneId: middayTimezone()`；不要在本 PR 中删除与设备下载无关的稳定性修复。

### 4. 中：设备接口设计文档仍写着“设备接口没有导出数据”，新值清单也没有列出本 PR 新增的路由和值

**文件:行**：`docs/execution/specs/2026-11-11-apple-device-body-design.md:232`、`:709`；`packages/platform-node/src/device-api-routes.ts:97-98`

**问题**：设计文档接口表没有这两条路由，而且第 232 行明确说设备接口里没有“导出数据”。第 709 行的第 17 节要求每个新出现的值都写明产生处、使用处、两端校验和自动检查。本 PR 新增了路由、`exportId` 查询参数、`fileId` 路径参数、`DeviceDownload` 字段和 `content-disposition` 行为，但文档都没有更新。这与“规则、说明文档和代码一致”的要求相冲突，也正是 I-73 要求避免的“只在一端认值”。

**证据（读代码证实）**：
```md
// docs/execution/specs/2026-11-11-apple-device-body-design.md:232
设备能做的就是这张表，不是网页能做的全部。比如设备接口里没有“改规则”“删记忆”“导出数据”，这些只在嵌入的网页里做，走网页会话；换网页会话要主人本人当场解锁（见上文“嵌入的网页”）。
```
```md
// 同一文件:709
每个新出现的值，都写明谁产生、谁使用、两端怎样校验、哪道检查守着（事故 I-73 的教训：一个值只在一端认）。
```
代码则新增：
```ts
// device-api-routes.ts:97-98
{ method: "GET", path: "data-export/archive", signed: true },
{ method: "GET", path: "files/content/{fileId}", signed: true },
```

**建议**：更新设计文档的接口表和第 17 节新值清单，至少列出 `exportId`、`fileId` 的产生/校验/使用、`DeviceDownload` 三个字段、响应头语义和对应测试；如方案已由 Andy 同意，也应留下对应的 ADR 或文档修改记录，而不是让代码和设计文档相反。

### 5. 低：作者说“别的主人的 404”只对导出包成立，文件下载在 owner/agent 不匹配时是 403，且没有路由级测试

**文件:行**：`apps/agent-service/src/production-data-export.ts:356-358`；`packages/platform-node/src/browser-thread-files.ts:149-157`；`packages/platform-node/src/http-gateway-server.ts:948-956`；`test/integration/device-download.test.ts:197-203`

**问题**：导出包包装函数在 owner 不匹配时返回 `undefined`，路由转成 404；但文件下载复用的 `BrowserThreadFiles.#scope` 在 owner 或 agent 不匹配时抛 `NOT_AUTHORITATIVE`，错误处理映射成 403。作者把两者都概括为“别的主人的 404”是不准确的。测试只在工厂函数层面构造了“别人的 owner”，没有走文件路由的跨 owner/agent 路径。

**证据（读代码证实）**：
```ts
// production-data-export.ts:356-358
if (input.authentication.ownerId !== options.ownerId) return undefined;
const view = options.jobs.view(input.exportId);
if (view.state !== "ready" || !view.built) return undefined;
```
```ts
// browser-thread-files.ts:153-155
const ownerId = authentication ? authentication.ownerId : this.#options.ownerId;
if (ownerId !== this.#options.ownerId || agentId !== this.#options.agentId)
  throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "File scope mismatch");
```
```ts
// http-gateway-server.ts:949-956
const statusCode =
  error.code === PORT_ERROR_CODES.NOT_AUTHORITATIVE
    ? 403
    ...
```

**建议**：如果要求“别的主人的文件也 404”，在文件下载端口把 scope 不匹配转换成 NOT_FOUND；否则修正作者说法并在测试说明里写清 403 的原因。补一条走真实 `readFile` 或 HTTP 路由的越权用例。

**侧重检查**

- **认证和授权**：读了 `device-api-routes.ts:574-578` 和 `paired-device-service.ts:330-427`。新路由确实沿用 `options.devices.authenticate`，覆盖签名、过期、nonce 重放、设备吊销、owner 停用、会话失效；没有发现绕过验签或撤销检查的路径。
- **输入和错误路径**：`exportId` 校验了“只能有一个 `exportId` 键、恰好一个值、符合 `DATA_EXPORT_ID_PATTERN`”，缺参、多参、重复、非法格式都走 400；文件路由拒绝任何非空查询串；文件 id 只用于数据库查询，不拼接文件系统路径，未发现路径穿越。发现的问题集中在文件 id 编码（意见 2）和跨 owner 状态码（意见 5）。
- **响应头和不可信输出**：`cache-control: no-store`、`attachment`、`no-referrer`、`nosniff` 都在；`content-disposition` 会过滤非可打印字符、引号和反斜杠，`filename*` 用 `encodeURIComponent`，未发现 CRLF 头注入。文件 mediaType 来自服务端分类器或受控的上传分类，不是直接回显任意请求头。
- **资源耗尽**：`sendDownload` 每次用 `Buffer.from(download.bytes)` 复制整份内容，文件下载还会整份解密；未看到本 PR 新增加的大小上限或并发限流。nonce 存储上限可能间接限制短期重放式刷取，但大文件并发下载的内存放大是否可被配对设备利用，我没有运行验证，标为推测/未核实。
- **规则、文档和代码一致**：发现设计文档明确禁止设备接口导出数据、且新值清单未更新（意见 4）。另外 `.agents/reviews/pr-537` 下的旧复核记录在本 PR 中被删除，我因记录路径受工具策略保护没有逐份核实，标为未核实。
- **测试**：新测试位于 `test/integration/device-download.test.ts`，`ci/policy.json` 的 integration include 是 `test/integration/**/*.test.ts`，所以会被收集。反向用例覆盖未签名、重放、未知/非法导出 id、缺参、多余参数、重复参数、吊销、无端口安装；按代码静态判断这些用例确实会触碰对应保护。未运行测试（本次工具限制不允许运行非 git 命令），且发现测试文件使用了非真实格式的文件 id，并有本 PR 自己引入的测试回退。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会。本 PR 的代码改动只在设备 HTTP 路由、`http-gateway-server` 端口接线、`production-data-export` 的导出包装和测试/文档；没有改系统提示、工具定义、历史消息、遮盖、压缩或任何模型请求组装代码。因此发给模型的内容仍然只在末尾追加，每轮变化的值没有进入开头。依据中的规则仍然成立（`prompt-prefix.md:27-28`、`:34-37`）。两个无关测试回退不改变生产提示，但会让测试失败。

2. **同一段文字会不会在不同请求里变成不同字节？** 不会因本改动发生。导出包在 `DataExportJobs` 构建后保存固定字节；文件内容每次从受保护的存储读取同一份字节；新响应头由文件名确定性生成，没有引入时间字段、随机字段或无序集合到模型输入。文档里没有新增模型侧序列化。

3. **有没有对应自动检查，反向用例真的会失败？** 有部分覆盖：`test/integration/device-download.test.ts` 已被 integration 项目收集，未签名、重放、非法/未知 id、缺参、多参、重复参数、吊销、未安装端口这些反向用例按代码静态判断会失败于当前保护逻辑。但检查不完整：没有用真实 `thread-artifact:<uuid>` 验证，也没有覆盖编码后的文件 id、过期导出、文件跨 owner 的路由行为；此外本 PR 删掉了 home-urgency 的 `binding` 期望和 SI-4 的时区修复，前者按代码推断会直接导致用例失败，后者会重新引入已知的零点 CI 抖动。未实际运行测试。

4. **每个新值的生产方和使用方两端都能接受吗？** `exportId` 两端一致：生产方 `DataExportJobs.start` 生成 `data-export:${randomBytes(16).toString("base64url")}`（`production-data-export.ts:231`），消费方使用同一个 `DATA_EXPORT_ID_PATTERN`（`contracts-v2.ts:1018`），格式匹配。`fileId` 不一致：生产方是 `thread-artifact:<uuid>`（`service-main.ts:290`、`production-thread-artifacts.ts:334`），消费方的路由白名单只接受未编码路径，标准客户端编码成 `%3A` 会被拒；测试又用了假的 `file-download-1`，没有暴露这一点。`DeviceDownload` 的 `bytes`、`mediaType`、`fileName` 在 `sendDownload` 中都有人消费，archive 的 mediaType 固定为 `application/zip`；文件 mediaType 来自服务端分类器。`exportArchive`/`readFile` 配置键只在生产组合和测试 harness 中接线，未安装时走 `rejectNotAllowed`，这一点两端一致。最后，作者“别的主人的文件 404”的说法与文件端口实际 403 不一致；设计文档和新值清单也未同步，属于两端校验/文档未对齐。
