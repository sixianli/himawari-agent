## 结论摘要

参数注入方面没有发现可利用的路径：`journal`、`rows`、`run` 的参数都经过白名单正则，表名还会和 `sqlite_master` 核对并用 `JSON.stringify` 加引号，列名来自 `PRAGMA`，`key` 只可能是硬编码的 `run_id`/`id`。真正的只读风险不在注入，而在“只读是否真的生效”没有执行级验证。另外发现一个 I-73 式的产生/消费不一致：`run` 子命令只认 UUID，拒绝生产里真实存在的 `run:<32位十六进制>`。

---

## 读代码证实的问题（按严重度）

### 1. 中：`run` 只接受 UUID 形式的 run-id，拒绝生产真实存在的 `run:<32位十六进制>`

- 文件:行：`scripts/operations/prod-read.sh:131`
- 问题：`run` 的正则要求 `run:` + 8-4-4-4-12 的 UUID；但生产里至少有两处会生成 `run:` + 32 位十六进制（无连字符）的 RunId，并写入 `runs` 表。`runs-open` 会把这些 id 列出来，用户复制后执行 `run <id>` 会被 65 拒绝。`rows` 的正则较宽（`prod-read.sh:146`），所以 `rows runs <id>` 反而能用，两个命令对同一个 id 的接受度不一致。
- 证据：
  - `scripts/operations/prod-read.sh:131`：
    ```bash
    require_match "$1" '^run:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' "run id"
    ```
  - `packages/application/src/services/thread-command-service.ts:49-56,223`：默认 runId 由 32 位十六进制指纹拼成
    ```ts
    return `thread-command:v1:${left.toString(16)...}${right.toString(16)...}`;
    ...
    function fingerprintSuffix(value: unknown): string {
      return threadCommandFingerprint(value).split(":").at(-1) ?? "invalid";
    }
    ...
    const runId = input.runId ?? createRunId(`run:${identity}`);
    ```
  - `apps/agent-service/src/production-background-runs.ts:203-206,254`：
    ```ts
    const identity = createHash("sha256")...digest("hex").slice(0, 32);
    ...
    runId: `run:${identity}` as RunId,
    ```
  - `packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts:1041-1056` 与 `sqlite-thread-operations.ts:995-1010`：后台通知 run 以 `input.notice.runId` 插入 `runs(id, ...)`。
- 建议：`run` 的 run-id 校验改用与领域一致的 `MACHINE_IDENTIFIER_PATTERN`（`packages/domain/src/identifiers.ts:39`：`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`），因为该值只作为 SQL 参数 `?` 传入，放宽不会引入注入；并补一条用 `run:`+32 位十六进制 的正向用例。`rows` 的 80 字符上限也可一并和 128 对齐。

### 2. 中：测试只比对远端命令文本，从不执行远端 JS，`readOnly`/`node:sqlite`/argv 索引均未验证

- 文件:行：`test/tooling/prod-read.test.mjs:21-24,91-99`
- 问题：假 `ssh` 只做 `printf '%s\n' "$*"` 和 `cat > input`，把 heredoc 原样存下来；测试只断言 `input` 包含 `{ readOnly: true }` 等字符串，从不把这段 JS 交给 Node 执行。因此以下都没有被验证：`require("node:sqlite")` 在生产 Node 上是否可用（是否需要 `--experimental-sqlite`）、`readOnly` 选项是否被接受并生效、`process.argv.slice(2)` 在 `node --no-warnings - ...` 下是否得到预期参数、SQL 是否真的能跑通。测试通过不等于“只读查询可用”。
- 证据：
  - `test/tooling/prod-read.test.mjs:21-24`：
    ```js
    path.join(directory, "ssh"),
    `#!/bin/bash\nprintf '%s\\n' "$*" >> ${calls}\ncat > ${input}\n`,
    ```
  - `test/tooling/prod-read.test.mjs:91-99`：
    ```js
    expect(result.input).toContain("{ readOnly: true }");
    expect(result.input).toContain("/var/lib/himawari/state/data/product.sqlite");
    expect(result.input).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/);
    ```
- 建议：在 CI（Linux/Hermes，不在 Mac）增加一个真正执行远端脚本的用例：造一个临时 SQLite 文件，让假 `ssh` 在识别到 `node --no-warnings -` 时用真实 Node 执行 stdin，并把数据库路径改为临时文件（可把路径做成脚本参数或测试专用环境变量）。这同时能覆盖 `node:sqlite` 可用性、`readOnly`、argv 索引和 SQL 列名。

### 3. 中：`npm run check` 不执行新测试，作者用“41 步通过”证明测试通过不成立

- 文件:行：`package.json` 的 `check:steps`、`scripts/run-all-checks.mjs:32`、`scripts/ci/run.mjs:235-242`
- 问题：`check:steps` 里没有任何一步会跑 `test/tooling/prod-read.test.mjs`；`check:ci-policy` 只做清单/配置校验，不执行测试文件。新测试实际是在 CI 的 `policy` job 里通过 `vitest(check.projects)`（`projects: ["tooling"]`）执行的。也就是说，作者说的“Hermes 上 npm run check 41 步通过”并不能说明这 23 个用例跑过；如果只依赖本地 `npm run check` 合并，回归不会被发现。
- 证据：
  - `scripts/run-all-checks.mjs:32`：
    ```js
    const names = stepNames(manifest.scripts["check:steps"]);
    ```
  - `scripts/ci/run.mjs:235-242`：
    ```js
    if (checkId === "policy") {
      await command("policy", tools.node, ["scripts/ci/check-policy.mjs", ...]);
      await command("toolchain", ...);
      await vitest(check.projects);
    }
    ```
  - `ci/policy.json` 的 `policy` check：`"projects": ["tooling"]`；`tooling` 的 include 含 `test/tooling/**/*.test.mjs`。
- 建议：把该测试显式加入 `check:steps`（例如新增 `check:prod-read`，像 `check:probe-sources` 一样 `vitest run --project tooling test/tooling/prod-read.test.mjs`），或在 PR 说明里明确“只在 CI policy job 覆盖”，不要用 41 步结果背书。

### 4. 低-中：只读保证只有 `readOnly: true`，没有 `PRAGMA query_only`，且生产库是 WAL

- 文件:行：`scripts/operations/prod-read.sh:45`；`packages/persistence-sqlite/src/sqlite-worker.ts:123`
- 问题：仓库里其他只读观察脚本普遍是“`readonly: true` + `PRAGMA query_only = ON`”（如 `scripts/operations/hermes-e2e-context-policy-diagnostic.mjs:169-173`），本脚本少了 `query_only` 这一层。生产库是 WAL（`database.pragma("journal_mode = WAL")`），只读连接在 WAL 下仍可能打开/写 `-shm`；如果 `readOnly` 没生效或被忽略，就不能严格保证“没有任何写生产机的路径”。这不是注入，但和“只读、不得写生产”的约束直接相关。
- 证据：
  - `scripts/operations/prod-read.sh:45`：
    ```js
    const database = new DatabaseSync("$PROD_DATABASE", { readOnly: true });
    ```
  - `packages/persistence-sqlite/src/sqlite-worker.ts:123`：
    ```ts
    database.pragma("journal_mode = WAL");
    ```
- 建议：在打开后加 `database.exec("PRAGMA query_only = ON")` 作为纵深防御；并在 CI 用临时 WAL 库验证“写语句会失败”。若想完全避免 `-shm` 写，可评估 `immutable=1`（但会读不到正在写入的 WAL，需权衡）。

### 5. 低：`database_query` 的 heredoc 没有加引号，本地 shell 会展开整段 JS

- 文件:行：`scripts/operations/prod-read.sh:43-45`
- 问题：`<<JS` 未加引号，本地 shell 会对整段 JS 做参数展开、命令替换和反斜杠处理。当前 JS 里只有 `$PROD_DATABASE` 一个 `$`，且是常量，所以没有现成问题；但这是脆弱写法，以后任何人在 JS 里加 `$` 或反引号都会在本地被展开，可能把本地值拼进远端脚本。
- 证据：
  ```bash
  ssh ... "cd /tmp && $PROD_NODE --no-warnings - $mode $first $second" <<JS
  const database = new DatabaseSync("$PROD_DATABASE", { readOnly: true });
  ```
- 建议：改成 `<<'JS'`，把数据库路径直接写成常量（或作为 Node 参数传入），让远端脚本字节固定，也便于测试。

### 6. 低：拒绝信息原样回显未转义的用户输入

- 文件:行：`scripts/operations/prod-read.sh:27,33`
- 问题：`refuse "$what is not allowed: $value"` 会把任意非法输入打到 stderr，包括 ANSI 转义序列、控制字符；在终端里可能造成显示/日志注入。不是远端命令注入，但属于不可信输入的反射。
- 证据：
  ```bash
  echo "PROD_READ_REFUSED: $1" >&2
  ...
  [[ "$value" =~ $pattern ]] || refuse "$what is not allowed: $value"
  ```
- 建议：回显前截断并过滤非打印字符，或只回显 `what` 和长度，不回显原文。

### 7. 低：规则文件与新增说明存在冲突/未同步

- 文件:行：`.agents/instructions/test-and-production-hosts.md:9,19`；`docs/runbooks/production-web-entry-runbook.md:79`
- 问题：同一文件第 9 行写“绝不使用 root 或生产账号……绝不触碰 `/opt/himawari`、`/etc/himawari`、`/var/lib/himawari` 或生产服务”，第 19 行新增“在 Mac 上只读查看生产机……用 `prod-read.sh`”，而脚本正是以 `root@84.247.157.41` 读取 `/var/lib/himawari/...`。第 4 行只在 `DELIVERY_MODE=fast` 时解除这些禁令，但第 19 行没有写这个前提。另外 `production-web-entry-runbook.md:79` 仍写“生产机上没有 sqlite3 和 node 命令；只读查库用 `ssh root@... 'sudo -u himawari-prod python3 -I -'`”，与本脚本用 `/opt/himawari/node/bin/node` 的做法没有互相引用，读者会得到两套不同的“只读查库”指引。
- 证据：
  - 第 9 行：“绝不使用 root 或生产账号，绝不读取生产机密，绝不触碰 `/opt/himawari`、`/etc/himawari`、`/var/lib/himawari` 或生产服务”
  - 第 19 行：“在 Mac 上只读查看生产机……用 `bash scripts/operations/prod-read.sh <查询>`”
  - `docs/runbooks/production-web-entry-runbook.md:79`：“生产机上没有 `sqlite3` 和 `node` 命令；只读查库用 `ssh root@84.247.157.41 'sudo -u himawari-prod python3 -I -' < 本地脚本`”
- 建议：在第 19 行显式写明这是对第 9 行禁令的只读例外（以及是否只在 fast 模式或所有模式生效），并在 runbook 里加一句指向 `prod-read.sh`，说明 Node 用绝对路径 `/opt/himawari/node/bin/node`。

### 8. 低：作者“不合规则以 65 退出”的说法与实现不完全一致

- 文件:行：`scripts/operations/prod-read.sh:23,28`；`test/tooling/prod-read.test.mjs:78-89`
- 问题：正则/范围不合法确实走 `refuse` 退出 65；但参数个数不对、未知查询走 `usage` 退出 64。测试也明确期望 64。作者的表述把所有“不合规则”都归为 65，不准确。
- 建议：文档/PR 说明改成“参数格式不合法 65，用法错误 64”，或统一为 65（但测试需同步）。

---

## 推测 / 未核实

- **`node:sqlite` 是否需要在生产 Node 上加 `--experimental-sqlite`**：脚本直接 `require("node:sqlite")`，没有加 flag。仓库其它地方都用 better-sqlite3，没有可对照的用法；测试也不执行这段 JS。生产基线是 Node 22.22.3（`ci/toolchain-lock.json`），我无法在本环境运行该版本，因此“无需 flag、`readOnly` 可用”属于未核实。若该版本仍需 flag，所有数据库查询都会失败。
- **生产机 `/opt/himawari/node/bin/node` 确实存在且可执行**：从 `scripts/delivery-mode/make-packet.py:502-503` 和 `scripts/delivery-mode/instances/andy-production.json` 推断存在，但未在实际生产机验证。
- **WAL 只读连接是否写 `-shm`**：取决于 SQLite 版本和文件权限，未在生产库上验证。
- **`runs-open` 无 LIMIT 的输出规模**：开放 run 数量通常有限，但未核实极端情况下是否会输出过多。

---

## 侧重检查

- **参数注入（journal 的 `-g`、rows 的表名/列名、node 参数）**：读代码未发现可利用注入。`journal` 模式只允许 `[A-Za-z0-9:._-]{3,80}` 且用单引号包住；`lines` 只允许 1-3 位数字并限制 1-200；`rows`/`columns` 表名只允许 `[a-z][a-z0-9_]{0,63}`，远端再用 `sqlite_master` 核对、用 `JSON.stringify` 加引号；列名来自 `PRAGMA table_info`；`key` 只可能是硬编码的 `run_id`/`id`；`run`/`rows` 的 run-id 只允许 shell 安全字符。注意 `journal -g` 是正则而非字面量，`.` 是通配符，但这只是查询语义，不是注入。
- **只读**：`readOnly: true` 已写，但没有 `query_only`，且测试不执行远端 JS，实际只读效果未验证（见问题 4）。
- **错误路径**：本地拒绝 65、用法错误 64、远端失败由 `set -e` 透传 ssh 退出码；远端 node 的 `PROD_READ_UNKNOWN_TABLE`/`PROD_READ_NO_RUN_COLUMN` 会以 ssh 非零退出。测试没有覆盖连接失败、远端 node 报错、未知表等路径。
- **不可信输入**：正则校验覆盖了 shell 元字符；但拒绝信息原样回显（问题 6）。
- **资源耗尽**：`rows` 有 `LIMIT 50` 且字符串截断 160；`journal` 有 `-n 1-200`；`runs-open` 无 LIMIT；`journal -g` 可能扫描较多日志。总体风险低。
- **不可撤销操作**：没有发现写生产机或改服务的路径；唯一的写风险是 WAL 只读连接的 `-shm`（问题 4）。
- **规则/文档一致性**：发现第 9 行与第 19 行的表述冲突、runbook 未同步（问题 7）；作者关于 65 的说法与实现不一致（问题 8）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。这个 diff 只新增了 `scripts/operations/prod-read.sh`、`test/tooling/prod-read.test.mjs` 和 `.agents/instructions/test-and-production-hosts.md` 的一行说明；没有触碰 `packages/prompt-catalog`、系统提示组装、工具定义、历史存储或出口遮盖。发给 Himawari 产品模型的内容仍然由原有机制只在末尾追加，每轮会变的值仍应在最后一条消息里。新增的说明文件是编码代理的指令文件，不是产品模型请求的一部分；即使它被注入某个编码代理的系统提示，也是一次性的静态修改，不是每轮变化的值。未发现它进入产品 prompt 路径（未核实是否存在其它把 `.agents/instructions` 注入产品提示的机制，但从代码结构看没有）。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会影响模型请求。脚本输出会随 journal/数据库状态变化，但这不是模型请求内容；如果代理把输出作为新消息追加，属于允许的“末尾追加”。脚本内部 `runs-open` 有 `ORDER BY created_at`，`tables` 有 `ORDER BY name`，`JSON.stringify` 保持列顺序；没有把时间戳或无序集合写进任何提示。因此不构成“同一段文字在不同请求里变字节”的问题。

**3. 有没有对应的自动检查？反向用例是否真的会失败？**
有测试，且 CI 会执行：`ci/policy.json` 的 `policy` job 选中 `tooling` 项目，`scripts/ci/run.mjs:235-242` 会跑 `vitest`，所以 `test/tooling/prod-read.test.mjs` 的 23 个用例会在 CI 执行。13 个不安全输入用例和 6 个用法用例都检查了退出码且 `calls === ""`；如果去掉对应正则/范围校验，这些反向用例会失败（例如 `journal "x'; rm -rf /"` 会变成 code 0 且产生 ssh 调用）。但两点不足：`npm run check` 的 41 步不含这个测试，作者引用的那次运行没有验证它；测试只检查远端命令文本，从不执行远端 JS，因此只读、`node:sqlite` 可用性、argv 索引和 SQL 正确性没有被自动检查覆盖（见问题 2、3）。

**4. 每个值产生的地方和使用它的地方都能接受吗？**
- `run` 的 run-id：**不能**。生产者 `thread-command-service.ts:223`/`production-background-runs.ts:254` 会产生 `run:<32hex>`，消费者 `prod-read.sh:131` 只接受 UUID，见问题 1。
- `PROD_TARGET`、`PROD_UNIT`、`PROD_NODE`、`PROD_DATABASE`：与仓库其它引用一致（`scripts/delivery-mode/instances/andy-production.json` 的 `himawari-prod.service`、`/var/lib/himawari/state`；`scripts/delivery-mode/make-packet.py:502-503` 的 `/opt/himawari/node/bin/node`；`docs/runbooks/production-web-entry-runbook.md:79` 的数据库路径），未发现不一致。
- SQL 列名：`runs` 表的 `id, thread_id, status, revision, created_at, updated_at` 都在 `0001_initial_product_schema.sql:141-153` 中存在；`rows` 的 `run_id`/`id` 选择逻辑与各表 schema 一致。
- 退出码：`usage` 产生 64，`refuse` 产生 65；测试按 64/65 分别断言，但作者说明只写了 65，见问题 8。
- 表名/列名/run-id 正则：`rows` 的 80 字符上限比领域 `MACHINE_IDENTIFIER_PATTERN` 的 128 窄，可能拒绝极长但合法的 RunId（低风险，见问题 1 建议）。
- `readOnly` 这个“配置键”：产生于脚本，消费于 `node:sqlite`；未在实际生产 Node 上验证是否被接受，见“推测/未核实”。
