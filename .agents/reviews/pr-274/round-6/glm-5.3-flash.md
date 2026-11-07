read 工具里那些复盘记录文件不存在于工作树，`git show <ref>:records` 又被仓库钩子拒绝（REVIEW_GIT_REFUSED），我标注为「未能读取」，不追查。继续核对代码与文档。
# PR #274 第 6 轮复核（GLM）

先说结论总览：两条改法都与第 4 轮意见一致、实现正确，我按作者点名的边界情形逐一核对，未发现新的“会出错”问题。下面先写侧重检查，再列发现（按严重度），最后逐条回答必答问题。

## 侧重检查

走的普通流程（一个截断私钥进入出口文本的链路）：

主人/模型文本 → `apps/agent-service` 组装请求 → `model-egress.ts:184` `#redactorFor` 选遍历器（chat/completions、responses、messages、embeddings 四种）→ 遍历消息树（`model-egress.ts:304-408`，跳过 SKIPPED_KEYS 标识字段与 OPAQUE_TYPES 的 thinking/图片）→ 每段正文 `text()`（`model-egress.ts:212`）→ `redactedOrRefused` → `redactForEgress`（`redaction.ts:211`）→ `redactPrivateKeyFragments`（`redaction.ts:300`）→ `maskKeyTails`（`machine-secrets.ts:98`）→ 发送前 `assertMachineSecretFree` 兜底（`model-egress.ts:224`）。

覆盖结论：
- 有覆盖：`maskKeyTails` 本体的单标记形状与速度用例（`private-key-fragments.unit.test.ts` 全文件，其中 69-75、77-82 是本次新增）；`redactForEgress` 组合与多数用例；`check:prompt-prefix` 用真实出口遮盖做逐字节前缀比较（`.claude/rules/prompt-prefix.md:74`）；新测试文件落在 `ci/policy.json:195-196` 的 unit 项目（`packages/**/*.unit.test.ts`），会随常规测试跑。
- 没有覆盖（薄弱点）：没有任何一个用例同时出现多个标记且**后面的标记也要被遮**（`floor` 被前移后又发生新遮盖的分支）；JSON 转义与多标记的组合也没有。作者问的「floor 与 cursor 关系」「相邻标记」「同行连续标记」这些分支目前只有推理验证（见下），没有自动用例钉住。
- 未能读取：`.agents/reviews/pr-274/round-4/judgments.md` 等复盘记录，工作树中没有这些文件（glob 无结果），`git show <ref>:<路径>` 被仓库钩子拒绝（`REVIEW_GIT_REFUSED records-path`），所以「不改的一条（文档第 5 个 PR 改）」的依据**未核实**；我读到的 README（`packages/sensitive-capture/README.md:19` 同一段文字每次遮出字节必须相同）、ADR 0167、ADR 0054、SRT 设计文档均未发现与改动相矛盾的描述。

## 发现（按严重度）

**1. 低（历史重遮盖字节变一次，流程凭证未核实）**
- 文件：`packages/sensitive-capture/src/machine-secrets.ts:104`（旧实现在 f2d91d6b 的同一函数）；`.claude/rules/prompt-prefix.md:84`
- 问题：遮盖规则变了。旧实现先试“窗口内下一行行首”的切片、命中即用（遮得少），新实现从窗口起点找最左匹配（遮得多）。**读代码证实**：对已被发送过、且含「长行＋其后正文行＋END 标记」形状的历史消息，按规则 5（`prompt-prefix.md:36`）历史存遮盖前内容、每次发送重新遮盖，重新发出时这些消息的字节会与上次不同——从那条消息起缓存整段重算，且模型会收到一次比上次遮得更多的旧内容。这是任何遮盖规则修正的必然副作用（规则 53 行也承认同类“字节变一次”模式），不违反只追加，但规则 84 行要求“会，就停下来出方案，Andy 同意才动工”——是否拍板**未核实**（记录读取被钩子拒绝）。
- 建议：在 PR 说明或提交信息里记下这次线上一致性代价（受影响对话一次性缓存失效），并确认规则 84 的拍板留了记录。

**2. 低（多标记交互路径无自动用例）**
- 文件：`packages/sensitive-capture/src/machine-secrets.ts:104-106`、`test/private-key-fragments.unit.test.ts:77-82`
- 问题：**读代码证实**：新性能用例（40000 个不被遮的标记）只走到 `tail === null → continue` 分支；`floor` 前移后下一个标记仍被遮的分支（floor=cursor、随后再遮）没有任何用例。恰恰是作者点名要我核对的分支。
- 建议：补一例「完整块先遮（cursor 前移）＋截断尾巴再遮」和多标记混合 JSON 转义用例。

**3. 信息（反向用例的“会失败”靠推理，未实测；墙钟阈值机器敏感）**
- 文件：`test/private-key-fragments.unit.test.ts:69-82`
- **推理证实**：新例 1 在旧实现下必然失败——旧实现先试 `lineStart` 切片（MIIE 行）并命中，长行的窗口内一段整体保留，输出会包含 `"A".repeat(1000)`，被第 74 行断言拒绝。**推测（未能运行，本环境禁）**：旧实现下例 2 应超 2 秒（每标记重扫至多 19200 字符 × 40000 个 ≈ 数亿次字符操作）。另：四个速度用例都按墙钟 `< 2000` 判定，在慢机器上有偶红风险——这是本文件既有风格（84-95、97-108 行改动前就有），非新引入。

## 作者点名核查项的核对结果（读代码证实，无阻断）

- **floor 与 cursor**：不变量成立。`matchAll` 的匹配互不重叠（先于 `matchAll` 的替换已把完整块换掉），所以第 106 行 `marker.index < cursor` 是防御性死代码；每个标记的 `floor` = 该标记末尾 ≥ `cursor`（被遮标记时二者相等，被跳过标记的末尾在 cursor 之后），因此 `from ≥ cursor`、`start ≥ cursor`，`input.slice(cursor, start)` 不会倒置，不会出现双份 `REDACTED`。
- **标记落在已遮区域内**：因上一条，下一标记必然起于上一匹配末尾或之后，情形实际到不了；`floor` 在 106 行 `continue` 之前前移（105 行），与作者“无论遮没遮都前移”的说法一致。
- **相邻两个标记 / 同一行紧跟的标记**：第二个标记的切片为空或只剩缝隙文本，`exec` 返回 null → 跳过，与旧行为一致，也不该遮（第 110-117 行测试期望孤立标记不动）。
- **从窗口起点的行中间匹配会不会多遮/漏遮**：多遮正是第 4 轮意见 1 要的行为（`KEY_LINE_START` 的 `^` 分支，`machine-secrets.ts:80`，使切片 0 位即视为行首）；不会破坏 JSON——消耗型组件（正文类 `[A-Za-z0-9+/=]`、前缀、行界）都不含 `"`，匹配不能跨引号。不会漏遮：跨越某个被跳过标记的匹配不存在，因为标记文本 `-----END … PRIVATE KEY-----` 含空格和连字母段，正文/前缀/行界任何组件都消耗不了它；>121 行正文的窗口内漏遮是正则 `KEY_LINES=120` 上限的既有边界（真实 RSA/OPENSSH 私钥正文远少于 121 行），非本次引入。
- **平方级路径**：`floor` 使每标记切片长度 = min(19200, 与上一标记的距离)，各切片区间伸缩相接、总和不超过文本长；`KEY_TAIL` 单切片最坏成本与切片长同阶（多余起点的匹配被 lookbehind O(1) 拒掉），整体仍线性。未发现新的平方路径。

作者对提交历史的说法也核对无误（git log/diff stat）：f2d91d6b 之后 4a2365b5、991c84b2 只加第 4 轮记录，3f8529d8 是唯一代码修改，其后 4 个提交全是 chore(review)。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 结构不变：改动只发生在出口遮盖内部，不碰系统提示、工具定义、消息顺序，也没有新增每轮变化的值（无时间、无计数器）。遮盖属于规则 5 明文的“每次发送重新遮盖”例外；遮盖密钥与占位符确定（私钥用固定串 `[MACHINE唯一的] → [密钥]`，`redaction.ts:65-66,304`）。唯一的字节变化是发现 1：受影响历史消息重遮后与上次发送不同，一次缓存失效——属规则允许的模式，但规则 84 要求的拍板**未核实**。
2. **同一段文字会不会在不同请求里变字节？** 不会。`maskKeyTails` 对同一输入字节确定：非全局正则 `exec` 无状态、`matchAll` 顺序确定、无时间/无序集合；`floor` 只由该消息自身的前文决定，满足规则 11（“只能取决于它自己和它前面的内容”）和 README.md:19 的约定。
3. **有没有对应的自动检查？** 有，两条新用例（`test/private-key-fragments.unit.test.ts:69-82`）已计入 unit 项目（`ci/policy.json:195-196`），随常规测试跑。反向验证：例 1 对旧实现**读代码证实**必败；例 2 对旧实现超时属**推测**（无法在本环境运行）。另注意发现 2：交互分支无用例。
4. **每个产生/使用的值两端都核对过吗？** 是。改动未新增标识、字段、配置键、清单项或序列化格式；退出值仍是原 `REDACTED` 串与 `private-key-block` ruleId。产生端：`machine-secrets.ts:111,123`；使用端：`redaction.ts:297-304`（计数与改写 `[密钥]`）、`machine-secret-exclusion`/`containsToolOutputSecret`（扫描不受影响）、`model-egress.ts:224`（断言）、观察回调 `(value) => observe("private-key-block", value)`（`machine-secrets.ts:123` 对 `redaction.ts:298` 的 `(ruleId, value)` 签名）——两端一致，测试常量 `MASK` 与 `REDACTED` 一致。核对通过，无新校验面。
