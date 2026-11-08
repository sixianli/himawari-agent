## 复核结论

我按增量 `1894c58..496bd77` 逐项核对了新正则的使用端（脚本、SQLite、测试、说明），并追溯了生产 run id 的产生处。增量本身没有引入命令注入，模型请求开头也没有被改变；发现的问题主要是安全检查范围、校验一致性和测试挂载。

## 读代码证实的问题

### 1【中】通用 `rows` 能读到生产机密，与说明里的“运行状态 / 绝不读取生产机密”冲突

- 文件：`scripts/operations/prod-read.sh:80-88`、`.agents/instructions/test-and-production-hosts.md:9,19`、`packages/persistence-sqlite/src/migrations/0058_web_push.sql:1-7`
- 问题：`rows` 只根据“表里有 `run_id` 或 `id`”选键，不限制表或列，因此能查询任何带 `id` 的表。`web_push_subscriptions` 的 `id` 是主键，表里有 `endpoint`、`p256dh`、`auth`；其中 `auth` 是 Web Push 的认证密钥，长度 ≤64，不会被 `shorten` 截断，会完整打印到 Mac 终端。说明第 19 行把入口范围写成“数据库里的运行状态”，同文件第 9 行仍写着“绝不读取生产机密”，代码没有实现这个边界。
- 证据：
  - `requireTable(first); const columns = columnNames(first); const key = columns.includes("run_id") ? "run_id" : columns.includes("id") ? "id" : null;`（`:81-83`）
  - `.prepare("SELECT * FROM " + JSON.stringify(first) + " WHERE " + key + " = ? LIMIT 50").all(second).map(shorten);`（`:85-88`）
  - `typeof value === "string" && value.length > 160 ? value.slice(0, 160) + "..." : value`（`:49-51`，只处理字符串，BLOB 交给 `JSON.stringify`）
  - `auth TEXT NOT NULL CHECK (length(auth) BETWEEN 1 AND 64)`（`0058_web_push.sql:7`）
- 建议：给 `rows` 加表/列 allowlist（例如只允许 `runs`、`thread_messages`、`turns`、`triggers`、`run_checkpoints` 这类运行态表）；至少排除 `web_push_subscriptions.auth/p256dh` 等凭据列并做掩码；对 `Uint8Array`/BLOB 单独输出长度而不是交给 `JSON.stringify`。补一条反向用例，断言 `rows web_push_subscriptions ...` 被拒绝或已脱敏。

### 2【低中】journal 行数的前导零会按八进制解释

- 文件：`scripts/operations/prod-read.sh:108-111`
- 问题：正则允许 `0` 开头的 1-3 位数字，但随后用 bash 的 `-ge/-le` 做算术，前导零被当成八进制。`08`、`09` 会被当作非法八进制而错误拒绝；`0310` 会以八进制 200 通过 1-200，却把字面 `0310` 传给 `journalctl`。若 `journalctl` 按十进制解析（推测），实际会取 310 行，超过文档写的 200 上限。
- 证据：`require_match "$lines" '^[0-9]{1,3}$' "journal line count"`；`[ "$lines" -ge 1 ] && [ "$lines" -le 200 ] || refuse ...`；`remote "... -n $lines"`（`:108-111`）
- 建议：范围检查前先规范化，例如 `lines=$((10#$lines))`，再校验 1-200 并把十进制值传给 `journalctl`；补 `08`、`009`、`0310` 的测试。

### 3【低】`run` 与 `rows` 的 run id 校验不一致

- 文件：`scripts/operations/prod-read.sh:131`、`:146`
- 问题：`run` 要求 `run:` 前缀，前缀后 1-120 位（总长最多 124）；`rows` 接受任意 3-80 位同类字符、不要求前缀。一个合法的 81-124 字符 run id 用 `run` 可以、用 `rows` 会被拒；反过来 `rows` 也接受非 run 的 id，但 usage 把两者都标成 `<run-id>`。当前生产 id（`run:`+32 位十六进制，共 35 字符）两边都能过，所以不是当前故障。
- 证据：`require_match "$1" '^run:[A-Za-z0-9._:-]{1,120}$' "run id"`（`:131`）；`require_match "$2" '^[A-Za-z0-9:._-]{3,80}$' "run id"`（`:146`）
- 建议：抽一个共享的校验函数；或者明确 `rows` 的参数是通用 `<id>`、单独命名并说明上限差异，至少把两处上限统一。

### 4【低】“生产格式是 32 位十六进制”这个说法只覆盖了当前主路径

- 文件：`test/tooling/prod-read.test.mjs:105-109`；提交说明
- 问题：测试名和提交说明把生产格式固定成 `run:`+32 位十六进制。当前主路径确实如此（`thread-command-service.ts:40-56,223` 的 `fingerprintSuffix` 返回 32 位十六进制；`production-background-runs.ts:203-206,254` 也是 `slice(0,32)` 后再加 `run:`），但仓库里的生产/资格证据还有 UUID 和短 id 形式，例如 `run:dcf2075d-1237-4f10-9e81-b427e0a7368f`、`run:bafb641b`。新正则能接受它们，但没有任何测试锁住这些格式。
- 证据：`test/qualification/evidence/hermes-web-2026-09-11/experience/protected-live-performance.json:212`；`docs/engineering-casebook.md:1468`
- 建议：补 `run:`+UUID、`run:`+短十六进制的正例；把测试名和提交说明改成“当前代码产生 32 位十六进制，历史生产 id 还有 UUID/短 id 形式”。

### 5【低】新测试没有进入本地必过门槛，数据库查询也没有被执行

- 文件：`test/tooling/prod-read.test.mjs`、`ci/policy.json:242-245`、`ci/policy.json:148`、`scripts/run-all-checks.mjs:32`
- 问题：测试文件属于 `tooling` 项目，但 `npm run check` 只执行 `check:steps` 里列出的脚本，`check:steps` 没有运行 tooling 项目；只有 CI 的 `coverage` 检查包含 `tooling`，而快速模式合并不等 CI。该测试里 `ssh` 被 stub，`node:sqlite` 的 SQL/表结构兼容性从未真正执行，只断言了 heredoc 文本包含 `readOnly` 和没有写语句。所以这次新增的反向用例只有手动跑时才生效，SQL 侧没有自动证据。
- 证据：`scripts/run-all-checks.mjs:32` 只解析 `check:steps`；`ci/policy.json:148` 的 `coverage` 项目才是 `["unit","contracts","tooling","integration"]`；`ci/policy.json:242-245` 是新增测试所属项目。
- 建议：加一个 `check:prod-read` 到 `check:steps`（或并入 `check:security-review`）；再加一个用临时 SQLite 实际执行数据库脚本的测试，真正验证 `runs`、`columns`、`rows` 的查询和只读打开。

### 6【低】`DELIVERY_MODE=fast` 的限制只在文档里，脚本不检查

- 文件：`.agents/instructions/test-and-production-hosts.md:19`、`scripts/operations/prod-read.sh`
- 问题：说明把以 root 读生产限定在 `DELIVERY_MODE` 写着 `fast` 时，但脚本没有任何 `DELIVERY_MODE` 检查；完整模式下直接运行仍会以 root 连生产。
- 建议：脚本启动时读取仓库根的 `DELIVERY_MODE` 并要求 `fast`（或要求显式 `--force` 并打印警告），让规则在代码里也成立。

## 推测 / 未核实

- `journalctl` 把 `0310` 按十进制读成 310：基于常见 systemd 解析行为推测，未在本机运行核实。
- 资格证据里的 `run:dcf2075d-...` 等就是当时数据库 `runs.id`：从字段名和上下文看很可能，但未连生产核实。
- `.agents/reviews/pr-294/round-1/*` 的内容未核实：git 对 `records-path` 拒绝读取，工作区 sparse checkout 也没有这些文件；从 diff 看它们是评审记录，不进入产品模型请求。

## 侧重检查

- 错误路径：参数数量错 → usage 退出 64；非法值 → refuse 退出 65 且在任何 ssh 之前；测试覆盖了这些路径。发现 journal 前导零的边界问题（上面第 2 条）。
- 不可信输入 / 注入：`run`、`rows`、`journal`、表名的字符集都不含空格、引号、`;`、`$`、反引号等 shell 元字符，虽然远程命令里是未加引号插值，当前不能注入；`journal` 的 pattern 还被单引号包住。`printf '%q'` 确实阻止了 ESC 等控制字符原样回显。没有发现本次改动新增的注入面。
- 安全：本次正则放宽没有削弱注入防线；但通用 `rows` 的读取范围过大，能读到 `web_push_subscriptions.auth` 这类机密（第 1 条）；入口的 fast 模式限制未落到脚本（第 6 条）。
- 资源耗尽：`journal` 有 1-200 行上限（但有八进制漏洞）；`rows` LIMIT 50；`run` 单行；`runs-open` 无 LIMIT（开放 run 通常很少，未发现实际风险）；`memory_episodes.embedding` 等 BLOB 若被 `rows` 命中会被 `JSON.stringify` 展开，建议一并处理。
- 不可撤销操作：脚本全部是 `systemctl show`、`journalctl`、`findmnt`、`df` 和只读 SQLite 查询，没有写操作；`readOnly: true` 也在文本上核实。未发现不可撤销路径。
- 规则/文档一致性：fast 模式例外与 `delivery-mode.md:29` 一致；runbook 里 `/opt/himawari/node/bin/node` 与脚本 `PROD_NODE` 一致；`runs-open` 用到的 `runs` 列和 `completed/failed/cancelled` 状态值与 `0001_initial_product_schema.sql:141-153` 一致。主要不一致是第 1 条的“运行状态”范围和“绝不读取生产机密”。

## 必答问题

1. **会不会改变模型已经见过的请求开头？不会。** 改动只碰 `.agents/instructions/`（编码代理说明）、`.agents/reviews/`（复核记录）、`docs/runbooks/`、`scripts/operations/prod-read.sh` 和 `test/tooling/prod-read.test.mjs`；没有碰 `packages/prompt-catalog`、`packages/runtime-pi`、线程提示组装或遮盖路径。`check:prompt-prefix` 只跑 `packages/runtime-pi/test/prompt-prefix.compat.test.ts`（`scripts/check-prompt-prefix.mjs:9`），该文件未改。发给模型的内容仍然只在末尾追加，每轮会变的值也没有被移到前面。唯一涉及模型调用的是新增的 `.agents/reviews/...prompt.md`，那是复核模型（Magpie/CodeBuddy）的输入，不是 Himawari 的请求开头。

2. **会不会让同一段文字在不同请求里变成不同字节？对模型请求不会。** 这个改动不进入任何模型请求。脚本里新用的 `printf '%q'` 输出可能随 bash 版本/locale 略有不同，但只写 stderr，不进入模型。`runs-summary` 的 `GROUP BY status` 没有 `ORDER BY`，SQLite 可能给出不同行序，但这是终端输出，也不是模型请求。

3. **有没有对应的自动检查，反向用例真的会失败吗？有，但不完整。** 新测试存在，且反向用例是实的：旧脚本的正则拒绝 `run:`+32 位十六进制，新正例会失败；旧脚本直接回显原始 ESC，控制字符用例会失败（提交说明也写“旧脚本跑新测试 2 个失败”，与代码分析一致）。但该测试不在 `npm run check` 的 `check:steps` 里，快速模式下不等 CI；且数据库脚本只用 stub 检查文本，没有真正执行 SQL。因此它是“可手动运行的测试”，还不是本地硬门槛。

4. **改动产生/修改的每个值，使用端都能接受吗？** 当前能通过，但有一致性缺口。
   - run id 产生处：`thread-command-service.ts:40-56,223` 产生 `run:`+32 位十六进制；`production-background-runs.ts:203-206,254` 同样是 `run:`+32 位十六进制。历史证据里还有 `run:`+UUID、`run:`+短十六进制。
   - run id 使用处：`prod-read.sh:131` 的 run 正则、`:146` 的 rows 正则、`:74` 的 `SELECT * FROM runs WHERE id = ?`（`runs.id` 是 `TEXT PRIMARY KEY`）。新正则都能接受上述格式，SQLite 侧是文本等值比较，后端不会拒绝。
   - 不一致：`run` 与 `rows` 的前缀要求和长度上限不同（第 3 条）；`rows` 还能读 `web_push_subscriptions` 等不在“运行状态”范围内的表（第 1 条）。
   - 文档侧：`DELIVERY_MODE` 的值在 `delivery-mode.md:6-7` 定义，新说明第 19 行按 `fast` 限定，这一点一致；runbook 的 node 绝对路径与脚本一致。
   - **作者说法核对**：正则“放宽为 run: 加 1-120 位”属实；“拒绝信息用 printf %q 回显”属实；“补 run、columns、journal 默认行数正例和控制字符用例”属实；“两个说明各补一句”属实；“生产 run id 是 run:+32 位十六进制”只对当前主路径成立，历史生产证据还有 UUID/短 id 形式；“rows 与 run 校验一致”不成立（第 3 条）；“说明与代码一致”在“数据库里的运行状态 / 绝不读取生产机密”这一点上不成立（第 1 条）。
