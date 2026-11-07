## 结论

未发现会扩大放行范围、破坏密钥扫描或改变模型请求的高/中严重度缺陷。本次改动的核心（把 `/^F5u42Bd3HyW8Kxk[A-Za-z0-9_-]{7}$/` 收紧成 `/^F5u42Bd3HyW8KxkUqo2gRA$/`）是严格收窄：新正则匹配的集合是旧正则匹配集合的子集。主要问题集中在文档表述和测试覆盖的小缺口，以及我在工具限制下无法核实的摘要/实跑结论。

## 读代码证实的发现

1. **低** — `docs/adr/0177-gitleaks-exact-value-allowlist.md:42`
   - 问题：背景仍用现在时说“现行 Spec 仍写着……文档和代码不一致”，但同一 PR 已把 Spec 第 240 行改成包含 ADR 0177 的例外路径，合并后这句话会误导读者以为 Spec 未更新。
   - 证据：ADR 第 42 行“ADR 0157 第 1 条和现行 Spec 仍写着‘个别具体的值仍按逐条例外处理’，文档和代码不一致”；Spec 第 240 行现在已是“个别具体的值仍按逐条例外处理；例外清单收不下的（……），按 [ADR 0177]……”。
   - 建议：改成“复核时 Spec 还写着……”或注明“本 PR 已同步更新 Spec”。

2. **低** — `test/tooling/gitleaks-config.test.mjs:31-41` 与 `docs/adr/0177-gitleaks-exact-value-allowlist.md:69`
   - 问题：这次收紧的白名单块没有经过真实 Gitleaks 的正反验证。`FIXTURES` 里没有 `apps/agent-service/test/production-reminder-push.unit.test.ts`，所以 `gitleaks-config.test.mjs` 从未执行到这块；ADR 决定第 4 条却概括说 gitleaks-config 会“核对放行的文件不再报、同一个值出现在别的文件里照报”。
   - 证据：`FIXTURES` 只有 `.agents/reviews/pr-273/…`、`production-http-composition.unit.test.ts`、`gitleaks-allowlist.test.mjs` 等条目，没有该推送测试路径；`ci/rules/gitleaks.toml:38-44` 正是这次修改的块。
   - 建议：在临时仓库 fixture 中放入该文件的 `deviceKey` 和 `https://api.day.app/…` 两种历史形态，并用锁定 Gitleaks 断言不报；再放一份同值到别的文件断言照报。否则历史兼容性只靠人工 VPS 扫描。

3. **低** — 作者说法“ADR 0177 现在写的条件与 gitleaks.toml 里每一块都对得上（新块按第 2 条，PR 248 的两块 match 块按第 3 条）”
   - 问题：`ci/rules/gitleaks.toml` 第 6-12 行还有一块 `regexTarget = "line"`（ADR 0157 的目录形状白名单），既不是第 2 条的新块，也不是 PR 248 的两块 match 块。ADR 0177 的“与 ADR 0157 的关系”已覆盖它，但“每一块”这个说法漏掉了它。
   - 证据：`ci/rules/gitleaks.toml:6-12` 的 `paths` 是整个 `test/qualification/evidence/workspace-authorization-lifecycle/` 目录、`regexTarget = "line"`；ADR 0177 第 80 行明确保留 ADR 0157 的形状白名单。
   - 建议：把说法改成“除 ADR 0157 保留的 line 块外，其余新块按第 2 条，PR 248 的两块 match 块按第 3 条”。

## 推测 / 未核实

- **未核实（摘要）**：`ci/toolchain-lock.json:1222` 的 `c72797bf…` 是否等于当前 `ci/rules/gitleaks.toml` 的 SHA-256。工具权限只允许 git 命令，无法计算哈希。格式没问题（`scripts/ci/install-tools.mjs:40` 要求 `/^[a-f0-9]{64}$/`）；消费者 `scripts/ci/install-tools.mjs:339` 做严格相等比较，摘要错会让 `check-security` 报“扫描规则摘要不匹配”。建议由 CI 实跑确认。
- **未核实（实跑）**：作者称“锁定 Gitleaks 8.30.0 扫全量历史，F5u 值 0 命中”“放宽回字符类时测试失败”。前者无法运行验证；后者从测试逻辑看成立（见必答问题 3），但未实际执行。
- **未核实（记录文件）**：`.agents/reviews/pr-273/round-1|4` 在当前检出的工作树里读不到，`git log` 对这些路径返回 `REVIEW_GIT_REFUSED`，无法核对新块 9 的实际内容和值。
- **推测（安全）**：`F5u42Bd3HyW8KxkUqo2gRA` 形似真实 Bark 设备键，原测试同时把它当 `deviceKey` 和 `https://api.day.app/<key>` 使用。如果它是真实凭据而非合成占位值，按 ADR 0177 决定第 5 条应先轮换、而不是继续白名单。这一点无法从代码证明，建议向 Owner 确认。

## 作者说法核对

- “git 历史里 `F5u42Bd3HyW8Kxk` 前缀只出现过 `F5u42Bd3HyW8KxkUqo2gRA` 一个完整值” — **读代码证实（限该路径）**：`git log --all -- apps/agent-service/test/production-reminder-push.unit.test.ts` 只有 `f73b0b76`（新增）和 `9dcdb6e3`（删除）；`git show f73b0b76:…` 与 `git show 9dcdb6e^:…` 中出现的都是这一个值（`deviceKey`、URL、非法 secret 用例）。且旧正则的语言包含新精确值，收紧只可能减少放行。
- “ADR 0177 背景改为 PR 248 加了八块” — **证实**：`git show bd0859a9 -- ci/rules/gitleaks.toml` 确实新增 2 块 `regexTarget = "match"` + 6 块 `regexTarget = "secret"`，其中 5 块精确、1 块字符类（即本次收紧的那块）。不过 ADR 是 6+2 分组说明，不是逐条列举。
- “第 2 条写明约束此后新加的每一块；原第 3、4 条顺延为第 5、4 条” — **证实**：ADR 决定现为 1-5，新的第 3 条是保留两块 match 块，原“只放行已核实不是密钥的值”变为第 5 条，“改动都要有测试”仍是第 4 条。
- “Spec 第 240 行改为 `classifiedLiteral` 的任何一种写法，并指向 ADR 0177 第 3 条” — **证实**：`scripts/ci/check-security.mjs:194-221` 的 `classifiedLiteral` 确有 5 个分类；ADR 第 3 条确实是保留 match 块。
- “PR 248 实际 11-05 合并、11-04 批准” — **证实**：`git show bd0859a9` 的提交日期是 2026-11-05 14:24 +0900，提交说明写“Andy 2026-11-04 批准”。
- “ci/toolchain-lock.json 摘要同步” — 格式对、旧摘要未残留，但**值本身未核实**。

## 侧重检查

- **错误路径 / 不合规范输入**：本次只改静态配置、测试和文档，没有新增输入解析代码；gitleaks 正则是锚定值，不接受用户输入构造。
- **不可信输入**：被扫描的是仓库历史内容；改动没有新增按目录/按规则放行，只把一块从“固定前缀+7 任意字符”收窄为精确值，放行面变小。
- **安全**：新正则匹配集 ⊆ 旧正则匹配集；路径仍限定单文件；未发现新的绕过。唯一待确认是 `F5u…` 是否为真实凭据（见“推测”）。
- **资源耗尽**：新增/修改的正则均无嵌套量词或放大回溯的写法（`^…$`、单字符类），不引入 ReDoS 风险。
- **不可逆操作**：没有改写、删除或重排历史；ADR 第 89 行也明确拒绝改写已推送历史。
- **规则/文档/代码一致**：逐块核对了 `gitleaks.toml` 与 ADR 0177/0157、Spec 第 240 行、`classifiedLiteral`、决定编号、链接目标和 `amends/amended_by`；除上面列出的低级别表述和覆盖缺口外，其余一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动文件只有 `ci/rules/gitleaks.toml`、`ci/toolchain-lock.json`、`test/tooling/*`、ADR 和 Spec；没有触碰系统提示、工具定义、历史消息、遮盖或任何请求序列化代码。发给模型的内容仍是“只追加、每轮会变的值只在最后一条消息”，这次改动不在这条路径上。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增/修改的是静态字符串：一个精确正则、一个 sha256、文档文字。没有按请求计算的值、时间字段、遮盖前后文依赖或无序集合；本改动不参与模型请求的序列化。

3. **有没有对应的自动检查，反向用例会真的失败吗？**
   - 有。`test/tooling/gitleaks-allowlist.test.mjs:83-108` 现在对包括 `F5u…` 在内的所有 secret 块跑“改一个同类字符”的反向用例。`sameKindLast`（第 86-90 行）把末尾 `A` 改成 `B`；若把正则放宽回 `[A-Za-z0-9_-]{7}`，`…RB` 仍会匹配，断言 `toBe(false)` 就会失败。逻辑上确实会失败，但我未实跑。
   - `test/tooling/gitleaks-config.test.mjs` 用真实 Gitleaks 做整体正反例，但不覆盖被删除的推送测试路径（见发现 2）。
   - `ci/toolchain-lock.json` 的摘要由 `scripts/ci/install-tools.mjs:332-345` 的 `verifyRuleFiles`（`check-security` 调用）自动强制，属于自动检查。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `F5u42Bd3HyW8KxkUqo2gRA`：产生于 `ci/rules/gitleaks.toml:44`；使用者是 Gitleaks（接受合法正则）、`gitleaks-allowlist.test.mjs`（sample 与 `sameKindLast`）和 ADR 文字。两端一致。
   - `c72797bf…`：产生于 `ci/toolchain-lock.json:1222`；`digest()` 的 `/^[a-f0-9]{64}$/` 接受其格式，`verifyRuleFiles` 要求严格相等。格式两端一致，摘要值本身未核实。
   - “ADR 0177 决定第 3 条”引用：ADR 第 3 条正是保留两块 match 块，引用正确。
   - ADR front matter 的 `amends` 与 ADR 0157 的 `amended_by` 双向一致；文档链接目标都存在。
   - 唯一不吻合的是作者“每一块都对得上”漏掉了 ADR 0157 的 line 块（`ci/rules/gitleaks.toml:6-12`），但该块由 ADR 0157 明确保留，不是代码错误，只是表述需要补全。
