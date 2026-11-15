## 结论与范围

这一轮的 `git diff df48c..a60c` 是一次把 `main` 合并进来的合并提交，不是 PR 566 送达时机功能的增量：送达时机的 `delivery-timing-copy.ts`、`production-delivery-timing-control.ts` 和合同改动在 `df48c` 里就已经存在，本轮增量实际带入的是 PR 565 的“想一想”设置三语文案，以及 PR 512 的手表代码/脚本。我核对了 PR 566 的代码是否与作者说法一致，也逐行看了增量里真正改变行为的部分（`production-think-settings.ts`、`configuration.ts`、合同与测试）。没有发现高严重度错误；下面按严重度列出低/中的问题。

### 1. 中：`ProductionDeliveryTimingControl` 自身不校验 locale，非法或缺失值会以 TypeError 崩溃

文件：`apps/agent-service/src/production-delivery-timing-control.ts:49-64`、`test/integration/production-delivery-timing-control.test.ts:158-166`

问题：控制层直接解构 `query.payload.locale`，再用它索引文案表，随后访问 `copy.label`。合同只在网关边界校验（`packages/platform-node/src/http-gateway-server.ts:398` 和 `apps/agent-service/src/in-process-gateway.ts:35` 都使用 `gatewayV2MessageSchema`），控制层本身没有防御。任何绕过网关的直接调用传入 `{}` 或 `fr` 时，`copy` 为 `undefined`，会抛出 `Cannot read properties of undefined`，而不是一个可识别的合同错误；而且崩溃前已经读过一次数据库。现有反向测试只证明 schema 会拒绝，没有调用控制层。

读代码证实的：控制层确实没有 locale 守卫；HTTP 和进程内 transport 确实会先做合同校验。
推测的：当前没有生产路径绕过网关，所以不是现网故障；但控制类是可复用的导出类，未来内部组合或测试风格直接调用时会踩到。

建议：在控制层用 `Object.hasOwn(DELIVERY_TIMING_COPY, key)` 之外，再对 `locale` 做 `locale === "zh-CN" || locale === "en" || locale === "ja"` 判断，非法时抛 `ApplicationPortError(INVALID_OPERATION, "DELIVERY_TIMING_SETTINGS_LOCALE_INVALID")`；把反向用例改成同时断言控制层拒绝。

### 2. 低：三语快照的 en/ja 没有逐条通过合同 schema，超长或含控制字符的新文案不会被自动检查发现

文件：`test/integration/production-delivery-timing-control.test.ts:135-156`、`packages/gateway-contracts/src/contracts-v2.ts:566-568`

问题：`read()` 只对 zh-CN 的快照调用 `gatewayV2MessageSchema.parse`（第 96-100 行）；“三种语言”循环只检查 `label.description.unit` 非空，没有对 en/ja 快照做合同校验。当前文案我都逐条看过，均在 `label<=80`、`description<=240`、`unit<=16` 以内，所以不是现网失败；但这是自动检查的缺口：将来某个 en/ja 文案超长或含控制字符时，测试仍会绿，真实响应却不符合合同。

读代码证实的：合同界限在 `contracts-v2.ts:566-568`；所有当前字符串都低于界限。
推测的：如果客户端或网关将来对响应做严格 schema 校验，这个缺口才会变成运行时失败。

建议：在三种语言的循环里也对每个 `snapshot` 调用 `gatewayV2MessageSchema.parse`，并逐键比对三种语言的文案，而不只是检查非空和 `recheckSeconds` 一个 label。

### 3. 低：ADR 0273 的响应字段主列表没有同步新增的 label/description/unit

文件：`docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:132` 与 `:136`

问题：第 132 行仍只列出 `key`、`value`、`defaultValue`、`minimum`、`maximum`、`overridden`；第 136 行才补充查询带 `locale`、每项带 `label`/`description`/`unit`。合同已经把这些字段设为必填（`contracts-v2.ts:566-568`），实现响应里也有；只看第一段字段列表的客户端实现者可能漏掉新字段。

读代码证实的：合同和控制层都要求并返回三个新字段。
建议：把第 132 行的字段列表一起补上三项，或删掉重复列表，只保留一处。

### 4. 低：`watch-ui-review.sh` 的 `--out` 未校验，会删除任意目标目录的所有 PNG，且新建模拟器不清理

文件：`clients/apple/scripts/watch-ui-review.sh:18`、`:45`、`:62`

问题：`--out` 直接接受任意路径，随后 `rm -f "$out"/*.png`。默认目录是生成目录，但误用 `--out .` 或源码目录会不可逆删除其中的 PNG。脚本在找不到模拟器时会 `simctl create` 新建，但退出时只 `shutdown`，不 `delete`，反复运行会堆积模拟器。

读代码证实的：上述三行代码。
建议：限制 `--out` 只能位于 `ui-review/` 下，或只删除本次 scene 对应的文件；记录模拟器是否由脚本新建，并在 `EXIT` 时 `simctl delete`。

注：该脚本来自合并进来的 PR 512，不属于 PR 566 的送达时机功能。

## 侧重检查

- 非法/缺失 locale：合同用 `enumeration(["zh-CN","en","ja"])` 和 `object` 必填校验（`contracts-v2.ts:558`），HTTP 与 in-process transport 都会先 parse；控制层没有自己的守卫（见意见 1）。三种值与客户端现有 `AnswerLocale` 的 `zh-CN/en/ja` 一致。
- 不可信输入/安全：新增文案都是模块级静态字符串，没有拼接用户输入，不进入模型提示词，也没有新增日志或密钥。文案表键是编译期约束，当前没有缺失。
- 资源耗尽：文案表是固定常量，没有按请求增长的结构。手表脚本的模拟器泄漏是唯一的资源问题（见意见 4）。
- 不可撤销操作：PR 566 没有删除/写操作；增量的手表脚本有 `rm`（见意见 4）。
- 规则与文档一致性：作者关于文件位置的三条说法都属实；`THINK_SETTING_TEXT`/`THINK_SETTING_UNIT_TEXT` 与架构文档描述一致；ADR 0273 字段列表有遗漏（见意见 3）。
- 未核实/未覆盖：本轮没有重新审计 PR 512 的整个手表 App（配对、密钥、提醒计划等），只看了增量中直接相关的 `MenuBarFeed.swift`、`watch-ui-review.sh` 和设计令牌；若需要按安全侧重审计手表配对与凭据路径，应另开一轮。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。PR 566 改的是 `delivery_timing.settings.read` 的客户端快照，增量改的是 `think.settings.read` 的客户端快照和手表 UI；这些字段没有进入系统提示、工具定义、历史消息或遮盖结果。送达时机文案明确不是提示词。发给模型的内容仍然只在末尾追加——本次改动不涉及模型上下文组装。

2. **同一段文字会不会在不同请求里变成不同字节？** 新增的送达时机文案和“想一想”文案都是静态常量：送达时机按 `locale` 选固定字符串，项目顺序由 `DELIVERY_TIMING_KEYS` 固定；“想一想”返回固定的 `zh-CN/en/ja` 三个键，项目顺序由 `THINK_SETTING_DEFINITIONS` 固定。相同的 locale/相同设置值下字节一致。快照里的 `revision`、`generatedAt` 会变，但这两个字段是旧代码已有的客户端响应字段，不是文案，也不是模型输入；本次没有引入依赖前后文的遮盖或无序集合。

3. **有没有自动检查，反向用例真的会失败吗？** PR 566 有“全部键 × 三种语言”的集成测试，以及非法 `fr`、缺失 locale 的反向测试；我核对了 `validation.ts` 的 `enumeration` 和 `object`，这两条反向输入确实会抛错，且 HTTP/in-process 路径确实使用这个 schema，所以“合同拒绝”成立。但反向测试只测 schema，不测控制层（意见 1）；en/ja 快照也没有逐条过 schema（意见 2）。增量的“想一想”测试把真实快照喂给 `gatewayV2MessageSchema` 并断言三个语言键，但没有专门的“缺一种语言”反向快照用例；不过 `object` 的必填行为会拒绝缺失字段。

4. **每个值两端都能接受吗？**
   - `locale`：生产者是客户端设置页（尚未实现）；消费端先是合同 `enumeration`，再是控制层索引。合同接受三种值，控制层在合同之后只接受同样三种；控制层自身缺守卫（意见 1）。
   - 送达时机 `label/description/unit`：生产者是 `ProductionDeliveryTimingControl`；消费端合同要求 `label<=80`、`description<=240`、`unit<=16`。当前所有值都低于界限；客户端设置页尚未实现，未发现其他消费端。
   - `times` 单位：生产者是 `THINK_SETTING_DEFINITIONS`；消费端合同 `unit: machineString` 接受它，`THINK_SETTING_UNIT_TEXT` 也有 `times` 项，集成测试和 fixture 已同步；没有其他生产消费端。
   - “想一想” `label/description/unitLabel`：生产者是 `ProductionThinkSettings.#views`；消费端合同要求每个语言字段为 1-400 字符（`contracts-v2.ts:881-902`），当前文案都在范围内；客户端尚未实现，未发现其他消费端。
   - 增量测试里的 `schemaVersion: "gateway.v2"`、`authority` 等：只出现在测试构造中，合同接受；不是生产值。
   - 手表相关的 `binding`、`locale` 等值不属于本轮 PR 566 的范围，我未把整个手表 App 作为本轮两端核对对象。
