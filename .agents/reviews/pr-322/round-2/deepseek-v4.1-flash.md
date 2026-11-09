## 结论摘要

改动能按预期在“写记录时”遮掉已登记的字面值，且**没有改变发给模型的提示词字节**。但有四个实质问题：合并门会重新检查本 PR 目录下的旧记录，导致活动 PR 自锁，而文档给出的补救办法与 gitleaks 扫全历史的事实矛盾；从白名单提取值时忽略了 `paths`/`targetRules`/`regexTarget`，会误遮非密钥值；补跑兼容只覆盖“从未遮过登记值”的旧存档；测试没有覆盖 `main()` 的接线和“部分登记”的旧存档。

---

## 问题（按严重度）

### 高：合并门会重新判红本 PR 已有的记录，文档给的“再提交遮盖版”并不能修好

- **文件:行**：`scripts/model-review/opencode-review.mjs:2505-2511`、`2532-2544`、`2546-2554`、`1252-1259`；`docs/adr/0190-mask-registered-test-values-in-review-records.md:52,80-81`；`scripts/ci/check-security.mjs:358-365,402-430`；`scripts/check-gitleaks.mjs:71`
- **问题**：`secretLikeRules` 把所有已登记值都当成 secret-like；`recordSecretProblems` 又用 `git ls-tree -r ... HEAD -- <本 PR 记录目录>` 扫**该目录下全部轮次文件**；`record-secret-like` 不在 `OVERRIDABLE_PROBLEMS` 里，不能用 `--accept-unreviewed` 放行。于是活动 PR 里在值登记之前提交的记录（包括本来就靠 ADR 0177 的路径白名单放行的记录，例如 `pr-319/round-1/glm-5.3-flash.md` 那条）会突然被非可覆盖地拒绝。更严重的是 ADR 0190 第 80/81 条说“改成遮盖写法再提交即可/手工改”，但 gitleaks 的历史扫描范围是**被测 head 可达的全部历史**（`range = ancestry ?? "--all"`，再以 `--full-history --no-ext-diff ${range}` 运行），后加一个“已遮盖”的新提交不会删掉旧提交里的原值；`check-gitleaks.mjs:71` 自己也写着“已提交的历史改不掉”，而 ADR 第 52 条又说“不改老记录”。三者互相矛盾。
- **证据（读代码）**：
  - `if (registeredTestValues.some((value) => text.includes(value))) rules.push(REGISTERED_VALUE_RULE_ID);`
  - `const listed = gitStatus(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ledgerPath], repo);`
  - `for (const id of secretLikeRules(shown.stdout)) problems.push(\`record-secret-like ${printable(file)} ${id}\`);`
  - `const range = ancestry ?? "--all";` / `"--full-history --no-ext-diff ${range}"`
  - `check-gitleaks.mjs`：`真密钥：从文件删掉并作废它，已提交的历史改不掉。`
- **建议**：合并门只检查 PR 范围内新增/改动的记录行（例如 `git diff --unified=0 <base>..HEAD -- .agents/reviews/...` 的新增行），或把已被路径白名单放行的值视为已接受，避免旧记录自锁。文档删掉“再提交遮盖版即可”，改成“只能加回白名单或重写历史，并按项目规则另做决定”。

### 中：提取清单忽略 `paths`/`targetRules`/`regexTarget`，会误遮非密钥和跨文件的值

- **文件:行**：`scripts/model-review/opencode-review.mjs:2463-2471`；`ci/rules/gitleaks.toml:63-68`（探针的 tmpfs 参数）、`70-76`（线程 UUID）、`86-92`（幂等键）、`94-100`（64 位文件摘要）；`docs/adr/0190...:49`
- **问题**：解析只看 `^…$` 形状和字面字符集，不看这条白名单只对哪个文件、哪条规则、`regexTarget` 是什么。结果 gitleaks 明确写着“不是密钥”的路径限定值也会在**所有**复核记录里被替换成 `[已遮盖:registered-test-value]`。记录里讨论探针脚本、幂等键或摘要时，原文会被永久抹掉（模型的原始输出只在临时目录，仓库里只剩遮盖版）。这和 I-73 是同一类错：清单产生方带路径/规则语义，消费方只把它当成全局字面值。
- **证据（读代码）**：
  - `for (const match of text.matchAll(/^regexes\s*=\s*\[\s*\'\'\'\^([^\n]*?)\$\'\'\'\s*\]\s*$/gm))`
  - `if (literal.length >= REGISTERED_VALUE_MIN_LENGTH && /^[A-Za-z0-9_\-=.:/ ]+$/.test(literal))`
  - 没有读取 `paths`、`targetRules`、`regexTarget`、`condition`。
- **建议**：只取 `targetRules` 属于密钥规则且 `regexTarget == "secret"` 的条目；或者改用一份独立的“复核记录测试值”清单，别把 gitleaks 的所有精确值都当密钥。至少不要全局遮盖路径限定值。

### 中：补跑兼容只覆盖“从未遮过登记值”的旧存档，清单变化后仍报 `ROUND_PROMPT_MISMATCH`

- **文件:行**：`scripts/model-review/opencode-review.mjs:1645-1651`、`2487-2493`；`docs/adr/0190...:78,82`；`test/tooling/opencode-review.test.mjs:3873-3901`
- **问题**：可接受的磁盘存档只有两种：按**当前**清单遮，或**完全不遮登记值**。如果旧存档写于“部分值已登记、之后又新增/删除了一个出现在 prompt 里的值”的时刻，它两者都不等：当前遮法会把新增值也遮掉，全不遮又比旧存档少遮了旧值。ADR 第 82 条说“写于该值登记之前，仍按旧遮盖结果接受”，但第 78 条又说删掉白名单值就不再遮；两种变化（增、删）都会让补跑失败，而测试只覆盖了“旧存档写于空集合”的情况。
- **证据（读代码）**：
  - `(onDisk !== null && onDisk !== maskSecretLike(prompts[model]) && onDisk !== maskSecretLike(prompts[model], { registeredValues: false }))`
  - `const writtenBefore = maskSecretLike(prompt); setRegisteredTestValues([value]); ... expect(run(writtenBefore)).toBe(1);`
- **建议**：补跑时优先用记录里已有的 `promptFileSha256` 与磁盘文件比对（缺这个字段时才退回两种遮盖形式），这样“当时遮成什么”被固定在账本里，不受后续清单增删影响。补“部分登记”和“删值”两个反向用例。

### 低：先遮登记值再跑强规则，可能降低真密钥识别（推测）

- **文件:行**：`scripts/model-review/opencode-review.mjs:2487-2492`
- **问题**：登记值替换发生在 `RECORD_SECRET_RULES` 之前。如果某条真密钥恰好包含一个登记值作为前缀/子串（例如未来的假令牌是某条真令牌的前缀），前面的部分会被换成中文字面量，后续 `github-token`/`openai-api-key` 等规则可能就不再匹配，剩余部分不再被遮。这是推测，现有白名单值触发概率很低，但方向和“安全”目标相反。
- **证据（读代码）**：
  - `let masked = registered ? text.replace(...) : text;`
  - `for (const [id, pattern] of RECORD_SECRET_RULES) masked = masked.replace(...);`
- **建议**：先跑强密钥规则，再遮登记值；或者两者都跑，取覆盖更长的结果。

### 低：ref 不存在时静默跳过，清单格式不对时也不报错（fail-open）

- **文件:行**：`scripts/model-review/opencode-review.mjs:2473-2477`、`2495-2503`
- **问题**：`registerTestValuesFromRefs` 对 `rev-parse` 失败的 ref 直接 `continue`；两个 ref 都不存在时会 `setRegisteredTestValues([])`，静默不遮。`registeredTestValuesFromToml` 对无法识别的文件也只返回空数组。作者的“读不到文件以 `REGISTERED_VALUES_UNREADABLE` 停下”只对“ref 存在但文件不存在”成立。`--assert` 有 `main-ref-missing` 兜底，普通复核里 `origin/main` 失效时则少遮（还有 `--base` 保底），但行为应写清楚。
- **证据（读代码）**：
  - `if (gitStatus(["rev-parse", "--verify", "--quiet", \`${ref}^{commit}\`], repo).status !== 0) continue;`
  - `if (shown.status !== 0) throw new Error(\`REGISTERED_VALUES_UNREADABLE ${ref}\`);`
- **建议**：`--assert`/`--report` 要求至少一个 ref 成功；清单为空时在日志里明确写“未读到任何登记值”；文档把“跳过错 ref”和“文件缺失报错”分开写清楚（ADR 写清了，作者摘要没有）。

### 低：测试覆盖缺口

- **文件:行**：`test/tooling/opencode-review.test.mjs:3873-3901`、`4450-4520`；`scripts/model-review/opencode-review.mjs:2961`
- **问题**：
  - 没有测试 `main()` 在普通过复核路径真的用 `--base` 和 `origin/main` 两处清单；测试都是直接调 `registerTestValuesFromRefs`。
  - “与登记顺序无关”的用例用的值互不重叠；`["registered-te", fakeValue]` 的插入顺序恰好等于排序后的顺序，所以即使实现是“逐个 replace 且不排序”，这两个用例也未必会红。
  - 没有 mixed set / 删值后的补跑用例。
  - `loadRegisteredTestValues(process.cwd(), "HEAD")` 硬编码了仓库当前两条白名单值；按 ADR 0177 清理白名单时这个测试会误报。
- **建议**：补 `main()` 接线、反序重叠值、mixed set/删值、`--report` 路径的用例；把对真实清单的断言改成“能在当前清单里找到至少一个”，或固定到测试自己造的文件。

---

## 侧重检查

- **错误路径**：`REGISTERED_VALUES_UNREADABLE` 只在 ref 能解析、文件缺失时抛；ref 不存在静默跳过（可接受但需文档明确，见上）。`--main-ref` 缺失由 `assertReviewed` 的 `main-ref-missing` 兜底。
- **不可信输入**：`--base`、`--main-ref` 都通过 `execFile` 传给 git，没有 shell 注入；`--main-ref` 校验了不能以 `-` 开头，`--base` 没有，但 `git rev-parse`/`git show` 收到非法选项只会失败。清单里的值只进 `RegExp` 前被转义，值本身只含字面字符集，未见 ReDoS 风险。
- **安全**：主要风险是“先遮登记值再跑强规则”的顺序（推测）和全局误遮（见上）。合并门本身比 gitleaks 更严，可能拒绝已被 gitleaks 路径白名单放行的记录。
- **资源耗尽**：清单很小，正则交替是字面量拼接，未发现明显资源问题。
- **不可撤销操作**：遮盖会永久抹掉记录里的原文；对非密钥值（探针参数、幂等键、摘要）这样做损失的是证据，而原始输出只在临时目录，不保证还能找回。
- **文档与代码一致性**：
  - ADR 0190:52“老记录不改” vs :81“手工改成遮盖写法”矛盾。
  - ADR 0190:80“改成遮盖写法再提交即可”与 `check-gitleaks.mjs:71` 及全历史扫描矛盾。
  - `.agents/instructions/model-review.md:92` 说补跑“按同样规则遮盖后再比”，代码实际接受两种形式（`:1645-1651`）。
  - 作者摘要说“从 `--base` 读”，代码在普通复核里还并了 `origin/main`（ADR 写对了）。
  - 作者摘要说“读不到文件以 `REGISTERED_VALUES_UNREADABLE` 停下”，代码对不存在的 ref 是跳过。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。提示词原件在 `scripts/model-review/opencode-review.mjs:3087` 传给 `reviewModel`，遮盖只发生在 `:3079` 写 `<模型>.prompt.md` 时；`buildPrompt`（`:277-306`）只用 brief、questions 和提交号，不读已写记录。复核副本还排除了 `.agents/reviews/`（`:2390`），模型也读不到这些存档。所以发给模型的内容没有变，追加结构也没有变；变的只是仓库里的提示词存档，它不是发给模型的那一条。符合 `.claude/rules/prompt-prefix.md` 第 4、5 条。`roundForRun` 的兼容逻辑只影响“是否接受旧存档”，不影响请求字节。

**2. 同一段文字会不会在不同请求里变成不同字节？**
在同一份登记集合、同一输入下是确定的：`setRegisteredTestValues` 去重后按“长度降序、字典序”排序（`:2457-2461`），`registeredValuesPattern` 生成一个交替正则、一次 `replace`（`:2479-2485`），与登记顺序无关。没有时间字段，也没有未排序集合。但**集合本身**来自 `--base` 和 `origin/main`，会随 main 前进/回退变化，所以同一段记录文字在不同时间可能遮出不同字节；这只影响写进仓库的记录和补跑校验，不影响发给模型的请求。

**3. 有没有自动检查，反向用例是否真的会失败？**
有，且部分反向用例是真的：合并门拒绝未遮盖记录、接受遮盖版（`test:2694-2711`）；补跑接受旧存档、拒绝改动的文件（`test:3873-3901`）；多 ref 并集、跳过不存在 ref、文件缺失抛错（`test:4478-4516`）。去掉对应实现，这些断言会失败。但覆盖不完整：没有 `main()` 接线测试、没有 mixed set/删值补跑、没有反序重叠值的确定性测试、没有 `--report` 路径测试；而且新测试能失败很大程度是因为它们导入了新函数，旧代码直接 import 失败，不能算精细的反向证明。

**4. 改动产生/修改的每个值，使用它的地方都能接受吗？**
- `registeredTestValues`：由 `registeredTestValuesFromToml` 过滤后产生，`setRegisteredTestValues` 只去重排序、不再次校验；生产入口只有解析器，测试可以直接塞任意值。消费方 `maskSecretLike`、`secretLikeRules`、`registeredValuesPattern` 都能接受字符串。
- `registered-test-value` 这个规则 id：用于替换文本和 `record-secret-like` 输出；仓库里没有消费方拿它去对照 `RECORD_SECRET_RULES`（`:2598-2616` 的同步测试只覆盖 `RECORD_SECRET_RULES`），所以能接受。
- 遮盖后的提示词/答案/报错/账本：字符集排除了引号、反斜杠、换行，`recordText` 和 `JSON.stringify` 都能接受；`delegate.mjs check` 用写盘时记下的 `promptFileSha256` 核对，也一致。
- **不能接受的两处**：`roundForRun` 不接受“部分登记”的旧存档（见中等问题）；如果某条登记值恰好是占位符 `[已遮盖:registered-test-value]` 的子串，`secretLikeRules` 会对已遮盖记录再次报 `registered-test-value`，形成自锁（当前清单没有这种值，属推测）。另外，路径限定的 gitleaks 值被全局应用，是 I-73 那种“产生方范围和消费方校验口径不一致”的同类问题。

---

## 未核实

- PR 322 自己的 round-1 记录里是否还残留原值：`git show` 被仓库的 records-path 守卫拒绝（`REVIEW_GIT_REFUSED`），无法读取，未核实。
- PR 319 分支当前是否还在活动、是否会再次跑合并门：未核实。
- PR 321 是否真的与 `assertReviewed` 附近不重叠：未核实。
- 以上对 gitleaks 历史扫描和 CI 的判断来自读 `scripts/ci/check-security.mjs`、`scripts/check-gitleaks.mjs`，没有实际运行 CI。
