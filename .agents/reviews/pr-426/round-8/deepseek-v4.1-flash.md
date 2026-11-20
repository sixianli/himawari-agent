## 范围与做法

本轮先看 `git diff 3f9908c..82990a87`，再用 `git diff 9f83b16..82990a87` 区分本 PR 自身改动与合入 main 的内容。增量里除作者列出的三处外，其余是 main 的提交（PR 472/476/483/496 等），不当作本 PR 新写代码；但新类型涉及合约和使用端时仍跟到底。上一轮判断记录在稀疏检出里读不到（对 `.agents/reviews/pr-426/.../verdicts.jsonl` 执行 `git show` 返回 `REVIEW_GIT_REFUSED`），所以「上一轮意见是否改好」无法逐条对照，只能核对作者列出的几处。

## 意见

本轮没有发现需要修改的问题。作者列出的三处都与代码一致：

- `package.json:27` 的 `check:steps` 保留 main 的步骤（含 `check:meaning-word-lists`、带 vitest 的 `check:incident-gates`），并在末尾追加 `check:client-parity`；`package.json:30-31` 的 `check:client-parity` 与 `generate:client-capabilities` 两条脚本都在。
- `packages/gateway-contracts/src/client-capabilities.ts:195` 登记为 `query("v2", "memory.import.duplicates.read")`，即 query/read。
- `clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:151` 有对应的 `.query/.read` 行，位置与能力表一致。
- 没有漏登记的新类型：`3f9908c..82990a87` 的合约只新增了 `memory.import.duplicates.read` 和 `memory.import.duplicates.snapshot`（`packages/gateway-contracts/src/contracts-v2.ts:69-70`），后者以 `.snapshot` 结尾，自动归入回应类型，不需要进能力表。

## 侧重检查

- **错误路径与不可信输入（读代码证实）**：设备网关先用 `findClientCapability` 查表，未知类型返回 404（`packages/platform-node/src/device-gateway.ts:95-98`）；query 若带 `idempotencyKey` 会被拒绝（同文件 `101-104`）；请求最后由合约 schema 解析（`device-gateway.ts:218-237`）。`memory.import.duplicates.read` 的 `contentRefs` 在合约里限制 1 到 500 条（`packages/gateway-contracts/src/contracts-v2.ts:1608-1626`）。
- **安全与隐私（读代码证实）**：该类型是只读查询，服务端 `#importDuplicates` 只读内容并返回判断，不写状态（`apps/agent-service/src/production-memory-control.ts:1337-1355`）；分类高于 private 或已被判为敏感的内容不会发给模型（同文件 `1364-1376`）；外部调用走 `redactForExternalText` 且 `zeroDataRetention: true`（`packages/platform-node/src/memory-import-duplicate-decision.ts:53-64`）。登记为 read 只表示设备密钥即可调用，和它的只读性质一致。
- **资源耗尽（部分证实）**：合约限制单次 500 条；外部响应有 1 MiB 上限（`memory-import-duplicate-decision.ts:13,93-107`）。每次查询的模型请求数上限、每日上限在 main 的实现里，本次增量没有改，**未逐行核对**。
- **不可撤销操作（读代码证实）**：本次增量只登记查询；`memory.import.commit`、`memory.import.undo` 仍是 change（`client-capabilities.ts:196-197`），没有把写操作降级。
- **规则与文档一致性（读代码证实）**：`prompt-prefix.md` 第 4、27-29 条要求只追加、变化值放最后；本次增量不碰提示词。ADR 0271 第 111 行也写明这个判断是后台单独调用、不改对话请求开头；第 70 行与登记的查询名一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会，本次增量不涉及：只改客户端能力表、生成的 Swift 清单和 `package.json`，`9f83b16..82990a87` 的净改动不含系统提示、工具定义、历史或遮盖相关文件。发给模型的内容仍按 `prompt-prefix.md` 第 4、27-29 条只在末尾追加，每轮变化的值仍在最后一条消息里；本改动没有触碰这条路径。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。新能力项是冻结数组里的固定条目，Swift 生成器按固定顺序遍历，没有时间字段、无序集合，也没有引入依赖前后文的遮盖（`client-capabilities.ts:112,195`；`client-parity.test.ts:74-157`）。
3. **有没有自动检查，反向用例真的会失败吗？** 有。`check:client-parity` 在 `check:steps` 末尾，CI 的 static 作业运行 `npm run check`（`scripts/ci/run.mjs:269`）。`packages/gateway-contracts/test/client-capabilities.contract.test.ts:34-36` 要求「能力表 + 回应类型」等于合约全部类型；`test/tooling/client-parity.test.ts:180-191` 双向比较合约与能力表；`214-219` 逐字比较生成的 Swift；`221-231` 是「表里加一条但文件没重生成就对不上」的反向用例。删掉新条目会同时让合约相等性检查和 Swift 严格比较失败。
4. **每个产生/修改的值的直接使用端都能接受吗？** 能，逐个核对如下：
   - `memory.import.duplicates.read`：合约侧同名且是 `envelope("query", ...)`（`contracts-v2.ts:69,1610`）；设备网关查表接受（`device-gateway.ts:95`），query 不允许 `idempotencyKey`（`101-104`），read 直接转发（`152`）并由 schema 校验（`218-237`）；网页发送端用同名查询（`apps/control-center/src/memory.ts:260`）；服务端有同名分支（`production-memory-control.ts:1164,1337`）；Swift 清单有对应行（`151`）。两端校验一致。
   - `memory.import.duplicates.snapshot`：`.snapshot` 结尾，自动归入 `CLIENT_RESPONSE_ONLY_TYPES.v2` 的回应列表（`client-capabilities.ts` 中按后缀过滤），不需要单独登记，也没有漏。
   - `check:client-parity` / `generate:client-capabilities` 配置键：`scripts/run-all-checks.mjs:32,36` 按 `check:steps` 逐个执行 `npm run <name>`；`test/tooling/run-all-checks.test.mjs:74` 要求每个步骤都有对应脚本；两条脚本都存在。

结论：三处改动正确，没有漏登记的新类型，本轮没有阻塞意见。
