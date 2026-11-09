## 读代码证实的发现（按严重度从高到低）

### 1. 中 — `system-instruction` 扩大了固定只读入口的授权范围，规则与文档没有同步

- 文件: `scripts/operations/prod-read.sh:8,108-118`；`.agents/instructions/test-and-production-hosts.md:19`；`docs/agent-rulebook-inventory.md:161`
- 问题: 这个查询直接读取生产配置文件 `/etc/himawari/config.json`，而规则文件把 Mac 上只读访问生产机的例外范围**逐项限定**为“服务状态、日志、磁盘、数据库里的运行状态”，不含配置文件。清单 C-1 也明确写着生产 `systemInstruction` “待 Andy 授权读取后补全”。本改动把读取该值的入口做进了通用脚本，却没有更新这两处规则/文档，也没有体现授权。
- 证据:
  - `prod-read.sh:8`: `PROD_CONFIGURATION="/etc/himawari/config.json"`
  - `prod-read.sh:112-116`: `const configuration = JSON.parse(readFileSync(process.argv[2], "utf8"));` … `const text = policy?.systemInstruction;` … `console.log(text);`
  - `.agents/instructions/test-and-production-hosts.md:19`: “……范围就是下面这个固定入口；服务状态、日志、磁盘、数据库里的运行状态……脚本只接受固定的几种查询……”
  - `docs/agent-rulebook-inventory.md:161`: “生产值在 `/etc/himawari/config.json`，待 Andy 授权读取后补全”
- 建议: 要么在该规则文件中把 `rule-memories`、`system-instruction` 明确列入允许范围并记录本次授权，要么让 `system-instruction` 需要单独确认后再执行；同时更新清单 C-1 的“待授权”字样。这个改动本身不泄露密钥（只打印一个字段），但它改变了“固定入口能读什么”的边界，属于规则与代码不一致。

### 2. 低 — `runPolicy` 的嵌套回退分支与真实配置解析不一致

- 文件: `scripts/operations/prod-read.sh:113`
- 问题: 脚本写成 `configuration.runPolicy ?? configuration.configuration?.runPolicy`，但产品的真实解析只接受**顶层** `runPolicy`，顶层出现 `configuration` 这个键会被 `rejectUnknown` 拒绝。因此嵌套分支只可能读到一个产品根本不会接受的配置，从而打印出“生产并未实际使用”的指令，和作者“只打印生产配置里实际生效的 systemInstruction”的说法有偏差。
- 证据:
  - `prod-read.sh:113`: `const policy = configuration.runPolicy ?? configuration.configuration?.runPolicy;`
  - `packages/platform-node/src/strict-configuration.ts:1184-1198`: `const input = record(value, "configuration");`，允许键清单里只有 `runPolicy`，没有 `configuration`
  - `scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:11`: `"runPolicy": {` 位于顶层
  - `scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs:129`: `original.runPolicy.coding.grantId`
- 建议: 去掉嵌套回退，只读顶层 `runPolicy.systemInstruction`；更稳妥的是复用 `parseProductConfiguration` 的解析结果，确保读到的是产品真正会用的值。

### 3. 低 — `rule-memories` 无数量上限、不过滤状态、不限定 owner/agent

- 文件: `scripts/operations/prod-read.sh:85-91`
- 问题: 查询返回 `category='rule'` 的**所有**记忆，包括 `trashed`、`deletion_pending`、`deleted_verified`，且没有 `LIMIT`、没有 `owner_id`/`agent_id` 过滤。虽然不含正文和 `content_ref`，但可能输出已删除规则的元数据、在库很大时产生大输出（资源/日志膨胀），在多 owner/agent 的库上还会混入不属于当前生产代理的记录。
- 证据: `"SELECT id, status, ... FROM memory_records WHERE category = 'rule' ORDER BY recorded_at"`，没有 `status` 条件与 `LIMIT`。
- 建议: 明确列出需要的状态（例如 `status IN ('active','archived')`），并按生产 owner/agent 过滤或明确说明为何不需要；加一个合理的 `LIMIT`。若故意列出全部状态，请在 `usage`/文档里写清楚。

### 4. 低 — 新测试没有绑定真实表结构，且没有直接断言新查询的只读打开

- 文件: `test/tooling/prod-read.test.mjs:179-204`
- 问题: 测试自己手写了一份 `memory_records` 建表语句（第 189 行），不是由真实迁移链生成，因此只能证明“这组列在测试表里存在”，不能防止以后真实 schema 变化导致生产查询报错（正是 I-73 那类“只看改动、没核对两端校验”的盲区）。另外测试标题写 “running the script read-only”，但没有像第 101 行那样断言新查询的脚本里含 `{ readOnly: true }`；只是复用同一段生成代码。
- 证据:
  - `test/tooling/prod-read.test.mjs:189`: 手写 `CREATE TABLE memory_records (...)`
  - `test/tooling/prod-read.test.mjs:183`: 只断言 `expect(result.input).not.toContain("content_ref")`
  - 现有只读断言在 `test/tooling/prod-read.test.mjs:101`
- 建议: 用真实迁移/`schema-catalog` 建库后跑这条查询；并显式断言 `result.input` 含 `{ readOnly: true }`。当前手动核对结果是：被选的 12 个列在真实迁移中都存在（见下）。

### 5. 低（部分推测）— 错误路径可能回显配置片段/控制字符

- 文件: `scripts/operations/prod-read.sh:111-116`
- 问题: `JSON.parse` 失败时，现代 Node/V8 的错误信息可能带上输入片段；`console.log(text)` 也会把 `systemInstruction` 里的控制字符原样送到终端。生产配置 `systemInstruction` 最长 16384 字节、由主人控制，不是密钥，所以风险低。
- 证据: `const configuration = JSON.parse(readFileSync(process.argv[2], "utf8"));`、`console.log(text);`
- 建议: 若要把该脚本的安全边界做严，可只捕获错误码、不回显解析片段，并对输出做控制字符处理。此条为推测性风险，未读到生产实际配置内容。

## 侧重检查

- **错误路径**: `system-instruction` 在字段缺失时抛错并以非零退出（`prod-read.sh:115`），本地 `set -euo pipefail` 会把失败传回；`rule-memories` 查询表不存在时会抛 `PROD_READ_UNKNOWN_MODE`/SQLite 错误。未发现静默降级。
- **不可信输入**: 两个新查询都要求参数个数为 0（`prod-read.sh:173-180`），参数校验在连接前完成；测试覆盖了带多余参数返回 64 且不建立 SSH 连接（`test/tooling/prod-read.test.mjs:235-241`）。未发现命令/SQL 注入入口。
- **只读与不可撤销操作**: 数据库仍以 `{ readOnly: true }` 打开（`prod-read.sh:48`）；配置文件只读，无写操作。未发现写路径。
- **敏感输出**: `rule-memories` 不选 `content_ref`，也不选 `content`；`system-instruction` 只打印一个字段，测试用 `secretReferences` 夹具验证 stdout 恰好是 `hello\n`（`test/tooling/prod-read.test.mjs:213-225`）。未发现密钥/令牌/加密内容输出。
- **资源耗尽**: 见发现 3，`rules` 无 `LIMIT`。
- **规则/文档一致性**: 见发现 1、2；另注：作者说目的是把规则补进 `docs/agent-rulebook-inventory.md`，但本次 diff 只有脚本和测试两个文件，清单文件未改，C-1 仍写“待授权读取后补全”。

## 作者说法核对

- “脚本只能只读” — 证实：数据库 `readOnly: true`，配置只读。
- “字段名和 `memory_records` 真实列一致” — 证实：`id/status/tentative/classification/importance_permille/confidence_permille/inference/recorded_at/updated_at/valid_to/superseded_by/use_count` 分别来自 `0001_initial_product_schema.sql`、`0052_memory_engine.sql`、`0053_memory_episodes.sql`、`0054_memory_consolidation.sql`，全部存在。
- “systemInstruction 位置判断与真实解析一致” — 部分不符：真实解析/模板/上线读回都是顶层 `runPolicy`；脚本多出的嵌套回退不可能出现在产品会接受的配置里（发现 2）。
- “两个查询不接受参数” — 证实（`prod-read.sh:173-180`）。
- “不改产品行为、不加迁移、不改发给模型的内容” — 证实：diff 仅脚本与测试；`prod-read.sh` 只被说明文档和测试引用，不在产品运行路径中。
- “把生产规则补进 inventory” — 本次提交未包含清单更新。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本 diff 只改 `scripts/operations/prod-read.sh` 和它的测试，没有任何代码进入请求组装/系统提示/工具定义/历史/遮盖路径；`prod-read.sh` 除测试外只被 `.agents/instructions/test-and-production-hosts.md`、`docs/runbooks/production-web-entry-runbook.md` 引用。因此“只在末尾追加、每轮变化值放最后一条消息”的规则不受影响（`.claude/rules/prompt-prefix.md` 第 4 条）。
2. **不会让同一段文字在不同请求里变成不同字节。** 没有改序列化、排序、遮盖或时间字段进入模型内容。唯一可能的非确定性是 `rule-memories` 的 `ORDER BY recorded_at` 在相同时间戳上的顺序，但它只影响运维输出，不进入模型请求。
3. **有自动检查，但覆盖不完整。** `test/tooling/prod-read.test.mjs` 属于 vitest `tooling` 项目（`ci/policy.json:193-194`），由 CI 的 `policy` check 执行；`npm run check`/`check:steps` 本身不直接跑该测试。反向用例确实存在：多余参数返回 64 且不连接、缺少 `systemInstruction` 非零退出、输出不含 `content_ref`/`secret-ref`、配置输出精确等于一个字段。缺口是测试表结构是手写的、未绑定真实迁移，且没有直接断言新查询的 `readOnly`（发现 4）。
4. **新增的每个值逐一核对过两端。** 查询名 `rule-memories`/`system-instruction` 在 `usage` 与 `case` 两处一致；数据库模式名 `rules` 与 `database_query` 分支一致；12 个列名全部能在真实迁移中找到；`/etc/himawari/config.json` 与 `parseProductConfiguration`、模板、S7 读回一致；`runPolicy.systemInstruction` 在真实解析里确实是顶层字段。唯一不一致的是脚本里多出的 `configuration.configuration?.runPolicy` 回退（发现 2），以及规则/文档没有把新入口和读取授权写进去（发现 1）。

未核实：测试的实际运行结果（环境只允许 git 命令，未执行 vitest）；生产 `/etc/himawari/config.json` 的真实内容（未读取，也不应读取）。
