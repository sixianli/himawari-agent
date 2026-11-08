# 复核报告：PA-1（Gmail 判断前读同一件事以前的邮件，62badac）

## 侧重检查：我走过的普通使用流程

入口 → 结束的路径：拥有者连接 Gmail（设置页说明 `proactive.apps.what1`）→ 定时 tick → `ProactiveMailCheckService.run()` → `reader.fetch` 新邮件 → `store.unprocessed` 过滤 → `#related`（gmail 线程/搜索/取信）→ `#recall` 记忆 → 分批 `proactivePrompt` → 模型判断 → `#finish` 写 SQLite 决策记录（校验 `relatedInputsValid`）。

- 已有测试覆盖的路径：`gmail-related` 的归一/编号/三种关联/预算/超时/不信任搜索命中/已归档与垃圾筛选（packages/platform-node/test/gmail-related.unit.test.ts，10 条）；集成的正向时间线、反向"同发件人不同事"、整体失败、部分失败、遮盖、6 封上限、账本记录（test/integration/proactive-mail-check.test.ts `[PA-1]` 6 条）；配置解析含 0 值和反向非法值（startup-configuration.unit.test.ts:1372-1400）；固定提示词的金样与清单防陈旧（prompt-rendering-golden.unit.test.ts:215、prompt-catalog.unit.test.ts:187）。
- 测试未覆盖的路径（读代码得出，标注为证实/推测）：①配置键 `related*` → `ProductionProactive` → 服务的映射（production-proactive.ts:180-185）只有值出现在测试夹具里，没有断言映射方向/接线正确（推测：接反了也不会有任何测试红）；②账本读回方向只有 daily-review 测试工厂补了四个默认字段（daily-review.unit.test.ts:157-160），没有读旧记录（缺 `related*` 字段）的用例，而 `entryFromRow` 的补默认值正是为旧记录写的；③控制中心没有展示这些字段的页面（与 ADR 自述一致，仓库里确实没有读 `inputs.related*` 的页面代码）。

## 按严重度排列的发现

1. **中｜packages/platform-node/src/gmail-related.ts:10-11,81-89,112 + proactive-mail-check-service.ts:679**｜默认配置下预算会明显不够，后面几封新邮件拿不到前情，却会被标记"前情可能不全"。｜证据：每封新邮件最多消耗 1（thread）+ 1（subject 搜索）+ 3（`MAX_REFERENCES_PER_MAIL=3` 个编号搜索）+ 每个搜索命中最多 10 个 id 的逐封取回（`SEARCH_RESULTS=10`）≈ 最多 45+ 个请求；默认 `relatedRequestsPerCheck=120`。第 4 封起新邮件会命中 `RelatedStop("budget")`（gmail-related.ts:81）→ `relatedUnavailable:true` → 提示词让模型"证据不足判 check"。ADR 0180 和工程案例库都没披露"默认 120 只够约 3 封获得完整时间线"这个后果。｜建议：在 ADR 的后果一节写明这个换算，或把每封自身的搜索/取回预算单独设限。

2. **中｜packages/application/src/services/proactive-mail-check-service.ts:679-699**｜即使本次检查注定因每日费用上限停止，`#related` 也已经把最多 120 次 Gmail 请求发完并且把旧邮件全文取回过。｜证据：`#related` 在第 679 行先执行，费用判断 `spentToday + costMicros + estimate > dailyCostMicros` 在第 699 行才按批发生；Gmail 请求不计入 costMicros。｜建议：把 `#related` 挪到第一批的费用判断之后，或在已超上限时跳过。

3. **低｜packages/application/src/services/proactive-mail-check-service.ts:246-280**｜related 视图对"只有摘要"的旧邮件不写 `bodyUnavailable`。｜证据：`relatedMailView` 的 json 只在 `windowed?.truncated || mail.bodyTruncated` 时写 `bodyTruncated`，没有 `baseMailView`（第 298 行）里 `windowed === undefined && item.bodyUnavailable` 那条分支；提示词目录对 `bodyUnavailable` 的解释只覆盖新邮件本身，但对"related 里这封是摘要还是正文"模型无从分辨。｜建议：给 related 的纯摘要条目补同样的标记，或确认设计上无歧义。

4. **低｜docs/adr/0180（决定第 2 条）**｜文档写"固定说明只在末尾追加两条……其他不动"，但两条新行实际插在 `MAIL_JUDGMENT` 的中段（bodyTruncated 行之后、"对每封邮件给出一个结论"之前，packages/prompt-catalog/src/mail.ts 差异第 +16/+17 行），不是末尾。KV 上无影响（见必答 1），但描述与代码不一致。｜建议：改文档措辞。

5. **低｜apps/agent-service/src/production-proactive.ts:180-185**｜配置→服务的映射只被"值出现"覆盖，没有接线方向的测试（见侧重检查①）。｜建议：加一条断言构造出的服务带四个上限值的测试。

## 读代码证实的 lain fact 与推测分开说明

**证实（逐行读过）**：
- 新增 4 个配置键两端一致：configuration.ts:223-226（类型）、strict-configuration.ts:994-997（白名单）、1020-1031（范围 0–50 / 200–50_000 / 200–200_000 / 1–2_000，且 `relatedCharactersPerMail ≥ relatedCharactersPerRelatedMail` 交叉校验）、production-proactive.ts:180-185（一一对应映射）、测试覆盖（startup-configuration.unit.test.ts:1372-1400）。
- 账本四个新字段两端校验一致：服务产生（proactive-mail-check-service.ts:1183-1187，`relatedFailedSteps` 排序、步骤名清洗并截到 64）；SQLite 校验（sqlite-proactive-operations.ts:525-547：键长 1–256、每列 ≤64 个唯一字符串 ≤256、steps ≤16 条 ≤64 字符、stats 为非负安全整数）；读回旧记录兜默认（sqlite-decision-ledger-operations.ts:142-146,175-191）。每列 ≤50 封（perMail 上限 50 < 64）且 Map 去重，`ids` 的唯一性、长度校验都可通过。
- 提示词结构：固定（`MAIL_JUDGMENT.text`）→ 记忆 → 邮件 JSON（含 per-mail 的 `related`）→ 最后一行"现在是…"（integration 测试断言最后一行 `prompt.split("\n").at(-1)).toMatch(/^现在是 /)`）。
- 确定性：related 数组排序键 `receivedAt.localeCompare || messageId.localeCompare`（gmail-related.ts:139-142），集合输入只影响插入顺序不影响输出；JSON 键序由字面量固定；遮盖每封独立调用，与后文无依赖。账本 `relatedStats.durationMs` 沿用既有 `Math.max(0, Date.parse(...))` 模式（1173 行同式）。
- 遮盖与上报成对：related 的 from/subject/snippet 走 `masked()`，正文先遮再截、上报 `sentBodyValues(mail.body, charactersPerRelated)`（服务 469-483 行），与 base 视图同一套；integration 测试断言验证码不上泄漏。
- 金样与清单：`prompt-manifest.json` mail.judgment sha256 更新、`changedIn: "PA-1"`；金样文件已同步包含两条新行。
- 作者说法核对：`npm run check` 的 `check:steps` 清单确为 41 步（package.json:27 逐项清点=41），`check:secrets`/`check:delivery-packet`/`check:security-review` 三步存在；"检查清单 id 能过其他端校验"这类 I-73 式核对这次两头都探到了（见上）。**"41 步中 3 步在干净 main 失败""第 0 层 49 文件 942 条通过"**：步骤数证实，哪 3 步失败与 942 条数未核实（不能运行命令）。
- 反向用例会真失败（推理）：如"同发件人不同事"用例，若去掉 `sharesCounterpart`/主题比对，`related` 会出现在 prompt 且测试断言 `prompt).not.toContain('"related":[')` 失败；遮盖用例同理。但我没有运行测试，这是一致性推理而非执行证据。

**推测**：真实 Gmail 对 `q=subject:"…"` 和全文搜索的排序/配额行为未核实（无网络，作者也自述未真测）；gmail-source.txt 的 `withTimeout` 内部实现我未读，超时后的 `failed` 步骤名归到哪个步骤是根据 findRelatedMail 的 catch 逻辑推的。

## 必答问题

1. **不改变（无违规）。** 这是规则第六节"后台调用"的一次性调用：顺序是固定指令 → 数据 → 当前时间（符合 §15"固定的在前、会变的在后"）。`related` 数据放在每封邮件自己的 JSON 里（数据段），`relatedUnavailable` 同位置，最后一条消息仍是"现在是…"行；每轮会变的值（邮件、记忆、related、时间）都已在数据段与末行。本调用没有对话历史，不存在"模型已经见过的开头"，`check:prompt-prefix` 的冻结前缀规则不约束这类调用；提示词文字的变更已按流程更新金样与 prompt-manifest（读码证实）。
2. **未发现违规（读码证实）。** 同一输入序列化字节确定：JSON 键序字面量固定、related 列表按 receivedAt+messageId 排序、取最新 perMail 的选择与切割与输入顺序无关、遮盖逐文本独立。唯一接近的是 `relatedStats`/`relatedByMail` 这类账本 JSON 的键插入顺序来自 Gmail 返回顺序，但那只进 SQLite 账本，不发给模型，且账本本就有同类既有模式。
3. **有，且构成合理（读码证实其机制，未执行）。** 金样快照测试（prompt-rendering-golden.unit.test.ts:215）会在固定说明再变而不更新金样时失败；prompt-catalog.unit.test.ts:187 的 `PROMPT_MANIFEST_STALE` 会在清单 sha256 与目录内容漂移时失败；两个检查都是 `npm run check` 的 `check:prompt-catalog` 一步。新增的 `[PA-1]` 反向用例（如 `prompt).not.toContain("新商品が入荷")`）在设计上依赖新代码的过滤逻辑，改前代码应使其失败（推理，未运行）。作者说的 3 步既有失败我只核对了步骤名存在，未核实"失败"本身。
4. **每个新值都核到了两端，未发现校验冲突（读码证实）。** `participants`（gmail-source.ts:220 产生 → 仅 gmail-related.ts:33/39 消费，可选字段，不进模型输入）；4 个配置键（类型→严格解析白名单+范围+交叉条件→production 映射→服务默认合并，0 = "off" 有意支持）；账本 4 字段（服务产生→SQLite 逐项校验→读回兜默认→daily-review 工厂同步）。账本页面展示层不存在（作者自述一致）。发现的问题见上面第 1、2、3 条（预算后果披露、超上限时的无谓请求、related 无 bodyUnavailable），均属文档披露与浪费层面，不是校验两端的断裂。
