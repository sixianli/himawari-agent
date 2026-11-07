# PR #274 完整复核（对比 7281d94..316eaf2）

## 一、读代码证实的发现（按严重度）

### 1. 中度 — `packages/application/src/services/model-egress.ts:410-420`

**问题**：新增的“只跳过真正的 base64 数据网址”会在数据网址里撞上巧合的密钥形状时，把整段 URL 按普通文字遮盖，从而破坏 base64。

**证据**：
```ts
const BASE64_DATA_URL =
  /^data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64,[A-Za-z0-9+/\r\n]*={0,2}$/u;
...
if (BASE64_DATA_URL.test(value) && scanMachineSecrets(value).length === 0) return value;
```
`scanMachineSecrets` 扫的是 **base64 编码后的文本**，不是解码后的内容。base64 字母表里没有 `-`，所以 `sk-`、`BEGIN`、`Bearer `、JWT 的点号都撞不上；唯一容易撞的是 `AKIA/ASIA[A-Z0-9]{16}`。测试自己就把 `data:image/png;base64,${AWS_LIKE}` 断言成要被遮（`packages/application/test/model-egress.unit.test.ts:132-146`）。一旦撞上，`text()` 会把 base64 中的一段换成 `[密钥]`，整个 data URL 变成非法 base64。

补充：真正的 `image_url` 块在 `maskTree` 里被 `OPAQUE_TYPES` 提前跳过（`model-egress.ts:426`），所以附件图片不受影响；受影响的是作为**普通字符串**出现的 data URL（用户文字、工具结果、网页正文里嵌的 data URL）。

**建议**：真 base64 数据网址应保持原样，或按 `text/*` 解码→遮盖→重编码；若确实识别到明文密钥，宁可整块丢弃也不要改坏 base64。至少加一条“含 `AKIA...` 的真数据网址仍可被 base64 解码”的反向用例。

---

### 2. 中度 — `packages/sensitive-capture/src/machine-secrets.ts:79,89-92`

**问题**：`KEY_HEAD` 会把“BEGIN 标记后跟任意一个字母数字”都当成残缺私钥正文，误遮普通文字。

**证据**：
```ts
const KEY_LINE_PREFIX = String.raw`(?:[^\s:\\"]*?[:-]\d+[:-])?[ \t+-]*\d*[ \t:]*`;
...
const KEY_HEAD = new RegExp(
  `-----BEGIN ${KEY_KIND}(?:[ \t]*${KEY_LINE_BREAK}${KEY_LINE_PREFIX}|[ \t]*)${KEY_TEXT}+(?:${KEY_LINE_BREAK}${KEY_SHORT_LINE}){0,${KEY_LINES}}`,
  "g",
);
```
标记后是 `[ \t]*` 再 `[A-Za-z0-9+/=]+`，于是 `-----BEGIN PRIVATE KEY----- is used ...` 会遮成 `[MACHINE_SECRET_REDACTED] used ...`；代码/文档里引用标记后紧跟英文单词也会被吞掉第一个词。因为该规则对所有出口文字（含历史工具结果、工具参数）生效，这既改写正常内容，也会让已发历史出现一次字节变化。现有反例只覆盖了标记后是引号的情况（`grep ... '-----BEGIN PRIVATE KEY-----' .`），没覆盖标记后接单词。

**建议**：同行的短正文至少要求长度阈值（例如 ≥16 个 base64 字符）或要求换行后再进入正文；并加“标记后接普通英文/中文不被遮”的反例。

---

### 3. 中度 — `packages/platform-node/src/files/pi-output-export.ts:47-50`（与 `model-egress.ts:419-421` 配合）

**问题**：完整输出先遮文字再 base64，但 base64 字符串本身仍会被出口遮盖当普通文字扫描。撞上 `AKIA/ASIA` 形状时，出口会把 base64 改掉，导致新加的 `digest`/`byteLength` 与实际发出去的 base64 不一致。

**证据**：
```ts
const masked = redactForEgress(text).text;
return masked === text
  ? exportedOutput(bytes, false)
  : exportedOutput(Buffer.from(masked), true);
...
byteLength: bytes.length,
digest: createHash("sha256").update(bytes).digest("hex"),
```
`exportedOutput` 的摘要/长度是按“出口遮盖之前”的字节算的；`maskTree` 随后还会对 `fullOutput.data` 这个字符串跑一遍 `redactForEgress`，而 `data` 不在 `SKIPPED_KEYS` 里。base64 里的偶然 `AKIA...` 会被二次替换，摘要就不再对应当前内容。

**建议**：base64 字段应被特别标记为不可再遮盖（例如在 `SKIPPED_KEYS` 中按字段名跳过，或改成结构化 `{encoding,data}` 让出口识别），并加一条“base64 解码后内容与 digest 一致”的测试。

---

### 4. 低度 — `packages/platform-node/src/files/pi-host-publication.ts:47,122-137`

**问题**：非法 UTF-8 且含密钥时，完整输出被丢掉，但提示写的是“完整输出超过上限，未保留”，原因被说错。

**证据**：
```ts
const FULL_OUTPUT_DROPPED = "完整输出超过上限，未保留";
...
} catch (error) {
  if (error instanceof Error && error.message === "PI_OUTPUT_FILE_REJECTED") exported = null;
  else throw error;
}
```
`pi-output-export.ts:42-45` 在非法 UTF-8 且 `containsToolOutputSecret` 为真时正好抛 `PI_OUTPUT_FILE_REJECTED`。旧代码在这种情况会走 `withhold()` 给出“疑似密钥”的提示，现在统一落成“超过上限”。

**建议**：给“因密钥丢弃完整输出”单独一个错误码/说明，或在调用方区分原因。

---

### 5. 低度 — 文档与代码不一致（作者已声明后续 PR 处理）

**证据**：
- `docs/architecture-v0.1.md:82`：“输出含机器秘密……只交出说明和真实退出码，不交正文”。
- `docs/execution/specs/2026-09-07-srt-unified-execution-design.md:431`：“正文检查机器秘密……”。
- `packages/sensitive-capture/README.md:11` 仍未列出新的 `redactPrivateKeyFragments`。

**说明**：作者说“错误码和文档在后面的 PR 里改”，所以这是已知延期，不是本轮阻塞项；但本轮合入后这些文档已经是错的，建议至少在本 PR 加一句“行为已改为出口遮盖”的指引。

---

## 二、推测 / 需运行验证的发现

### 6. 中度（推测）— `packages/runtime-pi/src/model-output-budget.ts:69-72`

**问题**：`lastLinePartial` 分支没有限定只在 tail 方向生效。

**证据**：
```ts
const tail = TAIL_DIRECTIONS.has(...);          // 只有 bash 走 truncateTail
const result = tail ? truncateTail(...) : truncateHead(...);
const kept = result.lastLinePartial
  ? result.content.replace(CUT_TOKEN_START, "")
  : result.content;
```
如果 Pi 的 `truncateHead` 也会置 `lastLinePartial`（字段名是通用的截断结果字段），read/grep/ls/find 的结果会在**开头**被去掉一串正常字符——而 head 截断的缺口在末尾，根本不需要去掉开头。现有测试只用了 `envelope(line, "bash")`。我没有在仓库里找到 `@earendil-works/pi-coding-agent` 的源码，无法直接确认它是否会置该标志，因此标为推测。

**建议**：改成 `tail && result.lastLinePartial`，并补一个非 bash、单行超限的 head 截断用例。

### 7. 中度（推测）— `packages/sensitive-capture/src/machine-secrets.ts:89-96`

**问题**：残块遮盖有 120 行上限，超过部分不遮；格式只覆盖 RSA/EC/OPENSSH。

**证据**：`KEY_HEAD` 的 `{0,${KEY_LINES}}`、`KEY_TAIL` 的 `{1,${KEY_LINES}}`；`KEY_KIND` 只允许 `RSA |EC |OPENSSH `。因此：
- 超过 120 行的残缺私钥，窗口外的正文保持原样；
- `-----BEGIN ENCRYPTED PRIVATE KEY-----`、`DSA PRIVATE KEY` 完全不在覆盖范围；
- 传统加密 PEM 开头是 `Proc-Type: 4,ENCRYPTED`，`KEY_HEAD` 会在 `Proc` 处停下，后面的 base64 不再遮。

完整块仍由 `private-key-block` 覆盖，所以只影响“残缺块”。实际 RSA/EC 密钥一般远小于 120 行，风险有限。建议确认是否要把 `ENCRYPTED`/DSA 与 `Proc-Type` 头纳入，并加 >120 行的用例。

### 8. 低度（推测）— `packages/sensitive-capture/src/machine-secrets.ts:86-116`

**问题**：大量标记时的最坏耗时未覆盖。现有性能用例是“很多 END 紧挨着”和“一条超长行”，没有覆盖“每次间隔约 19KB 的 END + 120 行类密钥行”，也没有覆盖“很多 BEGIN 但无 END”（`PRIVATE_KEY_BLOCK` 的 `[\s\S]*?` 会从头扫到尾，呈平方级，虽然这是既有行为）。建议补这两个形态的性能用例，或对总扫描量设上限。

### 9. 低度（推测）— `packages/runtime-pi/src/model-output-budget.ts:31`

**问题**：`CUT_TOKEN_START = /^[A-Za-z0-9._~+/=-]+/u` 只匹配行首无空白。若截断点落在缩进行或 `grep`/diff 前缀（如 ` 3 MIIE...`）之后，前导空格会让它完全不生效，残缺密钥后缀仍会留下。建议允许前导空白/前缀，或改成“去掉第一行中第一个空白前的类密钥段”。

---

## 三、侧重检查（错误路径 / 不可信输入 / 安全 / 资源 / 不可逆操作 / 文档一致性）

- **所有送模型出口**：`ModelEgress.wrapFetch` 只在 `pi-runtime-adapter.ts:999-1006`、`pi-model-transport.ts:313-314`、`memory-engine/src/embedding.ts:193-195` 三处接入；`#redactorFor` 对非 `/chat/completions`、`/responses`、`/messages`、`/embeddings` 的路径直接 `refuse`，不会裸发。未发现绕开出口的模型调用。
- **`data:`/文件块**：`file`/`input_file`/`document` 在源码中没有生成点（grep 确认）；`image` 块由 `pi-runtime-adapter.ts:1697-1704` 生成，被 `OPAQUE_TYPES` 跳过（二进制，合理）。
- **推理字段**：`reasoning_content`/`reasoning*` 被 `OPAQUE_MESSAGE_KEYS` 跳过（`model-egress.ts:381-386`，测试 `model-egress.unit.test.ts:116-126` 明确断言推理原文不变）。这不是本 PR 引入的，但意味着“对所有发给模型的文字都遮残缺私钥”并不包括推理块；如果模型把读到的私钥片段写进推理并被存回复用，这条路径仍会原样发回。**未核实**推理是否真的会进入下一轮请求。
- **完整输出 base64**：合法 UTF-8 会先 `redactForEgress`；非法 UTF-8 只在 `containsToolOutputSecret` 命中时丢完整输出（`pi-output-export.ts:42-45`），其余按原字节。出口看不到 base64 内部，这一点与作者说法一致；但也带来上面的二次遮盖问题。
- **二次遮盖/损坏**：见发现 1、3。`image_url` 块本身安全，普通字符串 data URL 不安全。
- **资源耗尽**：`redactPrivateKeyFragments` 有 `includes("PRIVATE KEY-----")` 早退；`KEY_TAIL` 有 19200 字符窗口和 120 行上限；性能用例存在但未覆盖上述最坏形态（发现 8）。
- **不可逆操作**：后台命令输出不再在流式阶段抛 `PI_RESULT_SECRET_REJECTED`，但命令本身已经执行，抛错并不能回滚；改动只是把“拒绝输出”改成“内部存原文、出口遮”，没有让不可逆副作用变多。输出尾写入 stdout/私有文件属“内部原文”策略范围。
- **网页结果**：Exa/DeepSeek 只剩查询词和网址的 `scanMachineSecrets`，结果交给出口遮盖；`OUTPUT_REDACTED` 删除后全仓库无悬挂引用（grep 确认）。
- **登记表/门槛**：`check-egress-redaction.mjs` 删除的 10 个文件与实际删除的调用一致；`model-egress` 的 `scanMachineSecrets: 1` 与实际 1 处调用一致；`pi-output-export.ts` 同时加入 `REDACTOR_ONLY_FILES` 和 `SENSITIVE_GATE_CALLS`，逻辑自洽。`test/tooling/egress-redaction-check.test.mjs` 有未登记调用/数量不符的反向用例。
- **文档一致性**：见发现 5，属于作者声明的延期。

---

## 四、必答问题

**1. 会不会改变模型已经见过的请求开头？**
请求结构上仍然只追加，没有把每轮变化的值塞进系统提示或工具定义；工具定义被 `DEFINITION_KEYS` 整体跳过，系统提示靠 `TRUSTED_PROMPT_TEXTS` 保护，通常不变。但**遮盖规则的改变会让已经发过的历史在下一轮重新遮出不同字节**：
- 含残缺私钥的历史消息会变一次——Andy 2026-11-07 已同意；
- 含“以 `data:` 开头但不是合法 base64 数据网址”或“合法 base64 数据网址里恰好有 `AKIA/ASIA...`”的历史消息也会变一次——这一部分**超出了**引用的同意范围（原话只针对“对所有发给模型的文字都遮残缺私钥”）。
所以答案不是“完全不改变”：结构是只追加，但历史字节会因新规则一次性变化。每轮会变的值（fingerprint、outcome）只进记录器，不进请求。

**2. 同一段文字会不会在不同请求里变成不同字节？**
新增规则本身是确定的：残缺私钥统一替换成 `[密钥]`，`fingerprint` 不进入请求；`maskKeyTails` 的窗口/`floor` 只取决于当前字符串自身，不依赖后面的消息；data URL 判定也只取决于该字符串。没有发现“依赖后文”的新规则。需要注意的仍是既有的 `known` 点名值机制（规则文件第 11 条的例外），以及“规则换新导致历史一次性变化”，但它们不是每次请求都不同。

**3. 有没有对应的自动检查，反向用例真的会失败？**
有：
- `packages/sensitive-capture/test/private-key-fragments.unit.test.ts`：完整块、缺首行、缺尾行、diff/grep 前缀、JSON 转义、性能、以及“只有标记/普通文字不遮”的反例；
- `packages/application/test/model-egress.unit.test.ts`：data URL 双向用例、自检拒发时 `withheld` 记录、残缺私钥经真实出口遮盖；
- `apps/agent-service/test/production-foreground-result.unit.test.ts`、`production-host-read.unit.test.ts`、`pi-coding-program.unit.test.ts`：改为经真实 `ModelEgress` 断言模型侧看不到密钥；
- `packages/platform-node/test/sandboxed-coding-operations.unit.test.ts`、`test/integration/workspace-copy.test.ts`：完整输出遮值/原字节复制；
- `packages/runtime-pi/test/model-output-budget.unit.test.ts`、`test/tooling/egress-redaction-check.test.mjs` 的行为/登记反向用例。
缺口：没有测“真 base64 data URL 撞上 `AKIA` 后仍是合法 base64/不被破坏”；没有测非 bash 的单行 head 截断；没有端到端校验 `fullOutput` 解码后与 `digest` 一致。

**4. 每个新增/修改的值，使用它的地方都能接受吗？**
- `ModelEgressSighting.outcome: "withheld"`：记录器默认 `masked`（`sensitive-interception-recorder.ts:77`），DB 迁移 `0078` 允许 `withheld`，contracts 枚举有它，控制台三语文案和过滤都有它——两端一致。
- 残缺私钥的 `ruleId: "private-key-block"`：是 `EgressRedactionRuleId` 子集，`memoryCategory` 通过 `MACHINE_SECRET_RULE_IDS` 能识别——一致。
- `fullOutput.redacted: true`：只有生产者和测试使用，没有消费方校验；多一个字段本身无害，但见发现 3，`digest`/`byteLength` 不保证与实际发出的 base64 一致。
- 删除 `WebProviderFailureCode.OUTPUT_REDACTED`：全仓库无残留引用（grep 确认），`webProviderFailure` 的 fallback 到 `UNAVAILABLE`。
- `PI_OUTPUT_FILE_REJECTED` 被复用到“含密钥的非法 UTF-8”：调用方接受这个码，但会误报成“超过上限”（发现 4）。
- `SENSITIVE_GATE_CALLS` 的删除与调用数：与源码一一对应，脚本会反向校验。
- `BASE64_DATA_URL`/`CUT_TOKEN_START`：内部常量，无外部消费方；`CUT_TOKEN_START` 的作用域疑点见发现 6/9。
