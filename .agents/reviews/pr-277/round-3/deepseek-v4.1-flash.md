## 结论

本轮增量（38133377→2ba56754）只改了三处：TypeSafe state 共用编号函数、DeepSeek 预拒改按字节、补 DeepSeek 检查脚本反向用例。三处修改本身与作者描述一致，未发现高严重度代码缺陷。主要问题是**文档仍写着“拒绝含密钥的网址/查询”，代码已改成“遮值后发送”**，以及几处低严重度的测试/静态检查覆盖不足。

---

## 读代码证实的问题（按严重度）

### 1.【中】文档与代码不一致：旧 ADR/设计仍说“拒绝”，代码已改成“遮值后发送”

- 文件:行：`docs/adr/0071-replaceable-web-search-and-fetch-providers.md:46`；`docs/execution/specs/2026-09-10-control-center-local-acceptance-design.md:47`、`:128`
- 问题：文档仍把“含密钥的网址”“凭据检测”描述成拒绝发送；当前代码会先遮值再发送。
- 证据（文档）：
  - ADR 0071:46：“网址先在主机侧检查：只收 http(s)，拒绝带账号密码、localhost、内网和保留地址、IPv6 字面量、超过 8192 字节的网址以及含密钥的网址。”
  - 设计文档:47：“查询限制长度与结果数量、拒绝机器秘密”；:128：“凭据检测继续阻止发送”。
- 证据（代码）：
  - `packages/platform-node/src/exa-public-search.ts:120-123`
    ```ts
    export function maskedPublicFetchUrl(value: string): string {
      if (Buffer.byteLength(value) > 4 * 8192) throw new Error("WEB_FETCH_INPUT_INVALID");
      return validatePublicFetchUrl(redactForExternalUrl(value).text);
    }
    ```
  - `packages/platform-node/src/deepseek-web-provider.ts:71` 查询词改为 `redactForExternalText(input.query.trim()).text`；`:125` 网址改为 `maskedPublicFetchUrl(input.url)`。
  - `packages/sensitive-capture/src/external.ts:88-99` 的 `withoutUserInfo` 会去掉网址里的账号密码而不是拒绝；`:121-146` 会遮掉敏感查询参数而不是拒绝。
- 建议：补一份新的 ADR（或在这些 ADR 里加“已被后续决定取代”的指向），说明“发往 Exa/DeepSeek 的搜索词和网址改为遮值后发送；账号密码直接剥离；机器密钥仍替换为 `[密钥]`”。设计文档也同步更新，避免运维/后续评审按旧行为理解。

### 2.【低】`externalTag` 缺失时回退到每次新建的顺序编号，会让不同密码得到同一占位符，进而撞 web 工具缓存键

- 文件:行：`apps/agent-service/src/production-coding-workflow.ts:115-120`；`packages/sensitive-capture/src/external.ts:76-84`；`apps/agent-service/src/web-tool-memory.ts:38-57`
- 问题：`outboundWebArguments` 允许 `services.externalTag` 为 `undefined`，此时 `redactForExternalText(query, {})` 每次调用新建一张顺序编号表，两个不同密码都得到 `[密码#aaaaaaaa]`；而 `web-tool-memory` 的缓存键正是用遮值后的 query 算的，于是第二次不同密码的查询可能命中第一次的缓存结果。
- 证据：
  - `production-coding-workflow.ts:115-120`
    ```ts
    const tag = await services.externalTag?.();
    const options = tag === undefined ? {} : { tag };
    return {
      ...args,
      ...(typeof query === "string" ? { query: redactForExternalText(query, options).text } : {}),
      ...(typeof url === "string" ? { url: redactForExternalUrl(url, options).text } : {}),
    };
    ```
  - `external.ts:80-83`
    ```ts
    return redactForEgress(input, {
      known: options.known ?? new Map<string, string>(),
      tag: options.tag ?? sequentialPlaceholderTag(),
    });
    ```
  - `production-coding-workflow.ts:454-459` 把 `args`（已遮值）传给 `memory.key(...)`；`web-tool-memory.ts:38-57` 用 query/url 生成 SHA-256 缓存键。
- 严重度说明：当前生产装配 `service-main.ts:885-891` 总是提供 `externalTag`，所以生产路径不可达；但类型把 `externalTag` 标成可选，测试里也允许返回 `undefined`（`production-coding-workflow.unit.test.ts:977`），属于潜在坑。
- 建议：把 `externalTag` 设为必填，或回退时不要用会跨调用复位的顺序编号（至少让缓存键包含原始 query 的哈希，或在没有 key 时禁用缓存）。

### 3.【低】`service-main.ts` 里 `externalTag` 失败后丢缓存的分支没有测试（作者已承认）

- 文件:行：`apps/agent-service/src/service-main.ts:875-891`
- 问题：`externalEgress ??= createProductionModelEgress(...)` 之后 `externalTag()` 抛错会 `externalEgress = undefined`，下次重建。这条错误路径没有自动测试。
- 证据：
  ```ts
  let externalEgress: ReturnType<typeof createProductionModelEgress> | undefined;
  ...
  externalTag: async () => {
    externalEgress ??= createProductionModelEgress(configuration, sources);
    try {
      return await externalEgress.externalTag();
    } catch (error) {
      externalEgress = undefined;
      throw error;
    }
  },
  ```
- 建议：把这段闭包抽成可单独测试的小工厂（例如 `createExternalTagSource(configuration, sources)`），补“第一次 key 解析失败、第二次成功”的用例。作者已列为待办，可接受，但应在 PR 里明确记录。

### 4.【低】静态检查只认“函数名出现过”，不认“作用在要发送的值上”；且 `maskedPublicFetchUrl` 不在 `EXTERNAL_REDACTION_FUNCTIONS` 列表

- 文件:行：`scripts/check-egress-redaction.mjs:83-100`、`:242-250`
- 问题：检查用 `new RegExp(\`\\b${required}\\(\`)` 只判断函数名在文件里出现，注释或无关调用也能满足；`REQUIRED_EXTERNAL_REDACTION_CALLS` 里 DeepSeek 要求 `maskedPublicFetchUrl`，但 `EXTERNAL_REDACTION_FUNCTIONS` 只列了 `redactForExternalText`、`redactForExternalUrl`，两处清单不完全一致。
- 证据：
  ```js
  export const EXTERNAL_REDACTION_FUNCTIONS = Object.freeze([
    "redactForExternalText",
    "redactForExternalUrl",
  ]);
  ...
  for (const required of REQUIRED_EXTERNAL_REDACTION_CALLS.get(relative) ?? [])
    if (!new RegExp(`\\b${required}\\(`, "u").test(text))
      violations.push(...)
  ```
- 建议：至少把 `maskedPublicFetchUrl` 加入 `EXTERNAL_REDACTION_FUNCTIONS`，并加一个“清单里的名字必须属于已登记遮盖函数”的自检；更强的做法是做轻量结构检查（例如确认 `redactForExternalText` 的返回值进入发往外部服务的 body），否则这个门只能防“完全删掉调用”。

### 5.【低】新 TypeSafe 用例只断言“不同值不同占位符”，没有断言“同一个值在不同字段得到同一占位符”

- 文件:行：`packages/platform-node/test/typesafe-jev-transport.unit.test.ts:230-244`
- 问题：本轮修复的核心是“不同值一定不同”，但同一值跨字段保持一致同样重要；现有 `:217-228` 的“同一密码再次出现”只断言不含明文，没有断言占位符相同。
- 证据：
  ```ts
  const placeholders = sent.match(/\[密码#[a-z]{8}\]/gu) ?? [];
  expect(placeholders).toHaveLength(2);
  expect(new Set(placeholders).size).toBe(2);
  ```
- 建议：把 `:217` 的用例加强为断言 `note` 和 `later` 里出现的是同一个 `[密码#xxxxxxxx]`；或在新增用例里加一组“同值两字段”。

### 6.【信息/低，非本轮引入】TypeSafe 请求体把每轮变化的 `state` 放在最前，固定 `model/questions` 在后

- 文件:行：`packages/platform-node/src/typesafe-jev-transport.ts:292-296`
- 问题：`{ state, model, questions }` 中 `state` 是每次审查都变的内容，放在最前；若 TypeSafe 侧有前缀缓存，固定部分无法命中。这不是本轮改动引入的，但和 prompt-prefix 规则“固定的在前、会变的在后”不一致。
- 证据：
  ```ts
  const body = JSON.stringify({
    state: redactedState(envelope),
    model: descriptor.model,
    questions: REVIEW_TYPESAFE_QUESTIONS.questions,
  });
  ```
- 建议：若确认 TypeSafe 有缓存收益，另开改动把 `model`、`questions` 放前、`state` 放后；这会一次性改变 TypeSafe 请求开头，需要按规则单独评估。当前 TypeSafe 是单次决策调用，没有多轮历史，所以不构成本轮阻断。

---

## 推测/未核实

- 我没有运行测试或 `npm run check`（只能用 git 命令和读文件）。下面关于“反向用例会失败”的判断是从代码逻辑推出来的，未实际执行。
- 我按要求没有逐个审 main 带来的 CI 文件；只核实了 `git diff af852041..2ba56754 -- packages apps scripts/check-egress-redaction.mjs test/tooling/egress-redaction-check.test.mjs` 为空，即合并没有改动本 PR 的代码文件。
- 外部服务遮盖是“无状态、只按当次文本规则”的：如果模型在搜索词里放一个**没有关键词、也不是机器密钥格式**的裸密码，`redactForExternalText` 不会识别。但主模型看到的对话已被出口遮盖成占位符，通常不会知道原值，所以实际泄露风险低；未做端到端验证。
- URL 敏感参数识别只覆盖 `?`/`#` 里的参数名，且参数名清单是英文固定集合；路径分段、矩阵参数（`;token=`）、中文参数名不在覆盖范围。这是 round 1 既有设计，不是本轮增量。
- `redactedState` 在 `MAX_REQUEST_BYTES` 检查之前就处理完整 state；state 来自受保护 payload，正常有界，未发现实际资源耗尽路径。

---

## 作者说法核对

- “TypeSafe state 共用编号函数，不同字段不同密码得到不同占位符”：**成立**。`typesafe-jev-transport.ts:117-130` 现在入口建一次 `known` 和 `sequentialPlaceholderTag()`，递归共用；`external.ts:60-74` 的顺序编号对同一 `kind\0value` 稳定、对不同值给不同 index。
- “DeepSeek 预拒超长查询改按字节数”：**成立**。`deepseek-web-provider.ts:70` 已是 `Buffer.byteLength(input.query) > 4 * 4096`。注意遮值后的 `maxQueryChars` 检查仍按字符数（`:74`），这是供应商限制，和“预拒”是两件事。
- “检查脚本补 DeepSeek 缺 `maskedPublicFetchUrl` 的反向用例”：**成立**。`test/tooling/egress-redaction-check.test.mjs:158-166` 用 fixture 断言了缺少 `maskedPublicFetchUrl` 的报错；旧脚本对已登记文件直接跳过，所以该用例在旧脚本上会失败。
- “合并 main 没有改变本 PR 行为”：**基本成立**，但作者说“改的是 CI 脚本、runner 脚本、文档”不完全准确：合并还带来了 `test/integration/production-http-composition-process.test.ts` 的文案改动（`Do not claim overall task success` → `不要说整个任务已经成功`）。这只是测试字符串，和本 PR 代码无交集，不影响行为。
- “`service-main.ts` 里 externalTag 失败丢缓存没有测试”：**成立**，见问题 3。

---

## 侧重检查

- **错误路径**：`externalTag` 失败被 `production-coding-workflow.ts:187-191` 捕获，返回固定的 `WEB_SEARCH_UNAVAILABLE`/`WEB_FETCH_UNAVAILABLE`，不会把 key 错误或秘密带进工具结果；超长输入在遮值前有 `49152` 字节预拒（`:184-185`）和 `4*8192`/`4*4096` 预拒（`exa-public-search.ts:121`、`deepseek-web-provider.ts:70`）；TypeSafe 遮值异常会落到 `#prepare` 的 `catch`，返回 `model.failed`，不会发出半遮内容（`typesafe-jev-transport.ts:300-314`）。未发现错误路径泄露秘密。
- **不可信输入**：TypeSafe state 从 JSON 解析后递归遮值，`isRecord` 排除数组/null，未知类型原样返回；URL/查询词来自模型/用户，`new URL` 有 try/catch，正则对 `%5B` 长串有性能用例（`external.unit.test.ts:166-170`）。未发现新的注入/解析崩溃点。
- **安全**：SSRF 检查发生在遮值后的 URL 上（`exa-public-search.ts:122`），账号密码被剥离、敏感参数被遮；`externalTag` 只暴露签名闭包，不暴露 key；TypeSafe 没有恢复表，占位符不可逆。未发现明显绕过；裸密码/路径参数等遮盖盲区是既有规则边界，已在“推测”里注明。
- **资源耗尽**：输入有字节上限；响应有 `MAX_RESPONSE_BYTES` 和 Exa 的 `responseLimit`；`sequentialPlaceholderTag` 的 Map 大小受输入限制；`redactForExternalUrl` 的编码占位符正则上限 160 字符并有 6 万 `%5B` 的 2 秒性能断言。未发现新增无界增长。
- **不可撤销操作**：遮值只产生新字符串，不改 `call.arguments` 和原始 `envelope`；TypeSafe 决策仍用原始 envelope 做绑定校验（`typesafe-jev-transport.ts:211`、`:507-533`）；没有新增文件写入或删除。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 的“遮盖密钥不变时字节相同”在本轮成立（TypeSafe 顺序编号每次请求从头开始；外部 web 用 HMAC key，key 稳定时同一值同一字节）；但 `docs/adr/0071` 和 2026-09-10 设计文档与“遮值后发送”的代码不一致，见问题 1。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**主对话（Pi 发给大语言模型的内容）不会。** 本增量没有改系统提示、工具定义或历史组装；搜索词/网址的遮值发生在工具执行前，工具结果（可能回显遮值后的 query/url）是**新追加的工具结果消息**，不是改写已有历史。外部遮值用的 HMAC 编号与主对话出口遮盖一致（`model-egress.unit.test.ts:688-698`），所以模型之前看到的同一秘密占位符与工具结果里的占位符相同，不会因为工具结果而改变前面已发内容的字节。每轮会变的 query/url、搜索结果都在新追加的工具调用/结果里，符合“只在末尾追加、会变的值放最后”。

**TypeSafe 是另一条单次决策调用，不是多轮对话。** 它的 body 每次由冻结的 state 重新生成；本轮共用编号函数会改变“有多个不同密码的 state”的占位符字节（相对旧版本），但同一输入两次生成完全相同的 body（`typesafe-jev-transport.unit.test.ts:214` 的 `expect((await run()).sent).toBe(first.sent)`），不存在“已经见过的历史前缀”被改写。唯一需要留意的是它的字段顺序仍是 `state` 在前、`model/questions` 在后（问题 6），这是既有设计，不是本轮引入。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

- **TypeSafe**：同一份 state 两次请求 → 字节相同（每次入口新建顺序编号表，遍历顺序固定）。但**同一个密码值在不同审查请求、不同位置**会因顺序编号得到不同占位符；这是顺序编号的固有属性，TypeSafe 没有恢复表、也没有跨请求历史，所以不构成缓存/泄露问题。若将来要求“同一值跨请求稳定伪名”，应改用 HMAC 编号。
- **外部 web 工具**：生产路径先由 `externalTag()` 用 HMAC 遮值（`model-egress.ts:120-125`、`production-model-egress.ts:76-88`），同一 `kind+value`、同一 key 下字节稳定；适配器再遮时看到占位符会原样保留（`external.ts:117-119`、`:188-194`）。key 轮换会改变占位符，这是规则里已记录的已知代价，不是本轮新增。
- **确定性**：`redactedState` 依赖 `Object.entries` 顺序，state 来自 `JSON.parse` 的固定 payload，同一字符串顺序固定；`findings` 按 `EGRESS_REDACTION_KINDS` 排序；URL 参数按 `&` 顺序处理。未发现无序集合或时间字段进入遮值结果。
- **回退路径的例外**：`externalTag` 缺失时，`redactForExternalText`/`redactForExternalUrl` 每次新建顺序编号，不同秘密可能都变成 `aaaaaaaa`（问题 2），这不是“同一文字变不同字节”，而是“不同文字变同一字节”，会导致缓存键碰撞；当前生产装配不会走这条路径。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，且三条反向用例在旧代码上都会失败（按代码逻辑推断，未实际执行）：
- TypeSafe 新用例 `typesafe-jev-transport.unit.test.ts:230-244`：旧版每个叶子新建编号表，两个密码都得到 `aaaaaaaa`，`new Set(placeholders).size` 为 1，用例失败。
- DeepSeek 新用例 `deepseek-web-provider.unit.test.ts:101-106`：旧版按 `input.query.length` 判断，6000 个“あ”长度 6000 < 16384，不会抛 `WEB_SEARCH_INPUT_INVALID`，而会走到 `maxQueryChars=128` 抛 `WEB_SEARCH_INPUT_UNSUPPORTED`，用例失败。
- 检查脚本新用例 `egress-redaction-check.test.mjs:158-166`：旧脚本对已登记的 `deepseek-web-provider.ts` 直接跳过，不检查 `maskedPublicFetchUrl`，`findEgressViolations` 不会产生该报错，用例失败。
- 既有确定性用例也在：`typesafe-jev-transport.unit.test.ts:214`（同一 state 两次字节相同）、`deepseek-web-provider.unit.test.ts:85`、`exa-mcp-transport.unit.test.ts` 的两次查询同字节用例。

缺口：`service-main.ts` 的失败丢缓存无测试（作者已承认）；新 TypeSafe 用例没有断言“同值同占位符”（问题 5）；静态检查只认函数名（问题 4）。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？

逐个核对如下：
- **`sequentialPlaceholderTag` 生成的 `[a-z]{8}` 编号**：被 `redaction.ts:61` 的 `EGRESS_PLACEHOLDER_PATTERN`、`external.ts:101-103` 的 `PLACEHOLDER`/`ENCODED_PLACEHOLDER` 消费，均要求/接受 8 个小写字母；TypeSafe body 只是 `JSON.stringify`，没有校验器会拒绝这种占位符。**接受**。
- **`maskedPublicFetchUrl` 返回的遮值 URL**：先被 `validatePublicFetchUrl` 检查（`exa-public-search.ts:125-149`），占位符已用 `encodeURIComponent`/`encodeURIComponent` 编码（`external.ts:143`、`:114`），`new URL` 能解析；再发给 Exa/DeepSeek 的 `url` 字段（字符串）。测试覆盖了 `%5B...%5D` 形式（`exa-mcp-transport.unit.test.ts`、`deepseek-web-provider.unit.test.ts:97-99`）。**接受**。
- **`ModelEgress.externalTag()` 返回的 tag 函数**：`production-coding-workflow.ts:115-116` 处理了 `undefined`；类型 `ExternalRedactionOptions["tag"]` 与 `redactForExternalText`/`redactForExternalUrl` 的 `tag` 参数一致；与主对话出口使用同一 HMAC key（`model-egress.unit.test.ts:688-698`）。**接受**。
- **`CODING_INPUT_TOO_LARGE` / `WEB_SEARCH_INPUT_INVALID` 错误码**：`CODING_INPUT_TOO_LARGE` 在本文件已有使用（`:192`），工具结果消费方按既有错误码处理；`WEB_SEARCH_INPUT_INVALID` 与改动前一致。**接受**。
- **`externalTag` 配置/装配字段**：`ProductionFileReadServices` 里是可选项（`production-file-read-workflow.ts:68`、`production-file-read-services.ts:54`），`service-main.ts:885-891` 提供；测试可省略。**接受**，但见问题 2 的回退风险。
- **清单/配置键/序列化格式**：本增量没有新增清单项或配置键；占位符是文本，不是 manifest id。I-73 所说的“清单里的 id 能否过后端校验”不适用于本增量。合并带来的 `linuxRunnerLabel = "ci-vps"` 属于 main 的 CI 改动，未逐个审（按要求）。
- **`docs`/ADR**：没有随代码更新，见问题 1，这是唯一“使用方不能接受/会误导”的地方。
