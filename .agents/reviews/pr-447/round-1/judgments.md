# PR 447 第 1 轮判断

被复核的提交：`9c19385d`（ADR 0242 的“通用，不按场景写死”补注）。两个模型都跑了，这一轮 0.11 美元。两个模型都把线程写的 7 条关于代码现状的说法逐条对了代码，都属实。问题出在设计上：补注只看了产生这些值的地方，没有把用到它们的地方走一遍。DeepSeek 引的代码线程都打开核对过，属实。修改都在后面的提交里，下一轮复核。

## 成立，会出错，中、高（改了，等下一轮复核）

- r1ds1（DeepSeek：高）和 r1ds9（DeepSeek：推测）“外部能提的规则以登记表为准”。核对：`packages/application/src/rules/rule-types.ts` 的 `RuleTypeDefinition.parse` 返回 `MailMatchParameters`；`apps/agent-service/src/production-mcp-read.ts` 的参数格式写死五个邮件字段，确认内容用 `preview.type === "mail_must_notify" ? … : …` 二选一。只把清单换成登记表，新类型在确认时会显示成另一种邮件规则。成立。改成：每种规则类型自己声明是否“外部可提”，并带对外参数说明、做法说明、确认内容的写法；`propose_rule` 的类型、参数说明、确认内容都从声明生成；这些做完之前保留现在的清单，不得只换清单。GLM 认为这条没有放宽不该放宽的（写入器的 `writableRuleType` 会挡没有测试的类型），这一点属实，但它没看确认内容写死的问题，线程采纳 DeepSeek 的判断。
- r1ds2（DeepSeek：高）清单外的类别按“其他”收。核对：`production-mcp-memory-writer.ts` 的 `proposalClassification` 对健康、财务类别直接判敏感，否则只扫正文里的标识；类别清单另有 `data-export/schemas.ts` 和迁移 0093 的 CHECK 两处。成立。改成：不给按“其他”；给了清单外的值，这一条不合格并列出能给的值；加一条检查守住三处清单和 `MEMORY_CATEGORIES` 去掉 `rule` 一致。这样和 ADR 0228 决定 3“分类不在九种里”被挡下的做法方向一致，不用改 ADR 0228。
- r1ds3（DeepSeek：中）“项目不限代码仓库”和“带凭据一律拒绝”矛盾。成立。改成：只有长得像远程地址的名字（`协议://` 开头，或 `用户@主机:路径` 且整段没有空白）才查凭据；别的名字里的 `?`、`#`、`@`、`:` 是普通字符。用例补上带这些字符的名字照常收、带凭据的地址被拒。

## 成立，会出错，低（改了）

- r1ds4（DeepSeek：中，线程判低）`ruleParameters` 管的是内置规则手册，不是外部规则类型登记表。核对：`packages/application/src/rules/rule-book.ts` 的 `RuleRecord` 没有对外参数的字段，`ruleBookFor` 产出内置规则。成立，补注改成点明两套东西，由任务 B 给内置规则手册的条目加声明。
- r1ds5（DeepSeek：中，线程判低）和 r1glm3 新加的用例要用到的机制现在没有。成立，补注写明这些要先建，用例逐条写清。
- r1ds7 “加一种就能提”没说要带测试，和 ADR 0226 第 61 行的“种类不变”说法不一。成立，补注写明；ADR 0226 第 61 行下面加一条再补。
- r1ds8（DeepSeek：推测，线程判低）外部 agent 反复提规则会一直触发回放。核对：`production-mcp-read.ts` 调 `rules.preview`，`production-owner-rules.ts` 的 `preview` 里调 `#replay`；ADR 0213 决定 6 是近 30 天、每种结论最多 300 封。这是现有行为。补注加上规则提议按接入单独限频率、用量在页面上看得见。回放放到什么时候算，留给任务 C 定。
- r1glm1 前提 12 没有指向补注。成立，句尾加一句带日期的指引。
- r1glm2 抄的类别清单没有反向检查。并进 r1ds2 的那条检查。

## 成立，可以更好（改了）

- r1ds6 前提 16 的那句是直接接在原文后面的，没带日期。改成带日期的括注，原文不动。

## 模型在必答问题里另提的

- DeepSeek：`propose_rule` 的类型从登记表生成后，登记表一变，对外 MCP 的工具定义跟着变一次，是外部 agent 那边的请求开头变。补注里写明了。
- 两个模型都确认：这个 PR 不改 Himawari 自己发给模型的请求。

## 模型标“未核实”的

- GLM：`production-mcp-write.test.ts` 的用例没有逐条打开；PR 413 和提交的对应是间接证实。线程在 PR 411 时对着 main 核对过 `start_here` 用了 `sources.profile`。
