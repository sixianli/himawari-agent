## 结论

我没有发现会让这 42 条例外被 CI 的 published 校验直接拒绝的字段错误；路径、包名、版本、integrity、sourceUrl、规则名和摘要结构都能对上现有校验。也没有发现改动会影响模型请求前缀或让同一段文字产生不同字节。

但作者的说明里有一处需要更正：**本提交自己的 CI 构建不会使用这 42 条新增例外**，因为 published 校验读的是 base 的清单，而不是候选清单；“模拟 60 条全部命中”只有在把 HEAD 当成 base 时才成立。另有几处内容级说法无法在离线仓库内核实。

## 问题（按严重度）

### 中：新增例外在本提交的 CI 中不会生效

- 文件:行：`scripts/ci/security-exceptions.mjs:232`，`scripts/ci/security-published-fixtures.mjs:20-29`，`test/tooling/security-published.test.mjs:148-160`
- 问题：`loadReviewedExceptions` 在 base 已有清单时使用 base 的字节，而不是候选文件；`security-published-fixtures` 又通过它构造白名单。因此本次新增的 42 条在真实 PR/提交 CI 中不会参与构建产物校验。
- 证据：
  - `scripts/ci/security-exceptions.mjs:232`：`const bytes = available ? git(root, ["show", \`${context.baseSha}:${exceptionPath}\`]) : candidate;`
  - 紧接着 `:233-234` 用这份 base 字节做 `withoutRemovedDependencies` 和 `validateSecurityExceptions`。候选清单只被单独校验，没被用于生成生效例外。
  - `test/tooling/security-published.test.mjs:148-160` 的用例名就是“已接受base阻止候选自加例外改善结果”，并期望 `PUBLIC_ARTIFACT_CONTAINS_SECRET`。
  - `test/tooling/security-review.test.mjs:371-374` 加载真实清单时把 `baseSha` 和 `headSha` 都设成 `head`，所以它能通过，但这不等于真实 PR 的 base 语义。
- 影响：作者说的“模拟 security-published-fixtures，60 条全部被命中”只能证明“把新增条目当作已接受 base”时通过；当前 `bf2b7234` 作为 base 时不包含这 42 条，真实构建仍会对这些成员报 `PUBLIC_ARTIFACT_CONTAINS_SECRET`，要等后续提交的 base 包含它们后才生效。ADR 0198 也写了安全作业目前不阻断合并，因此这更像流程上的两步生效，而不是数据错误。
- 建议：在 PR 说明里明确“本提交只提交提案，下一提交/合并后的 base 才生效”；如果要求同一提交内生效，应走 `.github/security-review-manifest.json` 的 Owner 复核路径，而不是候选清单自加例外。

### 低：作者说的“现有 51 条”与当前文件不一致

- 文件:行：`ci/security-exceptions.json`（当前共 76 条：60 条 published + 16 条 synthetic-secret；diff 新增 42 条 published，故 base 是 34 条）
- 问题：作者说明写“到期日 2026-12-04，与现有 51 条一致”。到期日一致这一半是对的，但“现有 51 条”与改动前的清单数量不符。
- 证据：对当前文件用 grep 计数得到 60 个 `"kind": "published-synthetic-fixture"`、16 个 `"kind": "synthetic-secret"`；本次 diff 只新增 42 条 published 并改了一行 `reviewEvidence`，因此 base 为 34 条。所有 76 条到期日均为 `2026-12-04T00:00:00Z`。
- 建议：更正说明为“现有条目的到期日均为 2026-12-04”或写明实际数量，避免审阅者以为还有 51 条既有条目。

### 低：`sourceProofSha256` 和 `sourceReview` 没有任何使用方校验

- 文件:行：`ci/security-exceptions.schema.json:260-267`；`scripts/ci/security-exceptions.mjs` 中未读取这两个字段
- 问题：作者声称 `sourceProofSha256` 是官方 tarball 的 SHA256，但代码只校验它是 64 位小写十六进制，不拿它和任何 tarball、integrity 或其他来源比对；`sourceReview` 也只校验长度。写错也不会被 CI 发现。
- 证据：`schema.json:260-263` 对 `sourceProofSha256` 只有 `pattern: "^[a-f0-9]{64}$"`；`validatePublishedEntry`（`security-exceptions.mjs:45-69`）和 `security-published-fixtures.mjs:30-67` 都不读这两个字段。
- 建议：要么增加对 `sourceProofSha256` 的实际来源校验，要么在说明中明确它只是人工证据、不是自动门槛。

### 未核实：命中行与理由是否逐条一致

- 文件:行：`ci/security-exceptions.json:1009`、`:1144`、`:1284` 等 reason 字段
- 问题：仓库当前是稀疏检出，`node_modules/` 和 `runtime/node_modules/` 都不在对象库里（`git show HEAD:node_modules/openai/client.d.ts` 和 `runtime/node_modules/.../providers.md` 都报不存在），我无法离线读到官方 tarball 的实际命中行。代码也不校验 `reason` 与命中内容是否对应。
- 可确认的部分：AWS 两条的 reason 指向公开示例 `[已遮盖:aws-access-key]`，这确实是公开示例，不是有效凭据；新增条目里没有 `openai-key`、`github-token`、`jwt-token` 命中，只有 `aws-key`、`bearer-token`、`credential-literal`。
- 推测/待核实：`da22585a...` 同时出现在 Pi CHANGELOG、openai client/bedrock 文件；`52477424...` 同时出现在 Pi providers 文档和 openai bedrock 文件。理由文字比较泛化，建议 Owner 复核时逐条对照实际命中的完整字符串，尤其是 `credential-literal` 的值，确认没有真实凭据混在占位符里。
- 建议：在审阅记录中保留每个 digest 对应的实际命中字符串（而不是只写“占位/说明文字”），这样后续复核不依赖重新下载 tarball。

### 未核实：60 条与生产实际应核对的 61 条

- 文件:行：`scripts/ci/security-published-fixtures.mjs:20-29`，`.github/security-review-manifest.json`（node-forge 条目）
- 问题：作者说模拟“60 条发布夹具例外全部被命中、没有未覆盖也没有多余”。但 `createPublishedFixtureReview` 使用 `loadReviewedExceptions`，在 Owner 复核清单生效时会把清单里的 node-forge README 也加入 `expected`，总数应为 61。只模拟文件里的 60 条不等价于生产校验。
- 证据：`security-published-fixtures.mjs:27-29` 从 `reviewed.exceptions` 过滤所有 published 条目；`loadReviewedExceptions` 会合并 `ownerReview.exceptions`（`security-exceptions.mjs:241-248`）。manifest 中确有 node-forge 的 `published documentation example seed` 条目。
- 建议：确认模拟时也包含 manifest 的 node-forge 条目；如果没包含，补一次 61 条成员的核对，或把“60 条”改成“文件内 60 条、另有 manifest 1 条”。

## 侧重检查

- **错误路径/不可信输入**：新增条目全部通过 schema 的 `additionalProperties: false` 和必填字段；路径不含通配符，`path === runtime/${packageLockPath}/${archiveMember.slice(8)}` 的关系成立；包名/版本能在 lock 中找到，规则都在 `publishedRules` 内；同一 entry 内没有重复的 `rule:digest`。未发现会被 `PUBLIC_FIXTURE_PATH_INVALID`、`SECURITY_EXCEPTION_DEPENDENCY_UNKNOWN`、`PUBLIC_FIXTURE_RULE_UNKNOWN`、`PUBLIC_FIXTURE_FINDING_DUPLICATE` 拒绝的条目。
- **两端的值**：我逐个核对了 5 个新增依赖的 lock 条目与例外字段：`@aws-sdk/nested-clients`（`package-lock.json:448-451`）、`@earendil-works/pi-ai`（`:946-949`）、`@earendil-works/pi-coding-agent`（`:1019-1022`）、`@google/genai`（`:1587-1590`）、`openai`（`:6780-6783`）。例外里的 `integrity`、`sourceUrl`、`version` 均与 lock 一致，`security-published-fixtures.mjs:33-36` 的严格相等校验可以通过。
- **范围是否过宽**：机制上每个例外绑定完整成员路径、文件 SHA256 和精确的 `findings`（规则、摘要、次数），文件字节或命中集合变化会分别触发 `PUBLIC_FIXTURE_MEMBER_CHANGED` / `PUBLIC_FIXTURE_FINDINGS_CHANGED`，不是通配或前缀豁免。唯一无法排除的是“文件里本来就同时有真实凭据且被逐条列入 findings”，这一点受限于无法读取 tarball，未核实。
- **资源耗尽/不可逆操作**：改动只是静态 JSON 增项，没有新增循环、下载、解压或写入路径；扫描端仍受既有单成员大小和总展开上限约束。没有不可撤销操作，例外到期自动失效。
- **规则/文档一致性**：ADR 0198 明确写了换 Pi 后安全例外要重做、需 Owner 批准，本次以 `proposed_owner_review_required` 提案形式提交，和文档方向一致。`.claude/rules/prompt-prefix.md` 在当前稀疏检出中不存在，未能读取原文；但本改动不涉及提示词组装代码。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次 diff 只改 `ci/security-exceptions.json`，没有改系统提示、工具定义、历史消息、遮盖逻辑或请求组装代码；也没有任何“在模型请求末尾追加/改写”的行为。发给模型的内容仍然只会在原有代码路径末尾追加，每轮变化的值仍由原逻辑放在最后一条消息里；本次改动不参与该流程。（规则原文未读到，结论来自改动范围和调用链未变。）
2. **不会让同一段文字在不同请求里变成不同字节。** 新增值都是静态 JSON 字符串；唯一的日期是固定 `expiresAt`，`reviewEvidence` 也是固定文本；没有依赖前后文的遮盖、时间戳、随机数或无序集合序列化。
3. **有自动检查，但覆盖的是机制和结构，不是这 42 条的真实内容。** `security-published.test.mjs:191-329` 的反向用例覆盖非法路径、未知依赖、版本/integrity/sourceUrl 不符、未知规则、重复命中、文件字节变化、命中增减、缺失/重复成员，都会按预期抛错；`security-review.test.mjs:342-428` 会加载真实提交的清单并校验全部条目。没有新增测试去验证这 42 条的实际 tarball 命中行、`reason` 和 `sourceProofSha256`；这些只能在构建/人工复核里发现。另见上面的中等问题：真实 PR 的 CI 不会应用候选新增例外，只有把 head 当 base 的测试会通过。
4. **逐个使用方核对结果：**
   - `kind`、`id`、`path`、`package`、`version`、`packageLockPath`、`archiveMember`、`integrity`、`sourceUrl`、`fileSha256`、`findings`、`reason`、`owner`、`reviewReference`、`expiresAt`：分别经过 schema、`validatePublishedEntry`、`security-published-fixtures` 的包源/成员/命中校验、`withoutRemovedDependencies` 的依赖存在性校验，均能接受。没有发现类似 I-73 的“清单里的值过不了后端校验”问题。
   - `sourceProofSha256`、`sourceReview`：只有 schema 校验，没有运行时使用方；结构上可接受，但事实真伪不会被 CI 验证。
   - `proposal.reviewEvidence`：只有 schema 的最小长度校验，追加文本本身不会导致校验失败。
