结论：本轮 f395787 的修复方向正确（只拿待确认记忆自己的文字做相关度判断），我核对的两处关键代码与作者说法一致；但相关度词表仍有可被常见二字组“误放”的缺口，且反向用例没有覆盖这一类。

## 读代码证实的发现

### 1. 中 — 相关度闸门可被常见二字组绕过（误放，不是已接受的“误拦”）

- 文件:行：`apps/agent-service/src/production-memory-capture.ts:135-164`、`apps/agent-service/src/production-memory-capture.ts:345-347`
- 问题：`relevanceTokens` 只剔除一小批泛化词，然后对任意连续的汉字串生成所有二字组；只要命中一个二字组就算“相关”。像「一下」「这个」「可以」「什么」「时候」「明天」「顺便」这类高频二字组不在剔除列表里，于是“无关但含常见二字组”的原话也能让待确认记忆转正。这与作者已接受的“同义词/混排导致误拦”方向相反，是误放。
- 证据：
  ```ts
  const GENERIC_TERMS =
    /主人|用户|喜欢|偏好|喜爱|好像|可能|经常|一直|比较|觉得|今天|现在|[的了是我你他她它在有和与就也都还很不最想要又]/gu;
  ...
  for (let index = 0; index + 1 < chars.length; index += 1) {
    tokens.add(`${chars[index]}${chars[index + 1]}`);
  }
  ```
  ```ts
  (confirmsTentative &&
    (!evidenceVerified ||
      !quoteRelatesToMemory(quote, [input.tentativeTexts?.get(existing) ?? ""])));
  ```
  具体例子（按上述正则推演）：待确认记忆「主人想先试一下再决定」，主人消息「帮我顺便取一下快递」。两者都含「一下」；消息长度 9 字，满足 `MINIMUM_QUOTE_CHARACTERS = 8`；`quoteFromOwnerMessage` 通过，`quoteRelatesToMemory` 也通过，于是无关消息可以把这条待确认记忆转正。
- 建议：把常见功能词二字组加入停用集合（至少「一下/这个/那个/什么/没有/可以/知道/时候/明天/昨天/今天/因为/所以/但是/还是/这样/那样/以后/之前/已经/一定/顺便/帮我」等），或要求命中的 token 不是高频二字组；并补一条“无关但共享常见二字组”的反向用例。转正会写入正式记忆并进入主人档案块，属于难撤回的后果，值得收紧。

### 2. 低 — 反向测试覆盖不全

- 文件:行：`apps/agent-service/test/production-memory-evidence.unit.test.ts:117-133`、`apps/agent-service/test/production-memory-evidence.unit.test.ts:163-168`
- 问题：`update`/`merge` 的拒绝用例只测了空 `quote`；没有测“原话已核对但内容无关”的 `update`/`merge`（虽然与 `unchanged` 共用同一 `confirmsTentative` 分支）。第 163-168 行的“not by generic ones”只测了「喜欢」「我」，没有测「一下」这类常见二字组，因此发现 1 不会被现有测试拦住。
- 证据：
  ```ts
  it.each(["update", "merge"])(
    "rejects %s without a verified quote (also required for any memory)",
    (decision) => {
      const parsed = parse(decision, "", "memory-tentative");
  ...
  expect(quoteRelatesToMemory("我喜欢开会", ["主人喜欢喝咖啡"])).toBe(false);
  ```
- 建议：为 `update`/`merge` 各加一条“已在主人消息中逐字核对、但与被转正记忆无关”的反向用例；并加“共享常见二字组”的反向用例。

## 推测 / 未核实

- 低（推测，且不在本轮改动行内）：`unchanged` 之外的 `create` 路径不受相关度闸门约束。`parseMemoryCandidates` 的通用原话校验只要求 `quote` 在主人消息中逐字存在（`production-memory-capture.ts:340-344`），而置信度上限只由模型给的 `inference` 决定（`production-memory-capture.ts:417-422`）。模型若输出 `decision:"create"`、`inference:false`、高分并给一段无关的原话，仍可把一条“猜测”直接写成正式记忆。这是既有设计，不是 f395787 引入；仅提示“转正必须靠主人原话+相关”这一目标仍有旁路。
- 未核实：`packages/prompt-catalog/prompt-manifest.json` 里新增的 `mail.judgment.tentative-note` sha256 是否与 `MAIL_JUDGMENT_TENTATIVE_NOTE.text` 匹配；我没有运行构建/校验命令。

## 侧重检查

- 错误路径：`tentativeTexts` 缺失时 `get` 回退为空串，相关度判为 false，走拒绝（安全方向）；读取记忆正文失败（`#readText` 返回 undefined）时该记忆不会进入 `existing`，其 id 也不在 `existingIds`，模型无法引用，因此不会被无门禁转正。已核对 `production-memory-capture.ts:753-760` 与 `:827-830`。
- 不可信输入：`existingMemoryId` 必须在 `existingIds` 中；`quote` 必须逐字出现在主人本次消息；相关度只用 `#readText` 读出的存储正文；候选正文长度上限 500、引用上限 300。本轮没有新增可注入点。
- 资源耗尽：相关度只对长度受限的字符串做线性双字组生成，正则无回溯风险；`quoteRelatesToMemory` 只在 `evidenceVerified` 为真时执行，此时引用已是主人消息（≤6000 字）的子串。
- 不可撤销操作：相关度失败在解析阶段就进入 `rejectedCandidates`，不落正式记忆；反之误放会直接转正、进入主人档案块，所以发现 1 的后果不可轻视。
- 规则/文档一致性：ADR 0179 第 6 条“只用那条待确认记忆自己的文字、不用模型这次输出的候选文字”与 `production-memory-capture.ts:347` 一致；“update、merge 同样”也与 `:336-339` 一致。文档说“去掉『主人』『喜欢』『的』这类到处都有的词”，代码的 `GENERIC_TERMS` 确实做了，但文档没有承诺挡住「一下」这类二字组，实际实现比声称的防护弱。

## 必答问题

1. **是否改变模型已经见过的请求开头？不会。** 本轮 f395787 只改了 `parseMemoryCandidates` 的相关度入参（`:347`）和单测；`memoryCapturePrompt`（`:166-191`）没动，系统提示、工具定义、历史消息、遮盖结果都没有变化。整个 PR 里新增的 `MAIL_JUDGMENT_TENTATIVE_NOTE`（`proactive-mail-check-service.ts:269-270`）和记忆列表重排都只影响后台调用；没有待确认记忆时邮件判断提示逐字节不变。发给对话模型的内容仍然只在末尾追加，每轮会变的值不在系统提示里。
2. **同一段文字会不会在不同请求里变成不同字节？不会。** `relevanceTokens` 只依赖 NFKC、小写和双字/单词集合，无时间、随机数或前后文；记忆正文来自存储内容。`confirmedFirstByRecency` 排序以 `updatedAt` 为主，`listActive` 有 `ORDER BY id`（`packages/persistence-sqlite/src/sqlite-memory-operations.ts:928-937`）兜底，同分时顺序确定。
3. **有没有自动检查，反向用例真会失败？有。** `production-memory-evidence.unit.test.ts:135-161` 的 REVERSE 用例把候选正文设成整句原话，若删掉 `!quoteRelatesToMemory(...)` 或退回使用候选文字，该候选会被接受，`expect(coffee.candidates).toEqual([])` 必然失败（按代码推演，未运行）。集成用例 `test/integration/production-memory-capture.test.ts:711-760` 覆盖 `unchanged` 的空引用、无关引用、相关引用三种情况。缺口见发现 2。
4. **改动产生/修改的值，使用方能否接受？本轮没有产生新的标识、字段、配置键或序列化格式。** `tentativeTexts` 的键来自 `existingIds`，值来自存储正文（`:828-830`）；拒绝后只经 `unverifiedEvidence`/`rejectedCandidates` 走 `evidence_unverified`，账本只写 `category`、`confidencePermille`、`inferred`（`packages/application/src/services/automatic-memory-service.ts:577-579`），不写 `evidenceVerified`，所以不会出现“原因码说未核实、属性说已核实”的数据矛盾。整个 PR 的 `tentativeMemoryIds` 能通过 SQLite 的 `ids` 校验（非空字符串、≤256、去重，`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:527-539`），生产记忆 id 形如 `memory:<generation>:<ordinal>` 可以接受；`kept_tentative` 长度也在 `reasonCode` 的 1-64 字符限制内（`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:47`）。未见两端校验不一致。
