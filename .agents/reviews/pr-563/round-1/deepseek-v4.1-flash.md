I'll start by examining the actual diff and the relevant files.
## 侧重检查

- **错误路径**：`added_column_backfills` 摘不对、文件名/表名对不上都返回 `[]`，随后 `migration_ledger` 以 `PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES` 拒绝；`history_ignored_columns()` 找不到常量会 `PACKET_HISTORY_IGNORED_COLUMNS_NOT_FOUND`。都是失败关闭。
- **不合规范/不可信输入**：表名来自固定的 `historyTables`，SQL 表名不拼接用户数据；`make-packet.py` 解析的是仓库内模板文件。没有新的外部输入面。
- **安全**：本次把 `threads.origin` 从所有历史闸门里永久拿掉，见下面第 1 条；未发现新增日志泄露行内容（`verify-fixtures.mjs:225` 仍断言 CANARY 不出现在输出里）。
- **资源耗尽**：`historyRow` 每行多一次浅拷贝；生成器是惰性的，没有把整表读进内存，量级与原来相同。
- **不可撤销操作**：迁移本身不可逆，但沿用原有 pre-migration 快照 + S3 恢复点 + S9 整库恢复；S9 前后比较也走 `historyDigests`，两边同样忽略 origin，恢复路径不受影响。
- **文档/规则一致性**：ADR 0086、`P-readback-design.md`、S8 证据字段仍写着“唯一例外是 recovery_json/0083”，与代码不一致，见第 4 条。

## 读代码证实的

- 改动文件只有出包/维护脚本、测试和复核简报；`deploy.sh` 未改。
- `ADDED_COLUMN_BACKFILLS` 只登记 `20261115045512_thread_origin.sql`，只允许 `threads.origin`，并要求模板里 `historyIgnoredColumns` 登记了 `origin`（`make-packet.py:188-204`）。
- `historyDigests` 和 `compareHistoryRows` 两侧都经过 `historyRow`（`read-s0-db.mjs:74`；`maintenance-common.mjs:965,972`）。
- 迁移 SQL 确实是 `ALTER TABLE threads ADD COLUMN origin ... DEFAULT 'owner'` 加条件回填 `'think'`（基线 ce8d5d6 已含该文件）。
- 除 `compareHistoryRows` 外，没有别的地方逐行比较 `threads`：`scripts/operations/hermes-native-history-import*.mjs` 只查 `message_watermark,revision`；`S7-switch-start-readback.py:233` 比较的是两份 `history` 摘要，两边都由 `historyDigests` 产生。
- `test_make_packet.py` 在 `npm run check` 的 `check:delivery-packet` 里；`verify-fixtures.mjs` 只在出包检查 `run-packet-checks.py` 里跑，不在 `npm run check`。

## 推测与未核实

- 我无法用允许的命令计算 `817407da…` 是否等于迁移文件的 `sha256(sql.strip())`（未核实）。若不等，新单测会失败、出包会拒绝，属于失败关闭。
- 生成器提前 `return()` 时底层 better-sqlite3 迭代器会因 `for...of` 的 IteratorClose 被关闭（语义推断，未实跑）；现有负向夹具会在抛错后继续使用同一连接，但没有专门断言。
- 生产上是否还有除 `thread_origin` 以外的待应用迁移、以及生产当前 schema 号，未核实；若还有别的历史表迁移，出包会继续拒绝，属于失败关闭。

---

### 1. [中] `threads.origin` 被所有历史闸门永久忽略，并非“一次性放行”

文件:行：`scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs:59-65,74`；`scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:965,972`

问题：`ADDED_COLUMN_BACKFILLS` 是一次性的（文件名 + 内容摘要），但 `historyIgnoredColumns = { threads: ["origin"] }` 会随模板进入今后每一个上线包。S3、S7、S8、S9 以及以后所有发布的历史比较都会忽略 origin，直到有人再改代码。作者说“一次性放行”，这与实现不符。

证据（读代码证实）：
```js
// read-s0-db.mjs:59
export const historyIgnoredColumns = Object.freeze({ threads: Object.freeze(["origin"]) });
// read-s0-db.mjs:74
hash.update(`${canonicalJson(historyRow(table, row))}\n`);
// maintenance-common.mjs:965
const live = (function* () { for (const row of current.prepare(query).iterate()) yield historyRow(table, row); })();
// maintenance-common.mjs:972
const row = historyRow(table, raw);
```

推测的风险：此后任何迁移、启动恢复或代码缺陷把某个主人线程的 `origin` 改成 `think`，该线程会从搜索、列表、首页、导出等主人界面消失，而 S7/S8 的历史闸门都看不出来。origin 正是 PR 558 用来决定可见性的列，这个盲区落在用户会直接感知的数据上。

建议：把忽略范围缩到真正跨 schema 的比较（S7 `verifyMigrationTransition`、S8 对照迁移前恢复点），而不是放进所有 `historyDigests`；或者在迁移后显式核对 origin 值（只允许 `owner`/`think`，回填集合与 receipt/inbox 规则一致），并在下一次发布删除这条全局忽略；至少用新 ADR 记录这条永久例外。

### 2. [中低] 迁移的回填结果没有任何部署侧校验，错误回填也能通过 S7/S8

文件:行：`packages/persistence-sqlite/src/migrations/20261115045512_thread_origin.sql`（不在本 diff，但本次要上线）；`scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:787,805-816`

问题：`migrationComparedSections` 的 `history` 走 `historyDigests`，而 origin 被忽略。于是迁移前后 `history` 必然相等，与 `UPDATE threads SET origin='think' ...` 的 WHERE 条件写对写错无关；行数也不变，其他 section 也不看 origin。

证据（读代码证实）：
```js
// maintenance-common.mjs:787
export const migrationComparedSections = Object.freeze(["history", "capabilities", "authorization", "releaseReceipts", "integrity", "foreignKeys"]);
// maintenance-common.mjs:816
for (const section of migrationComparedSections) if (canonicalJson(after[section]) !== canonicalJson(before[section])) changed(...)
```
`verify-migrate-fixtures.mjs:50` 给 `threads` 建的是空表，M1 也覆盖不到有行的回填；唯一检查回填语义的是 `test/integration/think-runner.test.ts`（基线里的 PR 558 测试），它不在 `npm run check` 的 `check:*` 列表里，也不是出包检查。

推测的风险：如果 WHERE 条件写错（把主人线程标成 think），上线时没有任何闸门报错，用户线程会直接消失；这与本次改动想要守住“历史数据可以放行但不能悄悄坏掉”的初衷相反。

建议：在 `migrateDatabase`/`verifyMigrationTransition` 之后加一项 origin 校验：值只能是 `owner`/`think`，并且 `think` 集合必须等于按迁移规则从 `thread_command_receipts` + `think_inbox` 推出的集合；在 `verify-migrate-fixtures` 里插入 think 和 owner 两类行，并做“删掉回填 UPDATE 必须失败”的反向用例。

### 3. [低] 真实路径没有带 origin 的用例，删掉关键 `historyRow` 调用测试也不会红

文件:行：`scripts/delivery-mode/packet-template/maintenance/verify-fixtures.mjs:28-29,239-250,638`；`scripts/delivery-mode/packet-template/maintenance/verify-migrate-fixtures.mjs:50`；`scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:965,972`；`scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs:74`

问题：新增的自动检查只断言了 `historyRow` 这个辅助函数本身；fixture 的 `threads` 是 `(id, body)`，所有逐行比对用例都只加 `extra` 列，从没让 `historyDigests` 或 `compareHistoryRows` 看到过一行带 `origin` 的 `threads` 数据。`verify-migrate-fixtures` 的 `threads` 也是空表。

证据（读代码证实）：
```js
// verify-fixtures.mjs:28
assert.deepEqual(historyRow("threads", { __rowid: 1, id: "thread:1", origin: "think" }), { __rowid: 1, id: "thread:1" }, ...);
// verify-fixtures.mjs:244
["history column added", "...HISTORY_COLUMNS_CHANGED:threads", "ALTER TABLE threads ADD COLUMN extra TEXT", ...]
// verify-migrate-fixtures.mjs:50
for (const table of historyTables) database.exec(`CREATE TABLE "${table}"(id TEXT PRIMARY KEY,status TEXT);`);
```

推测：如果把 `read-s0-db.mjs:74` 或 `maintenance-common.mjs:965/972` 的 `historyRow` 调用删掉或只应用一侧，当前所有测试仍会通过；后果是上线到 S7/S8 才失败，而 S8 在服务启动之后，失败会触发回滚。这不是数据损坏，但是一次本可提前发现的停服窗口失败。

建议：在 `verify-fixtures` 里造一个“reference 没有 origin、live 有 origin”的 `threads` 用例，断言两边相等；再加“只改 origin 别的列不变仍通过、改 body 必须失败”；并让 `verify-migrate-fixtures` 的 `threads` 带上若干行，跑完整的迁移前后 `history` 比较。

### 4. [低] ADR、读回设计文档和 S8 证据仍声称唯一例外是 recovery_json

文件:行：`docs/adr/0086-generate-release-packets-from-parameters.md:51`；`scripts/delivery-mode/packet-template/maintenance/P-readback-design.md:42`；`scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:1010`；`scripts/delivery-mode/packet-template/maintenance/verify-fixtures.mjs:638`

问题：代码新增了第二个例外（出包侧 `threads` 加列回填，部署侧 `threads.origin` 不参与历史比较），但文档仍写着“唯一的例外”。

证据（读代码证实）：
```md
<!-- ADR 0086:51 -->
唯一的例外是 `0083_model_invocation_owner_lost.sql` …
```
```md
<!-- P-readback-design.md:42 -->
… 上线前已有的行不能删、列不能变、内容不能改，唯一例外是 `sandbox_execution_records.recovery_json` …
```
```js
// maintenance-common.mjs:1010
return { ..., allowedStartupRecoveryColumns: startupRecoveryColumns, tables };
// verify-fixtures.mjs:638
scope: "... S8 row-by-row history against the S3 copy (old rows kept, new rows allowed, only sandbox recovery_json may change) ..."
```
S8 的 `s8-history-preserved.json` 因此会漏报本次新加的 origin 例外。

建议：同步修改 ADR 0086、`P-readback-design.md` 和 `verify-fixtures` 的 scope 文案，并在 S8 证据里增加类似 `ignoredHistoryColumns` 的字段，明确列出 `threads.origin` 是被有意忽略的。

### 5. [低] `history_ignored_columns()` 用正则解析运行时常量，是同一规则的第三份表示

文件:行：`scripts/delivery-mode/make-packet.py:199-204`；`scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs:59`

问题：出包侧用正则从源码文本里重新解析 `historyIgnoredColumns`，和运行时的对象是两份独立表示，格式一变（单引号、换行、改成普通对象字面量）就可能解析成空集或错误集合。

证据（读代码证实）：
```py
match = re.search(r'historyIgnoredColumns = Object\.freeze\(\{(.*?)\}\)', source, re.S)
...
return {table: tuple(re.findall(r'"([a-z_]+)"', names)) for table, names in re.findall(r'([a-z_]+): Object\.freeze\(\[(.*?)\]\)', match.group(1))}
```
当前模板格式下解析结果正确，且解析失败会拒绝出包（失败关闭），所以不是现存缺陷。

推测：以后改这一行格式时，最坏结果是出包拒绝（安全），但也可能把某个表漏掉；由于 make-packet 只校验“声明”，真正生效的是 `historyRow` 的行为，两者没有互相验证。

建议：把忽略列定义放到一个机器可读的 JSON/数据文件，由 `read-s0-db.mjs` 和 `make-packet.py` 共用；或者至少加一个夹具，断言解析结果与 `historyRow` 对 `threads`/其他表的实际行为一致。

---

## 对作者特别提问的回答

- **每个阶段前后两边是否都经过 `historyRow`**：S3、S7_DB_STATUS、S7_CONFIG_APPLY、S7_CATALOG_UPGRADE、S9_RAW_RESTORE 的历史比较都是 `historyDigests`，两边都经过；S8 的 `verifyHistoryAgainstRecoveryPoint` 逐行比较的两边也都经过（`maintenance-common.mjs:965,972`）。S0 的 history 只作为证据保存，代码里没有和后续阶段比较（`readFrozenS0` 只取 authorization/capabilities）。
- **生成器提前退出时底层迭代器是否关闭**：会。`live` 是在 `for...of` 上 suspend 的生成器，`live.return()` 会触发 IteratorClose 调用底层 better-sqlite3 迭代器的 `return()`；原代码本来也在 finally 里对底层迭代器调用 `return()`。没有专门断言关闭的用例，但现有“历史被改/列被加”的负向夹具会在抛错后继续使用同一个连接，算间接覆盖。
- **回填 UPDATE 会不会被其他检查拦下**：不会。`migrationComparedSections` 的 `history` 忽略 origin，行数不变，`releaseReceipts`/`capabilities`/`authorization`/`integrity`/`foreignKeys` 都不看 origin；`migration_ledger` 因摘要命中而放行；`S7-switch-start-readback.py:233` 比较的两份历史摘要同样忽略 origin。所以部署侧没有任何检查核对回填结果。
- **还有没有别的地方逐行读 `threads` 做比较**：没有。`scripts/operations/hermes-native-history-import*.mjs` 只读 `message_watermark,revision`；其余读 `threads` 的地方是业务查询，不做迁移前后比较。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本 diff 只改出包/维护脚本和复核材料，没有改系统提示、工具定义、历史消息或遮盖；`historyRow` 只影响发版证据里的历史摘要，不进入模型请求。发给模型的内容仍只在末尾追加，本 diff 没有新增任何进入请求头的每轮变化值。依据 `prompt-prefix.md` 第 4 条。迁移和 `threads.origin` 的业务过滤属于基线里的 PR 558，不在本 diff；我没有审计它对记忆摘要等后台调用输入的影响（未核实）。
2. **同一段文字会不会在不同请求里变成不同的字节？** 不会（就本 diff 而言）。`canonicalJson` 按键排序；`historyRow` 只按列名过滤；没有新增时间、随机数或无序集合序列化。`compareHistoryRows` 的键顺序依赖 SQLite 列顺序，但同一 schema 下确定；`origin` 由 `ALTER TABLE` 追加在末尾，过滤后与迁移前顺序一致。既有的 `checkedAt: new Date().toISOString()` 只写证据，不发给模型。
3. **有没有对应自动检查，反向用例会不会真的失败？** 出包侧有：`npm run check` 的 `check:delivery-packet` 跑新用例，反向用例（改 SQL、错文件名、错表名）会真的返回 `[]`。维护侧只有辅助函数 `historyRow` 的断言（在出包检查里跑），真实 `historyDigests`/`compareHistoryRows` 路径没有带 origin 的用例；删掉 `read-s0-db.mjs:74` 或 `maintenance-common.mjs:965/972` 的调用，现有检查不会红（读代码推断，未实跑）。摘要常量是否正确无法用允许的工具计算（未核实），但写错会让新单测和出包失败。
4. **每个值产生处和使用处两端是否都能接受？** 出包侧四项（文件名、摘要、`threads`、`origin`）两端一致：文件名来自 git 树/迁移引擎，`threads` 在 `historyTables` 中，`origin` 在解析出的忽略列表里，摘要按 `sha256(sql.strip())` 精确绑定（`make-packet.py:188-204,262-267`）。运行时的 `historyIgnoredColumns`/`historyRow` 被 `historyDigests` 和 `compareHistoryRows` 使用，两端都按同一列名过滤（`read-s0-db.mjs:59-65,74`；`maintenance-common.mjs:965,972`）。唯一不一致的是 S8 证据字段 `allowedStartupRecoveryColumns` 和文档文案仍只列 `recovery_json`，没有反映新增的 origin 例外（见第 4 条）。
