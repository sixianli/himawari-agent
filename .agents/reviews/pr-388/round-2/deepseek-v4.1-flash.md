说明：本轮已触及工具调用步数上限，以下结论基于此前实际读到的代码，不再调用工具。文末把「读代码证实」与「未核实/推测」分开。总体结论：第 2 轮改动本身未发现高严重度正确性缺陷；主要问题是有一个测试没有真正锚定 `memory:rule:mcp:` 的生产处，以及一处文档未同步、一处测试声明覆盖了实际没覆盖的列表顺序。

按严重度排序
==========

【中】测试没有核对真实生产出来的记忆编号（I-73 同类问题）
- 文件:行：`test/integration/memory-source-report.test.ts:42-51`、`apps/agent-service/src/production-mcp-rule-writer.ts:12,72`、`apps/agent-service/src/production-owner-rules.ts:424`
- 问题：`EXTERNAL_RULE_MEMORY_PREFIX = "memory:rule:mcp:"` 被定义在 rule-writer 里，但运行时真正生成记忆编号的是 `production-owner-rules.ts` 的 ``memoryId = `memory:rule:${input.key}` ``；`input.key` 来自 rule-writer 的 `` `${EXTERNAL_RULE_KEY_PREFIX}${proposal.proposalId}` ``，而 `EXTERNAL_RULE_KEY_PREFIX = "mcp:"`。测试只核对「三个字符串字面量彼此一致」，没有检查实际存下来的 `sourceMemoryId` 是否以 `memory:rule:mcp:` 开头。如果以后有人改了 `EXTERNAL_RULE_KEY_PREFIX` 或 `memory:rule:` 前缀，页面和报表会把这类记忆静默归到别的类，而现有测试仍通过。
- 证据：
  - `production-owner-rules.ts:424`：``const memoryId = `memory:rule:${input.key}` as MemoryId;``
  - `production-mcp-rule-writer.ts:11-12`：`export const EXTERNAL_RULE_KEY_PREFIX = "mcp:";` / `export const EXTERNAL_RULE_MEMORY_PREFIX = "memory:rule:mcp:";`
  - `production-mcp-rule-writer.ts:72`：``key: `${EXTERNAL_RULE_KEY_PREFIX}${proposal.proposalId}`,``
  - `memory-source-report.test.ts:49-50`：``expect(await read("apps/agent-service/src/production-mcp-rule-writer.ts")).toContain(`EXTERNAL_RULE_MEMORY_PREFIX = "${EXTERNAL_RULE_PREFIX}"`);``
  - `mcp-write.test.ts:756-760` 只读取 `row.sourceMemoryId` 的内容，没有断言其前缀。
- 建议：在 `mcp-write.test.ts` 里断言 `expect(row?.sourceMemoryId).toMatch(/^memory:rule:mcp:/u)`；或把前缀改成由 `EXTERNAL_RULE_KEY_PREFIX` 和记忆编号前缀组合出唯一常量，并让生产者直接引用该常量。

【低】ADR 0186 的分类定义没有同步新前缀
- 文件:行：`docs/adr/0186-memory-jumps-to-the-owners-original-message.md:44`
- 问题：ADR 0186 是记忆来源分类的规范定义，目前只写「按记忆编号前缀 `memory:mcp:` 判断」；本 PR 新增了 `memory:rule:mcp:` 归为 external，ADR 0226 决定 6 有写，但作为分类总定义的 0186 没更新，读者只读 0186 会漏掉规则类记忆。
- 证据：`0186:44`：「……在手动添加之后、能跳到原话之前多判断一类「外部 agent 提议、主人确认的」，按记忆编号前缀 `memory:mcp:` 判断。」
- 建议：在 0186 该句补上 `memory:rule:mcp:`，或注明另见 ADR 0226。

【低】「列表顺序不同算同一提议」这条测试实际没有改变列表顺序
- 文件:行：`test/integration/mcp-write.test.ts:930-944`
- 问题：测试只把对象的键顺序改成 `phrases` 在 `senderDomains` 前，但两个列表都只有一个元素，没有制造列表顺序差异。因此如果参数归一化以后不再对数组排序，这条测试仍会通过。ADR 0226 测试段落却声称「参数键序、列表顺序不同算同一提议」。
- 证据：`mcp-write.test.ts:937`：`params: { phrases: ["在留資格"], senderDomains: ["isa.go.jp"] },`（两个都是单元素列表）。
- 建议：用至少两个元素的列表，例如 `phrases: ["在留資格", "更新"]` 与 `["更新", "在留資格"]`，验证 `argsHash` 相同；或同时断言 `parseOwnerRuleParameters(...).params` 已排序。

【低】`MCP_PROPOSE_RULE_INVALID` 的「至少给一项条件」仍与实现不完全一致
- 文件:行：`packages/prompt-catalog/src/tools.ts:553`、`packages/application/src/rules/rule-types.ts:107-108`
- 问题：实现要求 `senderDomains`、`senderAddresses`、`phrases`、`words` 至少一项非空；只给 `excludePhrases` 会被拒绝。提示文字写的是「params 至少给一项条件」，可能让外部 agent 以为只填 `excludePhrases` 也算满足。本轮既然在改这句话，最好一并说清。
- 证据：`tools.ts` 新文字：「params 至少给一项条件，每项最多 64 字（phrases、excludePhrases 每项至少 2 字）……」；`rule-types.ts:107-108`：`if (senderDomains.length + senderAddresses.length + phrases.length + words.length === 0) invalid("至少要有一个发件域名、发件地址、词语或英文整词");`
- 建议：改成「senderDomains、senderAddresses、phrases、words 至少给一项（只有 excludePhrases 不算）」；第 2 轮新加的「phrases、excludePhrases 每项至少 2 字」与代码一致。

【低/观察】`#decidedRules` 的过期清理是惰性的，但不会无界增长
- 文件:行：`apps/agent-service/src/production-mcp-read.ts:283,524-532,540-549`、`apps/agent-service/src/bearer-admission.ts:4,32-36`
- 问题：清理只在每次 `propose_rule` 的确认路径开始时进行，没有定时器。若服务长时间不再处理规则确认，旧条目会一直留在 Map 里；但因为每次新增决定前都会先清理，且写令牌限流为每分钟 30 次、TTL 600 秒，所以稳定状态下条目数上限约为 300 条，不是无界增长。没有发现漏掉的持久化路径：标记、`storedFor`、进程内 Map 覆盖了「新规则」「复用现有规则」「标记写失败」「拒绝」四条路径；进程重启后旧 requestState 因签名密钥随机生成而失效（`production-mcp-read.ts:303-306`）。
- 证据：`bearer-admission.ts:4` `export const AUTHORIZED_PER_MINUTE = 30;`；`production-mcp-read.ts:524-526` 每次确认先清理 `until <= now`；`production-mcp-read.ts:283` Map 以 proposalId 为键。
- 建议：可加一条单元测试直接验证过期条目在下次确认时被删；不是阻塞项。

未核实/推测
==========
- `prompt-manifest.json` 中 `mcp.propose-rule-invalid` 的新 sha256（`382189...`）是否与新的 `tools.ts` 文本完全匹配：无法运行测试或计算 SHA-256，标「未核实」。第 2 轮确实同步改了这个摘要（diff 中有旧值 `796420...` → 新值 `382189...`）。
- `@modelcontextprotocol/server` 的 `createRequestStateCodec` TTL 是否固定从 mint 起算：包源码不在当前工作树（无 node_modules），无法读取。若是「每次访问刷新」的滑动 TTL，那么「复用现有规则 + 标记写失败」时，Map 的 `until` 可能早于 requestState 失效时间，撤销后理论上存在一个窗口能重新生效。按 ADR 0225/0226 的描述是固定 10 分钟，当前实现下 Map 的 `until`（接受时刻 + 600 秒）晚于或等于 state 的 mint + 600 秒，应该是安全的。此点标「未核实」。
- 新增测试是否在这台机器/CI 全部通过：未运行，未核实。`npm run check` 的 `check:steps` 列表里没有直接包含 `test/integration/mcp-write.test.ts`，它属于 integration 测试项目；是否在 CI 必跑需看 CI 配置（未核实）。

侧重检查
========
- 错误路径：确认了 `ProductionMcpRuleWriter.accept` 对非 DUPLICATE 的标记写入错误改成只 `onFailure` 并继续返回 `active.ruleId`（`production-mcp-rule-writer.ts:96-100`），`#proposeRule` 仍回 SAVED（`production-mcp-read.ts:538-544`）。`create`/`confirm` 本身的错误仍会抛到 `#proposeRule` 的 catch，返回 `MCP_PROPOSE_RULE_FAILED` 并记 `onFailure`（`production-mcp-read.ts:552-555`）。未发现「规则已生效却回失败」的新路径。
- 不合规范/不可信输入：`reason` 经 `normalizeProposalText` 去掉 Cc/Cf/Cs 和 U+2028/2029 并压缩空白（`production-mcp-memory-writer.ts:39,52-54`），所以确认框里不能用换行/双向控制符伪造段落；`summary` 由 `validRuleSummary` 禁止换行和不可见字符（`rule-types.ts:248-254`）；客户端名有 `CLIENT_NAME` 正则截断（`production-mcp-read.ts:98,255`）。参数列表最多 32 项、每项最多 64 字、`reason`/`summary` 最多 200 字（`rule-types.ts:15-16,71-86`、`production-mcp-read.ts:483-488`）。这部分未发现新问题。
- 安全：写工具只对 `WRITE_ACCESS` + modern era 注册（`production-mcp-read.ts:416-421`）；requestState 用随机密钥签名并绑定方法名和令牌种类（`production-mcp-read.ts:303-306`）；载荷库标记是加密的（`production-mcp-rule-writer.ts:85-95`）。未发现新增越权路径。
- 资源耗尽：确认框重试会重新调用 `rules.preview`（含回放），但写令牌限流 30/分钟（`bearer-admission.ts:4`），且回放本身有 `mailsPerOutcome` 上限（`owner-rule-replay.ts:42,146-148`）；`#decidedRules` 有前述上界。未发现新的无界资源增长。
- 不可撤销操作：规则生效前必须主人勾选确认（`production-mcp-read.ts:538`），生效后可在规则页撤销；标记写失败不回失败也不影响撤销。未发现新增不可撤销动作。
- 规则文件/文档一致性：ADR 0226 决定 3/4/5/6 与代码基本一致（复用现有规则、内存记录、标记、`storedFor`、记忆页/报表前缀都能对上）；差异是 ADR 0186 未同步，以及 invalid 文案对 `excludePhrases` 单独一项的表述不精确。

必答问题
========

1. 会不会改变模型已经见过的请求开头？
- 对 Himawari 自己的模型：不会（读代码证实）。新增的 `MCP_*PROPOSE_RULE*` 文案只被 `apps/agent-service/src/production-mcp-read.ts` 使用（grep 结果只有它和 prompt-catalog 定义、测试），没有进入 Pi/Himawari 的运行提示或工具定义。新增文案本身都是静态文本，没有日期、路径、额度、版本号、哈希等每轮会变的值。
- 对连接 Himawari 的外部 agent：MCP 工具列表会多出 `propose_rule`，但它是追加在 `propose_memory` 之后（`production-mcp-read.ts:87` 的 `MCP_WRITE_TOOL_NAMES = ["propose_memory", "propose_rule"]`，注册顺序 387-461 行），已有工具的文案和顺序未改；因此是「只在末尾追加」。
- 每轮会变的值：确认框里的回放数字（近 30 天检查/命中/改变数）和 `#decidedRules` 决定后的不同回复，都属于 elicitation 消息或工具结果，出现在请求末尾，不在系统提示/工具定义/历史前缀里。结论：仍然只在末尾追加，每轮会变的值不在开头。

2. 同一段文字会不会在不同请求里变成不同字节？
- 新参数的哈希用 `parseOwnerRuleParameters` 归一化后的 `parsed.params`，列表会去重并排序、对象键顺序固定（`rule-types.ts:71-115,257-273`），所以键序和列表顺序不同的同一组条件得到相同 `argsHash`（`production-mcp-read.ts:489-491`）。
- 没有发现新的依赖前后文的遮盖：`maskForExternalRead` 未改（`production-mcp-read.ts:220-229`）。新提示词是固定文本；manifest 里的 sha256 只用于检查，不是发给模型的字节。确认框里确有随时间变化的回放数字，但它在末尾消息里，不是「同一段前缀文字变字节」。
- 结论：未发现同一段模型前缀文字会因上下文变成不同字节的新路径。

3. 有没有对应的自动检查？反向用例真的会失败吗？
- 有：`test/integration/mcp-write.test.ts` 覆盖确认生效、拒绝/取消、非法参数（含 1 字 `phrases`）、并发只生效一次、撤销后重放、同参数复用、标记写失败仍回已生效、键序不同；`apps/control-center/test/memory-source.unit.test.ts` 覆盖 `memory:rule:mcp:` 归 external 且 `memory:rule:owner-chat` 不归 external；`test/integration/memory-source-report.test.ts` 覆盖报表 SQL 的前缀。
- 反向用例的正确性：
  - 标记写失败测试：如果 `production-mcp-rule-writer.ts` 改回对非 DUPLICATE 抛错，`accept` 会失败，回复变成 FAILED，`mcp-write.test.ts:888-903` 会失败，ADR 的说法成立。
  - 复用规则测试：如果去掉 `#decidedRules` 的内存生效记录，撤销后删掉标记，重放会走 `#activate` 新建规则，`mcp-write.test.ts:905-928` 会失败（`storedFor("mcp:<第二个提议编号>")` 找不到复用规则）。
  - 生效+拒绝并发测试：如果去掉拒绝的内存记录，「先拒绝后生效」会变成 kept，结果里会出现 DECLINED+SAVED，`mcp-write.test.ts:863-886` 会失败。
  - 但「列表顺序不同」这条没有真正构造列表顺序差异（见上），所以它不能证明列表排序未被破坏。`memory:rule:mcp:` 的报表/页面测试也没有断言真实写入的 `sourceMemoryId` 前缀（见上）。
- 这些测试是 integration/unit 项目；`npm run check` 的步骤清单未直接包含 `test/integration/mcp-write.test.ts`（我读到的 `package.json` `check:steps` 没有它），是否在 CI 必跑未核实。

4. 每个产生/修改的值，使用方都能接受吗？
- `memory:rule:mcp:<uuid>`：产生于 `production-owner-rules.ts:424`（`memory:rule:` + `mcp:` key）；消费方是 `apps/control-center/src/memory-source.ts:25-29`、`scripts/operations/memory-source-report.mjs:24`、以及规则存储的 `sourceMemoryId` 校验。格式/长度：`sqlite-owner-rule-operations.ts:9` 的 `MEMORY_ID = /^[\x21-\x7e]{1,128}$/` 接受它（`memory:rule:mcp:` 17 字符 + UUID 36 字符 = 53）；`gateway-contracts` 的 `machineString` 长度 ≤128、允许 `:`/`-`（`validation.ts:49-59`），也接受。当前两端确实匹配；问题是测试没锁住生产者。
- `source: mcp:<client>`：产生于 `production-mcp-rule-writer.ts:79`，在 `production-owner-rules.ts:531` 截到 256 后写给规则存储；`sqlite-owner-rule-operations.ts:123` 要求 1-256 字符串，而客户端名最多 64 字符（`production-mcp-read.ts:98`），因此总长约 68，能通过。
- `rule-decision:mcp:<uuid>`：由 `production-mcp-rule-writer.ts:89` 产生，消费者是 `decided()` 的 `payloads.get`（同文件 64 行）和测试里的 `LIKE`；格式与已有载荷引用一致，未发现长度/字符校验拒绝。
- `onFailure` 新必填项：仓库内只有两处构造 `ProductionMcpRuleWriter`，`service-main.ts:1819-1824` 和 `mcp-write.test.ts:288` 都传了，类型上能通过。
- 新增 prompt id 和 manifest 项：id 与 `tools.ts` 导出一致，manifest 在第 2 轮把 `mcp.propose-rule-invalid` 摘要从 `796420...` 改成 `382189...`；摘要是否精确匹配未核实（无法运行 sha256/测试），但检查脚本会做这件事。
- 新日志事件 `mcp-rule.marker-failed`：只用于诊断输出，没有下游格式校验。
