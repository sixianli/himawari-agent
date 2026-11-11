## 结论

本轮“合入 main 后再看 manifest”这一项核对通过：合并后的 `packages/prompt-catalog/prompt-manifest.json` 与两个父提交改动的并集一致，PR 392 的 `mcp.*` 条目、main 新增的 `memory.embedding-*` 条目都正确，两条 `save-label` 确实已删除。没有发现阻塞问题。

有 1 条低严重度的错误路径问题（规则提议复用了记忆的“未就绪”文案），以及 1 处测试缺口；另外作者“键序符合 biome”的说法不准确——键序不是 biome 管的。

## 发现（按严重度从高到低）

### 低 —— `propose_rule` 的“未就绪”分支返回记忆专用文案，且该分支没有测试

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:574-575`
- 问题：规则提议路径检查的是记忆提议的 `proposals.ready()`，失败时直接返回 `MCP_PROPOSE_MEMORY_NOT_READY.text`。这段文字是“Himawari 的记忆功能还没准备好，这次没有保存”，对外部 agent 描述的是记忆功能，而不是规则未生效。`unsupported` 分支还复用了记忆文案，但那条本身较通用。
- 证据（我读到的代码）：
  ```ts
  // production-mcp-read.ts:572-575
  if (!elicitationSupported(context.mcpReq.envelope))
    return proposalReply(MCP_PROPOSE_MEMORY_UNSUPPORTED.text, true);
  if (!(await this.#options.write?.proposals.ready()))
    return proposalReply(MCP_PROPOSE_MEMORY_NOT_READY.text, true);
  ```
  ```ts
  // packages/prompt-catalog/src/tools.ts:396-403
  export const MCP_PROPOSE_MEMORY_NOT_READY = fixedPrompt({
    id: "mcp.propose-memory-not-ready",
    ...
    text: "Himawari 的记忆功能还没准备好，这次没有保存。",
  });
  ```
  `McpRuleProposals` 没有自己的 `ready()`（`production-mcp-read.ts:141-149`），所以这里只能借记忆写入器的就绪状态。测试里只覆盖了 `propose_rule` 的 `elicitation:false`（`test/integration/mcp-write.test.ts:972-974`），没有覆盖 `proposals.ready()` 为假的规则路径。
- 建议：新增 `mcp.propose-rule-not-ready`（或把这条改成“Himawari 的写入功能还没准备好，这次没有生效”），并补一个 `proposals.ready()` 返回 false 时 `propose_rule` 的错误路径用例；是否真的能用规则的 readiness 判断，需要按 `ProductionMcpRuleWriter` 的依赖确认。

### 低 —— manifest 的合并一致性没有专门的自动检查，`UNKNOWN` 没有反向用例

- 文件:行：`apps/agent-service/test/prompt-catalog.unit.test.ts:175-195`、`339-381`
- 问题：现有测试能发现“main 条目丢失”（`PROMPT_MANIFEST_MISSING`）、“hash 未更新”（`PROMPT_MANIFEST_STALE`）、“多余条目”（`PROMPT_MANIFEST_UNKNOWN`），足以拦住本次合并的常见错误。但反向用例只显式测了 `STALE` 和 `MISSING`（第 370-381 行），没有对 `UNKNOWN` 的显式反向用例；也没有测试保证文件键序等于 `PROMPT_MANIFEST_WRITE` 生成顺序。
- 证据（我读到的代码）：
  ```ts
  // prompt-catalog.unit.test.ts:192-193
  for (const id of Object.keys(manifest))
    if (!ids.has(id)) problems.push(`PROMPT_MANIFEST_UNKNOWN ${id}`);
  ```
  ```ts
  // prompt-catalog.unit.test.ts:377-380
  expect(manifestProblems([changed], readManifest())).toContain(
    `PROMPT_MANIFEST_STALE ${first.id}`,
  );
  expect(manifestProblems([first], {})).toContain(`PROMPT_MANIFEST_MISSING ${first.id}`);
  ```
- 建议：加 `expect(manifestProblems([], { ghost: ... })).toContain("PROMPT_MANIFEST_UNKNOWN ghost")`；如果要防止“合并后键序漂移”，再加一个“manifest 键序 == `entries()` 排序”的断言（这不是本次合并的实际问题，但能让下一轮写 manifest 时更稳）。

### 说明 —— “JSON 键序和格式符合 biome”这一说法不准确

- 文件:行：`biome.json:14-25`、`apps/agent-service/test/prompt-catalog.unit.test.ts:162-165`、`303-315`
- 问题：`biome.json` 只启用了 formatter 和 recommended linter，没有启用 JSON 键排序规则。键序实际由 `PROMPT_MANIFEST_WRITE=1` 时 `Object.fromEntries(entries().map(...))` 的 `localeCompare` 排序写入决定。当前合并结果正好是两条“已排序分支”的并集（`mcp.*` 与 `memory.embedding-*` 不交错），所以键序没有问题；但把它归因于 biome 不准确。
- 建议：描述改成“格式通过 biome，键序与 `PROMPT_MANIFEST_WRITE` 的生成顺序一致”。

## 未核实

- 我没有重算任何 `sha256`：本环境只允许 read/grep/glob 和指定的 git 命令，不能运行 `node` 或测试。下面关于 hash 一致性的结论是结构性核对，不是重算结果。
- 我没有实际运行 `npm run check:prompt-catalog`、`check:prompt-prefix`、`mcp-write.test.ts`；只能确认反向用例代码存在。提交说明里写的“通过”和“把阈值改成 0 会失败”不是我的独立证据。
- 工作区是 72% 的 sparse checkout；对“已删除的 `save-label` 是否还有引用”的 grep 覆盖了存在的相关源码、测试和文档，但没有覆盖全部 100% 的文件。

## 侧重检查

查过的错误路径、不可信输入、安全、资源耗尽和文档一致性：

- **不可信输入**：`#proposeMemory` 用 `normalizeProposalText` 做 NFC、替换不可见控制字符并压缩空格，正文限制 2000 字符，分类走枚举；`#proposeRule` 限制 reason 200 字符，`params`/`summary` 交给 `parseOwnerRuleParameters` 校验，JSON schema 是 `additionalProperties:false`。测试覆盖了空正文、超长 reason、换行 summary、正则等（`mcp-write.test.ts:941-966`）。结论：入口校验在。
- **客户端自报名**：`CLIENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}/u`（`production-mcp-read.ts:105`）没有 `$` 锚点，但 `match()` 遇到允许字符以外的字符就停止，因此换行、引号、尖括号不会进入确认框文案；最多是截断前 64 个允许字符。没有注入问题，属于可接受的截断行为。
- **错误路径**：参数不合法返回 `*_INVALID`；签名状态不匹配/`askedAt` 非有限数返回 `*_CHANGED`；写入器异常走 `onFailure` 并返回 `*_FAILED`；极快拒绝/取消返回 `mcp.propose-not-shown` 且不写决策记录；`#oneAtATime` 防止同一提议并发重复保存。除上面“规则复用记忆未就绪文案”外，路径行为与 ADR 0225/0226 一致。
- **安全/不可撤销操作**：真正写入只发生在 `accept`；`accept` 不受 1.5 秒阈值影响，1.5 秒阈值只把 `decline`/`cancel` 降级为 `unseen`。ADR 明确写了确认框不是防恶意客户端的边界，写令牌才是；本轮没有改变这一点。
- **资源耗尽**：正文 2000 字符、reason 200、规则参数按列限 32 项；`requestState` TTL 600 秒；`#decidedRules` 有 TTL 清理；`#deciding` 在 finally 删除。未发现新增的无界增长路径。
- **文档与代码一致性**：ADR 0225/0226 写的“从工具开始处理带答案的重发时计时”“`askedAt` 非法按状态损坏回内容变了”“确认框不带字段”“拒绝/取消快速返回不记录”都能在 `mcpProposalAnswer`（`production-mcp-read.ts:176-183`）、`requestedSchema: { type: "object", properties: {} }`（`:677`、`:793`）和 `state.askedAt` 校验（`:589`、`:732`）对上。唯一不一致是规则路径的 `NOT_READY` 文案。
- **提示词/遮盖**：新增的 embedding 前缀没有引入新的、长度 ≥24 的固定文字段（唯一 ≥24 的仍是已经在目录里的 `MEMORY_EMBEDDING_QUERY_INSTRUCTION`），因此 `trustedPromptTexts` 的集合不变，既有对话的出口遮盖字节不受影响。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会（就 Himawari 自己的对话请求而言）。

- 本轮增量（`6dd171..d7ba`）对 `packages/prompt-catalog` 只有 `prompt-manifest.json` 的 5 条新增和 `src/memory.ts` 的新 embedding 条目；`src/tools.ts`、`src/index.ts`、`src/entry.ts` 相对 6dd171 没有 diff。相对 main，`src/memory.ts` 也没有 diff（即 main 的版本原样保留）。
- 新增的 5 条是 `layer: "embedding"`，只由 `packages/application/src/embedding-profiles.ts:50-102` 用于计算 embedding 输入，不进入对话的 system/tools/history。
- PR 392 对 `MCP_TOOL_PROPOSE_MEMORY`/`MCP_TOOL_PROPOSE_RULE` 的描述文字确实改了（`tools.ts:304`、`:421`），但它们的 `usedBy` 只有 `production-mcp-read.ts`，是**外部 MCP 客户端看到的工具说明**，不是 Himawari 自己对话请求的工具定义。外部客户端是否缓存这些说明由客户端自己管，Himawari 不冻结它；这不是 Himawari 请求开头的变化。
- 确认框文本是 `layer: "tool-result"`，作为确认/工具结果出现在末尾；`askedAt` 只放在签名 requestState 里，不进入文案。没有把每轮会变的值塞回系统提示或工具定义。仍然符合“只在末尾追加”和“每轮会变的值在最后”的规则。

### 2. 同一段文字会不会在不同请求里变成不同的字节？

不会。

- 新增文本都是 `fixedPrompt`/`templatePrompt` 的固定分段；确认框只有 `client`、`category`、`text`、`summary` 等槽位，`text` 先经过 `normalizeProposalText`（NFC、控制字符替换、空格压缩、trim），没有时间戳或 UUID 进入文案。
- `askedAt` 只影响 `mcpProposalAnswer` 选哪个固定结果（`unseen` / `declined` / `accepted`），不会改变同一段固定文案的字节。
- embedding 前缀是确定的；旧网关 Qwen3-8B 的查询格式 `Instruct: ${instruction}\nQuery:${query}` 与新模板 `text("Instruct: ") + instruction + "\nQuery:" + query` 在 `606862d3` 的 diff 里可逐字对上，文字未变。
- `embeddingIdentityFor` 用固定的 `JSON.stringify` 数组和固定的 redaction ruleset/artifact hash，同一配置下确定。
- 遮盖结果不变：新增的 embedding 文本段里没有新的 ≥24 字符固定文字（`packages/prompt-catalog/src/entry.ts:61-75` 的 trusted 清单不会新增条目），因此老对话的出口遮盖字节不变。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

有，但合并本身没有专用检查。

- `apps/agent-service/test/prompt-catalog.unit.test.ts`：
  - `manifestProblems` 检查每个导出条目都有 manifest 行、hash 匹配、`reason`/`changedIn` 非空，并检查 manifest 里没有多余 id（`:175-195`）。
  - 反向用例：改一个提示词但不更新 manifest → 期望 `PROMPT_MANIFEST_STALE`；manifest 为空 → 期望 `PROMPT_MANIFEST_MISSING`（`:370-381`）；“看起来像槽位的文字”与真槽位摘要不同（`:364-368`）。
- `apps/agent-service/test/prompt-wording.unit.test.ts` 会读同一份 manifest 检查禁用词和 emphasis，属于 `check:prompt-catalog`（`package.json:57`）。
- 因此：如果合并弄丢 main 的条目，会 `PROMPT_MANIFEST_MISSING`；如果 hash 被改坏，会 `PROMPT_MANIFEST_STALE`；如果两条 `save-label` 没删干净，会 `PROMPT_MANIFEST_UNKNOWN`。我没有实际运行，不能声称这些测试此刻是绿的；只确认断言逻辑会报错。
- `UNKNOWN` 没有显式反向用例，键序也没有断言（见上面的低严重度测试缺口）。
- 行为层有 `mcp-write.test.ts` 的边界断言（`:543-549`）和 unseen 路径（`:550-604`、`:903-939`）；提交 `51bc13b6` 说明里写了“把阈值改成 0 会让两条用例失败”，但我没有独立复现。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对如下：

- **manifest 键 / `sha256` / `changedIn` / `reason`**
  - 产生：`packages/prompt-catalog/src/*.ts` 的导出，`id` 和 `segments`；清单由 `PROMPT_MANIFEST_WRITE` 生成（`prompt-catalog.unit.test.ts:300-318`）。
  - 使用：`prompt-catalog.unit.test.ts` 的 `manifestProblems` 和 `prompt-wording.unit.test.ts` 的 `emphasisProblems`/`unfrozenProblems`；运行时代码不读 manifest。两端的校验就是这两个测试。`reason`/`changedIn` 只要求非空；`changedIn` 的 `ADR 0224/0225/0226` 文件都存在。
  - 合并核对：`git diff 6dd171..d7ba -- prompt-manifest.json` 只有 main 的 5 条新增；`git diff 6d63e1c..d7ba -- prompt-manifest.json` 只有 PR 的 4 条 sha/reason 变更、`mcp.propose-not-shown` 新增和两条 `save-label` 删除。`git diff 6d63e1c..d7ba -- src/memory.ts` 为空、`git diff 6dd171..d7ba -- src/tools.ts` 为空，说明两侧的源文本都没有在合并中被改，因此各自带过来的 hash 在结构上成立。`git diff --check` 干净。
  - **未核实**：hash 未在本环境重算。
- **被删的 `mcp.propose-memory-save-label` / `mcp.propose-rule-save-label`**
  - 产生：已从 `tools.ts` 删除；manifest 也没有。
  - 使用：`grep` 在现有工作区没有找到 `MCP_PROPOSE_*_SAVE_LABEL` 或这两个 id 的引用；`index.ts` 是 `export *`，不会残留导出；`production-mcp-read.ts` 已改用空 `requestedSchema`。**未核实**非 sparse 文件是否存在引用。
- **`mcp.propose-not-shown`**
  - 产生：`tools.ts:360-367`，manifest 第 392 行附近。
  - 使用：`production-mcp-read.ts:617`（规则）和 `:749`（记忆）；集成测试 `test/integration/mcp-write.test.ts:554/565/582/599/600/908/917/930`。id 不经过后端校验，只作为目录项；测试按文本引用。
- **`memory.embedding-query.gemma` / `.jina-v5` / qwen3 / document 两条**
  - 产生：`memory.ts:44-91`；manifest 有 5 条对应项。
  - 使用：`packages/application/src/embedding-profiles.ts:50-103` 的 profile；`embeddingProfileFor` 以 `(provider, model)` 查档案（`:131-139`）。模型名满足 `packages/platform-node/src/local-onnx-embedding.ts:52` 的 `^[a-z0-9][a-z0-9._-]{0,127}$`，也列入 `scripts/delivery-mode/make-packet.py:266-269` 的维度白名单。未发现 I-73 那种“清单产出但下游校验拒绝”的两端不一致。
- **序列化格式**
  - `renderPrompt` 按固定段顺序拼接；embedding `recipe` 用固定数组 `JSON.stringify`；manifest 用 `JSON.stringify(..., null, 2) + "\n"`。内容是确定的。

综上：本次 manifest 合并本身没有发现会阻断合入的问题；作者关于 `mcp.*` 条目、main 新增条目、删除 `save-label` 的三条核心说法均与代码一致。
