## 读代码证实的问题

### 1. 中：固定文字里的“点名值”不会被遮，和规则文件、I-78 门槛说明相反

- 文件:行：`packages/sensitive-capture/src/redaction.ts:204-217`、`packages/sensitive-capture/test/trusted-text.unit.test.ts:20-31`、`.claude/rules/prompt-prefix.md:54`
- 问题：固定文字先被换成 `\uFFFF` 再跑 `redactUntrusted`，而“点名值”的 known 替换也是在这次运行里做的，所以 known 永远看不到固定文字里的那个值。作者自己新增的测试还把“固定文字里的点名值不遮”写成了期望行为：
  ```ts
  const fixed = "示例里的 482910 只是格式说明，不是任何人的真实号码。";
  const input = `${fixed}\n482910 是验证码`;
  expect(result.text).toBe(`${fixed}\n[验证码#abcdefgh] 是验证码`);
  ```
  但规则写的是“点名的那条消息里，这个值每次单独出现……都遮掉，包括排在主人的话前面的运行环境说明”，I-78 行也写着 trusted-text 覆盖“点名的值前后都遮”。这里前后都遮只覆盖了固定文字之外的数据，固定文字内部是例外。
- 影响：如果某个提示词目录固定文字里恰好有主人点名的密码/验证码，固定文字里的那一份会留在明文里。由于同一段固定文字本来就会发给模型，真正新增的泄露有限，但这是明确的文档、测试和行为三方不一致，且违反作者自己列出的约束。
- 建议：明确优先级：若第 11 条例外优先，就不能在 known 替换前把固定文字整段填掉；可在恢复后对与 known 值重叠的 trusted 区间再做一次 known 替换，或不要把包含 known 值的片段当作 trusted。若决定固定文字永远不改，则要改规则、kv-cache-guide 和 I-78 的措辞，并把这个测试写成“固定文字例外”而不是“前后都遮”。

### 2. 中-低：输入里带 `\uFFFF` 会让整段内存整理提示放弃信任，I-78 会复现

- 文件:行：`packages/sensitive-capture/src/redaction.ts:178`、`apps/agent-service/src/production-memory-capture.ts:132-148`
- 问题：`trustedSpans` 一旦发现输入含 `TRUSTED_FILLER` 就直接返回空清单：
  ```ts
  if (trusted.length === 0 || input.includes(TRUSTED_FILLER)) return [];
  ```
  而内存整理 prompt 是“固定指令 + JSON 数据”拼成的同一个字符串：
  ```ts
  return [MEMORY_CAPTURE.text, JSON.stringify({ ..., ownerMessage: message.slice(...) })].join("\n");
  ```
  因此 owner 消息里只要有一个 `\uFFFF`，整段固定指令就按外来内容检查，“……密码和验证码用 restricted。”会把下一行的“1000”重新遮成 `[验证码#…]`，并重新产生“验证码 · 你的话”拦截记录。
- 影响：这是失败的路径，不是泄露；但它说明修复对不合规输入不稳健，且同一段固定文字会因为输入里一个字符而变成不同字节。前提是消息链路允许 `\uFFFF` 通过；前端/网关是否过滤未核实。
- 建议：不要用可能出现在输入里的字符当哨兵；更稳的是由提示词渲染层把 trusted 区间（偏移量）直接传给出口遮盖，而不是事后按内容搜索；至少要先把 owner 数据里的 `\uFFFF` 转义或剥掉，再启用清单。补一条经 `memoryCapturePrompt("\uFFFF…")` 的门槛用例。

### 3. 低：trusted 恢复后仍可能被 `assertMachineSecretFree` 拒绝

- 文件:行：`packages/application/src/services/model-egress.ts:217-221`
- 问题：`redactForEgress` 返回前会把固定文字原样恢复，随后 `assertMachineSecretFree(result.text)` 再扫描一次最终文本。若某条目录固定文字里出现机器秘密形状的示例（如 `password=...`、`sk-...`、`-----BEGIN ... PRIVATE KEY-----`），带清单时它不会被遮盖，恢复后会被这个检查拦下，整个模型请求变成 `refuse("sensitive material remained after redaction")`。
- 现状：我按机器秘密规则查了当前目录文字，没有真实命中（`sk-` 的命中是 `task-status` 之类 id 的误匹配），所以当前不会触发；这是 fail-closed，不是泄露。但以后往提示词目录里加这种示例时，表现是请求被拒，而不是原样发送。
- 建议：在 I-78 门槛里明确“固定文字不得包含机器秘密形状”，或对 trusted 区间做有意识的豁免/白名单，并保留现在的拒绝作为兜底。

### 4. 低：新增测试没有真正验证“同起点取更长”

- 文件:行：`packages/sensitive-capture/test/trusted-text.unit.test.ts:44-51`
- 问题：测试用 `long = FIXED + "以上。"`，而“以上。”不含敏感内容。即使实现错误地选了较短的 `FIXED`，剩下的“以上。”也会原样保留，最终字符串完全相同，测试仍通过。所以“同起点取更长”和“清单顺序无关”这两个性质没有被有效覆盖。
- 建议：把后缀换成会被遮的内容，例如 `long = FIXED + "验证码 482910"`，让选中长/短两种实现产生不同输出；再分别用 `[FIXED, long]` 和 `[long, FIXED]` 断言。

### 5. 低：真实运行换回失败转 `refuse()` 的路径没有测试

- 文件:行：`packages/application/src/services/model-egress.ts:476-486`
- 问题：`redactedOrRefused` 把 `EgressRedactionError` 转成 `refuse("trusted text could not be restored")`，但现有测试要么走 rehearsal 回退，要么在没有 trusted 时运行，没有一条能迫使“rehearsal 通过、真实运行换回失败”。这条错误路径目前只靠代码审查。
- 建议：若难以从公开 API 触发，可把 restore 做成可注入的内部函数或导出测试钩子，至少断言 refusal 原因和“请求未发出”。

### 6. 低/潜在：页面只按 `source === "background"` 隐藏“你的话”

- 文件:行：`apps/control-center/src/components/sensitive-interceptions.tsx:108-111`
- 问题：现在只隐藏 `background` 的 `owner_message`。当前所有会记录 `owner_message` 的模型路径只有 `chat` 和 `background`（mail 用 part `mail`，embedding 用 `embedding_input`，memory audit 用 `memory_source`/`memory_candidate`），所以现状正确。但 `SENSITIVE_INTERCEPTION_SOURCES` 还有 `mail`、`tool_result`、`memory_capture`；将来若有后台模型调用用这些 source 且 part 仍是 `owner_message`，页面会重新显示“你的话”。
- 建议：如果语义是“所有非 chat 调用都不是主人当面说的话”，用 `item.source !== "chat"` 或集中到一个 helper，而不是只判断 `background`。

### 7. 信息：作者说法 7 关于聊天系统提示的部分没有目录证据

- 文件:行：`packages/prompt-catalog/src/memory.ts:17,21`、`packages/prompt-catalog/src/chat.ts:255,267`、`packages/prompt-catalog/src/mail.ts:26`
- 问题：我按目录文字查了 4 到 8 位数字，只有 `MEMORY_CAPTURE` 的 `1000`、`CHAT_EGRESS_LEGEND` 的 `1111`（前有“尾号”，规则明确跳过）和 `MAIL_JUDGMENT` 的 `8601`（离“验证码”超过 40 字符）。所以当前真正会因这份清单改变红字结果的固定文字只有 `MEMORY_CAPTURE.text`；“聊天系统提示末尾恰好是数字”在当前目录里没有找到依据。
- 说明：这不影响内存整理的主要修复，但作者对影响面的描述偏宽；如果是动态拼进系统提示的内容造成，需要另找证据，我没有核实到。

## 推测的问题

- **资源消耗（未量化）**：`trustedSpans` 对每个出口字符串都遍历全部 ≥24 字符的目录文字（当前约一百多条，很多是长提示词），并收集所有出现位置；没有针对出现次数或输入长度的上限。大工具结果/网页内容可能带来可观的 CPU 和临时数组开销。我没有跑基准，标为推测。
- **内容型信任的绕过面（推测/设计取舍）**：任何外部内容只要和目录文字完全一致就会被当成 trusted。用户或第三方内容若知道这些文字，可把它们插在关键词和数字之间，使固定文字里的关键词不再计数；由于替换保持长度，普通窗口距离不变，实际能多绕过的空间有限。是否需要防这一层取决于威胁模型。
- **完整生产链路未覆盖**：门槛只经 `createProductionModelEgress` 直接构造请求，没有经 `PiModelTransport` + `backgroundModelContext` 走一遍。我读了 `backgroundModelContext`，固定文字确实作为单条 user content 原样放入，理论上能匹配；但没有对应测试，标为未覆盖。
- **历史缓存影响范围**：内存整理后台请求的固定前缀会变一次；聊天历史若贴入整段目录文字也会变一次。Andy 的同意只在文档里记录，我无法从代码核实授权本身。

## 侧重检查

- **错误路径**：rehearsal 失败会整段回退到无清单检查（`redaction.ts:217`），真实换回失败会抛 `EgressRedactionError` 并由 `model-egress.ts` 转成拒绝（`redactedOrRefused`）。回退路径有测试；真实失败路径没有。
- **不合规/不可信输入**：含 `\uFFFF` 的输入会禁用清单（问题 2）；含机器秘密形状的固定文字会在恢复后被拒绝（问题 3）；外部内容等于目录文字会被信任（推测）。
- **安全**：密码/私钥规则能吞掉填充字符时整段回退，测试覆盖了“密码：+固定文字”和“私钥块夹固定文字”；带 `\uFFFF` 的真实密码/私钥也能遮（测试第 75-82 行）。没有发现填充字符被规则吞掉后仍被当成已恢复的路径。
- **资源耗尽**：`trustedSpans` 的双重扫描和 `found` 数组没有上限，属于潜在成本；未实测。
- **不可撤销操作**：本次改动只改出口遮盖和页面显示，不改数据库、不迁移数据；页面“清除拦截记录”的旧逻辑未动。
- **规则 / 文档 / 代码一致**：`prompt-prefix.md` 第 11 条和 `kv-cache-guide.md` 第 11 条已写入“固定文字清单”依赖；但“点名值每次单独出现都遮”与 trusted 内部例外冲突（问题 1）。作者已撤回的“说法 2”我核对过：`machine-secrets.ts` 的私钥 `[\s\S]*?` 和 `PASSWORD_ASSIGNMENT` 值类确实已恢复基准版本。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？发给模型的内容是否仍然只在末尾追加，每轮会变的值是否都在最后一条消息里？

**会改变，而且不是严格意义上的“只追加”。** 具体是：

- 内存整理后台请求的固定指令里，原来被遮成 `[验证码#…]` 的“1000”现在会恢复成原文；这改变了后台请求开头已有的字节，代价是一次缓存失效。作者说 Andy 已同意，我无法从代码核实，但文档 `docs/kv-cache-guide.md:66` 和 I-78 行有记录。
- 任何历史消息如果包含整段目录固定文字，也会从“按外来内容检查”变成“原样保留”，字节会变一次。
- 这份清单在**一个构建内固定**（`packages/prompt-catalog/src/trusted.ts:10-14`），不是每轮变化；时间、记忆、运行环境等每轮变化的值仍在 slot/最后一条用户消息里。没有把新的每轮变化值塞进系统提示或工具定义。
- 因此结论是：不是“每轮只在末尾追加”被破坏，而是“历史里已发过的固定文字字节”会因这次发布变一次；作者的说法 7 对内存整理部分是准确的，对“聊天系统提示末尾恰好是数字”我没有找到目录证据。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

在**同一构建、同一前置内容**下，结果是确定的：

- trusted 清单由 `Set` 去重后按“长度降序、字典序”排序（`entry.ts:71-75`），匹配按起点排序、同起点取更长、贪心不重叠（`redaction.ts:189-196`），不依赖 `Object.values` 顺序或数据库顺序。
- 没有时间、随机数、无序集合进入红字结果；每个请求的 `known` 仍只依赖它和它前面的消息（现有第 11 条例外）。

但有三点依赖需要说清：

1. 结果依赖**当前构建的目录清单**：换提示词文字会让旧对话里冻结的旧固定文字不再被信任，文档已写明。
2. 结果依赖**这条消息自身的内容**：同一段文字在 trusted 区间内和区间外，遮法不同；包含 `\uFFFF` 时整段失去信任；有规则碰到填充字符时整段回退。这些都在同一条消息内，符合“只取决于它自己和前面的内容”，但意味着“同样的字面文本”在不同上下文里可以遮成不同字节。
3. 问题 1 的“点名值在固定文字里不遮、在外部数据里遮”就是这种上下文差异的典型；它是确定的，但和规则承诺不一致。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有门槛，且我核对了命令和项目配置：

- `package.json:44` 的 `check:prompt-catalog` 运行 `apps/agent-service/test/trusted-prompt-egress.unit.test.ts`、`packages/sensitive-capture/test/trusted-text.unit.test.ts`、`apps/control-center/test/sensitive-interceptions.unit.test.ts`，并继续跑原来的 pi-compat 检查。
- `vitest.workspace.ts` / `ci/policy.json` 里 `unit` 包含 `packages/**/*.unit.test.ts` 和 `apps/**/*.unit.test.ts`，`browser` 包含 `apps/control-center/**/*.unit.test.ts`，`node-services` 包含 `apps/agent-service/**/*.unit.test.ts`，所以三个文件确实会被执行。
- 反向用例按代码推断会失败：默认清单改为空时，`[I-78] sends the memory capture instructions unchanged` 会因为“1000”被遮而失败；去掉回退时，`falls back...` 和“私钥包住固定文字”用例会抛错；rehearsal 若把 `observe`/`table` 传进去，`leaves no record...` 会失败；页面用例在旧 `where()` 下会显示“其他 · 你的话”而失败。
- 但我也发现了覆盖缺口：问题 4（最长匹配没有真正被区分）、问题 5（真实换回失败转拒绝未测）、问题 2（owner 消息含 `\uFFFF` 的内存整理场景未测）、以及没有经完整 `PiModelTransport` 的背景路径测试。

我没有运行测试（本次只允许 git diff/log/show/blame/status 和读取工具），以上是读代码推断。

### 4. 每个产生或修改的值，使用它的地方都能接受吗？

我逐个核对了本次改动引入的值：

- **`trusted` 选项**：产生于 `ModelEgressOptions`（`model-egress.ts:47`），在 `Exchange` 里以 `this.#options.trusted ?? TRUSTED_PROMPT_TEXTS` 传给 `redactForEgress`（`model-egress.ts:198`）；`redactForEgress` 只在 `trustedSpans`/填充/回退逻辑里使用，其他调用点不传它，行为保持原样。
- **`TRUSTED_PROMPT_TEXTS`**：产生于 `trustedPromptTexts`（`entry.ts:61-75`），从 `background/chat/mail/memory/review/runtime/tools` 的全部导出对象里取 `segments` 的 text 片段；消费点只有 `model-egress.ts:198` 和测试；`prompt-catalog` 的 manifest 测试按 `id` 过滤，新增的数组/函数/常量不会被误当成 prompt 条目。
- **`EgressRedactionError`**：产生于 `redaction.ts:220`；消费于 `model-egress.ts:476-486`，转成 `ModelEgressRefusedError`。类型从包的根导出，`sensitive-capture/src/index.ts` 已导出。
- **页面 `source`**：产生端是 `SqliteSensitiveInterceptionOperations` 的 `SELECT ... source ...`（`sqlite-sensitive-interception-operations.ts:23-25`），迁移 0078 的 schema 有 `source` 列和 CHECK；`production-sensitive-interceptions-control.ts:63-74` 原样映射到 snapshot；网关合约 `contracts-v2.ts:673-680` 有 `source` 枚举；页面 `sensitive-interceptions.tsx:109` 消费。测试 fixture 也带 `source`。这条链路两端都能接受。
- **页面新的显示组合**：只用了旧的 message id（`sensitive.purpose.other`、`sensitive.part.*`、`sensitive.thread*`、`sensitive.background`），没有新增 i18n key；`source` 的取值都在枚举内。
- **未改数据/序列化格式**：这次没有改存储字段、迁移或请求体结构；`trusted` 和 `TRUSTED_PROMPT_TEXTS` 只存在于进程内。
- **潜在不接受点**：页面判断只看 `source === "background"`（问题 6）；`assertMachineSecretFree` 对 trusted 恢复文本的再检查（问题 3）；以及 `findSensitiveValues` 仍不带 trusted，这一点作者已在 I-78 行明确说明，测试也与之一致。
