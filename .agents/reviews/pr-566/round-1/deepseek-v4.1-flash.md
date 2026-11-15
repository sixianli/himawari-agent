**读代码证实的结论**：这个改动只影响网关 `delivery_timing.settings.read` 的响应，没有进入模型请求路径；文案表只被 `production-delivery-timing-control.ts` 引用。主要问题在测试覆盖，不在当前运行逻辑。

### 1. [中] en/ja 的 snapshot 没有经过合同校验，文案表与合同上限之间没有自动防线
文件：`test/integration/production-delivery-timing-control.test.ts:139-143`、`packages/gateway-contracts/src/contracts-v2.ts:566-568`

问题（读代码证实）：`read()` helper 只对 zh-CN 的 snapshot 做了 `gatewayV2MessageSchema.parse(snapshot)`（test:100），而三语测试循环里对 en/ja 只检查了 `snapshot.type`，没有把响应交给合同校验。合同对新增字段有 `bound(80/240/16)`，若某条翻译以后超过上限或带控制字符，测试仍会通过，服务会生成自己合同拒绝的 snapshot。这和 I-73“清单里的 id 能通过后端校验吗”是同一类问题：产出方和消费方的校验没有在测试里对齐。

证据：
```ts
// test:139-143
const snapshot = await device().query(
  message("query", "delivery_timing.settings.read", { locale }) as GatewayV2Query,
);
if (snapshot.type !== "delivery_timing.settings.snapshot") throw new Error("unexpected");
expect(snapshot.payload.items).toHaveLength(Object.keys(DELIVERY_TIMING_DEFAULTS).length);
```
```ts
// contracts-v2.ts:566-568
label: boundedString(80),
description: boundedString(240),
unit: boundedString(16),
```

建议：在 locale 循环里对每个 snapshot 调用 `gatewayV2MessageSchema.parse(snapshot)`；或增加直接遍历 `DELIVERY_TIMING_COPY` 的单元测试，按合同 bounds 校验全部 36 条文案。

### 2. [低] “语言跟随请求”只验证了一个设置项，其余键即使复制中文也会通过
文件：`test/integration/production-delivery-timing-control.test.ts:144-155`

问题（读代码证实）：循环对每条只检查 `label`、`description`、`unit` 非空；`texts.add(`${locale}:${entry.key}:${entry.label}`)` 包含 locale 前缀，所以即使 en/ja 的 label 直接复制中文，集合大小仍然是 `3 * 12`。只有 `recheckSeconds` 一个键的 label 被逐语言断言。

证据：
```ts
texts.add(`${locale}:${entry.key}:${entry.label}`);
...
expect(recheck?.label).toBe(
  { "zh-CN": "复查间隔", en: "Recheck interval", ja: "再確認の間隔" }[locale],
);
...
expect(texts.size).toBe(3 * Object.keys(DELIVERY_TIMING_DEFAULTS).length);
```

建议：对每个 key 断言三语 label 两两不同，或对完整文案表做期望值表；`description`/`unit` 也按 key 检查目标语言，而不是只检查非空。

### 3. [低] 控制层直接用 locale 索引文案表，绕开合同时会抛 TypeError
文件：`apps/agent-service/src/production-delivery-timing-control.ts:49,59`

问题（代码已证实；影响为推测）：`const copy = DELIVERY_TIMING_COPY[key][locale]` 没有运行时兜底。当前生产入口都先过合同（`http-gateway-server.ts:398`、`in-process-gateway.ts:35`），所以不是现存漏洞；但该类是导出的，集成测试也直接调用它，未来若有内部调用方绕过合同，非法 locale 会让 `copy` 为 `undefined`，随后 `copy.label` 抛 TypeError，变成非合同错误。与 `production-home.ts:867` 直接信任 `locale` 的现有模式一致，不是本次引入的独有问题。

证据：
```ts
// production-delivery-timing-control.ts:49,59
const { locale } = query.payload;
...
const copy = DELIVERY_TIMING_COPY[key][locale];
```

建议：加 `if (!copy) throw new ApplicationPortError(INVALID_OPERATION, ...)`，或至少补一条直接调用控制层的反向测试，明确这类输入不该到达控制层。

**侧重检查**

- 非法或缺失 locale：合同用 `enumeration(["zh-CN","en","ja"])` 且 `object` 要求字段必填，会拒绝；反向测试确实会失败。生产 HTTP 与 in-process 入口都在调用控制层前 parse 合同。
- 直接调用/绕过合同：控制层自身不校验 locale，见意见 3。
- 超长文案、控制字符：`boundedString` 会拒绝，但当前没有自动检查 en/ja 文案与合同上限，见意见 1。
- 资源耗尽、不可逆操作：本次只增加只读查询的静态文案，没有新增写入、外部调用或可撤销/不可撤销动作；locale 只用于选择静态常量，不拼接进输出。
- 安全：文案是服务端常量，不含秘密；没有把请求中的任意字符串反射回响应。
- 规则/文档一致：该改动与 `prompt-prefix.md` 无关；ADR 0273 第 136 行补了 locale/label/description/unit 说明，但第 132 行旧的字段列表仍未列新字段，靠下一条补充，读起来略有重复但不改变语义。
- 未核实：我没有运行测试，也没有找到实际客户端消费者（设置页尚未实现）。

**必答问题**

1. **不会改变模型已经见过的请求开头。** 依据：`DELIVERY_TIMING_COPY` 只被 `production-delivery-timing-control.ts:18` 引入，该控制只服务 `delivery_timing.settings.read` 网关查询（`production-approval-gateway.ts:187-188`），没有进入系统提示、工具定义、历史或遮盖路径。新增值全部在网关 snapshot 的 `payload.items`（control:60-70），没有向模型请求的最后一条消息增加任何每轮变化的值。发给模型的内容仍然只在末尾追加，本次改动不涉及它。

2. **不会让模型上下文里的同一段文字变成不同字节。** 文案是编译期静态常量，同一 locale 每次返回相同字节；不同 locale 是客户端明确传入的参数，不依赖前后文。snapshot 里原有的 `generatedAt`（control:73）本来就会变，但它不在模型请求中；新增字段没有依赖遮盖、时间或无序集合。`items` 顺序来自 `DELIVERY_TIMING_KEYS`，顺序固定。

3. **有自动检查，但不完整。** 合同层反向用例 `test:158-167` 对 `locale: "fr"` 和缺失 locale 确实会失败；`message()` 内部先 parse，断言仍能捕获合同放宽。正向有三语非空检查，但只有 zh-CN 的 snapshot 经过合同 parse，只有 `recheckSeconds` 的 label 做了逐语言断言；缺少“snapshot 缺新字段/字段超长”的反向用例。未运行测试。

4. **逐个核对两端：** `locale` 由客户端请求产生，消费于合同枚举和控制层索引；仓库内原有调用点只有 fixture 和集成测试，均已补 locale，没有残留发 `{}` 的调用方。`label`/`description`/`unit` 由文案表产生，消费于 snapshot 合同的 `boundedString(80/240/16)`；当前 36 条值都在范围内，但缺少自动核对（见意见 1）。`key` 仍是 `machineString`，12 个 camelCase 键都合法，fixture 已更新。Apple 的生成文件只有 operation/kind/tier，不编码 payload，因此不需要改。客户端设置页还没实现（`ci/operations-pending.json` 自述缺调用方），所以端到端消费者未核实。
