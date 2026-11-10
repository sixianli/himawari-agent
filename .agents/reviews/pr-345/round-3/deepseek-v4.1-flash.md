## 复核结论（PR 345 第 3 轮增量）

第 3 轮增量只改了：三语文案、ADR 第 9/10 条、`check-data-export` 门槛、新增 HTTP 用例；没有改生产运行代码。作者的的主要说法基本都能和代码对上，未发现高严重度缺陷。下面按严重度列出问题。

### 1. 中：页面说“解压后用命令行导入”，但 ZIP 内多了一层 `himawari-export/`，CLI 的 `--from` 根目录对不上

- 文件:行：`apps/control-center/src/i18n/resources/zh-CN.ts:723`（en:766、ja:773）；`apps/agent-service/src/production-data-export.ts:53`；`packages/persistence-sqlite/src/data-export/directory.ts:33-41`、`:52`；`packages/persistence-sqlite/src/data-export/verify.ts:181-183`
- 问题：网页导出的每个条目都带 `himawari-export/` 前缀；而 CLI `readPortableDirectory` 把 `--from` 当作根目录，`verifyIntegrity` 要求根目录下直接有 `manifest.json`。如果用户把解压出来的外层目录（里面是 `himawari-export/`）传给 `--from`，会得到 `DATA_IMPORT_MANIFEST_INVALID 缺少清单`。页面文案没有说明要把 `himawari-export` 子目录作为 `--from`。
- 证据：

```ts
// production-data-export.ts:53
const nameBytes = encoder.encode(`${DATA_EXPORT_ARCHIVE_ROOT}/${name}`);
```

```ts
// directory.ts:34,41,52
const root = path.resolve(directory);
const relative = path.relative(root, full).split(path.sep).join("/");
files.set(relative, new Uint8Array(await readFile(full)));
```

```ts
// verify.ts:181-183
const bytes = files.get(MANIFEST_FILE);
if (bytes === undefined)
  throw new DataExportError(DATA_EXPORT_ERROR_CODES.MANIFEST_INVALID, "缺少清单");
```

- 建议：文案写明“把解压得到的 `himawari-export` 目录作为 `--from`”，或让 `readPortableDirectory` 兼容“根目录下只有一个目录”的布局；并补一条“解压 zip → 命令行 import”的集成用例。

### 2. 低：新 HTTP 用例只核对响应头，没有核对密钥真的没进文件

- 文件:行：`test/integration/data-export-http.test.ts:97-106`
- 问题：用例名说“换成占位符后”，但只断言 `x-himawari-export-withheld` 为 7，没有解压响应体确认 `SECRET_API_KEY` 不存在、`[已扣留:` 存在。若“短文字计数”增加了但实际替换规则回归（把原文写进文件），这条用例仍会通过。这是安全属性测试的缺口；现有 CLI 用例覆盖了实体名遮盖，但不能替代 HTTP 端到端。
- 证据：

```ts
it("含机密的短文字（实体名等）换成占位符后，也计入响应头的处数", async () => {
  ...
  expect(Number(response.headers["x-himawari-export-withheld"])).toBe(7);
});
```

- 建议：在解压 `response.rawPayload` 后，断言所有文件拼接结果不含 `SECRET_API_KEY`，并至少包含一个 `[已扣留:`；或同时断言 manifest 中短文字 `omitted` 项为 1。

### 3. 低：英文/日文 `exportDone` 用“items / 件”描述“文字段数”，与本轮 ADR 和中文“处”口径不一致

- 文件:行：`apps/control-center/src/i18n/resources/en.ts:790-791`、`ja.ts:798-799`、`zh-CN.ts:746`；`apps/agent-service/src/production-data-export.ts:131-132`
- 问题：本轮 ADR 已把 `x-himawari-export-withheld` 定义为“文字段数 + 短文字条数”，不是记忆条数或“items”。中文写“处”是对的；英文 “sensitive items”、日文 “機微な内容 {withheld} 件” 容易被读成记忆/条目数。
- 证据：

```ts
// en.ts:790-791
"Exported {count} memories; {withheld} sensitive items were left as placeholders.",
```

```ts
// ja.ts:798-799
"記憶 {count} 件をエクスポートしました。機微な内容 {withheld} 件はプレースホルダーのままです。",
```

```ts
// zh-CN.ts:746
"已导出 {count} 条记忆；{withheld} 处敏感内容只留了占位符。",
```

- 建议：英文改为 “{withheld} text places/segments were left as placeholders”，日文改为 “{withheld} 箇所”，与 ADR 的“文字段数”一致。

---

## 读代码证实的

- 三语导出说明与 ADR 第 9 条一致：`packages/persistence-sqlite/src/data-export/snapshot.ts:31` 的 `EXPORTABLE_STATUSES` 包含 `trashed`；`:51-52` 只排除 `restricted`，所以回收站和敏感主题记忆都会导出。`export.ts:106-115` 只在 `hasSecret(text)` 时遮盖/扣留，否则原样输出，所以“除机密外是明文”成立。
- ADR 的响应头口径与代码一致：`production-data-export.ts:130-133` 计算 `withheld.texts + 短文字 count`；`export.ts:107` 用 `withheldKeys.add(key)`，键是“文字段”，一段内多个密钥只加一次；短文字计数来自 `export.ts:135` 的 `replacedShortTexts += 1`。
- 新用例期望 7 的来源成立：基础 `seedEverything` 产生 6 个 withheld 文字段（m-card、m-pass、m-key 各当前内容+历史），新增实体名含 API key 再贡献 1 个短文字计数。
- `check:data-export` 门槛 53 与静态测试数一致：`data-export.test.ts` 39 条、`data-cli.test.ts` 4 条、`data-export-retrieval.test.ts` 2 条、`data-export-http.test.ts` 8 条，共 53 条。未实际运行测试，见“未核实”。
- 日文 `sourceTitle`/`imported` 已与英中一致：`ja.ts:763-764` 的 `imported` 是通用 “Himawari のエクスポート”，`:768-769` 的 `sourceTitle` 是“旧版 …（JSON）”。
- 三语 `importUnreadable` 已改成不限定旧格式的通用文案：`en.ts:784`、`zh-CN.ts:740`、`ja.ts:792`。
- CLI import 确实读目录：`apps/admin-cli/src/data-command.ts:207` 调 `readPortableDirectory(from)`；命令行没有 zip 解包逻辑。
- `totalWithheld` 仍是 `texts + memories + decisions`，只用于“未加密封存时是否拒绝”，作者说留给 Andy 改名属实；它没有把短文字计数加进去，因此名字确实容易误解：
  `apps/admin-cli/src/data-command.ts:98-100`、`:175-179`。
- 未见对 prompt 组装、系统提示、工具定义、历史消息的改动；导出功能只读数据库并生成下载文件。

## 推测 / 未核实

- “临时删掉短文字加项该用例失败”：从代码看会失败（响应头会变成 6，而断言是 7），但本环境只能读文件和跑 git，未能实际运行验证。
- 53 条“当前通过数”是按代码静态计数得到的，不是测试运行结果。
- 第 1 条中“用户把外层目录传给 `--from` 会失败”是由 `readPortableDirectory` 和 `verifyIntegrity` 的代码推断，未实际执行命令。
- `withheld.texts` 的“一段里几个密钥只算一处”目前只有 `Set` 实现保证，没有专门测试；建议补一个同一段文字含两个密钥的用例。

---

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本轮只改了页面文案、ADR、门槛和测试；整个导出功能也不参与系统提示、工具定义、历史或遮盖的组装。发给模型的内容仍只在末尾追加，没有新增每轮会变的值到头段。依据 `prompt-prefix` 第 4 条。
2. **对模型请求不会。** 导出压缩包本身会因 `manifest.exportedAt` 和 ZIP DOS 时间戳在两次导出间字节不同，但那是下载文件，不会发给模型。数据文件在同一个数据库上仍是确定的（已有“同一个库导出两次数据文件相同”的测试）；遮盖按单条文字确定，短文字编号按数据库排序确定。
3. **有自动检查，但反向不是自动用例。** 新增 HTTP 用例和 `check:data-export` 门槛 53 都在；如果删掉短文字加项，按代码逻辑该用例会从 7 变 6 而失败。但仓库里没有提交“删除加项”的变异/反向测试，作者是手工试的，本环境未运行。另：ADR 的“一段里几个密钥只算一处”没有专门测试。
4. **逐个核对的值：**
   - `SHORT_TEXT_OMISSION_LABEL`：产生于 `packages/persistence-sqlite/src/data-export/types.ts:94`，由 `export.ts:428` 写进 manifest，由 `production-data-export.ts:132` 精确匹配；两端用同一个常量，能对上。测试 `data-export.test.ts:626` 仍用硬编码前缀，但当前能匹配。
   - `x-himawari-export-memories` / `x-himawari-export-withheld`：产生于 `production-data-export.ts:138-139`，消费于 `apps/control-center/src/data-export.ts:25-26` 和 `memory-page.tsx:2075`；名字和数字解析一致。
   - `memory.page.exportDone`：三语都有 `{count}`/`{withheld}`，样例值在 `message-ids.ts:1381`，调用方传数字；i18n 测试会校验。英文/日文文案的“items/件”口径问题见第 3 条。
   - ZIP 文件名：服务端 `himawari-export-${stamp}.zip`，客户端正则允许 `[A-Za-z0-9._-]`，日期格式能通过。
   - ZIP 根目录 `himawari-export`：见第 1 条，与 CLI `--from` 的目录根存在使用上的不一致。
   - 场景名 `accept-memory-export`、`accept-export-requires-login`：在 gate、部署测试、浏览器测试、walkthrough 覆盖清单里一致；本轮未改这些文件，已核对无遗漏。
   - `totalWithheld`：CLI 仍只算 texts+memories+decisions，和网页响应头口径不同；按本轮 ADR，这是有意的“另一个口径”，但改名时不要顺手改变行为。

## 侧重检查

- **错误路径：** 未登录 401、换主人 401、跨站 403、并发 429、生成失败 500 后 `running` 复位、HEAD 404，路由和现有测试都覆盖；`catch` 只记录大写错误码，不把可能含密文的 detail 写日志。
- **不可信输入：** 路由没有查询参数；只读 `Sec-Fetch-Site`、Cookie；ZIP 内文件名来自内部 `PortableFiles`，不是用户输入；客户端对 `content-disposition` 做了白名单正则。
- **安全：** 只读连接 `readonly: true`、`fileMustExist: true`；网页导出不带封存文件/证据；基础用例断言三组密钥不出现在文件中。第 2 条指出新增短文字用例没有把该密钥本身纳入“不得出现”的断言。
- **资源耗尽：** 单个导出上限 512MB，同一进程同时只允许一份；但 `createStoredZip` 仍把本地条目、中央目录和最终 archive 同时放在内存里，峰值可能明显高于 512MB。这是既有实现，不是本轮新增。
- **不可撤销操作：** 导出是只读，不写数据库，没有不可撤销副作用。
- **规则/文档/代码一致性：** 回收站、敏感主题、明文/机密、响应头口径均已核实；发现两处一致性缺口：解压后用 CLI 导入的目录根（第 1 条），以及英文/日文“items/件”与本轮 ADR“文字段数”的措辞（第 3 条）。
