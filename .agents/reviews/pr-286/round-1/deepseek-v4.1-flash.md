## 结论

改动方向成立：产品源码未改，夹具补上 `egress`、假模型服务器改成“先收齐字节再解码”、请求过滤器排除后台调用，三处都能在代码里对上。未发现会改写对话请求开头或引入新的字节不确定性的改动。但“CI 上稳定通过”这一条我无法在本地环境复现验证；另外新测试的“反向用例”没有真正锁住被改的服务器代码路径。

## 发现（按严重度）

### 1. 中：新测试没有真正覆盖被改的服务器处理器，旧写法回退时新测试仍会通过

- 文件：`test/integration/request-body-decoding.test.ts:20-26`，`test/integration/production-http-composition-process.test.ts:234-237`
- 问题：反向用例没有调用实际被修改的 `listenProvider` 处理器，而是手写了一遍旧逻辑。若有人把服务器处理器改回 `body += chunk`，这个新测试仍然全绿；只有端到端用例在“汉字恰好跨 TCP/TLS 块边界”时才会失败，而这依赖运行环境。
- 证据：

```ts
// request-body-decoding.test.ts:21-25
const [head, tail] = splitInsideCharacter(SENTENCE, "次");
let body = "";
for await (const chunk of Readable.from([head, tail])) body += chunk;
expect(body).toContain("�");
expect(body).not.toBe(SENTENCE);
```

```ts
// production-http-composition-process.test.ts:234-237
if (requestPath === "/v1/chat/completions") {
  void readRequestBody(request).then((body) => {
    const input = JSON.parse(body);
```

- 建议：把假 Provider 的 HTTP 处理器抽成可复用夹具，让新测试真正启动该处理器并用保证分段的方式发送请求；或者给处理器注入读取函数，分别用新旧读取实现跑同一组用例。这样反向用例才会在实现回退时直接变红。

### 2. 低：两个处理器改成 Promise 后没有拒绝处理，坏请求会变成未处理 rejection，客户端无响应

- 文件：`test/integration/production-http-composition-process.test.ts:207-230`、`234-292`
- 问题：`readRequestBody(...).then(...)` 没有 `.catch`。`JSON.parse` 失败或流读取失败时，Promise 变成未处理 rejection，`response` 永远不会结束，客户端只能等到超时；旧写法至少会在事件回调里同步抛错。
- 证据：

```ts
void readRequestBody(request).then((body) => {
  const input = JSON.parse(body);
  ...
});
```

- 建议：改为 `async` 回调加 `try/catch`，失败时返回 400/500 并 `response.end()`；至少给 `.catch` 记录诊断并销毁连接。

### 3. 低：`readRequestBody` 无长度上限

- 文件：`test/fixtures/request-body.ts:3-7`
- 问题：把所有块累积到内存后再 `Buffer.concat`，没有上限。当前只用于本机测试服务器，风险有限；但如果以后复用到其他夹具或允许外部输入，会造成内存耗尽。
- 证据：

```ts
const chunks: Buffer[] = [];
for await (const chunk of request)
  chunks.push(...);
return Buffer.concat(chunks).toString("utf8");
```

- 建议：加一个明确的字节上限，超限时拒绝并结束请求；至少在注释里写明只用于受控测试流量。

### 4. 低：真实 HTTP 用例用 50ms 定时器制造分段，但没有断言真的分成两段

- 文件：`test/integration/request-body-decoding.test.ts:38-49`
- 问题：测试名声称“delivers it in two separate chunks”，但只用 `setTimeout(..., 50)` 分两次写，服务器端没有断言收到两个 `data` 事件。如果网络或 Node 内部合并了两段，测试仍通过，无法证明真实 HTTP 路径确实经历了跨块解码。
- 证据：

```ts
outgoing.write(head);
setTimeout(() => outgoing.end(tail), 50);
...
expect(await received).toBe(SENTENCE);
```

- 建议：直接使用 socket 或自定义可写流，确保第一次写入已 flush；在服务器端记录收到的块数并断言 `>= 2`。否则这个用例只能证明最终解码正确，不能证明“跨块”场景。

## 读代码证实的

- `test/fixtures/production-service-main-child.mjs` 之前在 `createProductionModelComposition` 调用中确实没有 `egress`；同一个夹具的 `memoryCompositionFactory` 早已调用 `createProductionModelEgress(configuration, sources)`，说明 `sources.keys` 和 payload key 配置在该测试里可用。
- `createProductionModelComposition` 的选项要求 `egress`（`apps/agent-service/src/production-model-composition.ts:87-88`），后台辅助模型构造时把 `options.egress` 传给 `PiModelTransport`（同文件 `463-464`）。`PiModelTransport.invoke` 在 `packages/runtime-pi/src/pi-model-transport.ts:313` 直接调用 `this.#egress.exchange(...)`，缺少 `egress` 会抛异常，作者对根因的代码解释成立；是否被包成 `PORT_INVALID_OPERATION` 未核实。
- 后台模型请求由 `backgroundModelContext` 构造，第一条系统消息内容是 `EGRESS_PLACEHOLDER_LEGEND`，也就是 `CHAT_EGRESS_LEGEND.text`（`packages/runtime-pi/src/egress-context.ts:23-27`，`packages/application/src/services/egress-legend.ts:6`）。因此 `isAgentRequest` 用“第一条消息是 system 且内容不等于该常量”排除后台请求的写法，与当前代码一致。
- 对话请求走 `withPlaceholderLegend`，系统提示是“原系统提示 + 空行 + WITH_RESTORE 版本说明”（`packages/runtime-pi/src/egress-context.ts:15-20`），不会等于非 restore 的 `CHAT_EGRESS_LEGEND.text`，所以不会把正常对话请求漏掉。
- `CHAT_EGRESS_LEGEND` 属于提示词目录固定文字，`I-78` 的测试验证它在出口遮盖后原样保留（`apps/agent-service/test/trusted-prompt-egress.unit.test.ts:109-124`），并且同一内容反复发送字节一致（同文件 `186-190`），因此过滤器依赖的常量在请求体里是稳定的。
- 新测试文件位于 `test/integration/**/*.test.ts`，`ci/policy.json` 的 `integration` 项目包含该模式且没有排除它，所以 CI 的 `test`、`node-floor`、`coverage` 会收集到它。
- 事故表中的新路径 `test/integration/request-body-decoding.test.ts`、`test/fixtures/request-body.ts` 都存在，`check-incident-gates.mjs` 的路径存在性检查可通过。

## 推测/未核实

- 我无法在 Linux、Node 22.22.3、CI VPS 上实际运行这两个测试，因此“改动后稳定通过”只能从代码判断，不能确认。尤其作者提到的 TLS 第一块 16134 字节、本机第二轮 15488 字节、CI 上第二轮更大、旧代码在原第 1949 行失败等运行时证据，我没有复现。
- 新测试的第三个用例在真实 HTTP 下是否真的分成两块，未核实；50ms 延时通常够，但没有代码保证。
- `test/fixtures/production-service-main-child.mjs` 新增的 `egress` 没有像生产 `service-main.ts` 那样同时传 `egressThreadOf` 和 `ProductionSensitiveInterceptionRecorder`。当前两个测试不检查敏感信息拦截记录，所以不影响它们；但夹具仍与生产组合不完全一致，这是潜在风险，不是已确认缺陷。
- 历史资格证据里仍保存旧夹具哈希（例如 `test/qualification/evidence/workspace-authorization-lifecycle/p1-outcome-projection-01/input-freeze.json:880` 中的 `8474c16...`）。我没有找到代码消费这些哈希做当前源码校验；若它们只是历史记录则无需更新，若被当作“当前冻结输入”使用则会过期。
- 事故说明 I-82 写 `isAgentRequest`“只数第一条消息不是 `CHAT_EGRESS_LEGEND` 的请求”，代码实际还要求第一条消息 `role === "system"`。这只是描述略不完整，没有发现行为不一致。

## 侧重检查

- 错误路径：检查了两个请求处理器的 `readRequestBody(...).then(...)`，发现缺少 rejection 处理（发现 2）。
- 不合规范/不可信输入：测试服务器对请求体直接 `JSON.parse`，没有结构校验；这本来就是测试夹具，且只监听本机回环 TLS。新解码函数对字符串块按 UTF-8 重新编码，对 `IncomingMessage` 的 Buffer 块处理正确。
- 安全：本次改动不涉及产品认证、授权或秘密输出路径；新增 `egress` 只是让夹具更接近生产，没有把秘密写日志。未发现新的秘密泄露面。
- 资源耗尽：`readRequestBody` 无上限累积（发现 3）；测试服务器仅本机使用。
- 不可撤销操作：本次改动只改测试、夹具和文档，没有部署、删除、迁移类操作。
- 规则/文档一致性：核对了 `.claude/rules/prompt-prefix.md`、`docs/incidents-and-gates.md` I-82、`ci/policy.json` 和 `scripts/check-incident-gates.mjs`；新测试会被 CI 收集，事故表路径存在。文档大部分与代码一致，只有上述 `role` 条件的措辞略简略。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。产品源码没有改动；对话路径的出口遮盖本来就由 `service-main.ts:1799` 传给 `createProductionRunComposition`，夹具新增的 `egress` 只作用于主模型组合里的后台辅助调用。后台调用使用固定遮盖说明作为系统提示，数据放在后面的用户消息里，没有把每轮会变的值挪到请求头。就本次改动而言，发给模型的内容仍遵循“固定在前、变化在后、已发内容只追加”。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会，反而消除了一个有问题的来源。新 `readRequestBody` 先收集字节再一次性解码，消除了按块解码造成的 U+FFFD；出口遮盖的占位符由固定密钥 HMAC 生成，已有 `[I-78]` 用例确认同一内容每次字节相同。本次没有新增时间字段、无序集合或依赖后续内容的遮盖逻辑。

3. **有没有对应自动检查，反向用例真的会失败吗？** 有自动检查，而且新文件确实会被 integration 测试项目收集。反向用例在“手写的旧读法”上会稳定产生 U+FFFD，所以它不是假反向。但它没有覆盖实际被修改的服务器处理器：如果处理器实现回退，这个新测试仍可能通过，只有端到端测试在特定分块条件下才会失败（发现 1）。因此反向用例“证明了旧写法错”，但没有“锁住实现不能回退”。

4. **改动产生/修改的每个值，使用端都能接受吗？**
   - `egress`：由 `createProductionModelEgress(configuration, sources)` 产生，`createProductionModelComposition` 的 `ProductionModelCompositionOptions.egress` 是必填项，并在辅助模型和主传输里使用；同一夹具的 memory composition 已证明 `configuration`/`sources.keys` 可满足该函数。可接受。
   - `CHAT_EGRESS_LEGEND.text`：由 `prompt-catalog` 导出，后台 `backgroundModelContext` 使用同一个 `EGRESS_PLACEHOLDER_LEGEND`，测试过滤器与运行端实际字符串一致；出口遮盖不会改写它。可接受。
   - `readRequestBody`：参数是 `Readable`，两个使用点是 `IncomingMessage`（继承 `Readable`），测试里用 `Readable.from` 也符合。类型与运行时都可接受。
   - `isAgentRequest`：输入是 `providerRequests` 的 `{path, body?}`，输出用于 `agentGenerationRequests` 和 `agentRequests`；对 `/v1/embeddings`、后台 chat、正常对话 chat 的路径和首消息形状判断一致。可接受。
   - 新测试路径和事故表路径：均存在且被 CI 的 integration 包含；`check-incident-gates` 的路径校验可通过。可接受。
   - 唯一需要留意但不影响当前 CI 的是历史资格证据里旧夹具哈希仍指向改动前文件，未发现消费方，标为未核实。
