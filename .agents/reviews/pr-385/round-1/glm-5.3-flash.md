# 复核报告：PR 385（ADR 0229/0230、详细设计、实施计划、指令改写）

## 侧重检查

本 PR 只有文档和指令文件。我走的流程（从入口到结束）：

1. **指令改写流程**（本 PR 唯一实际改变行为的路径）：合并后，代理读 `AGENTS.md:117`「服务器端的构建、检查和测试绝不在 MacBook 上运行；iPhone、Apple Watch、Mac 客户端的构建、单元测试和安装在 Andy 的 Mac 上用 Xcode 做」→ `.agents/instructions/test-and-production-hosts.md:8-9`（改写后的硬边界+例外）→ `.agents/instructions/delivery-mode.md:31`（快速模式下仍有效的规则里同步改写）。三个文件互相一致；`.claude/rules/` 里没有与之矛盾的绝对禁止（owner-global-instructions.md、owner-standing-rules.md 均未涉及客户端构建）。有测试覆盖的部分：链接类检查（check:instruction-links、adr-numbers、docs-links、markdown-tables）存在（package.json:27,31,34,35,75,101,102 证实）；**没有任何自动检查能发现「文档对代码的陈述是否属实」**——下面第 1、2 条问题都是从这类缺口漏掉的（推测，依据 document-governance.md:28 所述校验范围）。
2. **文档对代码的引用逐条核对**：两份 ADR 和详细设计里带行号的代码引用共约 20 处，我读了 16 处，15 处与代码一致（http-gateway-server.ts:261/194/1115/428/463/497、thread-prompt-bundle-service.ts:89、contracts.ts:97/:68、approval-service.ts:41/:58/:73、production-memory-capture.ts:978、proactive-checks.ts:4、sqlite-proactive-operations.ts:29、0062/0069/0087/0088/0089 五份迁移的 `CHECK (source IN ('gmail'))`、schemas.ts:199/:253、sqlite-governed-deletion.ts:38/:762-764、sqlite-memory-operations.ts:868、action-policy-service.ts:37-50/:503、thresholds.ts:56、reference-adapters.ts:170、0058_web_push.sql:26、0061_web_push_feedback.sql:9）。1 处行号错误（第 2 条）。
3. **文档间一致性**：ADR↔设计↔计划交叉核对，发现 1 处数字矛盾（第 1 条）、1 处「一把密钥 vs 两把密钥」（第 3 条）。
4. 未核实：作者声称的各 check 实际通过（我不能运行命令）；`validate_docs.py` 不在仓库里（外部技能），其「没有新增错误」无法核实；`.agents/reviews/topic-ios-capabilities/` 在提交里存在（diff stat 显示 9 个文件），但本复核环境对该路径返回 `REVIEW_GIT_REFUSED records-path`，内容未读。

## 发现的问题（按严重度）

**1. 高 · docs/execution/plans/2026-11-11-apple-device-body-plan.md:48 · 计划与详细设计对真机测试数量矛盾（19 项 vs 25 项）**
证据：设计 docs/execution/specs/2026-11-11-apple-device-body-design.md:819「自动检查覆盖不了的 19 项……（iPhone 13 项、手表 2 项、Mac 4 项）」、:829 同样写「19 项真机测试」；计划 :48 第 2 批写「同时做连接方式实测和 **25** 项真机测试」。25 恰好是设计「还没核实的事」表的条目数（编号 1-18、25、19-24，共 25 行，且编号乱序），疑为把两份清单混为一谈。作者声称「三者之间不应矛盾」，此说法与代码不符。建议：改回 19 项，并把「还没核实的事」的行号重排为 1-25。

**2. 中 · docs/adr/0229-native-apple-clients-and-device-api.md:78 · 前提 17 引用的句子被本 PR 自己改掉了**
证据：前提 17 引「`.agents/instructions/test-and-production-hosts.md` 第 8 行原话：『绝不在用户的 MacBook 上运行 Himawari 测试：不做构建，不跑……』」；同一 PR 已把该文件第 8 行改为「绝不在用户的 MacBook 上运行 Himawari **服务器端的**测试：不做 Node 这一侧的构建……」（test-and-production-hosts.md:8）。合并后该引句在仓库里不复存在，「引用与 main 上的代码一致」的约束被本 PR 自己打破。建议：前提 17 改为引用改写后的原文，或注明引用的是改写前的状态并指向 ADR 0229 决定第 8 条。

**3. 中 · docs/adr/0229-native-apple-clients-and-device-api.md:97 vs 设计 :169-171 · 「一把 P-256 密钥」与「两把 P-256 密钥」矛盾**
证据：ADR 0229 决定第 4 条「每台设备配对时在自己的安全芯片里生成**一把** P-256 密钥，服务器只存公钥」；设计「设备身份和配对」第 3 步「在安全芯片里生成**两把** P-256 密钥：设备密钥……确认密钥（给高风险审批用）」。设计更细，但按作者自己定的约束属文档间矛盾；且「服务器只存公钥」在两把密钥的方案下意味着存两个公钥。建议：把 ADR 第 4 条改为「一到两把（签名密钥和确认密钥）」或与设计统一。

**4. 中 · docs/execution/specs/2026-11-11-apple-device-body-design.md:77 · 前提 S6 行号错误**
证据：S6 写「`packages/platform-node/src/strict-configuration.ts:1043` `optional("dailyCostMicros", 1_000_000, 1, 100_000_000)`」；实际该语句在 **:1067**（:1043 是 `relatedCharactersPerMail` 一行，我读过）。内容一致、行号不对——作者声称「逐条对照代码核对」，此条与之不符。这行还支撑「第一行上限 1 美元和现有默认值相同」的论证，行号错了不改变结论，但违反文档准确性约束。建议：改成 :1067。

**5. 低 · docs/adr/0229-native-apple-clients-and-device-api.md:167 vs docs/runbooks · 「两份操作手册里『Mac 只用来编辑、审查、提交』的句子」只有一份含有该确切句子**
证据：grep `docs/runbooks/`，该原话只在 test-host-operations-runbook.md:57；另一份 agent-tooling-runbook.md:56/94/120 用的是「不在 MacBook 上跑测试」的措辞。计划收尾清单（plan:109）同样写「两份 Runbook 里『Mac 只用来编辑、审查、提交』的句子」。语义上两份都受影响，但引句不准确。建议：改成「两份操作手册里的 MacBook 测试限制句」。

**6. 低 · docs/adr/0229-native-apple-clients-and-device-api.md:109 vs 设计 :275 · 实测方式「三种」vs「四种」**
证据：ADR 决定第 5 条「实测三种方式：HTTP/3、单条 WebSocket（对照）、手机直连生产机的 QUIC」；设计「多测现有网页作为基线，共四种」。可解释为设计加了基线，但按「不应矛盾」的约束最好在 ADR 里注明。推测为有意补充而非矛盾。

**7. 信息 · .agents/instructions/test-and-production-hosts.md:9 · 例外指向尚不存在的目录**
证据：例外范围写「`clients/apple/` 下的 iPhone、Apple Watch、Mac App」，该目录在本提交不存在（将来第 2 批才有，plan:48）。检查脚本不会拦（`check:instruction-links` 只查 Markdown 链接，反引号路径不查）。合并后到落地前，这条例外授权的范围是空的，无实害；仅提示。

**8. 信息 · 本 PR 新文档承诺的未来值两端校验**
证实：设计「新值清单」（:684-725）每条都写了产生处/使用处/两端校验/自动检查，符合 I-73 的教训；其中引用的现有机制我都核实存在：门槛表（thresholds.ts:56 `THRESHOLD_GATES`）、`DECISION_KINDS`/`DECISION_OUTCOMES`（sqlite-decision-ledger-operations.ts:4-5）、`check-prompt-prefix.mjs` 的 `REQUIRED = 8`（:10）、`check-data-export.mjs` 的 `REQUIRED = 53`（:15）、`check:egress-redaction` 的 `REQUIRED_REDACTION_CALLS`（:8）。设计还明确要求新增用例时同步改 `REQUIRED`（:766、:791），这正是防止「加了用例但没进门槛」的正确做法。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本 PR 不含任何代码：AGENTS.md、`.agents/instructions/` 只约束代理行为，不是发给 Himawari 对话模型的内容；文档和复核记录也不进模型请求（读代码证实：diff 只含上述文件）。对未来改动的承诺与只追加规则一致：加 `device_action`、`perception_read` 两个固定工具会让老对话重建一次请求开头，依据的机制属实——`thread-prompt-bundle-service.ts:89` 的 `tool_set_changed`（读到）；设计 :643 把「全部新提示词文字和两个工具同一版本上线，之后不再加提示词」定为硬要求，与 `.claude/rules/prompt-prefix.md` 第 4/6/7 条和第 53 行「改提示词文字……请求开头会变一次」的已知代价一致（读到）；每轮会变的值（当前时间、日历表）都排在最后（ADR 0230 前提 12 引规则第 15 条，原话与规则文件 :67 一致）。「之后分批开功能不再加提示词」与计划第 7 批接新来源是否真的不再新增提示词文字，取决于第 5 批是否把六个来源的检查提示词全部提前放进目录——计划没有明说，属推测层面的小风险。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
本 PR 本身不会（没有序列化代码）。对未来设计：ADR 0230 决定 12「按发生时间毫秒整数加编号排序、键序固定、同一批字节相同」符合 prompt-prefix 第 10/11 条；遮盖单位限定在「一批自己的内容」内，与规则第 54 行「点名值之后的同请求消息也遮」的例外一致，且设计明确这只影响以后新发的后台请求、不影响已发内容（读到）。带时间的字段（设备时间字符串）只另存用于显示、排序只用整数（设计 :309），不会进请求字节。未发现违背点。

**3. 有没有对应的自动检查，反向用例会不会真的失败？**
本 PR 改动的文件由这些现有检查覆盖（全部在 package.json 里证实）：check:instruction-links、check:adr-numbers（0089 的 `superseded_by` 路径真实存在，我读了 0229 文件）、check:docs-links、check:markdown-tables、check:glossary、format:check；其中 adr-numbers 和 docs-links 带 vitest 测试（test/tooling/adr-numbers.test.mjs、docs-links.test.mjs 在 grep 结果中出现）。反向用例「真的会失败」无法验证——我不能运行命令；作者声称通过，**未核实**。`validate_docs.py` 不在仓库（外部技能），其运行结果同样**未核实**。缺口：没有任何自动检查验证「文档陈述与代码一致」，上面第 2、4 条问题正是从这道缺口漏网的（推测，依据 document-governance.md:28 所述 `npm run check:docs` 已删除、只余局部检查）。

**4. 改动产生/修改的每个值，每个使用处都能接受吗？**
本 PR 产生的「值」只有指令文本和文档：规则例外（苹果客户端可在 Mac 上构建）在 AGENTS.md:117、test-and-production-hosts.md:9、delivery-mode.md:31、ADR 0229 决定第 8 条四处一致（读到）；引用的锚点（`#decision`）、ADR 路径、Runbook 路径都存在（读到）。ADR 0089 的 `status/decision_status/superseded_by` 改写与其取代关系一致（读到两文件头）。未产生运行时标识、配置键或序列化格式——文档里的「新值清单」属于未来实现，逐条写了两端校验（见上文第 8 条），其中引用的现有校验端点全部核实存在。设计/ADR 间真正的值不一致是第 1、3 条（测试数量、密钥把数）。
