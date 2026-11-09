## 结论摘要

核心白名单本身是“规则 + 具体记录文件 + 精确值”三重限定，**没有发现它能藏住真密钥**（`regexTarget = "secret"` 加 `^…$` 精确值，只有命中值恰好等于那个假令牌时才会被放行）。但材料里有几处说法与代码/ADR 不一致，而且收窄后的白名单**没有在收窄后重新验证 `check:gitleaks`**。下面按严重度排列。

---

## 已读代码证实的发现

### 1. 中 — 收窄后的白名单缺少“收窄后重新跑通 check:gitleaks”的记录，可能漏掉真实命中文件

- 文件：`ci/rules/gitleaks.toml:138`、`ci/toolchain-lock.json:1202`
- 问题：提交历史里唯一一次“check:gitleaks 通过（blocking=0）”是 `78afea98`，而那次用的是**目录级宽正则** `pr-[0-9]+/round-[0-9]+/[A-Za-z0-9.-]+\.md`。随后 `0121065c` 把它收窄成只匹配 6 个具体文件，但该提交说明只写了“按 ADR 0177 收窄”，**没有任何重新跑 `check:gitleaks` 的验证记录**。
- 证据（我读到的提交说明）：
  - `78afea98`：`验证：check:gitleaks 通过（blocking=0）…`，其 `paths` 为宽正则。
  - `0121065c`：`按 ADR 0177 把路径锚定到当前引用假令牌的具体记录文件…`，无 `check:gitleaks` 验证语句。
- 影响：如果实际命中文件不在那 6 个里（例如同轮的 `pr-316/round-1/judgments.md`、`pr-319/round-1/*.md/.prompt.md`，或 `verdicts.jsonl`），收窄后检查会重新变红。由于 `.agents/reviews/` 在复核副本里被 sparse checkout 剔除、并标了 `-diff`（`.git/info/attributes:1`），我无法读到实际记录内容，**这一条是否真的失败属未核实**。
- 建议：在 HEAD/`0121065c` 上重跑 `npm run check:gitleaks` 并记录 `blocking=0`；白名单路径应直接由该次 gitleaks 报告里的文件清单生成，而不是靠推测。

### 2. 中 — 材料“已核对的事实”里的路径描述与代码不符

- 文件：`ci/rules/gitleaks.toml:138`
- 问题：材料说“路径限 `.agents/reviews/pr-<数字>/round-<数字>/<文件名>.md`”，但最终代码是：
  ```
  paths = ['''(?:^|/)\.agents/reviews/(?:pr-312/round-3/judgments\.md|pr-316/round-1/(?:deepseek-v4\.1-flash|glm-5\.3-flash)(?:\.prompt)?\.md|pr-319/round-1/glm-5\.3-flash\.md)$''']
  ```
  即只覆盖 6 个具体文件，不是任意 `pr-<数字>/round-<数字>/*.md`。
- 证据：`git show 0121065c -- ci/rules/gitleaks.toml` 显示正是从宽正则改成了上面这串窄正则；`git log --oneline -- ci/rules/gitleaks.toml` 之后没有再次改动。
- 建议：更正材料，或如果确实想覆盖任意轮次，按 ADR 0177 明确写清代价（见下一条）。

### 3. 中 — “以后复核记录再引用同一个假值不再变红”这个目标与实现、ADR 0177 矛盾

- 文件：`ci/rules/gitleaks.toml:138`；`docs/adr/0177-gitleaks-exact-value-allowlist.md:102`
- 问题：实现只放行 6 个**具体文件**。新的复核记录（新的 PR/轮次/文件名）引用同一个假令牌时，路径不匹配，仍会变红。ADR 正是这么写的：
  > `以后复核模型在新的记录里再引用测试令牌，security 检查会再报，要再按本 ADR 加一块。`
- 证据：`gitleaks.toml:138` 路径写成 `pr-312/round-3/judgments\.md | pr-316/round-1/... | pr-319/round-1/glm-5.3-flash\.md`；ADR 0177:102 如上。
- 建议：材料里的目标改成“让当前 main 上的这 6 个文件通过；以后新记录再报时按 ADR 再加一块”。如果确实想“以后不再变红”，更合适的做法是在**写记录时的遮盖层**处理：给 `scripts/model-review/opencode-review.mjs` 的额外遮盖规则（`model-review.md:93` 提到的额外两条规则位置）加上这个已知假令牌的精确值，让新记录被写成 `[已遮盖:…]`；这样既不放宽 gitleaks，也不会在历史里越堆越多白名单块。这不影响已提交的旧记录，旧记录仍需现有白名单。

### 4. 低 — 白名单只匹配 `.md`，同轮 `verdicts.jsonl` 按要求会逐字引用模型答案，未来可能漏

- 文件：`ci/rules/gitleaks.toml:138`；`.agents/instructions/model-review.md:33`；`scripts/model-review/opencode-review.mjs:1121,1136-1138`
- 问题：`verdicts.jsonl` 的 `quote` 必须逐字来自本轮 `<模型>.md`。如果模型答案里含那个假令牌且某条判断引用了那句话，`verdicts.jsonl` 也会含该字面量，但路径正则只以 `\.md$` 结尾，不会放行 `.jsonl`。
- 证据：
  - `model-review.md:33`：`quote（模型原话，必须能在这一轮的 <模型>.md 里逐字找到）`
  - `opencode-review.mjs:1138`：`if (!answers.get(verdict.model)?.includes(verdict.quote))`
  - `gitleaks.toml:138`：路径以 `...glm-5\.3-flash\.md)$` 收尾，不覆盖 `.jsonl`
- 说明：`78afea98` 用同样是 `.md`-only 的宽正则却声称 `blocking=0`，因此**当前**的 `verdicts.jsonl` 很可能没有命中；这是面向“以后”的稳健性问题，属推测/未核实。
- 建议：若采用第 3 条的记录遮盖方案可一并解决；否则至少在加白名单时按实际 gitleaks 报告检查 `.jsonl`，不要把“记录文件”默认等同于 `.md`。

### 5. 低 — 反向用例覆盖有缺口：没有针对 pr-312 / pr-319 分支的负例

- 文件：`test/tooling/gitleaks-config.test.mjs:276-285`
- 问题：现有的“同轮任意文件”反向用例只放宽了 `pr-316/round-1/...`；另有“任意路径”用例放宽成全局 `pr-[0-9]+/round-[0-9]+/[^/]+\.md`。没有单独的 `pr-312/round-3/other.md`、`pr-319/round-1/other.md` 夹具来验证这两个分支各自被限制。
- 证据：
  ```
  "review record same round any file",
  "...pr-316/round-1/(?:deepseek-v4\.1-flash|glm-5\.3-flash)(?:\.prompt)?\.md...",
  "...pr-316/round-1/[^/]+\.md..."
  ```
- 说明：测试里 `expect(repositoryConfig).toContain(from)` 用整串匹配，任何对路径正则的改动都必须同步改测试，因此实际拦截力不差；这里主要是负例完整性。
- 建议：补 `pr-312/round-3/other.md`、`pr-319/round-1/other.md` 两个“同轮其他文件”夹具，以及对应放宽用例。

### 6. 低 — `toolchain-lock.json` 的 sha256 没有单元测试独立验证，只靠运行期门禁

- 文件：`scripts/ci/install-tools.mjs:253-257`（`loadToolchainLock` 只校验结构）、`:314-327`（`verifyRuleFiles` 才比对摘要）、`test/tooling/gitleaks-config.test.mjs:118`（测试只调用 `loadToolchainLock`）
- 问题：`gitleaks.toml` 的 sha256 若填错，`gitleaks-config` / `gitleaks-allowlist` 两个测试仍会通过；只有 `runGitleaksGate`（`check-security.mjs:598`）会在运行时用 `verifyRuleFiles` 报错。
- 证据：`loadToolchainLock` 直接 `validateToolchainLock(JSON.parse(...))`，无文件摘要比对；`verifyRuleFiles` 只在 `runGitleaksGate`/`runSecurityChecks` 里被调用。
- 说明：有门禁兜底，所以不是功能缺陷；我无法在只读工具下自行计算 sha256，**哈希是否正确属未核实**。作者声称 `check:gitleaks` 通过，但如第 1 条所述，那次验证发生在收窄前。
- 建议：可加一个 tooling 测试，直接对真实仓库调用 `verifyRuleFiles`，让 sha 错误在单元测试阶段就暴露。

---

## 推测 / 未核实

- 实际 `.agents/reviews` 里的内容无法读取（sparse checkout 剔除 + `-diff` + git 替身拒绝 `agents/reviews` 参数，见 `.agents/instructions/model-review.md:103`）。因此：
  - 那 6 个被放行的文件之外是否还有命中（第 1、4 条）——**未核实**。
  - `pr-312/round-3/judgments.md` 等真实文件的命中值是否确实能被 `^…$` 精确值匹配——测试夹具模拟的是 `token=…` 形式，真实上下文若不同（如带引号/标点进入 secret 字段）可能不匹配——**未核实**。
- `ci/toolchain-lock.json:1202` 的 `8cdf…` 是否等于当前 `gitleaks.toml` 的 sha256——**未核实**（无法运行哈希命令）。

---

## 侧重检查

- **错误路径 / 不可信输入**：复核记录是模型写的不可信文本，白名单用 `regexTarget = "secret"` + 精确值，不信任路径本身的“安全性”，因此即使路径被构造（例如 `x/.agents/reviews/pr-316/round-1/deepseek-v4.1-flash.md`）也只能放行值恰好等于假令牌的命中，不能藏真密钥。路径正则未锚定仓库根（`(?:^|/)`），属于为兼容绝对路径的既有写法，风险被精确值抵消。
- **安全 / 是否藏真密钥**：结论是不能。allowlist 的 `targetRules` 只有 `generic-api-key`，且 `regexes` 精确到那一个值；真实密钥即使写进这 6 个文件也会被正常报出。
- **资源耗尽**：`gitleaks-config.test.mjs` 每个变异用例会起真实 gitleaks（`scan` 两次 + 可能 `pathOnly`），本 PR 新增 2 个变异用例，仍是小夹具仓库，未见资源风险；若本机无 gitleaks 会联网下载，属既有行为。
- **不可撤销操作**：白名单无到期日（ADR 0177 已承认），一旦值所在文件改名/删除不会自动失效。本次值是不可用于真实凭据的假令牌，可接受；但“永久放行”这一点应继续保持“每个具体文件”的窄范围。
- **规则 / 文档 / 代码一致性**：发现三处不一致——材料路径描述（第 2 条）、材料目标（第 3 条）、以及 `description` 说“PR 316 第 1 轮”但未覆盖该轮 `judgments.md`（措辞层面的小不一致）。
- **其它检查**：`biome.json` 的 `files.includes` 明确排除了 `!!.agents/reviews`，因此新增记录不会破坏 `format:check`/`lint`；`check:markdown-tables` 只扫 `docs`，`check:instruction-links` 只扫 `AGENTS.md`、`.claude/rules`、`.agents/instructions`，均不扫 `.agents/reviews`。

---

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。本 PR 只改 `ci/rules/gitleaks.toml`、`ci/toolchain-lock.json`、两个 tooling 测试和 `.agents/reviews` 记录；不触碰系统提示、工具定义、历史消息或遮盖逻辑。复核脚本的必问问题/侧重来自 base 提交的 `.agents/instructions/model-review.md`，材料仍在末尾追加（`model-review.md:79-80,125`），新增记录不会进入请求开头。发放内容仍只在末尾追加，每轮会变的值仍在最后一条消息里。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。白名单、路径正则、sha256 都是静态值；没有依赖前后文的遮盖、时间字段或无序集合。唯一的不确定性是测试里 `randomBytes`/`hex` 生成的夹具，只写入临时目录，不属于模型请求或提交产物。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有：`gitleaks-config.test.mjs` 用锁定版本的真实 gitleaks 跑夹具，`gitleaks-allowlist.test.mjs` 检查每块形状并做值变异。反向用例是真的：`from` 是当前完整的路径正则，`to` 是放宽后的正则，夹具里放入了 `pr-316/round-2/...` 和 `pr-316/round-1/other.md` 两个只差路径的负例，放宽后会从 `EXPECTED` 里消失，断言 `not.toEqual` 会失败；值变异会改掉最后一个字符（含改为同类字符），字符类式放大会失败。缺口是 pr-312 / pr-319 分支没有单独负例（第 5 条），以及 sha256 没有单元测试（第 6 条）。
4. **每个产生/修改的值，使用它的地方都能接受吗？** 逐项核对：路径正则 → 被 gitleaks 引擎和两个测试消费，三处字符串一致（`toContain(from)` 会强制一致）；精确值 → 只被 `generic-api-key` 命中且 `regexTarget = "secret"`，与既有 deepseek 白名单同值，语义可接受；`description` → 只供人读，且已改为“值见 regexes”，不再把假令牌写进配置文件；sha256 → 被 `verifyRuleFiles` 消费，格式是 64 位十六进制，但**内容是否正确未核实**；新增记录文件 → 被 `biome` 排除、不被 markdown 类检查扫描。唯一“另一端可能不接受”的是 `.jsonl` 里的逐字引用（第 4 条，潜在）。
