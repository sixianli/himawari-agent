## 问题清单（按严重度从高到低）

### 1.【中】新加的测试行预计过不了 `format:check`，会阻塞必需检查

- 文件:行：`test/tooling/prod-read.test.mjs:235`
- 问题：新增的嵌套回退反向用例把整行写在一行；`biome.json` 的 `lineWidth` 是 100，这一行约 107 字符。`package.json:27` 的 `check:steps` 第一步就是 `npm run format:check`，CI 的 `static` 作业会执行 `npm run check`（`scripts/ci/run.mjs:244`），而 `static` 是必需作业链的一环。
- 证据：

```text
    writeFileSync(file, JSON.stringify({ configuration: { runPolicy: { systemInstruction: "nested" } } }));
```

```json
// biome.json:14-18
"formatter": { "enabled": true, "indentStyle": "space", "lineWidth": 100 }
```

```text
// package.json:27
"check:steps": "npm run format:check && npm run lint && ..."
```

- 证实/推测：行宽超过 100 是读代码证实的；`format:check` 会因此失败是按 Biome 配置推断的（本次无法运行 biome）。
- 建议：运行 Biome 格式化该文件，或手工改成多行调用；并在提交说明的 `Fast-mode-checks` 里如实记录 `npm run check` 是否真的跑过。

### 2.【中】`system-instruction` 以 root 跟随服务账号可写的配置路径，未复用产品的文件安全检查

- 文件:行：`scripts/operations/prod-read.sh:109-116`（新查询）；对照 `packages/platform-node/src/strict-configuration.ts:1550-1556`、`scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs:102`
- 问题：新查询用 root 经 SSH 执行 `readFileSync(process.argv[2])`，没有检查目标是不是普通文件、是不是符号链接、权限是否被其他人可写；而产品自己的配置加载器会做这些检查，生产回读脚本也明确要求 `config.json` 是 uid 999、0600 的普通文件。该文件归 himawari-prod（uid 999）所有，也就是说服务账号可以替换它。若被换成指向 root 才能读的文件的符号链接，root 进程会跟随读取；`JSON.parse` 抛错时 Node 的错误文本通常带输入片段，可能把“配置其余部分”或目标文件内容带到本地终端，和规则里“不含配置其余部分”的承诺不符。
- 证据：

```bash
# prod-read.sh:109-116
ssh ... "cd /tmp && $PROD_NODE --no-warnings - $PROD_CONFIGURATION" <<'JS'
const { readFileSync } = require("node:fs");
const configuration = JSON.parse(readFileSync(process.argv[2], "utf8"));
const policy = configuration.runPolicy;
const text = policy?.systemInstruction;
JS
```

```ts
// strict-configuration.ts:1550-1556
const info = await lstat(this.#configurationPath).catch(() => undefined);
if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) {
  throw new StrictConfigurationError(... "FILE_UNSAFE" ...);
}
```

```js
// S7-startup-readback.mjs:102
const configurationBytes = file(configurationPath, 999, 0o600);
```

- 证实/推测：没有 lstat/符号链接检查、以 root 读取、生产配置归 uid 999，都是读代码证实的；“错误文本会带出文件片段”是 Node/V8 的已知行为，属推测，未实际复现。
- 建议：至少复用与 `JsonFileConfigurationPort` 相同的 `lstat`/非符号链接/权限检查；更简单的是像 Runbook 里的查库方式那样用 `sudo -u himawari-prod` 读配置，避免 root 跟随服务账号可写路径；同时不要把 `JSON.parse` 的原始错误消息直接透传。

### 3.【中】规则文件说 Andy 已同意读取，但盘点清单仍写“待授权”，同一份仓库内前后矛盾

- 文件:行：`.agents/instructions/test-and-production-hosts.md:19`；`docs/agent-rulebook-inventory.md:161`（以及 `:149`）
- 问题：规则文件新写“Andy 2026-11-09 在项目线程里同意读这两样”；但盘点清单 C-1 仍写生产 `runPolicy.systemInstruction`“待 Andy 授权读取后补全”，C 节也仍写“读生产库按项目规矩要先问 Andy，所以没有读。需要的话：Andy 同意后……”。读者无法判断到底是“已授权未读取”还是“尚未授权”。
- 证据：

```text
// .agents/instructions/test-and-production-hosts.md:19
... Andy 2026-11-09 在项目线程里同意读这两样，范围不扩大到配置文件的其他内容 ...
```

```text
// docs/agent-rulebook-inventory.md:161
| C-1 | 生产配置的 `runPolicy.systemInstruction` ... | 生产值在 `/etc/himawari/config.json`，待 Andy 授权读取后补全 | ...
```

```text
// docs/agent-rulebook-inventory.md:149
... 读生产库按项目规矩要先问 Andy，所以没有读。需要的话：Andy 同意后，我用只读方式列出所有 `rule` 类记忆 ...
```

- 证实/推测：“两处文字互相矛盾”是读代码证实的；“Andy 2026-11-09 在项目线程里同意”本身仓库内没有独立记录，只有本行和提交说明，属未核实。
- 建议：把 `docs/agent-rulebook-inventory.md` 的 C-1 和 C 节改成“已于 2026-11-09 获授权，待读取/待补入”，或者实际读完后补全；若授权只覆盖“允许读”，也请在清单里明确写“尚未读取”。

### 4.【低】`LIMIT 500` 静默截断且按 `recorded_at` 升序，清单却写“列出所有”，会漏掉最新的规则

- 文件:行：`scripts/operations/prod-read.sh:88`、`:23`；`docs/agent-rulebook-inventory.md:149`
- 问题：查询只取最早的 500 条规则（`ORDER BY recorded_at` 升序 + `LIMIT 500`），没有总数、没有截断标记；超过 500 条时最新规则被静默丢弃。盘点清单却写“列出所有 `rule` 类记忆”，这与脚本行为不一致。另外 `recorded_at` 相同的行在 `LIMIT` 边界上可能返回不同集合，输出不是逐字节确定。
- 证据：

```sql
-- prod-read.sh:88
SELECT id, status, tentative, classification, importance_permille, confidence_permille,
       inference, recorded_at, updated_at, valid_to, superseded_by, use_count
FROM memory_records WHERE category = 'rule' ORDER BY recorded_at LIMIT 500
```

```text
// prod-read.sh:23
rule-memories  metadata (no text) of the rule-category memories, all statuses, at most 500
```

```text
// docs/agent-rulebook-inventory.md:149
... 我用只读方式列出所有 `rule` 类记忆（条数、状态、记录日期、是否待确认，不含原话 ...）
```

- 证实/推测：SQL 和 usage 是读代码证实的；生产是否真的超过 500 条未核实。
- 建议：增加 `id` 作为第二排序键；把排序改成 `recorded_at DESC, id` 以免先丢最新规则；或者同时输出总数/`truncated` 标记，或做分页。清单里不要写“所有”，或明确“最多 500 条”。

### 5.【低】`LIMIT 500` 的测试断言不精确，`LIMIT 5000` 也会通过

- 文件:行：`test/tooling/prod-read.test.mjs:185`
- 问题：断言是子串匹配 `toContain("LIMIT 500")`；`LIMIT 5000`、`LIMIT 50000` 都包含这个子串，所以这个“反向用例”挡不住把上限放宽的回归；也没有 501 行的行为测试。
- 证据：

```js
// test/tooling/prod-read.test.mjs:185
expect(result.input).toContain("LIMIT 500");
```

- 证实/推测：子串包含关系是确定的；是否需要严格断言取决于你们对“上限”的意图。
- 建议：用 `/LIMIT 500\b/` 或直接比对完整 SQL；再加一个插入 501 行、验证只返回 500 行的行为用例。

### 6.【低】规则文件新写的“范围”仍小于脚本实际能读的内容（既有问题，被这次文字强化）

- 文件:行：`.agents/instructions/test-and-production-hosts.md:19`；`scripts/operations/prod-read.sh:158-171`
- 问题：规则文件把范围写成“服务状态、日志、磁盘、数据库里的运行状态，以及两个固定查询”，但脚本仍接受 `tables`、`columns <table>` 和 `rows <table> <run-id>`，其中 `rows` 可对任意有 `id`/`run_id` 列的表按 ID 取整行，并不限于“运行状态”。这不是本次新引入的能力，但新句子“范围就是下面这个固定入口”读起来像穷举，和脚本行为不一致。
- 证据：

```text
// .agents/instructions/test-and-production-hosts.md:19
... 范围就是下面这个固定入口；服务状态、日志、磁盘、数据库里的运行状态，以及两个固定查询 ...
```

```bash
# prod-read.sh:158-171
tables) ... ;;
columns) ... database_query columns "$1" ;;
rows) ... database_query rows "$1" "$2" ;;
```

- 证实/推测：脚本接受这些查询是读代码证实的；它们是否被有意纳入“运行状态”范围，规则文件没有说明。
- 建议：在规则文件里明确列出 `tables`/`columns`/`rows` 的允许范围，或反过来把脚本收窄到表/列白名单。

### 7.【低】“记忆原话只能在记忆页看”表述不准确

- 文件:行：`docs/agent-rulebook-inventory.md:149`
- 问题：原话确实以密文存进 `payloads`，但仓库里至少记忆整理和每日复盘会解密读取原话，并不“只能在记忆页看”。这不影响 `rule-memories` 查询不取原话的事实，但理由写错了。
- 证据：

```text
// docs/agent-rulebook-inventory.md:149
... 记忆原话是加密的，只能在记忆页看 ...
```

```ts
// packages/application/src/services/durable-memory-service.ts:610
const content = await this.options.content.readText(current.contentRef);
```

```ts
// packages/application/src/services/daily-review.ts:284
(await options.readMemoryText(entry.contentRef).catch(() => undefined)) ?? "",
```

- 证实/推测：这些代码路径会读取解密后的记忆文本，是读代码证实的。
- 建议：改成“原话以密文存储；`prod-read` 不读原话；只有记忆页和受控后台流程解密”。

---

## 侧重检查

- **错误路径**：两个新查询都要求零参数，额外参数走 `usage` 并退出 64（`prod-read.sh:173-179`，测试 `prod-read.test.mjs:244-249`）；嵌套 `configuration.runPolicy` 会被拒绝，反向测试存在（`prod-read.test.mjs:235-241`）；缺少 `systemInstruction` 会非零退出（`:228-234`）。未覆盖：非法 JSON 的报错路径、配置文件是符号链接/权限异常、数据库 schema 落后导致缺列。
- **不合规范/不可信输入**：查询本身无用户参数注入面；`rule-memories` 关闭了任意表/列输入，SQL 固定。`shorten` 只截断 160 字符并隐藏 `auth/password/ciphertext/...` 列，但 `row` 输出没有做终端控制字符转义；`rule-memories` 的字段都被 schema 约束，风险低。
- **安全/权限**：数据库以 `readOnly: true` 打开（`prod-read.sh:48`），有测试断言（`prod-read.test.mjs:184`）。但整个脚本仍以 `root@84.247.157.41` 执行；配置文件归 uid 999，见问题 2。生产只读入口的“仅在 Mac + `DELIVERY_MODE=fast`”只靠规则文件约束，脚本本身没有校验平台或交付模式。
- **资源耗尽**：`rule-memories` 有 `LIMIT 500`，输出有界；`systemInstruction` 在产品解析层最多 16384 字节（`strict-configuration.ts:1128`），但 `prod-read.sh` 不经产品解析器，配置文件本身没有大小上限。数据库按 `recorded_at` 排序仍可能扫描全部规则行，不过生产规模下风险低。
- **不可撤销操作**：本次改动全是只读查询、文档和测试，没有写生产数据、改配置或重启服务的路径。
- **规则/文档/代码一致**：把 `rule-memories`、`system-instruction` 写进规则文件这件事本身与脚本的查询名、配置键一致；不一致集中在“授权状态”（问题 3）、“最多 500 条/所有”（问题 4）、“范围枚举”（问题 6）和“记忆原话在哪看”（问题 7）。

---

## 作者说法核对

- “删掉 system-instruction 的配置嵌套回退（只读顶层 runPolicy，加反向用例）”：**属实**。`prod-read.sh:113` 已是 `configuration.runPolicy`；`prod-read.test.mjs:235-241` 写嵌套配置并断言非零退出。产品解析器确实只接受顶层 `runPolicy`（`strict-configuration.ts:1189-1211`、`1405`、`1549-1566`），生产模板也是顶层。
- “rule-memories 加 LIMIT 500”：**属实**，见 `prod-read.sh:88`，usage 也同步写了 `at most 500`。
- “规则文件把两个固定查询和 Andy 2026-11-09 的同意写进只读入口范围”：**文字属实**；Andy 的同意本身仓库内没有独立记录，**未核实**；并且与盘点清单的“待授权”表述矛盾（问题 3）。
- “清单改成只列元数据”：**改动属实**，改后确实移除了“原话”并写了“不含原话”；但“所有”与 `LIMIT 500` 不一致（问题 4），“只能在记忆页看”不准确（问题 7）。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个 PR 的改动只涉及 `scripts/operations/prod-read.sh`、规则/盘点文档和 `test/tooling/prod-read.test.mjs`，没有改 `packages/prompt-catalog`、`runtime-pi`、系统提示拼装、工具定义或历史写入。`prod-read.sh` 的输出也不进入产品模型请求。按 `.claude/rules/prompt-prefix.md:27-36` 的“只追加/会变的值放最后一条消息”要求，本次不需要额外处理；**结论：不会**。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   对模型请求不会。唯一相关的确定性问题是 `rule-memories` 的结果：`ORDER BY recorded_at` 没有 `id` 作为第二排序键，且 `LIMIT 500` 在边界上可能因并列时间返回不同集合；但这只是运维查询的输出，不进入模型上下文，所以不影响 KV 缓存。**结论：不影响模型请求；但运维输出本身不是完全确定的。**

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有 `test/tooling/prod-read.test.mjs`，它属于 `ci/policy.json` 的 `tooling` 项目（`:193-196`），CI 的 `coverage` 作业会跑 `tooling`（`:108`）。嵌套回退反向用例在旧代码上会输出 `"nested"` 并退出 0，因此会真的失败，**是有效反向用例**。但 `LIMIT 500` 的断言只是子串匹配，`LIMIT 5000` 也会通过，**不能算严格的反向用例**；`rule-memories` 也没有超过 500 行的行为测试。另外 `npm run check` 的 `check:steps` 不包含这个测试文件，作者在提交里也写明 `npm run check` 没跑成。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   已核对：
   - 查询名 `rule-memories`/`system-instruction`：`usage`（`prod-read.sh:23-24`）、`case`（`:173-179`）、规则文件（`.agents/instructions/test-and-production-hosts.md:19`）、测试（`prod-read.test.mjs:180/209/245`）一致。
   - 数据库模式 `"rules"`：由 `database_query` 传入、由同一脚本的 `mode === "rules"` 分支消费（`:85-91`），无外部校验面。
   - SQL 选出的字段：`id/status/tentative/classification/importance_permille/confidence_permille/inference/recorded_at/updated_at/valid_to/superseded_by/use_count` 都存在于迁移后的 `memory_records`（`0001_initial_product_schema.sql:393-408`，后续 `0011`/`0052`/`0053`/`0054`/`0057`/`0065` 增加）；`content_ref` 未被选出，测试也断言不含它。
   - 配置键 `runPolicy.systemInstruction`：产品解析器确实在顶层 `runPolicy` 下解析（`strict-configuration.ts:1101-1129`、`1405`），生产模板也是顶层；脚本现在与之一致，旧的嵌套回退确实是错的。
   - 仍有两端不一致：盘点清单的授权状态（问题 3）、`LIMIT 500` 与“所有”（问题 4）、规则文件范围枚举与脚本通用 `rows/columns/tables`（问题 6）。
