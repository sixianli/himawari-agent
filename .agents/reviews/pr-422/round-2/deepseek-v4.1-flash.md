## 侧重检查

- **错误路径**：重点查了 `ci/security-exceptions.json` 的 base/候选读取、到期日、owner review 继承、PR 编号与评论 `issue_url`。发现一个会让宿主 CI 失败的关键路径：候选分支新增的 published-fixture 例外在 PR 和首次 main 运行中只被校验、不被使用。
- **不合规范/不可信输入**：例外路径必须是精确路径且以 `runtime/<packageLockPath>/<member>` 拼出；版本、integrity、依赖路径都与 `package-lock.json` 核对；评论审批会核对仓库所有者数字身份、仓库、PR、`sourceHead`、清单摘要和有效期。这些新增条目本身没有通配或扩大次数。
- **安全**：新增的 MCP server/zod 例外只覆盖精确文件与精确发现摘要，未放宽到目录或任意 bearer 文本；但 pre-merge 不生效的问题使它无法按作者预期保护本次 PR。
- **资源耗尽 / 不可撤销操作**：本次增量未改扫描器资源上限、归档解包上限或任何删除/覆盖逻辑。
- **规则/文档一致性**：代码侧的审批规则没变；文档仍记录旧的 PR #4 审批和 node-forge 1.4.0，与当前 manifest 不一致（见下）。

## 结论与发现（按严重度）

### 1. 高：新增/修改的 published-fixture 例外在 PR CI 和首次 main 确认中不会生效，构建产物检查会失败【实证】

- 文件：`scripts/ci/security-exceptions.mjs:226-234`、`scripts/ci/security-published-fixtures.mjs:20-38`、`ci/security-exceptions.json:1840-2010`、`.github/security-review-manifest.json:224-235`
- 问题：本轮把 MCP server 2.3.1 的 6 个 dist 条目、server 自带 zod 的 1 条，以及 client/core zod 4.6.7 的 2 条，只写进了 `ci/security-exceptions.json`。但宿主 CI 在 base 已有该文件时，只读取 **base 版本**做实际匹配；候选版本仅做一次校验：

  ```js
  const candidate = readFileSync(join(root, exceptionPath), "utf8");
  validateSecurityExceptions(JSON.parse(candidate), { now, ruleIds, dependencies });
  assert(available || source.initialization, "SECURITY_ACCEPTED_EXCEPTIONS_MISSING");
  const bytes = available ? git(root, ["show", `${context.baseSha}:${exceptionPath}`]) : candidate;
  const document = withoutRemovedDependencies(JSON.parse(bytes), dependencies);
  const exceptions = validateSecurityExceptions(document, { now, ruleIds, dependencies });
  ```

  构建产物检查又从同一函数取例外：

  ```js
  const reviewed = loadReviewedExceptions({ root, context, now, dependencies, ruleIds: ... });
  const entries = reviewed.exceptions.filter(
    (entry) => entry.kind === "published-synthetic-fixture",
  );
  ```

  在 PR 事件中 `context.baseSha = parents[0]`（目标 main），在 push 事件中是 `payload.before`，只有本地 `workflow_dispatch` 不传 `--base` 时才等于 HEAD：

  ```js
  baseSha = parents[0];        // pull_request
  baseSha = commit(/^0{40}$/u.test(payload.before ?? "") ? base : payload.before); // push
  baseSha = commit(base ?? ... : testedSha); // 本地 workflow_dispatch
  ```

  我已核对 `git diff 12ce0d0ad..8b6079296 -- ci/security-exceptions.json` 为空，也就是说 PR 的 base（12ce）里没有 MCP server 2.3.1，也没有 zod 4.6.7。base 里的 client/core zod 4.4.3 条目又会因当前锁文件是 4.6.7 被 `withoutRemovedDependencies` 过滤掉。于是构建归档扫描到 MCP 相关文件时 `expected.get(name)` 为空：

  ```js
  const entry = expected.get(name);
  if (!entry) {
    assert(findings.length === 0, "PUBLIC_ARTIFACT_CONTAINS_SECRET");
  ```

  而本 PR 的 build 任务会正常打包并发布运行时归档，所以只要归档里确有作者列出的这些命中，`publish.mjs` 的公开产物检查就会报 `PUBLIC_ARTIFACT_CONTAINS_SECRET`，PR 无法通过自己的必需 CI；合入后的第一次 main 确认同样用 `before` 作 base，也会失败。

  这也解释了为什么本地打包可能“通过”：本地不传 `--base` 时 base 就是 HEAD，候选例外会被当成 base 使用。已有测试明确钉住了“候选分支自加例外不改变受审阅 base”：

  ```js
  it("候选分支自加例外不改变受审阅base", ...)
  expect(result.exceptions).toEqual([]);
  ```

- 建议：把本轮真正需要在 PR 前生效的 9 条（6 个 server dist + server 自带 zod + client/core 两条 zod 4.6.7）放进候选侧的唯一入口 `.github/security-review-manifest.json`，并让 Owner 评论绑定新的 manifest 摘要。注意当前 `security-owner-review.mjs:314` 把清单里的 published fixture 硬编码成 `credential-literal` 且 `count: 1`，需要先扩展清单格式和该函数，支持显式 `rule`、`digest`、`count`（或多条 findings），否则 MCP 的 `bearer-token` 次数 2 和 zod 的 `jwt-token` 次数 2 无法表达。也可以用 `node scripts/ci/local.mjs --check build --base 12ce0d0ad...` 复现宿主 CI 的失败语义。

### 2. 低：`sourceProofSha256`/`sourceReview` 没有任何消费方校验，作者“由脚本从 npm tarball 算出”的说法无法被自动检查证实【实证】

- 文件：`ci/security-exceptions.schema.json:260-267`、`scripts/ci/security-exceptions.mjs:45-70`、`scripts/ci/security-published-fixtures.mjs:32-67`
- 问题：published fixture 的实际校验只覆盖 `packageLockPath/package/version`、`integrity/sourceUrl`、`fileSha256` 和 `findings`；`sourceProofSha256` 和 `sourceReview` 只被 schema 检查格式。全仓库搜索后，`sourceProofSha256` 只在 schema、生成 manifest 派生条目和测试 fixture 中出现，没有代码拿它和 tarball 摘要比对。因此新加的 `84efd...`、`96bc3f...` 即使写错，CI 也不会发现。
- 建议：在受控步骤里把 `sourceProofSha256` 与下载/缓存 tarball 的 SHA256 做比对，或者在文档和复核说明里明确它只是审阅记录、不参与门禁，避免把它当成已验证事实。

### 3. 低：审批文档仍记录旧评论和 node-forge 1.4.0，与当前 manifest 不一致【实证】

- 文件：`docs/execution/plans/2026-09-03-github-ci-quality-gates-plan.md:453`、`docs/backlog/BL-20261003-001-ci-安-全-例-外-到-期-后.md:66`
- 问题：文档仍写：

  > node-forge 1.4.0 …… 记录见 PR #4 审批评论 5662807447 …… 原始清单摘要为 565c2fda……

  以及旧评论 `6625244385`、`manifestSha256 565c2fda…`。当前 manifest 已是 `pullRequest: 422`、node-forge 1.4.3、comment `6816148518`，文档没有注明这是历史记录还是当前有效审批。代码门禁不读这些文档，不影响功能，但会影响审计可追溯性。
- 建议：如果这些是历史记录，明确标注“已被 2026-11-12 PR 422 审批取代”；如果它们本应记录当前审批，则更新为新 manifest 摘要、评论编号和 node-forge 版本。

## 未核实

- `6816148518` 是否确实是一条由 `sixianli` 发在 PR 422 会话里的 issue comment，且正文里的 `manifestSha256`、`sourceHead`、`expiresAt` 与当前 manifest/有效期一致。离线无法读取 GitHub 评论。若不一致，所有 PR 会在 `SECURITY_REVIEW_IDENTITY_MISMATCH` 或 `SECURITY_REVIEW_SCOPE_MISMATCH` 处失败。
- 新条目和 node-forge 的 `fileSha256`、findings digest/count 是否与真实 npm tarball 和安装文件一致；本环境没有 `node_modules`、没有网络，无法哈希核对。
- MCP server 2.3.1 的 6 个 dist 文件是否穷尽了所有 `bearer-token` 命中；`.map` 文件标 count 1 而 `.cjs/.mjs` 标 count 2，是否与真实扫描结果一致，无法离线确认。
- 作者说“本地打包后核对过”的具体命令和基线未在材料中给出；若本地没有传 `--base`，无法代表宿主 PR 的 base 语义。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本增量（`d22fd2372` + `c844a83a6`）只改依赖版本、锁文件、安全例外 JSON 和一条测试期望，没有触碰系统提示、工具定义、历史消息或遮盖逻辑；也没有新增任何写进请求开头的每轮变化值。发给模型的内容仍由原有代码组装，仍然只在末尾追加。依据：[prompt-prefix 规则](../../.claude/rules/prompt-prefix.md#rules)。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。安全例外/清单不是模型输入；没有新增时间字段、无序集合或依赖前后文的遮盖。依赖锁定和 JSON 序列化不参与模型请求字节。package-lock 的传递依赖变化是确定性的，不影响请求前缀。

3. **有没有对应的自动检查？反向用例会真的失败吗？**
   有。`test/tooling/security-published.test.mjs` 覆盖过期、超过 30 天、owner 漂移、通配路径、非包成员、路径不对应、未知依赖、版本/integrity/URL 不符、未知规则、重复命中、成员内容变化、命中增加/减少/换字面量、缺失/重复成员等反向用例；`test/tooling/security.test.mjs` 覆盖重复、到期、版本范围、未知依赖、`reviewReference`、未知字段、provenance 次数等。问题在于：这些检查验证的是校验器和合成 fixture，**本轮新增的 9 条 published-fixture 例外在宿主 PR 上根本没有进入实际匹配路径**（见发现 1），所以“新条目 hash/findings 是否正确”只有在合入后的 base 中才会真正被消费。真实 tarball 摘要无法在当前环境验证。

4. **每个改动的值，两端能接受吗？**
   - **vitest / @vitest/coverage-v8 4.1.9**：`package.json`、workspace package、`package-lock.json` 都是 4.1.9；`scripts/ci/check-coverage.mjs:104,109-110` 和 `ci/coverage-policy.json:5` 也要求 4.1.9；仓库里已无 4.1.12。两端一致。
   - **installable test 的 client 2.3.1**：`package-lock.json` 与 `packages/platform-node/package.json` 都是 2.3.1；`scripts/package-node-runtime.mjs:213,290` 从安装包的 `package.json` 读版本生成运行时清单；测试期望 2.3.1 与之一致。
   - **新例外的 path/version/integrity**：`validatePublishedEntry` 的路径拼接公式、锁文件依赖身份、integrity/sourceUrl 均核对通过；两端一致。
   - **manifest 的 node-forge 1.4.3**：manifest 的 version/integrity/sourceUrl 与 `package-lock.json:6235-6238` 一致；运行时闭包会经 `@anthropic-ai/sandbox-runtime` 带入 node-forge，路径成立。`fileSha256`/finding 未离线验证。
   - **manifest 的 pullRequest 422 / comment 6816148518**：代码要求评论的 `issue_url` 指向 `/issues/422`、`html_url` 指向 `/pull/422#issuecomment-6816148518`，且评论内 `approval.pullRequest === 422`。若评论确实在 PR 422，合入后其他 PR 的 `inherited` 为真，会跳过 PR 编号检查，仍按 422 校验评论，因此不会因为当前 PR 不是 422 而失败。
   - **sourceHead 不变**：`e2a792f855f82e74519daa9d4bea928370c76c50` 是当前提交的祖先（已用 git 历史核对），ancestor 检查通过；其他 PR 只要从该提交之后的 main 分出也能通过。
   - **本轮新增的 published-fixture 例外**：这是唯一两端不匹配的值——产生在候选 `ci/security-exceptions.json`，但宿主 CI 的消费者只读 base 版本，不接受它们（见发现 1）。
   - **sourceProofSha256/sourceReview**：只被 schema 检查，没有消费者做内容/来源核对，属于审计上的弱校验。
