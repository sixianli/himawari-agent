## 未核实项

- `.agents/reviews/pr-462/round-1/*` 在当前稀疏检出里不存在；`git show`/`git log -p` 读该路径被策略拒绝（`REVIEW_GIT_REFUSED records-path`）。因此第 1 轮第 5、6 条的原文我未核实，只能按作者说明中对应的两点核对代码。
- 没有运行测试，以下反向用例结论均来自读代码推演。

## 读代码证实的问题（按严重度）

### 中 — 未登记的 purpose 可被 `Object.prototype` 上的名字绕过

文件：`packages/platform-node/src/tenant-configuration.ts:90`、`test/tooling/tenant-secret-purposes.test.ts:50,56`

问题：`TENANT_SECRET_PURPOSE_CLASSES` 是普通对象字面量（`tenant-configuration.ts:30-45`），用 `TENANT_SECRET_PURPOSE_CLASSES[purpose]` 查表会命中原型链。`purpose` 为 `"constructor"`、`"toString"`、`"valueOf"`、`"hasOwnProperty"` 等时，返回值不是 `undefined`，而是继承来的函数；随后 `secretClass !== "shared"` 成立，非模型引用的密钥会被当作 `per-tenant` 接受，而不是抛 `PURPOSE_UNCLASSIFIED`。这与作者“没登记的用途一律拒绝”的说法不符。`safeReference` 允许这些字母串（`packages/platform-node/src/strict-configuration.ts:1599`），所以可达。

证据：

```ts
const secretClass = TENANT_SECRET_PURPOSE_CLASSES[purpose];
if (secretClass === undefined)
  throw new TenantConfigurationError(... PURPOSE_UNCLASSIFIED ...);
```

自动化检查同样漏掉：`test/tooling/tenant-secret-purposes.test.ts:50` 用 `purpose in TENANT_SECRET_PURPOSE_CLASSES`，`in` 也会命中继承属性。

建议：用 `Object.hasOwn(TENANT_SECRET_PURPOSE_CLASSES, purpose)`，或把表建成 `Object.create(null)` 后再冻结；检查脚本也改用 `Object.hasOwn`，并补 `purpose: "constructor"` 的反向用例。

### 中 — 已有密钥文件只校验元数据，失败写入留下的半成品会被当成 `kept`

文件：`packages/platform-node/src/tenant-configuration.ts:316-336`

问题：已有文件只检查普通文件/权限/属主，不检查内容是否是可用的 32 字节密钥。更关键的是，`open(..., "wx")` 先创建文件，`writeFile`/`sync` 失败时 `finally` 只 `close()`，不会删除半成品。下一次 provision 会把这个空文件或截断文件当成合法私有文件 `kept` 并返回成功，掩盖了上次写入失败。

证据：

```ts
if (existing) {
  if (!existing.isFile() || (existing.mode & 0o077) !== 0 || ...)
    throw ...;
  kept.push(`${ref}.${version}`);
  continue;
}
const file = await open(target, "wx", 0o600);
try {
  await file.writeFile(...);
  await file.sync();
} finally {
  await file.close();
}
```

建议：对已有文件校验解码后正好 32 字节；写入失败时 `unlink(target)` 再抛错。补空文件、截断文件、`0644`、符号链接、属主不符的反向用例。

### 中 — 密钥文件名 `${ref}.${version}` 有歧义，不同 ref/version 可落到同一文件

文件：`packages/platform-node/src/tenant-configuration.ts:311`、`packages/platform-node/src/host-secret-source.ts:134`

问题：ref 和 version 都允许包含 `.`，用 `.` 拼接文件名不是单射。`ref="a.b", version="c"` 和 `ref="a", version="b.c"` 的键对分别是 `a.b@c`、`a@b.c`，但都映射到文件 `a.b.c`。provision 会先写一个、再把另一个报成 `kept`，两个不同用途的密钥共用同一份密钥材料；读取端也使用同样的拼接，因此不会报校验错误。另有一个小的长度边界：`assertReferencePart` 允许每段 128 字符，拼出的文件名最长 257 字节，可能超过常见文件系统 255 字节的 `NAME_MAX`，预校验通过但 `open` 报 `ENAMETOOLONG`。

建议：用 `assertReferencePart` 不允许的字符（例如 `@`）作为文件名分隔符，或在写入前显式检测目标文件名冲突；同时限制拼合后的长度。

### 低 — 共用密钥的 ref/version 没有走同一套校验

文件：`packages/platform-node/src/tenant-configuration.ts:298-301`、`packages/platform-node/src/host-secret-source.ts:119-120,134`

问题：新增的 `assertReferencePart` 预校验只遍历 `classification.perTenant`。被模型引用的 shared 密钥如果在 base 配置里写成 `nested/key` 或 `user@key`，`synthesizeTenantConfiguration` 和 `provisionTenantKeyFiles` 都会成功，直到运行时 `RestrictedProviderSecretSource`/keychain 读取才失败。这是 I-73 式的“产生端接受、使用端不接受”。

建议：在 `synthesizeTenantConfiguration` 或 `check` 阶段对全部 `secretReferences`（至少 shared 部分）统一跑 `assertReferencePart`，并补 shared 反向用例。

### 低 — 名册检查是 `lstat` 后按路径打开，存在 TOCTOU，且只查主文件

文件：`apps/admin-cli/src/tenant-command.ts:55-65`

问题：先 `lstat(rosterPath)` 校验普通文件/权限/属主，随后 `RosterStore.open(rosterPath)` 按路径重新打开。若攻击者能在 `lstat` 与打开之间替换成符号链接，检查会被绕过。另外只检查 `roster.sqlite` 主文件，没有检查同目录的 `-wal`/`-shm` 文件和父目录权限。

证据：

```ts
const info = await lstat(rosterPath)...
if (!info.isFile() || ... ) throw ... TENANT_ROSTER_UNSAFE);
return RosterStore.open(rosterPath);
```

建议：打开文件描述符后用 `fstat` 校验并以该 fd 打开 SQLite（或用 `O_NOFOLLOW`），同时明确 `sharedRoot` 必须只有管理员可写；补父目录/边车文件的检查。

### 低 — 直接改初始 roster 迁移会让上一版生成的 roster 库 digest 不匹配

文件：`packages/persistence-sqlite/src/roster-migrations.ts:38`、`packages/persistence-sqlite/src/migration-engine.ts:866-879`

问题：`ROSTER_INITIAL_SQL` 被原地修改，`definition()` 会重新计算 digest。任何由 `ad06261d` 创建过的 `roster.sqlite`，再次用本提交打开时 `validateLedger` 会因 digest 不同抛 `SQLITE_MIGRATION_DIGEST_MISMATCH`，没有升级路径。

建议：如果 roster 还未发布，明确记录“旧库需删除”；否则新增一条迁移，不要改已应用的初始迁移。补一条从旧 schema 打开的迁移测试。

## 推测 / 未核实

- 上述 TOCTOU 能否利用，取决于 `sharedRoot` 是否允许攻击者写目录；代码里没有校验父目录权限，实际部署权限未核实。
- 是否存在由 `ad06261d` 生成并保留的 roster 库，未核实；若只存在于临时测试目录则影响很小。
- 提交说明的 `Layer-0-tests` 未列出 `packages/persistence-sqlite/test/roster-store.contract.test.ts`，因此我无法确认月份 CHECK 的反向用例是否在作者声称的 13 个第 0 层文件中实际运行过。
- 第 1 轮第 5、6 条原文未读到，见开头。

## 侧重检查

- 错误路径：`tenantConfigurationPath` 和 `storedPath` 现在只吞 `ENOENT`，其他错误会原样上抛，符合“只有 ENOENT 才报缺失”；但缺非 ENOENT 的反向测试。provision 的写入失败会留下半成品，且下一次被当成 `kept`，是明确的错误路径问题。
- 不合规范/不可信输入：purpose 查表可被原型链名字绕过；ref/version 只按组件校验，存在文件名歧义和超长；shared ref 未校验。
- 安全：roster/密钥文件都检查了普通文件、组/其他可写、属主；密钥目录和文件还检查了 `0700/0600`。不足是 roster 的 `lstat`→`open` 竞态、只查主文件、父目录/边车文件未查。
- 资源耗尽：新增代码没有循环放大或大块读取；主要边界是 257 字节文件名可能超过 `NAME_MAX`，以及 base 配置的深层递归改写（既有逻辑，未发现新增放大点）。
- 不可撤销操作：provision 只创建不删除；但失败写入留下的半成品不会自动清理，可能长期保留并伪装成成功。
- 规则/文档与代码：本 diff 没有触碰发送给模型的内容，因此不涉及 prompt-prefix 规则；`docs` 中没有找到 `TENANT_ROSTER_UNSAFE` 或 roster 相关说明，新增错误码没有文档对应。作者关于“月份 01–12”和“未登记用途拒绝”的说法，后者被原型链绕过打破。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。按 `git diff HEAD~2..HEAD` 阅读，本次改动只在 admin-cli、roster SQLite、tenant 配置合成/密钥 provision 和测试里；没有改系统提示、工具定义、历史消息、遮盖或模型请求组装代码。新增的 `synthesizeTenantConfiguration`/`provisionTenantKeyFiles` 也不在模型请求路径上。因此发给模型的内容仍然只在末尾追加，本次也没有新增“每轮会变”且被放进请求头的值。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

就本 diff 涉及模型文字而言，不会。`classifySecretReferences` 按配置数组顺序返回，`Set` 只做成员判断；`synthesizeTenantConfiguration` 的键顺序沿用输入对象顺序；`now` 只进入 `loadedAt`，而 `initialize-command.ts:60` 在落盘前把它去掉，且它不进入模型请求。`randomBytes` 生成的密钥材料确实每次不同，但那是密钥文件内容，不是发给模型的文字。没有依赖后文遮盖、时间字段或无序列化集合的问题。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

部分有，且部分反向用例从代码推演确实会失败：

- “模型引用未登记 purpose 必须拒绝”：新用例改 `vercel-gateway` 的 purpose；旧代码会走 `usedByModel ? "shared"`，因此旧代码不抛错，用例会失败。成立。
- “保留已有密钥、只补缺、拒绝斜杠/@ 的 ref”：旧代码 `open(...,"wx")` 会 `EEXIST`，且会先写下 `payload-key.v1` 再在非法名字处失败；新用例会失败。成立。
- “roster 组可写/符号链接”：旧代码 `access` 后直接打开，会成功；新用例会失败。成立。
- “月份 00/13 拒绝”：旧 CHECK 的 `[0-1][0-9]` 接受 00 和 13，旧代码下用例会失败。成立，但该测试文件不在提交说明的 Layer-0 清单里，是否实际跑过未核实。
- 没有反向用例覆盖：purpose 为 `"constructor"` 等原型链名字、已有密钥文件权限不安全/符号链接/空内容、非 ENOENT 的 admin 错误。这些分支目前没有会失败的测试。

### 4. 每个产生/修改的值，所有使用它的地方都能接受吗？

- `TENANT_ROSTER_UNSAFE`：产生处 `tenant-command.ts:64`，消费处 `runAdminCli` 的 `stableErrorCode` 接受大写错误码，测试也断言了；两端一致。
- `kept`：新增返回字段，唯一消费方是测试；类型已同步，没有生产调用方遗漏。
- `usage_monthly.month`：目前仓库里没有写入该表的代码，只有迁移和数据库级测试；约束正确接受 `YYYY-01` 到 `YYYY-12`，拒绝 `00/13`，但没有端到端写入方需要核对。
- per-tenant ref/version：产生端 `provisionTenantKeyFiles` 和读取端 `RestrictedSecretFileSource` 都使用 `assertReferencePart`，组件校验一致；但文件名字符串拼接存在歧义，两个不同的 ref/version 可以落到同一文件，这一层两端“都接受”反而是问题。
- shared ref：产生/合成端没有做 `assertReferencePart`，读取端会做；带 `/`、`:`、`@` 的 shared ref 会在合成后、运行时才失败。
- purpose：正常名字两端一致；原型链名字在分类端被误接受，且工具测试的 `in` 检查也漏掉。

### 关于第 1 轮第 5、6 条

无法读到第 1 轮原文，不能确认“判为不成立”的具体依据。就作者说明对应的两点看：

- “admin-cli 只有 ENOENT 才报缺失/未开户”：代码确实只在 `ENOENT` 时抛 `TENANT_ROSTER_MISSING`/`TENANT_NOT_PROVISIONED`（`tenant-command.ts:55-58,82-85,210-216`），字面成立；但没有非 ENOENT 的反向测试，且 roster 的 `lstat`→`open` 竞态仍存在。
- “名册文件打开前 lstat，拒绝非普通文件、组/其他可写、属主不符”：`tenant-command.ts:59-64` 确实实现了；但只覆盖主文件，未覆盖父目录和 SQLite 边车文件，也没有防止检查后替换。
