---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0264-a-decision-model-decides-whether-a-name-call-is-meant-for-himawari.md"
date: "2026-11-15"
---

# ADR 0273：主人在忙时，由判断模型 Jev 决定先不推送

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-words)
- [前提](#premises)
- [决定](#decision)
- [评测结果](#evaluation)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果和这一版没做的](#consequences)
- [追加（2026-11-15）：各项数值可在 App 里改](#settings)
- [关联文档](#references)

<a id="context"></a>

## 背景

发送闸门（[PR 414](0244-hard-rules-step4-unified-push-gate.md)）让主人自己定的“不推送时段”规则判断一次发还是延后；主人正在看 Himawari 时不弹推送。本 PR 加上第三道：按主人此刻的状态判断要不要延后（`production-web-push.ts` 的 `#timed`）。

设计里早就有这一块（[苹果设备身体设计](../execution/specs/2026-11-11-apple-device-body-design.md#10-送达时机)的“10. 送达时机”）：按“主人此刻的状态”把不紧急的推送延后到状态结束或最晚送达时间。本 ADR 定第一版怎么做，并修订 [ADR 0264](0264-a-decision-model-decides-whether-a-name-call-is-meant-for-himawari.md) 把 Jev 用于真实个人数据的范围：除了“这句话是不是在叫我”，再加“现在打扰主人合不合适”。

<a id="owner-words"></a>

## Andy 的原话

2026-11-13 16:07（日本时间）：

> 其实你记住一点：任何“是还是不是”的判断，都可以交给 JEV 这个模型，懂了吗？

2026-11-15 00:37（日本时间），项目聊天，回答线程提的“送达时机接 Jev”：

> 推送送达时机接 JEV这条我同意

评测和生产共用同一把 key：2026-11-13 16:08“就和生产共用，没事哈”（见 ADR 0264）。

<a id="premises"></a>

## 前提

1. 设计里的判断顺序：紧急的立刻送；不紧急的在主人忙时延后到状态结束或最晚送达时间，先到哪个算哪个；状态不知道就按现有时段规则办；正在看 Himawari 就不弹推送。来源：`docs/execution/specs/2026-11-11-apple-device-body-design.md` “10. 送达时机”，原话：“状态是‘不知道’：按现有时段规则办，不额外延后。”
2. 发送闸门对审批、缪斯故障和未知类别不延后；这几类在本 ADR 里同样不判断。来源：`packages/application/src/services/web-push-gate.ts` 里的 `PUSH_RULE_PROTECTED_CLASSES`，含 `approval`、`muse_outage`、`proposal`、`unknown`。
3. 决策记录已有类别 `delivery_timing`，结果只有 `delivered`、`deferred`、`deadline_reached`、`shown_in_app`。来源：`packages/application/src/ports/decision-ledger.ts` 的 `DECISION_OUTCOMES.delivery_timing`。
4. 决策记录表只允许 `memory_candidate` 这一类带“把握”（`confidence_permille`）。来源：`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql` 第 41-44 行：“kind = 'memory_candidate' OR (category IS NULL AND confidence_permille IS NULL AND inferred IS NULL)”。要记这个就得改表，本版不改。
5. 感知记录里已有 `speech.utterance`、`motion.activity`、`health.sample`、`context.focus`、`context.connectivity` 这五种，字段由写入处校验。来源：`packages/application/src/ports/perception.ts` 的 `PERCEPTION_RECORD_TYPES`。日历事件的设备镜像类型（`DEVICE_MIRROR_KINDS.calendar_event`）已定义，但这一版不读它。
6. 发往外部服务前必须遮敏感值并在 `scripts/check-egress-redaction.mjs` 登记。来源：ADR 0264 前提第 4 条。
7. Jev 经 Vercel AI Gateway 调用，是非题回答“是”的概率，带 `zeroDataRetention: true`。来源：ADR 0264 前提第 5、6 条（<https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions>）。
8. 模型费用算进感知每日模型费用上限：`packages/platform-node/src/perception-service.ts` 的 `reserveModelCost`。来源：ADR 0264 前提第 3 条。

<a id="decision"></a>

## 决定

1. **哪几类推送会被判断：**提醒（`scheduled_reminder`）、任务结果（`run_result`）、邮件提醒（`mail_reminder`）。审批、缪斯故障、提议通知和未知类别不判断、不延后。正在看 Himawari 时不判断（本来就不推）。
2. **主人此刻的状态，只用结构化的事实：**
   - 说话：最近 2 分钟内有带说话人的 `speech.utterance`；值是“主人和别人”或“只有主人”。
   - 移动：最近 5 分钟内最新的 `motion.activity`（静止、走路、跑步、骑车、开车）。
   - 睡觉：最近 30 分钟内最新的睡眠 `health.sample`；样本没结束算“睡着”，结束了算“醒着”。
   - 专注模式：最近 10 分钟内最新的 `context.focus`（开或关）。
   - 车载连接：最近 5 分钟内最新的 `context.connectivity` 的 CarPlay 字段。
   超过新鲜时间的一律不算，每种只取最新的一条。五种窗口都写在 `runPolicy.deliveryTiming`，可改。没有任何新鲜事实时，不调用模型，按原有规则送（前提 1）。
3. **问 Jev 一次是非题：**输入只有推送类别和这些事实（信号名、值、几秒前），不带任何文字内容、提醒原文、对话标题或位置。问题固定在提示词目录 `push.delivery-timing-question`：现在打扰主人是不是不合适。回答“是”的概率不低于门槛（默认 0.7）就延后。值经 `redactForExternalText` 遮一遍并在出口登记表里登记；每次请求带 `zeroDataRetention: true`。
4. **延后到什么时候：**每次延后 5 分钟（`recheckSeconds`），到点再看一次。最晚送达时间从通知入队算起：提醒 10 分钟，任务结果和邮件提醒 2 小时（可配置）。到了最晚时间，不再问模型，直接送，并记一条 `deadline_reached`。延后后通知的有效期顺延，但总寿命仍不超过 48 小时，和发送闸门的规则一样。
5. **判断不出来就送：**模型超时、出错、回答越界、费用预算用完、每分钟超过 30 次，都按“不延后”处理，并记一条发送闸门失败的诊断；这条判断不会让推送丢掉。
6. **同样的情况只问一次：**同一类推送加同样的事实（不看“几秒前”），5 分钟内只问一次，失败和预算不足的结果不缓存。结果只在内存里，不写数据库。
7. **决策记录（`delivery_timing`）：**延后写 `deferred`，原因码 `timing_busy_` 加触发的信号（例如 `timing_busy_motion+focus`）；模型判“可以送”写 `delivered`，原因码 `timing_clear`；到了最晚时间写 `deadline_reached`，原因码 `timing_deadline`。没有新鲜事实而照常送的，不写记录。决策记录表不允许这一类带把握，所以不记模型的概率（前提 4）。
8. **延后是单独的一种：**通知在待发表里的 `defer_rule_refs` 写 `["delivery_timing"]`，和规则延后区分；新增存储操作 `recordDeliveryTiming`，延后和记录在同一个事务里。不改表，不要迁移。
9. **费用：**每次问之前按请求大小预留费用，算进感知每日模型费用上限；预留不到就不问，按第 5 条送。
10. **全部可配置，没配置就什么都不变：**`runPolicy.deliveryTiming` 写模型名、key 引用、单价和各项数值；没有这一项时服务器不调用任何模型，推送行为和现在完全一样。

<a id="evaluation"></a>

## 评测结果

评测脚本 `scripts/evals/delivery-timing-live.eval.ts` 用生产同一个类 `DeliveryTimingDecision` 问真的 Jev。数据集 `test/fixtures/delivery-timing-eval/dataset.json` 共 40 条：20 条主人在忙（开车、骑车、跑步、车载连接、睡着、专注、和人说话及组合），20 条不忙（静止、走路、醒着、一个人、专注关、没连车及组合），每条问 2 遍，共 80 次，0 次出错，中位约 0.2 秒，最终问法这一版约 0.003 美元（`result.json` 的 `estimatedUsd`）。结果：`evals/delivery-timing/result.json`。

- 第一版问法的结果记在 `evals/delivery-timing/first-prompt-result.json`：门槛 0.7 下，忙的 40 次里判出 29 次，不忙的 40 次里误延后 0 次；漏掉的是只有车载连接、骑车、跑步、只有睡着这几类（概率 0.21 到 0.63）。
- 现用问法（把开车、骑车、跑步、连着车、睡着、和人说话、专注模式逐项写明，也写明静止、走路、醒着、一个人、没开专注不算忙）：门槛 0.7 下，忙的 40 次全部判出（最低 0.94），不忙的 40 次误延后 0 次（最高 0.53）。结果：`evals/delivery-timing/result.json`。
- 局限：数据集只有 40 条、是自己写的，问法也是照这批类别调的，所以现用问法的好成绩有偏高的可能；真实使用里的信号组合会更杂。费用上线后按决策记录里 `delivery_timing` 的条数和感知每日模型费用核对。

<a id="industry"></a>

## 业界怎么做

- iOS 的通知有四档打断级别：被动（不亮屏、不响）、主动（默认）、时效性（可以穿透专注模式和通知摘要）、关键。专注模式由用户自己定义，系统按它过滤；时效性通知才能穿透。来源：<https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel>。
- 系统的专注模式能挡掉我们这一层想挡的一部分，但它只认用户开着的模式，看不见“正在开车、睡着、在说话”这些没手动设置的状态，也不是 Himawari 的服务器能读到的东西。所以这一层读设备上报的感知记录，补系统看不见的那部分。审批照旧用“时效性”级别，不判断。
- 我们没有自己的训练数据，所以用现成的判断模型 Jev 代替专门训练的分类器；它回答概率，门槛可调，拿不准（中间值）时按“不延后”处理。

<a id="options"></a>

## 放弃的做法

- **写规则：**开车就延后、睡着就延后。违反 [ADR 0249](0249-the-model-judges-meaning-where-word-lists-guessed-it.md)（意思交给模型，不写词表）；而且组合起来（专注模式开着但在和朋友说话、车载连接断了但还在移动）规则会越写越多。
- **用对话模型（DeepSeek、GLM）判断：**要写提示让它输出 JSON，再解析，延迟约 1 秒，比 Jev 贵（ADR 0264 同样的理由）。
- **把模型的概率写进决策记录：**要改表（前提 4），本版先不做；原因码里只记触发的信号。
- **每次都问，不缓存：**同一时间多条通知会重复问同样的问题，费用和延迟都没必要。

<a id="consequences"></a>

## 后果和这一版没做的

- 主人在忙时，非紧急推送最多晚 10 分钟（提醒）或 2 小时（任务结果、邮件）；不忙时没有任何延迟（没有新鲜事实时不问模型）。
- 主人的移动、睡眠、专注、说话状态的结构化摘要会经 Vercel 发给 TypeSafe（不含文字、位置）。零保留由 Vercel 的合同保证，Himawari 只能在请求里要求，无法自己核实。ADR 0103 的红线在这一处再放开一格，Andy 已同意（见上面的原话）。
- **没做的：**
  1. 日历（“在日程中”）：这一版不读日历事件的设备镜像，等日历接入。
  2. “紧急的立刻送”：设计里写的是“现有规则判定的高优先级”，首页的紧急度打分见 [ADR 0255](0255-model-scores-urgency-of-home-items.md)，这一版两者都没接；这一版用“最晚送达时间”限制延后，没接打分。一条本来紧急的提醒（例如 9:00 提醒 9:15 的会）最多晚 10 分钟，这一点要等接了紧急度再改。
  3. 决策记录里不记模型的概率和各信号多新；`shown_in_app` 这个结果没有写入处。
  4. “一件事只在一处响”（Mac、iPhone 选一处）依赖这一版和 Mac 那批，另做。
  5. 手机上的真实表现（主人开车时是不是真的延后了、延后后送达是否自然）没有真机验证，等付费开发者账号开通后在 iPhone 上看。

<a id="settings"></a>

## 追加（2026-11-15）：各项数值可在 App 里改

项目规则不许写死。第一版里复查间隔、最长扣多久、各类状态多新算新、判忙的门槛、每分钟次数这 11 项（后来加了第 12 项 `macPresenceSeconds`）只能改服务器配置文件，主人在 App 里看不到也改不了。

追加的做法：服务器新增两个网关操作，沿用主人设置同样的“版本号 + 旧设备不能覆盖新值”规则（[ADR 0122](0122-every-owner-setting-on-the-server-with-revision.md)）。

- 查询 `delivery_timing.settings.read`，返回 `delivery_timing.settings.snapshot`：每一项的 `key`、`value`（现在生效的值；已存的值超出现行范围时服务会忽略它，这里显示配置文件里的值，`overridden` 为否）、`defaultValue`（配置文件里的值）、`minimum`、`maximum`、`overridden`（是否被主人改过），以及整体 `revision`。
- 命令 `delivery_timing.settings.change`，字段 `expectedRevision`、`key`、`value`；`value` 为 `null` 表示恢复成配置文件里的值。值超出范围或 `key` 不认识，整条拒绝；版本号不是最新的，整条拒绝。只有主人能改。
- 主人改过的值存在新表 `delivery_timing_settings`（一个账号一行，JSON 加版本号），改后马上对运行中的服务生效，不用重启（配置立即替换；已经判过的同一组事实，判断结果最多沿用到复查间隔，所以判忙门槛、超时、每分钟次数的新值对这类已判过的事实要等到复查间隔过后才起作用）。
- 只有配置文件里配了 `runPolicy.deliveryTiming`（送达时机已启用）、并且网页推送（`runPolicy.webPush`、它的密钥和 episode 保护）可用时，这两个操作才会装进网关。
- 设置页的界面由客户端第 11 批做。

## 追加（2026-11-15）：一处只响，服务器部分

起因：Mac 和 iPhone 都装了的时候，同一条提醒会两处同时响。这里记服务器这一半，客户端那一半由 Mac 和 iPhone 的客户端批次做（方案见 `/mnt/project-files/plans/push-followup-proposal.md` 第 2 节）。

- 判断谁来响：一条通知放行后（已过推送规则和送达时机），如果有一台 Mac 同时满足“有一条打开着的事件流”和“最近 `macPresenceSeconds` 秒内有过键鼠输入”，就只发给这台 Mac，不再发给 iPhone 和网页；否则照旧发给 iPhone。`macPresenceSeconds` 是送达时机设置的第 12 项，默认 300 秒，范围 30 到 3600 秒，和另外 11 项一样能在 App 里改（没配 `runPolicy.deliveryTiming` 时用默认值）。
- Mac 报在场：`POST /api/device/v1/presence`，请求体只有 `lastInputAt`（毫秒精度的 ISO 时间）；只有 Mac 能调（其他设备得到 404）；服务器把它夹在服务器当前时间以内，防止设备时钟偏快；返回 `{ok, serverTime}`。
- Mac 收通知：Mac 的事件流里多两种事件 `notification.deliver`（带 `id`、`kind`、`title`、`body`、`homeKey`、`createdAt`）和 `notification.withdraw`（带 `id`）。这两种事件不带 `id:` 行，因为客户端把 `id:` 当作断点续传的游标。Mac 上打开事件流不再算“应用正在屏幕上”，否则一开着 Mac 就把 iPhone 的推送压住了。
- 撤回：一条事项已经办结（提醒被划掉或完成、审批已处理）时，服务器给收过它的 Mac 发 `notification.withdraw`。
- iPhone 对账：`POST /api/device/v1/notifications/settled`，请求体 `{ids}`（最多 200 个，每个只含字母、数字、下划线、连字符，最长 64），返回 `{settledIds}`；只返回服务器确认已办结的，认不得的或还有效的不返回，iPhone 据此撤掉已经没用的通知。iPhone 的推送载荷顶层带 `notificationId`，值就是上面的 `id`。
- 通知 `id` 就是推送的 tag（对来源键做哈希），三处用同一个值。

没做：Mac 在场信号在服务重启后清空（进程内存），Mac 下一次上报前通知会退回 iPhone；这是故意的，宁可多响一处也不漏。

<a id="references"></a>

## 关联文档

- [SOURCE: docs/adr/0264-a-decision-model-decides-whether-a-name-call-is-meant-for-himawari.md]
- [SOURCE: docs/adr/0244-hard-rules-step4-unified-push-gate.md]
- [SOURCE: docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md]
- [SOURCE: docs/adr/0255-model-scores-urgency-of-home-items.md]
- [SOURCE: docs/execution/specs/2026-11-11-apple-device-body-design.md]
- [SOURCE: docs/product-vision.md]
- 方案（不在仓库里）：`/mnt/project-files/plans/push-followup-proposal.md`
