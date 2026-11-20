## 范围

本轮先看 `git diff 8c523d0bc6a9e21499cdd307feb1633ba3b93dd2..dc4bcf9929d281473e5d43bb1db0e19ea9797772`，再定位到实际修复提交 `932c2c5fe`（另一个 `a1e083b43` 只是复核记录）。增量真正改动的是 `production-mcp-memory-writer.ts`、`production-mcp-read.ts`、`prompt-catalog/src/tools.ts`、ADR 0281 和 `mcp-write.test.ts`；从这个区间合入的 main 代码（PR 588 的 `sync_memories`、Apple 客户端等）不是本 PR 作者的增量，本轮未深入复核。旧代码只在证据指向时跟读。

## 上一轮意见核对

- 意见 1（敏感内容可被外部 agent 自己声明的分类绕过）：代码未改，只改了 ADR 和工具说明，明确写成“已知缺口、Andy 已选先接受”。仍在，见下文意见 2。
- 意见 3（去重命中仍带批次号）：`#keep` 的修复本身正确，但新增测试没有真正覆盖这条分支，见意见 4。
- 意见 4（摘要缓存没有自动检查）：已由新增 `activeScanCount` 用例覆盖；去掉缓存会扫描 3 次，用例会失败。已改好。
- 意见 5（内存代际未建立时直接存回“失败”）：`proposals.ready()` 门控已加，新增未就绪用例会让回退后的代码失败。已改好。

## 意见

### 1（中高）改了 `propose_memory` 工具说明，却没有更新 prompt 清单，自动检查会失败

- 文件:行：`packages/prompt-catalog/src/tools.ts:370`、`packages/prompt-catalog/prompt-manifest.json:387-391`、`apps/agent-service/test/prompt-catalog.unit.test.ts:187`
- 问题：本增量把 `MCP_TOOL_PROPOSE_MEMORY.text` 从“敏感内容（例如健康、财务、证件）”改成“你把分类选成健康、财务、证件的内容……”，但 `mcp.propose-memory` 的清单摘要仍是旧值，`changedIn/reason` 也没更新。清单检查按 `segments` 的 JSON 算 sha256，工具说明正是 `segments` 的唯一文本，因此必然报 `PROMPT_MANIFEST_STALE mcp.propose-memory`。
- 证据：清单里仍是
  ```json
  "mcp.propose-memory": {
    "sha256": "e0d4d1f4b9a5561e5cb0dd1bf2baee48f0d9bd03be1e55b0e6e21e264d4dd195",
    "changedIn": "MCP 直接存",
    "reason": "按接入设置直接存记忆：工具说明、回执文字"
  },
  ```
  而检查代码是：
  ```ts
  if (row.sha256 !== digest(entry)) problems.push(`PROMPT_MANIFEST_STALE ${entry.id}`);
  ```
  `fixedPrompt` 把 `text` 原样放入 `segments`（`packages/prompt-catalog/src/entry.ts:29`），所以文本一改摘要必变。`git show 932c2c5fe --name-only` 也没有 `prompt-manifest.json`。
- 建议：用 `PROMPT_MANIFEST_WRITE=1 PROMPT_MANIFEST_CHANGED_IN=… PROMPT_MANIFEST_REASON=…` 重新生成清单，并把 `changedIn` 写成本 ADR/本次改动。

### 2（中高）上轮“敏感内容可被自定义分类绕过”仍未在代码里修好，工具说明反而把保护说成由外部 agent 自己选分类决定

- 文件:行：`apps/agent-service/src/production-mcp-memory-writer.ts:94-101`、`:287`、`packages/gateway-contracts/src/contracts-v2.ts:2010`、`packages/prompt-catalog/src/tools.ts:370`
- 问题：直接存是否放行只取决于 `proposal.dataClassification` 是否为 `private`；而 `dataClassification` 来自 `proposalClassification`，只认 `health`、`finance` 两个分类，或正文里的证件号/银行卡号。外部 agent 把健康、财务内容标成 `other`/`identity` 时仍会直接入库。本增量没有改这条路径，只是 ADR 把缺口写成“Andy 已接受”。同时新工具说明写“你把分类选成健康、财务、证件的内容……会先放进待确认”，但 `证件` 不是可用分类（可用分类见 `EXTERNAL_PROPOSAL_CATEGORIES`），`identity` 也不在敏感分类清单里，说明会让外部 agent 误以为选分类就能得到保护。
- 证据：
  ```ts
  if (proposal.status === "pending" && proposal.dataClassification !== "private")
    return "pending";
  ```
  ```ts
  return (MEMORY_SENSITIVE_CATEGORY_NAMES as readonly string[]).includes(category)
    ? "sensitive"
    : classificationWithIdentifiers(text, "private");
  ```
  ```ts
  export const MEMORY_SENSITIVE_CATEGORY_NAMES = ["health", "finance"] as const;
  ```
  ADR 0281:74 也确认“外部 agent 把健康、财务内容标成别的分类时，会以 private 不经确认直接入库”。
- 建议：若要按 Andy 的决定继续接受缺口，至少把工具说明改成与代码一致，不要暗示 `证件`/`identity` 分类会自动转入待确认；更稳妥的做法是由服务端按正文/类别重新定级，而不是信任外部 agent 自报的分类。

### 3（低）ADR 说“直接存的条目不占待确认和暂存上限”，与提交端先计入待确认再保存的代码不符

- 文件:行：`docs/adr/0281-memory-from-outside-agents-saves-directly-when-the-owner-turns-it-on.md:75`、`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:158-172`
- 问题：ADR 写“直接存的条目不占待确认和暂存的条数上限，只受每分钟调用次数和每次 50 条的限制”。但所有直接存条目都先走 `submit` 插入为 `pending`，提交前会按当前 `pending` 数量和未提交正文数量检查上限；已有 1000 条待确认时，新的直接存单条也会被 `EXTERNAL_MEMORY_PROPOSAL_PENDING_FULL` 拒绝，`propose_memories` 里会逐条回 `full`。
- 证据：
  ```sql
  SELECT SUM(status = 'pending') AS pending, COUNT(*) AS held
  FROM external_memory_proposals
  WHERE owner_id = ? AND agent_id = ? AND status <> 'committed' AND content_ref IS NOT NULL
  ```
  ```ts
  if (!seen && ((held.pending ?? 0) >= EXTERNAL_PROPOSAL_PENDING_MAXIMUM ||
      held.held >= EXTERNAL_PROPOSAL_HELD_TEXT_MAXIMUM)) { ... }
  ```
  提交之后才由 `keepDirect` 立即 `committed`。
- 建议：把 ADR 改成“保存完成后不占待确认/暂存上限；保存前仍按现有待确认上限检查”，或者说明待确认已满时直接存也会被拒。

### 4（低）“去重不进批次”的修复没有被新测试真正覆盖，回退该行测试仍会通过

- 文件:行：`test/integration/mcp-write.test.ts:2372-2384`、`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:230-276`、`apps/agent-service/src/production-mcp-read.ts:1268-1273`、`:1289`
- 问题：新增的“全重复批次”用例连续两次 `propose_memories` 发送同一段 `PARK`。第二次在 `proposals.submit` 阶段就查到已有 `committed` 的提议，直接返回 `already_saved`，根本不会进入 `keepDirect`/`#keep` 的 `same` 分支，也就不会触发本次修改的 `batchId: null` 行。把 `production-mcp-memory-writer.ts:326` 改回去，这个用例仍然通过。
- 证据：新用例只有
  ```ts
  await batch(muse, [{ text: PARK }]);
  await batch(muse, [{ text: PARK }]);
  expect((await web.overview()).externalProposals.batches).toHaveLength(1);
  ```
  而 `#proposeMemories` 只在 `result["status"] === "pending"` 时调用 `keepDirect`，`submit` 对已存在的 committed 提议返回 committed，结果直接是 `already_saved`。修复行是：
  ```ts
  await this.#commit(proposal, same, input.direct ? { ...input, batchId: null } : input);
  ```
- 建议：增加一个能真正走 `#keep` 去重分支的用例：先用非外部提议路径（例如主人记忆或直接写 memory state）造一条同文活跃记忆，再对该文本做一次直接存，断言不会新增/只出现不含该条目的批次；这样把 `batchId: null` 回退时用例才会失败。

### 5（低）ADR 的自动检查数量已过时

- 文件:行：`docs/adr/0281-memory-from-outside-agents-saves-directly-when-the-owner-turns-it-on.md:76`
- 问题：ADR 写“`test/integration/mcp-write.test.ts` 的四个 `[direct]` 用例”，本增量新增两个后实际已有六个 `[direct]` 用例。
- 证据：`grep -n "\[direct\]" test/integration/mcp-write.test.ts` 命中 6 处（2277、2310、2328、2363、2372、2387）。
- 建议：改成“六个”，或改为不写死数量的表述，避免以后再次漂移。

## 侧重检查

- 错误路径：直接存未就绪现在回“待确认”而不是“失败”，单条路径和批量路径都检查了 `ready()`；未发现新的错误返回。
- 不可信输入：`#readProposalArgs` 仍校验文本长度、分类白名单、机器密钥；但“分类自报即决定敏感与否”的信任问题仍在，见意见 2。
- 安全：直接存绕过了主人确认；敏感内容只靠 `health/finance` 分类和标识符扫描兜底，外部 agent 可规避，见意见 2。
- 资源耗尽：同一批只扫描一次活跃记忆的缓存已生效并有测试；直接存条目仍会在提交瞬间占用待确认条数，见意见 3。
- 不可撤销操作：去重条目改为 `batchId = null`，不再生成空批次；`listBatch/listBatches` 排除了空批次，`undoBatch` 不会误删既有记忆。代码层面正确，但缺少能覆盖该分支的测试，见意见 4。
- 规则/说明与代码一致性：ADR 的“不占上限”、`[direct]` 用例数量、工具说明里的“证件”分类均与代码不一致；prompt 清单未更新，见意见 1、3、5。

## 读代码证实的 / 推测的

读代码证实：

- `prompt-manifest.json` 的 `mcp.propose-memory` 摘要在本增量中没有更新，工具说明文本已变，检查必然报 `PROMPT_MANIFEST_STALE`。
- `proposalClassification` 只把 `health`、`finance` 或标识符命中判为 sensitive；`keepDirect` 只对非 `private` 留待确认。
- 新 `activeScanCount` 用例确实覆盖摘要缓存：3 条新记忆只会扫描一次 `listActive`。
- 新增未就绪用例会在去掉 `ready()` 门控后失败（`book` 实际就绪，会直接保存）。
- “全重复批次”用例在 `submit` 阶段就返回 committed，不会进入 `#keep` 的 `same` 分支。
- `batchId = null` 的消费端可接受：SQLite 迁移允许 `batch_id IS NULL`；`decide` 允许 committed 且 `batchId` 为 null；`listBatch/listBatches` 排除 null；导出校验只要求 `memoryId` 与状态一致，不要求 `batchId` 与 `memoryId` 对应。

推测：

- 工具说明中的“证件”可能被外部模型理解为 `identity` 分类，从而误以为该分类会自动待确认；这是语义推断，代码只证明 `identity` 不属于敏感分类。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不改变 Himawari 自己模型的请求：本增量改的是 `MCP_TOOL_PROPOSE_MEMORY.text`，只在 `production-mcp-read.ts:830` 作为外部 MCP 工具描述发给外部客户端，不在 Himawari 自己的系统提示/工具/历史里。没有把每轮会变的值挪进开头，仍是只追加。需要注意的是它确实改变了外部 MCP 客户端看到的工具定义一次；且如上所述 prompt 清单没有同步，自动检查会失败。
2. **同一段文字会不会在不同请求里变成不同字节？** 本增量没有引入依赖前后文的遮盖、时间字段或无序集合。`batchId: null` 是确定值，工具说明是静态字符串，未发现新的不确定性。旧有的 `randomUUID()` 只用于批次号，不进入模型提示。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 摘要缓存：有，新增 `activeScanCount` 用例，移除缓存会失败。未就绪：有，移除 `ready()` 门控会失败。去重不进批次：**没有有效覆盖**，新“全重复批次”用例走不到改动分支，回退改动仍通过，见意见 4。prompt 说明改动：有清单检查，但当前清单未更新，检查会失败，见意见 1。
4. **改动产生/修改的每个值，使用端都能接受吗？** `batchId: null` 的使用端已逐个核对：SQLite 写入/迁移、`listBatch/listBatches`、`undoBatch`、导出校验都能接受；`ready()` 是既有端口方法，调用端存在。未发现 `batchId: null` 造成运行期错误。`MCP_TOOL_PROPOSE_MEMORY.text` 的直接使用端是 `production-mcp-read.ts:830`，能接受新文本；但清单使用端 `prompt-catalog.unit.test.ts` 不能接受旧摘要，属于必须修的一端。ADR 中“不占待确认上限”的说法与提交端代码不一致，见意见 3。
