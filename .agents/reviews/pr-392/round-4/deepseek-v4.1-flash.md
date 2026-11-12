## 结论

未发现阻断性、高严重度或中严重度问题。合并冲突解决把 main 的 OAuth 接线和本 PR 的 `slowDecided`/`unseen` 两边都保留了；两个被删脚本没有残留引用。作者的三条说法基本属实，只有一处表述容易误解：这两个脚本相对 main 本来就不存在，所以相对 main 的净 diff 里没有删除记录，删除只发生在向 PR 分支合并时。

## 问题（按严重度从高到低）

### 低：文档仍写着已删除的 `writeSecretRef`
- 文件:行：`docs/adr/0225-external-agents-propose-memory-with-in-client-confirmation.md:118`（另见同文件 `:110`）
- 问题：ADR 0225 的“后果/测试”仍说 `writeSecretRef` 只接受用途 `mcp-write` 的密钥，和 ADR 0227 以及当前代码矛盾。
- 证据：
  - `docs/adr/0225...:118`：`` `packages/platform-node/test/startup-configuration.unit.test.ts`：`writeSecretRef` 只接受一把用途是 `mcp-write`、和只读令牌不同的密钥。 ``
  - `docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md:64`：`` 去掉 `secretRef`、`writeSecretRef` 和密钥用途 `mcp-read`、`mcp-write`。 ``
  - `packages/platform-node/test/startup-configuration.unit.test.ts:1529-1531` 明确把 `{ secretRef: ... }`、`{ ..., writeSecretRef: ... }` 列为应拒绝的配置。
- 建议：给 ADR 0225 这一条也加“已被 ADR 0227 取代”的注记，或直接改成校验 `audience`/`proposals`。这是 main 带入的既有不一致，不是本次冲突手工引入的，但最终树里确实不一致。

### 低：ADR 声称 P5-3 已使用 `unseen` 判定，但当前树没有
- 文件:行：`docs/adr/0225...:58`、`docs/adr/0226-external-agents-propose-rules-through-the-rule-proposal-flow.md:55`
- 问题：两处都写“P5-3 接待确认时直接用这个判定结果”，但 P5-3（ADR 0227）只做认证；当前代码里 `mcpProposalAnswer` 只被 `production-mcp-read.ts` 和测试引用，没有任何 P5-3 接线。
- 证据：
  - 两处 ADR 原文：`P5-3 接待确认时直接用这个判定结果。`
  - `grep mcpProposalAnswer` 只命中 `apps/agent-service/src/production-mcp-read.ts:176,616,748` 和 `test/integration/mcp-write.test.ts:541-546`。
  - `docs/adr/0227...:37` 说待确认写入由 ADR 0228 另行决定，而仓库里没有 `docs/adr/0228*`。
- 建议：把“P5-3 接待确认”改成“ADR 0228 的待确认流程”或删掉这句。我判断这是面向未来的说明，不是当前代码缺陷，但按现在的树读会误导。

### 低：`askedAt` 损坏分支缺少自动用例
- 文件:行：`apps/agent-service/src/production-mcp-read.ts:589`、`:732`
- 问题：ADR 说“状态里的发出时间不是有效数字，按状态损坏回「内容变了」”，代码用 `!Number.isFinite(state.askedAt)` 实现了，但没有测试真正走到这个校验；现有 NaN 用例测的是 `mcpProposalAnswer` 的 `answeredAt`。
- 证据：
  - 代码：`!Number.isFinite(state.askedAt) ||` 后接 `MCP_PROPOSE_MEMORY_CHANGED.text`。
  - 测试只有：`expect(mcpProposalAnswer("decline", 0, Number.NaN)).toBe("unseen");`（`test/integration/mcp-write.test.ts:545`）。
- 建议：加一条用测试 seam 或直接构造非有限 `askedAt` 的状态，断言回“内容变了”。严重度低，因为状态由 HMAC 签名，外部客户端不容易伪造。

### 信息：删脚本的说法需要按基线理解
- 文件:行：`git diff 2997b499..0099a4fa --name-status`
- 问题：相对 main（2997b499），这两个脚本不在 diff 里；相对 PR 分支第一父提交（`0099a4fa^1`）才显示 `D scripts/operations/mcp-write-acceptance.mjs` 和 `D test/tooling/mcp-write-acceptance.test.mjs`。这不影响正确性，但作者说法容易被理解成“main 上删了文件”。
- 证据：`git diff --name-status 2997b499..0099a4fa` 只列出 `production-mcp-read.ts`、两个 ADR、`prompt-manifest.json`、`tools.ts`、`mcp-write.test.ts` 和 review 记录；脚本删除出现在 `git diff --name-status 0099a4fa^1..0099a4fa`。
- 建议：提交说明里明确“这两个文件只存在于本 PR 分支，合并时删除”。

## 读代码证实的

- 合并结果确实同时保留了两边：
  - `test/integration/mcp-write.test.ts:297-312` 的 `slowDecided` 只在 `slowDecidedMs` 设置时包 `Proxy`。
  - `:313-329` 使用 `createMcpAccess`、`bindFirstOwner`、`access.verifier`、`owners`，并按 `readOnly` 决定是否传 `write`；`write.proposals` 和 `write.rules` 都被 `slowDecided` 包住。
  - `:381` 用 `cf-access-jwt-assertion` 头连接，和 `production-mcp-read.ts:92` 的 `MCP_ACCESS_ASSERTION_HEADER` 一致。
- `unseen` 判定在 OAuth 接线下仍被测试覆盖：
  - 直接函数边界：`test/integration/mcp-write.test.ts:541-546`。
  - 记忆：`:540-591`；规则：`:900-929`。
  - 空 schema 断言：`:496` 和 `:847`，都等于 `{ type: "object", properties: {} }`，和 `production-mcp-read.ts:677`、`:793` 一致。
- “慢读不推迟计时起点”用例：`test/integration/mcp-write.test.ts:593-601` 设 `slowDecidedMs = 2_000`，断言仍返回 `MCP_PROPOSE_NOT_SHOWN.text`，并检查 `slowReads() === 2`，说明两个写入器的 `decided` 都被放慢。
- 删脚本无残留：全仓库 grep `mcp-write-acceptance` 无命中；grep `MCP_WRITE_SECRET`、`write.secret`、`READ_SECRET`、`WRITE_SECRET` 也都没有残留。
- 作者说的脚本不兼容属实：`git show 0099a4fa^1:scripts/operations/mcp-write-acceptance.mjs` 里是 `secret: readSecret` 和 `write: { secret: writeSecretValue, ... }`，没有 `access`/`owners`。
- 无冲突标记：`git diff --name-only --diff-filter=U 0099a4fa` 为空；全仓库 grep 冲突标记只命中第三方声明文件的分隔线。

## 推测 / 未核实

- ADR 里“P5-3 接待确认时直接用这个判定结果”可能是想指未来的 ADR 0228 待确认流程；仓库里没有 0228，无法证实。
- 我没有运行测试，所以“反向用例会失败”是基于读断言的判断，不是实际运行结果。
- `prompt-manifest.json` 的新 sha256 没有实际计算核对；`check:prompt-catalog` 会在运行时校验，建议合并前跑一次。

## 侧重检查

- 错误路径：`unseen`、取消、拒绝、接受四条路径都读到了；`NaN`/时钟倒退分支有直接函数用例；损坏 `askedAt` 状态缺自动用例（见上）。
- 不可信输入：`action`、`text`、`client` 仍走原有校验；`askedAt` 来自 HMAC 签名的 `requestState`，不是客户端直接可写字段。新增的 `askedAt` 只参与时间判断，不写库。
- 安全：去掉勾选框后，客户端自动回 `accept` 会直接保存；ADR 0225 明确接受这一取舍，并说明确认框不是防恶意客户端的边界。OAuth 下所有绑定主人的客户端在 `proposals` 打开时都有写权限，这也是 main 的 ADR 0227 决定，不是本次冲突引入。
- 资源耗尽：本次只给签名状态增加了一个数字字段和一条固定文案；没有新增无界集合或逐轮增长的结构。
- 不可撤销操作：保存记忆/规则仍只在 `accepted` 分支执行；`unseen` 分支在写库前返回，未见误写。
- 文档与代码一致性：发现上面两条 ADR 0225 的陈旧描述；除此之外，`mcp.propose-not-shown` 在 `tools.ts`、`prompt-manifest.json`、`production-mcp-read.ts` 和测试之间是通的，删除的 save-label/`MCP_PROPOSAL_SAVE_FIELD` 没有残留。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会改变 Himawari 自己发给模型的请求。`packages/prompt-catalog/src/tools.ts` 的改动只被 `apps/agent-service/src/production-mcp-read.ts` 使用（`grep` 结果只有该文件和测试），是给外部 MCP 客户端的工具说明/确认框文字，不进入 Himawari 的对话历史、系统提示或工具定义。发给模型的内容仍只在末尾追加，每轮会变的值仍只在最后一条消息；本次没有改请求组装。注意：外部 agent 的客户端若把 MCP 工具定义当作自己的模型请求前缀，部署后这些工具说明会变一次，但那不受 Himawari 的只追加规则控制。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会新增这种问题。新增的 `askedAt` 是签名 `requestState` 里的数字，每次提议会变，但它不是模型提示文本；`MCP_PROPOSE_NOT_SHOWN`、新的确认框模板都是固定字符串。`text`、`client` 这类本来就随提议变化的槽位没有改变行为，也没有新增无序集合。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有。`test/integration/mcp-write.test.ts` 覆盖阈值边界、立即 decline/cancel、慢读、之后真正 accept/decline、决策记录和空 schema；`check:prompt-catalog` 会校验清单哈希。读代码判断：把 `mcpProposalAnswer` 的阈值判断删掉或写反，`:541-546` 会失败；把 `started`/`received` 的采样挪到慢读之后，`:593-601` 会失败（2000ms > 1500ms，会变成 `declined`）；把 `slowDecided` 只包一个写入器，`:598` 的 `slowReads() === 2` 会失败。未实际运行测试，因此不声称已观察到失败。`askedAt` 非有限值的状态校验没有自动用例。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   - `askedAt`：产生于 `production-mcp-read.ts:686`、`:802`；两边 mint 都带；校验于 `:589`、`:732`（`Number.isFinite`）；消费于 `:616`、`:748`。没有发现漏 mint 或漏校验的路径。
   - `MCP_PROPOSAL_UNSEEN_ANSWER_MS = 1_500`：函数和测试共用，没有 magic number 漂移。
   - `mcp.propose-not-shown`：`tools.ts:360` 产生，`prompt-manifest.json:392` 登记，`production-mcp-read.ts:617`、`:749` 使用，测试引用；两端一致。
   - 删除的 `MCP_PROPOSAL_SAVE_FIELD`、`mcp.propose-memory-save-label`、`mcp.propose-rule-save-label`：全仓库无残留引用。
   - 删除的两个脚本：全仓库无残留引用；`package.json`、CI 脚本、文档都没有引用。
   - 测试夹具 `createMcpAccess`/`bindFirstOwner`：和 `admit()` 读取的 `cf-access-jwt-assertion`、`readBySubject`、`externalSubjectRef` 一致。
   - 唯一发现的两端不一致是 ADR 0225 仍描述 `writeSecretRef` 被接受，而 ADR 0227 和启动配置测试都要求拒绝（见上）。
