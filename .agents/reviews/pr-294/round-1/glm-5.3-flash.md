Bash 只允许 git 命令，改用搜索工具继续核对。
## 复核结论（按严重度排列）

### 高 · scripts/operations/prod-read.sh:106 — `run` 子命令的正则与生产真实 run id 格式不符，对真实数据永远拒绝

- 证据（读代码证实）：
  - 脚本要求 `^run:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`（UUID 带连字符，prod-read.sh 的 `run` 分支）。
  - 生产 `runs.id` 的实际写入端：`packages/application/src/services/thread-command-service.ts:223` `createRunId(\`run:${identity}\`)`，而 `identity` 是 `threadCommandFingerprint(...).split(":").at(-1)`（thread-command-service.ts:54-55），指纹格式是 ``thread-command:v1:` + 16+16 位十六进制``（thread-command-service.ts:49-51），即真实 id 形如 `run:<32位无连字符hex>`；后台运行同样如此（apps/agent-service/src/production-background-runs.ts:254）。全库未发现 UUID 形式的 run id 生成点。
- 后果：`prod-read.sh run <真实id>` 永远以 65 拒绝，子命令不可用。fail-closed，无安全风险，但文档和 usage 都宣称该查询存在。
- 掩盖原因：测试的正例 id `run:17a4102d-1cb7-4487-ba7d-97074306d1bc`（test/tooling/prod-read.test.mjs:8）本身就是一个不存在的格式，且 `run` 只有负向用例（test 34-35 行）、没有正向用例——这正是 I-73 那类「产生端与消费端校验没对上、复核只看 diff」的重演。
- 建议：正则改成 `^run:[0-9a-f]{32}$`（如需兼容 muse-intake 外部 id，可放宽为 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`，与 production-muse-intake.ts:66 的 KEY_PATTERN 对齐），并补一个真实格式的 `run` 正向用例。

### 中 · package.json:27 / ci/policy.json:83,148 — 新测试未接入任何本地门槛，作者的说法会让人误以为 `npm run check` 覆盖了它

- 证据（读代码证实）：`npm run check` 的 41 步（逐一数过 package.json:27，确为 41）没有任何一步运行 prod-read.test.mjs；`npm test` 走 `scripts/ci/local.mjs --check test`，而 `test` 检查的项目是 `["unit","contracts","integration","e2e","pi-compat"]`（ci/policy.json:83），不含 tooling。它只会被 CI 的 `coverage` 检查跑到（ci/policy.json:148 projects 含 `tooling`，vitest.workspace.ts:47 对应 include `test/tooling/**/*.test.mjs`，ci/policy.json:243）。
- 后果：作者说「Hermes 上 npm run check 41 步通过」属实，但那 41 步完全不执行新测试；在 Hermes 本地按惯例跑 `npm run check` 或 `npm test` 都测不到这个脚本。
- 建议：给 `check` 加一步，或并入某个本地会跑的检查（现有 `check:probe-sources` 等模式可套用）。

### 低 · test/tooling/prod-read.test.mjs — 覆盖缺口

- 证据（读代码证实）：`columns`、`run` 只有负向用例，没有正向用例（正向用例能锁住远端命令原文，status/journal/rows 都有，这两个没有）；`journal` 默认 40 行分支未测；远端 JS 的运行时行为（`requireTable` 白名单抛错、`PROD_READ_NO_RUN_COLUMN`、`rows` 的 run_id/id 回退、160 字符截断）只在发送文本上做 contains/notMatch 断言，不执行验证——远端执行本地难测，属固有局限，但至少应给 `rows` 加一条真实格式 run id 的正向用例。
- 推测（未核实）：ssh 连接失败（BatchMode 拒绝、超时）时 `set -e` 使脚本以 ssh 的退出码（如 255）退出，非 64/65；无用例覆盖，不算写路径，属报错路径上未定义的部分。作者重点问的「报错路径」里这是唯一没定义行为的地方。

### 安全与只读核对（读代码证实，未发现注入或写路径）

- journal 模式：字符类 `[A-Za-z0-9:._-]{3,80}` 不含引号、空格、`$`、反引号、反斜杠，值又被单引号包裹，无法逃逸；`-g` 的值紧跟其后，被 journalctl 的 getopt 当作 `-g` 的参数整体吃掉，不能注入额外选项。测试负例（`x'; rm -rf /; echo '`、`$(id)`、`a b`、`5; id` 等）覆盖到位且断言 `calls === ""`（未连接）。
- rows/run/columns：表名限 `[a-z][a-z0-9_]{0,63}`，id 限 `[A-Za-z0-9:._-]{3,80}`，都是 shell 安全字符；值以 argv 传入（`process.argv.slice(2)`），JS 里表名先过 `requireTable` 白名单、再用 `JSON.stringify` 引用进 `PRAGMA table_info` 和 `SELECT ... FROM`（等价于带引号的 SQL 标识符），行值走 prepared statement 参数（`.all(second)`）。远端命令由固定字符串拼成，无可注入点。
- 只读：远端固定命令均为 systemctl show/journalctl/findmnt/df；数据库部分 `new DatabaseSync(..., { readOnly: true })`，脚本内无任何写语句（测试的 notMatch 断言覆盖 INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/REPLACE）。`runs` 表无 `run_id` 列（0001_initial_product_schema.sql:141-153），`rows` 回退到 `id` 键，正确。
- 未核实（无法上网/连生产机）：生产机 `/opt/himawari/node` 的 node 版本是否支持 `node:sqlite` 的 `readOnly` 选项（仓库 engines 为 >=22.19.0，package.json:8）；product.sqlite 是否为 WAL（readOnly 打开 WAL 的行为依赖 shm 现状）。这两点属远端事实。

### 作者说法逐条核对

- 「23 个用例」：属实（逐一数：2+13+6+1+1=23）。
- 「用假 ssh 检查远端命令原文」：属实（test 9-20、79-86 行断言 `calls` 精确匹配）。
- 「npm run check 41 步通过」：步骤数属实（41 步核对无误），是否真通过未核实；但该说法易误导——新测试不在那 41 步里（见「中」条）。
- 「不合规则以 65 退出」：部分不准确——只有正则拒绝和行数超界是 65，参数个数错误/未知查询是 64（usage）。文档未写退出码，不构成文档不一致。
- 「数据库部分用固定脚本、readOnly: true」「不得有写生产机路径」「参数不能注入远端命令或 SQL」：均与代码一致。

## 侧重检查（走过的流程）

最普通流程 `bash scripts/operations/prod-read.sh runs-open` 从入口走到结束：入口 arity 检查 → `case` 命中 → `database_query open`（`first`/`second` 为空串拼入远端命令）→ 固定 ssh 命令 + heredoc JS → `readOnly` 打开 → `GROUP BY status` 输出 JSON。走过的每一段 shell 逻辑都有测试或被负例覆盖；**无测试覆盖的代码路径**：远端 JS 的全部运行时行为（只能在生产机执行）、`columns`/`run` 正向分支、`journal` 默认行数分支、ssh 连接失败路径。结论：shell/注入面覆盖充分，测试接线与远端 JS 是两个缺口。

## 必答问题

1. **不会改变模型已见过的请求开头。**本改动不含任何组装或修改模型请求的代码；唯一文字改动是 `.agents/instructions/test-and-production-hosts.md:19` 加的一行静态说明（开发者代理指令，不进入 Himawari 产品运行时的请求组装），内容确定、无每轮变化的值。发给模型的内容仍只在末尾追加、每轮变化的值仍在最后一条消息——本次 diff 对此无任何触碰。
2. **不会。**新增的脚本与文档都是静态文本；脚本输出含时间戳（journal、ActiveEnterTimestamp），但只进终端，不进模型请求，不构成「同一段文字不同字节」。
3. **有自动检查且反向用例真实会失败**：负例断言 exit 65 且 `calls === ""`；若移除正则校验，脚本会调用（假）ssh，`calls` 非空且退出码改变，测试即失败。但该测试不在 `npm run check` 和 `npm test` 中运行，只在 CI coverage 检查中执行（见「中」条）。
4. **产生的每个值核对过**：脚本路径、查询名、退出码 64/65、`PROD_READ_REFUSED` 前缀、目标常量——产生处（脚本）与唯一使用处（文档第 19 行 + 测试）一致。唯一两端不匹配的是 run id 格式：消费端（脚本正则）假设 `run:UUID`，产生端（thread-command-service.ts:223）产出 `run:<32hex>`，即高严重度问题；这正是 I-73 要求的「把值交给真实校验」没做的地方。
