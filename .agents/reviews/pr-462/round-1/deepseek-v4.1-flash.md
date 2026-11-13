## 结论（按严重度从高到低）

### 1. 中高：未归类的用途只要被模型引用，就会被静默当成“共用”，不会拒绝

- 位置：`packages/platform-node/src/tenant-configuration.ts:89-101`（被 `synthesizeTenantConfiguration` 在 `:173-175` 用于决定哪些密钥原样保留）
- 问题：作者说“出现没归类的用途就拒绝”，但代码先判断 `usedByModel`，只要该 `ref` 被某个模型引用，`secretClass` 就直接变成 `"shared"`，于是 `undefined` 永远走不到 `PURPOSE_UNCLASSIFIED`。这不仅违反约束，还会让一个未归类、本应每人一份的密钥被原样保留在共用配置里。
- 证据：
  ```ts
  const registered = TENANT_SECRET_PURPOSE_CLASSES[purpose];
  const usedByModel = modelSecretRefs.has(ref);
  if (usedByModel && registered === "per-tenant") throw ...PURPOSE_CONFLICT...
  const secretClass: TenantSecretClass | undefined = usedByModel ? "shared" : registered;
  if (secretClass === undefined) throw ...PURPOSE_UNCLASSIFIED...
  ```
  现有反向用例只覆盖“未归类但没被模型引用”和“已归类为 per-tenant 却被模型引用”，没有覆盖“未归类且被模型引用”：`apps/admin-cli/test/tenant-roster-cli.unit.test.ts:165-195`。
- 建议：先判断 `registered === undefined` 并直接拒绝；只有 `registered === "shared"` 时才允许 `usedByModel`，或明确禁止用“被模型引用”覆盖用途分类。补一条模型引用未归类 `ref` 的反向用例。

### 2. 中：密钥文件名由配置里的 `ref`/`version` 直接拼路径，生产端和消费端校验不一致

- 位置：`packages/platform-node/src/tenant-configuration.ts:300-313`（`:306` 写文件），对照 `packages/platform-node/src/strict-configuration.ts:110-116` 和 `packages/platform-node/src/host-secret-source.ts:65-72,134`
- 问题：`provisionTenantKeyFiles` 直接用 `${ref}.${version}` 作为文件名，没有做消费端 `assertReferencePart` 的校验。`safeReference` 允许 `/`、`:`、`@`，长度到 256；而 `RestrictedSecretFileSource` 要求 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`。结果是：
  - 合法通过配置解析的 `ref`（含 `/`、`:`、`@`）会生成运行时读不到的密钥文件；
  - 含 `..` 和 `/` 的 `ref` 经 `path.join` 规范化后可逃出 `secrets` 目录，例如 `a/../../...`。
- 证据：
  ```ts
  const file = await open(path.join(directory, `${ref}.${version}`), "wx", 0o600);
  ```
  ```ts
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(result)) throw ...
  ```
  ```ts
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw ...
  const filePath = path.join(directory, `${secretRef}.${secretVersion}`);
  ```
- 建议：在写入前用与消费端完全相同的 `assertReferencePart` 校验 `ref` 和 `version`，并确认解析后的路径仍在 `directory` 下；补 `../`、`/`、`@`、超长引用等反向用例。

### 3. 中低：所有文件访问错误都被当成“名册缺失/未配置”，掩盖权限和符号链接问题

- 位置：`apps/admin-cli/src/tenant-command.ts:52-59`、`:76-80`、`:205-208`
- 问题：`access`/`readFile` 的任何异常都被映射成 `TENANT_ROSTER_MISSING`、`TENANT_NOT_PROVISIONED` 或 `{present:false}`。`EACCES`、`ELOOP`、I/O 错误等会被误报为“文件不存在”，既误导排查，也会掩盖可能的安全配置问题。
- 证据：
  ```ts
  try { await access(rosterPath); } catch { throw new Error(TENANT_COMMAND_ERROR_CODES.ROSTER_MISSING); }
  ```
  ```ts
  const stored = await readFile(storedPath, "utf8").then(
    (text) => JSON.parse(text) as unknown,
    () => undefined,
  );
  ```
- 建议：只把 `ENOENT` 映射为“缺失/未配置”，其他错误原样抛出并保留错误码；`tenant check` 读取存储配置时同理，只有 `ENOENT` 才算 `present:false`。

### 4. 中低：密钥预置不是幂等的，部分失败后无法继续

- 位置：`packages/platform-node/src/tenant-configuration.ts:298-315`
- 问题：每个 key 都用 `wx` 打开。若前一个 key 已存在（例如上次在中途崩溃，`payload-key.v1` 已写、`identity-csrf.v1` 未写），重新运行会在第一个已存在文件上抛 `EEXIST`，永远不会补上后面的密钥。测试 `apps/admin-cli/test/tenant-roster-cli.unit.test.ts:254-263` 反而把“必然抛 EEXIST”固化成期望。
- 证据：
  ```ts
  const file = await open(path.join(directory, `${ref}.${version}`), "wx", 0o600);
  ...
  written.push(`${ref}.${version}`);
  ```
- 建议：先 `lstat` 每个目标文件；已存在时校验普通文件、0600、所有者，然后跳过；只生成缺失的。若确实要禁止覆盖，也应返回明确的“部分已预置，可安全重试”状态，而不是让重试永久失败。补“第一个已存在、第二个缺失”的用例。

### 5. 低：`tenant check` 发现配置漂移也不失败

- 位置：`apps/admin-cli/src/tenant-command.ts:196-228`
- 问题：`differingFields` 只作为返回值输出，命令仍返回 `0`。如果这个命令的用途是“检查这个人存着的配置是否和基础配置合成结果一致”，漂移应当是非零失败；现有测试只断言无漂移时 `differingFields: []`，没有漂移用例。
- 证据：
  ```ts
  storedConfiguration:
    stored === undefined ? { present: false } : {
      present: true,
      differingFields: differingConfigurationFields(...),
    },
  ```
- 建议：当 `differingFields.length > 0` 时抛 `TENANT_CONFIGURATION_MISMATCH`（或用单独的 `--allow-drift`），并补一条篡改存储配置后 `tenant check` 失败的用例。

### 6. 低：新增的用途分类守卫不在本地 `npm run check` 里，且缺少“写死额度”的反向检查

- 位置：`package.json` 的 `check:steps` / `check:*`；`ci/policy.json` 的 `tooling` 项目；`test/tooling/tenant-secret-purposes.test.ts`
- 问题：事实是没有任何 `check:*` 脚本引用 `test/tooling/tenant-secret-purposes.test.ts`，它只会在 CI coverage 的 `tooling` 项目里跑。若本地门禁是 `npm run check`，这条守卫不会在本地阻断。另 ADR 0234 第 8 条要求“代码里出现写死的额度数字，检查必须失败”，本 PR 没有对应的反向检查（新增名册表本身没有写死额度，这一点是对的）。
- 证据：`package.json` 的 `check:steps` 没有 tenant 相关步骤；`ci/policy.json` 的 `tooling.include` 是 `test/tooling/**/*.test.ts`。
- 建议：增加如 `check:tenant-secret-purposes` 并接入 `check:steps`，或并入现有 `check:*`；同时补一个扫描代码/模板中写死额度数字的反向用例。

### 7. 低（安全加固）：名册文件未检查文件类型、符号链接和权限

- 位置：`apps/admin-cli/src/tenant-command.ts:52-59`，`packages/persistence-sqlite/src/roster-store.ts:137-140`
- 问题：`openExistingRoster` 只用 `access`，随后 `RosterStore.open` 直接打开并可能创建/迁移数据库。没有像配置读取那样做 `lstat`、拒绝符号链接、检查 0600/属主。Shared root 若被他人控制，`roster.sqlite` 可以是指向另一个 SQLite 文件的符号链接；读取或迁移会落到意料之外的文件。当前是管理员 CLI、且 shared root 通常 0700，所以实际风险有限。
- 证据：
  ```ts
  await access(rosterPath);
  return RosterStore.open(rosterPath);
  ```
  ```ts
  static open(databasePath: string): RosterStore {
    const database = openQualifiedDatabase(databasePath);
    applyMigrations(database, ROSTER_MIGRATIONS);
  ```
- 建议：打开前 `lstat` 名册路径，要求普通文件、非符号链接、组/其他不可写（最好属主匹配），并与 `JsonFileConfigurationPort` 的安全检查对齐。

---

## 推测 / 未核实

- 第 6 条的“是否真正阻断合并”取决于仓库的合并策略；代码事实是 `npm run check` 不会运行该 tooling 测试。
- `assertStateRootUsable` 只做字符串级路径比较，没有 `realpath`；符号链接别名可能绕过“不包含别人目录”的判断。不过 `runInitializeCommand` 用 `realpath(path.dirname(root))` 做了兜底，其他调用路径未核实。
- 我没有运行任何测试（工具限制只允许读文件和指定 git 命令），所以“反向用例会失败”只能按断言和实现推断。

---

## 侧重检查

- **错误路径**：查了 `resolveTenantArguments`、`openExistingRoster`、`tenantConfigurationPath`、`tenant check`、`RosterStore.add/setLimit/bindSubject`。参数校验（重复 flag、`--config` 混用、绝对路径、tenantId 前缀）是完整的；主要问题是第 3 条把所有 errno 都吞成“缺失”。
- **不合规范/不可信输入**：查了 `--tenant`/`--shared-root`、基础配置 JSON、`safeReference`、密钥 `ref/version`。发现第 2 条的文件名/路径问题；名册 SQL 使用参数绑定，未发现注入。
- **安全**：查了密钥分类、密钥文件权限、密钥目录属主、配置符号链接、名册符号链接。分类绕过（第 1 条）和路径逃逸（第 2 条）是主要问题；`provisionTenantKeyFiles` 对目录的 `lstat`、0700、属主检查是好的。
- **资源耗尽**：`tenant check` 每次调用都建临时库并应用 94 个迁移，属于可重复的管理操作，未发现无限循环；名册审计表没有保留期限，长期会增长，但 10–20 人规模不构成即时问题。
- **不可撤销操作**：`wx` 确实不会覆盖已有密钥，方向正确；但部分写入后不可恢复（第 4 条）。名册打开会执行迁移，未来新增名册迁移时是否会因缺少快照而拒绝打开，未核实。
- **规则/文档一致性**：本 PR 没有改提示词、工具定义、历史或遮盖相关代码；ADR 0234 第 8 条的“写死额度反向检查”没有落地。作者关于触发器（`roster-migrations.ts:64-75`）、`wx`、共享密钥原样保留的说法，除第 1 条的分类绕过后基本与代码一致。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？是否仍然只在末尾追加、每轮变化值在最后一条消息？

不会。本 PR 没有改动任何提示词、工具定义、历史组装或出口遮盖代码；`runAdminCli` 在没有 `--tenant` 时由 `resolveTenantArguments` 原样返回参数（`apps/admin-cli/src/tenant-command.ts:95-96`），单人文路径不变。新增的 `synthesizeTenantConfiguration` 改变的是每人一份的配置值和状态目录，不是每轮运行的请求内容；测试也验证了“用主人自己的编号合成时，基础配置逐字段相同”（`tenant-roster-cli.unit.test.ts:143-158`）。因此现有“发给模型的内容只在末尾追加、每轮变化值只在最后一条消息”的约束没有被破坏。未核实：本 PR 尚未把租户配置接入运行时，且我没有运行 `check:prompt-prefix`。

### 2. 同一段文字会不会在不同请求里变成不同字节？

在新增代码的当前使用路径里没有证据。`synthesizeTenantConfiguration` 对相同的 base+tenant+now 是确定的；`tenant check` 对合成配置和存储配置使用同一个 `now`；名册列表和 JSON 输出顺序固定；随机密钥字节是预置密钥文件，不会进入模型请求。
需要注意的是：`synthesizeTenantConfiguration` 的默认 `now = new Date().toISOString()`（`:167`）会进入 `configuration.loadedAt`；如果将来有调用方直接序列化 `configuration` 而不是 `raw`，同一输入会产生不同字节。当前新增代码只使用 `raw` 或显式传入 `now`，因此暂未构成问题，建议调用方始终显式传入 `now` 或只持久化 `raw`。

### 3. 有没有对应的自动检查？反向用例会真的失败吗？

有测试，但我没有运行：
- `apps/admin-cli/test/tenant-roster-cli.unit.test.ts`：覆盖配置合成、目录嵌套、密钥不共用、最长 slug、`.@` 拒绝、名册 CLI。
- `packages/persistence-sqlite/test/roster-store.contract.test.ts`：覆盖触发器修订号、usage 不加修订号、邮箱/登录身份唯一、数据库 CHECK。
- `test/tooling/tenant-secret-purposes.test.ts`：扫描源码用途是否都有分类。

缺口：
- 未覆盖“未归类用途 + 模型引用”的绕过（第 1 条），这是最需要补的反向用例。
- 未覆盖 `ref/version` 含 `/`、`@`、`..` 时的写入和读取（第 2 条）。
- 未覆盖 `tenant check` 发现漂移时失败（第 5 条）；未覆盖部分密钥已存在时的重试（第 4 条）。
- 未覆盖“按位置解析参数”的命令（例如 `sandbox list-unconfirmed`）；现有测试只测了使用键值解析的 `db status`。代码上看，只有当 `--tenant`/`--shared-root` 被放在原来 `--config` 的位置时，原地替换才成立。
- `test/tooling/tenant-secret-purposes.test.ts` 不在 `npm run check` 的步骤里；ADR 0234 要求的“写死额度数字必须失败”的反向检查没有新增。

### 4. 每个新产生/修改的值，使用它的地方都能接受吗？

逐个核对结果：
- `tenantId`：`assertTenantSlug`、数据库 CHECK、`tenantStateRoot` 三处一致；最长 32 字符有测试。
- `ownerId`/`agentId`/`deploymentId`：`assertTenantIdentifiers` 同时过 domain 和 `machineString`，`verifyTenantIdentifiersOnRealDatabase` 还过真实迁移和 `initializeProductIdentity`，测试覆盖。注意 `RosterStore.add` 只校验每个 ID 单独合法，不校验它们必须由 `tenantId` 派生；未来若用其它代码填名册，可能出现“alice 的目录里放 bob 的 ownerId”这种配置，数据库唯一约束只能防重复，不能防错配。
- `stateRoot`：严格配置解析器要求规范化绝对路径，`init` 又用 `realpath` 校验父目录；嵌套检查是字符串级，符号链接别名未核实。
- 密钥 `ref`/`version`：生产端写文件与消费端读取的校验不一致，见第 2 条。
- 密钥分类结果：存在未归类被当成 shared 的路径，见第 1 条。
- `revision`：`tenants`/`limits` 的增删改触发器会加一，`usage_monthly` 没有触发器；`tenant list` 读取，契约测试覆盖。
- `monthlyLimit`：`setLimit` 要求安全整数且非负，数据库 CHECK 也要求非负；`usage_monthly.month` 的 CHECK 只校验形如 `YYYY-MM`，会接受 `2026-19` 这类非法月份，属于较松的约束。
- 名册文件路径：没有像配置文件那样的符号链接/权限检查，见第 7 条。
- 审计 `detail`：`JSON.stringify` 写入、数据库 `json_valid` 约束、`JSON.parse` 读出，格式一致；时间戳和 `expiresAt` 没有格式校验，但当前没有消费方依赖格式。
