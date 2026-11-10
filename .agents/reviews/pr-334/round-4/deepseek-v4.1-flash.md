## 结论

这次增量本身方向正确：占位白名单确实只覆盖 `maskSensitiveText` 的五种输出，取段逻辑对省略号、中间段的处理与测试一致，`isSafeToIndex("[hunter2x]")` 现在会返回 false。但我发现一个仍然存在的秘密落盘缺口（与作者“普通方括号照常去值和兜底”的说法不完全相符），以及一处 ADR 声称有覆盖、实际没有覆盖的测试空洞。

---

## 读代码证实的问题

### 1. 中：ASCII 方括号里的纯字母/短密码仍会进明文词表

- 文件:行：`packages/sensitive-capture/src/secret-like.ts:17`、`packages/sensitive-capture/src/redaction.ts:80`、`packages/sensitive-capture/test/secret-like.unit.test.ts:66`
- 问题：作者说“普通方括号照常去值和兜底”，但“去值”依赖 `findSensitiveValues` 先认出这个值；而密码规则对以 `[` 开头的值直接放弃识别。`[hunter2x]` 能过测试，只是因为 `hunter2x` 本身满足“像密钥”（8 位以上且含字母数字）。纯字母的 `[sunflower]`、少于 8 位的 `[hunter2]` 既不会被 `findSensitiveValues` 认出，也不会被 `TOKEN_RUN` 兜住，会原样进入明文 FTS 词表。
- 证据：
  - `redaction.ts:80`：`...\\s*)(?!\\[)(${PASSWORD_VALUE}+)` —— 值以 `[` 开头时不匹配。
  - `secret-like.ts:36-42` 只把 `findSensitiveValues(text)` 的结果展开成待删值；没有别的来源。
  - `secret-like.ts:49`：`...(run) => (looksLikeSecretToken(run) ? " " : run)`；`looksLikeSecretToken` 对 `sunflower`（纯字母）返回 false。
  - 测试 `secret-like.unit.test.ts:66` 用的是 `x9Kq2mVb7Lp4Wz`，属于“像密钥”的串，绕过了这个缺口。
- 建议：在 `maskForIndex` 处理非占位片段时，增加一条方括号感知的兜底：先只对非占位片段去掉 ASCII `[`/`]`，再跑一次值提取（或把 `(?!\[)` 收紧为只跳过五种真实占位），把括号内的候选值也加入待删集合；并补用例 `maskForIndex("密码是[sunflower]")` 不含 `sunflower`、`isSafeToIndex("密码是[sunflower]") === false`。注意若直接改 `redaction.ts` 会影响出口遮盖的字节，需另行评估。

### 2. 低：ADR 声称“中文后文不被误删”有用例，实际没有能失败的用例

- 文件:行：`packages/sensitive-capture/test/secret-like.unit.test.ts:55-57`、`docs/adr/0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md:91`（以及第 55 行的“值里的中文后文不取”）
- 问题：`middle` 用例里密码值在中文逗号 `，` 处就截断了（`PASSWORD_VALUE = [^\s,，;；]`），所以 `客人来了` 根本不在被识别的值里；即便把实现改回“把值里的中文后段也当成待删值”，这条断言仍会通过。也就是说，“中文后文保留”这一条没有反向用例保护。
- 证据：
  - `redaction.ts:77`：`const PASSWORD_VALUE = "[^\\s,，;；]";`
  - 测试 `:55-57`：`"密码是aaa。sunflower。bbb，客人来了..."`，值只到 `bbb`。
  - ADR `:91`：声称“`contest` 和中文后文不被误删也各有用例”。
- 建议：加一条中文确实落在被识别值里的用例，例如 `maskForIndex("密码是sunflower。客人来了 后来客人来了")`，断言结果仍包含后一个 `客人来了`；去掉“只取 ASCII 片段”后该用例会失败。

### 3. 低：把所有 ASCII 片段都当待删值，会误删正常英文词（新行为）

- 文件:行：`packages/sensitive-capture/src/secret-like.ts:18`、`:22-27`
- 问题：旧逻辑只取“首段、末段”，新逻辑取值的每一段 ASCII 串。值中间夹着的普通英文词会被加入全局待删集合，删掉正文里所有同名单词，而不只是秘密本身。
- 证据：
  - `secret-like.ts:18`：`const ASCII_PIECE = /[A-Za-z0-9_\-+/@#$%^&*~!?.]+/gu;`
  - `:23-26`：`const pieces = (value.match(ASCII_PIECE) ?? []).map(...); return [value, ...pieces];`
  - 例：`密码是abc:hello:xyz，他说 hello 世界` 会识别出值 `abc:hello:xyz`，取段得到 `hello`，随后正文里与秘密无关的 `hello` 也会被从词表删掉；旧实现只取 `abc`/`xyz`（都短于 4）不会删 `hello`。
  - 类似地，私钥块会被拆出 `PRIVATE`、`BEGIN` 等普通词并加入待删集合。
- 建议：如果这是有意取舍，在 ADR 中写明“值中间的英文词也会被全局删除”，并加一条用例把这个行为固定下来；若不可接受，可限制中间段只在“整值不含中英文空格且片段与秘密相邻”时加入，或只保留能与秘密其余片段共同出现过的片段。

### 4. 低：错误路径把锁获取失败一律报成“服务没停”

- 文件:行：`apps/admin-cli/src/memory-command.ts:48-50`
- 问题：`acquireStateRootLock(...).catch(() => throw TARGET_NOT_STOPPED)` 会吞掉权限不足、状态根不存在、锁文件损坏等真实错误，运维会得到误导性的“目标未停止”。
- 证据：`const lock = await acquireStateRootLock(configuration.stateRoot).catch(() => { throw new Error(MEMORY_COMMAND_ERROR_CODES.TARGET_NOT_STOPPED); });`
- 建议：只把明确的“锁被占用”错误映射为 `TARGET_NOT_STOPPED`，其他错误保留原始错误码/原因；至少把原因写进诊断输出。

### 5. 提示：ADR 与代码的细微不一致

- 文件:行：`docs/adr/0196-...md:55`、`packages/sensitive-capture/src/secret-like.ts:40`
- 问题：ADR 写“每个值除了原样，还取出……4 个字符以上”，读起来像原值无条件保留；代码里原值也要过 `value.length >= SHORTEST_REMEMBERED_VALUE`（4）。短于 4 的值连原样也不会被加入。文档建议澄清为“原值和各片段都只保留 4 个字符以上的”。
- 证据：`secret-like.ts:40`：`.filter((value) => value.length >= SHORTEST_REMEMBERED_VALUE)`。

---

## 推测 / 未运行验证

- 上述第 1、3 条的行为结论由代码推导得出，未实际运行 vitest；建议作者用给定输入跑一次确认。
- `memory reindex` 的“先备份”只体现在诊断里的 `backupRequired: true`，代码没有校验最近是否真的做过备份。索引本身可重建、恢复的记忆可再归档，所以我认为可接受，但这是一次会改写 `memory_records` 和 `memory_consolidation_changes` 的批量操作，建议在上线 runbook 里保留人工确认步骤（ADR 已写了步骤）。
- 未核实：`acquireStateRootLock` 内部对“占用”和“其他失败”是否会抛出可区分的错误；如果可区分，第 4 条修改成本很低。

---

## 侧重检查

- 不可信输入：模型返回的实体经 NFKC+trim、长度 ≤64、`isSafeToIndex` 过滤（`production-memory-capture.ts:366-374`），最多 `MAXIMUM_ENTITIES` 条；记忆正文进入 `maskForIndex`/`indexableTerms`。正则均为线性、无嵌套量词，未见 ReDoS；`bareForms` 生成量与原值长度同阶，未见资源放大。
- 错误路径：`maskSensitiveText`/`findSensitiveValues` 在不传 trusted 时不会走 `EgressRedactionError` 抛错分支；`memory reindex` 的参数校验、确认词校验、事务回滚都正常。发现锁错误映射问题（第 4 条）。
- 安全/落盘：词表是明文 FTS；占位白名单本身不会被用来夹带任意秘密；发现 ASCII 方括号纯字母密码仍会落盘（第 1 条）。
- 不可撤销操作：`restoreIdleArchivesAndClearMemoryIndex` 在一个事务里更新记忆、标记整理变更为已撤销、清空该 Agent 的索引；第二次运行恢复 0 条（`revision = after_revision` 已不成立）；合并归档因 `action='archive'` 被排除（`sqlite-memory-maintenance.ts:19-24`、`:55-78`），与 ADR 第 63 条一致。
- 规则/文档一致性：`PLACEHOLDER` 五种的覆盖面已核对；ADR“中文后文有用例”与实际测试不一致（第 2 条）；“每个值原样保留”表述不精确（第 5 条）。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个改动只影响 `maskForIndex`/`isSafeToIndex` 的结果，用于 FTS 词表（`segmentation.ts:114-116`、`hybrid-memory-provider.ts`）和捕获时的实体过滤（`production-memory-capture.ts:373`）；没有触碰系统提示、工具定义、历史消息或出口遮盖（`secret-like.ts` 单向 import `redaction.ts`，反向没有 import）。因此不存在“改历史”的路径，每个请求仍然只在末尾追加；本轮新增的会变值只有 `memory reindex` CLI 自己输出的 `timestamp`（`writeServiceDiagnostic`），不进模型请求。请求组装本身本轮未逐行重读（未核实），但从 diff 范围看没有改动。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。`findSensitiveValues`、`maskSensitiveText`、`maskForIndex` 都是只依赖输入文本的纯函数，不含时间、随机数、上下文或无序集合；排序只按长度，等长项由确定性的插入顺序决定，JS 排序稳定。CLI 的 `now` 只用于数据库字段，不参与词表内容。唯一外部变量是提示词/遮盖规则版本，这属于部署期变化，不是同一请求内的字节漂移。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有：`secret-like.unit.test.ts`、`hybrid-memory-provider.unit.test.ts`、`memory-consolidation.test.ts`、`memory-episodes.test.ts`、`memory-reindex-cli.unit.test.ts`。按代码推导：
   - 去掉取段（`middle` 用例）、去掉整词匹配（`contest` 用例）、去掉整串检查（`x9Kq2...`）、把占位放宽成任意方括号（`[x9Kq...]` 与含重复值的方括号用例）、去掉遮盖（`sunflower` 用例）都会失败；
   - **但**“中文后文不被误删”没有有效反向用例（第 2 条）；
   - “普通方括号里的秘密”只覆盖了“像密钥”的串，没有覆盖纯字母/短密码（第 1 条）。未实际运行测试，以上为代码推导。

4. **改动产生/修改的每个值，使用方都能接受吗？**
   - 五种占位：逐一核对 `redactUntrusted` 的 `mask` 调用，标签只有 `密钥`、`密码`、`证件号`、`银行卡 尾号\d{4}`、`验证码`；`maskSensitiveText` 不传 `tag`，所以不会出现 `#...` 变体。`PLACEHOLDER` 正则恰好覆盖这五种，使用方只有 `split`，两端一致。
   - `ASCII_PIECE`/`PIECE_EDGE_PUNCTUATION`：模块私有，只供 `bareForms` 使用；生成值经 `wholeWordPattern` 转义后安全，空串被长度过滤。
   - 实体值：`isSafeToIndex` 在捕获端过滤，存储端只当字符串写入 `attributes.entities`，长度上限 64、数量上限 `MAXIMUM_ENTITIES`，两端能接受；但纯字母括号密码的过滤不完整（第 1 条）。
   - CLI：`REINDEX_MEMORY_<agentId>` 在同一函数内产生并校验；`--operator` 有独立格式校验；诊断字段是字符串/数字，`writeServiceDiagnostic` 接受 `Record<string, string|number|boolean|readonly string[]>`，没有额外 schema 拒绝。
   - 需要留意（PR 层面、非本轮新增）：`sqlite-memory-operations.ts:148` 的 `MODEL_VISIBLE_CLASSIFICATIONS` 与 `application` 侧 `isModelVisible` 的 `MODEL_VISIBLE` 是两处手写清单，目前都包含 `public/private/sensitive`，一致；这正是 I-73 那类“两处校验必须同步”的风险点，建议后续让持久层复用同一个常量或在测试里比对两者。
