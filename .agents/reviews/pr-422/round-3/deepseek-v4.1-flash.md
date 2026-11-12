# 复核结论

范围：`d895728…`（main，含 PR 416）→ `d3534fe…`（合并结果）中 `ci/security-exceptions.json` 的冲突解决；并对照上一轮 `c844a83…` 的增量。结论：**没有发现指向锁文件不存在依赖/版本、重复 published 路径、误删无关 main 条目、或到期日/proposal 违规的问题**。作者的实质描述与文件一致；问题主要在“验证证据”这一条说法上。

另外，`c844a83…d3534fe` 的增量本身只是：条目重排、`reason` 措辞、`reviewEvidence` 合并，以及把已存在的 zod-server/onnx 条目从文件末尾移到中间；没有新增版本号/路径变更。

## 读代码证实的问题

### [低] `npm run check` 并不校验工作区里的这份候选文件

- 文件:行：`package.json:26-27`、`scripts/ci/check-security.mjs:567-597`、`scripts/ci/security-exceptions.mjs:226-234`
- 问题：作者用“npm run check 50 步全过”作为本次冲突解决正确性的证据，但本地 `check` 的唯一相关步骤 `check:gitleaks` 只读取 **base 提交**的例外、且只取 `synthetic-secret`，不会校验工作区里改过的 `published-synthetic-fixture` 条目。
- 证据：
  - `scripts/ci/check-security.mjs:569-583` 读取 `git show ${context.baseSha}:ci/security-exceptions.json`，不是候选文件；
  - `scripts/ci/check-security.mjs:587-589` 只保留 `entry.kind === "synthetic-secret"`；
  - `scripts/ci/security-exceptions.mjs:229-233` 才是“校验候选、但有效例外仍取 base”的入口，它只在完整 security / publish 流程里调用；
  - `.agents/instructions/delivery-mode.md:18` 也明确写着本地 check “也不校验工作区里改过的 `ci/security-exceptions.json`，这些仍只有 CI 会拦”。
- 影响：`npm run check` 全过不能证明这次合并后的 `published-synthetic-fixture` 条目能被 CI 接受；它只证明 base 的 synthetic 例外在新锁文件下没坏。
- 建议：合并前至少用当前 `package-lock.json` 跑一次 `validateSecurityExceptions`/`loadReviewedExceptions`（或直接跑 CI security/publish 作业），再以 CI 结果为准；也可考虑把候选文件的校验纳入本地 check。

## 未核实（推测/离线无法证实）

- `@modelcontextprotocol/server` 2.3.1 的 6 个 dist 成员名、`fileSha256`、`findings`（`ci/security-exceptions.json:1839-1859`、`:1864-1884`、`:1940-1959`、`:1965-1984`、`:1990-2009`、`:2015-2034`）以及“index.cjs/index.mjs 不再命中”无法在离线环境核对。若任一项不符，发布准入会在 `scripts/ci/security-published-fixtures.mjs:55-72` 以 `PUBLIC_FIXTURE_MEMBER_CHANGED/FINDINGS_CHANGED/MEMBER_MISSING` 失败。
- zod 4.6.7 的 `string.test.ts`、onnxruntime 的 `libonnxruntime.so.1` 的实际成员内容与命中集合同样未离线核对。
- 没有运行 CI；PR 自身是否绿未核实。

## 侧重检查

- **错误路径**：全量 76 条例外我按校验器逐类核对——所有 `published-synthetic-fixture` 的 `package`/`version`/`packageLockPath` 都能在当前锁文件找到；重复身份、过期、依赖不存在分别由 `SECURITY_EXCEPTION_DUPLICATE`、`SECURITY_EXCEPTION_EXPIRED_OR_INVALID`、`SECURITY_EXCEPTION_DEPENDENCY_UNKNOWN` 拦截。未发现会走错误分支的条目。
- **不可信/不规范输入**：新条目的 `path` 都满足 `path === runtime/${packageLockPath}/${archiveMember.slice(8)}`（`security-exceptions.mjs:46-53`），`archiveMember` 以 `package/` 开头，路径无通配符；`validatePublishedEntry` 会拒绝越界或通配写法。
- **安全**：删除的 8 条仅对应已从锁文件消失的 `@octokit/*` 与 `universal-github-app-jwt`（最终 `package-lock.json` 中已无这些路径）；新增/改登的都是精确到单个文件的例外，没有按包或目录放行；`published-synthetic-fixture` 在源码扫描路径里被显式排除（`scripts/ci/check-security.mjs:274`），不会扩大源码命中的豁免面。
- **资源耗尽/不可撤销操作**：本改动是静态 JSON，无运行时资源影响；删除/新增均可由 git 回退，无可逆性风险。
- **规则/文档一致性**：docs 要求 published 例外绑定包名、版本、锁路径、integrity、成员路径、成员摘要、规则/摘要/次数、Owner、到期日；新条目字段齐全。唯一不一致就是上面的“npm run check 作为验证证据”。

## 本次材料四问

1. **指向锁文件不存在包或版本：没有。**
   - `@modelcontextprotocol/server` 2.3.1 + `sha512-e59M…` 见 `package-lock.json:1670-1673`，与文件 `:1839-1844`、`:1864-1869`、`:1940-1945`、`:1965-1970`、`:1990-1995`、`:2015-2020` 一致。
   - 三条 zod 4.6.7 + `sha512-g8W2…` 见 `package-lock.json:1640-1643`、`:1661-1664`、`:1683-1686`，与 `:351-356`、`:376-381`、`:1889-1894` 一致。
   - `onnxruntime-node` 1.30.0 + `sha512-twhs…` 见 `package-lock.json:6332-6335`，与 `:1914-1919` 一致。
   - 最终 `package-lock.json` 已完全没有 `@octokit/*` 和 `universal-github-app-jwt`，删除是对的。

2. **重复路径：本次涉及的 published 条目没有重复。** 60 条 `runtime/...` published 路径全部唯一。文件里另有两处**同一路径的 pre-existing synthetic-secret 条目**（`ci/security-exceptions.json:247` 与 `:273`，同为 `packages/platform-node/test/http-gateway-server.contract.test.ts`），但 `digest` 不同、身份键包含 `id+path+digest`，校验器允许；不是本次合并引入。

3. **main 原有、与本 PR 无关的条目：没有误删或改动。** `d895728..d3534fe` 的差异只有：`reviewEvidence`、三条 zod 版本/reviewReference/sourceReview、删 6 条 `@octokit`、删 2 条 `universal-github-app-jwt`、server dist 的 4 删 2 改 4 增、onnx 条目换位置内容不变。

4. **到期日/proposal：满足校验。** 76 条 `expiresAt` 全为 `2026-12-04T00:00:00Z`；`proposedAt` 为 `2026-11-04T00:00:00Z`，差值正好 30 天（校验是 `<= 30*86400000`）；`owner` 全为 `sixianli`，等于 `proposal.owner`；`status` 合法；没有 advisory/semgrep 混入，故不会被 `SECURITY_PROPOSAL_SCOPE_INVALID` 拒绝（`security-exceptions.mjs:116-142`）。

## 必答问题

1. **不会改变模型已见过的请求开头。** `ci/security-exceptions.json` 只被 `scripts/ci/*` 和 tooling 测试读取，不进入系统提示、工具定义、历史或遮盖。此改动没有在请求里新增任何每轮变化的值，追加语义不受影响；因此“只在末尾追加、变化值在最后一条消息”仍然成立。
2. **不会让同一段文字在不同请求里变成不同字节。** 这是静态 JSON 配置，不参与请求序列化；`proposedAt`/`expiresAt` 是固定常量，不是运行时生成。无无序集合、无顺序依赖。
3. **有自动检查，反向用例确实会失败。** `validatePublishedEntry`（`security-exceptions.mjs:45-70`）和 `security-published-fixtures.mjs:32-72` 覆盖依赖存在性、路径映射、integrity/URL 对锁文件、成员字节与命中集合。反向用例在 `test/tooling/security.test.mjs:403-427`、`test/tooling/security-published.test.mjs:191-321`；其中 `security.test.mjs:635-675` 正是“base 里有已删依赖的例外、候选不删就必须失败”的场景，候选删掉后才通过。**但**如上面的低严重度问题，本地 `npm run check` 不执行这项候选校验。
4. **每个修改值的两端都能接受。**
   - `path`/`packageLockPath`/`archiveMember`：生产端（例外文件）与消费端 `security-exceptions.mjs:46-53` 的等式一致。
   - `package`/`version`：与 `package-lock.json` 的 `path/name/version` 一致（`security-exceptions.mjs:54-62`）。
   - `integrity`/`sourceUrl`：与锁文件 `integrity`/`resolved` 一致（`security-published-fixtures.mjs:32-36`）；注意这层比对只在发布准入里做，`validatePublishedEntry` 本身不比对 integrity。
   - `findings.rule`/`digest`：`bearer-token`、`jwt-token` 均在 `publishedRules` 内，且每条内无重复 `rule:digest`。
   - `id`/`kind`/`expiresAt`/`reviewReference`/`fileSha256`/`sourceProofSha256`/`reason`/`sourceReview`：均通过 schema 的形状与长度/正则约束；`reviewReference` 均为 `pull/422` 或 `pull/381`。
   - 未核实的一端仍是实际 tarball 成员字节与命中数（见上）。
