本轮查过范围：`d7be889..0e3181b3` 的全部增量（只有 `.agents/plan-drafts/think-step-plan.md` 与 PR 616 第 2 轮记录、`usage.jsonl`；记录文件被本环境的 git 包装以 `REVIEW_GIT_REFUSED records-path` 拒绝，内容未核实）；对照 `d42a3a0..0e3181b3` 的 5 个非记录文件；通读 `.claude/rules/owner-standing-rules.md`、`model-review.md` 第 72–77 行、`delivery-mode.md`、`AGENTS.md`、`owner-global-instructions.md`、`think-step-plan.md`、`deploy-speed.md`、ADR 0052/0056 等相关段；全仓搜索“等 Andy 说合并”“合并前等”“改模型调用的大改动”等旧措辞；检查 `check-instruction-links.mjs`、`check-docs-links.mjs`、`check-agent-rulebook-inventory.mjs` 和 `opencode-review.mjs` 的提示词组装。未核实：Andy 的原话本身、PR 616 复核记录的具体内容、这些旧 ADR 是否已被其他 ADR 明确取代。

**侧重检查**

- **错误路径**：本轮唯一功能改动是方案文字。检查了“没有复核就等于没有中高意见”的空洞条件：`delivery-mode.md:27` 要求 `--assert-reviewed` 输出 `REVIEW_CURRENT`，`model-review.md:74` 要求复核链最后一点是当前提交的祖先，所以不能只凭“没有意见”合并；但 `model-review.md:76` 明说脚本拦不住线程不跑它，这是已知局限，不是本次新增。
- **安全与不可逆操作**：新规则只放开“合并”这一步。上线生产、动生产数据、花钱超过先问线仍写在 `owner-standing-rules.md:44`；`delivery-mode.md:29` 要求用户说“上线”才算授权，`test-and-production-hosts.md:19` 要求每次上线明确授权。改规则、改模型调用、改权限本身仍属于 `owner-standing-rules.md:26-29` 的“大改动”，要先出方案并经 Andy 同意，所以新规则没有让线程单方面改规则。合并动作可以用 revert 撤销。
- **不可信输入、资源耗尽**：本 PR 不解析外部输入，不新增脚本、网络或模型调用，花钱门槛未变。
- **规则、文档一致性**：目标文件里已没有残留的“等 Andy 说合并”；`deploy-speed.md:67` 和设计文档 `:484` 已改。旧 ADR 和全局指令副本仍写着旧措辞（见意见 1）。`check-instruction-links` 不扫描 `.agents/plan-drafts/`，所以提交说明里的检查通过并不覆盖本轮改的文件（见意见 3）。
- **增量本身**：第 2 轮意见 1 已改好：`think-step-plan.md:31-32` 不再写“合并前等 Andy”，改为按新规则线程自合并并链接到授权一节。增量没有触碰代码。

### 1. 低：多个现行 ADR 和全局指令副本仍写“合并要用户明确要求”，与新规则矛盾且未标取代

**文件:行**：`docs/adr/0052-third-production-host-acceptance-exception.md:153`、`docs/adr/0056-cloud-server-also-test-host.md:110`，以及同样措辞的 `0046-tests-back-on-hermes.md:126`、`0047-test-checkout-on-hermes-nvme.md:156`、`0049-first-production-host-acceptance-exception.md:134`、`0050-hermes-root-disk-cleanup-without-floor.md:143`、`0051-second-production-host-acceptance-exception.md:147`；另有 `.claude/rules/owner-global-instructions.md:61`。

**问题**：这些文件都写着“开分支、打标签、开 PR、合并仍要用户明确要求”或“除非明确要求，不得……合并”。新规则说线程自己合并，两者字面相反。虽然 `owner-standing-rules.md:44` 是更晚、更具体的项目规则，`owner-global-instructions.md:4` 也说项目专用规则优先，但旧 ADR 没有标“已被取代”，读测试主机文档的线程可能仍按旧说法等 Andy。

**证据**：

> `docs/adr/0052-third-production-host-acceptance-exception.md:153`：……开分支、打标签、开 PR、合并仍要用户明确要求。
>
> `docs/adr/0056-cloud-server-also-test-host.md:110`：……开分支、打标签、开 PR、合并仍要用户明确要求。
>
> `.claude/rules/owner-standing-rules.md:44`：复核没有中、高严重度的“会出错”意见，并且过了交付模式写的合并条件，线程就自己合并，不等 Andy 说“合并”，也不问他要不要合。

**建议**：在这些 ADR 的相关行或文首加一句“合并授权已由 2026-11-24 的长期规则取代，见 owner-standing-rules 的授权一节”，或在 `owner-global-instructions.md:61` 指向该长期规则，说明它是 Andy 的“明确要求”。如果决定旧 ADR 只是历史记录、不必改，也应在 PR 里写明理由。

**读代码证实**：上述文字确实存在。**推测**：是否真的会让线程停下来等 Andy，取决于线程先读哪份文件，未实测。

### 2. 低：增量把条件写成“没有中、高意见”，比正式规则的“中、高严重度的‘会出错’意见”更严，可能造成不必要的等待

**文件:行**：`.agents/plan-drafts/think-step-plan.md:31`；同样措辞也出现在 `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:484`。

**问题**：正式规则只要求没有“中、高严重度的‘会出错’意见”，而新改的这句写“复核没有中、高意见”。按字面，任何中高严重度的“可以更好”意见也会被当成不能自合并的条件，线程可能多等一次 Andy。它是往保守方向偏，不是安全问题，但和同一次 PR 的正式规则不一致。

**证据**：

> `think-step-plan.md:31`：……（模型调用；复核没有中、高意见并过了合并条件，线程就自己合并……）
>
> `owner-standing-rules.md:44`：复核没有中、高严重度的“会出错”意见，并且过了交付模式写的合并条件，线程就自己合并……
>
> `model-review.md:73`：……没有中、高严重度的“会出错”意见、过了交付模式写的合并条件，线程就自己合并……

**建议**：改成“复核没有中、高严重度的‘会出错’意见”，或写“按授权、上线和合并一节的判定”，避免两处规则读起来不一致。

**读代码证实**：文字差异存在。**推测**：线程是否会因此多等，取决于它怎么理解“中、高意见”，未实测。

### 3. 低：本轮改的 plan draft 不在任何链接检查范围内，“检查通过”不能证明这次链接和规则文字被检查过

**文件:行**：`scripts/check-instruction-links.mjs:7-12`、`scripts/check-docs-links.mjs:8`、`.agents/plan-drafts/think-step-plan.md:31`。

**问题**：提交 `0e3181b3` 的说明写“检查：`check:instruction-links`、`check:docs-links`、`check:glossary` 通过”，但 `check-instruction-links` 只扫描 `AGENTS.md`、`CLAUDE.md`、`.claude/rules`、`.agents/instructions`，`check-docs-links` 只扫描 `docs/`。被改的 `.agents/plan-drafts/think-step-plan.md` 两边都不在范围内。新链接目前指向的锚点确实存在（`owner-standing-rules.md:38` 的 `<a id="authorization-deploys-and-merges">`），但锚点被删或文字退回“等 Andy 说合并”时，现有检查不会失败。

**证据**：

> `scripts/check-instruction-links.mjs:7-12`：`INSTRUCTION_ROOTS = Object.freeze(["AGENTS.md","CLAUDE.md",".claude/rules",".agents/instructions"])`
>
> `scripts/check-docs-links.mjs:8`：`const DOCS_DIRECTORY = "docs";`
>
> `think-step-plan.md:31`：……见[授权、上线和合并](../../.claude/rules/owner-standing-rules.md#authorization-deploys-and-merges)。

**建议**：把 `.agents/plan-drafts`（以及 `.agents/plans`）加入 `INSTRUCTION_ROOTS`，或单独加一条检查；再补一个反向用例：把这个链接的锚点改坏或把文字改回“合并前等 Andy”，检查必须失败。若不想扩大检查范围，至少在提交说明里不要用这条检查来证明该文件没问题。

**读代码证实**：检查范围和当前锚点存在都已核实。**推测**：将来锚点被删或文字回退时不会被现有 CI 拦住。

### 4. 低：材料说“只改两份规则文字”，实际 PR 改了至少五个非记录文件

**文件:行**：`git diff --name-only d42a3a0..0e3181b3` 列出的 `.claude/rules/owner-standing-rules.md`、`.agents/instructions/model-review.md`、`.agents/plan-drafts/think-step-plan.md`、`.agents/plans/deploy-speed.md`、`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md`。

**问题**：材料写“只改两份规则文字”，但最终 PR 的 c8663558f 只改两份，d7be88909 又改了 `deploy-speed.md`、设计文档和 `owner-standing-rules.md`，0e3181b3 又改了 `think-step-plan.md`。后三处正是前几轮发现“仍写着等 Andy 合并”的地方。如果复核者按材料只查两份规则，就会漏掉这些文件，重演上一轮的问题。

**证据**：

> `git diff --stat d42a3a0..0e3181b3`：`owner-standing-rules.md | 2 +-`、`model-review.md | 2 +-`、`think-step-plan.md | 4 ++--`、`deploy-speed.md | 2 +-`、`2026-11-24-main-thread-subthreads-inbox-design.md | 2 +-`。

**建议**：把 PR 描述或复核材料里的改动范围改成实际文件清单，并说明哪些提交是回应第 1、2 轮意见；不要只写最初那两份规则文件。

**读代码证实**：diff 清单与各提交的内容已核对，事实明确。

**结论**

第 2 轮意见 1 已改好：`think-step-plan.md` 不再写“模型调用、改授权合并前等 Andy”，新文字和 `owner-standing-rules.md:44`、`model-review.md:73` 的主规则一致。本轮增量没有发现中、高严重度的“会出错”新问题；上面四条都是低严重度的文档一致性、检查覆盖和材料准确性问题，不阻塞合并，但建议至少改掉意见 2 的措辞、意见 4 的范围说明，并决定是否为意见 1 的旧 ADR 加取代说明。

**必答问题**

1. **不会改变模型已经见过的请求开头。** 本轮增量只改 `.agents/plan-drafts/think-step-plan.md` 的文字和复核记录；整个 PR 也没有改任何组装模型请求的代码、系统提示、工具定义、历史消息或遮盖逻辑。发给模型的内容仍只能在末尾追加，每轮会变的值仍在最后一条消息里（`AGENTS.md:40-51`、`prompt-prefix.md` 的既有机制未变）。另外，`model-review.md` 的改动在第 73 行，不在 `#checklist` 段；`opencode-review.mjs:288-298` 的 `reviewQuestions` 只从 `<a id="checklist">` 起截取，所以连复核模型的必答问题文本都没有变（`opencode-review.mjs:3108-3114`、`:3800-3802`）。
2. **不会让同一段文字在不同请求里变成不同字节。** 改动中是固定日期字面量“2026-11-24”和固定锚点，不依赖当前时间、前后文、集合顺序或遮盖结果；没有新增序列化、配置键或字段。
3. **没有对应的语义反向用例。** 提交 `0e3181b3` 说三个检查通过，但被改的 `think-step-plan.md` 不在 `check:instruction-links` 的扫描根，也不在 `check:docs-links` 的 `docs/` 范围；没有测试会在文字退回“等 Andy 说合并”或链接锚点被删时失败。当前链接目标已验证存在（`owner-standing-rules.md:38`）。见意见 3。
4. **本次修改的值逐个核对过。** 两个新链接、锚点都是 `#authorization-deploys-and-merges`，目标锚点存在、相对路径解析正确；日期只是文字，不被代码读取；没有新增标识、字段、配置键、清单项或序列化格式，直接使用端只有这两个链接，未发现不接受的地方。作者“只改两份规则文字”的说法与实际不符，见意见 4。未核实：`.agents/reviews/pr-616/round-2/*` 和 `usage.jsonl` 的内容（环境 git 包装拒绝 `records-path`），这些由复核脚本生成、合并门会验证，但本轮无法独立读取。
