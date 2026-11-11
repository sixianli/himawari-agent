# 复核报告：硬规则第 2 步（e63eac32）

## 发现的问题（按严重度从高到低）

**1.【中】`packages/application/src/rules/rule-book.ts:330-339` — `assertRuleShape` 的“机械防线”可被平凡绕过**
- 证据：检查逻辑是对整个表达式做子串匹配：
  ```ts
  const bare = rule.expression.replace(/"(?:[^"\\]|\\.)*"/gu, '""');
  if (/\bamount_(?:minor|currency)\b/u.test(bare) &&
      !/\bamount_state\s*==\s*"known"/u.test(rule.expression)) throw ...
  ```
  只要表达式**任何位置**出现 `amount_state == "known"` 就放行。例如 `amount_minor < 1000 || amount_state == "known"` 能通过检查，但金额缺失时 `amount_minor` 固定为 0（`rule-book.ts:97`），`0 < 1000` 为真，会把没有金额的邮件全部拦下——正是这条检查要防的事故。
- 读代码证实的部分：字段缺省值、两个正则的行为、`assertRuleExamples` 只校验规则自带例子的求值结果而不要求“缺金额不命中”的反例。单引号字符串嵌入绕过（CEL 是否接受 `'...'` 字面量）属**推测**——node_modules 未安装，无法读解析器源码核实。
- 建议：把“要求 known”改成结构化检查（AST 里验证 `amount_minor`/`amount_currency` 的每次出现都被 `amount_state == "known"` 的合取分支守卫），或至少要求注册的金额规则必须带一条“missing 状态不命中”的反例。
- 影响：`amountThresholdRule` 生成器本身是安全的；此缺口只在第 4 步把 `ownerRules` 接到存储后才可能被触发。

**2.【中→低】`packages/application/src/services/proactive-mail-check-service.ts:907` + `sqlite-proactive-operations.ts:645-679` — 重复的 `规则id@修订号` 会让整次检查写入失败**
- 证据：服务端 `[...suppressing].sort()` 不去重；存储端校验要求唯一：
  ```ts
  value.every(...) && new Set(value).size === value.length
  ```
  不满足就 `this.invalid(...)`。若第 4 步主人同时配两条金额规则（如 JPY<1000 和 JPY<800）且修订号相同，一封 600 日元的邮件两条都命中，`ruleHits` 里出现两条相同字符串，`store.record` 抛错，整个邮件检查轮失败。`floorHits` 有同样暴露，且 `GATE_OUTCOMES` 允许 owner 规则用 `raise_floor`（`rule-book.ts:325`），owner 规则命中也会进 `floorHits`（`proactive-rules.ts:56-63`）。
- 读代码证实的部分：以上代码路径。第 4 步是否会真出现同 id 同修订号的规则属**推测**（接线还不存在）。
- 建议：写入前用 `[...new Set(suppressing)].sort()` 去重；并决定 owner 规则是否允许 `raise_floor`。

**3.【低】`sqlite-decision-ledger-operations.ts:49-96` — `validateLedgerWrite` 不校验 `ruleHits`**
- 证据：校验只覆盖 `memoryIds`、`ruleIds`、`batchId`、`resultMemoryIds`（第 62-69 行），`ruleHits`（和 `floorHits`）直接进 JSON（第 175-181 行），读取时 `inputs.ruleHits ?? {}`（第 175 行）原样返回。proactive 路径（`sqlite-proactive-operations.ts:672-679`）有校验，ledger 直写路径没有——不过 `validateLedgerWrite` 拒绝 `kind === "proactive"`（第 52-53 行），所以生产上 `ruleHits` 实际只走有校验的那条路。属既有校验不对称模式的延续，非本改动新引入的高风险。

**4.【信息】`proactive-mail-check-service.ts:464-466` — `parseJudgements` 的默认 `bodyReadInFull` 与生产闭包口径不同**
- 默认版只看 `item.body !== null && !item.bodyTruncated`；生产版（第 1185-1190 行）另看 `proactiveMailView` 按 `perMail` 截窗后的 `bodyTruncated`。生产调用都传了闭包，默认版只有测试在用（`prompt-output-contracts.unit.test.ts:104-118`）。将来新增调用点容易用错默认值。建议收窄默认版或改名标明口径。

**5.【信息】`proactive-mail-check-service.ts:904-906` — 主人自己发的邮件也会被金额规则拦推送**
- `sentByOwner` 的邮件绕过地板规则（第 829 行 `floorIds = []`），但 `wantsPush && !floor` 时照样问裁判。主人说“小额别推送”是否该作用于主人自己发出的邮件的提醒，ADR 未写。第 4 步接线前无实际影响。

**6.【信息】`proactive-mail-check-service.ts:1375` — `ruleIds` 只含 `floorHits` 的 id，不含 `suppress_push` 命中**
- 与 ADR“原有的 floorHits、ruleIds 不变”一致，但消费决策记录的人要知道“哪些规则起作用”必须读 `ruleHits`。未发现现有消费方做 `ruleHits ⊆ ruleIds` 之类的交叉假设。

## 侧重检查

走了一条最普通流程：owner 规则经 `ownerRules` 选项 → 构造时 `assertRuleExamples`（`proactive-mail-check-service.ts:521-523`）→ `run()` 取信、`#fitBatch` → `proactivePrompt`（固定文字 + 记忆 + 邮件数据 + 当前时间，`proactive-mail-check-service.ts:389-410`）→ 模型 → `parseJudgements`（amount 解析 + `bodyComplete` 闭包，第 1184-1190 行，`perMail` 与提示词构建一致，缓存于 `mailViews` 不会重复跑遮盖）→ 洞察循环（地板 → `suppressPushHits` → `ruleHits`）→ `#finish` → `store.record`（sqlite 校验）→ ledger 读旧记录得 `{}`。
- 有测试覆盖：构造拒绝坏例子、正反向边界、`ruleHits` 写入、旧记录读取（`decision-ledger.test.ts:216`、`entryFromRow`）。
- 没有测试覆盖的路径：每日上限触达时 floor 命中邮件的无条件推送分支（第 834-856 行，`push: true`，不问裁判——地板命中本来就不该拦，行为正确但这段没被本次用例覆盖）；`#gateBackoff` 与被拦洞察的交互；问题 2 的重复 id 场景。
- 文档一致性：ADR 0210 的七条决定和三处偏差逐条对照代码均一致（闸门结果表、`!floor` 守卫、构造时跑例子、静默窗口删除、0087 迁移不存在——glob 无 0087 文件）。作者“没有任何生产代码构造 `AttentionPolicyService`”经 grep 证实：构造点只有 4 处测试/夹具（beef-restaurant、local-composition-root、attention-delivery、attention-policy.unit.test）。“npm run check 48 步、733 条通过”**未核实**（无法运行命令），但 `check:rule-registry`、`check:prompt-catalog`、`check:prompt-prefix` 脚本确实存在且指向所述文件。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？** 不会改变任何多轮对话的请求开头。改动只在 `packages/prompt-catalog/src/mail.ts:32` 给一次性后台判断提示词的固定文字末尾追加一行；golden（`apps/agent-service/test/__prompt_golden__/mail.judgment.txt:22`）证实新行位于固定块末尾，记忆、邮件数据、当前时间仍在其后（`proactivePrompt`，第 389-410 行），符合 prompt-prefix 规则第 15 条（固定在前、会变的在后）。这类判断是无历史的一次性调用，不触碰“已发内容不得改动”（第 4 条）；固定文字变更导致该提示词缓存失效一次，ADR 已写明，清单 sha 与 `changedIn: HR-2` 已记录。工具定义、系统提示、历史、遮盖逻辑零改动（diff 证实）。

**2. 同一段文字会不会变成不同字节？** 不会。新增的是纯静态文字；`amount` 只参与决策，不回写进任何提示词。`ruleHits` 值排序后写入（第 907 行），`ruleIds`、`relatedFailedSteps` 沿用既有排序；决策记录 inputs 以固定键序的字面量构造（第 1374-1389 行）。`floorHits`/`ruleHits` 的键序跟随候选处理顺序，与改动前的 `floorHits` 同模式，非新增问题。

**3. 有没有对应的自动检查，反向用例会不会真的失败？** 有：`check:rule-registry`（[HR-2] 单测：换算边界、字段永远存在、门槛正反例、`assertRuleShape` 拒绝两条坏规则和不对口结果）、`check:prompt-catalog`（golden + 清单 sha）、集成 `[HR-2]`（正向：小额被拦且记 `ruleHits`；反向 8 组：unsure、缺失、他币种、正好等于、币种不认识、数值乱写、无正文、正文截断，外加地板命中和没有规则两组）。没有本改动代码时，正向用例会失败（`ownerRules` 不存在、小额照推），`assertRuleShape` 拒绝类单测会失败；反向用例验证的是“行为未被误伤”。执行结果本身**未核实**（不能运行）。

**4. 每个新值的两端都核对了吗？** 逐个核对：`amount_state/amount_minor/amount_currency` —— 产生于 `senderFacts`（永远三字段齐），消费端 CEL 环境按字段目录注册并做类型检查（`rule-expression.ts:39、138-152`），uncertain 时 minor 归 0、currency 保留，与目录描述一致；`suppress_push` —— 三个消费点（`GATE_OUTCOMES`、`suppressPushHits` 过滤、`floorHitIds` 过滤）全部枚举核对，无遗漏的 switch；`ruleHits` —— 端口（可选）、proactive 写入校验、读取 `?? {}`、ledger 读取默认 `{}`，两端可接受（但见问题 2、3）；`ownerRules` —— 仅构造器消费（跑例子检查），运行期拼进 `rules`，`RuleJudge` 按 gate 过滤所以不会污染 `mail_delivery` 求值；`RULE_IDS.amountThreshold = "suppress_small_amount"` —— 通过 `ids()` 长度校验无碍；删除的 `quietHours` 配置 —— 4 处构造点全部更新，无残留引用。例外即上面第 1、2、5 条。
