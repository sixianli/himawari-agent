## 结论

第 3 轮增量（`455774e5..d5740176`）整体方向正确：把"同一请求重发"的判定从拼接字符串改成分别保存 `href/method/body`，并把"被拒绝的请求"也纳入缓存，确实能让重发字节与首次一致，并避免重复上报。未发现会导致敏感内容真实外发或破坏请求前缀的**已证实的**高危缺陷。下面按严重度列出发现，随后按"读代码证实 / 推测"区分，最后逐条回答必答问题。

---

## 发现（按严重度从高到低）

### 1. 低-中：缓存快路径绕过了 `hasBodyInRequest(input)` 这道检查
- 文件:行：`packages/application/src/services/model-egress.ts:194`（缓存命中分支）对比 `:237-239`（仅在 `#prepareFresh` 里检查）
- 问题：缓存比较只用 `href/method/body`，但"请求对象自带 body"是**只看 `input`** 才能发现的；命中缓存时直接返回/抛错，不再执行 `hasBodyInRequest(input)`。也就是说，第一次用「URL 字符串 + init.body」建立了缓存后，第二次传入「同 URL、同 method、同 init.body，但 input 是一个自带 body 的 Request/对象」时会绕过这道守卫。
- 证据（亲自读到）：
  - `model-egress.ts:194-200`
    ```ts
    if (
      last !== undefined &&
      typeof body === "string" &&
      last.href === href &&
      last.method === method &&
      last.body === body
    ) {
    ```
  - `model-egress.ts:237-239`
    ```ts
    const href = typeof input === "string" ? input : urlOf(input);
    if (href === undefined) refuse("request target is not a URL");
    if (hasBodyInRequest(input)) refuse("request object carries its own body");
    ```
  - `hasBodyInRequest` 只读 `input`：`model-egress.ts:339-343`。
- 建议：把 `href === undefined` 和 `hasBodyInRequest(input)` 两个判断移到 `#prepare` 的缓存分支**之前**（代价极小），或把它们纳入缓存命中条件；并加一条反向用例：先缓存成功，再用"同 URL/同 init.body 但自带 body 的 input"调用，必须被拒绝。
- 说明：按 Fetch 规范，`init.body` 会覆盖 `Request` 自带 body，所以**在当前调用方（Pi 传 URL 字符串 + init）下不可达**，也不构成已证实的外泄；这是"缓存快路径削弱了守卫"的防御性问题。

### 2. 低：拒绝缓存与作者说法不完全一致，且缺少针对拒绝分支的反向用例
- 文件:行：`packages/application/src/services/model-egress.ts:222-228`；测试 `packages/application/test/model-egress.unit.test.ts:583-608`
- 问题一（说法/代码）：作者说"上一次是被拒绝（ModelEgressRefusedError）的就再抛同一个错误"。实际只有 `href !== undefined && typeof body === "string"` 时的拒绝才会被记住；`request target is not a URL`（href 未定义）、`request has no readable body` / `request body is not text`（body 不是字符串）等拒绝不会被缓存，重发会重新检查并抛**新的**错误。这些路径本来也不上报，所以行为影响小，但说法应更精确。
- 问题二（测试）：新分支只有正向用例（拒绝→重发同一错误、只上报一次）；没有反向用例证明"拒绝之后发一个**不同**的 body 不会被旧的拒绝缓存误伤"。第 1 轮已有的 `REVERSE [RETRY-429] masks a different request...`（`model-egress.unit.test.ts:695-709`）只覆盖成功请求，不覆盖拒绝缓存。
- 证据（亲自读到）：
  ```ts
  if (
    error instanceof ModelEgressRefusedError &&
    href !== undefined &&
    typeof body === "string"
  )
    this.#lastRequest = { href, method, body, redacted: undefined, refusal: error };
  ```
  以及新测试断言 `expect(second).toBe(first); expect(reports).toHaveLength(1);`（`:604-607`）。
- 建议：补一条反向用例：先让 B1 被拒绝，再发合法 B2，必须真正调用 base 且不被旧拒绝影响；同时把说明改成"带 URL 和字符串请求体的拒绝才复用"。

### 3. 低：ADR 的测试清单没有同步本轮新增的用例
- 文件:行：`docs/adr/0245-retry-rate-limited-model-requests-at-the-request-layer.md:79`
- 问题：决定 6 已经写明"被拒绝的请求重发直接再抛同一个拒绝，不重复上报"，但后果里的测试清单仍只写"重发字节相同、只上报一次，及反向用例"，没有提到新增的拒绝重发单元用例和真实 Pi + 真实遮盖的 `[RETRY-429]` 端到端用例。文档与代码不完整一致（属说明文档滞后，不是行为错误）。
- 建议：把本轮新增的两条用例补进 ADR 的测试清单，并注明"拒绝重发只有正向用例，暂无反向用例"（若采纳发现 2 则一并更新）。

### 4. 低（隐患，非本轮缺陷）："一个交换只服务一次模型调用"只写在 ADR，代码没有注释或断言
- 文件:行：`packages/application/src/services/model-egress.ts:132-140`（只存一份 `#lastRequest`）；调用方 `packages/runtime-pi/src/pi-runtime-adapter.ts:1124`、`:1694-1710`
- 问题：如果将来有人在同一个 exchange 里交错发送 A→B→A，第三次 A 会走 `#prepareFresh`，而 `#known` 已被 B 扩大，可能把 A 中排在"点名消息"前的同一值也遮掉——正是本轮要修的字节变化问题。当前代码在每次 `admitPiStream` 都新建 exchange（`pi-runtime-adapter.ts:1124`），所以不可达；ADR 第 53 行也写了"以后要交错发多个不同请求，先改这里"。
- 建议：在该字段或 `#prepare` 上留一句注释指向 ADR 0245 决定 6；若担心误用，可把缓存改成按 body 的 `Map`（同一 exchange 内 A→B→A 也能复用 A 第一次的遮盖），但会增加内存上限，需要和"只记上一次"的决定一起权衡。

---

## 读代码证实的 / 推测的

**读代码证实：**
- `#prepareFresh` 的检查（href、`hasBodyInRequest`、body 类型、路径、JSON、遮盖、上报）代码未变，只是改名；缓存命中分支在其之前返回/抛错（`model-egress.ts:185-231` vs `:233-318`）。
- 成功请求会记录 `redacted`，拒绝会记录 `refusal`；两者都以 `href/method/body` 相等为前提（`model-egress.ts:208-230`）。
- 新单元测试确实会在第 2 轮代码上失败：第 2 轮拒绝时未记录 `#lastRequest`（`git show 455774e5:...` 的 `#prepareFresh` 在 `refuse(...)` 前没有写入），所以会二次上报、抛新错误。
- 新兼容测试在"第 1 轮之前"的代码上会失败：那时 `#prepareFresh` 每次重发都重新遮盖，`#known` 会把第一条消息里的 `hunter22abc` 也遮掉，`bodies[2] !== bodies[1]`（且更早的版本根本没有重试，bodies 数量也不对）。
- 每次模型调用新建 exchange：`pi-runtime-adapter.ts:1124`；压缩摘要也走同一条 per-call 路径（`:1694-1710`）；后台 transport 也是 per-call（`pi-model-transport.ts:312`）。
- `maxRetries = 2`、`maxRetryDelayMs = 10_000`，与 ADR 一致（`pi-runtime-adapter.ts:443-444`、`:1171-1172`）。
- 网关观察器在非 ok 且可重试时把 `sent` 复位、在连接错误时重抛原错误（`gateway-observation.ts:155-176`），与 ADR 决定 3 一致。

**推测 / 未核实：**
- 无法运行测试（本环境不允许），所以"测试全部通过""改动前失败"都是按代码逻辑推断，未实际执行。
- 没有 `node_modules`，看不到 `pi-ai` 的 `provider-retry.js`，因此"拒绝被当作连接错误、共 3 次调用、白等约 1.3 秒"只与代码中"聊天路径不特判 `ModelEgressRefusedError`、`maxRetries: 2`"相符，具体耗时与重试分类未核实。
- 发现 1 的"Request 自带 body 会被未检查地发出"只在非标准 fetch 实现下才可能；按 WHATWG 规范 `init.body` 优先，当前不可造成外泄——属推测性风险。

---

## 侧重检查（错误路径、不可信输入、安全、资源、不可撤销操作、文档一致性）

- **错误路径**：非 `ModelEgressRefusedError` 的异常不入缓存，重发会重新执行完整检查（`model-egress.ts:222-229`）；缓存拒绝不会再次触发 `#report`；重试次数由 Pi 的 `maxRetries: 2` 限制，不会无限重试。未发现新的死循环或错误吞噬。
- **不合规/不可信输入**：`#prepareFresh` 原有的 href/body 类型/JSON/路径检查保留；缓存命中时这些检查被跳过，但相等性保证它们此前已通过——唯一不保证的是 `hasBodyInRequest(input)`（发现 1）。非字符串 body、无 body 的 POST 不会被缓存。
- **安全**：缓存只在同一 exchange 内复用，且复用的一定是"首次已经过遮盖/拒绝"的结果；拒绝错误信息不含敏感值（`ModelEgressRefusedError` 只带 `reason`，`model-egress.ts:21-29`）。未发现本轮新增的敏感内容留存（原先的 `key = href+\0+body` 同样保存了原文，本轮改为引用反而少一次拼接复制）。
- **资源耗尽**：每个 exchange 最多保留一份 `body` + 一份 `redacted`；重试上限 2；无无界增长。
- **不可撤销操作**：本轮未改请求发送次数上限；连接错误重发可能导致服务方重复生成，这是 ADR 0245 后果里已接受的既有权衡（`docs/adr/0245...md:76`），不是本轮引入。
- **规则/文档一致性**：ADR 决定 6 与 `model-egress.ts` 的实现（含 method 大写归一）一致；`prompt-prefix.md` 第 5、11 条与"同一次请求内按 `#known` 向后遮、重发复用首次结果"一致；唯一滞后是 ADR 第 79 行的测试清单（发现 3）。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本层只做请求体遮盖，不组装/重排系统提示、工具定义或历史；本轮改动只是"同一请求重发时复用首次遮盖后的 body"，反而消除了重发字节漂移这一隐患。发给模型的内容仍然只在末尾追加（本轮未触及追加逻辑）；每轮会变的值仍不在本层新增。依据：`model-egress.ts:185-318` 只变换 body；新兼容测试断言 `server.bodies[2] === server.bodies[1]`（`prompt-prefix.compat.test.ts:1234`）。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   本轮不会引入新的字节不确定性；相反它修复了"同一 exchange 内重试时 `#known` 累积导致前面消息被重新遮盖"的确定性破坏。残留的确定性前提是"一个 exchange 只服务一次模型调用"：若违反该约定（A→B→A），第三次 A 会带着 B 学到的 `#known` 重新遮盖，可能改变字节（发现 4）。没有引入时间字段或无序集合。依据：`#known` 在 `Exchange` 上累积（`model-egress.ts:130`），缓存只保留上一份（`:132-140`）。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有：新增单元用例覆盖"拒绝后重发同一错误、只上报一次"（`model-egress.unit.test.ts:583-608`），新增真实 Pi + 真实遮盖的 compat 用例覆盖"重发字节相同"（`prompt-prefix.compat.test.ts:1224-1237`）；第 1 轮还有"不同 body 各自遮盖"的反向用例（`:695-709`）。按代码推断：新单元用例会在第 2 轮代码上失败，新 compat 用例会在第 1 轮之前失败（未实际运行）。缺一条：针对本轮新加的**拒绝缓存**的反向用例（拒绝后发不同 body 不得被旧拒绝误伤，见发现 2）。

4. **改动产生/修改的每个值，使用它的一端都能接受吗？**
   本轮产生/修改的值都是内部值：`#lastRequest` 的 `href/method/body/redacted/refusal`（产生和使用都在 `model-egress.ts` 内，已逐个核对，无外部契约校验）；测试里的 `retryAfter: "0"/"120"`（作为 HTTP 头写入，字符串合法）和 `runTurns(turns: readonly Turn[])` 参数（类型 `Turn` 见 `prompt-prefix.compat.test.ts:121-126`，字面量 `{prompt}` 可接受）。没有新增标识、配置键、清单项或序列化格式，因此不存在 I-73 式"清单 id 过不了后端校验"的跨端不一致。唯一不一致是文档侧的 ADR 测试清单未更新（发现 3）。
