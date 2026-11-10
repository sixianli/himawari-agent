# 审核结论（P1-5 邮件决策详情页方案）

## 侧重检查（先写：我走的流程和结论）

我按最普通的使用流程走了一遍：**周报“Muse 做对而 Himawari 没做到”案例行 → 点“查看这封邮件” → 新详情页路由（查询参数）→ `decision.email.read` → 左侧内嵌决策链 → 右上 `proactive.weekly.read` 校准数字 → 右下 Muse 条目与比较状态**。逐段核对了数据链路（`muse_reference_entries`/`muse_intake_items`/`proactive_processed_messages`/`decision_ledger` 的迁移和查询）、合约（contracts-v2.ts）、前端（router.ts、proactive.ts、weekly-report.tsx、decision-chain-drawer.tsx）、以及事故门槛 I-73 的原始记载。

结论：方案的数据前提成立（四张表都已存在，`message_id`/`paired_message_id`/`gmail_message_id` 都有，确实**不需要加表加迁移**）；“不碰模型请求”成立；但**新值的产生端/使用端清单不全**（正是 I-73 那类问题），**“同名同义”的比较状态在数据源上有实际偏差**，**测试计划没有绑定仓库现有的门槛机制**。

---

## 证实的问题（按严重度从高到低）

**1.（高）messageId 的写入端校验缺失，查询端正则是“单边约定”——I-73 同类**
- 证据：方案的正则 `[A-Za-z0-9_-]{1,256}` 与 Muse 接收端写入校验完全一致（`apps/agent-service/src/production-muse-intake.ts:60` `const GMAIL_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u`，用在 :230）。但这只管 `muse_intake_items.gmail_message_id`。详情页真正的主键查找对象是 `proactive_processed_messages.message_id`，它的写入（邮件检查流程，INSERT 在 `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:697`）**没有任何字符集校验**，数据库约束只有长度（`migrations/0069_decision_ledger.sql:103` `message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256)`）。也就是说：产生端（邮件检查写库）和本方案的使用端（查询正则）校验不一致。
- 后果：若某封邮件的 id 含正则外字符，库里真实存在，页面却显示“无记录”——静默不一致，和 I-73“清单里的 id 能通过后端校验吗”没问是同一类。
- 建议：把 `GMAIL_ID_PATTERN` 提为共享常量，在邮件检查写 `proactive_processed_messages` 前同样校验（或写日志统计越界 id），查询端复用同一常量；反向用例：一个“正则外但库里存在”的 id 必须要么能查到、要么显式报错，不得静默“无记录”。

**2.（中高）“合约两端同步”实际是五处以上同步，方案没列全**
- 证据：`gapCases` 现在没有 messageId，只有哈希 id（`apps/agent-service/src/production-gap-cases.ts:39-41` `gapCaseId` 是 `gap_` + sha256 前 20 位，前端无法反推出邮件编号，所以加字段是必须的）。加了之后要同步改：
  1. `packages/gateway-contracts/src/contracts-v2.ts:843-864`（gapCases schema）——不改则 `apps/agent-service/src/production-observation.ts:297` 的 `gatewayV2MessageSchema.parse(snapshot)` 在运行时抛错（这是现有的自检，算自动检查，但要在方案里写明）；
  2. `apps/agent-service/src/production-gap-cases.ts`（产生端）；
  3. `packages/gateway-contracts/test/gateway-v2.fixture.ts:283`（fixture）——`gateway-v2.contract.test.ts:34` 声明 "round-trips every … message"，新字段不进 fixture，这条覆盖声明就失效；
  4. `test/e2e/fixtures/control-center-browser-server.mjs:952`；
  5. `apps/control-center/test/weekly-report.unit.test.ts:192,758`。
- 另外：标记案例时密封的快照 `GapCaseSnapshot`（`apps/agent-service/src/production-gap-export.ts:16`）继承 `GapCase`，也会带上 messageId；旧标记的密封快照没有这个字段——`isGapCaseSnapshot`（:53）不校验新字段，推测无害，但方案应写明这个差异。
- 建议：方案第 4 条的“合约两端同步”展开成上面这份逐点清单，每点一个反向用例（去掉一处就红）。

**3.（中）“比较状态与 summarizeMuse 同名同义”在数据源上有实际偏差**
- 证据：`summarizeMuse`（`packages/calibration/src/index.ts:325-367`）的分桶（both/museOnly/himawariOnly/bothSilent/noHimawariRecord，:333-343）**只读 `muse_reference_entries`**（`museEntries` SQL，:631-635），且带 `muse_at` 时间窗。方案的第 1 条要读 `muse_intake_items`：一条 intake item 存在但 reference entry 还没评（`state` 为 delivered/suppressed，timing/content 为空，见 `migrations/0075_muse_intake.sql:23,43-46`）时，周报把它算作“Muse 没有这个邮件的条目”，详情页若按 intake item 显示“Muse 提醒了”，同一封邮件两边结论相反。
- 另外周报的数字是窗口化的（`muse_at >= start AND muse_at < end`），单邮件页无窗口，同名状态可能和周报里的归属周不一致。
- 建议：比较状态严格按 `summarizeMuse` 的数据源（`muse_reference_entries`，配对键 `paired_message_id`，逻辑复用 `pairEntriesByMail` + `HIMAWARI_ATTENTION_OUTCOMES`）计算；`muse_intake_items` 里“有 item 无评级”的情况单独显示“Muse 有动作、未评级”，不并入 both/museOnly。方案自己的疑虑提到了“多条或没有”，但没提这个同义缺口，应补进第 1 条的定义里。

**4.（中）测试计划没有绑定仓库现有的门槛机制，漏了会被出包流程才拦住**
- 证据：新页是“长期产品页”，按本仓库已落门槛的规则：
  - 走查定位只能写进 `apps/control-center/test/release-walkthrough-ui.ts`（I-08 门槛，`npm run check:release-walkthrough` 每次提交跑，docs/incidents-and-gates.md:47）；
  - `scripts/check-layout-audit.mjs`（`check:layout`）目前只打开固定的页面清单（I-15 记载“10 个页面”，docs/incidents-and-gates.md:54），新页不登记就不受手机/语言排版检查覆盖；
  - `check:locale`（消息表缺项即失败）、`check:glossary`（新文案旧叫法即失败）都会自动管新页，但方案只写“三语”，没写会走哪些检查；
  - 上线前真实浏览器走查必须在 `test/integration/product-path-browser.test.ts` 加场景并登记进 `scripts/delivery-mode/browser-acceptance-gate.py`（I-01 门槛，缺项以退出码 5 拒绝上线）。
- 建议：方案第 4 条把这四个检查逐一点名，作为“改动对应的自动检查”。

**5.（低中）“提醒检查记录行也加入口”没写清是哪一行，其中一行还需要再加一处合约字段**
- 证据：overview 快照里两类行：`audit.items` 每项已有 `messageId`（`contracts-v2.ts:424`），可直接做入口；但提醒页主行 `insights`（:399-418）**没有 messageId 字段**（只有 id/link/subject）。若入口放 insights 行，还得给 overview 合约加字段——又一组产生端/使用端，方案没列。
- 建议：写明入口行；若用 insights 行，把 overview 合约的 messageId 加入第 2 条的同步清单。

**6.（低）新查询的注册点清单不全，漏一处就是“operation not installed”或前端静默降级**
- 证据：`decision.chain.read` 现在分布在：`contracts-v2.ts:64`（查询类型联合）、`:990`（envelope）、`:2152`（schema 表）、`apps/agent-service/src/production-memory-control.ts:50`（安装清单）与 `:498`（分发）、前端可用性判断 `apps/control-center/src/proactive.ts:98-99`、e2e 假服务器 `test/e2e/fixtures/control-center-browser-server.mjs:1219`。`decision.email.read` 每处都要落，方案没列。
- 建议：照抄这份清单并加一条反向用例：从安装清单去掉新操作时，页面必须显示降级态而非报错。

**7.（低）Muse 密封文本的打开与“不留存”显示，方案没写**
- 证据：Muse 标题/正文是密封载荷引用（`muse_intake_items.title_ref/text_ref`，0075 迁移），周报的取法是 `seal.open` + `museTextWithheld` 兜底（`production-gap-cases.ts:64-85`，显示在 `weekly-report.tsx:1147-1151`）。新查询的右下栏要用同一套取法，否则要么取不到文字、要么绕过 `text_withheld`。受限记忆不泄露在链这一侧已由 `decision.chain.read` 的 `visible` 处理（`production-decision-chain.ts:215-219`），方案引用它是对的，但 Muse 一侧的分类处理没写。

**8.（低）缺项场景：`outcome='skipped'` 的邮件**
- 证据：`proactive_processed_messages` 含 skipped 行（skip_reason category/sensitive/own_mail，0069:106-107,113），一样有 `decision_id`；周报案例文案也专门处理了“跳过了这封邮件”（`production-gap-export.ts:38-41`）。详情页要定义 skipped 的显示（跳过+原因），方案只写了“缺项显示无记录”，没覆盖“有记录但被跳过”。

## 推测（未能证实）

- **Gmail 邮件 id 的真实字符集**：官方文档只说 `id` 是 "The immutable ID of the message"（string，未给字符集，https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages）。实践中是 base64url 风格字母数字，且方案正则与 muse intake 写入端一致，风险低；但“将来不会越界”没有一手来源保证，靠问题 1 的写入端校验兜底。
- **旧密封快照缺 messageId 无害**：`isGapCaseSnapshot` 只检查既有字段、导出流程不用 messageId（`production-gap-export.ts:53-70,135-172`），推测无害，建议加一条断言用例确认。

---

## 如果由我来定，我会怎样改这份方案

整体保留方案骨架（不加表不加迁移、复用 `decision.chain.read` 与周报数字、查询参数传编号都对），补五点：

1. **把 `GMAIL_ID_PATTERN` 提为共享常量**，在邮件检查写入 `proactive_processed_messages` 时同样校验，前端查询参数校验（参照 `readLaunchIntent` 的 `LAUNCH_ID`，`proactive.ts:308`——router 本身不校验查询参数）三处同源；反向用例证明三处不一致会失败。
2. **比较状态只按 `muse_reference_entries` 计算**（复用 calibration 的分桶逻辑），intake-only 条目显示“未评级”，不参与 both/museOnly；页面写明单邮件状态与周报窗口化数字的差别。
3. **值清单逐点列出**：gapCases.messageId 的五处同步点、`decision.email.read` 的七处注册点、（若入口在 insights 行）overview 合约新字段的产生/使用两端——每点一个反向用例，绑定 `gateway-v2.contract.test.ts` 的 round-trip 声明。
4. **测试绑定现有门槛**：`check:release-walkthrough`（选择器进 `release-walkthrough-ui.ts`）、`check:layout` 页面清单加新页、`check:locale`、`check:glossary`、发布走查场景进 `browser-acceptance-gate.py`。
5. **补两个场景定义**：skipped 邮件的显示；Muse 密封文本的 `seal.open` + `text_withheld` 取法与周报一致。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？** 不会。本次全部触点（gateway v2 查询/快照、控制中心页面、周报 UI、gapCases 字段）都是面向网页的快照链路（`production-observation.ts`、`production-decision-chain.ts`、contracts-v2），不进入系统提示、工具定义、历史或遮盖；发给模型的内容不受影响，“只追加、每轮变化值在最后一条消息”的规则无从被触碰。周报数据也不喂给模型（导出给 Muse backlog 的 prefill 是另一条 API 路径，且经 `maskForExport` 遮盖，本次不动它）。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不涉及发给模型的请求字节。UI 侧两点要求：新查询返回的 Muse 条目必须固定排序（照 `listItems` 的 `ORDER BY occurred_at DESC, natural_key DESC`，`sqlite-muse-intake-operations.ts:363`），不得依赖数据库返回顺序；`gapCaseId` 哈希逻辑不动。

**3. 有没有对应的自动检查、反向用例会不会真的失败？** 方案列了测试类别但没绑门槛。现有的自动检查里有两道会自然管住合约（`production-observation.ts:297` 的 schema parse、gateway round-trip fixture 测试），其余（走查选择器、layout/locale 页面清单、发布走查必过项）都要主动登记，见证实的问题 4；每个反向用例我都给了可判红的断言点。

**4. 每个新值的两端都核过了吗？** 主要四个值：① `messageId` 查询入参——产生端（邮件检查写库）无校验、使用端正则更严，**不一致，需修**（问题 1）；② `gapCases.messageId` 字段——产生端 `production-gap-cases.ts`、使用端合约 schema + 前端五处，方案只写了“两端”，**清单不全**（问题 2）；③ 比较状态枚举——产生端若含 intake item 就与周报不同义，**需限定数据源**（问题 3）；④ 查询参数的页面路由——`objectId` 限制的说法核实无误（`apps/control-center/src/app/router.ts:27` `MACHINE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`），改用查询参数是稳妥的，但 router 不校验查询参数，前端要自己校验（问题 1/建议 1）。

**未核实**：`scripts/check-layout-audit.mjs` 页面清单的当前具体内容（依据 I-15 记载为 10 页）；真实 Gmail id 是否出现过正则外字符（无一手来源）。
