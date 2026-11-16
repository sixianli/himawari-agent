### 1. 高 — 活跃 CI Spec 仍要求保留已删除的“需求映射”检查，CI-A06 失去对应实现
文件：`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:59`、`:82`（另 `:47`）；`package.json:27`
问题：这份 `status: active` 的 Spec 仍把“需求映射”列为现有检查会拦截的对象，并明确点名 `check:v0.2-coverage` 要“保留”。本 PR 已从 `check:steps` 删除这一步并删除脚本，仓库里也没有找到替代的需求映射检查，因此 `CI-A06` 的验收条件不再成立。
证据：
- `:59`：`- 格式、lint、类型、架构、需求映射、文档、覆盖率、安全扫描和门禁自身的负向验证。`
- `:82`：`| CI-A06 | 类型、依赖方向、产品不变量、需求映射或文档合同被破坏 | 现有检查和严格治理校验失败，检查过程不更新基线或 seal |`
- `:47`：`| \`check:v0.2-coverage\` 是需求映射检查；尚无代码覆盖率 provider | 保留需求映射检查，另建可测量的代码覆盖率策略 |`
- `package.json:27` 当前已是 `... && npm run check:boundaries && npm run check:v0.2-invariants && ...`，中间不再有 coverage 步骤。
建议：同一提交更新这份 active Spec（范围、CI-A06、`:47` 的设计输入），或明确标注该能力退役并说明由谁替代；如果“需求映射”仍需保护，应先建替代检查再删除旧检查。

### 2. 中 — 多个 `status: active` 的计划仍把已删除的命令或清单写成现行入口
文件：`docs/execution/plans/2026-09-07-srt-unified-execution-plan.md:2`、`:20`、`:417`、`:424`；`docs/execution/plans/2026-08-26-v0.2-spec-suite-integration-plan.md:58`、`:92`；`docs/execution/plans/2026-08-26-portable-durable-web-agent-plan.md:143`
问题：SRT 计划自称“当前执行顺序”，并把 `npm run check:v0.2-coverage` 列为“已有入口”；另外两份 active 计划仍把已删除的 `coverage-manifest.json` 当作 canonical manifest。删除后，按这些计划操作会碰到缺失的 npm script 或不存在的文件。作者把它们当作“旧计划”豁免，但它们的 frontmatter 是 `status: active`，且 `.agents/instructions/document-governance.md:21` 要求“仍有效的规格或计划”被改动弄错时在同一提交改正。
证据：
- SRT `:20`：`本文 R1–R12 是当前执行顺序…`
- SRT `:417`：`每个任务先运行行为相关的最小检查…已有入口如下：`；`:424`：`npm run check:v0.2-coverage`
- v0.2 计划 `:58`：`- scripts/check-v0.2-coverage.mjs`；`:92`：`Task 1 的 canonical manifest 位于 \`test/fixtures/v0.2/coverage-manifest.json\`…`
- portable 计划 `:143`：`…S1-A01–S1-A09 的任务、证据和验证入口由 \`test/fixtures/v0.2/coverage-manifest.json\` 固定。`
建议：至少把仍在 active 的计划改为 `archived`，或在计划里加“该检查已退役”的明确说明；如果坚持不改这些计划，请在 PR 里列出全部豁免文件并说明为什么 active 状态仍能保留已删除的现行命令。

### 3. 中 — `delivery-mode` 指令仍声称 `npm run check` 包含覆盖率检查
文件：`.agents/instructions/delivery-mode.md:18`；`package.json:27`
问题：`check:steps` 已没有覆盖率步骤，但快速模式说明仍把“覆盖率和不变量检查”写成 `npm run check` 的内容。之后代理会据此误判基本检查的范围。
证据：
- `.agents/instructions/delivery-mode.md:18`：`` `npm run check`（格式、lint…、覆盖率和不变量检查、机器机密扫描…） ``
- `package.json:27`：`... && npm run check:boundaries && npm run check:v0.2-invariants && npm run check:secrets && ...`
建议：删除“覆盖率”或改为“不变量检查”；若想保留代码覆盖率说明，明确它属于 CI 的 coverage 作业，而不在 `npm run check` 里。

**作者说法核对**
1. 基本成立，但仅限于“脚本、测试、CI 工作流、钩子、代码”范围：我检查了 `scripts/`、`.github/`、`packages/`、`apps/`、`test/tooling/`、`test/integration/`，没有发现导入或执行 `check-v0.2-coverage.mjs` 的代码，也没有其他代码读取 `coverage-manifest.json`。文档和 `test/.../evidence` 里仍有引用，但那些不是执行代码。稀疏检出排除了 `.agents/reviews/`，这一处未核实。
2. 成立：`scripts/run-all-checks.mjs:6-11` 只按 `^npm run (\S+)$` 解析，`:32` 读取 `check:steps`；删掉中间一项后字符串仍合法。`test/tooling/run-all-checks.test.mjs:74` 还要求每个步骤在 `package.json` 里有对应脚本，因此“只删脚本、不删步骤”会被这项测试抓到。
3. 成立：`document-governance.md` 已没有 `v0.2`/`coverage` 字样，剩下那句列举的其他检查前后文仍通顺。但这只覆盖该文件，不代表其他 active 文档也已同步（见上面第 1、2 条）。

**侧重检查**
- 错误路径：`run-all-checks.mjs` 遇到不是 `npm run <name>` 的步骤会抛 `CHECK_STEP_NOT_AN_NPM_SCRIPT`；新字符串仍由合法段组成，没有首尾多余的 `&&`。被删脚本的 `--manifest` 缺值、未知参数、文件缺失、JSON 解析失败等错误路径随脚本删除，不再可达。
- 不可信输入/安全：本 PR 没有引入新的输入解析或外部命令。被删脚本原本允许传入绝对 `--manifest` 路径并读取任意文件，删除后反而减少了开发工具侧的读取面；没有发现秘密或凭据被新增或暴露。
- 资源耗尽：删除脚本和测试减少了一次全仓文档遍历和一次测试运行；没有新增循环、子进程或常驻资源。
- 不可撤销操作：只有 git 跟踪的删除和 npm script 列表修改，可通过版本控制恢复；没有数据库迁移、部署或用户数据删除。
- 规则/文档/代码一致性：发现上述三处活跃文档不一致；`check:v0.2-invariants` 仍只读取 `test/fixtures/v0.2/security-invariants.json` 并扫描 `apps/`、`packages/` 和 `package.json` 依赖（`scripts/check-v0.2-invariants.mjs:7`、`:41-48`、`:87-101`），代码上不依赖被删文件。

**必答问题**
1. **不会改变模型已经见过的请求开头。** 本次改动只涉及 `.agents/instructions/document-governance.md`、`package.json` 的开发检查列表，以及被删除的开发脚本、fixture 和测试；没有改动产品请求组装、系统提示、工具定义、历史消息或遮盖逻辑。因此发给模型的内容仍然只在末尾追加，每轮会变的值仍然只放在最后一条消息里。`.agents` 说明文件的文字变化属于编码代理的新会话上下文，不是对产品已发请求历史的改写。
2. **不会让同一段文字在不同请求里变成不同字节。** 没有新增时间字段、遮盖规则、哈希或无序集合；删除的 `coverage-manifest.json` 是检查用 fixture，不参与模型输入序列化。被删脚本内部 `collectMarkdownFiles` 的顺序最多影响它自己的错误输出顺序，但该脚本已删除，不再产生影响。
3. **没有针对这次“退役”本身的完整自动检查。** 被删的 `test/integration/v0.2-coverage.test.ts` 原本带有 stale digest、漏 requirement、缺 verification entrypoint 等反向用例；它们随功能一起删除，无法再运行。现有 `run-all-checks.test.mjs:74` 只能保证 `check:steps` 里的每一步都有对应 npm script，因此“删脚本但忘删步骤”会失败；它不会检查 `check:steps` 是否应删除某一步，也不会发现活跃文档里残留的已删除命令。没有新增测试，且我无法运行测试确认实际结果，标为未核实。
4. **逐个值的消费者核对结果：**
   - `check:steps`（`package.json:27`）：代码消费者 `scripts/run-all-checks.mjs:6-11,32` 和测试 `test/tooling/run-all-checks.test.mjs:52-74` 都能接受删除后的字符串；文档消费者 `delivery-mode.md:18` 和 CI Spec 不接受，见第 1、3 条。
   - `check:v0.2-coverage`（已删除的 npm script）：没有代码消费者；文档消费者包括 CI Spec `:47`、SRT 计划 `:424`，以及历史证据 JSON。删除后这些文档消费者不匹配。
   - `test/fixtures/v0.2/coverage-manifest.json`（已删除）：唯一代码消费者是已删除的检查脚本及其测试；没有后端或运行时读取它，也没有发现其他脚本读取。历史 evidence 中记录的哈希只是当时记录，不参与当前校验。
   - `test/integration/v0.2-coverage.test.ts`（已删除）：未发现其他代码引用；历史 evidence 中的文件哈希是记录，不会要求文件仍存在。
   - `check:v0.2-invariants`（保留）：只读 `security-invariants.json` 并扫描 `apps/`、`packages/`、`package.json`，与被删文件无依赖；代码层面应照常通过，但我没有实际运行，标为未核实。
