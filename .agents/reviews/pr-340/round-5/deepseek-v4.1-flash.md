# 复核结论

本轮改动只涉及 `packages/persistence-sqlite/src/data-export/export.ts`、`directory.ts` 和两个测试文件。核心结论：**当前代码里，编号扫描没有漏掉任何会写出 `[已扣留:N]` 的短文字字段；导入/导出循环里编号稳定且单调递增**。但我发现几处文档、测试和健壮性问题，没有发现高严重度的功能缺陷。以下未运行测试（环境只允许 git/read/grep），测试结论来自读代码推演。

---

## 一、读代码证实的问题

### 1. 中：ADR 仍写着“按本次导出首次出现顺序编号”，与实现不一致

- 文件:行：`docs/adr/0200-portable-export-of-memories-and-decisions.md:53`
- 问题：文档说编号“按本次导出里首次出现的顺序给”，暗示每次从 1 重排；实现已改成接着库里已有占位的最大编号往后排。
- 证据：
  - ADR：`编号按本次导出里首次出现的顺序给，同一原文同一编号、不同原文不同编号，不会撞主键`
  - 代码 `packages/persistence-sqlite/src/data-export/export.ts:137`：`number = existingPlaceholderMax + shortTextNumbers.size + 1;`
- 建议：把 ADR 改成“接着该库已有占位的最大编号往后排；同一库内同一原文同一编号、不同原文不同编号；未导入过的新库仍从 1 开始”。`export.ts:428-431` 的 `omitted.reason`（“按出现顺序编号”）也建议同步补一句“接着已有编号”。

### 2. 中：编号扫描是手工枚举 6 个数组，只有实体名一处有回归用例

- 文件:行：`export.ts:118-127` 扫描 `entities/aliases/provenance/people/decisions/signals`；测试 `test/integration/data-export.test.ts:661-680` 只往 `memory_entities` 塞占位。
- 问题：扫描清单没有自动化保护。今后若新增一个走 `safeString/safeJson` 的字段，忘了加进这个数组，就会退回“复用旧编号 → 撞主键/唯一约束”的老问题，而现有测试仍然全绿。
- 证据：
  - `export.ts:120-127`：`const scanned = JSON.stringify([snapshot.entities, snapshot.aliases, snapshot.provenance, snapshot.people, snapshot.decisions, snapshot.signals]);`
  - `export.ts:337-338、347、351-352、356` 对这些集合里的 `detail/counts/inputs/subjectRef/pushSourceKey/sourceRef` 做 `safeJson/safeString`
  - `data-export.test.ts:676-679` 断言的只有实体名：`SELECT name FROM memory_entities WHERE name LIKE '[已扣留:%' ...`
- 建议：补一条测试：在 `aliases`、`provenance.source_id`、`people.relation`、`decision.counts/inputs/subject_ref`、`decision_signals.detail/source_ref` 各放一个已有的 `[已扣留:大编号]`，再加一个新密钥，断言新占位编号严格大于既有最大值；并在扫描处加注释说明“与 `safeString` 的调用点一一对应”。

### 3. 低：短口令用例的断言太弱，改完仍不能证明走的是“长度不足”分支

- 文件:行：`test/integration/data-cli.test.ts:335-336、352`
- 问题：先 `chmod 0600` 再写 `short\n` 的修复是对的（旧写法 `writeFile(..., {mode:0o600})` 不会改变已存在文件的权限，实际测到的是 0700 的权限拒绝）。但最终只断言 `code !== 0`，即使权限仍不安全也会通过，无法证明覆盖的是短口令分支。
- 证据：
  - `apps/admin-cli/src/data-command.ts:83-86`：`if (!status.isFile() || (status.mode & 0o177) !== 0) throw ...PASSPHRASE_FILE_UNSAFE; ... if (text.length < 12) throw ...ARGUMENT_INVALID`
  - `data-cli.test.ts:352`：`expect(refused.code).not.toBe(0);`
- 建议：断言 stderr/输出里含 `ADMIN_DATA_ARGUMENT_INVALID`（或至少与权限失败的错误码区分），让反向用例真正锁定短口令路径。

### 4. 低：`lstat` 吞掉所有错误，非 ENOENT 会以裸文件系统错误逃出

- 文件:行：`packages/persistence-sqlite/src/data-export/directory.ts:15-18`
- 问题：`lstat(root).catch(() => null)` 把 EACCES/ELOOP/ENAMETOOLONG 等都当成“不存在”，随后 `mkdir` 抛出的会是原生 fs 错误，而不是带 `PATH_UNSAFE` 的 `DataExportError`；同时 `lstat` 与 `mkdir` 之间仍有符号链接替换的 TOCTOU 窗口。
- 证据：`const existing = await lstat(root).catch(() => null); if (existing !== null && !existing.isDirectory()) throw new DataExportError(...PATH_UNSAFE...); await mkdir(root, { recursive: true, mode: 0o700 });`
- 建议：只把 `ENOENT` 当作不存在（其他错误原样抛出或包装成 `PATH_UNSAFE`）；`mkdir` 后再 `lstat` 一次确认是目录且非符号链接。静态文件/符号链接的反向用例已能过，但错误码一致性建议收紧。

---

## 二、推测 / 未核实

### 5. 低（推测）：占位数字位数无上限，理论上可导出自己 import schema 拒绝的值

- 文件:行：`export.ts:128-129` 用 `(\d+)` 取任意长度数字；消费者有长度上限：`schemas.ts:118`（实体 1..64）、`127-135`（人物 1..64/关系 1..32）、`206、210、226`（256）；DB 侧 `0057_memory_page.sql:28-30、41`、`0080_decision_signals.sql:10`。
- 说明：正常使用下编号很小，不会超长。但若库里被塞入一个几十位数字的 `[已扣留:...]`（不可信/被篡改的库），`existingPlaceholderMax` 会把新占位编号推成同样多的位数，导出本身不做 schema 校验，随后导入会因 `maxLength` 整份拒绝。
- 建议：对扫描到的编号设上限（例如超过某值就忽略/报错），或在导出时对生成的占位长度做校验。此为推断，未构造实际用例验证。

### 6. 低（推测）：为扫描编号把整份元数据 `JSON.stringify` 一遍，增加峰值内存

- 文件:行：`export.ts:120-127`
- 说明：大库（`detail/inputs` 很大、行数很多）会额外复制出一份完整的元数据字符串，导出本身已将全部行读入内存并生成文件。未测量实际影响。
- 建议：按字段/按行扫描，或复用已经序列化的内容，避免一次性拼接整份快照。

---

## 三、侧重检查（错误路径、不可信输入、安全、资源、规则/文档一致性）

- 不可信输入/绑定：`safeString` 生成的占位是短 ASCII+中文，所有消费者（DB CHECK 1..64/1..32/1..256、JSON Schema 同值、JSON 对象键无长度限制）都能接受；唯一例外是推测 5 的位数无上限。
- 唯一约束/主键：`memory_entities(memory_id,name)`、`memory_person_aliases(person_id,alias)`、`memory_provenance(memory_id,source_type,source_id)`、`decision_signals UNIQUE(decision_id,signal,source_ref)` 都依赖“不同原文不同编号”。新逻辑用全局最大编号往后排，能同时避开这些冲突；旧的“每次从 1 开始”在这些表上确实会撞。
- 错误路径：`writePortableDirectory` 对“目标是普通文件/符号链接”现在稳定抛 `PATH_UNSAFE`，测试会锁住；但对 `lstat` 的其他错误码和 TOCTOU 窗口仍较宽松（见问题 4）。
- 安全：扫描只把原始值放进内存字符串，不落盘；扣留明文仍不写入封存文件以外的位置，未发现新增泄漏面。
- 资源：新增一次整份元数据序列化（问题 6）。
- 规则/文档一致性：ADR 0200 与实现不一致（问题 1）；`memories.test`/gate 未覆盖扫描清单（问题 2）。

---

## 四、必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。增量只改数据导出/导入与测试；`data-export` 仅被 `packages/persistence-sqlite/src/index.ts` 导出、由 admin CLI 使用，没有进入系统提示、工具定义、历史或遮盖的组装路径。发给模型的内容仍是“只在末尾追加”，本改动不涉及。依据的 `prompt-prefix` 规则不受影响。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
对**模型请求**：不会，因为导出不参与模型请求。对**导出文件**：会——同一个机密短文字现在会因目标库已有的最大占位编号不同而得到不同的 `[已扣留:N]`（例如空库得 `[1]`，已有 `[1]` 的库得 `[2]`）。同一库、同一数据重复导出是确定的（占位不回改，`canonicalJson` 按键排序，snapshot 有固定 `ORDER BY`）。`manifest.exportedAt` 仍依赖 `now()`，但那是既有的快照时间，不在数据文件里。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
有 `npm run check:data-export`（`scripts/check-data-export.mjs` 收集 `[P1-6]` 用例并要求 ≥40 条通过）。
- 目录反向用例：旧实现是 `mkdir` 先抛原生 EEXIST，新断言 `code === PATH_UNSAFE`，在旧代码上会失败——有效。
- 重新编号用例：旧实现第二次导出会把新密钥也给 `[1]`，导入第三库时触发 `memory_entities` 主键冲突（或断言得到 `[1],[1]`），在旧代码上会失败——有效。
- 但：短口令用例只断言非 0（问题 3）；扫描清单是否覆盖全部字段没有任何用例（问题 2）。未实际运行，以上为读代码推演。

**4. 改动产生的值，两端校验都能接受吗？**
产生处：`export.ts:132-141`（`[已扣留:N]`）。使用处：实体名、人物名/关系/反向关系、别名、来源 `source_id`、决定的 `subject_ref/push_source_key/inputs/counts`、信号 `detail/source_ref`，以及导入时的同名 DB 列/Schema。逐个核对：
- 导出 schema：`schemas.ts` 中实体/姓名/别名 `text(1,64)`，关系 `text(1,32)`，`sourceId text(1,512)`，`subjectRef/pushSourceKey/sourceRef text(1,256)`——正常短占位都通过。
- 导入 DB CHECK：`memory_entities` 1..64、`memory_people` 1..64/1..32、`memory_person_aliases` 1..64、`memory_signals.source_ref` 1..256——正常短占位都通过。
- 唯一约束：靠“不同原文不同编号”满足，新逻辑成立。
- 唯一不匹配的两端：占位数字位数无上限时可能超 `maxLength`（问题 5，推测）；以及文档消费者 ADR 仍描述旧语义（问题 1，已确认）。
