## 结论

本轮只核对 `ci/security-exceptions.json` 的冲突解决。未发现高、中严重度问题。三个核心问题都成立：main 删掉的 5 条没有回来；main 其余条目和 `reviewEvidence` 没有丢；本 PR 重登/新增的条目与 main 新扫描规则不冲突。只有两个低严重度/提示项。

## 问题（读代码证实的）

### 低 — 新增条目的 `sourceProofSha256` 只有格式校验，没有和真实 tarball 交叉核对
- 文件: `ci/security-exceptions.json:1718,1743,1768,1818,1843,1868,1893`（以及 `:370,395` 的 zod 4.6.7 条目）
- 问题: 冲突解决新产生了 `84efd155…`（zod 4.6.7）和 `96bc3fe0…`（server 2.3.1）两个来源证明值，但当前代码没有任何地方用真实 tarball 的 SHA-256 校验它们。
- 证据:
  - `scripts/ci/security-exceptions.mjs:45-70` 的 `validatePublishedEntry` 只校验 `path`/`packageLockPath`/`package`/`version`/规则和 digest 去重，不碰 `sourceProofSha256`。
  - `scripts/ci/security-published-fixtures.mjs:31-39` 只校验 `dependency.integrity === entry.integrity` 和 `dependency.resolved === entry.sourceUrl`；`:54` 校验 `fileSha256`；`:60-66` 校验 findings。
  - `test/tooling/security-published.test.mjs:465-482` 也只核对 `fileSha256` 和实际扫描结果。
  - `ci/security-exceptions.schema.json:260-263` 对 `sourceProofSha256` 只要求 64 位十六进制。
- 建议: 如果这个字段承担来源证明作用，应在 `createPublishedFixtureReview` 或专门的测试里把它和 npm tarball 的 SHA-256 对上；否则应把字段降级为说明性信息，避免给人“已被校验”的错觉。该缺口不是这次冲突解决引入的，但新值同样落在这个缺口里。

### 低（格式/可维护性）— 四个新 mcp-* 条目把 `expiresAt` 放在 `path` 前面
- 文件: `ci/security-exceptions.json:1799,1824,1849,1874`
- 问题: `mcp-BumlNux0.cjs(.map)`、`mcp-DIH4cS6P.mjs(.map)` 四个条目的字段顺序与其余 67 条不同（`expiresAt` 被放到了 `path` 之前）。JSON 语义和所有消费端都不受影响，我逐条读过也没有发现重复键；这只是合并时人工编辑留下的格式不一致。
- 证据: 上述四行均为 `"expiresAt": "2026-12-04T00:00:00Z"` 紧跟在 `"id"` 后，随后才是 `"path"`；其余条目都是 `reviewReference` 之后才出现 `expiresAt`。
- 建议: 合并前顺手统一顺序，减少后续冲突和人工比对成本。

## 已读代码确认无问题的点

1. **5 条没有带回来**：`git diff d3534fe..f51 -- ci/security-exceptions.json` 只删除了这 5 条并更新了 `reviewEvidence`；当前文件也不存在 `docs/custom-provider.md`、`docs/extensions.md`、`docs/mcp.md`、两个 `examples/extensions/*/index.ts`。
2. **main 其余条目没有丢**：main 有 79 个 `"path"`，最终 71 个；最终缺少的正好是 8 条随 `@octokit/app` 移除的（6 个 README + 2 个 universal-github-app-jwt），以及 4 条旧的 MCP 2.0.0 dist 路径（`index.cjs`、`index.cjs.map`、`index.mjs`、`index.mjs.map`），后者由 4 个新的 `mcp-*` 路径替代。其余 main 路径全部存在；`index.d.cts`、`index.d.mts` 和三份嵌套 zod 是同一路径按新版本重登。
3. **`reviewEvidence` 只追加、没有丢字**：`git diff --word-diff=porcelain main..f51` 显示 main 的整段文字全部保留，唯一变化是末尾在“用真实台账和已安装的依赖文件逐条核对。”之后追加了 PR 422 那一段。
4. **新条目与 main 新扫描规则不冲突**：main 的规则变化只是 `scripts/ci/security-source.mjs:7,73-78` 对 `credential-literal` 排除“整个值就是环境变量名引用”；新登记条目的 findings 全是 `bearer-token` 或 `jwt-token`，不受这条规则影响。
5. **新条目版本/来源与锁文件一致**：`package-lock.json:1640-1691` 中 client/core/server 的嵌套 zod 均为 4.6.7、server 为 2.3.1，`integrity` 与台账逐字一致；`packages/platform-node/package.json` 也确实是 server/client 2.3.1、zod 4.6.7。
6. **删除 8 条 octokit 例外有依赖前提**：`packages/integration-github/package.json` 已移除 `@octokit/app`，`package-lock.json` 中已没有 `@octokit/*` 和 `universal-github-app-jwt`。

## 推测/未核实

- 我**没有运行任何测试**：环境里没有 `node_modules`，且本轮只允许 `git` 命令。因此作者说的 `security-published.test.mjs`、`security.test.mjs`、`security-review.test.mjs` 共 142 例通过，以及 `npm run check` 50 步全过，均标为**未核实**。
- 四个新 `mcp-*` 文件和两份 `index.d.*` 的真实扫描 digest/count 未直接验证；代码层面只能确认它们的 finding 类型不受 main 的 env-var 规则影响，最终仍要依赖 `security-published.test.mjs:446-483` 在安装依赖后逐条核对。
- 两个新的 `sourceProofSha256` 无法离线核对；见上面的低严重度问题。

## 侧重检查

- **错误路径**：`validateSecurityExceptions` 对非法 schema、过期、路径不确定、未知依赖都会抛受控错误码（`security-exceptions.mjs:108-188`）；`security-published.test.mjs:189-195` 覆盖“候选删掉仍有命中的条目必须失败”；`:207-215` 覆盖 base 台账结构错误。
- **不可信/不合规输入**：条目路径必须精确且与 `packageLockPath` + `archiveMember` 对应（`security-exceptions.mjs:45-53,135`）；测试还拒绝 `..`（`security-published.test.mjs:466`）。新增路径均通过这个对应关系。
- **安全**：本轮没有新增真实凭据例外；删除的 5 条正是 main 规则判定为“纯环境变量名引用”的文件，且 `security-published.test.mjs:434-445` 用真实文件断言扫描结果为空。main 的规则本身不在本轮范围。
- **资源耗尽/不可逆操作**：改动是静态 JSON 台账，没有新增循环、外部输入下载或删除/写入运行数据的路径；不涉及不可逆操作。
- **规则/文档/代码一致性**：`reviewEvidence` 引用的 `scripts/ci/security-source.mjs` 和 `test/tooling/security-published.test.mjs` 都存在，行为描述与代码一致；唯一的不一致是上面四个新条目的字段顺序。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这个文件只被 `scripts/ci/*` 和 `test/tooling/*` 引用（grep 未发现运行时代码引用），不在系统提示、工具定义、历史消息或遮盖结果的构造链路上，因此不存在“只在末尾追加”的问题。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。改动是静态 JSON；`reviewEvidence`、`expiresAt` 等都是固定字面量，没有依赖前后文的遮盖、运行时间字段或无序集合生成。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有。`security-published.test.mjs:434-445` 断言 5 个文件在当前规则下无命中；`:446-483` 用真实台账和已安装文件逐条核对 `fileSha256` 与 findings；`:189-195` 证明“删掉仍有命中的条目”会以 `PUBLIC_ARTIFACT_CONTAINS_SECRET` 失败。若把 5 条旧例外重新加回并保留旧 findings，核对测试会失败；若改成空 findings，schema 的 `minItems: 1` 会拒绝。测试本身未在本环境运行，属未核实。
4. **每个值的使用端都能接受吗？** `kind`/`id`、`path`、`packageLockPath`、`archiveMember`、`package`、`version`、`integrity`、`sourceUrl`、`fileSha256`、`findings`、`owner`、`reviewReference`、`expiresAt` 都被 schema 和 `validatePublishedEntry`/`createPublishedFixtureReview` 覆盖；新条目的版本、integrity、URL 与 `package-lock.json` 一致，`reviewReference` 的 `pull/422` 符合 schema 的 pull/commit/issues 正则。唯一没有被实际校验的是 `sourceProofSha256`/`sourceReview`，已在问题清单中列为低严重度。
