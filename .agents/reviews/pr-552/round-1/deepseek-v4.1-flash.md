## 复核意见（按严重度）

### 1. 中：读接口没有用“生效规则”过滤已存的 overrides，快照可能把已被忽略的旧值当成当前生效值

- 文件:行：`apps/agent-service/src/production-delivery-timing-control.ts:52-62`；`packages/application/src/services/delivery-timing.ts:58-70`；`packages/persistence-sqlite/src/sqlite-delivery-timing-settings-operations.ts:64-69`
- 问题：holder 应用 overrides 时只接受“安全整数且在范围内”的值，但 `delivery_timing.settings.read` 直接把存储里的 `override` 当作 `value` 返回，并把任何存在的 override 标成 `overridden: true`。一旦数据库里有超出当前范围的旧值（作者自己也说“超出范围的旧值在 applyDeliveryTimingOverrides 里忽略”），读接口显示的“现在生效的值”就会和实际生效的配置不一致；ADR 0273 对 `value` 的定义是“现在生效的值”。
- 证据（读代码证实）：
  - 读接口：`const override = settings.overrides[key]; ... value: override ?? this.#options.defaults[key], ... overridden: override !== undefined`
  - holder 过滤：`if (Number.isSafeInteger(value) && value !== undefined && value >= minimum && value <= maximum) next[key] = value;`
  - 持久层只校验形状：`(input.value !== null && (!Number.isSafeInteger(input.value) || input.value < 0))`，不校验 `DELIVERY_TIMING_RANGES`。
- 建议：读接口复用同一个过滤逻辑（例如用 `applyDeliveryTimingOverrides(defaults, settings.overrides)` 计算 `value`，或抽一个共享的“该 key 的 override 是否生效”函数），`overridden` 也按“实际生效的 override”计算；补一条反向用例：绕过 control，直接向 store 写入超范围值，断言快照返回默认值且 `overridden: false`，同时 holder 也使用默认值。
- 推测：正常通过 `delivery_timing.settings.change` 写入的路径有范围校验，所以今天只有“范围收紧后的旧数据/直接写持久层/手改库”能触发；但作者明确把“忽略旧值”作为设计保证，读接口没有兑现。

### 2. 低：设置改变不会清 `DeliveryTimingJudge` 的已判定缓存，“改后马上生效”对判忙门槛、超时、每分钟次数并不完全成立

- 文件:行：`packages/application/src/services/delivery-timing.ts:241-254`、`250-253`；`apps/agent-service/src/production-delivery-timing.ts:33-35`；`apps/agent-service/src/production-delivery-timing-control.ts:100`
- 问题：`holder.apply` 只替换配置对象，不会清掉 `DeliveryTimingJudge.#remembered`。判定的缓存 key 只包含 `pushClass` 和 facts，不包含配置；命中缓存时直接返回旧判定。因此修改 `busyAtLeastPermille`、`timeoutMs`、`perMinute` 后，已经判过且仍在 `recheckSeconds` 窗口内的同一组事实仍会使用旧结果。作者说“改后马上对运行中的服务生效”，对这些项不准确。
- 证据（读代码证实）：
  - `const key = JSON.stringify([question.pushClass, question.facts.map(({ signal, value }) => [signal, value])]);`
  - `const known = this.#remembered.get(key); if (known) return known.judged;`
  - `busyAtLeastPermille` 等只在 `#reserveAndJudge(question, configuration)` 里使用（缓存未命中时）。
  - `apply` 只做 `this.#current = applyDeliveryTimingOverrides(this.base, overrides);`。
- 建议：在设置变更时让 judge 清空 `#remembered`（例如给 `DeliveryTimingSource`/judge 增加 `invalidate()`，由 `changed` 回调触发）；或者把影响判定的配置并入缓存 key；如果不想改行为，就把 ADR/说法改成“配置立即替换，已判定的结果最多沿用到复查间隔”。补一条测试：同一 facts 先判一次，修改 `busyAtLeastPermille` 后再次判定，断言不返回旧结果。
- 推测：实际延迟上限取决于新 `recheckSeconds`（默认 5 分钟，最大可设 1 小时），用户可能感知为“改了没马上变”。

### 3. 低：代码创建 holder/安装操作的条件比 ADR 和作者说法更窄——还需要 webPush 配置、webPush secret 和 episodeProtector

- 文件:行：`apps/agent-service/src/service-main.ts:2774`、`2845-2856`；`docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:135`
- 问题：ADR 和作者说法都是“只有配置了 `runPolicy.deliveryTiming` 时这两个操作才会装进网关”。实际 `deliveryTimingHolder` 的创建整个位于 `if (webPushConfiguration && webPushSecret && episodeProtector)` 块内；只配置 `deliveryTiming` 而没有 webPush 配置/secret/protector 时不会创建 holder，两个操作也就不会安装。
- 证据（读代码证实）：
  - `if (webPushConfiguration && webPushSecret && episodeProtector) {`
  - 该块内才有 `if (timingModel && timingConfiguration) deliveryTimingHolder = new DeliveryTimingHolder(...)`
  - 后续 `...(deliveryTimingHolder ? { deliveryTimingSettings: deliveryTimingHolder } : {})` 与 `options.deliveryTimingSettings !== undefined` 决定操作是否安装。
- 建议：如果送达时机本来就只服务于 web push，这是合理的，但请把 ADR/说明改成“配置了 `runPolicy.deliveryTiming` 且 web push 可用时”；如果希望只按 `deliveryTiming` 判断，则把 holder 创建和操作安装移到 webPush 条件之外。
- 推测：当前部署若配置了 `deliveryTiming` 但缺 webPush secret，App 看到的操作不可用；是否属于预期未核实。

### 4. 低：作者说“不涉及发给模型的内容”不准确——新鲜度窗口会改变送达时机判断请求里的 facts

- 文件:行：`apps/agent-service/src/production-delivery-timing.ts:90-120`；`packages/platform-node/src/delivery-timing-decision.ts:50-76`
- 问题：这次改动本身没有改系统提示、工具定义、历史或遮盖，也没有新增模型调用；但 `speechFreshSeconds`、`motionFreshSeconds` 等新鲜度窗口决定读取哪些感知记录，进而决定 `ownerStateFacts` 产出哪些 facts。`deliveryTimingRequestBody` 会把这些 facts 放进模型的 `input`。所以“完全不涉及发给模型的内容”不成立。
- 证据（读代码证实）：
  - `const windows = [["speech.utterance", configuration.speechFreshSeconds], ...];`，然后按窗口 `listRecordsBetween`，再 `judge.decide({ pushClass, facts: ownerStateFacts(records, nowMs, configuration) })`。
  - `deliveryTimingRequestBody` 把 `input.facts.map(({ signal, value, secondsAgo }) => ...)` 写进请求。
- 建议：把说法收窄为“不新增模型调用，也不改判断请求的固定指令；但主人的新鲜度设置会改变进入该后台判断请求的事实集合”。这不违反 prompt-prefix 规则（固定指令仍在前面，facts 在后面的可变输入里）。
- 推测：如果 App 设置页把这 11 项都展示为“送达时机参数”，用户可能理解为只影响延后时间；实际上部分项会改变哪些状态被送进模型判断。

## 侧重检查

- 不合规范/不可信输入：`key` 用 `Object.hasOwn` 挡掉 `constructor` 等原型属性（`production-delivery-timing-control.ts:84-86`）；持久层 `KEY_PATTERN` 也挡掉下划线开头的 `__proto__`，SQL 全部参数化，没有注入面。`value` 的非整数/负数最终会被持久层拒绝；普通的“超出范围”写入在 control 层被拒绝。结论：正常写入路径的输入校验成立。
- 错误路径：读取到超范围旧值不会报错，而是被 holder 静默忽略；但读接口没有同步忽略（意见 1）。`revision` 冲突在事务内比较并返回 `PORT_CONFLICT`，不会覆盖新值。读取持久层 JSON 假定是对象；`json_valid` 只能保证是合法 JSON，手工写入 `null` 之类会在 `settings.overrides[key]` 处抛错——只对手工改库/未来异常数据成立，未构成当前正常路径问题。
- 安全：修改要求 `actorType === "owner"` 且 `scope.ownerId/agentId` 与当前租户一致；读取与 `owner.preferences.read` 一样不校验 actor/scope，依赖网关注入的认证和单租户边界。未核实所有入口是否都强制 scope。
- 资源耗尽：快照固定 11 项；写入一次一条 key；范围上限限制了 `perMinute`、`timeoutMs`、最大延后等；没有新增无界循环。把 `perMinute` 调到最大会增加模型调用，但受原有预算 `reserve` 约束。
- 不可撤销操作：设置本身可通过 `value: null` 恢复配置值；把最长延后调小会让已延后的通知更早到期并发出（`#timed` 在到 deadline 时返回 false 继续发送），不是直接丢弃。没有发现新的不可撤销破坏。
- 规则/文档一致性：ADR 和作者说法有两处与代码不完全一致（意见 3、4）；ADR 对 `value` 是“现在生效的值”的定义和读接口实现不一致（意见 1）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会改变对话请求的系统提示、工具定义、历史消息和遮盖结果；没有改 `packages/prompt-catalog`，也没有改会话组装。新增的只是 App 的网关读写操作。唯一会变化的是独立的后台“送达时机判断”请求：它的固定指令不变，但新鲜度窗口会改变 facts 集合，facts 属于该请求后面的可变输入，不是对话开头。所以对话仍然只在末尾追加，每轮变化的值没有进入请求头。
2. **同一段文字会不会在不同请求里变成不同字节？** 没有引入新的不确定性：快照里的 `generatedAt` 只发给 App；存储 JSON 的键顺序不进入模型请求；判断请求里的 `secondsAgo` 是原有的每轮变化值，且位于固定指令之后。修改设置会确定性地改变 facts（取决于当前配置），但相同配置、相同感知数据下字节是确定的，不属于同内容随机变字节。
3. **有没有自动检查，反向用例真的会失败吗？** 有：单元测试覆盖 holder 应用/忽略越界值，集成测试覆盖范围、未知 key、`constructor`、旧 revision、非主人，合约 fixture 和 Swift 能力表也更新了。反向用例是有效的：去掉 range 检查会让 `recheckSeconds: 5` 写入成功并让断言失败；去掉 `Object.hasOwn` 会让 `constructor` 通过并失败；去掉 revision/owner 检查也会让相应断言失败。但**没有**反向用例覆盖“读接口过滤已存越界旧值”和“设置变化后清 judge 缓存”，因此意见 1、2 不会被现有检查抓到。
4. **每个产生/修改的值，两端都能接受吗？** 读代码核实了：11 个 key（camelCase）都能通过 `machineString`；所有 default/minimum/maximum/value 都是非负安全整数，能通过 `integer(0)`；`generatedAt` 来自 `now().toISOString()`，符合 `timestamp`；新表名/迁移/schema catalog、`deliveryTimingSettings.*` 持久层前缀、操作名、合约消息类型、客户端能力表和 `ci/operations-pending.json` 都互相对得上；`DELIVERY_TIMING_KEYS`、`DELIVERY_TIMING_DEFAULTS`、`DELIVERY_TIMING_RANGES` 三者的 key 一致。唯一不一致的是读接口对已存 override 的校验比 holder 宽松（意见 1），以及 holder 安装条件与文档不一致（意见 3）。
