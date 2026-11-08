# 复核结论（e5edb54 vs f0478c4）

## 一、发现（按严重度从高到低）

### 1. 高：同一段文字里重复出现的密码/验证码，后面几次不会被遮就发往外部
- 文件:行：`packages/sensitive-capture/src/external.ts:57-61`；`packages/sensitive-capture/src/redaction.ts:283-292`、`359-373`；`apps/agent-service/src/production-coding-workflow.ts:119-120`
- 问题：`redactForExternalText` 只把 `tag` 传给 `redactForEgress`，没有传 `known`，也没有在本地收集“点名值”。因此只有带关键词的那一处会被遮，同一字符串里后面单独出现的同一个密码/验证码会原样发出。发给模型的出口（`Exchange`）会传 `this.#known`，所以模型出口能遮住后续重复，外部出口不能。
- 证据：
  - `external.ts:57-61`：
    ```ts
    export function redactForExternalText(input, options = {}) {
      return redactForEgress(input, options.tag === undefined ? {} : { tag: options.tag });
    }
    ```
  - `redaction.ts:283-292`：只有 `known !== undefined` 时才会 `known.set(original, placeholder)`。
  - `redaction.ts:359-373`：模型出口靠 `known` 循环把后面单独出现的原值替换掉。
  - `model-egress.ts:218-225` 确实传了 `known: this.#known`。
- 影响：搜索词或网址文字里先写 `password: hunter2abc`，后面再单独出现 `hunter2abc`；或验证码在 40 字窗口外再次出现时，第二次会明文发给 Exa/DeepSeek。这与作者“规则和发给模型的出口遮盖完全相同”的说法不一致。
- 建议：每次外部遮盖调用单独建一个 `known` Map 传进去；网址参数被遮时也把原值记进同一 Map（或先对整段文字做遮盖再处理参数），并补“同一值重复出现”的测试。
- 【读代码证实】

### 2. 中：TypeSafe 按叶子遮盖时，靠字段名表达敏感性的密码/验证码不会被遮
- 文件:行：`packages/platform-node/src/typesafe-jev-transport.ts:113-120`；`packages/sensitive-capture/src/redaction.ts:68-69`
- 问题：`redactedState` 只对字符串值调用 `redactForExternalText`，不把键名带进文本。若 state 里出现 `{"password":"hunter2abc"}` 或 `{"verificationCode":"482910"}`，值本身没有关键词，`PASSWORD_ASSIGNMENT` 不会命中，会原样发给 TypeSafe。
- 证据：
  ```ts
  function redactedState(value: unknown): unknown {
    if (typeof value === "string") return redactForExternalText(value).text;
    ...
    Object.entries(value).map(([key, entry]) => [key, redactedState(entry)])
  ```
  `PASSWORD_ASSIGNMENT` 要求同一字符串里有 `password`/`密码` 等关键词加分隔符。
- 影响：当前 `prepareInput` 生成的 envelope 只有身份、版本、动作等字段（`production-automatic-review.ts:82-97`），所以生产数据里暂时没有这种字段；这是纵深防御的缺口，不是当前必然泄漏。作者说的“逐个字符串叶子遮一遍”本身属实，但不等同于“按字段语义遮敏感值”。
- 建议：遮盖时把键名拼进待遮文本（例如 `key: value`），或对已知敏感键名直接替换值；补 `{password: ...}`、`{verificationCode: ...}` 的测试。
- 【读代码证实；生产 envelope 是否可能含此类字段为推测】

### 3. 中：入口处的遮盖没有被 `npm run check` 守住，静态检查只查函数名出现过
- 文件:行：`scripts/check-egress-redaction.mjs:88-100`、`210-214`、`242-250`；`package.json` 的 `check:egress-redaction`
- 问题：
  1. `REQUIRED_EXTERNAL_REDACTION_CALLS` 只登记了 Exa、DeepSeek、TypeSafe 三个提供方文件；`production-coding-workflow.ts` 的 `outboundWebArguments` 没有被任何登记项覆盖。删掉或绕过入口遮盖，`npm run check` 仍会通过。
  2. 检查只做 `new RegExp(\`\\b${required}\(\`)` 的函数名存在性匹配；把函数调用放到死代码、或遮错值，都能通过。
  3. `check:egress-redaction` 只运行 `scripts/check-egress-redaction.mjs` 和 `test/tooling/egress-redaction-check.test.mjs`，这次新增的 `production-coding-workflow.unit.test.ts`、`external.unit.test.ts` 等行为测试不在 `npm run check` 里。
- 证据：
  ```js
  for (const required of REQUIRED_EXTERNAL_REDACTION_CALLS.get(relative) ?? [])
    if (!new RegExp(`\\b${required}\\(`, "u").test(text))
      violations.push(...)
  ```
  以及注册表只有三个 `packages/platform-node/src/*` 文件。
- 影响：作者“缺了 npm run check 失败”的说法对三个提供方文件成立，但 PR 的主要入口（缓存键、沙箱输入、授权摘要）没有自动门禁；反向验证是人工做的。
- 建议：把 `production-coding-workflow.ts` 纳入要求（例如要求 `outboundWebArguments` 内出现两个遮盖调用），或增加一个可断言的 AST/字符串检查；把关键行为测试纳入 `npm run check` 的某个步骤。
- 【读代码证实】

### 4. 低：机器密钥的占位符不带编号，不同机器密钥在缓存键/授权摘要里会塌成同一个值
- 文件:行：`packages/sensitive-capture/src/redaction.ts:297-304`；`apps/agent-service/src/production-coding-workflow.ts:280`、`316`、`449-455`；`packages/sensitive-capture/test/external.unit.test.ts:85-90`
- 问题：`EgressPlaceholderKind` 不含机器密钥；机器密钥一律变成 `[密钥]`，不经过 `tag`。因此两个只在机器密钥上不同的搜索词（如 `deploy ghp_AAA` 与 `deploy ghp_BBB`）遮盖后完全相同，`WebToolMemory.key` 相同，`input-digest` 也相同；第二次搜索会命中第一次的缓存。
- 证据：
  ```ts
  text = redactMachineSecrets(...);
  ...
  text = text.split(MACHINE_SECRET_MARKER).join(MACHINE_SECRET_PLACEHOLDER);
  ```
  而缓存键来自 `arguments: args`（已遮盖）。新增测试只覆盖了两个不同 `password` 的缓存分离。
- 影响：这不是秘密泄漏（两次真正发出去的字节本来就相同），但作者“两个不同的密码得到不同的占位符，搜索缓存不会串”的说法只对密码类成立；对 PR 的主要对象机器密钥不成立，搜索不同密钥会拿到同一份结果。
- 建议：如果希望区分，给机器密钥也生成编号占位符（会改变与模型出口的一致性，需要设计决定）；或者缓存键使用“原始参数的内部哈希 + 遮盖后参数”的组合，仅内部使用。补两个不同机器密钥的缓存测试。
- 【读代码证实】

### 5. 低：先遮盖、后做大小校验，模型给出的超大网址会先进入正则处理
- 文件:行：`apps/agent-service/src/production-coding-workflow.ts:184-211`；`packages/platform-node/src/exa-public-search.ts:210-218`、`274`；`packages/platform-node/src/deepseek-web-provider.ts:70-74`、`124`；`packages/sensitive-capture/src/external.ts:81`、`176-182`
- 问题：原来 `validatePublicFetchUrl` 先检查 8192 字节、`Exa.search` 先检查 4096 字节；现在先调用 `redactForExternalText` / `redactForExternalUrl`，再检查。`ENCODED_PLACEHOLDER = /%5B(?:%[0-9A-F]{2}|[ a-z0-9])*?%5D/giu` 在大量 `%5B` 且没有 `%5D` 的输入上可能退化为二次复杂度。
- 证据：见上述行；`outboundWebArguments` 在 `CODING_INPUT_TOO_LARGE` 和 `Buffer.byteLength(args["query"]) > 4096` 之前执行。
- 影响：工具参数来自模型/不可信网页诱导的模型输出，属于本地 CPU 资源消耗面；目前有模型输出长度和运行超时兜底，风险有限。
- 建议：对原始输入先做长度上限检查（网址 8192、查询 4096），遮盖后再检查一次；给 `ENCODED_PLACEHOLDER` 加输入规模保护或改写为线性扫描。
- 【读代码证实调用顺序；实际可利用程度/耗时未实测】

### 6. 低：网址片段的处理与作者描述不完全一致，且片段里的 `token=` 只按文字规则遮
- 文件:行：`packages/sensitive-capture/src/external.ts:105-134`、`136-158`
- 问题：`withoutSensitiveParameters` 用第一个 `?` 和其后的第一个 `#` 划分查询。若 `#` 在 `?` 之前（如 `https://x/#route?token=abc`），片段里的 `token=abc` 会被当成查询参数遮掉；若片段形如 `#token=abc`（没有 `?`），则只按文字规则遮，`token` 值不会按参数名处理。作者说“片段里的内容只按文字规则遮，不按参数名遮”，只对后者成立。
- 证据：
  ```ts
  const query = input.indexOf("?");
  const fragment = input.indexOf("#", query);
  const end = fragment < 0 ? input.length : fragment;
  ```
- 影响：HTTP 客户端通常不把片段发给服务端，所以实际泄漏风险低；但如果 Exa/DeepSeek 使用完整 URL 或片段有语义，`#token=...` 会带出去。
- 建议：先解析出真正的 fragment 边界，再决定是否对 fragment 内的参数名做遮盖；或明确文档化为限制并加测试。
- 【读代码证实；实际提供方是否使用片段为推测】

### 7. 低：`validatePublicFetchUrl` 不再检查机器密钥，当前调用方都先遮，但函数契约变弱
- 文件:行：`packages/platform-node/src/exa-public-search.ts:120-122`
- 问题：删除了 `scanMachineSecrets(value)` 检查，只保留长度和 URL 校验。当前三个调用点（workflow、Exa、DeepSeek）都传遮盖后的值，所以现状安全；但这是导出的公共函数，未来或测试里直接传原文会绕过机器密钥检查。
- 证据：`if (Buffer.byteLength(value) > 8192) throw ...`，没有 `scanMachineSecrets`。
- 建议：保留“调用方必须已遮盖”的注释/命名，或在函数内部做一次 `assert`（会与“先遮再发”重复但安全）；至少加一个测试说明直接调用不再负责遮盖。
- 【读代码证实】

### 8. 信息：`externalTag` 取密钥失败会从工具流程抛出，而不是稳定的工具失败结果
- 文件:行：`apps/agent-service/src/production-coding-workflow.ts:115`；`apps/agent-service/src/service-main.ts:885-887`；`apps/agent-service/src/production-runtime-tools.ts:1124`
- 问题：`await services.externalTag?.()` 抛错会直接冒出 `executeProductionCodingRequest`，没有转成 `WEB_*_INPUT_INVALID` 或 `failed(...)`；也没有对应失败测试。
- 证据：`const tag = await services.externalTag?.();` 无 try/catch；调用方 `#executeRequest` 直接 `return executeProductionCodingRequest(...)`。
- 影响：生产聊天本身也需要同一把密钥，取不到时聊天已经不可用，所以安全上可接受；但会把“外部服务不可用”变成内部异常，可能影响运行终态和诊断。
- 建议：明确错误码并在工作流内转成稳定失败，或在启动时解析密钥并复用同一个 `ModelEgress`；补取密钥失败用例。
- 【读代码证实】

---

## 二、必答问题

### 问题 1：会不会改变模型已经见过的请求开头？
**结论：不会改变已发出的系统提示、工具定义、历史消息和遮盖结果；只在末尾追加新内容。**

依据（读代码证实）：
- `model-egress.ts` 的改动只是把原来的内联 `tag` 抽成 `placeholderTag`，签名消息仍是 `${kind}\u0000${value}`，密钥和 `sign` 未变（`model-egress.ts:120-125`、`218-225`）；`redactForEgress` 本身没有改动。
- `outboundWebArguments` 返回新对象，不修改 `call.arguments`；`stableCall(call)` 保存的仍是模型原始调用（`production-coding-workflow.ts:56-69`、`246-254`）。历史写入侧 `RuntimeHistoryService` 明确“不重写字段”（`runtime-history-service.ts:37`）。
- 变的是新产生的 `web_fetch` 工具结果里的 `url` 字段（`runWebTool` 返回 `fetched.result.url`，已是遮后的网址）。它作为新的工具结果只在末尾追加；以前含机器密钥的搜索/读取会被整次拒绝，所以旧历史里没有同类结果。旧历史里已有的敏感查询参数网址不会被回写。
- 没有新增每轮变化的值到固定头部；新工具结果里的 `retrievedAt` 本来就是每轮变化的，且位于追加的消息里。
**未核实：** 没有实际跑 `check:prompt-prefix` 或抓请求体验证；以上是代码路径核对。

### 问题 2：同一段文字会不会在不同请求里变成不同字节？
**结论：在同一遮盖密钥、同一环境、同一调用配置下，不会；现有代码是确定性的。**

依据（读代码证实）：
- `placeholderTag` 用 HMAC 对 `${kind}\u0000${value}` 签名，纯函数；`ModelEgress` 的密钥派生结果在实例内缓存（`production-model-egress.ts:75-86`）。
- `redactForExternalText` / `redactForExternalUrl` 没有依赖时间、随机数、集合遍历顺序；`withFinding` 按固定 `EGRESS_REDACTION_KINDS` 顺序输出。
- TypeSafe 的 `redactedState` 按对象原有顺序遍历，结果确定。
- 例外是既有的遮盖密钥轮换（`prompt-prefix.md:79` 已承认会改变字节），以及没有提供 `externalTag` 时的无编号占位符回退；生产装配提供了 `externalTag`。机器密钥始终是 `[密钥]`，本身也是确定的。

### 问题 3：有没有对应的自动检查？反向用例真的会失败吗？
**部分有，且不够完整。**

- 有：`scripts/check-egress-redaction.mjs` 新增了三个外部出口文件必须出现指定遮盖函数名；`test/tooling/egress-redaction-check.test.mjs` 有正向和反向用例（例如缺少 `redactForExternalUrl` 时报告失败）。这些属于 `npm run check`。
- 有：新增 `[mask-not-block]` 测试和 `external.unit.test.ts`，从代码看，把源文件换回旧实现时这些测试会失败（旧实现会拒绝或缺少新函数）。但这属于 `npm run test`，**不在 `npm run check` 里**。
- 不足：入口 `outboundWebArguments` 没有被静态检查覆盖；静态检查只查函数名出现，不查是否包裹了要发出的值；`REQUIRED_EXTERNAL_REDACTION_CALLS` 只到提供方文件。
**未核实：** 没有实际执行测试，反向失败的结论是根据旧代码行为推断。

### 问题 4：改动产生/修改的每个值，使用它的地方都能接受吗？
**已核对的主要值：**

- `[密码#8位]`、`[密钥]`、URL 编码后的 `%5B...%5D`：Exa 的 `callTool` 参数接受任意字符串；DeepSeek 只校验 `[...query].length` 和 URL 结构；TypeSafe 的 JSON `state` 接受字符串。**没有类似 I-73 的后端 `machineString` 校验会拒绝它们。**（读代码证实）
- `resourceRef = coding:<sha256>`、`input-digest = sha256`：形状未变，`public-search-authorization` 只检查目标类型/域/接收方，不校验摘要值；`runtime-tool-authorization` 不使用该值。语义从“原始参数摘要”变成“遮后参数摘要”，**已有的、部署前创建的审批在升级后可能无法按原摘要续用**（未核实是否存在这种跨版本在途审批）。
- `externalTag` 接口：生产 `service-main.ts` 已注入，`createProductionFileReadServices` 会转发；未提供时 `outboundWebArguments` 接受 `undefined` 并退回无编号占位符。
- `REQUIRED_EXTERNAL_REDACTION_CALLS` 的键与 `ALLOWED_EXTERNAL_EGRESS_FILES` 键一致，测试又加了“每个登记外部出口必须写明”检查。
- `web_fetch` 工具结果 `url` 变成遮后网址：模型、UI、缓存和后续续读都能接受；续读时入口会再次遮盖，代码上幂等。
- TypeSafe 的 `[密钥]`/`[密码]` 由 `redactedState` 放入 `state`，解析端只要求 JSON 结构，不要求原值。

---

## 三、侧重检查

- **错误路径**：`externalTag` 失败会抛异常，未转成稳定工具错误（见发现 8）。`redactForExternalText` 在外部路径不会执行 `ModelEgress` 那种“遮完再断言”的最后检查（`model-egress.ts:229-243`），若遮盖规则本身漏掉机器密钥，外部路径没有最后一道拦截。
- **不合规范/不可信输入**：模型给出的 URL/查询是主要不可信输入。用户信息、敏感参数名、路径和查询文字有处理；但片段、参数名编码、`&`/`;` 分隔、`&amp;` 等边界没有完整覆盖。`validatePublicFetchUrl` 的机器密钥检查已移除，当前调用方都先遮。
- **安全**：发现 1 是实际泄漏路径；发现 2 是纵深防御缺口；发现 4 是缓存/摘要塌缩，不泄漏但会让不同机器密钥的搜索混在一起；`ModelEgress` 的最后断言没有照搬到外部路径。
- **资源耗尽**：发现 5，先遮盖后限长；`ENCODED_PLACEHOLDER` 有二次复杂度风险，未实测。
- **不可撤销操作**：本 PR 只涉及只读的搜索/读取和 TypeSafe 审核请求/回复，没有新增不可撤销副作用。TypeSafe 回复不再因含机器密钥被拒绝，但原始回复不落盘，只使用解析后的 `answers`/`usage`，风险可接受。
- **规则/文档一致性**：
  - `prompt-prefix.md` 的“只追加、字节确定”没有被本次改动破坏（问题 1、2）。
  - 作者“`isSensitiveQueryParameter` 只用于诊断打码”属实（`pi-runtime-adapter.ts:316-325`）。
  - 作者“删掉四行 `SENSITIVE_GATE_CALLS`”属实；这四个文件里也确实不再有对应调用。
  - 作者“规则和发给模型的出口遮盖完全相同”**不准确**：外部文字路径没有 `known`（重复值不漏遮）也没有遮盖后的机器密钥断言。
  - “两个不同密码不共用缓存”对密码类成立；对机器密钥不成立（发现 4）。
  - “每个登记的外部出口文件都必须写明遮盖函数”属实，但入口工作流不在登记范围（发现 3）。
  - 未逐文件核对“编辑过的文件删除所有注释”这一条；只抽查到 `typesafe-jev-transport.ts` 及其测试只剩允许的 `biome-ignore` 注释。

---

## 四、未核实

- 没有实际运行 `npm run check`、`npm run test`、`check:prompt-prefix`，也没有跑作者的反向验证；测试是否全部通过、失败条数是否如作者所述，未核实。
- 没有实际抓取 Exa/DeepSeek/TypeSafe 真实请求体；只核对了代码路径和测试断言。
- 没有逐条核对所有 `resourceRef` / `input-digest` 的消费方；只看了 `public-search-authorization.ts`、`runtime-tool-authorization.ts` 和运行时工具入口。
- 没有完整核对所有被编辑文件是否都删除了既有注释。
- 没有评估 `ENCODED_PLACEHOLDER` 在最坏输入下的实测耗时。
