## 总体结论

本轮核心修复方向是对的：`main.yml` 的 `full` 现在在作业级授予 `contents: read`、`actions: write`、`pull-requests: read`，`validateMainWorkflow` 要求它正好是这三项，`validateCallerGrantsCalledPermissions` 又用 `ci.yml` 的顶层和作业级权限逐项核对。没有发现能让 I-93 类启动失败漏过去的当前可用路径。问题集中在三处：对 GitHub 的 `write-all`/`read-all` 字符串写法处理错误（但在现有流水线里会被更早的校验挡住，不会漏判）、事故清单引用了已被本轮删掉的旧报错文字、ADR 0201 的表述已和代码不一致；另有测试覆盖缺口。

---

## 发现（按严重度）

### 1. 低：`write-all` / `read-all` 字符串写法被按字符遍历，错误码不符合作者说法

- 文件:行：`scripts/ci/main-workflow.mjs:21-27`
- 问题：`Object.entries(permissions ?? {})` 假定 `permissions` 一定是映射。GitHub 允许 `permissions: read-all` / `write-all` 这种字符串写法；对字符串做 `Object.entries` 会得到 `[["0","w"],["1","r"],...]` 这种字符下标对。于是：
  - `ci.yml` 里写 `write-all` / `read-all` 时，仍会抛错（因为 `granted["0"]` 是 `undefined`，排名 0），所以**不是漏判**，但抛的是 `MAIN_WORKFLOW:full-grants-0-w` 之类，而不是作者说的 `MAIN_WORKFLOW:full-grants-<scope>-<level>`。
  - 如果调用方自己用字符串写法（例如未来 `main.yml` 的 `full.permissions: write-all`），则 `granted[scope]` 对任意真实 scope 都取不到值，会把所有申请都当成未授予，产生误报。
- 证据（亲自读到）：

  ```js
  const granted = main.jobs?.full?.permissions ?? main.permissions ?? {};
  const requested = [ci.permissions, ...Object.values(ci.jobs ?? {}).map((job) => job.permissions)];
  for (const permissions of requested)
    for (const [scope, level] of Object.entries(permissions ?? {}))
  ```

  现有流水线里 `ci.yml` 的字符串写法会先被 `check-policy.mjs` 的 `requireReadPermissions` 拒绝：

  ```js
  assert(
    permissions && typeof permissions === "object" && !Array.isArray(permissions),
    `${label}: permissions must be explicit`,
  );
  ```

  （`scripts/ci/check-policy.mjs:326-329`；`main.yml` 的 `full` 字符串写法则先被 `validateMainWorkflow` 的 `sameEntries` 拒绝。）
- 建议：在遍历前把 `permissions` 规范化：字符串 `read-all`/`write-all` 展开为已知 scope 的完整映射，其他非映射值直接显式抛 `full-grants-invalid`。同时补 `write-all`、`read-all`、`permissions: {}` 三条反向/正向用例。

### 2. 低：事故清单 I-93 引用了已被本轮测试改写删掉的失败文字

- 文件:行：`docs/incidents-and-gates.md:127`
- 问题：该行「证据」写「`[I-93]` 用例以“main.yml full 没有授予 actions: write”失败」。但本轮测试改写后，断言只匹配错误码，不再有这句中文提示。
- 证据：清单原文：

  > 证据：把 `main.yml` 退回修复前，`[I-93]` 用例以“main.yml full 没有授予 actions: write”失败；修复后通过

  当前测试实际断言：

  ```js
  expect(() => validateMainWorkflow(reverted, tools)).toThrow("full-permissions");
  expect(() => validateCallerGrantsCalledPermissions(reverted, ci)).toThrow(
    "full-grants-actions-write",
  );
  ```

  （`test/tooling/ci-optimization.test.mjs:168-173`）
- 建议：把清单里的引文改成 `MAIN_WORKFLOW:full-permissions` / `MAIN_WORKFLOW:full-grants-actions-write`，或去掉具体文字，只描述行为。

### 3. 低：ADR 0201 仍写「其他作业只读」「只有 required 可以带 actions: write」，与新的 `main.yml` 不符

- 文件:行：`docs/adr/0201-delete-run-reports-after-gate-passes.md:51`
- 问题：本轮给 `main.yml` 的 `full` 作业加了 `actions: write`，ADR 0201 的表述在仓库范围内已不成立。设计规范第 129、274 行已经改成「`ci.yml` 里只有该作业」「除汇总作业和 `main.yml` 的 `full` 调用作业外」，ADR 没同步。
- 证据：ADR 原文：

  > 其他作业仍然只读。`scripts/ci/check-policy.mjs` 把这写成硬规则：只有 `required` 作业可以带 `actions: write`……

  代码：

  ```yaml
  full:
    needs: plan
    permissions:
      contents: read
      actions: write
      pull-requests: read
  ```

  （`.github/workflows/main.yml:61-66`）
- 建议：把 ADR 第 51 行限定为「`ci.yml` 内」，并补一句 `main.yml` 的 `full` 调用作业需要转授 `actions: write`，与设计规范第 129、274 行一致。

### 4. 低：接线测试只做源码文本包含，且缺关键反向用例

- 文件:行：`test/tooling/ci-optimization.test.mjs:138-142`
- 问题：证明「检查进入 `check:ci-policy`」的用例只断言 `scripts/ci/check-policy.mjs` 文本里包含 `validateCallerGrantsCalledPermissions(mainWorkflow`。如果调用被移走、只留下注释里的同名字符串，这条测试仍会通过。另外，作者问到的 `write-all` / `read-all`、`permissions: {}`、`full` 缺键/多非写权限键都没有反向用例。
- 证据：

  ```js
  expect(readFileSync("scripts/ci/check-policy.mjs", "utf8")).toContain(
    "validateCallerGrantsCalledPermissions(mainWorkflow",
  );
  ```

- 建议：用探针调用 `main()`（或对导入函数做 spy）证明它真的被执行；补上述边界用例。现有 6 条反向用例本身是真会抛错的（见下文必答 3）。

---

## 读代码证实的

- `validateCallerGrantsCalledPermissions` 的实现、`validateMainWorkflow` 改为 `sameEntries` 后要求 `full.permissions` 正好三项：`scripts/ci/main-workflow.mjs:7-9,17-29,52-56`。
- `check-policy.mjs` 的 `main()` 在 `:1284-1286` 读取 `main.yml` 并先 `validateMainWorkflow`、再调用 `validateCallerGrantsCalledPermissions`。
- `npm run check:ci-policy` 就是 `node scripts/ci/check-policy.mjs`（`package.json:91`），且 `check:steps` 包含它（`package.json:27`），`npm run check` 由 `scripts/run-all-checks.mjs:32` 从 `check:steps` 展开。
- 当前 `ci.yml` 顶层只有 `contents: read`、`pull-requests: read`（`:21-23`），只有 `required` 作业有 `contents: read`、`actions: write`、`pull-requests: read`（`:383-386`）。
- `check-policy.mjs` 的 `requireReadPermissions` 会先拒绝 `ci.yml` 里的字符串权限或未知 scope（`:325-339`），并在 `:381`、`:434-435` 对所有作业执行。
- 新增 6 条测试确实存在，并且第 2–6 条都是直接调用函数并断言抛错/通过，不是因为环境原因偶然通过（`test/tooling/ci-optimization.test.mjs:130-192`）。
- 设计规范第 129、274 行已写明 `main.yml` 的 `full` 权限例外。

## 推测 / 未核实

- **未运行测试**：工具限制只能读文件和跑 git 命令，以上「反向用例会失败」是按代码路径推导，未实际执行。
- **未联网核实 GitHub 运行时**：作业级 `permissions` 高于工作流级 `actions: read` 能否真正转授给被调用工作流，是按 GitHub 的作业级覆盖语义和事故分析推断；没有实际运行 `main.yml` 验证 `startup_failure` 已消失。
- **未核实** `scripts/check-incident-gates.mjs` 是否还会校验 I-93 行里的引文内容；从文档描述看它只校验格式、状态和门槛文件是否存在。该行引用的文件都存在。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。本次改动只涉及 CI 工作流、CI 校验脚本、tooling 测试和文档/复核记录，没有改动系统提示、工具定义、历史消息、出口遮盖或任何发送装配路径（`scripts/model-review/*` 也未改）。因此发给模型的内容仍然只在末尾追加，每轮变化的值仍只在最后一条消息里。复核记录是新增文件，不是对已发送请求内容的改写。依据 `prompt-prefix.md#rules` 第 4、10 条。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

不会。唯一涉及顺序的是 `sameEntries` 里的 `Object.entries(...).sort()`，它只用于 CI 内部比较，作用在 `Object.entries` 新建的数组上，不会改写 workflow 对象或 YAML 字节；没有引入时间字段、随机值或依赖上下文的序列化。模型请求的序列化代码未改动。

### 3. 有没有自动检查，反向用例是否真的会失败？

有，共 6 条，位于 `test/tooling/ci-optimization.test.mjs:130-192`。其中真正会失败的反向路径是：
- 被调用作业要 `actions: write`、调用方只给 `read` → `full-grants-actions-write`；
- 调用方无作业级权限时按顶层算，仍不足 → 失败；
- `ci.yml` 顶层新增调用方没给的 `issues: read` → `full-grants-issues-read`；
- 把 `main.yml` 退回 `actions: read` → `full-permissions` 和 `full-grants-actions-write` 都失败；
- `full` 权限重排仍通过，改成 `contents: write` → `full-permissions` 失败。

缺口：`write-all` / `read-all`、`permissions: {}`、`full` 缺键、接线到 `main()` 的行为验证都没覆盖；接线的现有断言只是文本包含。

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？

逐个核对：
- `main.yml` 新增的 `full.permissions` 三个键值：`validateMainWorkflow` 接受（正好这三项）；`validateCallerGrantsCalledPermissions` 接受并作为授予上限；GitHub Actions 接受标准权限映射；`actionlint`（`scripts/ci/run.mjs:245-249`）处理的是同一文件。设计规范已同步；ADR 0201 未同步（见发现 3）。
- 新错误码 `MAIN_WORKFLOW:full-grants-<scope>-<level>`：只在 `assert` 产生，测试用 `.toThrow("full-grants-actions-write")` 消费，没有其他解析器依赖格式；但字符串写法会生成 `full-grants-0-w`，与约定不符（见发现 1）。
- 新返回值 `{ scopes }`：只被测试断言使用，没有生产消费者，接受。
- `check-policy.mjs` 的新导入和调用：`package.json:91` 的 `check:ci-policy` → `main()` → `:1286` 调用，链路成立。
- I-93 清单行：`check:incident-gates` 会检查门槛文件存在，引用的 `test/tooling/ci-optimization.test.mjs`、`scripts/ci/main-workflow.mjs` 都存在；但引用的旧报错文字已失效（见发现 2）。

---

## 侧重检查

- **错误路径**：缺少 `full` 作业、缺少 `permissions`、未知级别、字符串权限、空映射、YAML 错误、重复键都查过。未知级别 `?? 3` 会失败；字符串权限会失败但错误码错；`permissions: {}` 被忽略，这符合 GitHub「全部设为 none」的语义，不是漏判。
- **不合规范/不可信输入**：`main.yml`/`ci.yml` 用 `uniqueKeys: true`、`maxAliasCount: 0` 解析；作业项为 `null` 时 `job.permissions` 会抛 `TypeError`，仍是失败关闭，但报错不是 `MAIN_WORKFLOW:*`。错误码里直接拼接 YAML 的 scope/level，理论上可带控制字符进 CI 日志，但输入是受审查的仓库文件，风险低。
- **安全**：`full` 获得 `actions: write` 只用于把权限转授给 `ci.yml`；`validateWorkflow` 仍禁止 `required` 以外的作业写 `actions`（`check-policy.mjs:434-435`），`ci.yml` 其他作业不会继承调用方作业的写权限。删除产物仍由 `required` 的脚本按 `report-` 前缀限定，未扩大不可撤销操作范围。
- **资源耗尽**：别名数量受限；新增一次 main.yml 解析，开销可忽略。
- **规则/文档一致性**：设计规范第 129、274 行与代码一致；ADR 0201 第 51 行、事故清单 I-93 引文与代码不一致（见发现 2、3）。
