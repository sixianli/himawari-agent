## 复核结论

本轮实际增量（`1df8bf8..a99e6`）只涉及 6 个文件：清单校验脚本、`prod-read.sh`、两个 tooling 测试、owner-profile 测试、清单文档。没有运行时产品代码改动。下面按严重度排列。

### 1. 中低 — `scripts/check-agent-rulebook-inventory.mjs:10`（消费方：`docs/agent-rulebook-inventory.md:148`）
**问题**：新的测试编号 `PA-2b`、`PA-2c` 根本不会被清单校验器提取，等于没有被校验。
**证据**：
- `const TEST_ID = /\b(?:PG|OM|SI|PA|NAME|MEM|W)-[A-Z0-9]+\b/g;`（`scripts/check-agent-rulebook-inventory.mjs:10`）
- 校验循环在 `:78-82` 用这个集合逐个查测试文件。
- 字符类只含 `[A-Z0-9]`；`PA-2b` 中 `2` 与 `b` 都是词字符，末尾 `\b` 不成立，整个 `PA-2b`/`PA-2c` 匹配不到（`PA-2` 本身仍能匹配，且 `owner-profile-service.unit.test.ts:203` 确有 `[PA-2]`）。
- 新增反向用例只覆盖 `PG-1/PG-80/OM-5`（`test/tooling/agent-rulebook-inventory.test.mjs:58-68`），没有任何小写后缀编号。
**后果**：`PA-2b`/`PA-2c` 用例若被重命名或删除，`npm run check:agent-rulebook-inventory` 仍然通过，与作者“核对测试编号”的说法不一致；这是自动检查的盲区，不是 CI 立刻失败。
**建议**：字符类改为 `[A-Za-z0-9]+`（或显式维护编号清单），并加一条含小写后缀编号的反向用例。

### 2. 低 — `test/tooling/prod-read.test.mjs:314-317`（对应 `scripts/operations/prod-read.sh:125-135`）
**问题**：非 root 运行时，属主反例并没有隔离“文件属主”这一项检查，删掉文件属主判断用例仍会通过。
**证据**：
```js
const foreign = String(process.getuid() + 1);
expect(readConfig(result.input, file, foreign).stderr).toContain("PROD_READ_CONFIG_UNSAFE");
```
此时临时目录由当前用户 `mkdtemp` 创建，`parent.uid` 也是当前 uid；`owners = [0, uid+1]` 不包含当前 uid，所以 `!owners.includes(parent.uid)` 已经先判 UNSAFE。删掉 `!owners.includes(stat.uid)` 后该分支依旧 UNSAFE。
真正能隔离文件属主的是 `process.getuid() === 0` 分支（`:309-313`，父目录 root、只 chown 文件）。作者说“root 下已实测”是准确的，但普通 CI 若不是 root，这条回归测试抓不到文件属主检查被删除。
**建议**：把判定逻辑抽成可单测的函数，或在 CI 明确用 root 跑；非 root 分支至少注释说明它只覆盖“拒绝”，不覆盖文件属主判断。

### 3. 低 — `test/tooling/agent-rulebook-inventory.test.mjs:15-68`
**问题**：作者说“不跟随符号链接，加反向用例”，但符号链接行为没有测试。
**证据**：代码确有 `if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;`（`scripts/check-agent-rulebook-inventory.mjs:17`），但该测试文件全部 3 个用例只覆盖链接/锚点、缺失文件/编号、精确匹配与排除自身测试文件，没有创建任何 symlink。
**建议**：在 fixture 中放一个指向临时目录外测试文件的符号链接（以及一个目录符号链接），断言其内容不参与编号匹配。

### 4. 低 — `scripts/check-agent-rulebook-inventory.mjs:13`
**问题**：`LINK` 正则漏掉带 title 的链接（作者已把它列为未改的“可以更好”，确认仍存在）。
**证据**：`const LINK = /\]\(([^)\s]+)\)/g;` 要求 `)` 紧跟在无空格 URL 后；`](adr/x.md "title")` 不会命中，链接会被静默跳过。
**建议**：用 Markdown 解析器，或至少允许可选的 `"title"`/`'title'` 形式。

---

## 读代码证实的结论

- **生产属主/权限不会误拒（有仓库内依据）**：`S2-stop-and-inspect.py:22` `SERVICE_UID = 999`；`S7-switch-start-readback.py:140` `regular(configuration, 999, 0o600)`；`S9-control-files.py:335,346` 对 `config.json` 要求 uid 999。新脚本要求文件 uid ∈ {0,999}、`(mode & 0o077)==0`、`nlink==1`，正好与生产不变量一致（生产是 `999`、`0600`）。因此正常生产布局下**不会**因文件属主/权限误拒。
- **父目录正常布局也不会误拒**：`P9-switch-start-readback.md:60` 说明维护流程以生产账号写 `/etc/himawari/config.json.next`，说明该目录必须对 uid 999 可写；新检查接受属主为 root 或 999、且非 world-writable 的目录。常见的 `root:himawari-prod 0770`、`999:* 0700/0770`、`root:root 0755` 都会通过。放宽成只拒 other-writable 与维护流程自洽。
- **M-4 与代码、ADR 0193 一致**：`owner-profile-service.ts:149-167` 用 `min(requestRank, modelVisibleCeiling())` 过滤分类，并检查 `status==="active"`、`currentlyValid`（`supersededBy`、`tentative`、`validTo`）；`model-visibility.ts:16-18` 的 `modelVisibleCeiling()` 返回 `sensitive`，`restricted` 不在可见集合。`context-formation-service.ts:228-231` 实际给 `compose` 传 `modelVisibleCeiling()`，所以“敏感的规则会注入”成立。`production-memory-control.ts:558` 的 `outline` 用 `"private"` 是控制中心概览，不是模型规则块，不构成 M-4 矛盾。
- **`rule-memories` 改名两端一致**：usage `prod-read.sh:24`、case `:203-205`、远端脚本分支 `:86`、测试 `test/tooling/prod-read.test.mjs:200-203`、`.agents/instructions/test-and-production-hosts.md:19`、清单 `docs/agent-rulebook-inventory.md:240` 都用新名。
- **新检查已接入 `npm run check`**：`package.json` 的 `check:steps` 含 `npm run check:agent-rulebook-inventory`；`scripts/run-all-checks.mjs:32` 从 `check:steps` 解析并逐个执行；对应脚本和测试文件都存在。
- **0770/0777 用例是真反向用例**：旧的 `(parent.mode & 0o022)` 会把 0770 判为 UNSAFE，新测试要求 0770 成功，旧代码会失败，说明该测试确实能守住这次放宽。

## 推测 / 未核实

- 生产 `/etc/himawari` 的**真实属主和权限**仓库内没有断言，未核实。若它是符号链接（`lstatSync(...).isDirectory()` 为假）、属主是第三个 uid、或 world-writable，脚本会拒绝；这属于异常布局，拒绝本身合理，但作者“真实目录权限未核实”的说明是准确的。
- 若生产服务账号 uid 不是 999（例如账号重建），检查会误拒。目前 S2/S7/S9 都写死 999，支持 999 这一取值。
- 清单 I 节声称“退出码都是 0”“输出里没有密钥”，无法在仓库内核实；内容本身是记忆元数据和一行 systemInstruction，未见密码/令牌。
- 清单 I 节的时间戳和 UUID 是静态快照，不会进入模型请求，不影响第 1、2 问。

---

## 侧重检查

- **错误路径**：`prod-read.sh` 先 `openSync(O_RDONLY|O_NOFOLLOW)`，缺失文件 → `PROD_READ_CONFIG_UNREADABLE`；符号链接 → `ELOOP` → `PROD_READ_CONFIG_UNSAFE`；JSON 坏 → `UNREADABLE` 且不打印原文（测试 `:280-284` 验证不含 `token-value`）。`lstatSync(path.dirname(...))` 未包 try/catch，理论上父目录在 open 与 lstat 之间消失会抛未捕获异常，但以 root 读生产路径基本不可达，未列为问题。
- **不可信输入**：所有查询参数有白名单正则（`prod-read.sh:161-200`）；`rule-memories` 无参数；`system-instruction` 的路径和 uid 是脚本常量，不存在命令注入面。
- **安全**：读取前先用 `fstat` 校验已打开的描述符，再要求 `isFile`、`nlink==1`、属主 0/999、权限不超过 0700；放开父目录 group-write 不削弱安全性，因为文件本身必须由 0/999 拥有、0600、硬链接数为 1，组内攻击者无法伪造。`O_NOFOLLOW` 保护最终组件。
- **资源耗尽**：`prod-read.sh` 是只读查询（`readOnly: true`，`LIMIT 500`/`LIMIT 50`），无写操作。清单校验脚本会同步读取全部测试文件，规模可控，未发现无界循环或超大分配。
- **不可撤销操作**：本次改动没有删除、覆盖或迁移数据的路径。
- **规则/文档/代码一致**：M-4、`rule-memories`、`npm run check` 的说法都属实；不一致的是 `PA-2b/PA-2c` 未被校验器识别、符号链接行为无测试、`LINK` 正则的已知限制。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。完整 diff `a2156..a99e6` 只改文档、脚本、测试和 `package.json`，没有改任何提示词、工具定义、上下文组装、历史或遮盖代码。发给模型的内容仍然只在末尾追加，每轮会变的值仍只在最后一条用户消息里，符合 `.claude/rules/prompt-prefix.md` 第 1、2、4 条；ADR 0193 的一次性历史例外与本改动无关。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。新增的运行时脚本只读生产配置/数据库，`rule-memories` 固定 `ORDER BY recorded_at DESC, id`；清单 I 节里的时间戳/UUID 是静态文档快照，不进入请求；没有新增遮盖、无序集合或依赖前后文的序列化。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
大部分有，且多数是真反向：0770 成功/0777 拒绝（旧 0o022 会失败）、硬链接拒绝、0644 拒绝、PA-2b/PA-2c 行为、清单精确编号和排除自身测试文件，都能在对应判断被改坏时失败。缺口是：`PA-2b/PA-2c` 没有被校验器提取（问题 1）；符号链接行为无测试（问题 3）；非 root CI 下文件属主反例不隔离（问题 2）。

**4. 每个新值/改动值，两端都能接受吗？**
- `PROD_SERVICE_UID="999"`（`prod-read.sh:9`）→ 远端命令 `:111` 与 `owners` `:125`；生产配置的 999/0600 有 S2/S7/S9 依据，接受。
- 父目录掩码 `0o002`（`:133`）→ 测试 `prod-read.test.mjs:292-295`，0770 接受、0777 拒绝，两端一致。
- `rule-memories` 名称 → usage、case、远端分支、测试、文档、指令文件全部一致。
- `check:agent-rulebook-inventory` 配置键 → `check:steps` → `run-all-checks.mjs` → 脚本/测试均存在，接受。
- `PA-2b`/`PA-2c` 测试编号 → 测试文件存在且与清单文字相符；但清单校验器这个消费方读不出它们，**不能接受（静默漏检）**。
- M-4 文档文字、`raw-output` 锚点、ADR 0193/0185/0112 链接 → 锚点和 ADR 文件存在，文字与 `owner-profile-service.ts`、`model-visibility.ts`、ADR 0193 一致，接受。
- I 节原始 JSON 字段（`classification`、`tentative`、`importance_permille`、`valid_to`、`superseded_by` 等）→ 与 `memory_records` 迁移列和远端 SELECT 列表一致，仅作为文档快照，接受；其“生产实际输出”无法核实。
