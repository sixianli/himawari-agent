## 侧重检查

查过并对照代码的路径与结论：

- **不可信输入（复核记录是模型生成的文本）能否借此藏真密钥**：新块是 `condition = "AND"` + `targetRules = ["generic-api-key"]` + `regexTarget = "secret"` + 值正则 `^...$`（`ci/rules/gitleaks.toml:134-140`），值被锁死为那个假令牌。路径虽用 `(?:^|/)` 做后缀匹配，但换不成别的值，**放行真实密钥的风险低**。
- **资源耗尽 / ReDoS**：新路径正则只有非嵌套可选组和字面量，线性，无嵌套量词。
- **不可逆操作与到期**：只改规则和测试，不删除/改写已提交记录；白名单本身无到期日（ADR 0177:101），属既有设计，本改动未加重。
- **规则 / 文档 / 代码一致性**：与 ADR 0177 第 2 条一致（逐文件、精确值），但与 PR 材料写明的目标不一致，见发现 1。
- **工具链完整性**：`verifyRuleFiles` 会比对 `ci/rules/gitleaks.toml` 的 sha256（`scripts/ci/install-tools.mjs:314-322`），摘要错了 `check:gitleaks` 预检即失败；本次无法用允许的命令重算，标「未核实」。

## 读代码证实的发现

### 1. 中 — 最终改动没有实现“以后复核记录再引用同一个假值不再变红”，作者的事实描述停留在旧提交

- 文件:行：`ci/rules/gitleaks.toml:138`；`docs/adr/0177-gitleaks-exact-value-allowlist.md:102`
- 问题：材料“已核对的事实”称路径限 `.agents/reviews/pr-<数字>/round-<数字>/<文件名>.md`，但最终代码已收窄到几个具体文件；且最终做法意味着**新记录再引用同一个值仍会变红**，与 PR 目标“以后复核记录再引用同一个假值不再变红”冲突。
- 证据：
  - 最终路径：`paths = ['''(?:^|/)\.agents/reviews/(?:pr-312/round-3/judgments\.md|pr-316/round-1/(?:deepseek-v4\.1-flash|glm-5\.3-flash)(?:\.prompt)?\.md|pr-319/round-1/glm-5\.3-flash\.md)$''']`（`ci/rules/gitleaks.toml:138`）。
  - `git diff 78afea98..0121065` 显示旧行是 `pr-[0-9]+/round-[0-9]+/[A-Za-z0-9.-]+\.md`，被本次替换成上面的具体文件列表。
  - ADR 0177 原文：“以后复核模型在新的记录里再引用测试令牌，security 检查会再报，要再按本 ADR 加一块。”（`docs/adr/0177-...md:102`）
- 建议：若目标只是“让当前 main 变绿且符合 ADR 0177”，把 PR 目标和“已核对的事实”改成“只修当前已命中的具体文件”，并补全所有实际命中文件；若“以后不再变红”是硬目标，则另做一层：在 `scripts/model-review/opencode-review.mjs` 的 `RECORD_SECRET_RULES` 增加针对这个已知假值的字面量遮盖规则（用 `join` 之类构造避免源码里出现原文），让写记录时就把值替换成 `[已遮盖:...]`；历史里已提交的记录仍保留当前逐文件白名单。注意合并门 `assertReviewed` 用同一组规则复查已提交记录，新增规则会影响旧记录，需一并设计，避免自锁。

### 2. 中 — 新白名单覆盖 6 种路径形态，但真实 gitleaks 测试只有 1 个正例和 1 个跨轮反例；同轮目录放宽不会被发现

- 文件:行：`test/tooling/gitleaks-config.test.mjs:40-42`、`:58-60`、`:84-99`、`:264-268`
- 问题：新块允许 `pr-312/round-3/judgments.md`、`pr-316/round-1/{deepseek-v4.1-flash,glm-5.3-flash}{,.prompt}.md`、`pr-319/round-1/glm-5.3-flash.md`，但夹具只造了：
  - 正例 `REVIEW_316_RECORD = ".agents/reviews/pr-316/round-1/glm-5.3-flash.md"`；
  - 反例 `REVIEW_316_SIBLING = ".agents/reviews/pr-316/round-2/glm-5.3-flash.md"`。
  其余路径分支没有夹具。若把路径部分改成 `pr-316/round-1/[^/]+\.md`（同轮目录级放宽），`sibling` 在 `round-2` 不会命中，`REVIEW_316_RECORD` 本来就被放行，findings 不会变化，这条反向用例仍会通过。ADR 0177 明确“不得放行整个目录”。
- 证据：
  - `FIXTURES` 只登记 `[REVIEW_316_RECORD]` 与 `[REVIEW_316_SIBLING]`（`:58-60`）。
  - 反向用例只把整条路径换成 `...pr-[0-9]+/round-[0-9]+/[^/]+\.md$`（`:264-268`），没有覆盖“保留 pr-316/round-1、只把文件名放宽”的情形。
- 建议：为每个路径分支至少加一个正例（pr-312、pr-319、deepseek 变体、`.prompt` 变体），并在**同一目录**再加一个反例（如 `.agents/reviews/pr-316/round-1/other.md`），这样同轮目录级放宽也会导致 findings 变化、测试失败。

### 3. 低 — `gitleaks-allowlist.test.mjs` 新增样本与上一条重复，且该文件只核对值与块形状，不核对路径唯一性

- 文件:行：`test/tooling/gitleaks-allowlist.test.mjs:107-108`
- 问题：新增的 `[["abcdef", "123456"].join(""), changeLast]` 与第 107 行完全相同；它能验证新块的值正则，但没有像 `gitleaks-config.test.mjs` 那样验证新块路径不会匹配别的文件。
- 证据：
  ```
  [["abcdef", "123456"].join(""), changeLast],
  [["abcdef", "123456"].join(""), changeLast],
  ```
- 建议：保留一条即可；路径唯一性交给发现 2 建议的同目录反例覆盖，避免重复样本掩盖索引错位。

## 推测 / 未核实

### 4. 中（推测）— pr-319 的 `.prompt.md`、`judgments.md`、`verdicts.jsonl`、`usage.jsonl` 或 deepseek 答案若也原样引用了那个假令牌，检查仍会红

- 文件:行：`ci/rules/gitleaks.toml:138`；`scripts/model-review/opencode-review.mjs:2445-2456`
- 依据：最终白名单对 pr-319 只列了 `glm-5.3-flash.md`，没有 `.prompt.md`、`deepseek-v4.1-flash.md`、`judgments.md` 等；而 `maskSecretLike` 的 `credential-assignment` 只认 `api_key/access_token/refresh_token/password/client_secret/webhook_secret` 等键名，`token=...` 不命中，写记录时不会遮盖这个值。复核记录目录被环境按 `.agents/instructions/model-review.md:103` 的 `-diff` + git 替身挡住，我无法读取确认。
- 建议：先实际跑 `npm run check:gitleaks`，把本次实际命中的所有文件都列进白名单（或走发现 1 的写入期遮盖），不要只凭“应该只有 glm 那份”推断。

### 5. 低（未核实）— `ci/toolchain-lock.json` 的 sha256 是否真与当前 `gitleaks.toml` 一致

- 文件:行：`ci/toolchain-lock.json:1202`
- 依据：`verifyRuleFiles` 会严格比对（`scripts/ci/install-tools.mjs:321`），但当前环境只允许 git 只读命令，无法重算 sha256。若不一致，`check:gitleaks` 会在预检阶段直接失败。
- 建议：提交前以 `npm run check:gitleaks` 的实际结果为准。

### 6. 低（未核实）— 新增记录是否影响 `format:check` / `check:instruction-links` 等其它检查

- 依据：仓库是 sparse checkout，`.agents/reviews/pr-319/**` 不在工作区，我没有实际跑这些检查；从脚本看 `check:instruction-links` 只扫 `.agents/instructions`（`scripts/check-instruction-links.mjs:11`），大概率不受影响，但未实测。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本改动只碰 `ci/rules/gitleaks.toml`、`ci/toolchain-lock.json`、`test/tooling/*` 和 `.agents/reviews/pr-319/*`，没有改任何请求组装代码；新增的 `*.prompt.md` 是存档，不是运行时发送内容，且复核副本会 sparse checkout 掉整个 `.agents/reviews`（`.agents/instructions/model-review.md:103`）。因此发给模型的内容仍由现有逻辑只在末尾追加，每轮变化的值仍只在最后一条消息里，符合 [只追加](../../.claude/rules/prompt-prefix.md#rules)。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增的是静态正则、静态锁文件哈希和静态记录文件；没有时间字段、无序集合或依赖前后文的遮盖逻辑改动。测试里的 `randomBytes`（`gitleaks-config.test.mjs:19`）是既有测试夹具，与模型请求无关。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有，且大部分有效：`gitleaks-config.test.mjs` 用锁定版本真实 gitleaks 同时扫当前文件和历史，正向夹具证明该块会放行，反向夹具（同值出现在 `round-2`）证明它会照报；值变异用例（`gitleaks-allowlist.test.mjs:91-113`）和“路径放宽成任意 PR/轮”用例（`gitleaks-config.test.mjs:264-268`）确实会让结果偏离预期而失败。缺口是发现 2：6 种路径分支只覆盖 1 种，且同轮目录级放宽不会被发现。

4. **每个产生或修改的值，使用它的一端都能接受吗？**
   - `ci/rules/gitleaks.toml:134-140` 新块：使用方是 gitleaks 8.30.0（锁定版本）、`gitleaks-allowlist.test.mjs`（解析 `[[allowlists]]`，要求 AND/secret/单路径/单正则，并已把计数从 13 改为 14）和 `gitleaks-config.test.mjs`（按字符串替换路径正则）。已逐项核对，格式和计数一致。
   - `ci/toolchain-lock.json:1202` 的 sha256：使用方是 `verifyRuleFiles`（`install-tools.mjs:314-322`）和 `check-security` 预检；要求精确相等。**未核实是否相等**。
   - 测试常量 `REVIEW_316_RECORD` / `REVIEW_316_SIBLING` 和 `EXPECTED_WITH_REPOSITORY_CONFIG`：只在 `gitleaks-config.test.mjs` 内使用，路径、内容、预期三处互相一致。
   - 新增 `.agents/reviews/pr-319/*` 文件：使用方是复核合并门（`record-secret-like`）和记录读取；它们的路径要同时匹配白名单，但白名单只列了 `glm-5.3-flash.md`，其余文件是否也需要放行**未核实**（见发现 4）。
