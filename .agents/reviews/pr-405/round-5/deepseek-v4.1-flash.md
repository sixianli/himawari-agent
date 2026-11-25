## 本轮范围

我读了 `0182c09..b0c082` 的文档增量，重点是 `7d2e4a1`、合并提交 `aabdcf9`、`b0c082`，并跟到这些引用指向的当前代码：`docs/adr/0258`、`docs/adr/0285`、`docs/adr/0286`、`docs/adr/0229`、`docs/adr/0257`、详细设计、实施计划、v4 的 README/tokens/canvas/NextVault，以及 `check-design.mjs`、`client-capabilities.ts`、`client-parity.test.ts`、`DesignTokens.swift`、`ClientCapabilities.swift`、`action-policy-service.ts`、两处 `sqlite-*` 删除代码。没有运行测试或检查；v5 保险箱方案不在仓库里，相关原文未核实。

## 意见

### 1、高、保险箱锁屏“只写请你批准一次”与 ADR 0258 决定第 8 条“锁屏通知显示全文”直接冲突

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:1034`、`:660`、`docs/adr/0258-each-apple-device-plays-to-its-strength.md:120`
- 问题：本轮一边在 ADR 0258 和详细设计里把锁屏规则改成“全文显示、同意卡片是真实动作和明细”，一边在新加的保险箱一段写“推送只写‘Himawari 请你批准一次使用’，不写是哪一项”。保险箱的批准推送也是锁屏通知、也带批准按钮，但没有任何“保险箱例外”的说明。
- 证据：
  - `docs/execution/specs/2026-11-11-apple-device-body-design.md:1034`：“用的时候：推送只写“Himawari 请你批准一次使用”，不写是哪一项；点开是批准页……”
  - `docs/execution/specs/2026-11-11-apple-device-body-design.md:660`：“同意卡片的推送正文是程序写的真实动作和明细，带“不要”“同意”两个按钮。”
  - `docs/adr/0258-each-apple-device-plays-to-its-strength.md:120`：“锁屏通知显示全文（前提 16）：她的话是她写的原话，同意卡片是程序写的真实动作和明细……”
- 建议：二选一。要么在 ADR 0258 决定第 8 条和详细设计第 18 节的锁屏段写明“保险箱批准推送是例外，只写通用一句，点开才显示项名和动作”，并在前提 S14/关联文档里登记；要么把保险箱推送改成显示项名和真实动作。现在这样按字面实现会做出违反 ADR 0258 的锁屏行为。

### 2、中、`check:client-parity` 仍不会发现设计页面表与能力表/Swift 的偏差，PR 只是把差异写成待办

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:303`、`packages/gateway-contracts/src/client-capabilities.ts:382`、`:386`、`:389`、`:392`、`test/tooling/client-parity.test.ts:159-231`、`docs/execution/plans/2026-11-11-apple-device-body-plan.md:109`
- 问题：详细设计的页面去处表要求 `approvals` 进主对话、`suggestions` 变成选项、`capabilities-adapters` 和 `improvements` 手机上不做；当前能力表仍是 `today.approvals`、`today.suggestions`、`settings.capabilities`、`settings.improvements`，生成的 Swift 也是旧的。`check:client-parity` 只比对网页清单、网关合约和“从能力表重新生成的 Swift”，不读详细设计，所以两边不一致时它照样通过。作者在 ADR 0258 和计划里承认了旧对应，但这正是上一轮意见 2 的缺口，不是自动检查。
- 证据：
  - `client-capabilities.ts:382` `{ webPage: "approvals", nativePage: "today.approvals" },`；`:386` `capabilities-adapters` 对 `settings.capabilities`；`:389` `suggestions` 对 `today.suggestions`；`:392` `improvements` 对 `settings.improvements`
  - `client-parity.test.ts:214-219` 只比较 `renderSwift(CLIENT_CAPABILITY_TABLE, CLIENT_PAGE_TABLE)` 与 Swift 文件；没有一处读详细设计的页面表。
  - 计划 `:109` 把这项改动留给“照第 4 版做的第一个 iPhone PR”。
- 建议：至少加一条用机器可读页面去处生成或断言的检查，并写反向用例：把 `approvals` 改回 `today.approvals` 时必须失败。否则第一个 iPhone PR 仍可能改错页面去处而全部检查通过。

### 3、中、`check:apple-design` 仍只读第 2 版 tokens，新增第 4 版素材没有任何自动校验

- 文件:行：`clients/apple/scripts/check-design.mjs:20`、`test/tooling/apple-design-check.test.mjs:112`、`:133`、`:171`、`docs/execution/specs/2026-11-11-apple-device-body-design.md:218`
- 问题：本轮改了 `docs/assets/apple-clients/2026-11-25-v4/tokens.json` 的 `source` 和 `canvas.json` 的保险箱宽度/标题，但生成器和测试仍固定读 `2026-11-12-v2/tokens.json`。第 4 版的 `tokens.json`、`canvas.json` 只靠人工看 JSON，没有任何检查；v4 素材以后改坏或与 Swift 不一致，`check:apple-design` 不会失败。
- 证据：
  - `check-design.mjs:20` `export const TOKENS_SOURCE = "docs/assets/apple-clients/2026-11-12-v2/tokens.json";`
  - `apple-design-check.test.mjs:112`、`:133`、`:171` 也直接用 v2 的 `tokens.json`。
  - 详细设计 `:218` 已明说“这道检查通过不说明第 4 版的数值已经进了代码”。
- 建议：至少加一个只验证 v4 `tokens.json`/`canvas.json` 合法性和必要字段的测试；更好的做法是像计划说的那样，在本 PR 或紧接的 PR 把 `TOKENS_SOURCE` 和测试夹具切到第 4 版，并带一个“把 v4 的必填值删掉就失败”的反向用例。

### 4、中、更新后的代码引用已与当前 main 不符：`action-policy-service.ts:513` 的“只在 CRITICAL 时”不再成立

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:673`、`packages/application/src/services/action-policy-service.ts:513-517`
- 问题：设计说“现有审批只在风险是最高一档（`CRITICAL`）时才要求近期身份验证”，并引用 `:513` 的 `recentAuthenticationRequired: intent.finalRisk === "CRITICAL"`。当前工作树里 `:513` 只是属性名开头，实际条件在 `:513-517`，而且已经多了 `ownerPresenceRequired` 这条事实。也就是说，这句“现有行为”在合并 main 后已经不成立；这不只是行号偏移。
- 证据：
  - 设计 `:673`：“现有审批只在风险是最高一档（`CRITICAL`）时才要求近期身份验证（……`action-policy-service.ts:513` `recentAuthenticationRequired: intent.finalRisk === "CRITICAL"`）”
  - 代码 `:513-517`：`recentAuthenticationRequired:` / `intent.finalRisk === "CRITICAL" ||` / `intent.deterministicFacts.some(` / `({ code }) => code === POLICY_FACT_CODES.ownerPresenceRequired,`
- 建议：改成“`CRITICAL` 或带 `ownerPresenceRequired` 事实时”，引用 `:513-517`；如果这段本来是在描述 ADR 0257 合并前的旧行为，就明确写“ADR 0257 第 1、2 步合并前”。

### 5、低、`sqlite-durable-operations.ts:3935` 不是那处 `UPDATE memory_provenance`

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:820`、`packages/persistence-sqlite/src/sqlite-durable-operations.ts:3945`
- 问题：设计列出四处“只按编号更新 `memory_provenance`”的位置，前三处（`:943`、`:986`、`:1021`）都对，第四处引用 `:3935` 却只是一个查询参数的右括号；真正的 `UPDATE memory_provenance SET source_deleted = 1` 在 `:3945`。
- 证据：`sqlite-durable-operations.ts:3945` 是 `\`UPDATE memory_provenance SET source_deleted = 1`；`:3935` 是 `),`。
- 建议：把 `:3935` 改成 `:3945`。这是上一轮“行号偏移”意见未完全改好的一处。

### 6、低、S13 仍说“这个分支还没合进来”，合并 main 后已不成立

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:85`
- 问题：`b0c082` 已经通过 `aabdcf9` 合入 main，ADR 0286 文件就在本分支；S13 的括号“（已进 main，这个分支还没合进来）”在最终提交上已经是错的。
- 证据：S13 原文“ADR 0286 文件 `0286-the-main-model-reads-and-writes-memory-itself.md`（已进 main，这个分支还没合进来）……”；当前分支可直接读到 `docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md`。
- 建议：删掉“这个分支还没合进来”，或改成“写这份修订时还没合入，本轮已随 main 合入”。

## 上一轮意见核对

- 意见 1（锁屏全文出处）：已改好。S13、ADR 0258 决定第 8 条、详细设计锁屏段都改成 ADR 0286 决定第 4 条，并写明 ADR 0229 决定第 9 条和后果的两句不再适用；我核对过 ADR 0229 原文和 ADR 0286 原文，引用一致。
- 意见 2（页面去处和能力表/Swift 对不上）：部分改好，已明确写成待办，但自动检查缺口仍在，见上面意见 2。
- 意见 3（后台 + 外来内容权限写松）：已改好。权限表加了 ADR 0285 决定第 7 条的说明和感知提醒/日历事件的例外；我核对过 ADR 0257 的 `amended_by` 和 ADR 0258 决定第 4、6 条，方向一致。
- 意见 4（第 2 批仍按 v2/三页签）：基本改好。计划 `:109` 明确说该批已按第 2 版做完、下面是历史记录，并写明第 4 版第一个 PR 先改 `TOKENS_SOURCE` 和 `CLIENT_PAGE_TABLE`。正文仍留着 v2、三页签的字样，但已不再是会出错的执行指令。
- 意见 5（`check:apple-design` 仍读 v2）：只做了文档说明，检查未改，见上面意见 3。
- 意见 8（新值清单指向不存在的测试文件）：文档层面已改好。`:909` 明确列出五个未建文件并说明不能当成已有检查；我用 glob 确认 `device-limits`、`device-connection`、`perception-deletion`、`perception-origin-gate`、`delivery-timing` 这五个文件确实不存在。
- 意见 7（行号偏移）：大部分改对，仍有意见 4、5 两处不对。
- 意见 10（旧界面文字）：已改好。当前 `docs/` 里搜不到“导航那一行”和“补画的六排”。

## 侧重检查

- 安全与锁屏：本轮新加的保险箱锁屏规则与 ADR 0258 决定第 8 条冲突，见意见 1；`后台也能用` 开关明确写了“服务器被黑时这一项会泄露”，属于有意的风险取舍，但没有对应自动检查。
- 不可信输入：保险箱导入和“网站对不上”设计有整页警告、默认“不用这一项”、继续要刷脸，方向合理；这部分没有代码，未能验证实现。
- 不可撤销操作：注销丢了的手机、换总钥匙、删掉一项都只有界面描述，设计里没有写部分失败、回滚或二次确认；这可能由未合入的 v5 方案负责，**未核实**，不据此下结论。
- 资源耗尽：换总钥匙要“每一项在这台手机上重新加密一遍”，设计没有写中途失败或大量条目时的处理；**推测性风险**，源方案不在仓库，未核实。
- 规则/文档与代码一致：ADR 0285、0286、0229、0257 的引文我逐句对过，条号和措辞一致；`CLIENT_PAGE_TABLE`、`DesignTokens.swift`、两个删除实现的行号和内容已按当前代码核对，发现意见 2、3、4、5、6。
- 未核实：v5 保险箱方案原文（不在仓库）、作者声称的 `check:docs-links` 等检查结果（本环境不能运行）、`05-vault.png` 的九屏画面（只核对了 canvas/README 和文件大小）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。本轮只有文档和设计素材，没有改任何组装或发送模型请求的代码；系统提示、工具定义、历史、遮盖都未动。设计里提到的 `device_action`、`perception_read` 和保险箱后台使用都是未来实现，本 PR 没有产生新工具或新消息。按 `.agents/instructions/prompt-prefix.md` 的“只追加”和“系统提示、工具按对话冻结”，本轮没有违反；将来实现保险箱如果给模型加工具，必须作为一次性的工具集合变化处理，不能每轮变。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不涉及。改动是静态文档和静态设计素材；`tokens.json` 的 `source` 是固定字符串，`canvas.json` 的宽度/标题也是固定值，没有时间字段、无序集合或依赖前后文的序列化进入模型请求。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 只有文档链接、词表、Markdown 表格、ADR 编号、格式这类通用检查；对新加的保险箱规则、页面去处、v4 素材没有对应的自动检查。`check:client-parity` 的反向用例只覆盖“能力表加类型但 Swift 没重生成”，不覆盖设计页面表；`check:apple-design` 只覆盖 v2 tokens，不覆盖 v4；新值清单里五个测试文件也确实不存在。因此这次新增内容没有“去掉守卫就失败”的反向用例，意见 2、3 是实际缺口。

4. **每个新值/改动值的两端都能接受吗？**
   - `tokens.json` 的 `source`、`canvas.json` 的 `w`/`title`：仓库内没有代码读 v4 的这两个文件；`check:apple-design` 仍读 v2，所以没有使用端校验，见意见 3。
   - `S14` 前提：只在详细设计 `:1028` 使用，两端都是文档；v5 原文不在仓库，未核实。
   - 页面去处（`approvals`、`suggestions`、`capabilities-adapters`、`improvements`）：本轮没有改 `CLIENT_PAGE_TABLE`，生成的 Swift 也仍是旧值；计划把它们留给下一个 PR。直接使用端 `check:client-parity` 能接受合法的 `nativePage` 字符串，但不会判断它是否等于设计表里的去处，见意见 2。
   - ADR 链接和测试文件名：链接目标存在（`docs/adr/0285`、`0286`、设计规格均存在）；五个测试文件名是未来值，当前不存在，不能作为已有保护。
   - 结论：没有代码被本轮改坏；但“设计表 → 能力表 → Swift”和“v4 tokens → 生成器”这两条链在本轮都没有被使用端或检查接受/校验，属于未闭合的值。
