未发现会改变生产行为或模型请求的中高严重度问题。以下两条为低严重度的可改进项，均针对测试本身。

### 1. 低 — SI-4 的时区仍由运行时刻动态决定，建议固定时钟或固定时区
文件：`test/integration/sensitive-interceptions-browser.test.ts:126-129`、`test/e2e/fixtures/control-center-browser-server.mjs:445`

问题：`middayTimezone()` 每次按当前 UTC 小时选一个 `Etc/GMT±N`，虽然能把本地时间固定到 12 点、避开零点窗口，但测试实际使用的时区随运行时刻变化，不是固定的 IANA 用户时区；假数据本身仍用 `Date.now()` 生成。这个做法能稳定通过，但可读性和可复现性不如“固定时区 + 固定 now”，也不便于以后排查日期分组问题。

证据（读代码证实）：
```ts
// sensitive-interceptions-browser.test.ts:126-129
function middayTimezone() {
  const offset = 12 - new Date().getUTCHours();
  return offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
}
```
```js
// control-center-browser-server.mjs:445
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
```
组件确实按浏览器本地日期分组：
```tsx
// sensitive-interceptions.tsx:83-91
const now = new Date();
const today = localDay(now.toISOString());
const yesterday = localDay(new Date(now.getTime() - 86_400_000).toISOString());
...
const day = localDay(item.firstSeenAt);
```
建议：更彻底的做法是给夹具传入固定的 `now`（或让 `sensitiveReset` 接受基准时间），再配合固定时区（例如 `Asia/Tokyo` 或 `UTC`），这样日期分组完全确定，也不需要在测试里反向计算 POSIX `Etc/GMT` 符号。当前实现可以保留，但建议至少加一句说明为什么用 `Etc/GMT` 的反号。

推测/未核实：没有实际运行 Playwright，无法验证 Chromium/ICU 在当前 CI 镜像里一定接受 `Etc/GMT-12` 这类名称；从 IANA 列表和 `@playwright/test@1.62.1` 的 `timezoneId` 支持看应当可用。

### 2. 低 — binding 断言只校验前缀，建议复用 device-home 的完整格式
文件：`test/integration/home-urgency.test.ts:827`、`:836`、`:957`

问题：`expect.stringMatching(/^b1\./)` 只要求以 `b1.` 开头，像 `b1.not-a-binding` 这种明显非法的值也会通过。虽然实际解析由 `home-feed.test.ts` 覆盖，这里不影响正确性，但同一仓库已有更严格的格式断言，复用它成本很低。

证据（读代码证实）：
```ts
// home-urgency.test.ts:827
binding: expect.stringMatching(/^b1\./),
```
```ts
// device-home.test.ts:200
expect(entry.binding).toMatch(/^b1\.[A-Za-z0-9_-]+$/u);
```
建议：三处都改成 `/^b1\.[A-Za-z0-9_-]+$/u`，与 `device-home.test.ts:200` 保持一致。作者“解析由 home-feed 用例覆盖”的说法是成立的，见 `test/integration/home-feed.test.ts:848-936` 对成功解析、`binding_stale`、`binding_invalid`、`action_not_offered`、`item_gone` 的覆盖。

**侧重检查**

- 错误路径：`decodeHomeBinding` 对超长、无 `b1.` 前缀、非数组、非对象 payload、不认识的命令类型都返回 `null`（`apps/agent-service/src/production-home-binding.ts:32-46`）；`resolveAction` 对无效、过期、动作未提供、条目消失分别返回 `binding_invalid`、`binding_stale`、`action_not_offered`、`item_gone`（`production-home.ts:848-855`），`home-feed.test.ts:906-936` 有对应反向用例。
- 不合规范或不可信输入：`middayTimezone()` 的返回范围是 `Etc/GMT` 与 `Etc/GMT-1..-12`、`Etc/GMT+1..+11`，由 `getUTCHours()` 的 0–23 整数算出，没有越界值；binding 由服务端编码，不来自外部输入。
- 安全：改动只在测试文件内，没有新增日志、密钥或外部输入处理。
- 资源耗尽：只给一个页面增加了 `timezoneId`，没有新增循环、并发页面或大量数据。
- 不可撤销操作：正向 SI-4 用例不执行清除；清除用例仍是先确认再发送，未被本次改动放松。
- 规则/文档一致性：`prompt-prefix.md` 只约束发给模型的内容；本次 diff 没有生产代码、提示词、工具定义、历史或遮盖逻辑变化，因此不触碰该规则。CI 文档明确禁止用重试隐藏不稳定测试（`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:147`），本改动是消除不确定性而不是加重试，方向一致。

**必答问题**

1. **不会改变模型已经见过的请求开头。** 本次 diff 只有两个测试文件，没有改系统提示、工具定义、历史消息、出口遮盖或请求组装代码。`home-urgency.test.ts` 仍使用固定的 `NOW` 构造数据和 mock 模型调用，新增的只是读取结果后的断言；SI-4 是浏览器验收，不发模型请求。因此发给模型的内容仍然只在末尾追加，每轮变化的值位置没有变化。

2. **不会让模型请求里的同一段文字变成不同字节。** binding 由 `encodeHomeBinding` 按固定规则生成：`b1.` + `base64url(JSON.stringify([type, payload]))`（`production-home-binding.ts:27-29`），且不进入模型请求。新增的 `middayTimezone()` 只影响浏览器页面渲染，不是模型请求内容；夹具时间用 `Date.now()` 是本次 diff 之前就存在的。
   说明：如果超出模型请求范围，页面上的日期标题本来就会随运行时间变化，这是测试夹具和浏览器本地日期显示的正常行为，不是序列化不确定性问题。

3. **binding 有自动检查，反向用例有效；SI-4 这次没有新增反向用例。**
   - 新增的三处 `toEqual` 会在 `binding` 缺失、为 `null` 或不是 `b1.` 开头时失败。解析本身由 `home-feed.test.ts` 覆盖，其中 `binding_invalid`、`binding_stale` 等反向用例会真正失败。
   - SI-4 的改动是让原有正向用例稳定通过，没有为 `middayTimezone` 增加单元测试；而且该 helper 让本地日期与 UTC 日期相同，所以即使页面错误地改回按 UTC 分组，“今天”断言也未必能发现。原测试本来也没有覆盖“昨天”或本地/UTC 差异，属于既有覆盖缺口，不是本次改动放松。
   - 未核实：没有运行测试，无法确认两条用例在当前 CI 镜像上的实际执行结果。

4. **两端校验都能接受。**
   - `binding`：产生处 `production-home-binding.ts:27-29`，前缀 `b1.`，上限 `HOME_BINDING_MAXIMUM`；契约 `contracts-v2.ts:937` 接受 `nullable(boundedString(2048))`；使用处 `production-home.ts:848-855` 校验前缀、长度、命令类型，并与当前条目的 binding 做严格相等比较。新增测试的字符串匹配与这些规则兼容。
   - `timezoneId`：产生处 `middayTimezone()`，使用处只有 `browser.newPage`（`sensitive-interceptions-browser.test.ts:164-168`），没有其他消费方；值域是有效 IANA `Etc/GMT` 名称。运行时的 Chromium/Playwright 接受情况未核实。
   - `reviewLabel`、`ownerPresence` 等既有字段未改动，diff 中只是补充 binding，没有新增其他标识或序列化格式。
