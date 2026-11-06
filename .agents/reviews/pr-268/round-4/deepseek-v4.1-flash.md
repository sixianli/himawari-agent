## 结论

核心修复方向是对的：整理记忆的固定指令确实是一个连续的目录片段，放在最后一次 user 消息开头，`createProductionModelEgress` 默认带清单后，“1000”不再被验证码规则遮住；清单为空的反向用例也确实会失败。没有发现能让真实秘密稳定绕过遮盖的确定路径。

主要问题集中在：规则文件与代码的退回条件不一致、一个新增测试是空转、页面有一个 `threadId=null` 的边界，以及 `trusted` 选项缺少 24 字下限校验。全量测试没有运行（工具限制），下面凡涉及“通过/失败”都只依据读代码和作者说法。

---

## 发现（按严重度）

### 1. 中：规则文件写的退回条件比代码少一条，`known` 可以让后面的消息退回整段检查

文件：`packages/sensitive-capture/src/redaction.ts:208-213`
规则：`.claude/rules/prompt-prefix.md:53`

证据：

```ts
const known = [...(options.known?.keys() ?? [])];
const filler = TRUSTED_FILLERS.find(
  (candidate) => !input.includes(candidate) && !known.some((value) => value.includes(candidate)),
);
const spans = filler === undefined ? [] : trustedSpans(input, options.trusted ?? []);
if (filler === undefined || spans.length === 0) return redactUntrusted(input, options);
```

规则文件写的是“输入里已经出现全部 34 个候选填充字符时也这样（退回整段检查）”，但代码还检查 `known` 键里的字符。后果是：前面的消息里只要出现过包含这些非字符的密码或验证码（密码规则的值类 `[^\s,，;；]+` 可以包含它们，长度 ≥6 就会进 `known`），后面的消息即使输入本身不含全部 34 个字符，也会退回 `redactUntrusted(input, ...)`，固定文字会重新被检查，I-78 的误遮可能在该请求里复活。文档没有写这条路径，也没有测试覆盖“known 里命中全部 34 个字符”的情况。

建议：要么把 `known` 条件写进规则文件并补反向用例；要么只排除当前 `view` 中实际会与 known 值冲突的字符。若保留该条件，应说明它是为了避免 known 值跨 filler 偶然匹配，而不是“输入含全部填充字符”。

---

### 2. 中/低：页面对 `source="chat"` 且 `threadId=null` 的记录仍显示“你的话”

文件：`apps/control-center/src/components/sensitive-interceptions.tsx:108-118`

证据：

```ts
const part =
  item.source !== "chat" && item.part === "owner_message"
    ? null
    : message(`sensitive.part.${item.part}` as MessageId);
...
const origin =
  item.threadId === null
    ? message("sensitive.background")
    : title
      ? message("sensitive.thread", { title })
      : message("sensitive.threadUntitled");
```

`ModelEgressContext.threadId` 允许 `null`（`packages/application/src/services/model-egress.ts:32`），chat 的 exchange 也直接使用 `request.threadId`（`packages/runtime-pi/src/pi-runtime-adapter.ts:1002`）。如果出现 `source="chat"`、`threadId=null`，页面会显示“后台 · 聊天 · 你的话”，既按 `threadId=null` 把来源显示成“后台”，又仍然叫“你的话”，与“后台调用的 user 消息不再显示成‘你的话’”不一致。生产是否真的产生这种记录，我未核实。

建议：按显示来源判断，而不是只看 `source`，例如 `threadId === null || source !== "chat"` 时隐藏 `owner_message`；并补一个 `source="chat"`、`threadId=null` 的页面用例。

---

### 3. 低：第 4 轮新增的 `known` 排除测试是空转

文件：`packages/sensitive-capture/test/trusted-text.unit.test.ts:104-115`

证据：

```ts
const named = `abc\uFFFFdef`;
const known = new Map([[named, "[密码#abcdefgh]"]]);
const input = `${FIXED}\n${named}`;
```

`named` 本身就在 `input` 里，所以 `!input.includes("\uFFFF")` 已经把 U+FFFF 排除；即使删掉 `redaction.ts:210` 的 `!known.some(...)`，filler 仍然是 U+FFFE，结果一样。这个用例不能证明第 4 轮“挑填充字符时排除 known 键”的改动。

建议：构造 known 值不在 input、但会在 view 中跨 filler 命中的用例，例如 `known = "ab" + "\uFFFF".repeat(FIXED.length) + "cd"`、`input = "ab" + FIXED + "cd"`，断言不退回、固定文字保持；如果该条件确实不需要，就删掉它和这个用例。

---

### 4. 低：重叠可信区间会被整段丢弃，尾部按外来内容检查

文件：`packages/sensitive-capture/src/redaction.ts:193-200`

证据：

```ts
found.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
const spans: (readonly [number, number])[] = [];
let cursor = 0;
for (const span of found) {
  if (span[0] < cursor) continue;
  spans.push(span);
  cursor = span[1];
}
```

如果 A 从 0 开始、B 从 A 中间开始并延伸到 A 之后，贪心会选 A，跳过 B，B 在 A 之后的尾部没有变成 filler，仍会按外来内容检查。是否在真实目录清单里存在这种前后缀重叠，我未核实；但算法本身不保证“所有出现的固定文字都不检查”，可能造成 I-78 式误报。

建议：合并相交/重叠区间，或按覆盖范围选择后再取并集；补一个部分重叠的测试。

---

### 5. 低：`trusted` 选项不强制 24 字下限，短片段可以关掉主人写的关键词

文件：`packages/sensitive-capture/src/redaction.ts:204-213`
测试：`apps/agent-service/test/trusted-prompt-egress.unit.test.ts:147-149`

证据：

```ts
const shortTrusted = await sent([{ role: "user", content: sentence }], { trusted: ["验证码"] });
expect(shortTrusted.body).toContain("482910");
```

`redactForEgress` 直接接受 `options.trusted`，不检查长度；测试明确展示了：只要把“验证码”放进 trusted，主人写的“验证码 482910”就不再被遮。默认清单由 `trustedPromptTexts` 过滤到 ≥24 字，所以当前生产路径没有传短片段；但这是公开的可覆盖选项，未来调用者容易踩到，也和规则文件“不少于 24 个字符”不一致。

建议：在 `redactForEgress` 内按 `TRUSTED_TEXT_MINIMUM_LENGTH` 过滤或校验 `trusted`，或把这个选项限定为内部/测试专用。

---

### 6. 低（推测）：每个文本字段都做全清单扫描，且有可信片段时规则跑两遍

文件：`packages/sensitive-capture/src/redaction.ts:208-227`

证据：

```ts
const known = [...(options.known?.keys() ?? [])];
const filler = TRUSTED_FILLERS.find(
  (candidate) => !input.includes(candidate) && !known.some((value) => value.includes(candidate)),
);
...
const rehearsal = redactUntrusted(view, { ... }).text;
...
const masked = redactUntrusted(view, options);
```

`trustedSpans` 对每个文本字段遍历全部可信文字并做 `indexOf`；`known` 还会对每个候选复制并扫描；有可信片段时 `redactUntrusted` 跑两遍（空跑 + 正式）。历史很长或工具结果很大时，CPU/内存会随 `(#trusted × 文本长度)` 增长，代码没有上限或快速短路。具体开销未量化，属于推测。

建议：仅在可能包含目录文字的字段/消息上启用；或预编译多模式匹配（如 Aho-Corasick）；`trusted` 为空时直接提前返回，不要先复制/扫描 `known`。

---

### 7. 低：作者说“按长度降序”，代码用 UTF-16 `.length`，筛选却用码点

文件：`packages/prompt-catalog/src/entry.ts:68, 72-74`

证据：

```ts
if (segment.kind === "text" && [...segment.text].length >= TRUSTED_TEXT_MINIMUM_LENGTH)
...
[...texts].sort((left, right) =>
  right.length !== left.length ? right.length - left.length : left < right ? -1 : 1,
),
```

筛选按 Unicode 码点，排序按 UTF-16 码元。只影响含 astral 字符片段的排序；由于 `trustedSpans` 最终按起点排序，功能上无影响，但作者“按长度降序”的说法不精确。建议排序也改用 `[...text].length`，或修正说明。

---

## 作者说法核对

1. **“`redactForEgress` 新增 `trusted` 选项，固定文字换成填充字符再换回；对不上抛 `EgressRedactionError`；输入含 U+FFFF 时不启用清单”**：`trusted` 选项和填充/换回属实；但当前实现是“先空跑，失败退回整段检查；正式跑失败才抛”，不是一句“对不上就抛”；填充字符也已从固定 U+FFFF 改为 34 个非字符中挑一个（`redaction.ts:172-176`）。作者后几轮已修正，当前代码与第 2-4 轮说法一致。
2. **“密码规则和私钥块排除 U+FFFF，任何规则不会吞填充字符”**：第 2 轮已作废，代码确认 `machine-secrets.ts` 未改，私钥块仍是 `[\s\S]*?`，密码值类仍是 `[^\s,，;；]+`；现在靠空跑检测，见 `redaction.ts:221-226`。这条旧说法不成立，但不是当前代码的问题。
3. **“清单取不少于 24 字符、去重、按长度降序字典序”**：基本属实；筛选按码点，排序按 UTF-16 码元，见发现 7。
4. **“所有出现位置按起点升序、同起点取更长，贪心不重叠；结果与清单顺序无关”**：属实（`redaction.ts:193-200`）；但重叠时尾部可能漏掉，见发现 4。
5. **“页面 `where()`：对话聊天显示标题 + 你的话；后台用途显示用途、不显示你的话；不认识的用途照常显示出处处”**：基本属实；`source="chat"` + `threadId=null` 的边界不一致，见发现 2。
6. **“门槛用例、反向用例、页面用例都由 `check:prompt-catalog` 运行；默认清单改成空会失败”**：脚本确实包含三个测试文件（`package.json:46`）；默认清单为空时 `[I-78]` 记忆整理用例会失败。但第 4 轮新增的 `known` 测试不会因改动被回退而失败，见发现 3。
7. **“整理记忆后台请求开头 `[验证码#…]` 变回 1000，缓存失效一次；聊天只在系统提示末尾恰好是数字、或历史里贴过整段固定指令时变一次”**：整理记忆部分属实，`memoryCapturePrompt` 把 `MEMORY_CAPTURE.text` 原样放在最后一条消息开头（`production-memory-capture.ts:132-148`），其中确实有会被验证码规则误遮的“1000”。聊天部分我未找到会因本次改动变化的具体系统提示片段（`chat.ts` 里只有 legend 的“尾号1111”，验证码规则会因 `尾号` 跳过）；因此“聊天只在……时变一次”我未核实，不能确认也没有反例。

---

## 读代码证实的

- `MEMORY_CAPTURE.text` 是单个 text segment，长度 ≥24，进入 `TRUSTED_PROMPT_TEXTS`；`memoryCapturePrompt` 把它和 JSON 数据用 `\n` 拼接，固定指令在最后一条 user 消息开头（`production-memory-capture.ts:132-148`）。
- `ModelEgress` 默认使用 `TRUSTED_PROMPT_TEXTS`，`trusted: []` 会覆盖为空（`model-egress.ts:198`）。
- 正式跑换回失败会抛 `EgressRedactionError`，`redactedOrRefused` 会转成 `refuse()`（`redaction.ts:229`，`model-egress.ts:480-484`）。
- 空跑不传 `observe`/`table`，`known` 用副本，测试确认没有留下记录（`redaction.ts:221-226`，`trusted-text.unit.test.ts:89-102`）。
- `check:prompt-catalog` 确实包含新的 agent-service、unit、browser 测试；`check:steps` 合并后保留 `check:delivery-packet` 和 `check:check-runner`，且两个脚本都存在（`package.json:27,40-41`）。
- 页面的所有用途、部分翻译在 zh-CN/en/ja 里都有对应键。
- `trustedSpans` 的排序/贪心逻辑与发现 4 的描述一致。
- 新增 `TRUSTED_PROMPT_TEXTS` 不注册为 PromptEntry，`prompt-catalog` 测试用 `isEntry` 过滤，不会把它当成目录条目。

## 推测/未核实

- `source="chat"` + `threadId=null` 是否在真实生产路径出现（类型允许，但生产调用大多有 thread）。
- 真实目录清单里是否存在前后缀部分重叠的固定文字，从而触发发现 4。
- 发现 6 的性能影响有多大，没有量化，也没有运行基准。
- 作者“`npm run check` 全部通过”未运行验证。
- 作者“聊天只在系统提示末尾恰好是数字，或历史里贴过整段固定指令时变一次”的具体触发范围，未找到反例也未构造出实际发生变化的聊天请求。

---

## 侧重检查

- **错误路径**：正式跑换回失败会 `refuse()`，不会把带填充字符的请求发出去；空跑失败则退回整段检查。未发现可由普通输入稳定触发的“拒绝发送”路径。失败前 `known`/`table` 可能已被部分修改，若同一 `Exchange` 被重试，可能影响下一次；生产 Pi 设置 `maxRetries: 0`，风险低，未进一步核实。
- **不合规范/不可信输入**：包含全部 34 个非字符的输入会退回整段检查（规则文件已写）；`known` 里的值也能触发退回（规则文件未写，见发现 1）。短 `trusted` 片段可以关掉主人关键词（发现 5）。重叠可信区间可能漏掉尾部（发现 4）。
- **安全**：没有发现确定的新秘密泄漏路径。固定文字不作为关键词上下文是需求本身，代价是：如果将来目录里出现以“密码”“验证码”结尾的片段，外部内容紧跟其后可能不再被识别；我查了当前目录，没有以这些关键词结尾的 text segment，所以当前没有这个具体绕过。
- **资源耗尽**：未见硬性内存上限；发现 6 的扫描/双跑是潜在成本，未量化。
- **不可撤销操作**：本次改动没有新增删除、发布、支付等不可撤销操作。
- **规则/文档一致性**：发现 1（known 退回条件）、发现 7（排序口径）、`docs/kv-cache-guide.md:66` 的汇总没有写退回条件和 known 条件。`docs/incidents-and-gates.md:116` 的 I-78 描述与当前代码基本一致。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

会改变，但主要是**一次性**的遮盖结果变化，不是每轮都变：

- 整理记忆后台请求的固定指令在最后一条 user 消息开头，`MEMORY_CAPTURE.text` 是连续的目录片段。修复前其中“1000”可能被遮成 `[验证码#…]`，修复后变回“1000”。这确实改变了已经发过的背景请求前缀的字节，作者说 Andy 已同意；这是一次缓存失效，不是每轮变化。
- 聊天系统提示里，我查到与目录文字可能相关的只有 egress legend 里的“尾号1111”，验证码规则会因“尾号”跳过；我没有找到聊天系统提示会因本次改动必然变化的片段。历史里如果贴过整段目录文字，那部分遮盖结果会变一次；作者的说法与代码不矛盾。
- 改动没有把新的每轮变化值放进请求开头：`TRUSTED_PROMPT_TEXTS` 是构建期常量，按位置排序；填充字符只用于内部，最终被换回原文，不会发给模型；每轮变化的运行环境、时间等仍在最后一条消息。
- 但严格说，**跨发布版本不是只追加**：规则变化会让旧内容的遮盖字节变一次。规则 11 已写“遮法取决于这份清单，改提示词文字会让请求开头变一次”；这是本次改动有意的例外，不属于每轮追加。

结论：在同一构建内、同一前缀下，请求仍只在末尾追加，每轮会变的值仍在最后一条消息；这次改动本身会造成一次性的历史/背景前缀字节变化，需按“已同意的一次缓存失效”对待。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

在同一构建、同一前缀下不会：

- `TRUSTED_PROMPT_TEXTS` 去重后排序，是构建期固定值。
- `trustedSpans` 的匹配结果按起点升序、同起点取更长，最终区间与清单顺序无关。
- 填充字符从固定的 34 个候选中按“输入和 known 里没有”选择，确定；换回后原文不变，填充字符不会出现在发给模型的内容里。
- 没有时间、随机数、对象遍历顺序或不稳定集合参与输出。

但遮盖结果可以依赖**前面的内容**：`known` 由前面的消息累计，`known` 会影响填充字符选择，进而在极端情况下影响是否退回整段检查。这仍然符合规则 11“只取决于它自己和它前面的内容”，不是依赖后面的内容。发现 1 的问题是文档没有写这条依赖路径。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有：

- agent-service：`trusted-prompt-egress.unit.test.ts`，经 `createProductionModelEgress` 发整理记忆请求和目录每个条目，断言原样不变、没有拦截记录。
- sensitive-capture：`trusted-text.unit.test.ts`，覆盖固定文字紧挨数据、数据自带验证码、隔着固定文字的关键词仍生效、点名值在固定文字前后都遮、规则碰到固定文字时退回。
- control-center：`sensitive-interceptions.unit.test.ts` 的 `[I-78]` 页面用例。

反向用例中，`trusted: []` 时“1000”会被遮、固定文字最后一个字去掉时数据里的验证码会被遮、密码/私钥夹固定文字时退回整段检查、聊天记录仍显示“你的话”，这些在改动回退时应该会失败。**但第 4 轮新增的 `known` 排除用例是空转**（发现 3），把该改动删掉它也通过；另外没有覆盖“known 命中全部 34 个字符”的退回路径、重叠可信区间、`source=chat` + `threadId=null` 的页面路径。全量测试未运行。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐项核对：

- `trusted` 选项：`redactForEgress` 接受 `readonly string[]`；`ModelEgress` 用 `this.#options.trusted ?? TRUSTED_PROMPT_TEXTS`，空数组会正确覆盖默认值；生产 `createProductionModelEgress` 不传该选项，使用默认清单；其他 `redactForEgress` 调用方不传，得到 `[]`。类型兼容。问题是选项本身不校验 24 字下限（发现 5）。
- `TRUSTED_PROMPT_TEXTS`：消费方 `ModelEgress` 和测试，按字符串 `indexOf` 使用，不需要额外校验；未在目录清单里注册为 PromptEntry，不会破坏 `prompt-catalog` 的 manifest 测试。生产测试辅助 `packages/testing`、`memory-engine` 的 `new ModelEgress` 也会隐式使用默认清单，行为可能变化，未核实全量测试。
- `EgressRedactionError`：新增抛出点只在 `redactForEgress` 的正式换回失败；`ModelEgress` 的 `redactedOrRefused` 会捕获并 `refuse()`。其他调用方目前不传 `trusted`，不会走到新抛出点。
- `TRUSTED_TEXT_MINIMUM_LENGTH`：导出但除 `entry.ts` 外没有别的使用者，不影响现有消费者。
- `package.json` 的 `check:delivery-packet`、`check:check-runner`：脚本定义存在；`run-all-checks` 按 `npm run <name>` 解析，`run-all-checks.test.mjs` 断言这两个名字存在；合并后 `check:steps` 保留了两边内容。
- 页面使用的 `source`、`purpose`、`part`：`SensitiveInterceptionItem` 来自 gateway snapshot schema，枚举包含这些值；`MESSAGE_PURPOSES` 和三种语言的 i18n 键都存在；未知 purpose 走 `sensitive.purpose.other`。唯一不一致是 `source=chat` + `threadId=null` 的显示（发现 2）。
- I-78 文档引用的文件、测试、脚本都存在；`npm run check:prompt-catalog` 确实运行三个新测试文件。文档中“`findSensitiveValues` 返回 1000”表述略口语化，但底层函数确实不带清单、行为未变。

更好的方案：如果重做，建议不要用“全局字符串清单 + 填充字符 + 空跑/换回”的方式，而是让提示词组装层把固定片段标记为 trusted（例如返回带 `trusted` 范围的结构化消息），出口遮盖直接跳过这些范围。这样能一并消除重叠区间、填充字符选择、known 耦合、双跑开销和 24 字启发式；若保留当前方案，至少应预编译多模式匹配、合并重叠区间、校验 24 字下限、明确 known 退回条件并补反向测试。
