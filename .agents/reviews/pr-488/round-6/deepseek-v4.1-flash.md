## 核对结论（按严重度）

### 低-1 文档行号引用没有自动检查，反向用例不会失败
- 文件:行：`scripts/check-adr-numbers.mjs:11-30`、`:53-66`、`:72-98`；`docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:36-41`、`:60`
- 问题：本轮改的正是“第 N 行 + 原话”这类引用，但现有 ADR 检查只覆盖文件名编号、标题编号、链接文件/锚点、`docs/adr/...md` 路径是否存在，**不校验行号，也不校验该行上是否真有引用的原话**。第 5 轮已经出现过一次 61/82/65/83 的错误，这次仍靠人工复核发现。
- 证据：
  - `findAdrNumberProblems` 只匹配 `ADR_FILE` 文件名并查重复编号（`scripts/check-adr-numbers.mjs:11-30`）。
  - `findAdrTitleProblems` 只比较标题里的编号（`:53-66`）。
  - `findAdrLinkProblems` 只查链接目标、锚点和 `docs/adr/` 路径是否存在（`:72-98`）。
  - `docs/adr/0253-...md` 再增删一行，这些引用就会再次失真；仓库文档自己也写明“没有对 `docs/` 做全面校验的自动检查”（`.agents/instructions/document-governance.md:28`）。
- 建议：给这类引用加一条检查：解析“第 N 行，原话“…””，读目标文件第 N 行并断言原话是其子串；反向用例把行号 +1 必须失败。或者把 ADR 引用改成锚点 + 短引文，不再写行号。

### 低-2 ADR 0266 对 ADR 0253 第 84 行的描述不精确
- 文件:行：`docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:60`、`docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:84`
- 问题：原文说“不是 ADR 0253 第 66、84 行写的独立锁文件”，但第 84 行并没有写“独立锁文件”；“ARM 的工具链放在独立的锁文件里”只在第 66 行。第 84 行是“不采用把 ARM 条目直接加进 `ci/toolchain-lock.json`”的理由，和结论相关，但不是“独立锁文件”的原话。
- 证据：
  - ADR 0253:66：“ARM 的工具链放在独立的锁文件里，有自己的校验和自己的摘要字段；……和工作流文件不改。”
  - ADR 0253:84：“| 把 ARM 条目直接加进 `ci/toolchain-lock.json` | 不采用 | 这个文件的摘要写进 x64 产物记录，改它会改变 x64 的记录 |”
- 建议：改成“ADR 0253 第 66 行写的独立锁文件（第 84 行给出不直接加进主锁文件的理由）”，或只引第 66 行。

### 低-3 `amended_by` 双向关系仍不完整（既有问题，本轮只补了一个）
- 文件:行：`docs/adr/0176-ci-on-ovh-vps.md:9`、`docs/adr/0181-...md:7`、`docs/adr/0189-...md:7`、`docs/adr/0202-...md:7`、`docs/adr/0238-...md:9`、`docs/adr/0243-...md:7`
- 问题：本轮给 0176 的 `amended_by` 补了 0238，这条边是对的；但 0181、0189、0202 都是 `status: active` 且 `amends: 0176`，0176 的 `amended_by` 仍没有它们。0238 的 `amended_by` 也缺 0243（0243 的 `amends` 含 0238 和 0241）。仓库约定是双向 `amends`/`amended_by`（`docs/adr/0031-...md:139`）。
- 证据：
  - `0176:9`: `amended_by: "...0241..., ...0256..., ...0238..."`
  - `0181:7` / `0189:7` / `0202:7` 均为 `amends: "docs/adr/0176-ci-on-ovh-vps.md"`
  - `0238:9`: `amended_by: "...0241..., ...0266..."`；`0243:7`: `amends: "...0238..., ...0241..., ...0174..."`。
- 建议：补齐 0176 缺的 0181/0189/0202，以及 0238（和 0241）缺的 0243；否则“补 0238”只是补了一个样本。更稳的是给 `check-adr-numbers.mjs` 增加 `amends`/`amended_by` 双向一致性检查。

### 信息-1 增量并非只有作者列出的三处文档
- 文件:行：`45be..HEAD` diff 中的 `.agents/reviews/pr-488/round-5/*`、`.agents/reviews/pr-488/usage.jsonl`
- 问题：作者说“只有文档：ADR 0266…、补 ci/policy.json…、ADR 0176…”，但增量还新增了第 5 轮复核记录并改了 `usage.jsonl`。这些不是运行时代码，不影响结论，但描述不完整。
- 建议：汇报时补一句“另有 `.agents/reviews/pr-488/round-5/` 记录与 `usage.jsonl`”。

## 读代码证实的正确项
- ADR 0253:62 确有“ARM 不进 GitHub 必过检查，也不切线上。”；:83 确有“测试机可能被 Oracle 回收，不能让必过检查依赖它”；:66 确有“`ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流文件不改。”。ADR 0266 的新行号 62、83、66 正确。
- `ci/policy.json` 的行号全部正确：policy 的 `arch`/`alternateArch` 在 15/16，static 在 32/33，security 在 122/123（`ci/policy.json:15-16,32-33,122-123`）。
- ADR 0176 新增 0238 的双向边一致：`0238:7` 写 `amends: "...0176..."`，`0176:9` 补 `amended_by: "...0238..."`。
- 顺带核对（本轮未改）：ADR 0266:39 的 `ci.yml` 行号 33/72/284、:40 的 362、:38 的 ADR 0238:92 原话，均与当前文件一致；ADR 0266:60 说主锁文件已有 linux-arm64 的 Node、Python、actionlint、gitleaks、Semgrep，`ci/toolchain-lock.json` 中确有这些条目。
- `45be..HEAD` 没有 `apps/`、`packages/`、`scripts/` 的代码变更，实质是文档加复核记录。

## 推测
- 随着 ADR 0253 后续继续编辑，这类硬编码行号还会再次漂移；如果没有自动检查，只能靠下一轮复核再发现。这是流程风险，不是当前文本错误。

## 侧重检查
- **错误路径 / 不可信输入**：本增量没有运行时输入处理；唯一的“输入”是文档中的行号/原话引用，已逐条对照源文件核对。
- **安全**：没有凭据、命令、网络或权限变更；ADR 0266 涉及 CI runner 迁移，但本轮只改文档行号，未改 `ci/policy.json` 或工作流。
- **资源耗尽 / 不可撤销操作**：无。
- **规则、说明文档与代码一致性**：行号、原话、`amends`/`amended_by` 已核对；发现低-2、低-3 两处不一致。未核实：整个 PR 的代码改动（job-host、sandbox、CI 脚本）不在本轮增量内，未逐行重审。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本增量只改 `docs/adr/` 和 `.agents/reviews/` 记录，未触及系统提示、工具定义、历史消息、遮盖或运行时序列化代码；发给模型的内容仍只在末尾追加，每轮会变的值位置不变。
2. **同一段文字会不会变成不同字节？** 不会。没有新增时间字段、前后文相关遮盖或无序列化集合；改的是静态文档行号。
3. **有没有对应的自动检查，反向用例真会失败吗？** 没有。`check:adr-numbers` 只查编号、标题、链接、路径，不查“第 N 行 + 原话”；把行号改错不会被 CI 拦下，只有人工复核能发现。
4. **每个被修改的值，使用它的地方都能接受吗？** 大部分可以：62/66/83 和 `ci/policy.json` 的 15/16、32/33、122/123 都经核对正确；0176 补 0238 的双向边也正确。但 ADR 0266:60 把“独立锁文件”归到 0253:84 不精确；0176 的 `amended_by` 仍缺 0181/0189/0202，0238 缺 0243。
