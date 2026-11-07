（工具调用已到上限，以下结论仅基于已读到的内容；未读到的明确标「未核实」。）

# 复核结论

## 确认的问题（按严重度）

### 1. 低：作者“放宽或删掉，新样例失败”的说法只对“删掉”成立，对“放宽正则”不成立
- 文件:行：`test/tooling/gitleaks-config.test.mjs:42-43、50、161`；`ci/rules/gitleaks.toml:43`
- 问题：新增样例只验证了“允许路径里的这个精确值不报、同一个值放在另一个文件里照报”，它验证的是**路径限定**，不是**值的精确性**。把 `ci/rules/gitleaks.toml` 的 `regexes = ['''^F5u42Bd3HyW8KxkUqo2gRA$''']` 放宽回字符类 `^F5u42Bd3HyW8Kxk[A-Za-z0-9_-]{7}$` 时：
  - `PUSH_TEST` 里的值仍然命中放宽后的正则 → 仍被放行；
  - `other-push.unit.test.ts` 因路径不匹配仍然照报。
  两者相加与 `EXPECTED_WITH_REPOSITORY_CONFIG` 完全一致，所以 `gitleaks-config` 测试**仍会通过**。作者本轮说“放宽或删掉时新样例失败”，但 71ba88e1 的提交说明只写了“从 gitleaks.toml 删掉那块白名单，gitleaks-config 失败”，并没有“放宽”的验证。
- 证据（亲读）：样例 fixture 与其期望值：
  - `[PUSH_TEST]: ... deviceKey: "${PUSH_DEVICE}" ...`，`"apps/agent-service/test/other-push.unit.test.ts": ... "${PUSH_DEVICE}"`
  - `EXPECTED_WITH_REPOSITORY_CONFIG` 含 `"apps/agent-service/test/other-push.unit.test.ts generic-api-key"`，不含 `PUSH_TEST`；
  - 默认规则用例把 `PUSH_TEST` 当作应报项。
- 影响有限：`test/tooling/gitleaks-allowlist.test.mjs` 的 `scoped[1]`（`changeFirst` / `sameKindLast`）仍在 JS 正则层挡住“放宽成字符类”，所以不是安全漏洞，而是**声称的覆盖范围不实**、真实 Gitleaks 层仍然没有证明“同文件、同形状的别的值会被拒”。
- 建议：在 `PUSH_TEST` 路径下再加一个“同前缀、不同尾字符”的 22 字符值作为反面 fixture，期望它被 `generic-api-key` 报出；或在测试里对 `gitleaks.toml` 做一次真正改成字符类的 mutation 并断言结果变化。修改后把作者说法改成“删掉会失败；路径/条件放宽会失败；正则放宽由 allowlist 测试覆盖”。

### 2. 低：作者用“不在白名单路径里”论证“不会多报或少报”，逻辑不成立
- 文件:行：`scripts/ci/check-security.mjs`（`snapshotCurrent` 用 `git ls-files` 收全部跟踪文件；`scanGitleaks` 扫当前内容 + `headSha` 全祖先）；`docs/adr/0177-gitleaks-exact-value-allowlist.md:44`
- 问题：白名单路径只决定**能抑制哪些命中**；新增文件本来就不在白名单里，反而会按默认规则正常扫描，新增内容完全可能带来新的 `generic-api-key` 命中。PR 276 的路径是否命中白名单，与“security 作业会不会多报”不是同一个问题。本轮增量还新增了 `.agents/reviews/pr-275/round-3/` 记录，同样不在任何白名单路径里。
- 证据（亲读）：`snapshotCurrent` 用 `git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])`；历史扫描范围为 `context.headSha` 的全祖先（`gitleaksHistoryScope`）。PR 276 只改了 `docs/engineering-casebook.md` 和 `.agents/reviews/pr-276/**`，确实都不匹配任何 `paths` 正则。
- 未核实：`.agents/reviews/pr-276/**` 与 `.agents/reviews/pr-275/round-3/**` 的实际内容无法确认（harness 对 records 路径返回 `REVIEW_GIT_REFUSED`，稀疏检出里也不存在），因此**是否真的产生新命中未核实**。可确认的是 `docs/engineering-casebook.md` 新增的案例 85 文本里没有明显会触发 `generic-api-key` 的“关键词+分隔符+高熵值”结构（仅凭肉读，未运行 Gitleaks）。
- 建议：把说法改成“PR 276 只增加文档和复核记录，需以 security 作业实跑结果为准”；或者在合并后跑一次 security 作业确认 finding 数与基线一致。

## 读代码证实的正确之处（不算问题）
- ADR 0177 两处措辞已改准：Spec 已从“个别具体的值仍按逐条例外处理”改为包含 ADR 0177 的现行描述（`docs/execution/specs/...:240`），ADR 0157 头部的 `amended_by` 确实指向 `docs/adr/0177-gitleaks-exact-value-allowlist.md:7`。ADR 0177 背景“PR 275 之前……只写着”与 diff 中的旧文本一致。
- 合并提交 5748200e 没有改动本 PR 的 `ci/rules/gitleaks.toml`、`ci/toolchain-lock.json`、`docs/adr/0177`、`test/tooling/gitleaks-config.test.mjs`、Spec；相对 6bc0c9ec 的实际增量只有 71ba88e1 的改动 + PR 276 文件（`git diff 71ba88e1..5748200e --stat` 仅 `.agents/reviews/pr-276/**` 和 `docs/engineering-casebook.md`）。
- `packages/agent-service/test/production-reminder-push.unit.test.ts` 在当前树中已不存在，ADR 的“已删除的测试文件”说法成立（glob 无结果）。

## 推测 / 未核实
- `ci/toolchain-lock.json` 的 `sha256: c72797bf…` 是否等于当前 `ci/rules/gitleaks.toml` 的摘要：未核实（不能运行 sha256）。间接依据：`gitleaks.toml` 自 6bc0c9ec 起未变，而 6bc0c9ec 同步改过 lock；且 `scripts/ci/install-tools.mjs:332 verifyRuleFiles` 在 security 检查中被调用，若不匹配会 infrastructure_failed。
- PR 276 / PR 275 round-3 复核记录是否含 `generic-api-key` 可命中内容：未核实（无法读取 records 路径）。
- 新增 fixture 中 URL 行 `https://api.day.app/F5u42…` 是否会被默认规则单独命中：未核实（未运行 Gitleaks）；作者称测试通过，若 URL 行以不同 secret 命中，`PUSH_TEST` 会被报出而测试应失败，因此按作者结果推断不命中。

## 侧重检查
- **安全 / 白名单收紧**：本改动的核心是把一条“固定前缀 + 任意 7 字符”收紧为精确值。真实 Gitleaks 层新增样例证明了**精确值在允许路径被放行、同值异地照报**，但没有证明**同路径下同形状的其它值会被拒**；后者只有 JS 正则层测试。属覆盖不完整，非漏洞。
- **不可信输入**：`.agents/reviews/**` 是模型写的文本，会被 security 扫描；本轮新增 review 记录且不在白名单路径，存在新命中风险（未核实实际内容）。
- **错误路径**：新样例若被删块，`PUSH_TEST` 会出现在 `current`/`history` 两处命中里，`expect(findings.current).toEqual(EXPECTED…)` 会失败——逻辑上成立，提交说明也记录了失败并点名该文件。
- **资源耗尽**：测试沿用既有 `beforeAll` 下载锁定 Gitleaks 的模式，超时 180s；未发现新增长期占用或无限循环。
- **不可逆操作**：无；合并只追加提交，未改写历史。
- **规则/文档/代码一致性**：`prompt-prefix.md` 第 11 条、案例 85 引用的测试名 `[I-78] never changes the trusted text, even when it holds a value named elsewhere` 实际存在于 `packages/sensitive-capture/test/trusted-text.unit.test.ts:20`；`I-78` 存在于 `docs/incidents-and-gates.md:116`；`check:prompt-catalog` 通过 `package.json:52` 覆盖 `apps/agent-service/test/trusted-prompt-egress.unit.test.ts`，且该文件同时匹配 node-services 与 unit 两个项目，与案例中“22 次运行”说法一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次增量改的是 `ci/rules/gitleaks.toml` 相关的测试、ADR、案例库文档和复核记录，没有触碰系统提示、工具定义、历史消息、遮盖或提示词目录。`engineering-casebook.md` 不被 `packages/prompt-catalog` 或 `apps/agent-service/src` 引用（grep 无结果）。发给模型的内容仍只在末尾追加，每轮变化的值仍在最后一条消息里；本改动不产生新的每轮变化值。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会。改动与模型出口无关。`gitleaks-config.test.mjs` 里 `githubToken()` 用了 `randomBytes`，但那是测试夹具，不是发给模型的内容；Gitleaks 扫描结果排序/去重也是测试内部确定性处理。未发现依赖时间、前后文遮盖或无序遍历的请求内容变化。

3. **有没有对应自动检查，反向用例是否真的会失败？**
   有。`test/tooling/gitleaks-config.test.mjs` 由 `ci/policy.json:242-243` 的 tooling 项目纳入，`policy` 检查运行 tooling，`security` 依赖 `policy`，所以 CI 会跑。
   - 删掉推送白名单块：`PUSH_TEST` 会作为命中出现，与期望集合不等 → 失败（逻辑成立，提交说明也记录了失败）。
   - 路径放宽成 `.*` 或条件改成 `OR`：`other-push` 会被放行 → 期望集合变化 → 失败。
   - **但把值正则放宽回字符类：新样例不会失败**（见问题 1）；这种情况由 `gitleaks-allowlist.test.mjs` 的 JS 层用例兜底，不是由真实 Gitleaks 层兜底。

4. **改动产生/修改的每个值，两端校验都能接受吗？**
   - `PUSH_DEVICE = "F5u42Bd3HyW8Kxk" + "Uqo2gRA"` = `F5u42Bd3HyW8KxkUqo2gRA`（22 字符）：与 `ci/rules/gitleaks.toml:43` 的 `^F5u42Bd3HyW8KxkUqo2gRA$`、`gitleaks-allowlist.test.mjs` 的样例、ADR 0177:44 的字面值逐字一致，接受。
   - `PUSH_TEST = "apps/agent-service/test/production-reminder-push.unit.test.ts"`：与配置 `paths` 正则 `(?:^|/)apps/agent-service/test/production-reminder-push\.unit\.test\.ts$` 匹配，接受。
   - `"apps/agent-service/test/other-push.unit.test.ts"`：不被该 `paths` 匹配，作为反面期望，接受。
   - `ci/toolchain-lock.json` 的 `sha256`：无法重算，未核实；但 `verifyRuleFiles` 会在 security 检查中校验，且 `gitleaks.toml` 自更新 lock 的 6bc0c9ec 后未再变。
   - 文档值（PR 编号、`main 5cedac65`、测试名、`I-78` 编号、规则第 11 条）：引用均能在对应文件中找到，接受。
