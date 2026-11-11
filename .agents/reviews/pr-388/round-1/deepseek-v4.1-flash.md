## 复核结论

### 一、读代码证实的问题（按严重度）

#### 1【中】去重路径会让 `storedFor` 的防重放兜底失效，与 ADR 0226 决定 4 的承诺不一致

- 位置：`apps/agent-service/src/production-owner-rules.ts:496-515`、`:647-656`、`:680-683`；`apps/agent-service/src/production-mcp-rule-writer.ts:60-66`、`:68-98`
- 问题：`storedFor(key)` 只按 `hash(key)` 推出规则编号去规则手册查；但 `#activate` 在同一组参数已有规则时会把规则编号换成**另一条已存在规则的编号**：

  ```ts
  const ruleId = `${OWNER_RULE_ID_PREFIX}${hash(proposal.key).slice(0, 24)}`;
  const same = existing.find(
    (row) => row.ruleId !== ruleId && sameRule(row.parameters, parsed.type, parsed.params),
  );
  if (same) {
    await this.reconfirm(same.ruleId);
    return Object.freeze({ ... ruleId: same.ruleId, ... });
  }
  ```

  而兜底检查是：

  ```ts
  async storedFor(key: string): Promise<boolean> {
    const ruleId = `${OWNER_RULE_ID_PREFIX}${hash(key).slice(0, 24)}`;
    return (await this.#options.rules.read({ ...this.#scope(), ruleId })) !== undefined;
  }
  ```

  另外，提议 JSON 里的 `key` 只在第一次 `#writeText(proposalId, JSON.stringify(proposal))` 时写入，之后同内容提议复用同一载荷，`key` 可能仍是另一个提议编号的 `mcp:<uuid>`（`#writeText` 在载荷已存在时直接跳过，见 `production-owner-rules.ts:397-398`、`:647-656`）。

- 后果：如果标记写入失败/丢失，而这次生效走了“已有同参数规则，只重新确认”的路径，则 `storedFor(mcp:<本次提议编号>)` 为 false。此后主人撤销那条规则，再重放旧确认，`confirm` → `#activate` 会在 `includeRetired:false` 里找不到它，于是按 `hash(key)` 新建/恢复规则。这正是 ADR 0226 决定 4 和 `MCP_PROPOSE_RULE_ALREADY_SAVED` 文本声称不会发生的情况。
- 建议：让 `storedFor` 同时按规范化参数匹配已有规则（含已撤销），或让外部提议始终使用与规则内容绑定的稳定规则编号；或者把“提议编号 → 规则编号”的持久结论放在激活前/同一事务里。补一条“已有同参数规则时确认、撤销、删标记、重放”的测试。

> 补充（文档与代码不一致）：ADR 0226 说查规则手册能防“写标记前**进程中断**”。但 `requestState` 的签名密钥是每进程随机（`production-mcp-read.ts:303-307` 的 `key: randomBytes(32)`），进程重启后旧确认本来就会验签失败、无法重放。`storedFor` 实际防的是**同一进程内标记写入失败后仍用旧状态重试**。ADR 的措辞不准确。

#### 2【中低】规则已生效后标记写失败，却返回“没有生效”

- 位置：`apps/agent-service/src/production-mcp-rule-writer.ts:81-97`；`apps/agent-service/src/production-mcp-read.ts:541-543`
- 问题：`confirm` 已经写入规则和规则类记忆，之后才写 `rule-decision:mcp:<提议编号>`：

  ```ts
  const active = await this.#options.rules.confirm(receipt.proposalId);
  if (active.ruleId === null) throw new Error("MCP_RULE_NOT_ACTIVE");
  try {
    await this.#options.payloads.put(...);
  } catch (error) {
    if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.DUPLICATE)
      throw error;
  }
  ```

  非 `DUPLICATE` 的标记写入错误会冒到 `#proposeRule` 的 `catch`，返回 `MCP_PROPOSE_RULE_FAILED`（“这次没能让规则生效……不要告诉主人已经生效了”）。
- 后果：规则实际已生效，外部 agent 和主人却被告知失败；可能触发错误重试或错误汇报。这不是正常拒绝路径。
- 建议：`confirm` 成功后把标记写入失败当作非致命（记录 `onFailure` 并继续返回已生效），或把标记写入做成幂等/可恢复的持久结论，或在失败时回查规则状态并返回“已生效”。补故障注入用例（规则生效后让载荷写入失败）。

#### 3【低】外部规则记忆在记忆来源页/报表中被归为“整理记忆产生的”

- 位置：`apps/agent-service/src/production-owner-rules.ts:424`；`apps/control-center/src/memory-source.ts:23-24`；`scripts/operations/memory-source-report.mjs:23`
- 问题：外部规则的 `key` 是 `mcp:<uuid>`，因此规则类记忆编号是 `memory:rule:mcp:<uuid>`；但两个分类器只认：

  ```ts
  if (item.memoryId.startsWith(EXTERNAL_PROPOSAL_MEMORY_PREFIX)) return "external";
  // EXTERNAL_PROPOSAL_MEMORY_PREFIX = "memory:mcp:"
  ```

  ```sql
  WHEN m.id LIKE 'memory:mcp:%' THEN 'external'
  ```

  `memory:rule:mcp:<uuid>` 两个都不匹配，最后落到 `tidy`（“整理记忆产生的”）。
- 后果：外部 agent 提议、主人确认的规则记忆，在记忆页和来源报表里不被识别为“外部”。这是 I-73 式的“新 id 两端校验不一致”。注意：P2-3 的聊天规则记忆同样会落到 `tidy`，所以这可能是一个已有分类缺口；但本 PR 明确引入了外部来源，至少应确认这是否符合预期。
- 建议：两个分类器都识别 `memory:rule:mcp:`，或调整记忆编号前缀；在 `memory-source-report` 测试中加一条外部规则记忆用例。

#### 4【低】外部错误提示文字与实际参数校验不一致

- 位置：`packages/prompt-catalog/src/tools.ts:556`；`packages/application/src/rules/rule-types.ts:61`、`:78`、`:80-83`
- 问题：提示文字说“每项 1 到 64 字、……不能用正则或不可见字符”，但：

  ```ts
  const PHRASE_MIN = 2;
  ...
  if (length < minimum || length > OWNER_RULE_ENTRY_LIMIT)
  ```

  `phrases`/`excludePhrases` 实际至少 2 个字；列表项的校验正则只拒绝 `Surrogate/Cc/Cf`，不拒绝 `Zl/Zp`（U+2028/U+2029 这类行/段分隔符）。

  ```ts
  if (/[\p{Surrogate}\p{Cc}\p{Cf}]/u.test(entry)) invalid(`${key} 里有不可见字符`);
  ```

- 后果：外部 agent 按提示提交 1 字词语会被拒；提交 U+2028 等不可见分隔符却可能通过。提示和校验行为不一致。
- 建议：要么把提示改成“词语/排除词至少 2 字”，并把 `Zl/Zp` 纳入拒绝；要么放宽/明确校验。补 1 字词语和 U+2028 的正反用例。

#### 5【低】`propose_rule` 的“服务未准备好”检查用的是记忆提议写入器

- 位置：`apps/agent-service/src/production-mcp-read.ts:497`
- 证据：

  ```ts
  if (!(await this.#options.write?.proposals.ready()))
    return proposalReply(MCP_PROPOSE_MEMORY_NOT_READY.text, true);
  ```

- 后果：`propose_rule` 的可用性被 `proposals` 绑定。当前 `McpWriteAccess` 要求 `proposals` 和 `rules` 同时存在，所以暂时不会出错；但若以后只接规则写入器，`write.proposals` 为 undefined 时这里会抛 TypeError，被外层 `catch` 变成 `MCP_PROPOSE_RULE_FAILED`，而不是“未准备好”。这是接口耦合问题。
- 建议：给 `McpRuleProposals` 增加 `ready()`，或显式检查 `write.rules` 的存在与就绪。

#### 6【低/成本】预览回放可被反复触发

- 位置：`apps/agent-service/src/production-mcp-read.ts:553`；`packages/application/src/services/owner-rule-replay.ts:130-188`
- 说明：每次首次调用和每次“没有 inputResponse 的重发”都会执行 30 天回放；接受时 `create` 内部还会再回放一次（`production-owner-rules.ts:629`）。写令牌持有者每分钟最多 30 次请求（`bearer-admission.ts:4`），仍可反复触发最多 `4 × ruleReplayMailsPerOutcome` 条决策记录的读取/解密。
- 判断依据：这是读代码得出的调用次数和上限；实际配置的 `ruleReplayDays` / `ruleReplayMailsPerOutcome` 数值未读到，未量化成本。
- 建议：把预览结果按 `argsHash` 缓存在 requestState 或提议里，确认时复用；至少避免“同一提议每次重发都重算”。

#### 7【低】ADR 说来源写 `mcp:`，但去重路径不会更新来源

- 位置：`apps/agent-service/src/production-owner-rules.ts:501-514`
- 问题：已有同参数规则时走 `reconfirm(same.ruleId)` 后直接返回，没有把已有规则的 `source` 改为 `mcp:<client>`，也不会写外部提议的规则类记忆。ADR 0226 决定 3 说“规则来源写 `mcp:<客户端名>`，规则手册里看得出是外部提议的”，在这种情况下不成立。
- 建议：在 ADR 里写明去重路径保留原规则来源/记忆，或决定是否允许更新来源。

### 二、推测与未核实

- **未核实**：没有运行任何测试。以下关于“反向用例会失败”的判断来自读测试代码和实现逻辑，未实际执行。
- **未核实**：`packages/prompt-catalog/prompt-manifest.json` 新增项的 SHA-256 是否正确，无法在此环境计算；`apps/agent-service/test/prompt-catalog.unit.test.ts:300-319` 会按 `JSON.stringify(segments)` 重算并比对。
- **推测**：如果 `configuration.runPolicy.mcpRead` 打开但邮件检查（`proactive`）未配置，`propose_rule` 仍能创建规则，确认框会显示“回放不可用”，但规则之后不会被任何邮件检查执行。ADR 没有明确要求此时隐藏工具。
- **推测**：把新提示词加入 `TRUSTED_PROMPT_TEXTS`（`packages/prompt-catalog/src/trusted.ts`）会扩大“固定文字”清单。由于这些文字是新字符串，理论上只可能影响恰好包含这些新字符串的内容；已有历史里不应出现它们，所以不会改变已发历史字节。没有读到会用到这些新文字的既有模型请求。

### 三、侧重检查

- **错误路径**：检查了标记写入失败、`confirm` 失败、规则到达上限、参数非法、类型未知、多出参数、客户端不支持 elicitation、只读令牌、老版本连接、回放算不出来、重复/并发重发、撤销后重放。发现第 1、2 条问题；其余路径按代码会返回固定错误或正确拒绝。
- **不合规范/不可信输入**：`parseOwnerRuleParameters` 对类型、未知键、列表项数、长度、不可见字符、排除词全排除做了校验；`reason` 经 `normalizeProposalText` 去掉 `Cc/Cf` 并限制 200 字；客户端名被 `CLIENT_NAME` 正则限制为 64 字符。发现提示文字与 `phrases` 最小长度/`Zl/Zp` 不一致（第 4 条）。
- **安全**：`propose_rule` 只在 modern + 写令牌 + `write.rules` 存在时注册；`requestState` 有签名和 10 分钟 TTL；拒绝只写进程内记录，进程重启后旧状态失效。防重放的主标记在 `accept` 末尾写入，去重路径有兜底缺口（第 1 条）。
- **资源耗尽**：`#deciding` 按提议编号排队并在完成后删除；`#declinedRules` 只在处理规则提议时清理过期项，上限受请求频率和 10 分钟 TTL 约束。回放成本见第 6 条。
- **不可撤销操作**：规则和规则类记忆由 P2-3 流程写入，撤销会归档记忆并把规则置为 retired；外部提议本身不能撤销。发现“规则已生效但标记写失败被报失败”（第 2 条），以及崩溃窗口下可能留下规则类记忆（属 P2-3 已有非原子写入问题，本 PR 未新增提交逻辑）。
- **规则/说明文档与代码一致性**：核对了 ADR 0226 的前提 2、4（`create`/`confirm` 行号和“撤销后再点生效会恢复”），与代码一致；发现决定 4 的“进程中断”措辞与每进程随机签名密钥的实际行为不符，去重路径与“来源写 mcp:”不一致，错误提示与校验不一致。

### 四、必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**

对 **Himawari 自己发给模型的请求：不会**。

- `packages/prompt-catalog/src/tools.ts` 只追加了新导出，没有改动任何已有提示词文字。
- `prompt-manifest.json` 只是新增条目并调整了一个已有条目的 JSON 键位置；manifest 只在测试中读取，不参与模型请求组装（运行时 `trusted.ts` 取的是各模块导出的 segments）。
- 新增的每次会变的值（客户端名、回放数字）只出现在 MCP elicitation 的确认消息里，不进入 Himawari 的内部模型提示。
- 新规则类记忆以后只会作为“本轮选中的记忆/资料”出现在最后一条用户消息或邮件检查的数据段；不会改写系统提示、工具定义或历史。

需要注意的边界：外部 MCP 客户端自己的模型会看到工具列表多了一个 `propose_rule`，这是工具集合变化（按 `.claude/rules/prompt-prefix.md` 第 6/7 条属于一次性换新），不是 Himawari 内部请求开头的改写。`TRUSTED_PROMPT_TEXTS` 因新增提示词而增加条目，但新增的是新字符串，不会重排已有条目，也不会让旧历史变成不同字节。

结论：Himawari 的内部请求仍然只在末尾追加，每轮会变的新值没有进入系统提示或工具定义。

**2. 同一段文字会不会在不同请求里变成不同字节？**

对 **会进入模型的内容：不会**。

- 规则类记忆正文由 `externalRuleQuote(client, reason)` 加 `summary` 决定，客户端名在提议状态里固定，`reason` 会 NFC 规范化、去掉 `Cc/Cf` 并压缩空格，`summary` 校验后 trim；同一提议重试得到相同正文。
- `argsHash` 使用 `parseOwnerRuleParameters` 处理后的 `parsed.params`，列表已排序去重、键顺序由解析器固定，因此参数键序不同不会产生不同哈希。
- 决策标记的密文字节会因 nonce/`createdAt` 不同而不同，但它不进入模型输入。
- 确认框里的回放数字在不同重试时可能变化，但那是外部 MCP 内容/工具结果，不是 Himawari 的内部模型提示，也不会改写已存在的历史。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

有，主要集中在 `test/integration/mcp-write.test.ts`：

- 确认后规则生效、来源 `mcp:claude-code`、规则类记忆正文、规则表达式命中/不命中：已覆盖。
- 拒绝、取消、没勾选不写规则/载荷：已覆盖。
- 参数非法、类型未知、多出参数、只读令牌、老版本、客户端不支持 elicitation、回放不可用：已覆盖。
- 同一确认并发重发只生效一次：已覆盖。
- 撤销后删除 `rule-decision` 标记再重放：已覆盖。按代码逻辑，去掉 `storedFor` 这一步会复活规则，所以该用例会失败。
- 同时收到生效和拒绝两种顺序：已覆盖。去掉 `#declinedRules` 后，在“拒绝先到”的顺序会变成 `[DECLINED, SAVED]`，测试会失败。
- 提示词目录的 manifest 摘要/说明：`prompt-catalog.unit.test.ts` 会重算并报告 `PROMPT_MANIFEST_STALE/MISSING`。

**测试缺口**（读代码发现，未运行）：

- 没有“已有同参数规则 → 外部提议确认 → 撤销 → 删标记 → 重放”的用例，因此第 1 条去重路径未被覆盖。
- 没有“同内容提议、不同提议编号复用同一 `rule-proposal` 载荷”的用例。
- 没有“`confirm` 成功后标记写入失败”的故障注入用例，第 2 条未被覆盖。
- 没有 `memory:rule:mcp:` 的记忆来源分类用例。
- 没有 `EXTERNAL_RULE_TYPES` 与 `RULE_TYPES` 的一致性守卫；目前两边是独立硬编码，未来新增/改名规则类型可能漂移。

**4. 每个新值的两端校验都核对了吗？**

逐个核对结果：

| 值 | 产生处 | 使用/校验处 | 结论 |
|---|---|---|---|
| `mcp:<uuid>` 规则 key | `production-mcp-rule-writer.ts:70` | `#activate` 用它哈希出 `owner:<24hex>`；`#writeMemory` 用它生成 `memory:rule:mcp:<uuid>` 和 `memory-content:rule:mcp:<uuid>` | 规则编号通过 SQLite `^owner:[A-Za-z0-9_-]{1,58}$`；记忆编号长度 52、内容引用长度 60，均通过 `^[\x21-\x7e]{1,128}$` / 域名标识符规则 |
| `rule-decision:mcp:<uuid>` 载荷引用 | `production-mcp-rule-writer.ts:87` | 同一文件 `decided` 的 `get`；测试查询 `LIKE 'rule-%'` | 长度 55，`PayloadStore` 无额外模式限制，读写一致 |
| `mcp:<client>` 规则来源 | `production-mcp-rule-writer.ts:77` | SQLite `source` 长度 1–256；规则手册/决策链显示原字符串 | 客户端名最多 64，长度 68，通过；显示端原样接受 |
| `reason` 最长 200 | `production-mcp-read.ts:472-488` | `externalRuleQuote` → `create` 的 `quote` 上限 500 | 最大约 277，通过 |
| `summary` | `parseOwnerRuleParameters` | 规则存储/记忆正文 | 1–200、无换行/不可见字符，通过 |
| 提议编号 `rule-proposal:<32hex>` | `production-owner-rules.ts:647-655` | `confirm` 的 `^rule-proposal:[0-9a-f]{32}$` | 通过 |
| 去重后的规则编号 | `#activate` 返回 `same.ruleId` | `accept` 用 `active.ruleId` 写标记；`storedFor` 用 key 推导的编号查 | **两端不一致，见第 1 条** |
| `memory:rule:mcp:<uuid>` | `production-owner-rules.ts:424` | 记忆页 `memorySourceState`、来源报表 | 编号本身合法，但分类器不识别为 `external`，见第 3 条 |
| 提示词 id / manifest 项 | `tools.ts`、`prompt-manifest.json` | `prompt-catalog.unit.test.ts` 重算摘要、检查缺失/未知 | 13 个新增 id 全部已定义且被使用；摘要正确性未在本环境计算，标“未核实” |

总体：核心 P2-3 链路、MCP 鉴权、状态签名、拒绝不落盘都接对了；主要风险集中在“去重路径的防重放兜底”和“标记写失败被报成失败”这两个边缘但明确违反 ADR 承诺的地方。
