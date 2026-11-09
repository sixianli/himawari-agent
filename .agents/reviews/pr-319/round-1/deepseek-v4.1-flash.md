## 发现（按严重度）

### 1. 中高：新白名单把“具体文件”扩大成“整类复核记录文件”，与 ADR 0177 和 Spec 的明文规定冲突

- 文件:行：`ci/rules/gitleaks.toml:134-140`
- 问题：新增块的 `paths` 匹配 `.agents/reviews/pr-<数字>/round-<数字>/<任意文件名>.md`，即所有 PR、所有轮次的复核记录，而不是 ADR 要求的“具体文件”。PR 没有同步修改 ADR 或 Spec，代码与已接受的安全规则文档不一致。
- 证据：
  - `ci/rules/gitleaks.toml:138`：`paths = ['''(?:^|/)\.agents/reviews/pr-[0-9]+/round-[0-9]+/[A-Za-z0-9.-]+\.md$''']`
  - `docs/adr/0177-gitleaks-exact-value-allowlist.md:66`：“`paths` 只有一个正则，锚定到具体文件（不得放行整个目录）”
  - `docs/adr/0177-gitleaks-exact-value-allowlist.md:102`：“以后复核模型在新的记录里再引用测试令牌，security 检查会再报，要再按本 ADR 加一块。”
  - `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:238`：“按 ADR 0177 加‘规则 + 单一路径 + 精确值’的白名单”
- 建议：二选一：
  1. 按现行 ADR 收窄到当前实际命中的具体文件（例如分别锚定 `pr-312/round-3/judgments.md` 和 `pr-316/round-1/<文件名>.md`），以后仍按 ADR 逐块增加；
  2. 如果确实要“以后同类记录不再逐块加”，就正式修订 ADR 0177（以及 Spec 的“单一路径”措辞），明确允许“复核记录目录 + 精确值”的白名单，并保留“值必须精确”的约束。当前这种“代码先放宽、文档不动”的做法不应直接合入。

### 2. 中：现有反向用例不能证明“目录级路径”会被拒绝，值反向用例也覆盖不到关键放宽

- 文件:行：`test/tooling/gitleaks-config.test.mjs:264-268`、`test/tooling/gitleaks-allowlist.test.mjs:74-114`
- 问题：
  - 路径反向用例只把正则放宽到 `.*\.md$`；如果放宽成 `.agents/reviews/.*\.md$`（也就是让整个复核记录目录生效），现有 fixture 的命中结果不会变化，测试仍会通过。这正好覆盖不到本 PR 的实际路径形态。
  - 值反向用例只测“把最后一位改成同类字符”；如果新块的正则去掉 `$`、改成 `^<那个假令牌>.*$` 或完全不加锚点，现有 `changeLast`/`sameKindLast` 都不会失败，`gitleaks-config` 的“deepseek any value”也只替换锚定过的字符串，无法发现新块单独失锚。
- 证据：
  - `test/tooling/gitleaks-config.test.mjs:264-268`：唯一的 review-record 路径变异是改成 `'''.*\.md$'''`。
  - `test/tooling/gitleaks-allowlist.test.mjs:74-81`：路径反例只有 `/tmp/work/src/other.ts` 和 `docs/test/integration/other.test.ts`，没有 `.agents/reviews` 内部的反例。
  - `test/tooling/gitleaks-allowlist.test.mjs:83-114`：值变异只有 `changeLast`、`changeFirst`、`sameKindLast`，没有“追加后缀”或“去掉锚点”的用例。
  - `ci/rules/gitleaks.toml` 中其他 `generic-api-key` 记录的 fixture 值都不同（例如 `pr-273` 的合成令牌是另一串 32 位值），所以路径放宽到整个 `.agents/reviews` 时这些结果不变，测试不会报错。
- 建议：
  - 在 `gitleaks-config.test.mjs` 增加一个 review 路径下、值只差一个字符的 fixture（或值带后缀的 fixture），断言它仍被报告；
  - 如果 ADR 仍要求“具体文件”，增加一个把路径从具体文件放宽到 `.agents/reviews/.*\.md$` 的变异用例，断言结果必须变化；
  - 增加断言：新块的 `regexes` 必须同时以 `^` 开头、`$` 结尾，或增加“去掉锚点必须让测试失败”的变异用例。

### 3. 低：`description` 里重复写出了那个假令牌原文

- 文件:行：`ci/rules/gitleaks.toml:135`
- 问题：描述文字里直接包含那个假令牌原文。当前 `generic-api-key` 大概率不会命中它（该行没有英文关键字加赋值符的上下文），但其它白名单块的 `description` 都不重复具体值；这会给未来规则变化增加一个不必要的命中面，也不符合“回答里不要写出原文”的同一类最小暴露原则。
- 证据：`description = "复核记录（...）里原样引用的 deepseek 测试假令牌 …，只限这类记录文件"`（原文中该位置是那个假令牌）。
- 建议：改成“原样引用的 deepseek 测试假令牌（值见 `regexes`）”，不在描述里重复原文。

### 4. 低：文件名字符类不含下划线等字符，“以后同类记录不再变红”的目标并不完整

- 文件:行：`ci/rules/gitleaks.toml:138`
- 问题：`[A-Za-z0-9.-]+` 不允许 `_`、中文、空格等。如果以后复核记录文件名含下划线（例如某个模型名或人工文件名），同一个假值仍会被报，目标落空。
- 证据：`paths = ['''(?:^|/)\.agents/reviews/pr-[0-9]+/round-[0-9]+/[A-Za-z0-9.-]+\.md$''']`
- 建议：如果采纳“复核记录级”范围，改成 `[A-Za-z0-9._-]+`；如果按 ADR 收窄到具体文件，则此点自然消失。

### 5. 未核实：`ci/toolchain-lock.json` 的新 sha256 是否与修改后的规则文件一致

- 文件:行：`ci/toolchain-lock.json:1202`、`scripts/ci/install-tools.mjs:314-322`
- 问题：`verifyRuleFiles` 会强制比较 `ci/rules/gitleaks.toml` 的实际 sha256 与锁文件记录。本环境不能执行 `sha256sum`，无法独立验证 `92d815c4…` 是否确实对应新文件。若不一致，`npm run check:gitleaks` 会以“扫描规则摘要不匹配”继续失败。
- 证据：`scripts/ci/install-tools.mjs:321`：`assert(sha256(readFileSync(path)) === file.sha256, \`扫描规则摘要不匹配: ${file.path}\`);`
- 建议：合入前本地跑一次 `npm run check:gitleaks` 或生成锁文件的脚本确认。此项为**未核实**，不是已确认缺陷。

---

## 读代码证实的结论

- 新增白名单确实同时限定：`targetRules = ["generic-api-key"]`、`condition = "AND"`、单一 `paths`、`regexTarget = "secret"`、单一且精确锚定的 `regexes`（`ci/rules/gitleaks.toml:134-140`）。
- 因为值被 `^…$` 精确锚定，**当前这条白名单本身不能用来藏一个不同值的真实密钥**；再宽的路径也只能放行“那个假令牌”这个值。
- 新 fixture `REVIEW_316_RECORD` 与 sibling `REVIEW_316_SIBLING` 的设计是正确的正反样例：记录文件被放行，`docs/review-copy/...` 下同值文件仍被报告（`test/tooling/gitleaks-config.test.mjs:40-42,58-60,84-85,205-208`）。
- `gitleaks-allowlist.test.mjs` 的块数量从 13 改为 14，与新追加的 `[[allowlists]]` 一致；新增的变异样例与两个 `^<假令牌>$` 块按顺序对应（第 107-108 行两条相同样例分别对应 deepseek 块和新 review 块）。
- 生产扫描路径也是可匹配的：当前文件扫描在 snapshot 绝对路径下执行，正则的 `(?:^|/)` 能匹配 snapshot 前缀（`scripts/ci/check-security.mjs:383-397`）。
- 该 PR 只改 CI 配置和测试，不涉及提示词组装、历史写入或遮盖实现，因此不会改变模型已见请求开头。

## 推测 / 未核实

- **未核实**：PR 材料说新命中在 `.agents/reviews/pr-312/round-3/judgments.md` 和 `.agents/reviews/pr-316/round-1/`。本复核环境的 git 访问拒绝了这些记录路径（返回 `REVIEW_GIT_REFUSED records-path ...`），所以无法直接确认实际文件名和内容；从正则看，`judgments.md` 和常见模型文件名都能匹配。
- **推测**：如果未来复核记录文件名含 `_` 或中文，当前路径正则不会匹配（见发现 4）。
- **未核实**：锁文件 sha256 的正确性（见发现 5）。

---

## 侧重检查

- **错误路径**：新增正则是普通 RE2 语法，字符类加锚点，无嵌套量词，不存在灾难性回溯；若 TOML/正则写坏，gitleaks 会启动失败或 `verifyRuleFiles` 报摘要不匹配，不会静默通过。**结论：无新增资源耗尽风险。**
- **不合规范或不可信的输入**：复核记录是模型写的不可信文本。当前值精确锚定，模型写入不同值的真实密钥仍会被 `generic-api-key` 报告；但路径范围从“具体文件”扩大到“所有复核记录”，属于安全规则边界的永久放宽，且与 ADR 0177 冲突（发现 1）。
- **安全**：当前值精确，不能借这条白名单隐藏不同值的真实密钥；真正的风险是流程性的——安全白名单的覆盖范围超出已批准文档，且没有 ADR 修订与对应反向测试。
- **不可撤销操作**：该白名单没有到期日，路径一旦放宽就会长期生效；按 ADR 0177 的后果说明，只应在“已经核实不是密钥、且范围尽量窄”的前提下加入精确值白名单。
- **规则文件、说明文档和代码一致性**：**不一致**。代码允许“任意 PR/任意轮次的复核记录”，ADR 0177 决定第 2 条要求“锚定到具体文件（不得放行整个目录）”，Spec 要求“单一路径 + 精确值”；PR 未修改这两份文档。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只涉及 `ci/rules/gitleaks.toml`、锁文件和两个 CI 测试文件，没有进入系统提示、工具定义、历史消息或遮盖结果的组装路径；也没有新增每轮变化的值。因此“只在末尾追加、会变的值都在最后一条消息里”的约束不受影响。依据：`.claude/rules/prompt-prefix.md:27-29,35-36`。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增的是静态、无时间、无上下文依赖的正则白名单；不参与提示词序列化，也没有引入无序集合或带时间的字段。测试里原有的随机 GitHub 令牌 fixture 是本 PR 之外既有逻辑，不进入模型请求。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有：`test/tooling/gitleaks-allowlist.test.mjs` 和 `test/tooling/gitleaks-config.test.mjs`，且新块有正例（记录文件不再报）和“同值出现在别的文件仍报”的反例（`docs/review-copy/...`）。但反向覆盖不完整：
   - 路径放宽到 `.*\.md$` 会失败；
   - 路径放宽到 `.agents/reviews/.*\.md$`（本 PR 实际形态的目录级范围）**不会**让现有测试失败；
   - 值正则去掉 `$` 或改成 `^<那个假令牌>.*$`，现有最后一位变异用例**不会**失败。
   所以只能回答“部分满足”，不能说所有该防的反向用例都会失败。

4. **每个产生/修改的值，使用它的地方都能接受吗？** 逐项核对：
   - 新 `[[allowlists]]` 的字段由 gitleaks 解析，`condition`/`targetRules`/`paths`/`regexTarget`/`regexes` 都合法，gitleaks 和两个测试都能接受；
   - 新 fixture 的路径和内容与 `EXPECTED_WITH_REPOSITORY_CONFIG` 一致，`scoped` 数量 14 与 13 个旧块加 1 个新块一致；
   - 新 fixture 与既有 `.agents/reviews/pr-273`、`pr-274` fixture 不冲突，因为它们的值或规则不同，既有期望结果不需要改；
   - `ci/toolchain-lock.json` 的 sha256 由 `verifyRuleFiles` 消费，**未核实**是否同步正确；
   - `description` 里的字面值不参与匹配，但属于额外暴露面（发现 3）。

**总体建议**：如果要坚持 ADR 0177 的现行规则，应把 `paths` 收窄到当前具体记录文件；如果要实现“以后同类记录不再逐块加”，应先修订 ADR 0177 和 Spec，明确允许“复核记录目录 + 精确值”的白名单，并补上“review 路径里不同值仍被报告”“目录级路径必须受控”的反向用例。另一个更彻底的系统性方案是：在 `scripts/model-review/opencode-review.mjs` 的 `RECORD_SECRET_RULES`（`scripts/model-review/opencode-review.mjs:2430-2449`）里加入这个已知测试值的精确遮蔽规则，让未来的复核记录在写入时就不落这个字面量；历史文件再用按具体文件的精确值白名单处理，这样不必长期放宽 gitleaks 的路径范围。
