## 结论摘要

这一轮真正的代码改动很小：`model-review.md` 一行指令、`probeRefused` 的收窄、以及第 3 轮记录。指令那行和 `package.json`、`delivery-mode.md`、I-90 基本一致；`probeRefused` 的改动方向正确、反向用例是真会失败的。但我发现两处判断记录/作者说法与代码不符，一处“修复没修完”的残留误判路径。

（先说明工具边界：我只能用 `git diff/log/show/blame/status` 和 `read/grep/glob`，不能跑脚本；`.agents/reviews/**` 一律被 `REVIEW_GIT_REFUSED records-path` 拒绝，`round-3` 的 `judgments.md`、`verdicts.jsonl` 我读不到，涉及它们内容的判断只能依据材料里的转述，标明“未核实”。）

---

## 读代码证实的发现（按严重度）

### 中：修复只排除了“缩进行”，`git log -1 --oneline` 的提交标题仍在列 0，同类误判会复发
- 文件:行：`scripts/model-review/opencode-review.mjs:1741`、`:2012-2022`、`:2085-2086`；`test/tooling/opencode-review.test.mjs:763-776`
- 问题：自检里的 allowed 探针包含 `git log -1 --oneline`（1741 行）。`--oneline` 输出是 `<短哈希> <提交标题>`，**标题在列 0**，不是四格缩进。新过滤只丢弃 `/^\s/` 开头的行，所以只要 HEAD 的提交标题里出现 `REVIEW_GIT_REFUSED`、`: restricted` 或 `The user has specified a rule which prevents you`，`probeRefused` 仍返回 true，allowed 探针会被判成 `PROBE_READ_COMMAND_BLOCKED`，整次自检失败。作者说“`git show`、`git log` 打印的提交说明每行缩进四格”对 `git show`/默认 `git log` 成立，对自检实际用的 `--oneline` 不成立。
- 证据：
  - `:1741` `{ kind: "allowed", ...bash("git log -1 --oneline") },`
  - `:2012-2016` `.filter((line) => line !== "" && !/^\s/.test(line));`
  - `:2085-2086` `if (probe.kind === "allowed" && (call.status !== "completed" || probeRefused(call))) problems.push(\`PROBE_READ_COMMAND_BLOCKED ...\`)`
- 影响：不是安全旁路（写/读探针漏判只会让自检失败，属 fail-closed），但会让复核流程再次因“提交说明里引用了这个词”而无法启动，正是这次要修的那类故障。
- 建议：不要只按缩进判断；对 git 替身的拒绝只认行首精确前缀（`^REVIEW_GIT_REFUSED `），或结合 `call.status`/退出码；并补一条把 token 放在 `git log -1 --oneline` 标题（列 0）的反向用例。

### 中：R3-1 的降级理由“原句后半段自带以后若加了就先运行的后手”不成立
- 文件:行：`package.json` 的 `"check:gitleaks"` 与 `check:steps`；`.agents/instructions/model-review.md:140` 的旧句
- 问题：材料说 R3-1 从“中”降到“低”，理由之一是原句后半“以后若加了就先运行”已经兜住。但 main `1a3a1efe` 的 `package.json` 里 `check:gitleaks` 早已存在，且就在 `check:steps` 里；旧句开头“目前 `package.json` 里没有 `check:gitleaks` 这个脚本，云端线程不用跑它”是直接与事实相反，并主动告诉云端线程**不用跑**，不是“以后才要跑”。因此该“后手”不能作为降级依据。
- 证据（我亲自读过）：
  - `git show 1a3a1efe…:package.json` 中 `"check:gitleaks": "node scripts/check-gitleaks.mjs"`，且 `"check:steps": "... && npm run check:gitleaks && ..."`
  - 旧指令：“目前 `package.json` 里没有 `check:gitleaks` 这个脚本，云端线程不用跑它；以后若加了……”
- 说明：`judgments.md` 本体我读不到，这条对照的是材料转述的 R3-1 理由。最终改成的新指令本身是正确的，问题在“降为低”的论证。
- 建议：在记录里把降级理由改成“main 上原有的文案与 package.json 直接矛盾，会误导云端线程跳过 gitleaks（I-90/I-86 同类风险）”，或至少删掉“后手已经覆盖”的表述；新指令保持。

### 低：R3-3 对两个脚本“是否校验列数”的描述不精确
- 文件:行：`scripts/check-incident-gates.mjs:27-33`；`scripts/check-markdown-tables.mjs:8`、`:64-70`
- 问题：
  1. `check-incident-gates` **校验了表头列**：`:27-28` 要求表头逐列等于 `编号|日期|现象|根因|次数|门槛（文件或命令）|状态`，不一致就 `INCIDENT_TABLE_COLUMNS_CHANGED`。它**没有校验每个数据行的列数**：`:32` 直接解构前 7 个值，多余的第 8 列被静默丢掉。所以“它不校验列数”只在“数据行/多余列”这个范围成立，说成完全不校验是不准确的。
  2. `check-markdown-tables` 确实逐行比较列数（`:64-70`），但 `SCANNED_DIRECTORIES = ["docs"]`（`:8`），只扫 `docs/`。`files=403 errors=0` 对 `docs/incidents-and-gates.md` 有效，但**对 `.agents/reviews/pr-312/**` 或 `.agents/instructions/**` 没有任何证据力**。
- 证据：
  - `check-incident-gates.mjs:27-28` `if (cells(lines[header]).join("|") !== COLUMNS.join("|")) errors.push(...)`
  - `check-incident-gates.mjs:31-33` 只取前 7 个 cell
  - `check-markdown-tables.mjs:8` `const SCANNED_DIRECTORIES = ["docs"];`
- 建议：记录里把断言写精确（“表头列固定、数据行多余列不查”），并明确 `check:markdown-tables` 只覆盖 `docs/`。

### 低：指令这行没有对应的“事实陈述”自动检查
- 文件:行：`scripts/check-instruction-links.mjs:55-77`；`test/tooling/run-all-checks.test.mjs:50-73`
- 问题：`check:instruction-links` 只校验 markdown 链接存在、锚点存在、以及反引号里的仓库路径；`check:gitleaks` 不是路径，不会被检查。`run-all-checks.test` 断言 `check:steps` 里每个名字都是真实 npm 脚本（间接保证 `check:gitleaks` 存在），但它不读 `model-review.md`。因此“这句话说 check:gitleaks 存在/属于 check”没有反向用例；只有 `delivery-mode.md#fast-mode` 这个锚点被机器检查。
- 建议：补一个 tooling 用例，解析指令里提到的 `npm run <script>` 并断言 `package.json` 里有该脚本（或至少在 `check:steps` 里），否则这条文字以后还会漂移。

### 未核实 / 推测
- **R3-2**（三条命中不在 `.agents/reviews/pr-312/**`、`origin/main` worktree 同样三条）与 **I-84 行 md5 与合并基相同**：记录目录被拒、不能跑 `check:gitleaks`/md5，**未核实**。能确认的是 `ci/rules/gitleaks.toml` 不在 `1a3a1efe..head` 的改动列表里（`git diff --stat` 未列出），与“本 PR 不改该文件”一致。
- **opencode 自身拒绝话术的实际缩进**：仓库里唯一的样例是 `test:598` 的列 0 文本，没有真实 opencode 输出夹具。若真实输出把它缩进，allowed 探针且 `status==="completed"` 时可能漏判（推测）。不过 git 替身和 `bash -r` 都以非零退出，`call.status !== "completed"` 会兜住。

---

## 侧重检查

- **不可信输入/错误路径**：`refusalCandidateLines` 对 `call.output` 做 `String(... ?? "")`，null/undefined 安全；只按行首空白过滤，判断确定。真实拒绝来源我逐个核对：git 替身写 `REVIEW_GIT_REFUSED <problem>` 在列 0（`opencode-review.mjs:638`），`bash -r` 的 `: restricted` 在列 0，opencode 的 `The user has specified...` 在测试夹具里在列 0，新过滤都仍能命中。
- **安全/旁路**：收窄只会让更多行“不被认成拒绝”。对写/读探针，漏判 → `PROBE_NOT_REFUSED`，自检失败（fail-closed，不会放行）；对 allowed 探针，git/restricted 的非零退出由 `status` 独立兜住。因此不构成产品侧安全旁路，只会造成“阻塞复核”的可用性问题。
- **资源耗尽**：`split("\n").filter(...)` 会把整段输出复制成行数组；相比原来的整串 `includes` 多一份内存，但 `call.output` 本已在内存里，且探针数量有限，未见可利用点（推测，未测大输出）。
- **不可撤销操作**：本轮改动不涉及写文件、删除、上线或数据库，只有判定逻辑和文档。
- **规则/文档/代码一致性**：`package.json`（`check:gitleaks` 存在且在 `check:steps`）、`delivery-mode.md`（`#fast-mode` 锚点存在、描述一致）、I-90（同一门槛、同一脚本）三者一致；`check-incident-gates`/`check-markdown-tables` 的转述有上述不精确。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会（就本轮改动而言）。本轮只改了 `.agents/instructions/model-review.md` 的 delegate 段一行、`probeRefused` 的自检解析、和 `.agents/reviews` 记录，都不在产品的请求组装里，没有把任何内容前移或改写历史。连复核模型自己的提示词也没变：复核提示词只抽取 `model-review.md` 里 `<a id="checklist"></a>` 开始的必答问题段（`opencode-review.mjs:220-231`），被改的那行在别的段落。全 PR 里唯一会进入模型请求的实质改动是“给模型的上限说明”等工具结果文本，那些是追加的消息/工具结果，且已在前几轮复核；本轮没有新增此类改动。依据 `prompt-prefix.md` 第 4、10 条。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。新逻辑是纯函数：`String(output).split("\n").filter(...)`，无时间、无随机、无集合遍历顺序；过滤结果只影响自检 pass/fail，不影响任何发给模型的字节。指令与记录是静态文本。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
- `probeRefused` 收窄：有。`test/tooling/opencode-review.test.mjs:763-776` 构造三段 token 都在四格缩进行里、期望 `false`；若还原成旧的整串 `includes`，输出确实包含三段 token，会返回 `true`，用例以 `- false / + true` 失败。真实拒绝的正向覆盖在 `:752-758`（git、restricted）和 `passingCalls`（`:598` 的 opencode 话术）。
- 指令那行：**只有链接/锚点被检查**（`check-instruction-links.mjs:55-69`），没有对“check:gitleaks 存在且属于 check”这句话的反向用例，见上文低危项。
- 第 3 轮记录：无自动检查；且我读不到文件，无法核对 `judgments.md`/`verdicts.jsonl` 原文。

**4. 每个产生/修改的值，两端校验都能接受吗？**
- `GITLEAKS_GATE_FAILED`：产生于 `scripts/check-gitleaks.mjs:67-72`（`formatGateResult` 失败分支），新指令 `model-review.md:140` 引用它，一致；该分支同时打印 `GITLEAKS_FINDING …` 和各命中路径，指令说的“看命中的是不是本轮记录”可执行。
- `check:gitleaks`：`package.json` 定义、`check:steps` 含它、`run-all-checks.mjs` 按 `check:steps` 执行，`delivery-mode.md`/I-90 说法一致。
- `delivery-mode.md#fast-mode`：目标文件存在 `<a id="fast-mode"></a>`，`check-instruction-links` 也会校验到（锚点存在）。
- `REVIEW_GIT_REFUSED`：产生于替身 `opencode-review.mjs:638`（列 0），被 `REFUSAL_TEXTS` + `refusalCandidateLines` 接受（列 0 行不被过滤），两端匹配。
- 新增 `refusalCandidateLines` 导出：仅 `probeRefused` 使用（`grep` 全仓只此一处），无其他消费者，不需要额外鉴权/校验。
- 第 3 轮 `verdicts.jsonl`/`judgments.md` 的字段值：**读不到，未核实**。
- `check-incident-gates` 的 `INCIDENT_TABLE_COLUMNS_CHANGED`：表头 7 列两端一致；但数据行多余列不被校验，这一点在判断“合并两边都不丢”时不能当成列数完整性证据。
