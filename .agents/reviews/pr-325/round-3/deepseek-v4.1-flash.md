## 复核结论

说明：受工具限制，我只能读代码和跑允许的 git 命令，**没有实际执行测试**；下面涉及“测试会失败/通过”的判断来自阅读断言，标注为“未运行”。

---

### 中

**1. `scripts/check-operations.mjs:91-104` 残留检测仍有假阴性：只认 `"`/`'`，且 `message(`/`measure(` 例外按标识符名放行**

问题：作者说“任何带引号的名字字面量都算”，但实现只遍历 `"` 和 `'`，反引号模板字符串、字符串拼接都不检测；而且两个例外只看字面前缀是否是 `\bmessage(` / `\bmeasure(`，不限制来源文件或调用对象，任何 `xxx.message("已删操作")`、`xxx.measure(a, "已删操作")` 都会被放过。

证据（亲自读到）：
```js
function removedNameUsed(text, name) {
  for (const quote of ['"', "'"]) {          // 不含反引号
    const literal = `${quote}${name}${quote}`;
    ...
      const before = text.slice(Math.max(0, at - 60), at);
      if (!/\bmessage\(\s*$/.test(before) && !/\bmeasure\([^,()]*,\s*$/.test(before)) return true;
```
这意味着 `type: \`session.revoke\`` 或 `rpc.message("session.revoke")` 这类真实残余不会被拦。当前真实仓库没有这类残余（我 grep 全仓带引号的形式，只命中 i18n 的 `memory.search`/`inbox.digest` 和 `production-run-composition.ts:227` 的 `timings.measure(..., "memory.search", ...)`、`memory-page.tsx` 的 `message("memory.search")`，这些恰好都在豁免/排除范围内），所以**当前不会误报**；但门槛对新写法的覆盖不完整。

建议：把反引号也纳入；把 `message(` 例外收紧到 i18n 的 `message`（按导入/文件路径），把 `measure(` 例外收紧到具体的计时辅助函数；补一条 `rpc.message("已删操作")` / 模板字符串的反向用例。

---

### 低

**2. `scripts/check-operations.mjs:176-184` 删掉 `ci/operations-removed.json` 会静默关掉所有“已删操作”守卫**

问题：待接入名单缺失会报 `OPERATIONS_LEDGER_MISSING`，但已删除名单缺失时 `removed` 保持 `[]`，不报错，检查照常通过。

证据：
```js
if (existsSync(removedPath)) {
  try { removed = Object.keys(JSON.parse(...).removed ?? {}); }
  catch { errors.push("OPERATIONS_REMOVED_LEDGER_UNREADABLE"); }
}
// 没有 else 分支
```
建议：补 `OPERATIONS_REMOVED_LEDGER_MISSING`，与待接入名单对称。

**3. `docs/adr/0192-delete-unimplemented-gateway-operations-and-gate-new-ones.md:49` 与代码不一致**

问题：ADR 第 6 条仍写“只要求不以 `type: "名字"`、`type === "名字"`、`case "名字"` 形式出现”，但代码已改成“任何带引号的字面量（除 message/measure）”。第 3 轮只同步了“后果”一节，决定条目没同步。

证据：ADR:49 原文；代码 `scripts/check-operations.mjs:91-104`。
建议：把第 6 条改成“任何带引号字面量都算，界面文案 id 和计时标签除外”，与代码/测试描述一致。

**4. `test/integration/production-memory-capture.test.ts:1314-1327` “忽略后再取消”没有断言中间状态真的写成 `dismissed`**

问题：测试直接调用 `store.update` 改成 `dismissed`，但忽略返回值；如果这次 update 因 `expectedUpdatedAt` 冲突返回 `false`，随后 `cancel` 仍会把 `scheduled` 改成 `cancelled`，断言照样通过，测试并未真正覆盖“已忽略→取消”。

证据：
```ts
await store.update({
  id: other, expectedUpdatedAt: scheduled?.updatedAt ?? "",
  status: "dismissed", ...
});                                  // 没有 expect(...).toBe(true)
await tool("cancel", { reminderId: other }, "call-after-dismiss");
expect(await store.read(other)).toMatchObject({ status: "cancelled" });
```
建议：`expect(await store.update(...)).toBe(true);` 并先断言 `status === "dismissed"`。

**5. `apps/control-center/src/app/control-center-inventory.ts:59-71,157-168` 清单说“blocked/missing”，运行时的 `isSurfaceInstalled` 却可能返回 true（推测，当前无用户可见影响）**

问题：tasks 页 `contractStatus: "missing"`、`integrationPolicy: "blocked"`，但 `isSurfaceInstalled` 只看操作列表非空且已安装；现在 tasks 只剩 `github.monitor.set_state`，该操作一安装 `isSurfaceInstalled` 就为 true。`integrationPolicy/contractStatus` 运行时完全没被读取。

证据：`isSurfaceInstalled` 只做 `operations.length > 0 && operations.every(...)`（59-71 行），tasks 定义见 157-168 行；`app.tsx:534-538` 的 `governanceSurface` 不含 tasks，所以最终仍落到 `PageNotFound`（app.tsx:659-671），**当前没有渲染器，因此只是语义不一致**。
建议：要么让 `isSurfaceInstalled` 尊重 `integrationPolicy/contractStatus`，要么把 tasks 明确标成“仅 github monitor 可用”的部分契约，避免清单与运行时判定矛盾。

---

## 侧重检查

- **错误路径**：`ProductionReminderWriter.cancel` 更新失败抛 `REMINDER_UNAVAILABLE`（production-reminder-writer.ts:305）；已取消提醒再次 `dismiss/snooze` 抛 `MEMORY_REMINDER_CANCELLED`（production-memory-control.ts:866-870）；`update` 校验 `scheduled` 与 `dismissed_at` 必须互斥（sqlite-memory-reminder-operations.ts:164-169）。均有对应测试（production-memory-capture.test.ts:1181-1183、1160-1180）。
- **不合规范/不可信输入**：模型工具参数有长度/白名单校验（production-reminder-writer.ts:362-370）；DB 约束把 `status` 限制为三值（0085.sql:9,13），`cancelled` 必须带关闭时间，测试覆盖（migration contract test 插入 `cancelled + null` 应失败）。
- **安全**：`session.revoke` / `health.status` 从网关 v2 删除，但原生接口仍在（`packages/platform-node/src/built-in-identity-routes.ts:150-162` 的 `/api/identity/v1/devices/revoke`；`/api/health/v1/dependencies` 由 e2e fixture 继续提供），没有出现“无法撤销会话/看不到健康”的退化。未发现泄露密钥或放宽鉴权。
- **资源耗尽/不可撤销操作**：0085 是整表重建（`CREATE … / INSERT … / DROP TABLE / RENAME`），在事务内执行，失败可回滚；`applyMigrations` 在 `currentSequence>0` 时要求已验证快照（migration-engine.ts:921）。`memory_reminders` 无其他表外键引用、无触发器/视图，重建后重建了两个索引，测试校验行、外键列表、索引和 `foreign_keys=1`。风险可控。
- **规则/文档与代码一致性**：除上面第 3 条 ADR 不一致外，`schema-catalog.ts:662` 描述已同步为“dismissed or cancelled”，`SUPPORTED_SCHEMA_MAX=85` 与 `CURRENT_SCHEMA_SEQUENCE=85`、`LATEST_MIGRATION_SEQUENCE` 一致。
- **作者特别提问的“两个例外”**：我按真实仓库检索了全部 26 个已删名字的带引号出现，只有 i18n（被 `FRONTEND_EXCLUDED` 排除）和 `message(...)`/`measure(...)`（被例外放行）；**真实仓库目前不会误报**。漏报风险见上文第 1 条。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动只涉及网关 v2 契约/控制面、SQLite 迁移与提醒状态、control-center 清单、CI 脚本、测试和 ADR；diff 没有触及 prompt 组装、工具定义目录或运行历史。`reminder_cancel` 的名称、参数结构、说明文字均未变（production-reminder-writer.ts:86-97），只是执行后写 DB 的状态不同。因此发给模型的内容仍然只在末尾追加，每轮会变的值没有进入系统提示/工具定义/历史。依据：[prompt-prefix.md#rules](../../.claude/rules/prompt-prefix.md#rules)。（未逐行读 `runtime-pi` 的组装实现，但本次文件清单中无相关文件变化。）

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。唯一新增/改变的序列化值是 DB 里的 `status = "cancelled"` 和迁移 DDL，不进入模型请求；没有改动遮盖逻辑，也没有引入依赖后文的遮盖、时间字段进入请求头或无序遍历。新增的 `check:operations` 只在 CI 读文件，不影响运行时序列化。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
有：`package.json` 新增 `check:operations` 并接入 `check:steps`（`npm run check` 会执行，见 `scripts/run-all-checks.mjs`）；`test/tooling/operations-check.test.mjs` 覆盖缺后端/缺调用方/缺测试、pending 完整/无理由/不在契约、installed 越界、已删操作以字面量残留、快照回到契约等反向输入；`memory-reminder-cancelled-migration.contract.test.ts` 用旧 CHECK 下插入 `cancelled` 必失败、整行对比、外键列表、索引、`foreign_keys=1`；`production-memory-capture.test.ts` 覆盖忽略→取消、取消后 dismiss/snooze 抛错、年度提醒取消不顺延。按代码阅读，去掉修复后这些断言会失败（**未实际运行**）。缺口见第 1、2、4 条。

**4. 改动产生/修改的每个值，使用它的地方都能接受吗？**
- `"cancelled"`：产生于 production-reminder-writer.ts:299 与 production-memory-control.ts:888；使用于端口类型（memory-reminders.ts:14）、SQLite update 校验（sqlite-memory-reminder-operations.ts:167，`cancelled+非空` 通过、`cancelled+空` 拒绝）、DB CHECK（0085.sql:9,13）、`listDue/listUpcoming` 的 `status='scheduled'` 过滤（sqlite-memory-reminder-operations.ts:125,142）、web push 的 `!== "scheduled"`（production-web-push.ts:476）、以及取消守卫（production-memory-control.ts:866）。两端一致，没有只认 `scheduled|dismissed` 的遗漏。
- 清单/配置：`memory.overview.read` 在契约（contracts-v2.ts:60）与生产安装名单（production-memory-control.ts:45）中均存在，`control-center-inventory.unit.test.ts:73-84` 校验清单只引用已实现消息类型；`SUPPORTED_SCHEMA_MAX=85` 与 `CURRENT_SCHEMA_SEQUENCE=85`、`LATEST_MIGRATION_SEQUENCE` 对齐。
- 已删名单 26 项与契约列表删除的 26 个名字逐一对得上；在扫描范围内未发现除 i18n/计时标签/界面文案外的残余。
- 待接入名单 23 项：检查会校验“在契约里 + 理由≥10 字 + 补齐后必须移除”，但我**没有运行检查**，无法确认这 23 项在真实仓库全部仍处于缺项状态（未核实）。

---

## 结论

第 3 轮作者说明与代码基本一致：已删名单确实用全部契约名字（含回执）比对；`reminder_cancel` 确实把已忽略改成已取消，且只有工具这一处调用 `writer.cancel`，与网关行为一致；测试也补了对应反向用例。主要问题是**残留检测门槛仍有假阴性**（只认单双引号、`message`/`measure` 例外按标识符名放行），以及**已删除名单缺失时不报错**；另有一处 ADR 文字未同步和一处测试未断言中间状态。生产正确性方面未发现阻断问题。
