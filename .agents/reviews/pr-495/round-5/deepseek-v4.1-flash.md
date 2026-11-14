## 本轮复核范围

- 增量：`git diff 6ccf14b7650f0e81b37909e74edce30db41d9ed4..80302eded6cd181fe3efe693614dc4a53ecf0b91`。这一轮主要读了 ADR 0269 的措辞修改、合并 `origin/main`（PR 493）带进来的 `.agents/instructions/model-review-card.md`、`.claude/agents/code-review-round.md`、`AGENTS.md`、`docs/adr/0263`、`docs/adr/0175`、`test/tooling/review-round-tools.test.mjs`，以及它们直接依赖的 `scripts/model-review/opencode-review.mjs`、`scripts/check-incident-gates.mjs`、`.claude/rules/incident-gates.md`、`docs/adr/0107`、`docs/adr/0269`、`AGENTS.md`、`package.json`、`test/tooling/incident-gates.test.mjs`。
- 用 `git diff 120fdd9..80302e` 核对了 `check-incident-gates`、`incident-gates.test.mjs`、`package.json`、`docs/incidents-and-gates.md` 的完整改动。
- `.agents/reviews` 是稀疏检出且脚本对记录路径返回 `REVIEW_GIT_REFUSED`（`model-review.md:132` 说明了这个保护），所以复核记录本身没读到。

## 意见

### 1. 【中】合法的一轮只要经过 GLM 替补，流程卡就会让主线程不启动子代理

文件：`.agents/instructions/model-review-card.md:19`、`scripts/model-review/opencode-review.mjs:3694-3700`、`.agents/instructions/model-review.md:63`、`:72`

问题：流程卡要求“这一轮该跑的每个模型都有 `outcome=ok` 的结果”才起子代理，并说“退出码不是 0（模型的 `outcome` 不是 `ok`……）时不起子代理”；但 DeepSeek 遇到可重试服务错误时，脚本会自动让 GLM 替补，DeepSeek 自己没有 `ok`，脚本却按“已覆盖”以退出码 0 结束。这一轮在账本、`--judge-skeleton`、`--finish-round`、`--assert-reviewed` 看来都是合法的一轮（`:1683` 只取 `ok` 记录，`model-review.md:72` 明确接受“有替补它的 `ok` 结果”），只有流程卡的启动条件会把它判成不能起子代理。

证据：

- `model-review-card.md:19`：“命令退出码是 0、输出里有 `outcome=ok` 的 `REVIEW_RESULT` 行，并且这一轮该跑的每个模型都有 `outcome=ok` 的结果（用 `--round` 只补跑了一部分的不算）以后……起一个新的子代理……退出码不是 0（模型的 `outcome` 不是 `ok`、报错、要先问花钱）时不起子代理”。
- `opencode-review.mjs:3694-3700`：`const covered = results.some((record) => record.substitute && record.outcome === "ok"); if (results.some((record) => record.outcome !== "ok" && !(covered && record.model === results[0].model))) process.exitCode = 4;`
- `model-review.md:63`：“……就让 GLM 跑这一轮（打印 `REVIEW_SUBSTITUTE`，账本记 `substitute: true`、`substituteFor`）”；`:72`：“每个都有 `ok` 的结果或有替补它的 `ok` 结果（替补只在这一轮里被替补的模型自己有一条没通过的记录时才算）”。

建议：把流程卡改成“这一轮该跑的每个模型都有直接 `ok`，或有一条 `substituteFor` 指向它的 `ok` 替补记录；看到 `REVIEW_SUBSTITUTE` 的轮次算覆盖”，并补一条用 `substitute: true` 账本驱动的反向测试。现在的 `review-round-tools.test.mjs` 只断言了“每个模型都有 `outcome=ok`”这句话，反而把这个错误条件锁住了。

说明：这段流程卡是合并 `origin/main`（PR 493）时进入本分支的，不是第 5 轮 ADR 措辞改动新增；但它在本次增量范围内，且与本 PR 的复核流程直接相关。

### 2. 【低】ADR 0269 把“不载入仓库里的技能”归到前提 1，但前提 1 引用的原文没有这句

文件：`docs/adr/0269-load-instructions-on-demand-at-thread-start.md:30`、`:71`

问题：`:71` 说“云端线程不载入带 `paths` 的规则，也不载入仓库里的技能（前提 1）”，但前提 1 引用的一手原话只说了 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/` 与 `paths` 规则，没有提技能。仓库自己的前提规则要求每条前提附原话；这条技能事实没有引到原文，读 0269 的人无法从前提 1 核对它。

证据：

- `0269:30` 原话：“`CLAUDE.md`, `.claude/CLAUDE.md`, and `.claude/rules/` at the repository root — Loaded from every repository when the thread starts. `CLAUDE.md` files in subdirectories and path-specific rules aren't loaded”。
- `0269:71`：“……云端线程不载入带 `paths` 的规则，也不载入仓库里的技能（前提 1）”。
- 同一页面其实有这句话：`docs/adr/0080-document-governance-in-fast-mode.md:30` 引了“Skills under `.claude/skills/` | Not loaded”。

建议：在前提 1 补上技能那一句的原话（或把 `:71` 的引用改成指向该原话），否则这个“前提”只支持了一半。

### 3. 【低】`--open` 的“不列条目”条件写成 `npm run check:incident-gates`，但 `--open` 只跑清单脚本，不跑该 npm 脚本里的 vitest

文件：`.claude/rules/incident-gates.md:9`、`package.json:30`、`scripts/check-incident-gates.mjs:98-105`、`docs/adr/0269:61`

问题：规则和 ADR 说“清单有任何一处通不过 `npm run check:incident-gates` 时，`--open` 不列条目”；但 `check:incident-gates` 现在由“清单脚本 + `test/tooling/incident-gates.test.mjs` 的 vitest”两部分组成，而 `--open` 只调用 `checkIncidentGates()` 读取清单。若清单本身合法、只是测试文件或测试环境坏了，`npm run check:incident-gates` 会失败，`--open` 仍会打印条目和 `count=N`。括号里的例子（找不到、表格坏、状态写错、门槛文件不存在）都是清单错误，所以这不是功能错误，但字面上把“测试失败”也算进了“清单通不过”。

证据：

- `package.json:30`：“`check:incident-gates`: `node scripts/check-incident-gates.mjs && vitest run ... test/tooling/incident-gates.test.mjs`”
- `check-incident-gates.mjs:98-105`：`--open` 只根据 `checkIncidentGates()` 返回的 `errors` 决定打印 `INCIDENT_OPEN unavailable`，从不运行 vitest。
- `.claude/rules/incident-gates.md:9`：“清单有任何一处通不过 `npm run check:incident-gates`（……），它就不打印未结条目”。

建议：把规则和 ADR 的判据改成“清单本身（`node scripts/check-incident-gates.mjs`）有任何一处错误”，或明确写“`npm run check:incident-gates` 里的 vitest 失败不在 `--open` 的 unavailable 判据内”。

## 读代码证实的

- 作者说法 1 与 `scripts/check-incident-gates.mjs` 一致：`--open` 过滤 `OPEN_STATES`（缺门槛、等 Andy、仓库外），每行 `编号 | 状态 | 日期 | 第一句`；`firstSentence` 用 `Array.from` 按 Unicode 码点截到 80 个并加 `…`；随后打印 `INCIDENT_OPEN count=N total=M`；有错误时改打印 `INCIDENT_OPEN unavailable errors=K`，错误写到标准错误，仍打印 `INCIDENT_GATES failed`；退出码仍为 0/1（`scripts/check-incident-gates.mjs:78-105`）。
- `.claude/rules/incident-gates.md:9` 写的条件与上述脚本行为一致（除了上面第 3 条的 npm 脚本范围）。
- 反向测试真实存在：`test/tooling/incident-gates.test.mjs:123-134` 测 80 字符边界和 emoji 不切成半个代理对；`:151-173` 测清单缺失/无表格时 `unavailable errors=1`、不出现 `count=0`；`:175-193` 测清单可读但门槛文件缺失时不列 `I-02`、stderr 有 `INCIDENT_GATE_PATH_MISSING`。这些用例在旧的“打印 `count=0`/照列条目”实现上会失败。
- `check:incident-gates` 已把该测试纳入阻断链（`package.json:27,30`）。
- `.claude/rules/prompt-prefix.md` 已不存在；`.claude/rules/` 现在只有 `incident-gates.md`、`owner-global-instructions.md`、`owner-standing-rules.md`、`proposal-premises.md`。全仓库仍指向旧路径的只有 ADR 0269 里描述“移走”这件事的历史句；`docs/`、`AGENTS.md`、`model-review.md`、`packages/sensitive-capture/README.md`、`.agents/handoffs` 的两份 11-05 交接文件都已指向 `.agents/instructions/prompt-prefix.md`。移动后的规则里 `../../docs/...` 等相对链接仍正确（`.agents/instructions` 与 `.claude/rules` 都在仓库下两层）。
- `AGENTS.md:43` 的“发给模型的内容只追加”一节确有 3 条核心原则和 5 个问题。AGENTS.md 删掉的细节能在被链接文件里找到：CI 长期授权和“本 PR 改红先查先修”在 `.agents/instructions/delivery-mode.md:27`；复核分级、轮次、`--accept-low`、`--accept-unreviewed`、Mac 交接在 `.agents/instructions/model-review.md`（如 `:63`、`:69`、`:72`、`:73`、`:164`）；Pi 现有偏离不得照抄在 `docs/pi-development-guide.md:29`、`:344`。
- ADR 元数据闭环：`docs/adr/0107...md:7` 的 `amended_by` 指向 0269，`docs/adr/0269...md:6` 的 `amends` 指向 0107；ADR 0269 编号在全仓库唯一；`CLAUDE.md:1` 确实只有 `@AGENTS.md`；ADR 0269 引 ADR 0107 决定 3 的原话“每个线程开工时读，收尾时更新”确实存在。
- 全量 diff 没有改 `apps/`、`packages/` 下的运行时源码；`check:prompt-prefix` 仍在 `package.json:27,45`。
- 事故清单当前有 6 条非“已落门槛”行：I-06、I-25、I-45、I-60、I-63 为 `缺门槛`，I-09 为 `仓库外`，与材料里的“5 条未结、1 条仓库外”一致；总行数未逐行数。

## 推测与未核实

- ADR 0269 前提 1、2 引用的 Claude Code 文档原文、“每个 `CLAUDE.md` 不超过 200 行”、技能只在用到时载入正文，以及 ADR 0263 修订里的“主线程缓存 1 小时、子代理缓存 5 分钟”“约 7 万 token”等外部事实，本次无网络，未核实。
- `.agents/reviews/pr-495/round-4`、`topic-adr0269-claims` 各轮记录读不到（稀疏检出，且 `git show` 对记录路径返回 `REVIEW_GIT_REFUSED`），所以“第 4 轮低意见 3、4 已改正”“plan-claims 已核 3 次、最后一次 11 句全部一致”均未核实。能读到的是增量确实删掉了指向 PR 说明、仓库里无从核对的估算，并改了前提 4 和决定 4 的措辞。
- `.agents/reviews` 为历史记录、有意不改：当前全仓库 grep 未发现其中指向旧 `.claude/rules/prompt-prefix.md` 的链接，但记录读不到，不能确认“所有历史引用都不需要改”。
- “后台命令结束会叫醒主线程”“等待时不调工具”属于 Claude Code 行为，未核实。
- 合并是否完整保留了 `origin/main` 的每一处改动，只核了 `git diff 158697387..80302e -- AGENTS.md ...` 的最终内容；没有逐文件对比整个 main 历史。

## 侧重检查

- 错误路径：`--open` 的“清单缺失、无表格、门槛文件不存在”都有测试，退出码和输出前缀正确；新发现的错误路径问题见意见 1（替补轮被流程卡误判）和意见 3（`--open` 与 `npm run check:incident-gates` 范围不一致）。
- 不合规范或不可信的输入：清单的编号、日期、字段、次数、状态、门槛路径都有校验；`firstSentence` 对任意症状文本用 `Array.from`，不会产生孤立代理对；表格行内不可能有换行，输出不会因此断行。`openIncidentLines()` 被导出，若绕过 `checkIncidentGates()` 直接喂非法 state，会静默过滤掉该行，但 CLI 只在 `errors.length===0` 时调用它，当前无影响。
- 安全：脚本只读仓库文件、不联网、不执行清单内容，输出到终端的文字来自仓库内事故表，当前没有密钥或用户输入；没有新增运行时暴露面。
- 资源耗尽：每次开局读约 184KB 清单，只输出未关闭条目（当前 6 行，每行症状最多 80 码点），不会随清单增长线性放大终端输出。
- 不可撤销操作：本改动没有删除事故条目，没有运行时会改数据；只移动/改写文档和开发脚本。
- 规则、说明文档与代码一致性：`--open` 的实现、规则、ADR、清单头部说明、测试基本一致；意见 1、2、3 是三处不一致。另：Mac 线程不本机跑复核的例外只在 AGENTS.md 和 `model-review.md#delegate` 里，`model-review-card.md` 的主线程步骤没有 Mac 例外，但这是增量前已有的写法，本次只作观察，不作为意见。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 对 Himawari 运行时：不会。增量没有改 `apps/`、`packages/` 下的请求组装、系统提示、工具定义、历史或遮盖代码，仍只在末尾追加，每轮会变的值仍在最后一条消息里；`check:prompt-prefix` 仍是阻断检查。对 Claude Code 线程自身：新线程开局自动载入的指令内容会变（这正是本 PR 的目的：`prompt-prefix.md` 移出 `.claude/rules`、AGENTS.md 精简），但它是线程起始的静态载入，不是对话中途改写，也不是每轮变化的值；已在运行的线程不会被改写。`--open` 的输出不会进入任何模型请求。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。移动后的规则文件是静态文本；`--open` 按清单文件顺序确定性输出，没有时间、随机数、前后文相关遮盖或无序集合。`INCIDENT_OPEN count` 随清单内容变化，但这是开发命令的输出，不是发给模型的内容。没有改任何遮盖或序列化代码。
3. **有没有自动检查，反向用例真的会失败吗？** 有。`check:incident-gates` 现在在 `npm run check` 里同时跑清单脚本和 `test/tooling/incident-gates.test.mjs`；反向用例覆盖了“清单缺失/无表格/门槛文件不存在时不得打印条目或 `count=0`”，以及 80 码点截断和 emoji 不切半；链接由 `check:instruction-links`、`check:docs-links` 覆盖，运行时前缀由 `check:prompt-prefix` 覆盖。缺口是意见 1 的替补轮条件没有测试，现有测试反而锁住了错误条件；合并带进来的 `review-round-tools.test.mjs` 新用例跑在 tooling 项目（完整 `npm test`/覆盖率作业），不在 `npm run check` 的直接步骤里。本次是只读复核，没有实际运行测试，以上来自读代码。
4. **改动产生或修改的每个值，所有使用端都能接受吗？** 逐个核对过：`--open`、`INCIDENT_OPEN count/total`、`INCIDENT_OPEN unavailable errors=` 的使用端是 `.claude/rules/incident-gates.md:9`、ADR 0269:61、`docs/incidents-and-gates.md:18` 和两个测试，格式与脚本一致；移动后的路径所有指令/文档引用已更新，检查脚本没有硬编码旧路径；ADR 0269 编号唯一、`amends`/`amended_by` 对称，`check:adr-numbers` 能覆盖；`check:incident-gates` 的 stdout 没有别的解析者，`check:steps` 只是串行调用。唯一不能互相接受的是意见 1（流程卡的“每个模型 ok”与脚本/账本的替补覆盖规则），以及意见 3 的判据范围。这些值都不是后端字段或配置键，没有后端校验可核；事故清单里的 I-66 门槛路径已同步改成 `.agents/instructions/prompt-prefix.md`。
