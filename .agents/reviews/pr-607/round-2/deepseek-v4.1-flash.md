## 本轮范围

这一轮对比了 `98b11615..febe1d26` 的 2 个提交（`afbb6fb8` 复核记录、`febe1d26` 文档修正），逐条核对了上一轮意见 2–5；对增量改到的计划、证据 README、两份指令文件做了重点阅读；对原改动的关键值做了抽查：`package.json`、检查脚本改名、`security-invariants.json`、`repo-hygiene` 的 `allowedLarge`、`sourceSpec`/`sourcePlan` 使用端、`task-evidence.schema.json` 引用、固定 GitHub 链接。没有整份重读前几轮已覆盖的旧代码。

## 意见

### 1. 中 — 增量声称清掉残留的“封存”说法，但 active plans/specs 和 glossary 仍在要求已删除的 Runbook 封存

文件:行
- `.agents/instructions/document-governance.md:31`
- `docs/execution/plans/2026-09-28-tool-execution-audit-plan.md:166`
- `docs/execution/plans/2026-11-11-apple-device-body-plan.md:195`
- `docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md:495`
- `docs/execution/plans/2026-09-07-srt-unified-execution-plan.md:375`
- `docs/glossary.md:66`

问题：新规则明确说 Runbook 不再封存指纹，`runbook.py seal` 已从技能删除；但多个 active 计划/规格的未完成清单和当前词表仍要求“重新封存/再封存（seal）”。增量只改了同一批文件里“归档”的条目，紧邻的“封存”条目没有改；`febe1d26` 的提交说明是“去掉残留的‘封存’‘归档’说法”，与实际代码不符。执行这些清单项时会调用一个已经不存在的能力，且与新的文档治理规则直接冲突。

证据：
- `document-governance.md:31`：`Runbook 不再封存指纹（contract_sha256、runbook-contract 清单和 runbook.py seal 已从技能里删除...）`
- `2026-09-28-tool-execution-audit-plan.md:166`：`- [ ] Runbook 语义核对、重新封存，按独立缺陷提交。`（该文件正是增量改过的文件，第 168 行刚改成 `git rm` 删除）
- `2026-11-11-apple-device-body-plan.md:195`：`- [ ] 两份 Runbook 里不许在 MacBook 上构建和跑测试的句子在切回完整模式时重新封存。`（增量改的是第 198 行）
- `2026-09-24-isolated-tool-execution-plan.md:495`：`...重新核对静态合同和操作步骤后再封存（seal）...`
- `2026-09-07-srt-unified-execution-plan.md:375`：`...运行相应静态检查和实际授权 preflight 后再封存...`
- `docs/glossary.md:66`：`...Runbook 改了文字要重新封存...`
- 我在仓库里没有找到 `runbook.py` 或 `runbook.py seal` 的实现文件，说明“封存”能力确实已不在本仓库。

建议：把这些 active 清单/规格里的“重新封存/seal”改成“按 `runbook.py check` 查结构并对照 `Authoritative Sources`，不再封存”；`docs/glossary.md:66` 的当前规则也要同步。历史 ADR、lessons、复核记录和证据文件里的纯文字提及按约束保留不动。

### 2. 低 — `check:security-invariants` 没有找到反向自动测试，“加入禁令会失败”只靠脚本逻辑保证

文件:行
- `package.json:27`、`package.json:85`
- `scripts/check-security-invariants.mjs:40`、`:55-63`

问题：检查本身已经接入 `check:steps`，但 `test/` 下没有引用 `security-invariants` 的测试文件；我也没有找到“往产品代码里注入 `core.upgrade.auto` 或 `/api/register` 后期望检查失败”的反向用例。因此作者说法 4“加入其中一条会失败”从脚本逻辑看成立，但没有自动测试防止以后改坏扫描逻辑。

证据：
- `package.json:27` 的 `check:steps` 包含 `npm run check:security-invariants`。
- `scripts/check-security-invariants.mjs:55-63` 确实会对 `forbiddenCapabilityLiterals` 和 `forbiddenRouteFragments` 扫描并 `errors.push`。
- 在 `test/` 下 grep `security-invariants|forbiddenCapabilityLiterals|core.upgrade.auto|owner.register.public`，只命中证据 JSON 和 `test/fixtures/security-invariants.json`，没有测试代码。

建议：在 `test/tooling/` 增加一个反向测试：临时复制或构造一个包含禁用字面量/路由的产品源文件，运行检查并断言失败；再断言干净输入通过。这样 5 条保留禁令才有自动回归。

### 3. 低 — 11 个证据 README 的固定链接修复不在任何链接检查覆盖范围内

文件:行
- `.agents/instructions/document-governance.md:29`
- `test/qualification/evidence/workspace-authorization-lifecycle/*/README.md`（本轮改的 11 个文件）

问题：上一轮意见 5 的断链确实改成了指向 `34de855...` 的 GitHub 固定链接；但 `check:docs-links` 只检查 `docs/`，而 `check:docs-links` 明确不含 `docs/archive`，这些 README 在 `test/` 下，不在检查范围。以后有人再改回相对链接或写错锚点，CI 不会发现。

证据：
- `document-governance.md:29`：`npm run check:docs-links 查 docs/（不含 docs/archive）里每个行内 Markdown 相对链接...`
- 11 个 README 现在都用 `https://github.com/sixianli/himawari-agent/blob/34de855...` 固定链接，例如 `p1-page-next-action-01/README.md:83`、`p3-completion-01/README.md:3`。

建议：如果要让这类修复可回归，给 `test/qualification/evidence/**/README.md` 增加一个针对相对链接和固定 URL 格式的检查，或把 `check:docs-links` 的扫描根扩展到 `test/qualification/evidence`（不检查外网可达性，只检查格式、仓库内相对路径和 URL 中的路径/锚点是否能静态匹配）。

## 侧重检查

- **不可撤销操作**：本次删除 37 个文档是 `git rm`，工作树不可撤销，但历史保留；我抽查了 `34de855` 上仍存在 `docs/archive/plans/2026-09-23-automatic-review-defect-repair-plan.md`，固定链接方向正确。所有被删文件的完整清单和每个锚点没有逐一核对，标为未核实。
- **安全**：删掉的 10 条禁令包括 GitHub 写操作、外部通知相关字面量/路由和 `@octokit/rest`、`@slack/web-api`、`nodemailer`、`twilio` 依赖；这些现在不再被自动检查拦截，只剩 5 条（2 个字面量 + 3 个路由）。这是 Andy 已同意的决定，但从安全角度这是自动门槛的实际下降，未来只能靠指令文字约束。
- **不合规范/不可信输入**：`security-invariants.json` 是仓库内静态清单，没有外部输入；`check-security-invariants.mjs` 对清单路径是硬编码，清单缺失会直接抛错并以非零退出，属于失败关闭。
- **错误路径**：脚本没有新增分支；删除清单项和移动 fixture 后，路径已同步到 `test/fixtures/security-invariants.json`，未发现旧路径读取。
- **资源耗尽**：检查仍递归读取 `apps`、`packages` 下的文件，逻辑未变；本次删除大量文档只会减少工作树内容，没有新增资源风险。
- **规则/文档/代码一致性**：两份指令文件本身已一致；但 active plans/specs 和 `docs/glossary.md` 仍保留“封存”要求，这是本轮最主要的不一致，见意见 1。

## 读代码证实的与推测

读代码证实的：
- 上一轮意见 2：`document-governance.md:51` 已改为“完整的偏差核对推迟到完整模式”，`delivery-mode.md:26` 已去掉“包括过期的 Runbook 封存”。
- 上一轮意见 3：`docs/execution` 下已没有 `archive_doc`、`移到 docs/archive` 或“归档到 docs/archive”的指令；剩下的“归档”多是历史记录、产物归档或“不归档”。
- 上一轮意见 4：`docs/` 下已没有 `check:v0.2-invariants`；旧命令只留在 `test/` 的历史证据 JSON/README 中。
- 上一轮意见 5：`test/**/README.md` 里不再有指向 `docs/archive` 的相对链接；11 个断链已改成固定 GitHub 链接。
- `sourceSpec`、`sourcePlan` 在仓库里已无任何引用；对应测试断言和夹具字段已删除。
- `task-evidence.schema.json` 只在历史 frozen-input 清单里作为字符串出现，没有代码读取。
- `sourceSpec`/`sourcePlan` 之外，`control-center-inventory.ts` 的 `baselineEvidence` 指向的 `s4-*.json` 文件仍存在，不在被删文件里。
- `allowedLarge` 新增条目格式符合 `check-repo-hygiene.mjs:58-67` 的校验；`matchesPrefix` 对非 `/` 结尾路径做精确匹配（`scripts/check-repo-hygiene.mjs:93-95`）。
- `scripts/check-security-invariants.mjs` 与旧脚本相比只改了清单路径，逻辑部分一致。

推测/未核实：
- 11 个 GitHub 固定链接里的每个锚点是否都能在 `34de855` 的对应文件里找到，我只抽查了一个文件存在，没有逐个验证；也不能联网验证 GitHub 页面。
- 历史证据 JSON 里的 `"command": "npm run check:v0.2-invariants"`（如 `test/integration/qualification/evidence/s0-tasks2-3-11-contracts.json:26`、`p3-completion-01/delivery-checks.json:10`、`p6-resource-inventory-01/checks-result.json:11`）目前没有找到任何消费者；如果未来有工具按证据重放命令，会失败。按约束，这些属于历史证据，可以不改。
- 删除的 37 个文档是否每个都被完整替换了有效链接，我只检查了 Markdown 链接和证据 README；没有遍历所有二进制或非 Markdown 文件。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。改动集中在 `.agents/instructions`、`docs/execution`、`test/qualification` 证据、复核记录和检查清单/脚本；没有触碰系统提示组装、工具定义、历史序列化或遮盖代码。`grep` 也没有发现 `apps/`、`packages/` 读取这些被改文档。发给模型的内容仍然只在末尾追加，每轮会变的值仍应只在最后一条消息里。未核实：没有重读运行时提示组装的完整实现。

2. **同一段文字会不会在不同请求里变成不同字节？** 不涉及。`security-invariants.json` 是构建期静态检查清单，不进入模型请求；删除条目、移动 fixture、改文档链接都不会改变任何请求字节。没有新增时间字段、无序集合或依赖前后文的遮盖。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？** 原改动的 `check:security-invariants` 已接入 `check:steps`，但没找到针对 5 条保留禁令的反向自动测试；“加入禁令会失败”只能从脚本逻辑确认。增量文档改动方面，`check:docs-links` 只覆盖 `docs/`，`check:instruction-links` 覆盖指令文件；`test/` 下 11 个证据 README 的固定链接修复没有自动检查，见意见 2、3。

4. **改动产生或修改的每个值，使用端都能接受吗？**
   - `check:security-invariants`：使用端是 `package.json:27` 的 `check:steps`；`scripts/`、`.github/`、`package.json` 中已无旧名。
   - `scripts/check-security-invariants.mjs` 的清单路径：指向存在的 `test/fixtures/security-invariants.json`。
   - 导出的 `checkV02Invariants`：只有脚本自身调用，没有外部消费者；函数名仍带 `V02`，是命名残留，不影响行为。
   - `test/fixtures/security-invariants.json`：只被检查脚本读取；`schemaVersion`、数组字段格式都能被现有循环接受；`forbiddenDependencies: []` 合法；保留的 5 条仍会被扫描。
   - `sourceSpec`、`sourcePlan`：仓库内已无引用；对应测试接口和断言已删除；没有 schema 要求它们存在。
   - `test/fixtures/v0.2/task-evidence.schema.json`：只在历史 frozen-input 清单里出现，没有代码读取。
   - `allowedLarge` 新增项：`parseConfig` 要求 `path` 和 reason 非空，`matchesPrefix` 对 `docs/engineering-casebook.md` 做精确匹配，格式正确。
   - 11 个 GitHub 固定链接：消费者只有 Markdown；抽查的 pin 提交包含目标文件，锚点未逐一核实。
   - 旧命令 `check:v0.2-invariants`：`package.json`、`scripts/`、`.github/` 已无引用；仅历史证据 JSON/README 保留，未找到消费者，属于约束允许的历史记录。
