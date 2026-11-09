## 结论（按严重度从高到低）

### 1. 中：最终代码不满足“以后复核记录再引用同一个假值不再变红”，且作者对路径范围的描述与最终代码不一致
- 文件:行：`ci/rules/gitleaks.toml:138`
- 问题：作者说“路径限 `.agents/reviews/pr-<数字>/round-<数字>/<文件名>.md`”，但最终代码是按 PR/轮次/模型名逐项列举的固定文件清单；只有清单里的文件被放行。任何新轮次、新模型或另一个文件名的复核记录再次引用那个假令牌，`check:gitleaks` 仍会红。这与本次材料的“目标”直接冲突。
- 证据：
  - 代码是穷举，不是通配：`paths = ['''(?:^|/)\.agents/reviews/(?:pr-312/round-3/judgments\.md|pr-316/round-1/(?:deepseek-v4\.1-flash|glm-5\.3-flash)(?:\.prompt)?\.md|pr-319/round-1/glm-5\.3-flash\.md)$''']`（`ci/rules/gitleaks.toml:138`）。
  - ADR 自己也写明了这个后果：`以后复核模型在新的记录里再引用测试令牌，security 检查会再报，要再按本 ADR 加一块。`（`docs/adr/0177-gitleaks-exact-value-allowlist.md:102`）。
  - 作者描述的宽路径实际只出现在最初的提交 78afea98；后续 0121065c 已把它收窄（提交说明：“复核记录白名单收窄到具体文件”）。
- 建议：先明确目标。若确实要“以后不再红”，应治根：在写记录的遮盖流程里把已知的合成假令牌按精确值遮掉（`scripts/model-review/opencode-review.mjs` 的 `RECORD_SECRET_RULES`/`maskSecretLike`，历史已提交记录仍保留一条窄白名单），这样新记录根本不会入库这个字面量；若坚持用白名单覆盖未来记录，则可放宽 `paths` 到 `.agents/reviews/`，但保留 `regexTarget = "secret"` 和精确值 `^…$`——值固定且熵低，不会放进任何真实密钥；不过这需要修改 ADR 0177/规范中“单一路径、每块只认一个文件”的约束。

### 2. 中低：一块白名单塞进多个文件，与 ADR 0177 和规范“规则 + 单一路径 + 精确值 / 每块只认一个文件”不一致
- 文件:行：`ci/rules/gitleaks.toml:138`、`docs/adr/0177-gitleaks-exact-value-allowlist.md:11/66/74`、`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:238`
- 问题：ADR 的标题和正文要求每个精确值白名单“单一路径”“每块只认一个文件里的一个值”；新块用一个 `paths` 正则同时覆盖 5～6 个文件（`pr-312/round-3/judgments.md`、`pr-316/round-1` 的 deepseek/glm 及 `.prompt`、`pr-319/round-1/glm-5.3-flash.md`）。description 却写“按 ADR 0177 锚定到具体文件”，容易让人以为仍遵守单文件约束。
- 证据：
  - `# ADR 0177：…用“规则 + 单一路径 + 精确值”的 Gitleaks 白名单放行`（`docs/adr/0177…:11`）。
  - `paths 只有一个正则，锚定到具体文件（不得放行整个目录）`（同上 :66）；`所以每块只认一个文件里的一个值`（同上 :74）。
  - 测试只校验正则条数，不校验“一个文件”：`expect(block.paths).toHaveLength(1);`（`test/tooling/gitleaks-allowlist.test.mjs:69`）。因此这种多文件合并不会被测出来。
- 建议：要么拆成“每个文件一块”（与 ADR 一致，缺点是块数变多），要么修改 ADR 0177 和 Spec，明确允许“一个 `paths` 正则列出多个具体文件（不含通配目录）”，并给测试加一条“每个 alternation 只能匹配预期的那一个具体文件”的断言。

### 3. 低：真实 gitleaks 正向夹具只覆盖新白名单中的一个文件，其他 alternation 拼错也会绿
- 文件:行：`test/tooling/gitleaks-config.test.mjs:59-62` 对照 `ci/rules/gitleaks.toml:138`
- 问题：新块有 5～6 个路径分支，但 `FIXTURES` 只放了 `pr-316/round-1/glm-5.3-flash.md`（以及用于反例的 round-2 和 `other.md`）。`pr-312/round-3/judgments.md`、`.prompt.md` 变体、`pr-319/round-1/glm-5.3-flash.md` 都没有被真实 gitleaks 跑过；其中任一分支写错，main 上仍会红，而测试仍通过。
- 证据：`[REVIEW_316_RECORD]: REVIEW_316_LINE,` / `[REVIEW_316_SIBLING]: REVIEW_316_LINE,` / `[REVIEW_316_SAME_ROUND_OTHER]: REVIEW_316_LINE,`（`gitleaks-config.test.mjs:60-62`），而路径正则有多个其他分支（`gitleaks.toml:138`）。
- 建议：为每个 alternation 至少加一个夹具（每个 PR 目录、`.md` 和 `.prompt.md` 各一），或由路径正则的分支自动生成夹具；这样任何一个分支写错都会让测试失败。

### 4. 低（提示，不算缺陷）：路径正则的 `(?:^|/)` 可以匹配任意前缀下的同名后缀
- 文件:行：`ci/rules/gitleaks.toml:138`
- 问题：`(?:^|/)` 表示 `foo/.agents/reviews/pr-312/round-3/judgments.md` 也能匹配，并不严格限仓库根目录。但因为这条白名单同时要求 `targetRules = ["generic-api-key"]`、`regexTarget = "secret"` 且值必须是那个固定假令牌（`^…$`），它无法用来藏任何真实密钥；这是所有既有白名单的通用写法，不是本次引入的新风险。
- 建议：若想更严格可改成 `^\.agents/reviews/...`，但收益有限；建议保持现状，避免与既有风格不一致。

## 读代码证实的

- 新白名单确实只放行 `generic-api-key` 规则、`regexTarget = "secret"`、精确值那个假令牌，并有 `condition = "AND"`（`ci/rules/gitleaks.toml:134-140`）；它不会放行同形状的其他值，也不会放行别的规则。
- 命中路径确实被收窄到具体文件，不是作者所说的 `pr-<数字>/round-<数字>/<文件名>.md` 通配（`gitleaks.toml:138`）。
- `gitleaks-allowlist.test.mjs` 的块数从 13 改为 14 是正确的：配置文件共 17 个 `[[allowlists]]`，去掉前三个被解构掉的块后正好 14（`gitleaks-allowlist.test.mjs:24,64`）。
- 两个新增的反向/放宽用例在逻辑上确实会让测试失败：把 `pr-316/round-1` 放宽成同轮任意 `.md` 会让 `REVIEW_316_SAME_ROUND_OTHER` 不再上报；放宽成任意记录路径会让 `REVIEW_316_SIBLING` 也不再上报；两者都会使 `findings` 与 `EXPECTED_WITH_REPOSITORY_CONFIG` 不等（`gitleaks-config.test.mjs:86-102,267-276,286-309`）。值变异用例对第 14 块也成立（`gitleaks-allowlist.test.mjs:107-113`）。
- `ci/rules/gitleaks.toml` 的摘要确有消费者：`scripts/ci/install-tools.mjs:314-321` 的 `verifyRuleFiles` 会与 `ci/toolchain-lock.json` 比对，摘要不符会报 `扫描规则摘要不匹配`。
- 遮盖流程目前不覆盖 `token=` 这种裸写法：`scripts/model-review/opencode-review.mjs:2445-2448` 的 `credential-assignment` 只认 `api_key/access_token/refresh_token/password/client_secret/webhook_secret`，不认单独的 `token`；因此未来复核记录仍可能原样带出这个假令牌，这也解释了为什么需要 gitleaks 白名单。

## 未核实（本环境无法验证）

- `ci/toolchain-lock.json` 里的新 sha256 是否真的等于新 `ci/rules/gitleaks.toml`：本环境只允许 git 命令，无法计算 sha256；只能确认 diff 中该值从 `34c0d12…` 改为 `8cdfb88…`，最终消费者是 `verifyRuleFiles`。
- 实际 main 上所有命中文件是否全部被第 138 行覆盖：`.agents/reviews/` 路径的 `git show`/`git diff` 被环境以 `REVIEW_GIT_REFUSED records-path …` 拒绝，我无法读取 `pr-312/round-3/judgments.md`、`pr-316/round-1/*`、`pr-319/*` 的实际内容。特别是 `pr-316/round-1/judgments.md`、`pr-316/round-1/verdicts.jsonl`、`pr-319/round-1/deepseek-v4.1-flash.md` / `.prompt.md`、`pr-319/round-2/*` 是否含被 gitleaks 命中的形式，未核实。
- 作者声称的 `check:gitleaks` blocking=0、`format:check` 原本为绿：未运行验证。

## 侧重检查

- **错误路径 / 不可信输入**：复核记录是模型写的不可信文字，可能原样引用任何字面量。新块把“路径”收窄到具体文件，同时用精确值约束，因此即使模型在别的记录里写真实密钥也不会被这条放行；但如果模型在新记录里写那个假令牌，就会再次触发（见问题 1）。这一路径我通过 `gitleaks.toml:134-140`、`opencode-review.mjs:2430-2456`、`docs/adr/0177…:102` 核对过。
- **安全 / 藏真密钥**：结论是这条路走不通——白名单要求 `regexTarget="secret"` 且正则 `^…$` 锚定那一个固定假值，真实密钥值不同，仍会被报。唯一的宽松点是 `(?:^|/)` 前缀，但与值约束叠加后不构成“藏真密钥”的通道（见问题 4）。
- **资源耗尽 / 不可撤销操作**：本次改动只是静态 TOML、锁文件、测试和记录，没有新增循环、下载、删除或不可逆操作；`gitleaks-config.test.mjs` 的下载/临时目录行为是既有的。
- **规则文件、说明文档和代码一致**：发现两处不一致——最终路径范围与作者说法不一致（问题 1）；多文件合并与 ADR 0177/Spec 的“单一路径、每块一个文件”不一致，且测试没有守住（问题 2）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本次改动只涉及 `ci/rules/gitleaks.toml`、`ci/toolchain-lock.json`、`test/tooling/*` 和 `.agents/reviews/*` 记录；没有改系统提示、工具定义、历史消息、遮盖规则或请求组装。没有证据表明这些文件会进入模型请求前缀；发给模型的内容仍然只在末尾追加，本次也没有新增“每轮会变的值”。（依据 `.claude/rules/prompt-prefix.md` 第二、三、四节；本改动不触碰这些路径。）

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增的是静态正则、静态 sha256 和静态夹具；没有引入依赖前后文的遮盖、时间字段或无序集合。测试里的 `githubToken()` 随机值是本 PR 之前就有的测试夹具，不属于发给模型的内容，也不是本次新增。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有，且新加的反向用例在逻辑上确实会失败：`gitleaks-config.test.mjs:267-309` 的两个路径放宽用例、`gitleaks-allowlist.test.mjs:83-114` 的值变异用例，都会让结果偏离预期（见“读代码证实的”）。但有两点限制：一是只对 `pr-316/round-1/glm-5.3-flash.md` 这一个实际路径做了正向验证，其他 alternation 未覆盖（问题 3）；二是这些测试在 tooling 项目里，`npm run check` 本身不跑 tooling 测试（`README.md:55`），要靠 CI/`npm run test:tooling` 才能生效。

4. **每个新产生的值，所有使用它的地方都能接受吗？** 逐项核对结果：
   - `paths`/`regexes`/`condition`/`targetRules`/`regexTarget`：与既有块同形，由真实 gitleaks 8.30.0 解析；`gitleaks-config.test.mjs` 的正向夹具假定该块能生效。这一端可用（但未覆盖全部 alternation）。
   - `ci/toolchain-lock.json` 的新 sha256：消费者是 `install-tools.mjs:314-321` 的 `verifyRuleFiles`，会做严格比对；值本身是否算对，本环境未核实。
   - 白名单块数：`gitleaks-allowlist.test.mjs:64` 的 14 与配置 17 块减去前 3 块一致，已核对。
   - 新增夹具路径：由测试自己在临时仓库创建，路径合法；但 `pr-312`、`pr-319` 等真实文件是否存在且拼写与正则一致，因记录不可读而未核实。
