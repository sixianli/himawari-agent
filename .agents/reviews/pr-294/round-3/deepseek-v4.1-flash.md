## 结论摘要

方向正确：远端仍是固定只读脚本，参数校验没被削弱，未发现通过 `rows`/`run` 可直接读出的原始凭据。但遮盖规则过宽，会把非敏感诊断字段一并遮掉；另有几个当前不可达、但规则上漏掉的凭据列，以及测试和文档缺口。

## 读代码证实的问题

### 中：`token`/`embedding`/`credential` 未加词界，遮掉了非敏感诊断字段

文件：`scripts/operations/prod-read.sh:47-49`

```js
const hiddenColumn = /(^auth$|p256dh|endpoint|ciphertext|embedding|secret|token|password|credential)/i;
...
if (hiddenColumn.test(key)) return "[hidden]";
```

`token` 会命中 `input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens`、`fencing_token` 等；`embedding` 会命中 `embedding_model`、`embedding_dimensions`；`credential` 会命中 `credential_revision`。

证据：

- `packages/persistence-sqlite/src/migrations/0068_model_usage_observations.sql:15-21`
```sql
input_tokens INTEGER NOT NULL ...
output_tokens INTEGER NOT NULL ...
cache_read_tokens INTEGER NOT NULL ...
cache_write_tokens INTEGER NOT NULL ...
```
该表有 `run_id`，所以 `prod-read.sh rows model_usage_observations <run-id>` 能查到，结果是所有 token 统计都变成 `[hidden]`，缓存诊断失去意义。
- `packages/persistence-sqlite/src/migrations/0021_run_execution_leases.sql:9` 的 `fencing_token` 会被遮。
- `packages/persistence-sqlite/src/migrations/0052_memory_engine.sql:24-26` 的 `embedding_model`、`embedding_dimensions` 会被遮。
- `docs/runbooks/production-web-entry-runbook.md:85` 要求读 `deployments` 的 `revision`、`fencing_token`；若按同一固定入口读，`fencing_token` 现在一定是 `[hidden]`。

建议：改成按精确列名或显式清单匹配，例如 `^(auth|p256dh|endpoint|ciphertext|embedding|secret_ref|secret_refs_json|token_ref|password|password_hash|credential)$`，不要把 `token`、`embedding`、`credential` 当无界子串；并补一条反向测试：`rows model_usage_observations` 的 token 数必须保留。

### 低：真正的凭据内容列 `account_json`、`challenge_json` 不在规则里

文件：`scripts/operations/prod-read.sh:47`、`packages/persistence-sqlite/src/migrations/0031_built_in_identity.sql:1-21`

```sql
CREATE TABLE built_in_accounts (
  owner_id TEXT PRIMARY KEY ...
  account_json TEXT NOT NULL CHECK (json_valid(account_json)),
...
CREATE TABLE built_in_challenges (
  digest TEXT PRIMARY KEY,
  ...
  challenge_json TEXT NOT NULL CHECK (json_valid(challenge_json))
```

`packages/application/src/ports/built-in-identity.ts:5-11` 证明 `account_json` 里存的是：

```ts
readonly passwordHash: string;
readonly factorPayloadRef: string;
readonly recoveryDigests: readonly string[];
```

这些列名不匹配 `hiddenColumn`。当前没有直接泄露，因为 `rows` 的键选择只认 `run_id` 或 `id`：

- `scripts/operations/prod-read.sh:85`
```js
const key = columns.includes("run_id") ? "run_id" : columns.includes("id") ? "id" : null;
```
`built_in_accounts`/`built_in_challenges` 都没有 `id` 或 `run_id`，会报 `PROD_READ_NO_RUN_COLUMN`。但这是靠“表刚好没有 id 列”挡住的，不是遮盖规则挡住；以后加列或加查询模式就会暴露。

建议：把 `account_json`、`challenge_json` 加进隐藏清单，或改成“敏感表整表拒绝/只允许固定列”的白名单式查询，避免依赖表结构碰巧挡住的保护。

### 低：遮盖测试只测了抽取出来的函数，没测远端真实执行；二进制分支在真实 schema 上几乎不可达

文件：`test/tooling/prod-read.test.mjs:119-141`

```js
const start = script.indexOf("const hiddenColumn");
const end = script.indexOf("const tableNames");
const body = script.slice(start, end);
const sandbox = new Function(`${body}; return shorten;`)();
```

这验证的是 heredoc 文本里的函数逻辑，不验证远端 `node:sqlite` 是否真的把 BLOB 返回为 `Uint8Array`，也不验证真实表查询。

另外，`scripts/operations/prod-read.sh:51`：

```js
if (value !== null && typeof value === "object") return "[binary " + value.byteLength + " bytes]";
```

迁移里的 BLOB 列只有 `embedding`（`0052:26`、`0053:21`）和 `ciphertext`（`0001:63`），两者都已被 `hiddenColumn` 先行遮成 `[hidden]`。测试里的 `payload: new Uint8Array(3)` 在真实 schema 中不存在，所以“二进制只报字节数”这条在当前数据库上实际几乎不会发生。

建议：加一个用临时 SQLite 库和真实 `node:sqlite` 的端到端用例（或至少让假 `ssh` 在本地执行 `node`）；若要保留二进制分支，用一个真实存在且不匹配隐藏名的 BLOB 列来测。

### 低：文档把固定入口说成“数据库里的运行状态”，实际 `rows` 能读任意有 `id`/`run_id` 的表，且未说明遮盖策略

文件：`.agents/instructions/test-and-production-hosts.md:19`

```text
...范围就是下面这个固定入口；服务状态、日志、磁盘、数据库里的运行状态...
```

`rows` 的实际能力是读取任何有 `run_id` 或 `id` 列的表（`scripts/operations/prod-read.sh:82-90`），包括 `thread_artifacts.path`、`decision_ledger`、`muse_intake_*` 等，不只是“运行状态”。文档也没有说明哪些列会被遮、遮成什么。建议在说明里写清：可查表范围、遮盖列、`[hidden]`/`[binary N bytes]` 的含义，并同步修正 `fencing_token` 等被误遮的用法。

### 低：run id 长度上限与领域校验不一致

文件：`scripts/operations/prod-read.sh:133`、`:148`

```bash
require_match "$1" '^run:[A-Za-z0-9._:-]{1,120}$' "run id"
...
require_match "$2" '^[A-Za-z0-9:._-]{3,80}$' "run id"
```

领域校验允许 1–128 个字符（`packages/domain/src/identifiers.ts:39`）：
```ts
const MACHINE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
```
`run` 实际最多接受 124 字符，`rows` 最多 80 字符，合法的长 id 会被拒绝。生产当前是 `run:` + 32 位十六进制（36 字符），不受影响，但属于校验两端不一致。建议让 `run` 的上限与领域一致，`rows` 也至少覆盖领域允许的最大长度。

## 推测/未核实

- `sandbox_execution_records.plan_json`、`sandbox_jobs.plan_json`、`sandbox_admission_queue.request_json` 等 JSON 列可能包含命令、环境变量或用户数据中的秘密；这些列名不匹配遮盖规则。未核实这些 JSON 中是否实际会出现可用的凭据值，所以列为待查，不作为已确认泄露。
- 远端 Node 版本对 `node:sqlite` BLOB 的返回类型未在真实生产环境执行验证；按 Node 文档推断为 `Uint8Array`，但测试没有覆盖。

## 侧重检查

- 错误路径：`journal`、`run`、`columns`、`rows` 的非法参数都在连接前被 `require_match` 拒绝（`prod-read.sh:109-112`、`:133`、`:142`、`:147-148`），测试覆盖了注入字符、控制字符和超范围数字，`refuse` 用 `printf '%q'` 避免回显控制字符（`:33`）。结论：安全。
- 不可信输入/命令注入：表名只允许 `^[a-z][a-z0-9_]{0,63}$`，run id 只允许字母数字和 `:._-`，journal pattern 不含单引号；远端命令中无用户可控的 shell 元字符。结论：未发现注入路径。
- heredoc 里的 JS：`$` 只出现在 `$PROD_DATABASE` 和正则 `^auth$` 中；`$|` 在未加引号的 heredoc 中保持字面量，且测试读取的正是 ssh 实际收到的输入，正则会话完整。结论：能运行。
- 安全/只读：`new DatabaseSync(..., { readOnly: true })`（`:45`），SQL 只有 `SELECT`/`PRAGMA`；`status`、`mounts`、`disk`、`journal` 也是只读命令。结论：没有不可撤销操作。
- 资源耗尽：`rows` 有 `LIMIT 50`，字符串截断 160 字符，journal 行数 1–200 且上限 200；但 `runs-open` 没有 `LIMIT`（`:69-74`），极端情况下大量卡住的 run 会一次性输出；BLOB 在遮盖前已由 SQLite 读入内存。结论：一般可接受，`runs-open` 的上限是缺口。
- 规则/文档一致性：规则文件未被本改动触碰；文档仍准确说“只读”，但没写遮盖策略，且 `数据库里的运行状态` 的范围比实际 `rows` 能力窄。本改动不影响模型请求路径。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只在 `scripts/operations/prod-read.sh` 和 `test/tooling/prod-read.test.mjs`（以及 `.agents/reviews` 记录），没有修改系统提示、工具定义、历史消息、遮盖实现或组装请求的代码。发给模型的内容仍只有运行时原有路径在末尾追加；本次没有新增任何“每轮会变”的字段。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会影响模型请求。遮盖函数只依赖列名和值，不依赖前后文、时间或集合顺序。`rows` 的 SQL 没有 `ORDER BY`，多次执行的输出行序可能不同，但这是人工查看的终端输出，不进入模型请求。
3. **有没有对应的自动检查，反向用例会真的失败吗？** 有：`test/tooling/prod-read.test.mjs` 被 `ci/policy.json:242-243` 的 tooling 项目包含，而 `policy` 是 required 检查的前置。去掉 `hiddenColumn` 检查或二进制分支时，新测试会失败。但 `npm run check` 的 `check:steps`（`package.json:27`）没有运行 tooling 项目，快速模式本地不会自动跑；且缺少“不得过度遮盖”的反向用例、缺少真实远端 Node/真实 SQLite BLOB 的用例。
4. **改动产生或修改的每个值，各使用方都能接受吗？** `[hidden]`、`[binary N bytes]` 只被测试和人工输出消费，没有下游解析器，这一点可以接受。但同一改动带来的过宽遮盖会让 `rows`/`run` 的使用者（尤其 runbook 中读 `deployments.fencing_token` 和缓存 token 统计的步骤）无法接受这些值，这是实际影响。另：`account_json`/`challenge_json` 这类真正凭据列当前因表没有 `id`/`run_id` 而不可达，但规则本身没有覆盖，属于“两端校验没对齐”的隐患。
