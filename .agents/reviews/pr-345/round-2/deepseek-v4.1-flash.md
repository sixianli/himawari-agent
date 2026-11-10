## 读代码证实的

### 1. 中：响应头“文件里实际替换成占位符的处数”与实现不完全一致（一个文本含多个机密时少计）

- 文件:行：`apps/agent-service/src/production-data-export.ts:130`、`packages/persistence-sqlite/src/data-export/export.ts:106`
- 问题：头部现在算的是“含机密的字段数（`withheld.texts`）+ 短文字替换次数”。`withheld.texts` 按 `exportedText()` 的 `key` 去重计数，一个字段只加 1；但 `policy.mask()` 可能在同一个字段里替换出多个占位符（例如一段记忆里有两个银行卡号）。这时文件里实际有 2 个占位符，头部只算 1。ADR 第 9 条把它定义为“文件里实际替换成占位符的处数”，这个说法只对“每个字段最多一个机密”成立。
- 证据：
  - `export.ts:106-114`：`if (!options.policy.hasSecret(text)) return { ...base, text }; withheldKeys.add(key); ... const masked = options.policy.mask(text); ... withheld: true`
  - `production-data-export.ts:130-133`：`const placeholders = result.manifest.withheld.texts + (result.manifest.omitted.find(... )?.count ?? 0);`
  - `docs/adr/0200-portable-export-of-memories-and-decisions.md:62` 明确写“文件里实际替换成占位符的处数”。
- 建议：要么把文案/ADR 改成“含机密的字段处数 + 短文字替换次数”，要么让 `mask` 返回实际占位符个数并据此计数；补一个“同一文本里两个机密”的测试。

### 2. 中：新增的“短文字”加项没有测试覆盖，正向夹具里该项恒为 0

- 文件:行：`test/integration/data-export-http.test.ts:81`、`test/integration/data-export-fixture.ts:179`
- 问题：网页导出测试只断言 `withheld.texts === 6` 和头部等于 `6`。夹具里的实体名、人物名、别名、来源编号、决策输入都不含 `SECRETS`，所以“含机密的短文字”项的 `count` 是 0；把 `production-data-export.ts:132` 的加项删掉，测试仍然通过。作者说“测试用固定夹具断言精确值 6（旧公式会得 9）”只能证明旧公式会失败，不能证明新加项生效。
- 证据：
  - `data-export-http.test.ts:81-83`：`expect(manifest.withheld.memories).toBe(3); expect(manifest.withheld.texts).toBe(6); expect(Number(response.headers["x-himawari-export-withheld"])).toBe(6);`
  - `data-export-fixture.ts:179/182`：`message-${seed.id}`、`实体-${seed.id}`；`191/197`：`'小林'`、`'阿林'`，均不含 `SECRETS`。
  - 现有的短文字测试在 `test/integration/data-export.test.ts:540`、`611`，只测文件内容，不测 HTTP 头。
- 建议：在 HTTP 测试里向 `memory_entities` 或 `memory_provenance` 插入带 `SECRET_API_KEY` 的值，断言头部等于 `withheld.texts + 短文字条数`；再加一个“删掉短文字加项测试必须失败”的反向用例。

### 3. 中低：三语文案与 ADR 说回收站、敏感主题记忆“原文按原样/按明文”导出，实际其中的机密仍会被遮盖

- 文件:行：`apps/control-center/src/i18n/resources/en.ts:788`、`apps/control-center/src/i18n/resources/zh-CN.ts:743`、`apps/control-center/src/i18n/resources/ja.ts:796`、`docs/adr/0200-portable-export-of-memories-and-decisions.md:62`
- 问题：文案说“memories in the trash, and the original text of sensitive-topic memories ... are written to the files as they are / 原文会按原样写进文件 / 本文はそのまま書き出される”。但 `exportedText()` 对所有文本先做 `hasSecret()` 检查，含机密时仍然返回遮盖后的文本或 `WITHHELD_PLACEHOLDER`。敏感主题记忆（例如财务）里若有银行卡号、密码，就不会按原样写入。
- 证据：
  - `export.ts:106-114`：含机密时 `text: options.policy.hasSecret(masked) ? WITHHELD_PLACEHOLDER : masked`。
  - `test/integration/data-export.test.ts:456` 的用例明确验证“topic-type sensitive memories stay readable while credentials are masked”；财务主题的 `m-card` 仍被扣留。
  - `en.ts:788`、`zh-CN.ts:743`、`ja.ts:796` 均写“as they are / 按原样 / そのまま”。
- 建议：改成“回收站和敏感主题记忆不会被排除，但其中的机密仍按上面的规则留占位符”，并同步改 ADR 第 9 条。

### 4. 低：日文 `sourceTitle` 未同步；`memory.page.imported` 只改了日文

- 文件:行：`apps/control-center/src/i18n/resources/ja.ts:768`、`apps/control-center/src/i18n/resources/ja.ts:763`
- 问题：作者说三语的 `sourceTitle` 都改成了“旧版 JSON”。实际只有 en/zh 改了；ja 仍是 `{Himawari のエクスポート}`。另外 ja 的 `memory.page.imported` 改成了“旧版 Himawari のエクスポート（JSON）”，en/zh 的对应文案仍是泛称 `a Himawari export` / `Himawari 导出文件`，三语不一致。
- 证据：
  - `ja.ts:768-769`：`other {Himawari のエクスポート}`。
  - `ja.ts:763-764` vs `en.ts:756-757`、`zh-CN.ts:713-714`。
- 建议：统一三语标题和导入成功文案。

### 5. 低：`importUnreadable` 被 Codex 路径共用，新的“旧版 Himawari JSON”措辞会在 Codex 文件解析失败时出现

- 文件:行：`apps/control-center/src/components/memory-page.tsx:1864`、`apps/control-center/src/i18n/resources/zh-CN.ts:740`
- 问题：`read()` 对 Codex 的 `.md/.txt` 和 Himawari 的 `.json` 共用同一个 `catch`，失败都显示 `memory.page.importUnreadable`。该文案已改成“不是旧版 Himawari 导出的 JSON 文件”，选错 Codex 文件时提示会指向 Himawari JSON。
- 证据：
  - `memory-page.tsx:1870-1872`：`Promise.all(list.map(async (file) => parse(...))).then(load).catch(() => setError(message("memory.page.importUnreadable")))`
  - `zh-CN.ts:740`：`文件读不出来，或者不是旧版 Himawari 导出的 JSON 文件。`
- 建议：按 `source` 分开两条错误文案，或改成不限定格式的通用文案。

### 6. 低：文案说新压缩包可用于“命令行导入”，但 CLI 的 import 只接受目录，不接受 zip

- 文件:行：`apps/control-center/src/i18n/resources/en.ts:766`、`apps/control-center/src/i18n/resources/zh-CN.ts:723`、`apps/control-center/src/i18n/resources/ja.ts:773`、`apps/admin-cli/src/data-command.ts:207`
- 问题：三语文案说新导出 zip 用于备份和换机（命令行导入），但 `himawari-admin data import --from` 走 `readPortableDirectory(from)`，只读取目录；admin-cli 里没有解压 zip 的逻辑。用户直接拿 zip 去导入会失败。
- 证据：
  - `en.ts:766`：`Export all memories now gives a zip for backup and moving machines (imported with the command line)`；`zh-CN.ts:723`：`只用于备份和换机（命令行导入）`。
  - `data-command.ts:207`：`const files = await readPortableDirectory(from);`
  - `packages/persistence-sqlite/src/data-export/directory.ts:33-35`：`readPortableDirectory(directory: string)` 只 `readdir` / `lstat`。
- 建议：文案写“解压后用命令行导入”，或给 CLI 增加读取 zip 的入口。

### 7. 低：CLI 的 `totalWithheld` 仍用旧公式，与 ADR 的“别把 memories/decisions 加进去”不一致

- 文件:行：`apps/admin-cli/src/data-command.ts:98`、`docs/adr/0200-portable-export-of-memories-and-decisions.md:62`
- 问题：ADR 第 9 条说记忆条数和决策条数是另一个口径，加进去会重复计数；但 CLI 的 `totalWithheld()` 仍然返回 `texts + memories + decisions`。它目前只用于“是否大于 0”的判断，因此没有可见的错误计数，但同一概念出现两套公式，容易在后续复用出错。
- 证据：
  - `data-command.ts:98-100`：`return withheld.texts + withheld.memories + withheld.decisions;`
  - `document.ts:62`：“记忆条数和决策条数是另一个口径，不加进去，否则同一处会算两次”。
- 建议：改名为 `hasWithheld()` 只做非零判断，或改用与网页导出相同的口径并注明用途。

## 推测/未核实

- `REQUIRED = 52` 是否等于“当前通过数”：脚本只要求 `passed.length >= 52`（`scripts/check-data-export.mjs:15/48`）；我没有运行测试，无法核实当前实际通过数是否正好 52。
- 新增浏览器验收场景 `accept-memory-export`、`accept-export-requires-login` 的实际执行结果未核实，只核对了场景名已加入 gate、`test_deploy.py`、覆盖测试和 browser 测试。
- 网页导出的“单飞”标志 `running` 是进程内变量；如果未来同一数据库有多个服务进程，它不是跨进程互斥。当前生产是否严格单进程未核实，ADR 也没有写明这个前提。
- 迁移号不校验的合理性：`SqliteProductStateRepository.open()` 在返回前调用 `applyMigrations()`（`product-state-repository.ts:222-227`），服务启动后再注册导出路由（`service-main.ts:701`、`production-http-composition.ts:1143`），因此作者“服务启动时已迁移”的说法与代码一致；但这是运行时前提，不是导出接口自身的校验。

## 侧重检查

- **错误路径**：未登录 401、跨站 403、并发 429、生成失败 500 都返回空 body；`database.close()` 在 `finally` 里；`running` 在 `finally` 里复位（`production-data-export.ts:141-153`）。`HEAD` 现在返回 404，符合作者说明，但这是非常规的 GET 资源行为，客户端若用 HEAD 探活会看到 404。
- **不可信输入**：路由只读 `sec-fetch-site` 和认证 cookie，没有 body/query/path 输入；`code` 日志用 `^[A-Z][A-Z0-9_]{2,63}$` 限制，不会把普通错误消息或带空格/标点的敏感串写进日志（`production-data-export.ts:145-149`）。未发现路径穿越或注入面。
- **安全**：响应头 `cache-control: no-store`、`referrer-policy: no-referrer`，文件名是服务端固定格式。导出包含回收站和敏感主题记忆，且只要求普通主人会话、没有 recent-auth/CSRF 令牌；ADR 明确这是产品选择，但“一次请求带走全部记忆”比普通浏览更敏感，建议至少确认 stolen-session 场景可接受。
- **资源耗尽**：整份导出在内存中生成，512 MB 限制在 `createStoredZip` 打包阶段才检查（`production-data-export.ts:68-70`）；ADR 已补充“峰值内存可能更高、同步阻塞主进程”。`running` 只防同时生成，不防顺序重复请求；这属于已记录的取舍。
- **不可撤销操作**：导出使用 `openReadOnlyDatabase`（`read-only.ts`），`readSnapshot` 只读，未发现写库或删除动作。
- **规则/文档/代码一致性**：三语文案、ADR、CLI 和实现之间发现上面第 3-7 条不一致；`SHORT_TEXT_OMISSION_LABEL` 生产者（`export.ts:428`）和消费者（`production-data-export.ts:132`）使用同一常量，清单 schema 对 `what` 只要求 1-512 字符串（`schemas.ts:362`），这一端能通过校验。新增消息 ID 在 en/ja/zh 和 `MESSAGE_IDS` 中都存在，`exportDone` 有样例值。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动集中在数据导出 HTTP 接口、记忆页 UI 和三语文案；没有任何代码改系统提示、工具定义、历史消息或模型出口遮盖。导出接口用的是 `createDataExportTextPolicy()` 处理导出文件，不进入模型请求。依据 `.claude/rules/prompt-prefix.md#rules` 第 4 条“已发给模型的内容只能在末尾追加”，本改动没有触碰这些内容。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对模型请求：不会，本改动不参与模型请求组装。
   对导出文件：同一个数据库、同一时刻导出的数据文件是确定的（`data-export.test.ts:504`）；但压缩包整体不会逐字节相同，因为 `manifest.exportedAt` 和 zip 的 DOS 时间戳每次请求都变（`production-data-export.ts:44-48`、`128`），短文字占位编号也依赖库里已有占位和遍历顺序（`export.ts:119-140`）。这不影响模型，也不是本次改动引入的缺陷，但“导出包可复现”不能成立。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有：生成失败后标志复位、HEAD 404、zip 头/CRC/偏移、网页导出正向断言 6、`check:data-export` 门槛 52。但**新增的“短文字”加项没有测试覆盖**（见第 2 条），删掉该加项测试仍通过；“一个文本多个机密时头部少计”也没有反向用例；“新版 zip 不能在网页导入”只有旧 JSON 解析测试（`memory-interactions.unit.test.ts:1482-1486`），没有“上传 zip 必须被拒绝”的测试。因此只能算部分满足。

4. **改动产生或修改的每个值，生产端和使用端都能接受吗？**
   - `SHORT_TEXT_OMISSION_LABEL`：生产端 `export.ts:428` → 清单 `omitted[].what`；消费端 `production-data-export.ts:132` 精确匹配；清单 schema 允许任意 1-512 字符串（`schemas.ts:362`），能通过。
   - `x-himawari-export-withheld`：生产端 `production-data-export.ts:130-139`；消费端 `apps/control-center/src/data-export.ts:21-27`、HTTP 测试、浏览器验收正则、ADR 第 62 行，都接受非负整数；缺头时客户端落成 0（作者已承认的“可以更好”）。
   - 新消息 ID（`exportNote`、`exportWorking`、`exportDone`、`exportFailed`）：en/ja/zh 都定义，`MESSAGE_IDS` 已登记，`exportDone` 样例值存在。
   - 新验收场景名：已加入 `browser-acceptance-gate.py`、`test_deploy.py`、`release-walkthrough-coverage.test.mjs`、`product-path-browser.test.ts`、`release-walkthrough-ui.ts`，两端能对上。
   - `migrationSequence`：导出端固定写 `LATEST_MIGRATION_SEQUENCE`（`production-data-export.ts:123`），导入端用它做 `verifyIntegrity`/`parsePortable` 校验；生产服务启动时已迁移，故正常路径成立，但导出接口自身没有读库版本，属于依赖前提。
   - `totalWithheld`：CLI 仍用旧公式（见第 7 条），与网页导出新口径不一致，但当前只用于非零判断，暂无可见错误。
