# 审核结论

方案的目标（让 Mac 线程用上 himawari-cloud 的出口代理和 Magpie）是成立的，但当前设计把“执行复核”交给一个**不受沙箱约束、能写仓库和推分支的云端 Claude 会话**，再用事后检查兜底。这是最大的问题：它把原本“复核模型在一次性容器里只读代码”的安全模型，换成了“另一个 LLM 可以直接改共享分支”。建议改成“确定性远程任务 + 独立结果引用/工件交接 + 可信检查器”，并补上 brief 哈希、账本只追加、gateway 字段核验和反向测试。

---

## 一、证实的发现（按严重度）

### 高

**1. 云端线程是 LLM，却直接写共享 PR 分支；`--check-result` 是事后检查，拦不住已推送的代码和强推。**
- 证据：方案 §4“云端线程：只跑复核、只提交记录、只回消息”、§风险“只提交记录目录这条靠任务说明约束，Mac 线程拉取后用 `--check-result` 核对，不对就不采用”；`AGENTS.md:106-109` 规定每个提交立即推送；`AGENTS.md:7` CI 在每次推送后运行；`.agents/instructions/model-review.md:76` 说明现有复核的安全假设是“跑在用完即删的云端容器里”，而委派的云端线程不是那个容器；`.agents/handoffs/2026-11-05-opencode-review-findings.md:79` 记录同一类云端容器里实测到 `GITHUB_TOKEN`、`HTTPS_PROXY` 等变量名。
- 后果：云端线程（或被 brief/代码提示注入）可以在 Mac 线程核对前把任意代码推上分支，CI 会先跑；强推还会让 `--from` 提交从分支上消失，事后检查无法恢复。业界的做法是给自动化任务最小权限的令牌，而不是共享写权限（GitHub 官方文档：<https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication>、<https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#permissions>）。
- 建议：不要让云端线程写 PR 分支。让它写独立结果引用（如 `refs/review/<id>`）或结果分支，令牌只允许推这个引用；Mac 线程 fetch 结果引用，校验后 cherry-pick/合并记录目录。若必须写 PR 分支，至少拒绝非快进推送、校验 `--from` 是祖先，并去掉云端线程的强推/删分支权限。

**2. brief 从工作区读取，云端线程可以改；没有内容哈希核验。**
- 证据：`scripts/model-review/opencode-review.mjs:2787` `const brief = recordText(readFileSync(options.brief, "utf8"));`；`prepareCopy` 在 `2353` 才把 `.agents/reviews/` 从复核副本排除，而 brief 在这之前已经读入；方案 §2 把 brief 放在 `.agents/reviews/<目录>/briefs/`，正是云端线程有写权限的目录；方案 §4 的 `--check-result` 只核对 `head`、`mode`、`round`，没有 brief 哈希。
- 后果：云端线程可以把 brief 改成任意内容发给外部复核模型，运行后 `git checkout -- <brief>`，提交的 diff 里看不出异常。这是提示注入/数据外泄的直接通道（OWASP LLM01：<https://genai.owasp.org/llm-top-10/>）。
- 建议：把 brief 作为 `--head` 里的已提交 blob 读取（`git show <head>:<path>`，参见 <https://git-scm.com/docs/git-hash-object>），任务说明里写 `briefSha256`，`--check-result` 用 `git hash-object` 核对；要求工作区干净（`git status --porcelain` 为空）且 `HEAD` 是 40/64 位提交哈希，而不是分支名。

**3. `--check-result` 只验路径和部分字段，账本可伪造/改写；`--require-gateway` 可被绕过。**
- 证据：`opencode-review.mjs:1231-1235` 的 `changedOutside` 只按路径前缀过滤；`1237-1241` 的 `assertReviewed` 只读 HEAD 的 `usage.jsonl`；`1147-1187` 的 `coveragePoints` 只看 ledger 里的 `outcome`/`model`，不检查 `<model>.md`/`.prompt.md` 是否存在；`2568-2590` 的 `gatewayRecordFields` 只在经 Magpie 时写 `gateway` 字段，而方案的 `--check-result` 没有要求 `gateway === "magpie"`。
- 后果：云端线程可以改写旧账本行、只写一条伪造的 `outcome: ok`、或者不带 `--require-gateway` 直接直连，仍可能通过 Mac 的核对。`--assert-reviewed` 本身也不验证模型答案文件。
- 建议：`--check-result` 必须验证：
  (a) `--from` 是新 HEAD 的祖先（拒绝强推）；
  (b) 旧 `usage.jsonl` 是新文件的逐字节前缀（只追加，不能改写/删除/重排）；
  (c) 新文件在白名单内且都是普通文件（拒绝符号链接、可执行位、额外文件）；
  (d) 每个预期模型都有 `round-N/<model>.md`、`.prompt.md` 和对应的 ledger 记录，`head`/`mode`/`round`/`models`/`outcome` 一致；
  (e) 每条新记录 `gateway: "magpie"`、`providers` 在允许集合内、`cost` 不超过批准额；
  (f) brief 和 prompt 的 SHA-256 一致，`.prompt.md` 里的 brief 与 brief blob 逐字节一致。
  `--assert-reviewed` 也应至少检查答案文件存在。

**4. brief 的提交顺序与第 0 步冲突：提交 brief 后分支头不再是 `--head`。**
- 证据：方案 §2“先把材料提交进分支 `.agents/reviews/<目录>/briefs/<要复核的提交前 12 位>-<模式>.md`”；第 0 步“`git fetch` 后分支头必须正好是 `--head` 那个提交”；`opencode-review.mjs:2342-2345` 的 `resolveCommits` 把 ref 解析成当时的提交。若 brief 在代码提交之后提交，分支头已不是代码提交；若 `--head` 用 brief 提交，brief 文件名又指向父提交。方案没有说清 `--head` 是哪一次提交。
- 建议：明确 `--head` = 包含 brief 的提交（即 brief 提交），brief 文件名用父提交（被复核的代码提交）；或者先提交 brief，再提交代码，`--head` = 代码提交。任务说明和 `--check-result` 都用解析后的 40/64 位哈希，不用分支名。

### 中

**5. 云端会话费用不进账本、不受先问门槛，可能让单轮总花费静默超过 1 美元。**
- 证据：`.agents/instructions/model-review.md:37`“其他花钱仍按 0.5 美元先问”；`model-review.md:105` 预算检查只读 `usage.jsonl`；`opencode-review.mjs:1012-1026` 的 `budgetCheck` 只读 ledger，`2798-2807` 调用；方案 §6“每次交出去会多开一个云端会话……约 0.4 到 1.1 美元……不进复核账本”。
- 建议：把云端会话的预估费用加进“这一个 PR 的复核累计费用”再问 Andy；或为委派单独设 0.5 美元先问线，并在 `--report` 里列出。不要让 0.4-1.1 美元的隐藏成本绕过 1 美元门槛。

**6. `--require-gateway` 的代理检查只看 `HTTPS_PROXY`，和脚本现有代理名单不一致。**
- 证据：`opencode-review.mjs:596` `PROXY_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]`，`598-602` 的 `proxyCredentialProblems` 也读这四个；`model-review.md:75` 明确代理地址包括大小写写法；`handoffs/2026-11-05-opencode-review-findings.md:79` 云端容器里确实有 `HTTPS_PROXY`。方案 §3 只写“`HTTPS_PROXY` 为空”。
- 后果：云端若只用 `https_proxy`/`HTTP_PROXY`，会被误拒；反之，一个非代理的 `HTTPS_PROXY` 值也会放行。
- 建议：用 `PROXY_ENV.some((name) => (process.env[name] ?? "").trim())`；同时不要只靠代理存在，最终以 Magpie 预检的 `GATEWAY_PREFLIGHT_FAILED`/服务方错误为准；在任务里写明需要的环境变量名。

**7. `--check-result` 没有任何自动测试；反向用例不完整。**
- 证据：方案 §7 只列了 `delegation-prompt.mjs` 生成和 `--require-gateway` 的测试；`--check-result` 是 §4 的核心防线，却没有测试。`.claude/rules/incident-gates.md:4` 要求每个事故/风险有自动检查；`AGENTS.md:38` 同样要求。
- 建议：用临时 git 仓库测试：云端提交改代码文件 → 拒绝；改写旧 `usage.jsonl` 一行 → 拒绝；加符号链接/额外文件 → 拒绝；`head`/`mode`/`round`/`models` 任一不符 → 拒绝；`--from` 不是祖先（强推）→ 拒绝；`gateway` 不是 `magpie` → 拒绝；brief 哈希不符 → 拒绝。`--require-gateway` 的测试要断言：`HIMAWARI_REVIEW_GATEWAY=direct`、`--gateway direct`、无代理、只有小写 `https_proxy` 时都按预期处理，并且失败时不写 `usage.jsonl`、不安装。

**8. `--branch`/`--reply-to`/`--from` 未校验，直接进任务说明和命令。**
- 证据：现有 `--main-ref` 在 `opencode-review.mjs:2462-2465` 拒绝以 `-` 开头和控制字符；新增参数没有类似规则。方案 §2 把 `--branch`、`--reply-to` 写进任务说明；§4 的 `--from` 用于 git 命令。Git 分支名允许 `;`、`&`、`$`、反引号等字符（见 <https://git-scm.com/docs/git-check-ref-format>），拼进命令有注入风险。
- 建议：`--branch` 用 `git check-ref-format --branch` 或保守正则，生成命令时加引号；`--from` 按 `--main-ref` 的规则校验并加 `--`；`--reply-to` 限定为应用会话 id 的格式（如 `session_[A-Za-z0-9]+`）且不含控制字符；brief 路径 `realpath` 后必须在 `.agents/reviews/<目录>/briefs/` 下。

**9. 方案改变了 Mac 的默认行为，但没有改现有规则第 130 行，规则会自相矛盾。**
- 证据：`model-review.md:130`“Mac 上没有出口代理代填凭证，不设这个变量，照旧直连”；方案 §1“Mac 线程……一律交给 himawari-cloud……只有 Andy 说‘直连 Go’时才在 Mac 上直连”；§8 只说新增一节和补一句，没有说改第 130 行。
- 建议：如果确实要改默认，明确改第 130 行并写 ADR/Andy 原话；否则保留“Mac 默认直连 Go，只有需要 Magpie 时才委派”，这样也避免每次方案讨论都多开一个云端会话。

**10. `--check-result` 从拉下来的新 HEAD 运行，可能执行云端改过的检查脚本。**
- 证据：方案 §4“收到 DONE 后拉分支，先用新命令 `node scripts/model-review/delegation-prompt.mjs --check-result ...`”；脚本在仓库里，云端线程有提交权。
- 建议：从 `--from` 那个提交运行检查器（`git show <from>:scripts/...` 到临时文件，或另开一个只读 checkout），并核对脚本 blob 的 SHA-256；不要从被检查的 HEAD 运行检查器。

**11. 45 分钟等待与 25 分钟脚本超时之间没有心跳/状态检查，可能重复委派、重复花钱。**
- 证据：`opencode-review.mjs:2428` 默认 `timeoutMinutes: 25`，两个模型并行；首次运行还要安装 opencode/Magpie（`model-review.md:80,138`）；方案 §5 说 45 分钟没消息就 fetch 分支。
- 建议：云端线程一开始发 `DELEGATED_REVIEW_STARTED`，每 5-10 分钟发心跳；Mac 线程超时后先查云端会话状态再决定是否重派；超时值至少覆盖“安装 + 25 分钟 + 推送”的最坏情况。用一个 lock/lease 防止重复。

**12. §2 与 §7 对任务说明是否包含材料全文自相矛盾，影响“逐字节一致”。**
- 证据：方案 §2“任务说明只写这个路径”；§7“生成的任务说明包含……材料全文”；`opencode-review.mjs:2787` 读文件，`2391-2393` 的 `recordText` 会规范化换行和行尾空格。
- 建议：只保留一个来源：brief 提交进仓库，任务说明只写路径 + SHA-256；不要在两处复制全文。测试要比较发送到复核模型的 prompt 里的 brief 与提交 blob 逐字节一致。

**13. 没有锁；“一次只有一个 Mac 线程交出一个复核”是假设。**
- 证据：方案“比较过、没采用的”说“现在一次只有一个 Mac 线程交出一个复核”；仓库里同时有协调者、Mac 线程、云端线程（`AGENTS.md:27`、`model-review.md:4`）。两个委派会各自通过第 0 步，最后只有一个 push 成功，另一个白花钱。
- 建议：在结果引用上做锁/租约（`refs/review/lock` 或环境锁），同一 PR/同一 head 只允许一个委派；或采用独立结果引用方案，让重复执行变成可检测的冲突。

**14. `--approved-usd`/`--providers` 只靠“云端线程不得自己加参数”约束，没有技术核验。**
- 证据：方案 §2“预算……由 Mac 线程……写进命令；云端线程不得自己加参数”；§4 `--check-result` 只核 `head`/`mode`/`round`；账本有 `providers` 和 `cost` 字段（`model-review.md:141`）。
- 建议：任务说明里写预期 `approvedUsd`、`providers`、`models`；`--check-result` 核验新记录的 `providers`、`cost` 不超过预期；`--require-gateway` 和 `gateway: magpie` 一起核验。

### 低

**15. 前提 1 的行号差一行。** `model-review.md:42` 是“报告 Andy 时……”，合并前核对在 `43` 行。方案前提 1 写“第 42 行起”。建议改成 43 行，所有前提统一“文件:行 + 原话”。

**16. `--brief` 的相对路径基准是进程 cwd，不是 `--repo`。** 证据：`opencode-review.mjs:2446` `options.brief = resolve(take())`；`2787` 直接读。建议要求从仓库根运行，或按 `options.repo` 解析，否则云端线程在子目录运行时是 ENOENT，不是干净的 `GATEWAY_REQUIRED`。

**17. `DELEGATED_REVIEW_DONE` 消息格式没有机器可读规范/测试。** 方案 §4 说消息包含 `REVIEW_RESULT`、`GATEWAY_USAGE`、`REVIEW_SPENT_TOTAL` 各行；`resultLine` 在 `1029`，两个模型时有两行 `REVIEW_RESULT`。建议消息用一行 JSON 或固定分隔符，包含目录、轮次、提交、模型、结果、花费、gateway；Mac 线程解析失败就拒绝，并加测试。

---

## 二、推测 / 未核实

1. **云端会话的 `start_session`、环境选择、回消息能力（方案前提 3-5）没有仓库内一手来源。** 按 `.claude/rules/proposal-premises.md:9-13`，另一个 Claude 的转述不算来源；应引用应用/工具的官方文档，或标“未核实”。如果消息工具不可靠，Mac 线程只能靠分支轮询，45 分钟窗口可能不够。
2. **云端会话的费用 0.4-1.1 美元没有来源。** 如果云端线程为了汇报去读模型答案，费用可能更高；应给出实测记录或把它当估算并留余量。
3. **云端线程的实际权限/令牌范围未核实。** `handoffs/2026-11-05-opencode-review-findings.md:79` 只证明容器里有 `GITHUB_TOKEN` 这个名字，不能证明它能推、能强推、能删分支；但方案要求它推分支，至少需要写权限。
4. **云端线程会被 brief/代码提示注入。** 这取决于应用的权限和系统提示，仓库里无法核实；但 OWASP LLM01/LLM06 把“提示注入”和“过度代理”列为成熟风险（<https://genai.owasp.org/llm-top-10/>）。
5. **45 分钟是否够未核实。** 首次安装 opencode/Magpie、网络波动、两个模型并行 25 分钟，最坏情况可能超过 45 分钟。
6. **云端会话是否在多次委派间复用未核实。** 方案说“每次交出去会多开一个云端会话”，但没有明确；若复用，KV 缓存规则要求只在末尾追加，任务说明不能改开头（`.claude/rules/prompt-prefix.md:4`）。

---

## 三、侧重检查

- **错误路径**：检查了 `--require-gateway` 必须在 `readFileSync(options.brief)`（`2787`）和 `installGateway`（`2828`）之前；缺 brief、head 移动、push 被拒、脚本失败、消息丢失、强推、从不可信 HEAD 运行检查器。结论：方案的错误路径主要靠任务说明，缺少技术控制和测试（见高 1、3、4，中 10、11）。
- **不合规范/不可信输入**：检查了 branch/reply-to/from 的注入、brief 内容、模型答案、账本、符号链接、`.env`。结论：`--branch`/`--reply-to`/`--from` 未校验；brief 从工作区读；账本可改写；记录目录允许符号链接和额外文件（见高 2、3，中 8）。
- **安全**：检查了云端线程的写权限、提示注入、brief 路径、网络密钥、检查器引导、brief 里的秘密。结论：最大风险是“云端 LLM 直接写 PR 分支”和“brief 可被篡改后发给外部模型”；建议改结果引用 + 最小权限令牌（见高 1、2）。
- **资源耗尽**：检查了 45 分钟 vs 25 分钟、重复委派、无锁、重复安装、云端会话费用、超大 brief。结论：无锁和超时设置可能导致重复执行/重复花钱；云端会话费用未纳入预算（见中 5、11、13）。
- **不可撤销操作**：检查了推共享分支、强推、改写账本、CI 在推送后运行、提交秘密。结论：推共享分支和强推不可逆；事后检查不能撤销，必须事前限制（见高 1、3）。
- **规则/文档一致**：检查了 `model-review.md:130` 与方案 §1 的默认行为冲突、前提 1 行号、`proposal-premises.md`、花费规则、§2/§7 矛盾、“脚本从云端克隆里读它”的措辞。结论：方案需要同时修改规则第 130 行并补 ADR，否则新旧规则矛盾（见中 5、9、12，低 15、16）。

---

## 四、如果由我定，我会怎样改这份方案

1. **保留 Mac 默认直连 Go，不把委派设为默认。** 只有需要 Magpie/更便宜的服务方，或 Andy 明确要求时才委派。这样大多数方案讨论不必多开一个 0.4-1.1 美元的云端会话。
2. **把“云端 Claude 会话 + 共享 PR 分支”换成“确定性远程任务 + 独立结果引用/工件”。** Mac 线程推送代码和 brief，记录 `briefSha256`、`head`、`base`、`mode`、`round`、`models`、`approvedUsd`、`providers`；远程 runner（CI VPS、专用复核容器，或只跑一条固定命令的云端会话）把结果写到 `refs/review/<id>`，不写 PR 分支。
3. **结果引用由 Mac 线程用可信检查器验收。** 检查器从 `--from` 提交运行，不执行新 HEAD 里的脚本；验证：`--from` 是祖先、旧 `usage.jsonl` 只追加、文件白名单和普通文件、每个模型的答案/prompt/ledger 齐全、`gateway: magpie`、`providers` 在允许集合、`cost` 不超预算、brief/prompt 哈希一致。通过后再把记录目录 cherry-pick/合并进 PR 分支。
4. **如果必须用云端 Claude 会话当 runner**：不要给它 PR 分支写权限，只给 `refs/review/*` 的受限令牌；要求 `DELEGATED_REVIEW_STARTED` 和心跳；超时设为 60-90 分钟；用 lock/lease 防重复。
5. **brief 只有一个来源**：提交进仓库，从 `--head` 的 blob 读取（`git show`），任务说明只带路径 + SHA-256，不复制全文；要求工作区干净。
6. **`--require-gateway` 修正并接入账本**：检查 `PROXY_ENV` 四个名字；放在读 brief/安装之前；只在普通复核模式允许，`--assert-reviewed`/`--report` 拒绝；账本记录 `requireGateway`，检查器要求新记录 `gateway: magpie` 和 `providers`。
7. **费用透明**：云端会话预估费用纳入“累计费用超过 1 美元先问”的计算，并在 `--report` 里列出。
8. **补测试**：临时 git 仓库测 `--check-result` 的代码改动、旧账本改写、符号链接、额外文件、错误 head/mode/round/models、强推、brief 哈希不符；测 `--require-gateway` 的 direct/无代理/小写代理，并断言失败时不写文件、不安装；再加一条用假 runner 的端到端 dry run。
9. **规则与文档**：修改 `model-review.md` 第 130 行并新增“委派”一节；`AGENTS.md` 补一句；写 ADR 记录“执行位置从 Mac 移到云端”和费用模型；修正前提 1 的行号；把前提 3-5 标为未核实或补官方来源；消除 §2/§7 的矛盾。

---

## 五、逐条回答必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
- 不会直接改变复核模型的请求组装：方案没有触碰 `buildPrompt`、`MODE_TEXT`、`reviewConfig`、工具定义；brief 仍然在 `buildPrompt` 的“本次材料”末尾追加（`opencode-review.mjs:277-301`）。每次复核是一个新会话，不存在“改写已发开头”。
- 但方案引入了一个可变来源：brief 从工作区读取（`2787`），云端线程可以改；§7 又要求任务说明包含材料全文，和 §2“只写路径”矛盾。这会让同一段材料在不同运行里变成不同字节（属于问题 2），虽然位置在末尾，不破坏“只追加”，但破坏“逐字节一致”。
- 如果云端会话在多次委派间复用，任务说明里的 commit、reply-to 等变化值在开头，就会改变云端线程自己的请求前缀；方案说每次新开会话，但未明确，标“未核实”。依据：`.claude/rules/prompt-prefix.md:4,11,28,84`。
- 建议：加一条测试锁定 `buildPrompt`/模式文字不变，并记录 brief 和 prompt 的 SHA-256。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**
- 会，存在三条路径：
  (a) brief 从工作区读（`2787`），云端的未提交修改会改变发给模型的内容；
  (b) §2 只写路径、§7 又写材料全文，两处内容可能不同；
  (c) `recordText` 会统一换行和去掉行尾空格（`2391-2393`），提交的原始字节和发送的字节可能不同（但规范化是确定的）。
- 动态值（commit、reply-to、approved-usd）只出现在给云端 Claude 的任务说明里，不进入复核模型的请求；除非复用云端会话，否则不影响复核模型。
- 建议：brief 从提交 blob 读取并哈希校验；任务说明只带路径 + 哈希；不要复制全文；要求工作区干净；每次委派新开会话，或在同一会话里只在末尾追加。依据：`.claude/rules/prompt-prefix.md:11,36,51-54`。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
- 不完整。方案 §7 只覆盖 `delegation-prompt.mjs` 生成和 `--require-gateway`；最关键的 `--check-result` 没有测试，账本只追加、符号链接/额外文件、gateway 字段、brief 哈希、强推、错误 head/mode/round/models 都没有反向用例。
- “去掉 `--require-gateway` 时测试失败”只证明生成器包含这个参数，不证明运行时守卫会拒绝；需要一条测试：在 `HIMAWARI_REVIEW_GATEWAY=direct` 或 `--gateway direct`、无代理、只有小写 `https_proxy` 的情况下，脚本以 `GATEWAY_REQUIRED` 退出，且不写 `usage.jsonl`、不安装。
- 依据：`.claude/rules/incident-gates.md:4`“每个事故都必须以一项自动检查结束”；`AGENTS.md:38` 同一要求。
- 建议：按上面第四节第 8 条补测试，并让测试用临时 git 仓库真正构造“云端改代码/改账本”的提交。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**
逐个核对：
- **brief 路径**：产生者 Mac 线程；使用者是复核脚本 `--brief`（工作区 `readFileSync`，`2787`）、`--assert-reviewed` 的 `changedOutside`（允许记录目录下任意文件，`1231-1235`）、云端 `git add`/`push`。两端不一致：检查器只看路径，复核脚本读的是可变工作区。必须改成读提交 blob + 哈希。
- **`--head` / `--base` / `--previous`**：产生者委派脚本；使用者 `resolveCommits`（`2342-2345`）、`prepareCopy`（`2356`）、账本 `head`（`model-review.md:91` 要求 40/64 位哈希）。若委派脚本传分支名，第 0 步的“分支头等于 `--head`”就没有意义；必须传解析后的哈希。
- **`--branch`**：产生者 Mac 线程；使用者是打印出来的 `git fetch`/`git push` 命令。没有校验/引号，Git 允许的分支名字符可能破坏命令。应按 `git check-ref-format` 校验并加引号。
- **`--reply-to`**：产生者 Mac 线程；使用者是应用的消息工具。没有格式/控制字符校验；应限定会话 id 格式，并加测试。
- **`--from`**：产生者 Mac 线程；使用者是 `--check-result` 的 git 命令。没有像 `--main-ref` 那样的校验（`2462-2465`）；应以 `-` 开头/控制字符拒绝，并检查祖先关系以拒绝强推。
- **`--require-gateway`**：产生者命令行；使用者 `parseArgs`/`main`。需要允许在普通复核模式、在 `--assert-reviewed`/`--report` 拒绝（现有 `ARG_NOT_FOR_SUBCOMMAND`/`ARG_NOT_FOR_MODE` 模式，`2516-2520,2540-2541`）；必须在 `readFileSync(brief)`（`2787`）和 `installGateway`（`2828`）之前检查。账本没有 `requireGateway` 字段，检查器无法知道它是否被使用；应加字段，或要求每条新记录 `gateway: magpie`。
- **`DELEGATED_REVIEW_DONE/FAILED`**：产生者云端线程；使用者 Mac 线程解析器。没有机器可读格式和测试；两个模型时 `REVIEW_RESULT` 有多行（`resultLine` `1029`）。应改一行 JSON 或固定分隔符，并测试截断/多行/失败格式。
- **`GATEWAY_REQUIRED`**：产生者复核脚本；使用者委派脚本/云端线程。需要加进错误码测试，并断言在写任何文件前退出。
- **`briefs/` 目录**：产生者 Mac；使用者 `--assert-reviewed` 的路径过滤（允许）和复核副本的 sparse-checkout（排除 `.agents/reviews/`，`2353`）。复核脚本在 `2787` 已先读入 brief，所以副本排除不影响它；但检查器应把它列入白名单，而不是“记录目录下任意文件”。

如果你要我给一个最小可落地的版本：先做“结果引用 + brief 哈希 + 可信检查器 + 账本只追加 + gateway 字段核验 + 反向测试”，再考虑是否真的需要把默认行为从 Mac 直连改成云端委派。
