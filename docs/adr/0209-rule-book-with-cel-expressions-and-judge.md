---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-10"
covers: ".agents/instructions/prompt-prefix.md, packages/application/src/services/proactive-rules.ts, packages/application/test/rule-expression.unit.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0209：规则手册用 CEL 表达式，由一个裁判计算（部分取代 ADR 0163 的决定 4）

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [CEL 库的核实结果](#cel-check)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

愿景 v2.3 要求规则是“硬性设定”：写进程序、必定执行。[ADR 0163](0163-owner-preferences-as-data-run-by-tested-rule-types.md) 把主人的具体偏好定为数据，由测过的程序执行。2026-11-10 的方案讨论把它落成具体结构：每个实例一本规则手册，每条硬规则是手册里的一行数据，由一个裁判计算，再由两道闸门调用。方案全文是协调者交给 Andy 的“硬规则接入 Himawari 的架构方案（整合版）”，最终版方案已由 Andy 在 2026-11-10 22:21 JST 回复“文档里面要我定的那些，按照你的建议来”，并说明一律以最终版为准。

本 ADR 记录第 1 步落地的决定：CEL 表达式语言、规则手册、字段目录、裁判，以及把现有静默时段、重要发件人和钱相关词迁进来。第 1 步不改变任何现有行为。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 规则是硬性设定：`docs/product-vision.md` 第 59 行，“规则本身写进程序、必定执行，每条都有回归测试守着”。
2. 每人一个实例，各自一个主人，主人可能不会写代码：[0083-isolated-instance-per-person-with-owner-entry.md](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0083-isolated-instance-per-person-with-owner-entry.md) 第 50 行，“每个人一套独立的 stateRoot、数据库文件……每个实例内部仍然只有一个主人”。（ADR 0083 已被 ADR 0234 取代，改为一个程序、每人一个数据库文件；“每人各自一个主人、主人可能不会写代码”这一点不变）
3. ADR 0163 决定 4 的原文：“一句话要经过确认卡，Andy 确认后才变成长期规则。”
4. 现有的邮件检查在 `packages/application/src/services/proactive-rules.ts`（迁移前）里写死了三条“地板规则”（重要发件人、公共机构域名后缀、钱相关词）和静默时段计算；三条地板规则的 id（`floor_important_sender`、`floor_public_domain`、`floor_money_words`）已写进决策记录，所以保持不变。
5. CEL 的安全性：cel-spec 说明 CEL “evaluates in linear time, is mutation free, and not Turing-complete”；cel.dev 说明 “CEL was designed specifically to be safe for executing user code”。
6. 用户在界面看到的是试算例子，不是代码；模型只翻译，不写可执行代码（方案最终版“放弃了什么”）。
7. 发给模型的内容只能往后追加：`.agents/instructions/prompt-prefix.md`。本步没有给模型的请求加任何东西。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **规则表达式用 CEL（Common Expression Language，Google 的受限表达式语言），实现用 npm 包 `@marcbachmann/cel-js` 8.0.0（MIT 许可，没有依赖）。**只允许一个白名单：字面量（整数、文字、真假）、字段、`&& || ! ?:`、比较、`in`、`+` `-`、列表字面量，以及 `size`、`exists`、`all`、`startsWith`、`endsWith`、`contains`。其余一律拒绝，包括 `matches`（这个库用的是 JavaScript 的正则，没有 CEL 规定的线性时间保证）、`int()` 之类的类型转换、`has`、字段访问、下标、字典、`* / %`。每道闸门的表达式只能读那道闸门字段目录里的字段，类型检查必须通过，结果必须是真或假，长度和节点数有上限。
2. **规则手册**是每个实例（主人加 Agent）的一组规则，每条有固定 id、修订号、表达式、结果、出处、状态。内置规则（公共机构域名后缀、钱相关词）写在代码里的数据文件中，随版本发布，每条自带“该命中 / 不该命中”的例子；主人设置派生的规则（重要发件人、静默时段）存在数据库的 `rule_book_rules`，每次修改修订号加 1，旧版本写进只追加的 `rule_book_history`。这两条的表达式不存库，由程序按存下来的参数生成，所以参数是唯一来源。以后加自由表达式的规则时，再给表加表达式列。
3. **字段目录**按闸门固定：`mail_item`（发件地址、发件域名、邮件文字、邮件文字里的英文单词）和 `mail_delivery`（当地分钟数、当天和前一天是星期几）。字段由程序提供，事实由代码算；只有新增字段才需要写代码。
4. **裁判**（`RuleJudge`）输入闸门、字段和规则，输出所有命中的规则（id、修订号、结果）。表达式在缓存里编译一次。字段缺失或类型不对时直接报错，不当作“没命中”悄悄放过；每条规则写明缺失时怎么算，要等第 2 步引入金额字段时才需要，到那时再加。
5. **迁入现有设置，不改行为。**迁移 0086 创建规则手册表，把每个实例的静默时段和重要发件人复制成第 1 版规则并写入历史，然后从 `proactive_settings` 里删掉这两列，该表只剩“检查开关”和更新时间，之后规则手册是唯一来源。钱相关词的英文部分原来是带 `\b` 的不区分大小写正则，现在由程序把邮件文字切成英文单词列表，规则表达式用 `in` 判断，结果逐字相同；中日文词条用 `contains`。
6. **取代 ADR 0163 的决定 4。**新的决定：主人明确说“以后 / 一律……”的，规则直接生效，同时给一张回执卡，上面有试算例子和一键撤销；模型从对话里推断出来的，只作为提议，主人点头才生效；只说一次的话不变成规则。理由：普通用户看不懂表达式，试算例子才是他们能判断的东西，对明说的话再要求点一次确认是多余的一步，也符合“尽量不要让主人人工介入”。这一条的界面和流程在第 4 步实现，本步只记下决定。ADR 0163 的决定 1、2、3 不变。
7. **门槛：**`npm run check:rule-registry`（属于 `npm run check` 的一步）运行三组测试：每条规则都有出处、表达式通过类型检查、例子通过，并且例子被改错或表达式被换掉时必须报错；白名单拒绝清单；新旧实现对照（2 万封随机邮件的地板规则命中和顺序，以及三个时区、跨夏令时、每 29 分钟一个时刻的静默时段判断和结束时间，都必须与迁移前的实现一致，改掉规则里一个词，对照测试就失败）。

[返回阅读导航](#contents)

<a id="cel-check"></a>

## CEL 库的核实结果

方案要求第 1 步先核实库的质量。做法：用 CEL 官方一致性用例（`google/cel-spec` 的 `tests/simple/testdata`，basic、comparisons、logic、integer_math、string、macros、fields、lists、conversions、parse、plumbing 共 11 个文件）逐条在库的默认环境里跑，只算不涉及 protobuf 消息类型的用例。

- 库状态：2025-06 首发，90 多个版本，最新 8.0.0 发布于 2026-07-07，单一维护者，没有依赖，自带解析、类型检查和结构上限。它自己的说明只写“Most of the CEL Spec”，不自称完全符合，包里不带一致性测试。
- 结果：主体通过（运算、逻辑、字符串函数、`in`、宏、字符串比较、短路求值）。有偏差的地方：不同数字类型之间的相等和排序（例如 `1.0 == 1` 在类型检查时被拒绝、`dyn(3u) in [3]` 为假）、64 位整数边界不报溢出（`-(-9223372036854775808)`）、`int()` 对超范围的小数不报错、字节串排序、反引号字段名、保留字当方法名。逐条对照后，这些都落在白名单之外：我们不开放类型转换、乘除模、字节串、字段访问和 `matches`，整数字段都是小的整数，所以这些偏差够不到。
- 因此判定：在白名单内可用。白名单的拒绝清单和白名单内的行为都有自己的测试（`packages/application/test/rule-expression.unit.test.ts`）。换库时，这些测试和对照测试是验收依据。
- 已知备选：Buf 的 `@bufbuild/cel` 0.6.2 带官方一致性数据，但仍是 0.x，要带 protobuf 和 re2 的 WebAssembly（约 11 MB），本步未选。如果以后要开放 `matches` 或数字转换，应改用它，或在应用层自己写。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- Kubernetes 的准入策略用 CEL（“Validating admission policies use the Common Expression Language (CEL)”），Google Cloud IAM 的条件也用 CEL（cel.dev：“IAM offers CEL expressions”）。
- AWS AgentCore 让管理员用自然语言说明智能体能调用哪些工具，由模型翻译成 Cedar 策略，再按模式校验，执行放在智能体和工具之外（“an auditable, deterministic enforcement layer that sits outside the agent and tools”）。本方案同样让模型只翻译，程序校验和执行。
- Claude Code 的钩子文档：要强制硬性的允许或拒绝，用权限系统，不用钩子。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- 让模型写代码当规则：测试和代码出自同一个模型，会带着同一个误解；用户看不懂代码，确认等于没确认。
- 自己写表达式解析器：等于自己发明一门语言，解析、类型检查和防止算不完都要自己做。
- Cedar、OPA、json-rules-engine：Cedar 没有计数和延后这类通知需要的表达，OPA 的 Rego 对模型和普通用户更难写对且在 Node 里要编译成 WebAssembly，json-rules-engine 灵活度差不多还带 4 个依赖。
- 给钱相关词做成 `matches` 正则：这个库的 `matches` 是 JavaScript 正则，可能回溯过度，所以拒绝。
- 第 1 步就把静默时段改成纯表达式计算结束时间：现在“是不是静默”由表达式判断，“静默到几点”仍用原来的计算，两者由对照测试保证一致；第 2 步把两份静默时段的实现合成一份。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 新增一个依赖（`@marcbachmann/cel-js`，精确版本 8.0.0）。
- 迁移 0086：新增 `rule_book_rules`、`rule_book_history`（历史只追加，随 Agent 或主人一起删除时才能删），`proactive_settings` 删掉 `quiet_hours` 和 `important_senders` 两列。`ProactiveSettings` 多了两个修订号，未保存过时是 0，读到的是默认静默时段 23:00–07:00 和空的重要发件人。
- 后续步骤要改的：第 2 步通知闸门和金额字段（那时加“字段缺失怎么算”），第 3 步动作闸门，第 4 步一句话变规则和回执卡、规则页、撤销，第 5 步导出。`proactive_settings` 不在数据导出里，所以第 5 步需要把规则手册一并导出。
- 决策记录里写的仍是地板规则的 id；把规则 id 和修订号写进决策记录要先扩字段，留到第 2 步。
- 迁移 0086 删掉 `proactive_settings` 的两列，不可逆：回退程序时必须同时从迁移前的快照恢复数据库，不能只换程序（迁移引擎要求有快照才执行，回退脚本沿用这一条）。
- 唯一和旧实现不同的地方：旧数据里含孤立代理项（不合法的 Unicode 字符）的重要发件人，读设置时会被丢弃。规则语言解析不了这种字符（实测 cel-js 报 Invalid Unicode surrogate），旧实现里它只能匹配同样带孤立代理项的发件人，实际等于不生效；新的保存路径（网关和存储）都拒绝这类值。
- 第 4 步让模型把一句话译成表达式之前，要先补求值次数上限或禁止嵌套的 `exists`、`all`：第 1 步的表达式都由代码生成、嵌套很浅，现在不会出问题，但 `text_words.all(a, text_words.all(b, ...))` 的求值次数会随嵌套层数成幂增长。
- 发给模型的内容、系统提示和工具定义都没有变，`npm run check:prompt-prefix` 不受影响。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0163](0163-owner-preferences-as-data-run-by-tested-rule-types.md)：本 ADR 取代其中的决定 4，决定 1、2、3 继续有效。
- [ADR 0134](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0134-adopt-product-vision-v2-2.md)、[ADR 0153](0153-adopt-product-vision-v2-3.md)：规则是硬性设定。
- [ADR 0083](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0083-isolated-instance-per-person-with-owner-entry.md)：每人一个实例（已被 [ADR 0234](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0234-one-program-per-person-database-file.md) 取代，改为一个程序、每人一个数据库文件；每人各自一个主人这一点不变）。
- [ADR 0204](0204-handle-pi-deviations-d2-d3-d5.md)：“先问我”接现有审批，第 3 步用。
- [.agents/instructions/prompt-prefix.md](../../.agents/instructions/prompt-prefix.md)：发给模型的内容只追加。
- [ADR 0233](0233-rule-book-joins-the-data-export.md)：规则手册进入数据导出（后续）。

[返回阅读导航](#contents)
