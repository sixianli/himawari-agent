我已经完成了所有必要的阅读。正在撰写复核报告。

## 复核报告（基准 058293d → 5870f36，修复出口遮盖误遮固定指令 I-78）

### 「读代码证实的」的问题清单（按严重度）

**中**
- `packages/application/src/services/model-egress.ts:476`（间接）、`packages/sensitive-capture/test/trusted-text.unit.test.ts`、`apps/control-center/test/sensitive-interceptions.unit.test.ts` —— **这三个文件里只有 agent-service 的门槛用例真正挂在 `check:steps` 链上**。`package.json:27` 的 `check:steps` 只包含 `check:prompt-catalog`（`package.json:44`，已包含 `trusted-prompt-egress.unit.test.ts`，证实）；`scripts/run-all-checks.mjs:32` 只跑 `check:steps` 里的名字。`packages/sensitive-capture/test/trusted-text.unit.test.ts` 属于 `unit` 项目（`ci/policy.json:196` `packages/**/*.unit.test.ts`），页面用例属于 `browser` 项目（`vitest.workspace.ts:66`），都不在任何 `check` 步骤里，只在完整测试套件（`npm run test` 等）中执行。而 `docs/incidents-and-gates.md` I-78 行把三个测试都写进门槛列并写「挂在 `npm run check:prompt-catalog`」——这句话对后两个文件不成立（`scripts/check-incident-gates.mjs:65-70` 只核对路径存在，不核对是否被 check 执行）。建议：把 sensitive-capture 和页面的 I-78 用例也挂进某个 check，或把 incident 行的措辞改准确。

**低**
- `packages/sensitive-capture/src/redaction.ts:220、225` —— 恢复阶段的两条 `throw new EgressRedactionError()` **没有任何测试覆盖**（全文 grep 只有 `machine-secret-exclusion` 等间接触及其他路径；trusted-text 和 trusted-prompt-egress 均未构造恢复失败用例）。且 `model-egress.ts:216-220` 只 try `assertMachineSecretFree`，恢复失败会以原始异常冒出，不进 `refuse()` 统一出口。建议补一条「清单串改坏后必须失败置空/拒绝」的反向用例。
- `packages/sensitive-capture/src/machine-secrets.ts:25` —— 私钥块改 `[^\uFFFF]*?` 后，若真实私钥体恰好含 U+FFFF（含固定文字被填充的场景），整块不再被遮为 `[密钥]`，`-----BEGIN … -----` 头尾会原样出模型。理论上还保留了尾部 `PRIVATE_KEY_BOUNDARY` 断言兜底（`machine-secrets.ts:59`），我判断风险可接受，但值得知道。
- `packages/sensitive-capture/src/redaction.ts:331-335`（named-earlier）+ `known` 映射来自历史消息：若先前消息里被记下「值」本身就含 U+FFFF，后续带清单的消息里它可以在填充串内命中并替换，破坏恢复（极异端输入）。设计上 `input.includes(TRUSTED_FILLER)` 已挡住「本条输入含 U+FFFF」的情况（redaction.ts:178），这条残留只可能来自跨请求的 known 值。极低概率，列为已知残留即可。
- 页面数据不对称（非本次引入，但与本次相关）：`locateMaskedValues`/`credentialFindings`/`maskSensitiveText`/`findSensitiveValues`（`packages/sensitive-capture/src/redaction.ts:356、372、437、480`）都以 `redactForEgress(input)` 不带清单的方式调用，同一字符串在「出口」与「邮件检查/记忆审计」两条路径会得出不同遮法。这两条路径处理的内容（邮件正文、记忆文本）通常不含提示词目录固定文字，我核对未发现会复现 I-78 的记录来源（拦截记录只出自 `model-egress.ts:200-211` 的 `observe`），不算缺陷，列出供知悉。

### 「推测」的（我没有证据支持）
- 新清单生效后，历史上其他 `new ModelEgress(...)` 测试助手（`packages/testing/src/model-egress.ts:6`、`packages/runtime-pi/test/helpers/model-egress.ts:9`、`packages/memory-engine/test/helpers/model-egress.ts:4`、`packages/application/test/model-egress.unit.test.ts`）默认行为随之改变，只能靠全量测试证明无回归，我未运行。
- 聊天系统提示与历史在修复后哪些字节会变一次，作者声明 7 给的是条件式说法；我核对了提示词目录里与「验证码/密码」关键词相关的段落（`chat.ts:255/267` 的占位符说明里的 "1111" 被 redaction.ts:315 的「尾号」例外挡住，不会先前被遮），支持作者的条件范围，但未逐字核查运行时拼装的全部聊天系统提示。

## 侧重检查（我走的流程与结论）

普通流程：Andy 发消息 → Pi runtime 流式请求（`packages/runtime-pi/src/pi-runtime-adapter.ts:999-1004` 设置 `purpose: "chat"`、`threadId`）→ `wrapFetch`（model-egress.ts:153-234）→ `redactChatCompletions` → 观察记录 → 数据库 → 控制中心页面 `where()`（sensitive-interceptions.tsx:99-123）。后台支线：每轮之后 `ProductionMemoryCapture`（production-memory-capture.ts:752-781）→ `auxiliaryMemoryGeneration`「memory-capture」→ `wrapFetch`，以及 `消息处理器生成、动作复核、邮件判断`（production-model-composition.ts:463-471，`modelUsagePurpose` 把 `memory-episode-0` 归一为 `memory-episode`，packages/application/src/ports/model-usage.ts:58-63，与页面 `MESSAGE_PURPOSES` 集合一一对应）。

未覆盖路径：这条流程里，`service-main.ts:1919`  → 组装层真实发出的「memory-capture 请求里固定指令不遮」没有端到端测试直接断言——门槛用例是用 `memoryCapturePrompt` + `createProductionModelEgress` 两者各自的真实实现拼出来模拟（自建 init），近似但不经过 `generateText` 组装链；页面改动有 3 条单测覆盖；恢复失败分支无覆盖（已在上方列出）。文档一致性已核对：`.claude/rules/prompt-prefix.md` 新增第 11 条子项、`docs/kv-cache-guide.md` 第 11 条更新、incident I-78 行均与代码事实相符（24 字符阈值 = `entry.ts:59` 的 `TRUSTED_TEXT_MINIMUM_LENGTH`），项目规则「不写注释」遵守（改动无新增注释）。

## 逐条核对作者的说法（先给核对结果）

1. **属实**。`redaction.ts:200-227` 证实：`trusted` 出现时把影子文本按同长度 `\uFFFF` 填充替换、跑完规则再原位换回；`trustedSpans` 只匹配、不进 find（关键词不计数）；恢复对不上抛 `EgressRedactionError`（220/225）；输入含 `\uFFFF` 时退回旧路径（178）。
2. **属实**。我把全部规则扫了一遍：私钥块排 `\uFFFF`（machine-secrets.ts:25），密码值字符类排 `\uFFFF`（redaction.ts:64），bearer/jwt/sk-/gh/OSS/AKIA/credential-assignment 的类是 `[A-Za-z0-9._~+/=-]` 等（machine-secrets.ts:27-42），其余各规则只匹配数字、大写字母或汉字，都不会吞掉 `\uFFFF`。
3. **属实**。`entry.ts:59-76` + `trusted.ts`：只取 `text` 段 ≥24 字符、`Set` 去重、按长度降序再字典序固定排序；`model-egress.ts:197` 默认 `this.#options.trusted ?? TRUSTED_PROMPT_TEXTS`。
4. **属实**。`trustedSpans` 把全部条目全部出现位置收集后按 `(起点升序, 同起点取长度更大的)` 排序，再从 0 贪心取不重叠区间（184-197），嵌套与同起点短区间都被跳过，结果只取决于出现的字符串集合本身，与清单顺序无关（trusted-text 第 5 条用例也断言了这个性质）。
5. **属实**。`sensitive-interceptions.tsx:99-123` + `zh-CN.ts:1201-1208` 证实四类分支的显示与用例一致；`model-usage.ts:58-63` 证实所有后台用途都会被归一，页面集合没有缺口。
6. **基本属实**：`check:prompt-catalog` 里已含 `trusted-prompt-egress.unit.test.ts`，其第一条与第三条在默认清单为空时会失败（我会分析：第一条断言 `MEMORY_CAPTURE.text` 原样未遮、第三条遍历目录全部条目断言未遮，都会因验证码规则命中 "1000" 而失败）。但 trusted-text 与页面用例未挂 check（见中危项）。
7. **基本属实**：我核实了「每轮变化值都在末尾」——memory-capture 的请求是“列表顺序固定（system 一条固定 legend 说明）+ 一条重建的 user 正文”（测试代码也是这个形状），系统提示与工具未变化。已同意“起头变化之前的内容也变化”                                                的聊天情形是条件性的，我核对的范围未见冲突，见「推测」。

## 必答问题逐条

**1. 请求开头（供模型读取的内容只追加）**
- memory-capture 类后台请求：请求是【固定 system 消息（legend 说明，在清单里，`egress-legend.ts:6` = `CHAT_EGRESS_LEGEND.text`）+ 单条重建的 user 正文】；随轮次变化的 `messageSentAt/ownerMessage/previous…` 全部在唯一一条 user 正文里（production-memory-capture.ts:132-148 单字符串拼接），符合“随轮次变化的值都在最后一条消息里”。这次修复把该 user 正文开头原来被遮的 `[验证码#…]` 还原成 "1000"，已发内容前缀字节变一次——已获同意，文档（prompt-prefix.md 新子项、kv-cache-guide 第 11 条）如实记载。
- 聊天：系统提示/历史按对话冻结、每轮变化的值在最后一条（runtime 提示在末尾）；修复后聊天系统提示的目录片段不会被遮（占位符说明里的 "1111" 例本来也命中不了，见侧重检查）。“历史里贴过整段固定指令”会变一次的说法条件合理（我未逐字核查全部聊天拼装）。
- 结论：**是，仍然只追加**；唯一违反“已发内容不变”的点是这次有意的一次性还原，已在文档里写明并被批准。

**2. 同一段文字不同请求 → 不同字节**
- 不会（相同清单前提下）：清单是模块级常量（`trusted.ts`，构建内固定），匹配区间选取与清单顺序无关（redaction.ts:189-197，用例覆盖），排序用代码单元比较，无依赖对象遍历或数据库顺序之处。已知例外都以可控方式收敛在代码里：输入含 `\uFFFF` 时退回旧遮法（`redaction.ts:178`）、跨构建改提示词文字时清单随之变（rule 文件新增子句明示、待接受）。同一次会话 repeats 的确定性也有用例（trusted-prompt-egress 最后一条断言两次相同字节）。
- 残留的水：本条消息的遮法既取决于消息自己，也取决于清单（构建内）——这是文档化的设计选择。

**3. 自动检查与反向用例**
- 有，且强制门槛存在：`check:prompt-catalog` 包含新用例（package.json:44）；`反向: without the trusted list the masked ...` 两条反向用例显式用 `trusted: []` 断言当默认清单为空时 "1000" 会被遮、记录会生成——与第一条「原样不变」对照，**默认清单被清空时门槛确实会失败**（我逐行推理验证，未实际运行）。sensitive-capture 的反向用例同样有（第一条与 `no trusted` 断言），页面也有 REVERSE 用例。范围缺口：sensitive-capture 与页面两条用例不在 `check:steps`，见上面「中」级问题。

**4. 每个值的产生与使用**
- `TRUSTED_PROMPT_TEXTS`：产生于 prompt-catalog 七个模块全部条目（`prompt-catalog/src` 下仅这 7 个数据文件，`glob` 与 grep 证实没有遗漏的提示条目文件）；使用仅 model-egress.ts:197 默认值与门槛用例。包依赖边界 application→prompt-catalog 在 `scripts/boundary-policy.mjs:14` 允许。
- `trusted` 选项 / `TRUSTED_TEXT_MINIMUM_LENGTH` / `trustedPromptTexts`：只在 trusted.ts 与测试中使用。
- 填充字符 `\uFFFF`：与全部规则逐条分析无冲撞（见声明 2 的核实），两条异常路径用例覆盖；恢复失败路径无覆盖（低危项）。
- 页面字符串结果 `where()`：三例试例与消息目录全部存在；`MESSAGE_PURPOSES` 与后端归一后的用途集合吻合（model-usage.ts:3-12 与 58-63）。页面旧存量的记录（修复前入库、“你的话”）会用新渲染显示——这是「只改页面，不改数据」的合意效果。

除此之外没发现问题。整体质量高，两处建议补齐：门槛覆盖面("check:steps")、恢复失败路径的用例。
