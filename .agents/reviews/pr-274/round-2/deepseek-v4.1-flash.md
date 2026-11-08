## 读代码证实的问题

### 1. 中高｜`packages/sensitive-capture/src/machine-secrets.ts:111-114`｜结尾私钥残块在「END 前最后一行超长」时完全不遮（相对 0fc16edd 是回归）

问题：`maskKeyTails` 把窗口起点前移到「下一行行首」。当 `-----END ... PRIVATE KEY-----` 前面最后一行 base64 超过 `KEY_TAIL_WINDOW`（19200 字符）时，`nextLineStart()` 返回的恰好是 `marker.index`，切片为空，`KEY_TAIL` 直接不匹配，整段正文和 END 行原样放行。

证据（本人读到）：
```ts
// machine-secrets.ts:98-103
const candidates = [input.indexOf("\n", from), input.indexOf("\\n", from)]
  .filter((index) => index !== -1 && index < limit)
  .map((index) => index + (input[index] === "\n" ? 1 : 2));
return candidates.length === 0 ? limit : Math.min(...candidates);
// machine-secrets.ts:111-114
const earliest = Math.max(cursor, marker.index - KEY_TAIL_WINDOW);
const from = earliest === cursor ? earliest : nextLineStart(input, earliest, marker.index);
const tail = KEY_TAIL.exec(input.slice(from, marker.index));
if (tail === null) continue;
```
复现（20000 > 19200，`earliest` 落在正文行内，后面的唯一换行就在 END 前）：
```ts
redactPrivateKeyFragments("A".repeat(20000) + "\n-----END RSA PRIVATE KEY-----")
// 现状：原样返回；0fc16edd 的旧无窗口尾规则会遮
```
这不是「少遮 120 行」的性能取舍，而是整段不遮；同一路径还会让 `pi-output-export.ts` 的合法 UTF-8 文本直接导出（见第 4 条）。

建议：窗口起点改为「回退到 `earliest` 之前最近的行首」（`lastIndexOf("\n"/"\\n")`），或在 `nextLineStart(...) === marker.index` 时回退到上一行行首/`earliest`，并接受单行可能超过窗口。补一条反向用例：单行 20KB 正文 + END 必须被遮。另注意 `{1,120}` 的 120 行上限意味着超长私钥仍只遮最后 120 行，至少要在测试里明确这是有意的取舍。

### 2. 中｜`packages/application/src/services/model-egress.ts:409-410,419`｜`BASE64_DATA_URL` 并不只放行「真正的 base64 数据网址」，仍可夹带明文秘密

问题：正则只检查字母表和形状，不校验 payload 是否真的是规范 base64（允许 `=` 出现在任意位置、允许空 payload），所以「假 data 头 + 明文秘密」会被整段跳过。最直接的例子是 AWS 密钥：
```
data:image/png;base64,AKIA[拆开]ABCDEFGHIJKLMNOP
```
payload 全在 `[A-Za-z0-9+/=]` 内，匹配后 `return value`，而其中的 `AKIA...` 是 `aws-access-key` 规则本来能识别的。同理 `data:text/plain;base64,password=...` 只要值不含 `-`/`.` 等字符也会被跳过。

证据：
```ts
// model-egress.ts:409-410
const BASE64_DATA_URL =
  /^data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64,[A-Za-z0-9+/=\r\n]*$/u;
// model-egress.ts:418-419
if (typeof value === "string") {
  if (BASE64_DATA_URL.test(value)) return value;
```
作者说「只跳过真正的 base64 数据网址」与代码不符。这不是本轮新引入的绕过（旧代码 `startsWith("data:")` 也会放过），但这次所谓收窄没有解决它。

建议：命中 data URL 形状后仍先跑一次 `scanMachineSecrets`/`redactForEgress`（明文 `AKIA...`、`password=...` 会被规则抓到）；或校验 payload 能规范解码再编码（长度、padding 位置、`Buffer.from(payload).toString("base64")` 一致）。至少补一条「假 data 头 + AWS key 必须被遮」的用例。顺带：`;BASE64` 大小写、带引号/百分号编码的参数目前不匹配，会走遮值路径，建议明确取舍。

### 3. 低｜测试与文档

- `packages/sensitive-capture/test/private-key-fragments.unit.test.ts:61-72`「stays fast」只断言 `performance.now()` < 2000ms，不断言任何内容被遮；因此上面第 1 条的「完全不遮」可以全绿地跑过，而且 2 秒墙钟断言在慢 CI 上本身易抖。建议把「单行长正文 + END 必须遮」和「内容断言」加进去，时间断言只作为辅助或放宽。
- `packages/runtime-pi/test/model-output-budget.unit.test.ts:39-45` 只测 `tool: "bash"`（tail 方向），没有非 bash（head 方向）的回归用例，见下方推测条目。
- 文档仍写旧行为：`docs/execution/specs/2026-09-07-srt-unified-execution-design.md:417`、`docs/adr/0054-readonly-tools-in-host-and-reused-task-sandbox.md:137`、`docs/architecture-v0.1.md:82` 说工具输出遇到私钥片段「按原样失败/不交正文」，而 `pi-output-export.ts` 已改成遮后导出。作者说文档在第 5 个 PR 改，属于已知延期，不算本轮代码错，但在文档更新前不能当作已验证一致。

## 推测（未能读到上游库源码）

### 4. 中（条件成立时）｜`packages/runtime-pi/src/model-output-budget.ts:61-63,69-71`｜`lastLinePartial` 没限定 tail，可能删掉 head 截断结果的**开头**

问题：非 bash 工具走 `truncateHead`，bash 才走 `truncateTail`；但剥离逻辑只看 `result.lastLinePartial`，没看 `tail`。如果上游 `truncateHead` 在「最后保留行被从字节中间截断」时也把 `lastLinePartial` 置真（字段名本身更像这个含义），那么 `read`/`grep` 等 head 结果会被 `CUT_TOKEN_START` 从**开头**删掉一串正常文字（例如文件首行开头的 `const`、`hello`），而截断其实发生在末尾。

证据：
```ts
// model-output-budget.ts:61-63
const result = tail
  ? truncateTail(texts[position] as string, { maxBytes: budget })
  : truncateHead(texts[position] as string, { maxBytes: budget });
// model-output-budget.ts:69-71
const kept = result.lastLinePartial
  ? result.content.replace(CUT_TOKEN_START, "")
  : result.content;
```
未核实点：`@earendil-works/pi-coding-agent@0.84.2` 的 `truncateHead` 是否也置 `lastLinePartial`；仓库里没有该包源码，无法确认。新增测试只覆盖 `bash`，所以即使 head 方向被破坏也没有红用例。

建议：无条件改成 `tail && result.lastLinePartial`（tail 方向的剥离才是本轮要修的），并补一条 `tool: "read"` 的长单行用例，断言开头正文不被删。另外即使是 tail，按空格边界截断时「开头一串 token 字符」可能是一个完整单词，直接删掉也会丢内容；更稳的是只在切点确实落在类密钥串中间时剥（例如前缀像 `sk-`/`ghp_`/`AKIA`/`eyJ`），或对尾部片段再跑一次遮值。

## 侧重检查（错误路径 / 不可信输入 / 安全 / 资源 / 文档）

- 错误路径与不可信输入：检查了 END 前超长单行、只有短正文行的尾片段、escaped `\n`/`\r\n`、JSON 引号包裹、grep/diff 前缀、NUL/非法 UTF-8、超长文件名/链接（后两者本轮未改）。结论：超长单行尾片段会漏遮（第 1 条）；短尾行（无 16+ 正文行）仍不遮，但与旧行为一致。
- 安全：检查了出口自检。`assertMachineSecretFree` 只调 `scanMachineSecrets`，不含 BEGIN/END 边界判断（`machine-secrets.ts:155-158`），所以第 1 条漏遮后出口自检也不会兜住；`pi-output-export` 合法 UTF-8 分支也不再走 `containsToolOutputSecret` 兜底。假 data URL 的明文秘密会整段跳过（第 2 条）。
- 资源耗尽：`KEY_HEAD` 已由 `{0,120}` 限行，`redactPrivateKeyFragments` 无标记时直接返回；`KEY_TAIL` 每次最多看 19200 字符，但多个 END 标记时每个都要扫一遍窗口，输入上限（工具结果/导出预算）约束下未发现明显放大器。新增性能测试是墙钟断言，不能证明复杂度。
- 不可撤销操作：本轮 4 个源文件只做文本遮值/截断/导出，没有删除、覆盖、外发新出口；导出仍只读私有目录文件。
- 规则/文档一致性：`.claude/rules/prompt-prefix.md` 第 5、8、11 条与本轮的关系见下；`docs/...` 的旧「整段拒绝」描述尚未更新（作者声明 PR5 处理）。

## 必答问题

1. **会不会改变模型已见过的请求开头？**
   - 不会引入「每轮变化的值」，也没有改写入顺序；新工具结果（`model-output-budget`、`pi-output-export`）都是追加在末尾的新内容。
   - 但出口遮盖算法本身变了：对于已有对话，历史里若含有「旧代码会跳过、新代码现在要遮」的字符串（非 base64 的 `data:` 开头文本、短/同行/转义换行的私钥残块），下一次请求会在最早那条受影响的历史消息处改变字节，造成一次性前缀失效；这不是每轮变化，但确实动了已发内容，按规则第 8 条需要确认是否已有方案/批准。
   - 具体到本轮：`BASE64_DATA_URL` 收窄会让「`data:` 但不是合法 data URL」的历史串首次被遮；`machine-secrets` 改动会让部分历史私钥残块遮法变化（第 1 条还会让一部分从「遮」变成「不遮」）。

2. **同一段文字会不会在不同请求里变成不同字节？**
   - 本次新增的 `BASE64_DATA_URL`、`KEY_HEAD`/`KEY_TAIL`、`CUT_TOKEN_START`、`redacted`/digest 都是纯函数，没有时间、随机、集合遍历顺序依赖；同一请求前提下同一段文字遮出的字节相同。
   - 唯一既有的上下文依赖是 `Exchange.#known`（同一请求里前面消息点名的密码/验证码会影响后面消息的遮法），本轮没有扩大。密钥轮换会改变 tag 字节，也是既有已记录的行为。

3. **有没有自动检查，反向用例真的会失败吗？**
   - `model-egress.unit.test.ts:129`：正向（真 data URL 保留）+ 反向（`data: token sk-...`、`data:text/plain,password=...` 被遮）。旧代码 `startsWith("data:")` 会让 `a`×24 出现在原始请求里，反向用例会红，成立；但没覆盖「假 data 头 + 明文 AWS key」。
   - `private-key-fragments.unit.test.ts:52-59`：短正文、同行、escaped CRLF，旧代码都会漏，反向成立。`61-72` 只测耗时，不测遮没遮，无法发现第 1 条；也没有「单行超窗口」用例。
   - `pi-output-export` 测试：NUL 合法 UTF-8 现在期望 `\u0000[密钥]`，旧代码会抛 `PI_OUTPUT_FILE_REJECTED`，反向成立；非法 UTF-8 仍期望拒绝，正向也保留了。
   - `model-output-budget.unit.test.ts:39-45`：只覆盖 tail；没有 head 方向的失败用例，无法验证推测第 4 条。
   - `scripts/check-egress-redaction.mjs` 的登记数仍匹配：`pi-output-export.ts` 仍是 `containsToolOutputSecret: 1`，没有触发登记校验。

4. **改动产生/修改的每个值，两端都能接受吗？**
   - `BASE64_DATA_URL`：只在 `maskTree` 内消费，不跨边界，下游只收到「跳过/不跳过」后的字符串，无 schema 问题。
   - `redacted: true` 与遮后 `data/byteLength/digest`：由 `exportedOutput` 产生，`pi-host-publication.ts:123` 嵌入 `fullOutput`；`pi-runtime-adapter.ts:357-367` 和 `production-sandbox-tool-result.ts:97-104` 只校验 `schemaVersion/tool/content/isError/source` 等字段，不拒绝额外键；`production-foreground-result` 测试也按遮后字节核对 digest，两端一致。
   - `outcome: "withheld"`：`SENSITIVE_INTERCEPTION_OUTCOMES` 已包含 `withheld`（`ports/sensitive-interceptions.ts:35`），记录器用 `sighting.outcome ?? "masked"` 接收，类型和存储都接受。
   - `REDACTED` 标记：`redaction.ts:297-304` 按标记前后差值计数并替换成 `[密钥]`，计数逻辑对新 `maskKeyTails` 的单个 REDACTED 仍成立。
   - `CUT_TOKEN_START` 修改后的 `content`：下游只按字节上限和 `details.truncation` 使用，`truncationMetadata` 删除 `content`，没有长度一致性校验；但如第 4 条所述，方向没限定可能让 head 结果内容被误删。
