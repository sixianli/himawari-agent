## 结论摘要

作者关于 P2-1 的几项核心说法大体成立，但有两处不成立或说过头：**清单 C-1 并没有改成“已获授权”**；**新的 lstat 检查只在“group/other 可写 + 最后一段符号链接”这一窄范围内有效，并不是作者说的“非他人可写”，也没有校验收到的文件是否就是生产部署约定的那个文件**。另外 lstat 失败路径会抛出原始堆栈，和“只输出固定代码”的说法不符。

---

## 读代码证实的问题（按严重度从高到低）

### 1. 中 — lstat 检查不能证明“配置可信”，也没有校验生产部署的文件属主/父目录

- 文件:行：`scripts/operations/prod-read.sh:116-117`
- 问题：检查只有 `isFile`、`isSymbolicLink`、`(mode & 0o022)`，没有校验 uid/gid、`nlink`、父目录属主和权限。因为远程以 root 运行，lstat 拿到的元数据是真实的，这一点有效；但“非他人可写”只等于“非 group/other 可写”。生产配置按部署脚本是 **uid 999、mode 600**，即对非 root 的服务账号 `himawari-prod` 可写，却会通过检查；一个陌生非 root 用户拥有的 0600/0644 文件也会通过；world-readable 的 0644 同样通过。
- 证据：
  - `scripts/operations/prod-read.sh:117`：`if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) fail("PROD_READ_CONFIG_UNSAFE");`
  - `scripts/delivery-mode/packet-template/signing/prepare-__PKT_LABEL__-snapshot.sh:69`：`[[ $(stat -c %u "$config") == 999 && $(stat -c %a "$config") == 600 ]]`
- 建议：按部署脚本已有的不变量校验 `uid == 999`（或显式允许 root）、`mode & 0o077 == 0`（至少拒绝 group/other 写，若目标含敏感文字也可拒绝 group/other 读）、`nlink == 1`，并检查 `/etc/himawari` 父目录不被非 root 改写。否则文档不要把它说成“非他人可写”。

### 2. 中 — 清单 C-1 仍然写着“待 Andy 授权读取”，与 C 节/H 节“已获授权”矛盾，作者“C-1 已改”的说法不实

- 文件:行：`docs/agent-rulebook-inventory.md:161`（对照 `:149`、`:210`、`:220`）
- 问题：本轮只改了 C 节末尾（`:149`）和 H 节（`:220`），C-1 表格行仍写“待 Andy 授权读取后补全”；G 节 `:210` 仍写“记忆库里的 `rule` 类记忆：需要先授权读生产库”。这直接和 `:149` 的“Andy 已同意只读列出”、`:220` 的“已获授权，待读取”冲突，是本次新引入的前后矛盾。
- 证据：
  - `docs/agent-rulebook-inventory.md:161`：`生产值在 /etc/himawari/config.json，待 Andy 授权读取后补全`
  - `docs/agent-rulebook-inventory.md:220`：`Andy 已同意只读（2026-11-09），已获授权，待读取。`
  - `docs/agent-rulebook-inventory.md:210`：`记忆库里的 rule 类记忆：需要先授权读生产库，不在 19 条之内。`
- 建议：把 C-1 的出处列改成与 H 节一致（“Andy 已获授权，待读取”），并同步改 G 节 `:210`；若实际授权只覆盖两个固定查询，则反过来修正 H 节的措辞。

### 3. 中低 — `lstatSync` 在 try/catch 之外，缺文件/不可 stat 时输出原始堆栈，不是固定代码

- 文件:行：`scripts/operations/prod-read.sh:116-123`
- 问题：作者说“JSON 损坏和其他错误只输出固定代码（PROD_READ_CONFIG_UNSAFE、PROD_READ_CONFIG_UNREADABLE）”。但 `lstatSync` 在 try 之外，文件不存在、权限不足、ELOOP 等会抛出未捕获异常，Node 直接打印堆栈（含路径），不会输出 `PROD_READ_CONFIG_UNREADABLE`。测试只覆盖“文件存在但 JSON 损坏”（`:255`），没有覆盖不存在的文件或 lstat 失败。
- 证据：
  - `scripts/operations/prod-read.sh:116`：`const stat = lstatSync(process.argv[2]);`
  - `scripts/operations/prod-read.sh:119-123`：try/catch 只包住 `readFileSync` 与 `JSON.parse`
  - `test/tooling/prod-read.test.mjs:255`：`writeFileSync(file, "{ not json token-value");`（错误用例仍先创建文件）
- 建议：把 `lstatSync` 也放进 try/catch 并映射为 `PROD_READ_CONFIG_UNREADABLE`；补一条“传不存在的路径”用例，断言 stderr 是固定代码且不含堆栈。

### 4. 低 — lstat 后再按路径读取存在 TOCTOU，且读取会跟随符号链接；`isSymbolicLink()` 实际是死分支

- 文件:行：`scripts/operations/prod-read.sh:116-120`；对照仓库已有的安全读取写法 `scripts/delivery-mode/packet-template/signing/prepare-__PKT_LABEL__-snapshot.sh:36-43`
- 问题：先 `lstatSync(path)`，再 `readFileSync(path)`，第二次打开会重新解析路径并跟随符号链接；如果检查后文件被替换成符号链接，检查结果不成立。另外 lstat 已不跟随最后一段，符号链接时 `!stat.isFile()` 已为真，`stat.isSymbolicLink()` 永远不会被求值为真，属于冗余。中间路径段（例如把 `/etc/himawari` 换成符号链接）也会被 lstat 解析而不被发现。
- 证据：
  - `scripts/operations/prod-read.sh:116-120`：`const stat = lstatSync(process.argv[2]); ... configuration = JSON.parse(readFileSync(process.argv[2], "utf8"));`
  - 仓库自己的读取器 `prepare-__PKT_LABEL__-snapshot.sh:36-43`：`os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)`，随后 `os.fstat(descriptor)` 并与 `filename.lstat()` 比较 dev/ino/uid/gid/mode/nlink/size/mtime/ctime。
- 建议：用 `openSync(path, O_RDONLY | O_NOFOLLOW)` 打开，`fstatSync(fd)` 与 lstat 身份逐项比较后从 fd 读取；不要用两次路径解析。可删掉冗余的 `isSymbolicLink()`，或在注释/说明里明确它只是防御性写法。

### 5. 低 — 清单说“条数”，但查询上限 500，超过 500 时无法给出真实总条数

- 文件:行：`docs/agent-rulebook-inventory.md:149`
- 问题：文字是“所有 `rule` 类记忆的条数、状态、记录日期、是否待确认，最多 500 条（最新的）”。如果实际超过 500 条，只能列出最新 500 条，“所有…条数”这个说法无法兑现。
- 证据：`scripts/operations/prod-read.sh:88` 为 `... ORDER BY recorded_at DESC, id LIMIT 500`；`docs/agent-rulebook-inventory.md:149` 用了“所有…条数”。
- 建议：改成“最多列出最新 500 条；若需确认真实总数需另做 count 查询/另行授权”。

### 6. 低/未核实 — 规则文件把 `tables`、`columns`、`rows` 写进授权范围，但“同意读这两样”只点名两个固定查询

- 文件:行：`.agents/instructions/test-and-production-hosts.md:19`
- 问题：本轮加了“（含 `tables`、`columns`、`rows`）”，但同时写“Andy … 同意读这两样”，而“这两样”指 `rule-memories` 和 `system-instruction`。三个结构查询在基准版本里已经存在（`27451df` 的 `prod-read.sh` 已含 `tables/columns/rows`），所以不是本轮新增能力，但文档没有给这三样单独的授权依据。
- 证据：`git show 27451df...:scripts/operations/prod-read.sh` 已含 `tables`、`columns`、`rows`；`.agents/instructions/test-and-production-hosts.md:19` 的“这两样”紧接两个固定查询。
- 建议：标为“未核实”：确认 `tables/columns/rows` 是否也在既有授权内，或把“这两样”改成“这些固定查询”。

---

## 推测 / 未核实

- **生产配置当前是否为普通文件**：`S7` 通过写 `config.json.next` 再改名替换（`scripts/delivery-mode/packet-template/systemd/P9-switch-start-readback.md:60`），所以现在大概率是普通文件；若是，新增的符号链接拒绝不会误伤。但未在真实生产机上核对。
- **TOCTOU / 陌生属主文件是否可被利用**：取决于 `/etc/himawari` 目录的属主和权限；仓库里未直接读到该目录的运行时权限，未核实。
- **P1-4 的 `cancelled` 状态**：我做了跨端核对（见 Q4），消费方基本一致；仅有一个行为差异：`production-memory-control.ts:866` 只挡“已 cancelled 且 action 不是 cancel”，所以对已 cancelled 再次 `cancel` 仍会重写 `dismissedAt/updatedAt`，而 `production-reminder-writer.ts:294` 会直接返回。是否在意这个差异未核实，推测影响很小。

---

## 核对作者说法逐条

| 作者说法 | 结论 |
| --- | --- |
| system-instruction 读配置前检查普通文件、非符号链接、非他人可写 | 基本属实，但“非他人可写”只覆盖 group/other，见问题 1 |
| JSON 损坏和其他错误只输出固定代码 | 部分不实：lstat 错误未捕获，见问题 3 |
| 加符号链接、可写、损坏三个用例 | 属实：`test/tooling/prod-read.test.mjs:255-278` |
| rule-memories 改为 `ORDER BY recorded_at DESC, id LIMIT 500` | 属实：`prod-read.sh:88` |
| 用例插 501 行验证只返回最新 500 条 | 属实：`prod-read.test.mjs:200-214` |
| 测试行用 biome 2.3.5 格式化 | 版本属实（`package.json:100`、`package-lock.json:16`）；是否已格式化未运行，未核实 |
| 清单 C-1 和 C 节改为已获授权待读取 | C 节/H 节属实；**C-1 不实**，见问题 2 |
| 原话说明已改 | 属实：`docs/agent-rulebook-inventory.md:149` 已写密文存储、不读原话 |
| 规则文件范围补上 tables、columns、rows | 属实：`.agents/instructions/test-and-production-hosts.md:19` |

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本轮的 P2-1 增量只改 `scripts/operations/prod-read.sh`、`test/tooling/prod-read.test.mjs`、`.agents/instructions/test-and-production-hosts.md`、`docs/agent-rulebook-inventory.md`（外加 review 记录）。这些都不在组装模型请求的路径里（`packages/prompt-catalog`、`packages/runtime-pi`、agent-service 的提示词拼装、出口遮盖都不涉及）。基准到 head 的更大 diff 里的其他文件（reminder 数据库/迁移、网关约定删除、control-center 清单）也不是请求开头组装代码。因此：发给模型的内容没有新增任何东西，也就不存在“往开头插值”或“每轮变化值跑到最后一条之外”的问题；规则“只在末尾追加”没有被触碰。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会（对模型请求而言）。** 改动没有加入任何会进入提示词的时间、无序集合或依赖前后文的遮盖。对运维查询本身，`rule-memories` 的 `ORDER BY recorded_at DESC, id` 反而比原来的 `ORDER BY recorded_at` 更确定（原来是同时间并列时顺序未指定）；`SELECT` 列固定，`JSON.stringify` 的键顺序由固定列顺序决定，字节是确定的。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

**有。** `test/tooling/prod-read.test.mjs` 命中 `ci/policy.json` 的 tooling 项目 include（`test/tooling/**/*.test.mjs`），随 tooling 项目在 CI 的 policy/coverage 作业运行。按静态推演，反向用例确实会在修复前失败：
- 符号链接：旧代码 `readFileSync` 跟随链接成功，测试要求非零退出且 stderr 含 `PROD_READ_CONFIG_UNSAFE`，会失败。
- 可写文件：旧代码无 mode 检查，测试要求 `PROD_READ_CONFIG_UNSAFE`，会失败。
- 损坏 JSON：旧代码抛出 `SyntaxError` 且错误信息会带 `token-value`，测试要求 stderr 含 `PROD_READ_CONFIG_UNREADABLE` 且不含 `token-value`，会失败。
- 501 行：旧 `ORDER BY recorded_at LIMIT 500` 会先返回 `m1`，新用例要求 `rows[0] === "bulk500"` 且不含 `m1`，会失败。

未覆盖/缺口：没有“文件不存在 / lstat 抛错”用例，没有属主/uid 用例，没有中间路径段为符号链接的用例，也没有真正以 root 经 ssh 运行的集成用例。这些是静态阅读结论，未实际运行测试。

### 4. 改动产生或修改的每个值，两端都能接受吗？

- **`newest 500`/SQL**：usage（`prod-read.sh:23`）、文档（`docs/agent-rulebook-inventory.md:149`）、SQL（`:88`）、测试（`prod-read.test.mjs:185-214`）一致。
- **配置键 `runPolicy.systemInstruction`**：与产品解析器一致。`packages/platform-node/src/strict-configuration.ts:1102-1129` 在配置根上解析 `runPolicy.systemInstruction`；生产快照脚本 `prepare-...sh:77` 也用 `config.capabilityDeployment`，说明 `/etc/himawari/config.json` 的根就是配置对象，不是 `{configuration:{...}}` 包装。因此脚本读的键是对的；测试里把 `{ configuration: { runPolicy... } }` 判为失败也是对的。
- **生产配置权限**：`prepare-...sh:69` 要求 `uid 999、mode 600`，新检查的 `mode & 0o022` 对 600 为 0，会放行，所以不会误杀（前提是当前为普通文件，见“未核实”）。
- **两个新错误码**：只在脚本和测试里出现，没有其它消费方。
- **P1-4 的 `cancelled` 状态**（顺带核对）：`packages/application/src/ports/memory-reminders.ts:14` 已扩为三态；`production-memory-control.ts:888-890` 写入 `cancelled`；`production-reminder-writer.ts:294-302` 写入并短路；`sqlite-memory-reminder-operations.ts:167` 的校验 `(status === "scheduled") === (dismissedAt === null)` 与 `0085` 迁移的 CHECK 一致；`production-web-push.ts:476` 和 due/upcoming 查询都只挑 `scheduled`，`cancelled` 不会被当到期提醒。消费端能接受。

---

## 侧重检查

我按“错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档与代码一致性”逐项看过：

- **不可信输入**：`journal` 的 pattern/行数、`columns/rows` 的表名和 run id 都有正则白名单；表名还会经 `requireTable` 对照 `sqlite_master`；SQL 里表名用 `JSON.stringify` 包过；`journal` 用单引号包参数，字符集不含单引号，未发现注入。`system-instruction` 的路径是常量，无用户输入。
- **错误路径**：发现 `lstatSync` 在 try 外（问题 3）；JSON 损坏/读取失败会固定报码，这部分符合预期。
- **安全**：lstat 检查的属主/父目录/TOCTOU 缺口见问题 1、4；以 root 运行不是问题本身，但检查不能替代“文件是不是部署约定的那个文件”。
- **资源耗尽**：`rule-memories` 限 500，`rows` 限 50，`journal` 限 200 行；`system-instruction` 会整份读入配置（配置若异常巨大可能占内存，但文件由部署流程生成，风险低）；`runs-open` 无 LIMIT 是既有行为，不在本轮改动内。
- **不可撤销操作**：脚本只读，SQLite 以 `{ readOnly: true }` 打开，未发现写入/删除路径。
- **规则文件/说明与代码一致性**：C-1/G 与 H/C 节矛盾（问题 2）是本次最直接的不一致；`newest 500`、`tables/columns/rows` 与代码基本一致，但“所有条数”措辞过宽（问题 5）。
