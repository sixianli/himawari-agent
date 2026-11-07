## 侧重检查（错误路径、不可信输入、安全、资源耗尽、不可撤销操作、规则/文档/代码一致性）

- **错误路径**：`redactForEgress` 在“空跑后恢复对不上”时抛 `EgressRedactionError`；`model-egress.ts` 的 `redactedOrRefused` 捕获后调用 `refuse("trusted text could not be restored")`，请求不发送。路径闭合，**读代码证实**。
- **不合规范/不可信输入**：输入中出现全部 34 个候选填充字符时，代码令 `filler === undefined`，退回 `redactUntrusted` 整段检查（`redaction.ts` 的 `const spans = filler === undefined ? [] : trustedSpans(...)`）。这不会造成漏遮，但会让同一段固定文字在这一次请求里重新被检查/可能被遮。**读代码证实**；对缓存的影响属于**推测**。
- **安全**：外来内容原样抄一段固定文字，该段内的数字不再检查；固定文字里出现主人点名过的值也不遮。两点都在代码里成立，且案例 85 已写明是 Andy 接受的风险。**读代码证实**。
- **资源耗尽**：`trustedSpans` 对每个清单项在整段输入上反复 `indexOf`，复杂度约为 O(清单项数 × 输入长度)，且正式遮盖前还要再跑一遍完整规则（空跑）。案例只引用了 PR #268 第一个修复提交的 7.4/7.8 毫秒，并写明“加上空跑之后的总开销：未测量”。**潜在成本已证实，实际影响未测量**。
- **不可撤销操作**：本次 diff 只有文档和复核记录，没有代码、配置或数据变更，不涉及不可撤销操作。**读代码/看 diff 证实**。
- **规则、文档、代码一致性**：规则文件第 11 条与 `redaction.ts` 的两种退回、34 个填充字符、固定文字里点名值不遮基本一致；案例 85 有一处措辞与代码不符（见下 D2），门槛反向验证的数字取自中间提交（见下 D1）。

---

## 读代码证实的发现

### 1. 中 — 门槛反向验证的数字来自中间提交，不是最终合并代码
- 文件:行：`docs/engineering-casebook.md:5394`；`docs/engineering-casebook.md:5393`
- 问题：案例把“10 个用例失败”“恢复后 18 个通过”当作当前门槛的反向证据，但这两个数字来自 `5870f36`（PR #268 的第一个修复提交）。此后代码又被 `c07e26c9`（加空跑/退回）、`ca00b409`（改填充字符选择）、`8a4aa446`、`b51a995b` 修改，最终 `redaction.ts` 与 `trusted-prompt-egress.unit.test.ts` 都已不是 `5870f36` 的版本；最终合并状态上没有对应的反向测试记录。
- 证据：
  - `5870f36` 提交说明原文：“把 ModelEgress 的默认清单改成空的再跑：10 个用例失败……；恢复后 18 个通过。”
  - `247058e8` 提交说明也写明本轮是“反向验证改为引用提交原话”。
  - 最终 `packages/sensitive-capture/src/redaction.ts` 已包含 `const rehearsal = redactUntrusted(...)` 和 `if (restoredText(rehearsal, input, spans, filler) === undefined) return redactUntrusted(input, options);`，这些是 `5870f36` 之后加的。
- 建议：在案例里注明“数字来自第一版修复提交；合并前最终版本未复测”，或补跑最终代码并记录新的失败/通过数。不要把中间提交的测试结果写成当前门槛的现状。

### 2. 中 — “任何规则都匹配不上的填充字符”与代码和第 3 条自相矛盾
- 文件:行：`docs/engineering-casebook.md:5351`、`docs/engineering-casebook.md:5354`
- 问题：第 2 条说填充字符“任何规则都匹配不上”，但第 3 条又说“只要有规则会碰到填充字符……这一段就退回修复前的方式整段检查”。代码实际依赖后者：`PASSWORD_ASSIGNMENT` 的 `([^\s,，;；]+)` 可以匹配填充字符，所以要先空跑、冲突就退回，而不是填充字符天然不被任何规则匹配。
- 证据：
  - `packages/sensitive-capture/src/redaction.ts`：`const PASSWORD_ASSIGNMENT = /((?:密码|...)\s*(?:[:：=＝]|是|为|為|は)\s*)(?!\[)([^\s,，;；]+)/giu;`
  - 同文件 `redactForEgress`：`const rehearsal = redactUntrusted(view, {...}).text; if (restoredText(rehearsal, input, spans, filler) === undefined) return redactUntrusted(input, options);`
- 建议：改成“先换成填充字符，空跑发现有规则会碰到它就退回整段检查”，避免读者以为填充字符对所有规则都免疫。

### 3. 中 — 同一段固定文字可能因同一条消息里的其他内容而在不同请求中遮法不同
- 文件:行：`docs/engineering-casebook.md:5396`（“共用的开头变了一次”）；`packages/sensitive-capture/src/redaction.ts` 的 `redactForEgress`（具体行号未核实）
- 问题：案例的“结果数据/缓存”只写了“变了一次”，但代码有两个退回条件：①输入或已记下的点名值里出现全部 34 个候选填充字符；②空跑发现有规则碰到填充字符。触发其一时，同一段固定文字会被当作外来内容检查，里面的“1000”可能重新被遮，请求该位置字节与未触发时不同。外来内容可以故意包含 34 个非字符来触发条件①，造成一次前缀变化/缓存未命中；这不是泄密，但属于可被外部输入影响的缓存稳定性问题。
- 证据：
  - `redaction.ts`：`const filler = TRUSTED_FILLERS.find((candidate) => !input.includes(candidate) && !known.some((value) => value.includes(candidate)));`
  - `redaction.ts`：`const spans = filler === undefined ? [] : trustedSpans(input, trusted); if (filler === undefined || spans.length === 0) return redactUntrusted(input, options);`
  - 案例 85 第 5355 行只写了“34 个全被占用时，这一段退回整段检查”，但“结果数据/缓存”没有说明这会让固定前缀随外部数据变化。
- 建议：在“取舍”或“结果数据”里明确写出这一点：退回条件下固定文字仍可能被遮，外部输入可主动触发；若要守住缓存稳定性，可考虑对退回条件单独加测试或改成不依赖整段输入的填充选择。

### 4. 低 — “34 个全被占用”措辞不精确
- 文件:行：`docs/engineering-casebook.md:5355`
- 问题：代码判断的是“任意一个候选字符出现在整段输入或 known 值里”，不是“34 个位置都被固定文字占用”。规则文件第 11 条写的是“输入和前面记下的点名值里合起来已经出现全部 34 个候选填充字符”，更准确。
- 证据：`redaction.ts` 的 `!input.includes(candidate) && !known.some((value) => value.includes(candidate))`。
- 建议：把“全被占用”改成“输入和已记下的值里已经出现全部 34 个候选字符”。

### 5. 低 — 文档里“四个后台调用”“Andy 一开始就否了”等历史说法无法从代码核对
- 文件:行：`docs/engineering-casebook.md:5364`、`docs/engineering-casebook.md:5361`
- 问题：这些是讨论过程记录，代码里没有对应证据；我只能确认最终代码选择了“固定文字清单 + 原地填充 + 空跑退回”，不能确认“四个后台调用”具体数量或当时的讨论原话。
- 建议：在案例中标注这些是线程讨论记录（已有 `.agents/reviews/topic-trusted-prompt-egress/` 作为出处即可），或改成可核对的表述。

---

## 对作者说法的核对

1. **“案例内容和 PR #268、I-78、规则第 11 条一致”**：大体一致。`docs/incidents-and-gates.md:116` 的 I-78 行、`.claude/rules/prompt-prefix.md:53` 第 11 条与案例的方案、退回条件、24 字符下限、34 个填充字符均能对上；但存在上面的 D2 措辞矛盾，以及 D1 的时间点问题。
2. **数字出处**：
   - 7.4/7.8 毫秒、“10 个用例失败”“恢复后 18 个通过”：**已核对**，确实在 `5870f36` 提交说明里。
   - 0.3471 美元、0.5596 美元：**未核实**。`.agents/reviews/topic-trusted-prompt-egress/usage.jsonl` 和 `.agents/reviews/pr-268/usage.jsonl` 在当前稀疏检出中不存在，且 `git show` 对 `.agents/reviews` 路径返回 `REVIEW_GIT_REFUSED records-path`，无法读内容。两个目录在 `27e1d33` 的提交统计中存在，路径本身不假。
   - 生产验收：**未核实**。仓库里确实没有截图；案例已如实写明“截图没有存进仓库”，但“4 条记录、各遮 1 次”和“验收通过”只能以 Andy 的原话为准。
3. **“两条业界引文本次都打开原文核对过”**：**未核实**（不能上网）。另外 Presidio 链接用的是 `https://presidio.dataprivacystack.org/tutorial/13_allow_list/`，不是 Microsoft 官方 Presidio 域名；案例 81 也用了同一镜像域名，无法据此断定错误，但建议面试前用官方 `microsoft.github.io/presidio` 再核一次。
4. **“案例已加入目录（第 85 项）和岗位能力对照表”**：**已核对**。目录第 112 行、岗位能力表第 136 行、案例 81 后续第 5188 行都指向 `#case-trusted-prompt-text`，锚点定义在第 5334 行。

**第 2 轮增量逐条核对**：
- 反向验证改为引用 `5870f36` 原话：**是原话，但见 D1，属于中间提交。**
- “对比与取舍”改写：与代码思路一致；Google 词典/Presidio 允许清单排除值、`ExcludeByHotword` 按词排除、我们排除固定文字——这些概括与 `redaction.ts` 的 `trusted` 实现相符。
- 填充字符避开点名值、34 个全占用退回：**代码证实**（`known.some(...)` 与 `filler === undefined`）。
- 固定文字里的点名值不遮：**代码证实**（trusted span 先换填充再恢复原文，known 替换不会碰它），退回情况除外。
- 生产验收出处写明：**文档文字已改**，源头本身仍**未核实**。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
本次 diff（`ba9ffaed..247058e8`）只改 `docs/engineering-casebook.md` 和 `.agents/reviews/pr-276` 复核记录，没有改系统提示、工具定义、历史、遮盖代码或配置，因此**不会**改变发给模型的内容。案例描述的实际修复（`27e1d33`，已在基准 `5cedac65` 之前合并）会把后台整理记忆请求开头的 `[验证码#…]` 变回 `1000`，这是一次性的前缀变化，案例和 `5870f36` 提交说明都写明了。该变化不是“每轮变的值塞进最后一条消息”的问题，而是遮盖规则变化导致固定文字字节变化；规则第 11 条把“清单是遮盖的另一个输入”列为已知例外。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
本次文档 diff：**不会**。案例描述的代码：对**未变化的消息和未变化的清单**，遮法是确定的；但两个退回条件会让同一段固定文字在不同请求里被遮或不被遮——①输入/known 值包含全部 34 个候选非字符；②空跑发现规则碰到填充字符。也就是说，同一条固定指令的字节可能依赖这条消息的其他内容（尤其外来数据）而不同。案例已承认退回，但“结果数据/缓存”没有充分展开；这是我建议补写的点。除此之外，清单按长度降序排序（`trustedPromptTexts` 的 `sort`），没有无序集合或时间字段问题。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有自动检查：`package.json:52` 的 `check:prompt-catalog` 跑 `apps/agent-service/test/trusted-prompt-egress.unit.test.ts`、`packages/sensitive-capture/test/trusted-text.unit.test.ts`、`apps/control-center/test/sensitive-interceptions.unit.test.ts`，且 `package.json:27` 的 `check` 包含 `check:prompt-catalog`。
- 自动反向用例存在：`trusted-prompt-egress.unit.test.ts` 的 `[I-78] REVERSE: without the trusted list the same request masks 1000 as a code and records it` 用 `trusted: []`，会遮 `1000`；`trusted-text.unit.test.ts:20` 的 `[I-78] never changes the trusted text...` 和同文件的无清单用例也覆盖了正反。
- 但“把默认清单换成空的后 10 个失败/18 个通过”是 `5870f36` 上的人工实验，不是当前 CI 里自动执行的反向用例；最终代码没有这个数字的复测记录。建议补一个“默认清单为空时对每个目录条目断言会失败”的自动用例，或明确标注该数字的历史版本。

**4. 改动产生或修改的每个值，使用它的地方都能接受吗？**
- 新锚点 `case-trusted-prompt-text`：定义在 5334，目录 112、能力表 136、案例 81 后续 5188 都引用它，一致。
- 新目录项 85 与案例标题：目录和正文编号一致。
- I-78 引用：`docs/incidents-and-gates.md:116` 存在，`#incidents` 锚点在 32 行。
- 规则第 11 条：`.claude/rules/prompt-prefix.md:53` 存在，内容与代码的 24 字符下限、34 个填充字符、两种退回条件一致。
- 测试名 `[I-78] never changes the trusted text, even when it holds a value named elsewhere`：`packages/sensitive-capture/test/trusted-text.unit.test.ts:20` 存在。
- `.agents/reviews/topic-trusted-prompt-egress/`、`.agents/reviews/pr-268/`：在 `27e1d33` 的提交统计中存在；但 `usage.jsonl` 的金额**未核实**。
- 生产验收的 4 条记录、各 1 次：**未核实**（截图不在仓库）。
- 行业引文：**未核实**（不能上网）；Presidio 域名建议再核。
- 代码侧新值：`TRUSTED_PROMPT_TEXTS` 由 `trustedPromptTexts` 产生、`ModelEgress` 在 `model-egress.ts:198` 消费；`TRUSTED_FILLERS` 由 `redactForEgress` 消费；`trusted` 选项两端都按“字符串数组”处理，长度下限一边是 `entry.ts` 的 24、一边是 `redaction.ts` 的 24，**两端一致**。这些值的类型和校验能对上。

**总结**：本次文档增量本身没有改变任何发给模型的内容；主要风险是案例把中间提交的反向测试数字当成最终门槛证据（D1），以及“填充字符任何规则都匹配不上”与代码/第 3 条矛盾（D2）。此外，退回条件会让固定前缀受外部输入影响，值得在案例里写清楚（D3）。生产验收、花费和两条外部引文均**未核实**。
