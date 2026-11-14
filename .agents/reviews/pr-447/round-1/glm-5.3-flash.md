# 复核结论：PR 447（ADR 0242 补注）

这次改动只动了 `docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md` 一个文件（+25/-1），全是带日期的补注和一节汇总，原文不动。作者列的 7 条说法我逐条对了代码，**全部属实**；发现的问题集中在少数几处文档缺口，没有发现与代码或别的 ADR 的实质矛盾。

## 问题清单（按严重度从高到低）

**1. 低 · docs/adr/0242:58 · 前提 12 没有跟着补注，编码线程只读前提会被误导**
- 证据（读到）：0242 第 58 行仍是「**外部 agent 能提的规则只有两种邮件规则；转述的偏好按记忆提。**」，而本次补注只在决定 7（第 126 行一带）写了登记表的新口径。仓库惯例是在被取代的前提里加「后续：」（如 0225 第 120 行、0226 第 61 行都这么做了）。
- 建议：前提 12 句尾加「（2026-11-12 补：能提的种类以规则类型登记表为准，见决定 7 的补注）」，与 0226:61 的写法对齐。

**2. 低 · docs/adr/0242:126（决定 6 补注）/ 248 · 「不另抄一份」缺一道反向检查**
- 证据（读到）：现在的重复清单是字面复制，`production-mcp-memory-writer.ts:46-56` `EXTERNAL_PROPOSAL_CATEGORIES` 带 `as const satisfies readonly MemoryCategory[]`——`satisfies` 只要求是子集，将来哪怕有人把 `rule` 加进这份复制，类型系统也不报错。新增的测试条目（0242:248）只有「清单里没有的值按『其他』收」，没有「对外清单必须恰好等于 `MEMORY_CATEGORIES` 去掉 `rule`、多出或少了任何一个都失败」的反向用例。
- 建议：在 248 行补一句反向用例，或者提示任务 C 用类型级推导（`Exclude<MemoryCategory, "rule">`）而不是再抄一份。

**3. 低 · docs/adr/0242:177（决定 4 补注）/ 248 · 「过不了自动检查」所指的检查现在并不存在**
- 证据（读到）：补注说「以后加读工具，不接读取上限就过不了自动检查」。当前代码里四个读工具各自手工接 `ceiling`（`production-mcp-read.ts:1240、1187、1210` 一类），没有任何「登记读工具 + 校验是否接上限」的机制；248 行新测试条目「登记一个没接读取上限的读工具，检查失败」同样是计划项。
- 严重度只定低，是因为 0242 的「测试」一节本来就是目标行为清单（0225、0226 同例），补注放进同一节符合惯例；但要意识到这条检查本身是任务 B/C 的新工件，不是现成的。
- 建议：不必改文字；编码线程开工时把「读工具登记表 + 上限检查」当成要新建的东西，不要去找一个不存在的现成检查。

未发现其他问题：补注与 0213、0225、0226、0228、0246 的既有条文方向一致（0226:61 已经记了「确认改到 Himawari 里做，能提的规则种类和 P2-3 流程不变」，0246 的导出校验不受「按其他收」影响）；新增锚点 `#general-not-per-scenario` 与文内链接一致；`#consequences` 锚点存在（0242:228）。

## 侧重检查（测试覆盖、文档-代码一致性、一条普通流程）

走的流程：外部 agent 连 MCP → `start_here` 读规则摘要 → `rule_book` 看参数 → `propose_memory`/`propose_rule` 提议 → 待确认 → Himawari 确认。
- 读路径有集成测试：`test/integration/mcp-read.test.ts:862-994` 覆盖 `start_here`（:878 断言 `rules.items` 只有一句摘要，正好守住补注决定 4 说的现状）；:674-713 覆盖 `rule_book`（:711 断言 `quiet_hours` 带 `quietHours` 参数，对应补注点名要改的 `ruleParameters` 现状）。`apps/agent-service/test/production-mcp-read.unit.test.ts` 只测遮盖，工具行为全靠集成测试。
- 写路径 `production-mcp-write.test.ts` 的具体用例我没有逐条打开（未核实），其覆盖范围由 ADR 0225/0226 的测试节描述。
- 文档引用的每个代码标识符我都读到了原文（见必答问题 4），行号、内容与补注一致。
- 「外部 agent 能提的规则以登记表为准」这条放宽的权限边界核实过两端：产生端登记表 `rule-types.ts:202-213` 现在恰是那两种；使用端即使去掉 `EXTERNAL_RULE_TYPES`，写入器 `production-owner-rules.ts:460` 仍走 `writableRuleType`（`rule-types.ts:224-232`，无 `tests` 就抛 `RULE_TYPE_UNTESTED`），所以「只能是带测试的规则类型」在代码里本来就有闸，补注没有放宽不该放宽的东西。

## 必答问题逐条回答

1. **会不会改变模型已见过的请求开头？** 不会。改动只有一份 ADR markdown，不触任何代码；0242 后果节（:233）自己也写明「Himawari 自己发给模型的请求不变……外部 agent 那边，工具清单会变一次」，且那是任务 C 之后的事。发给模型的内容仍然只追加、每轮变的值都在最后一条消息——本次无任何相关改动，无需动 [prompt-prefix 规则](../../.claude/rules/prompt-prefix.md#rules) 的例外。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会，纯文档改动，不产生任何序列化值。补注反而提醒了一个字节问题：「这次不做的」里保留项目笔记不进 Himawari 聊天检索的理由（会让每个老对话的请求开头换新），补注没有推翻它。
3. **有没有对应的自动检查、反向用例会不会真失败？** 本次无可执行改动，没有也不需要新的自动检查；现有检查（`npm run check` 全套）不受影响。文中新增的测试条目（0242:248）全部是任务 B/C 的计划项，今天不存在，反向用例无从运行——问题 3 里说的「读工具上限检查」即是（见问题清单第 3 条）。现状部分（start_here 只给摘要、rule_book 参数写死）有真实测试守着（mcp-read.test.ts:878、:711）。
4. **每个产生/使用的值两端都能接受吗？** 逐个核过，一致：`EXTERNAL_RULE_TYPES`（rule-writer.ts:16，read.ts:613/671 使用）；`RULE_TYPES` 恰两种（rule-types.ts:202-213）；`ruleParameters` 的两个写死 id（read.ts:324-328）；`#startHere` 只取 `enforcedOwnerRule(row)?.summary`（read.ts:1263）；`MEMORY_CATEGORIES` 含 `rule`、`EXTERNAL_PROPOSAL_CATEGORIES` 缺 `rule`（memory-projection.ts:13-24、memory-writer.ts:46-56）；`INVISIBLE_FORMATTING` 存在；ADR 0213:32 原话逐字一致；`product-vision.md:101` 原话一致（「规则是硬性设定：带出处、带回归测试」为原文片段引用，忠实）；PR 413 已合并（`3af9f207`，另有 `e98a036e` 记录读的一侧由它合并）——PR 归属与提交 `6e5d5ffa` 的对应关系是间接证实，标推测。两端校验最要紧的一条（登记表→propose_rule→写入器）已核：写入端 `writableRuleType` 的带测试闸门在，去掉硬编码清单不会放行无测试类型（见侧重检查）。I-73 的教训（清单 id 能不能过后端校验）在这条补注上是过关的。

## 作者 7 条说法的核对结果

1. ✓ 属实（rule-writer.ts:16；read.ts:613 生成枚举、:671 再校验）。2. ✓ 属实（rule-types.ts:202-213 恰这两种）。3. ✓ 属实（read.ts:324-328）。4. ✓ 属实（read.ts:1263）。5. ✓ 属实（projection.ts:13-24 十项含 `rule`；writer.ts:46-56 九项无 `rule`，确是另抄的一份）。6. ✓ 属实（0213:32 原话逐字一致）。7. ✓ 基本属实：`start_here` 已用 `sources.profile?.(ceiling)`（read.ts:1241），该功能由提交 `6e5d5ffa` 引入，PR 413 归属为间接证实（推测成分仅在此一处）。
