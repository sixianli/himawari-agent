**读代码证实的**

### 1. 中：`docs/engineering-casebook.md` 仍按路径引用两个已删除的 backlog
- 文件:行：`docs/engineering-casebook.md:1407`
- 问题：该行仍写着 `BL-20261026-004-production-cloudflare-entry-for-owner-phone.md` 和 `BL-20261026-007-enable-bark-reminder-push-in-production.md`，这两个文件正是本 PR 删除的；同行的 `BL-20261026-005`、`BL-20261026-006` 则保留。它们放在反引号里，不是 Markdown 链接，`check:docs-links` 不会检查，所以断链留了下来。
- 证据：
  - `git diff --name-only --diff-filter=D 20800746..f20cf4cb` 输出包含 `docs/backlog/BL-20261026-004-production-cloudflare-entry-for-owner-phone.md`、`docs/backlog/BL-20261026-007-enable-bark-reminder-push-in-production.md`。
  - 当前文件原文：``Backlog `docs/backlog/BL-20261026-004-production-cloudflare-entry-for-owner-phone.md`、`BL-20261026-005-home-screen-web-app-and-web-push.md`、`BL-20261026-006-voice-entry-hold-to-talk-and-siri-shortcut.md`、`BL-20261026-007-enable-bark-reminder-push-in-production.md` ``。
- 建议：把 004、007 改成指向 `208007462f99e16c5c8cd4daac2acc10fa9f5f36` 的固定链接，或删掉这两个已结束条目的路径；005、006 保留。

### 2. 中：`[SOURCE: …]` 替换普遍丢失锚点，和“锚点保留”的说法不符
- 文件:行：`docs/adr/0036-agent-worker-restart-as-a-pair.md:76`、`docs/adr/0112-memory-page-carried-memories-and-topic-browsing.md:139`、`docs/execution/specs/2026-09-15-control-center-v4-design.md:51`、`docs/runbooks/install-start-stop-runbook.md:321`
- 问题：原 `[SOURCE: 文件#锚点]` 被换成固定链接时，链接目标只到 `.md`，没有保留 `#锚点`，标签里却仍写着 `「成对重启与离线就绪边界」`、`「profile」`、`「mode-disclosure」`、`「非沙箱-unknown-到期」`。读者会落到文件顶部而不是对应小节，直接违反作者说法 2 的“锚点保留”。我按“标签带锚点名、目标无 `#`”的模式找到 27 处候选，人工核对了上面 4 处，均属实。
- 证据（diff 原文）：
  - 旧：`[SOURCE: docs/execution/specs/2026-09-29-sandbox-foreground-result-durability-design.md#成对重启与离线就绪边界]`；新：`[…「成对重启与离线就绪边界」（已删除…）](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/specs/2026-09-29-sandbox-foreground-result-durability-design.md)`
  - 旧：`[SOURCE: docs/execution/specs/2026-10-25-self-built-memory-engine-design.md#profile]`；新链接同样没有 `#profile`。
  - 旧：`[SOURCE: docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#mode-disclosure]`；新链接没有 `#mode-disclosure`。
  - 旧：`[SOURCE: docs/execution/specs/2026-09-29-sandbox-deadline-settlement-design.md#非沙箱-unknown-到期]`；新链接没有该锚点。
- 建议：给每条由带锚点 SOURCE 换来的固定链接补回原锚点；最好写一个一次性脚本从 diff 的旧 SOURCE 中提取 `#…` 并校验新链接，避免人工漏项。

### 3. 中低：`.agents/plan-drafts/think-step-plan.md` 两处仍把已删除规格当作价格来源
- 文件:行：`.agents/plan-drafts/think-step-plan.md:23`、`:99`
- 问题：两处都按路径引用 `docs/execution/specs/2026-09-07-real-file-summary-agent-loop-design.md`，该文件已被本 PR 删除。第 99 行还明确依赖其中的“价格表”，属于“读者仍需要旧文”的情况；按约束应改成固定链接，而不是留一个不存在的仓库路径。
- 证据：
  - 第 23 行：``按 DeepSeek V4 Flash 目录价（…，`docs/execution/specs/2026-09-07-real-file-summary-agent-loop-design.md`）``。
  - 第 99 行：``DeepSeek V4 Flash 的目录价是…（`docs/execution/specs/2026-09-07-real-file-summary-agent-loop-design.md` 的价格表…）``。
  - `git diff --name-only --diff-filter=D` 输出包含 `docs/execution/specs/2026-09-07-real-file-summary-agent-loop-design.md`。
- 建议：把两处改成指向 `20800746` 的固定链接，或把价格表搬到一个保留的文档后再引用。

### 4. 低：改过的两份 Runbook 仍保留过期 `contract_sha256` 和 `runbook-contract` 清单
- 文件:行：`docs/runbooks/install-start-stop-runbook.md:5`、`:34`；`docs/runbooks/hermes-control-center-upgrade-runbook.md:5`、`:19`；规则见 `.agents/instructions/document-governance.md:31`
- 问题：这两份 Runbook 本次都被编辑，但文件头仍声明 `contract_sha256` 并保留 `<!-- runbook-contract: … -->`。现行规则说这些字段和清单已不再封存、会被忽略，“编辑时顺手删掉”。尤其 hermes Runbook 刚把正文改成“对照 `Authoritative Sources` 核对步骤”，不再提生成摘要，文件头却还挂着一个摘要，前后不一致；旧的 `runbook.py` 若仍按摘要检查，也会把这些值当作旧合同。
- 证据：
  - `install-start-stop-runbook.md:5`：`contract_sha256: "sha256:7e5bbea…"`；`:34`：`<!-- runbook-contract:`。
  - `hermes-control-center-upgrade-runbook.md:5`：`contract_sha256: "sha256:03631e…"`；`:19`：`<!-- runbook-contract:`。
  - `document-governance.md:31`：“Runbook 不再封存指纹（`contract_sha256`、`runbook-contract` 清单和 `runbook.py seal` 已从技能里删除，旧文件里留着的这些字段会被忽略，编辑时顺手删掉）”。
- 建议：既然本 PR 已经编辑这两份文件，就顺势删掉 `contract_sha256` 和整个 `runbook-contract` 清单；若只想做最小改动，至少不要把正文改成不生成摘要后还保留旧摘要。

### 5. 低：现有自动检查拦不住本次实际出现的错误
- 文件:行：`test/integration/sandbox-reservation-administration.test.ts:253-276`、`:1600-1636`；对应检查规则见 `.agents/instructions/document-governance.md:29`
- 问题：作者说法 3 只证明“两份 Runbook 里的 Python 片段仍能被测试执行”，但测试并不读取 `runbook-contract` 清单，也不检查锚点或裸路径。`npm run check:docs-links` 只查 `docs/` 下的**相对 Markdown 链接**，所以本报告的三种错误——反引号裸路径（`engineering-casebook.md`、`think-step-plan.md`）、外部 GitHub 固定链接的锚点、外部链接是否存在——都不会让任何检查失败。没有反向用例能证明这些缺陷会被拦住。
- 证据：
  - `runbookUpgradeGate()` 只做 `readFile(runbook)`、匹配 `python3 - /absolute/path/product.sqlite` 并 `spawnSync`，不解析 `<!-- runbook-contract:`，也不检查链接。
  - `document-governance.md:29` 说明 `check:docs-links` 查“`docs/`（不含 `docs/archive`）里每个行内 Markdown 相对链接”；外部链接和反引号路径不在范围内。
- 建议：增加一个检查：扫描 `docs/`、`.agents/` 中的裸 `docs/...` 路径，确认文件存在；对所有 `20800746` 固定链接检查路径和锚点（可离线读取 base commit 的 git blob，不必联网）；并给“SOURCE 替换丢失锚点”加反向用例。

### 6. 低：PR 描述的数量与实际 diff 不一致
- 文件:行：PR 描述 vs `git diff --shortstat`
- 问题：描述说删除 63 个文件、其中 38 条 backlog、改动 113 个文件；实际是删除 62 个文件（37 条 backlog、8 份计划、16 份规格、1 份 Runbook），共 176 个文件变更。若“113”指修改文件，实际修改数是 114。这不影响功能，但会让复核者按错误的规模判断覆盖率。
- 证据：
  - `git diff --shortstat 20800746..f20cf4cb`：`176 files changed, 287 insertions(+), 9234 deletions(-)`。
  - `git diff --name-only --diff-filter=D -- docs/backlog` 共 37 行；完整 D 列表共 62 行。
- 建议：更正描述中的 63/38/113；若确实想删 38 条 backlog，请指出第 38 条是哪份文件，否则按 37 条记录。

**推测**

- 未联网，无法实际打开 GitHub 确认固定链接在浏览器中的跳转；但路径取自 base commit 的删除清单，抽查的锚点（如 `container-unbound-recovery`、`startup-supervision`、`deadline-classification`、`main-thread-heartbeat-only`、`control-opened-first`）在 `20800746` 的文件中确实存在。
- 若其他机器上仍使用旧版 `document-governance` 技能，保留下来的 `contract_sha256` 可能被旧 `runbook.py` 判为失配；按本仓库现行规则这些字段被忽略，所以这只是兼容性推测。
- `test/qualification/evidence/` 下的 JSON/TSV/README 仍大量出现被删文件的路径和摘要，但作者已明确把这类历史证据排除在本次修改范围外，我没有把它们列为缺陷。

**侧重检查**

- 错误路径：重点查了删除后留下的引用、裸路径、相对链接、外部固定链接锚点；相对链接未发现指向被删文件，反引号裸路径和锚点有遗漏（意见 1、2、3）。
- 不合规范/不可信输入：本 PR 不解析外部输入，不改命令执行、认证、网络或数据库代码；没有新增用户输入入口。
- 安全：新增内容都是静态 GitHub 链接，不含凭据、令牌或隐私正文；未发现把秘密写进文档的变化。`git rm` 是不可撤销的删除，但旧内容仍可从 `20800746` 取回，符合 PR 的“不归档、指向历史提交”策略。
- 资源耗尽：无运行时资源分配变化；只删文档、改链接。
- 规则文件与代码/文档一致性：`document-governance.md` 的“过期即删、计划不再新建、Runbook 不再封存”与 `docs/glossary.md`、hermes Runbook 的正文修改一致；但两份被编辑 Runbook 的文件头仍保留规则要求删除的封存字段（意见 4）。
- Runbook 操作路径：确认 `install-start-stop-runbook.md:668`、`hermes-control-center-upgrade-runbook.md:273` 的 `python3 - /absolute/path/product.sqlite <<'PYTHON'` 片段仍在，`sandbox-reservation-administration.test.ts` 的升级门槛测试仍会读取这两份文件；链接替换没有破坏该片段。剩余 8 条 `runbook-contract` 路径行都指向现存文件。
- 安全/数据：未触及产品代码、配置、迁移、CI 工作流或钩子；没有改变任何模型可执行路径。

**必答问题**

1. 不会改变模型已经见过的请求开头。本 PR 只删除 `docs/` 文件和改文档链接，没有改系统提示、工具定义、历史消息、遮盖规则或提示词目录；在 `apps/`、`packages/` 中搜索 `docs/execution|docs/backlog|agent-tooling-runbook` 无命中，产品代码不按路径读这些文档。发给模型的内容仍然是固定的在前、会变的在后，每轮变化的值仍只在最后一条消息里。
2. 不会。没有新增时间、随机值、无序集合或依赖前后文的遮盖；固定链接使用固定的 `208007462f99e16c5c8cd4daac2acc10fa9f5f36`，正文是静态字节。同一段文档文字在不同请求里不会因此变成不同字节；这些文字本来也不进入模型请求。
3. 自动检查不足。`check:docs-links` 能拦住“相对 Markdown 链接指向已删文件”，但拦不住本次实际出现的反引号裸路径、外部固定链接路径错误、锚点丢失；`sandbox-reservation-administration.test.ts` 只验证两份 Runbook 的内嵌 Python 升级门槛，不验证 `runbook-contract` 清单、链接或锚点。因此，针对本报告意见 1–3 的反向用例目前不会失败。意见 4 提到的旧 `runbook.py` 摘要检查按现行治理已停用。
4. 逐个核对如下：
   - 固定链接的提交号和路径：路径来自 `git diff --diff-filter=D` 的删除清单，抽查的 base 文件锚点存在；未联网逐条访问 GitHub，无法确认所有 URL 的最终跳转。
   - `[SOURCE: …]` 替换后的链接标签和锚点：标签可读，但部分锚点丢失（意见 2）；使用方是文档读者，没有后端校验会因此报错，但读者会落到文件顶部。
   - Runbook 的 `runbook-contract` 条目：当前保留的 8 条 `docs/execution|backlog|runbooks` 路径都指向现存文件；本 PR 删掉的 17 行（作者说法）在可见 diff 中至少包含一条已删规格，剩余清单没有被任何在仓库内的测试读取。旧 `runbook.py` 是外部技能，现行规则说忽略这些字段。
   - `contract_sha256`：产生于 Runbook 文件头，使用方是旧封存工具和读者；现行规则说字段被忽略，但值已随文件编辑而过期，建议删除（意见 4）。
   - `promoted_to`、`source_idea`、`supersedes`、`superseded_by`：我检查了非空值，`IDEA-20261026-001` 的 `promoted_to` 指向保留的 `BL-20261026-003`，ADR 的 `superseded_by`/`supersedes` 都指向保留文件；未发现指向被删文件的 frontmatter 值，作者说法 4 成立。
   - 反引号路径：`docs/engineering-casebook.md:1407` 和 `.agents/plan-drafts/think-step-plan.md:23,99` 仍指向被删文件，没有校验器会接受或拒绝它们，因为根本没有校验器读取这类裸路径（意见 1、3）。
   - 文件数量：作者说 63/38/113，实际 62/37/176（修改 114）；不影响运行时，但和 diff 不一致（意见 6）。
