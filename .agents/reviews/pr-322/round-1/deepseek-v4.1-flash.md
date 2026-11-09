# 复核结论

说明：以下“证实的”都来自我亲自读到的代码/文档；“推测/未核实”单列。未运行任何测试（本轮只能用 read/grep/glob 与 git 查看）。

## 一、读代码证实的发现

### 1. 高：写记录与合并门从不同版本读清单，会让已有记录自锁，且不能 override
- 文件:行：`scripts/model-review/opencode-review.mjs:2943`、`:2925-2927`、`:2527-2535`、`:1252-1259`
- 问题：普通复核用 `--base` 的清单遮记录，`--assert-reviewed` 却用 `--main-ref` 的清单查记录。若某个值是在 PR 分支点之后才在 main 登记（或分支一直沿用旧 `--base`），记录写时不会遮它，合并门却会把它报成 `record-secret-like`；`record-secret-like` 不在 `OVERRIDABLE_PROBLEMS` 里，`--accept-unreviewed` 也放不过。对“本 PR 目录下已提交的记录”，`recordSecretProblems` 每次都会检查整个目录（含旧的 `.attempt-*`），所以已有记录可能被追溯拒绝，而 ADR 又禁止改写已推送历史。
- 证据：
  - 普通路径：`setRegisteredTestValues(loadRegisteredTestValues(options.repo, commits.base ?? commits.head));`（:2943）
  - 合并门路径：`setRegisteredTestValues(loadRegisteredTestValues(options.repo, options.mainRef ?? "origin/main"));`（:2925-2927）
  - 门检查整个 PR 记录目录：`gitStatus(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ledgerPath], repo)`（:2528）
  - 命中即报且不可 override：`for (const id of secretLikeRules(shown.stdout)) problems.push(\`record-secret-like ...\`)`（:2521-2522）；`OVERRIDABLE_PROBLEMS` 中没有它（:1252-1259）
- 建议：让“写”和“门”只用同一个清单来源。可选：
  - 普通复核也接受并统一使用同一个 ref（例如新增 `--rules-ref`，默认与门一致），或
  - 每轮账本记录清单来源/摘要（`rulesRef`/`rulesSha256`），门按该轮记录里的来源重算；或
  - 门只检查本 PR 新增/修改的记录文件，对 main 上已存在的旧记录豁免。
  另外要补一个“base 无此值、main 有”的测试。

### 2. 中：`--report` 完全不加载清单，报告和真正的合并门结论会不一致
- 文件:行：`scripts/model-review/opencode-review.mjs:2920-2923`、`:1435`、`:2521`
- 问题：`main()` 在处理 `--report` 时直接 `return`，从未调用 `setRegisteredTestValues`；`reviewReport` 内部又调用 `assertReviewed`，后者用当前全局清单（默认空）检查记录。于是同一个提交下，`--report` 可能打印 `REVIEW_CURRENT`，而 `--assert-reviewed` 会报 `record-secret-like`；`--report` 的 `no-error` 自洽判断也可能因此通过。文档明确要求把 `--report` 的“第 6 步检查结果”原样贴进汇报。
- 证据：
  - `if (options.report) { for (const line of reviewReport(options)) console.log(line); return; }`（:2920-2923）
  - `const gate = assertReviewed({ repo, pr, mainRef });`（:1435）
  - 记录检查只在 `secretLikeRules` 里看当前全局清单（:2521）
- 建议：在 `--report` 分支之前也执行同样的 `loadRegisteredTestValues(..., options.mainRef ?? "origin/main")`；更稳妥的是把加载放进 `assertReviewed` 内部，让所有调用方（含测试和 report）自动一致。补 CLI 级测试。

### 3. 中：清单解析范围与文档承诺不一致：既会多读非密钥值，也会漏掉合法格式，且“本 PR 新加的白名单”当下不生效
- 文件:行：`scripts/model-review/opencode-review.mjs:2461-2468`、`:2943`；`docs/adr/0190-mask-registered-test-values-in-review-records.md:49-54`
- 问题：
  - 解析正则只认“单行、单元素、三单引号”的 `regexes = ['''^…$''']`，不检查 `targetRules`、`regexTarget`、`paths`、`condition`。因此：
    - 多行数组、单/双引号、带尾逗号或行尾注释、一个数组里多个正则的新白名单会被静默漏掉（“以后谁再给 Gitleaks 加了精确值白名单，复核记录自动不再带出它”不成立）。
    - 反过来，任何字面量通过字符集检查的非密钥值也会被当作“registered-test-value”。当前 `ci/rules/gitleaks.toml` 里就有“tmpfs 参数、不是密钥”（:62-68）、幂等键（:86-92）、文件摘要（:94-100）这类条目；它们会进入遮盖与 `record-secret-like`，让人工写的 `judgments.md`/`verdicts.jsonl` 被不可覆盖地拒绝。
  - 普通复核从 `--base` 读清单，而新增白名单的 PR 在合并前 base 里没有该块，所以“登记之后以后的记录就不会再带出它”对“登记它的那个 PR”本身不成立；该 PR 的模型一旦引用新值，记录仍不会被遮。
- 证据：
  - `for (const match of text.matchAll(/^regexes\s*=\s*\[\s*\'\'\'\^([^\n]*?)\$\'\'\'\s*\]\s*$/gm))`（:2463）
  - `if (literal.length >= REGISTERED_VALUE_MIN_LENGTH && /^[A-Za-z0-9_\-=.:/ ]+$/.test(literal))`（:2465）
  - 普通路径只读 base：`loadRegisteredTestValues(options.repo, commits.base ?? commits.head)`（:2943）
  - ADR 承诺：“以后谁再给 Gitleaks 加了精确值白名单，复核记录自动不再带出它”（ADR 0190:49）
- 建议：用真正的 TOML 解析器读取 `[[allowlists]]`，显式要求 `condition="AND"`、`targetRules`、`regexTarget="secret"`、`paths` 唯一、`regexes` 唯一且是精确字面量；对不符合形状的条目“报错/记录并测试”，不要静默跳过。对“登记它的 PR”，要么同时读 head 的清单并接受相应风险，要么在 ADR 里明确第一批仍需人工处理。“已登记的测试假值”与“所有精确值白名单”也应统一措辞。

### 4. 中：ADR 说“答案和判断都经同一遮盖”与代码不符
- 文件:行：`docs/adr/0190-mask-registered-test-values-in-review-records.md:80`；`scripts/model-review/opencode-review.mjs:3076`、`:1138`、`:2528`
- 问题：脚本只遮自己写的提示词、答案、报错和账本；`verdicts.jsonl`、`judgments.md` 由线程手写，没有任何自动遮盖。新增的 `record-secret-like` 却会检查这些文件；`lowFixProblems` 又要求 `verdict.quote` 能在已遮盖的 `<模型>.md` 里逐字找到。若线程不从遮盖后的答案抄 quote，或 judgments 里引用了原值，就会分别出现 `quote-not-found` 或不可覆盖的 `record-secret-like`。
- 证据：
  - ADR：“答案和判断都经同一遮盖，所以仍然能对上。”（:80）
  - 答案写入时才遮：`writeFileSync(join(roundDir, \`${name}.md\`), maskedRecordText(summary.text));`（:3076）
  - quote 必须逐字命中已落盘答案：`if (!answers.get(verdict.model)?.includes(verdict.quote)) problems.push(...)`（:1138）
  - 门检查 PR 目录全部文件（:2528）
- 建议：明确 `verdicts.jsonl`/`judgments.md` 的 quote 必须从遮盖后的 `.md` 复制；或在门的检查/解析路径对这两个文件应用同一 `maskSecretLike` 后再比对。把 ADR 的措辞改成实际行为（“答案经遮盖；判断由线程从遮盖后的答案复制”）。

### 5. 低：旧轮次补跑可能因提示词存档的遮盖口径变化而报 `ROUND_PROMPT_MISMATCH`
- 文件:行：`scripts/model-review/opencode-review.mjs:1645-1649`、`:3061`、`:2943`
- 问题：`roundForRun` 用“磁盘上的旧提示词存档”与“现在按新清单重新遮盖的提示词”逐字比较。旧存档只经过旧的规则；如果提示词/材料里包含现在已登记的值，重新遮盖后字节不同，补跑会被拒绝。ADR 只说明请求头不受影响，没有说明这个迁移期影响。
- 证据：
  - `(onDisk !== null && onDisk !== maskSecretLike(prompts[model]))`（:1646）
  - 存档写入：`writeFileSync(join(roundDir, promptFileName(model)), maskSecretLike(prompt));`（:3061）
- 建议：比较时优先用未遮盖的 `promptSha256`，或在存档缺少新规则时给一次兼容回退并记录；在文档/测试里覆盖“旧存档 + 新清单”的情况。

### 6. 低：`main-ref-missing` 会被 `REGISTERED_VALUES_UNREADABLE` 抢先吞掉
- 文件:行：`scripts/model-review/opencode-review.mjs:2471-2475`、`:2925-2927`、`:1317-1320`
- 问题：`--assert-reviewed` 在 `assertReviewed` 校验 ref 是否存在之前就调用 `git show <mainRef>:ci/rules/gitleaks.toml`。当 `origin/main` 不存在时，得到的是 `REGISTERED_VALUES_UNREADABLE origin/main`（退出码 2），而不是文档承诺的 `REVIEW_NOT_CURRENT ... main-ref-missing`（退出码 5）。`--report` 又完全不读文件，所以同一缺失条件下两个子命令行为不同。
- 证据：
  - `const shown = gitStatus(["show", \`${ref}:ci/rules/gitleaks.toml\`], repo); if (shown.status !== 0) throw new Error(\`REGISTERED_VALUES_UNREADABLE ${ref}\`);`（:2472-2473）
  - 先加载再校验：:2925-2927
  - 原本的诊断：`problems.push(\`main-ref-missing ...\`)` / `main-not-merged`（:1317-1320）
- 建议：先校验 `mainRef` 是提交，再读文件；或把“ref 不存在”和“文件读不到”拆成两个错误码，并统一 report/assert 的行为。

### 7. 低：测试覆盖不足，反向用例有一条是同义反复
- 文件:行：`test/tooling/opencode-review.test.mjs:4402-4408`、`:4377-4381`、`:2652`
- 问题：
  - “与登记顺序无关”的用例先调用会排序的 `setRegisteredTestValues`，再把输入反转后调用一次同样会排序的函数，所以即使删掉排序也照样通过；它没有构造重叠值，测不到真正的替换顺序问题。
  - 没有端到端测试证明“已提交记录包含已登记值 → `recordSecretProblems`/`assertReviewed` 报 `record-secret-like`”；当前 merge-gate fixture 的 `gitleaks.toml` 是空串（:2652），所以测不到。
  - 没有 `--report` 的 CLI 测试；没有多行/单双引号等格式变体；没有“非密钥的精确白名单值”用例。
  - `finds the values the repository's own allowlist registers` 绑定了当前 gitleaks 的具体条目，未来按 ADR 0177 清理白名单时会误伤测试。
- 证据：
  - `expect(registeredTestValuesFromToml(toml).sort())...` 与 `setRegisteredTestValues([...].reverse())`（:4377-4379、:4405-4408）；`setRegisteredTestValues` 内部 `sort`（:2455-2458）
  - 空清单的 merge-gate fixture（:2652）
- 建议：增加：真实提交记录含登记值 → 门拒绝；`--report` 与 `--assert-reviewed` 结论一致；base/main 清单不一致；格式变体；重叠值；非密钥值。顺序测试应直接测 `maskSecretLike` 对一个不受排序保障的输入的处理，或至少放入互相重叠的登记值。

### 8. 低：文档说只从 `--base`/`--main-ref` 读，实际 plan/plan-review 会退回 `--head`
- 文件:行：`scripts/model-review/opencode-review.mjs:2697`、`:2943`；`docs/adr/0190-mask-registered-test-values-in-review-records.md:50`
- 问题：`--base` 只在 code-review 模式必填；plan/plan-review 可省略，省略时清单从 `commits.head`（就是被复核的提交）读。这与 ADR “不从被复核的改动读，免得改动自己改掉清单”的绝对说法不一致，也给方案类复核留下“用被审改动自己的 gitleaks.toml”的口子。
- 证据：
  - `if (options.mode === "code-review" && !options.base) throw new Error("ARG_REQUIRED --base");`（:2697）
  - `loadRegisteredTestValues(options.repo, commits.base ?? commits.head)`（:2943）
- 建议：在 ADR 和 model-review.md 写清“没有 `--base` 时从 head 读”的例外，或让所有模式都要求一个明确的规则 ref；不要用一个可能受被审改动影响的默认值。

## 二、推测 / 未核实

- **未核实**：现存各 PR 的 `.agents/reviews/` 里是否真的有记录包含当前已登记的值。当前稀疏检出没有该目录，无法逐个核对；上面第 1 条的“自锁”是机制上会发生，具体到某个开放 PR 是否触发取决于其记录内容。
- **未核实**：作者说“PR 321 在 `assertReviewed` 附近，与本 PR 不重叠”。本仓库只看到当前提交，无法查看另一个线程的 PR。
- **推测**：实际团队在用 `--base` 时，合并 main 后是否会更新到新的 main。若会更新，第 1 条触发概率下降；若一直保留分叉点（文档现在的说法是“分叉点提交”），触发概率明显上升。
- **推测**：第 3 条里“非密钥值被门拒绝”能否在日常中触发，取决于线程是否在 `judgments.md` 里手抄这些参数值；机制上可触发，实际频率未核实。

## 三、侧重检查（错误路径、不可信输入、安全、资源、不可撤销、文档一致性）

- **错误路径**：清单文件读不到时会 `throw`，在 `main()` 顶层转成退出码 2，属于 fail-closed，方向正确；但 `--report` 不走这条路径（发现 2），且 ref 缺失被误报成文件不可读（发现 6）。
- **不可信输入**：`--main-ref` 拒绝开头的 `-` 和控制字符，`--base` 会经 `git rev-parse` 解析为提交；`spawnSync` 用参数数组、不经 shell，`replaceAll`/`includes` 用字面量，不发生正则注入。风险主要是 TOML 解析用正则而非解析器，以及 plan 模式退回到被审提交（发现 3、8）。
- **安全**：登记值替换发生在 `RECORD_SECRET_RULES` 之前。若某个真实密钥恰好包含一个登记字面量，先替换可能破坏后面密钥规则的最小长度匹配，留下前缀片段；当前登记值都是特定假值，概率低。另 `maskSecretLikeDeep` 会遮账本的 `head`/`from` 等结构字段，理论上字面量落在提交哈希里会破坏 `parseUsage` 校验，概率极低，但属于“遮结构字段”的固有风险。
- **资源耗尽**：`git show` 用 256MB `maxBuffer`，解析正则按行线性；`replaceAll` 是“登记值个数 × 文本长度”。当前十几条、记录不大，无问题；没有对单个值最大长度和条目数量的校验，若 base 的 `gitleaks.toml` 被异常放大，会放大耗时/内存。
- **不可撤销**：记录写入仓库后难以改写。第 1 条的“写时用旧清单、门用新清单”会让本来已提交的记录永久过不了且不能 override；第 3 条的过度/不足遮盖也会写进历史。方向应是“先确定单一只读来源，再落盘”。
- **规则/文档一致性**：ADR 0190 与 0177 的 `amends`/`amended_by` 双向一致，文件名通过 `scripts/check-adr-numbers.mjs` 的“四位编号-小写短名”规则；`ci/rules/gitleaks.toml` 未改，所以不需要同步 `ci/toolchain-lock.json` 摘要。不一致处集中在发现 1、3、4、8：清单来源、解析范围、`verdicts.jsonl` 是否遮盖、plan 模式退回 head。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个改动没有进入 `buildPrompt`，`maskSecretLike` 只用于写记录、摘要、账本和 `roundForRun` 的比较（grep 可见调用点只有 :1284、:1290、:1646、:3061、:3076、:3088、:3121）。发给模型的 `prompt` 仍是原文，`setRegisteredTestValues` 只影响落盘。模型看到的内容仍然只在末尾追加；本轮没有新增任何“每轮会变”的字段。唯一的副作用是旧轮次补跑的存档比较会变（发现 5），但那发生在发送之前。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会因为“请求”而不同：清单在每次运行开始时一次性载入，`setRegisteredTestValues` 去重后按长度降序、再按字典序排序（:2455-2458），替换是纯字面量、无时间/随机/上下文依赖，所以同一进程内同一清单对同一文本输出稳定，和登记顺序无关。需要注意两点：
   - **不同路径可能不同**：普通写记录用 `--base`，门/报告用 `--main-ref`，同一文本在两处可能遮出不同字节（发现 1、2）。
   - 重叠的登记值只靠“长度优先”处理，不是一般的并集算法；当前清单没有这种重叠，但对任意新名单不保证遮盖完整（发现 3、7）。

3. **有没有自动检查，反向用例真的会失败吗？**
   有单元测试（解析、遮盖、`secretLikeRules`、不可读时报错、读取仓库自身清单），merge-gate fixture 也补了 `ci/rules/gitleaks.toml`。但反向覆盖不足：
   - 没有端到端“记录含登记值 → 门报 `record-secret-like`”的用例；
   - 没有 `--report` 与 `--assert-reviewed` 一致性的用例；
   - 没有 base/main 清单不一致的用例；
   - “顺序无关”用例是同义反复（先排序再反转再排序），删掉排序也会通过；
   - 没有多行/单双引号等格式变体和“非密钥值”用例。
   因此现有测试能证明“解析和遮盖函数的基本行为”，不能证明问题清单里最关键的“合并门自锁/两路径一致”不会发生。

4. **每个新值的产生处与使用处是否都能接受？**
   - `registered-test-value`：产生于 `maskSecretLike`（:2480），消费于 `secretLikeRules`/`record-secret-like`（:2491、:2522）。门只把它拼进自由文本，不做规则 id 白名单校验，格式可接受；但它是否被加载取决于调用路径，`--report` 漏加载（发现 2）。
   - `registeredTestValues`：产生于解析器，消费于 `maskSecretLike`（含 `maskSecretLikeDeep` 的账本字段）和 `secretLikeRules`。写与门使用不同来源，账本的 `head`/`from`/`files`/`findings` 两端校验可能不一致（发现 1）；没有值长度上限和结构字段豁免（侧重检查）。
   - `REGISTERED_VALUES_UNREADABLE`：产生于 `loadRegisteredTestValues`（:2473），消费于顶层 `catch`（:3189-3191）和测试。顶层能接受任意错误文本；但它抢占了 `main-ref-missing` 的诊断（发现 6）。
   - `ci/rules/gitleaks.toml` 清单项：本 PR 未改该文件，故不需要改 `ci/toolchain-lock.json`；但解析器只认其中一种写法，未来符合 ADR 0177 但换一种排版的清单项会被静默漏掉（发现 3）。
   - ADR 元数据/文件名：`amends`/`amended_by` 双向一致，`check-adr-numbers` 可接受。

**整体建议**：把“清单来自哪个 ref”变成单一、显式、可记录的值（账本每轮记 `rulesRef`/`rulesSha256`，写和门共用），用真正的 TOML 解析器读取并校验白名单形状，把 `--report` 纳入同一加载路径，补上“记录含登记值→门拒绝”“base/main 不一致”“旧存档补跑”三类测试。这样比现在“写用 base、门用 main、解析靠单行正则”的方案更可验证，也不会在已有记录上自锁。
