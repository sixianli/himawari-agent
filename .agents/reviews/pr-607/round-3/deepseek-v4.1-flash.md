本轮只审查 `febe1d26..9388f091` 的增量，并回看上一轮第 1 条是否真的改好。查过的范围：增量 19 个非复核记录文件（全部是 Markdown 文档），以及为核对说法跟进的 `package.json`、`scripts/check-security-invariants.mjs`、`test/fixtures/security-invariants.json`、`scripts/check-repo-hygiene.mjs`、`scripts/check-glossary.mjs`、`scripts/check-docs-links.mjs`、`scripts/check-adr-numbers.mjs` 和全部 13 份 Runbook 的标题结构；`.agents/reviews/pr-607/round-2` 在当前稀疏检出中不存在，未读。

**侧重检查**

- 错误路径/不可信输入/资源耗尽/权限：增量是纯文档，没有新增运行时代码、输入解析、外部调用或资源分配，不引入这类路径。
- 不可撤销操作：增量没有新增删除、覆盖或远端写操作；此前 PR 的 `git rm` 依赖 git 历史保留旧文。
- 配置与代码一致：重点核了新增的 `allowedLarge` 条目和约束检查改名两处“值—使用端”。
  - `scripts/check-repo-hygiene.mjs:59-67` 读取 `allowedLarge`，要求 `path` 是仓库路径、`reason` 非空；`matchesPrefix`（同文件 `:93-95`）对不带结尾 `/` 的路径做完全匹配，`docs/engineering-casebook.md` 能通过。该条目同时绕开单文件上限和总变更上限（`:150-160` 的 `continue`），符合登记大文件的用途。
  - `package.json:85` 定义了 `check:security-invariants`，`:25` 的 `check:steps` 已使用新名字；脚本存在且读 `test/fixtures/security-invariants.json`（`scripts/check-security-invariants.mjs:7`）。
- 规则文件与文档是否一致：发现上一轮的第 1 条并未完全清干净，详见下面意见。
- 未核实：`runbook.py check` 和“三重门禁”属于仓库外的 `document-governance` 技能，仓库里没有副本，无法确认其行为；`docs/engineering-casebook.md` 的实际大小也未核实。

---

### 1. 中 — 上一轮第 1 条只改了一部分：仍在进行的规格和计划还要求已删除的 Runbook seal

文件:行：`docs/execution/specs/2026-09-07-srt-unified-execution-design.md:482`、`docs/execution/plans/2026-09-07-srt-unified-execution-plan.md:34`；同类还有 `docs/execution/specs/2026-10-04-sandbox-preparation-launch-arbitration-design.md:81`、`docs/execution/plans/2026-09-28-tool-execution-audit-plan.md:360`。

问题：上一轮意见是“active plans/specs 和 glossary 仍在要求已删除的 Runbook 封存”。这次增量清掉了 glossary 和若干计划行，但两个 `status: active` 的文档仍保留面向后续工作的 seal 要求，和 `.agents/instructions/document-governance.md:31` 的“Runbook 不再封存指纹，`runbook.py seal` 已从技能里删除”直接矛盾。执行者照这些行做，会去找一个已删除的流程。

证据（读代码证实）：

- `docs/execution/specs/2026-09-07-srt-unified-execution-design.md:482`：`当前 Runbook 仍描述现有二进制；新实现改变运行合同后再语义复核并封存，不因设计文档批准自动改操作指令或 seal。`
- `docs/execution/plans/2026-09-07-srt-unified-execution-plan.md:34`：`...操作步骤不变；其选定源码变化需要重新计算静态 seal。`
- `docs/execution/specs/2026-10-04-sandbox-preparation-launch-arbitration-design.md:81`：`...再过第 1–2 层、自审、文档封存后单独提交并推送。`
- `docs/execution/plans/2026-09-28-tool-execution-audit-plan.md:360`：`...改到 Runbook 覆盖的代码时复核并重新封存。`
- 新规则见 `.agents/instructions/document-governance.md:31`：`Runbook 不再封存指纹（... runbook.py seal 已从技能里删除...）`。

推测：`2026-10-04:81` 和 `2026-09-28:360` 可能被作者当成历史过程记录而保留；但它们所在文档仍是 `status: active`，且语句是面向执行步骤的，并不是“某次已完成”的纯历史陈述。历史 reply 记录、证据文件和 ADR 里的“封存”我没有算作问题。

建议：把这两份 active 规格/计划中的 seal 要求改成“对照 `Authoritative Sources` 核对步骤”，或明确标注为历史过程且不再作为门禁；同时用同样的 grep 扫一遍 `docs/execution/` 中 `status: active` 的文件，避免只删“重新封存”而漏掉“并封存”“文档封存”“静态 seal”。

### 2. 低 — Hermes 升级 Runbook 仍要求生成 `contract_sha256`，与“不再封存”冲突

文件:行：`docs/runbooks/hermes-control-center-upgrade-runbook.md:336`（同文件 `:5` 仍有 `contract_sha256`，`:19` 仍有 `runbook-contract`）。

问题：增量统一说明 Runbook 不再封存，但这份仍有效的 Runbook 正文继续指导“核对和生成 `contract_sha256`”，会把操作者带回已删除的封存流程。

证据（读代码证实）：

- `docs/runbooks/hermes-control-center-upgrade-runbook.md:336`：`发布文档与源码应在同一份干净的候选源码中核对和生成 contract_sha256，并用同一候选执行严格文档检查。...`
- `.agents/instructions/document-governance.md:31`：`Runbook 不再封存指纹（contract_sha256、runbook-contract 清单和 runbook.py seal 已从技能里删除，旧文件里留着的这些字段会被忽略，编辑时顺手删掉）`。

建议：删掉这句或改为“对照 `Authoritative Sources` 核对”，并按新规则顺手移除该 Runbook 的 `contract_sha256` 和 `runbook-contract` 块。该行不在本次增量里，属于同类残留，不是增量新引入。

### 3. 低 — 增量改到的 glossary 行仍把“已做完的实施计划”写成保留不维护，和“做完就删除”不一致

文件:行：`docs/glossary.md:66`；对照 `.agents/instructions/document-governance.md:22`。

问题：增量为了去掉“已封存 Runbook”改了这一行，但同一行仍说“已做完的实施计划（`docs/execution/plans/`）……计划是做完的任务清单，不再维护”。新政策是已做完的计划用 `git rm` 删除、不归档，不再保留成“不再维护”的冻结文件。

证据（读代码证实）：

- `docs/glossary.md:66`：`已冻结的设计原型（docs/assets/）、照着操作的 Runbook（docs/runbooks/）和已做完的实施计划（docs/execution/plans/）：...计划是做完的任务清单，不再维护。`
- `.agents/instructions/document-governance.md:22`：`过期的文档直接删除，不归档...工作已做完或已放弃的规格（Spec）和旧计划（Plan）...在结束它的那次改动里用 git rm 删掉；旧版本在 git 历史里。`

建议：把“已做完的实施计划”从“不再维护的保留文件”改成“完成后删除，旧版本在 git 历史里”；同段 `:65` 的“归档文档”也可以改成“Git 历史里的旧文档”，避免继续暗示存在归档目录。

（另有一处无害残留，不作为意见：`scripts/check-glossary.mjs:19`、`scripts/check-docs-links.mjs:9`、`scripts/check-adr-numbers.mjs:33` 仍把已不存在的 `docs/archive` 当特殊路径。它们不读取被删文件，当前不影响检查，但可以在下次改这些脚本时清掉。）

---

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会。增量只改 `docs/` 下的说明、计划、规格、Backlog 和 Runbook，没有改 `packages/prompt-catalog`、工具定义、历史消息、遮盖或请求组装代码；也没有改每轮发送的序列化。发给模型的内容是否仍只追加、会变的值是否都在最后一条消息，这次改动不涉及。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。增量文本不会进入模型请求，也没有改遮盖规则、时间字段、JSON 键序或集合顺序。不涉及。

3. **有没有对应的自动检查，反向用例会真的失败吗？** 没有针对这次文档口径的自动检查。`check:docs-links`、`check:glossary`、`check:instruction-links` 只能查链接、旧叫法和指令文件路径，不能发现“active 规格仍要求 seal”或“Runbook 仍要求生成 `contract_sha256`”。因此把上面这些残留留着，现有检查不会报错；反向用例（故意在 active 文档写回“重新封存”）也不会失败。约束检查改名本身有实际门禁：我读代码确认 `scripts/check-security-invariants.mjs:62-72` 会在源码里发现被禁的字面量或路由片段时把 `errors` 填上并以 1 退出，但我没有运行它。`runbook.py check` 的反向行为未核实。

4. **增量产生或修改的每个值，使用端都能接受吗？逐个核对两端：**
   - `Authoritative Sources` 这个节名：使用端是 `.agents/instructions/document-governance.md:31`、`:56`、`docs/glossary.md:66`、`docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md:495`、`docs/execution/plans/2026-11-11-apple-device-body-plan.md:195`。13 份 `docs/runbooks/*.md` 全部都有 `## Authoritative Sources`，可接受。
   - `runbook.py check`：使用端是 `.agents/instructions/document-governance.md:31`、`docs/runbooks/sandbox-reservation-administrative-disposition-runbook.md:163`。技能不在仓库，命令是否存在、语义是否正确**未核实**。
   - `contract_sha256` / `runbook-contract`：新规则说忽略并在编辑时删掉，但 13 份 Runbook 仍全部保留；其中 `hermes-control-center-upgrade-runbook.md:336` 还在要求生成摘要。这是使用端与新规则不一致，见意见 2。
   - `check:security-invariants`：`package.json:85` 定义、`:25` 使用，脚本 `scripts/check-security-invariants.mjs` 存在，清单 `test/fixtures/security-invariants.json` 存在；脚本导出的函数名仍叫 `checkV02Invariants`（`:40`），没有外部导入者，只有同文件 `:120` 调用，不影响运行但名字是旧口径。
   - `docs/engineering-casebook.md` 的 `allowedLarge` 条目：`scripts/check-repo-hygiene.mjs:59-67` 的校验和 `:93-95`、`:150` 的匹配逻辑都能接受，路径只放行这一项；实际文件大小未核实。
   - `BL-20261026-001` 的标题改动：只改文档标题，`record_id` 和文件名未变，仓库里没有其他引用，使用端无影响。
   - 旧名字 `check:v0.2-invariants` / `check-v0.2-invariants.mjs`：只出现在 `test/qualification/evidence/**` 的历史证据文件里；它们不是脚本、CI 或产品代码，按约束属于历史证据可保留。`sourcePlan` / `sourceSpec` 全仓已无匹配。
