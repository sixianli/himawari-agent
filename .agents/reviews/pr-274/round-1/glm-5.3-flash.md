# 复核报告（基准 80eaff4 → 0fc16ed）

以下把「读代码证实的」与「推测」分开标注；凡未标注者均为读代码证实。文件行号以 0fc16ed 为准。

## 按严重度排列的发现

### 高（1 条）
**H1｜`packages/application/src/services/model-egress.ts:415-422, 344-385`｜出口遮盖有不被遮的分支，本 PR 新依赖的托底假设在这些分支上不成立**
- 证据：`maskTree` 对字符串有 `if (value.startsWith("data:")) return value;`（model-egress.ts:416），跳过时既不跑 `redactForEgress` 也不跑 `assertMachineSecretFree`（这两者只在 `text()`，model-egress.ts:211-238 内执行）；`OPAQUE_TYPES`（file/input_file/document/image/image_url/input_audio/item_reference 等，:374-377）同样整块跳过（:422）；`SKIPPED_KEYS`/`OPAQUE_MESSAGE_KEYS`（reasoning 等）也跳过。
- 后果：作者的问题“是否每条路径都经过出口遮盖"的答案是**否**。`/chat/completions` 等四个路径之外的请求会整次拒发（:184，fail-closed，这点符合预期），但进入这四类请求体的 `data:` 前缀字符串和 opaque 块是**原样送出**的。在此 PR 之前，各工具出口的整段拦下和这些分支互相独立、主要看信封整体，没有互相依赖；现在所有拦下去了以后，"托底=出口遮盖”的假设里多出了这些不被遮的洞，而且没有任何自动检查守住它们。
- 「源代码里没有地方生成 file/document 块」这一核对事实：在 `apps/agent-service/src` 范围内 grep 无生成点，**证实**（限定范围）；但 ADR 0093（docs/adr/0093-chat-attachments-images.md:35）记录上游 Pi 库 `@earendil-works/pi-ai` 会把内容转成 `image_url` 块——这一段**未核实**（读不到该依赖的代码）。
- 建议：至少对 `data:` 前缀分支补一个机器密钥断言（或把跳过限制在已确知的 URL 字段），并加一条“发出去的最终 body 逐串自检"式的纵深检查。

### 中（3 条）
**M1｜`packages/sensitive-capture/src/machine-secrets.ts:75-105`｜残缺私钥正则：两类漏遮、一类性能疑虑**
- 漏遮 a：标记行后正文不足 16 字符的残块不遮。`KEY_LINE` 要求 `[A-Za-z0-9+/=]{16,}`（:80），`KEY_LAST_LINE`（≥1 个字符）只出现在"最后一行"位置，且 fragment-3 要求至少一行完整 `KEY_LINE`（:88-91）。而旧的边界检查 `containsToolOutputSecret` 只认 `-----(BEGIN|END) PRIVATE KEY-----`（machine-secrets.ts:56-60），会拦"标记+短正文"；本 PR 把这个检查从所有 UTF-8 分支去掉（如 pi-output-export.ts:41-46 现在 UTF-8 分支根本不调它）。作者说“只有标记、没有正文的不遮”是本意，但“标记+最多 15 字符正文”会**漏遮**并流出约 11 字节钥体开头。
- 漏遮 b：嵌套 JSON 转义的 `\r\n`（字面量 `\r\n` 形如 `\\r\\n`）不被 `KEY_LINE_BREAK`（`(?:\\n|\r?\n)`，:76）认得；截断的 CRLF 私钥以转义形式出现时漏遮。完整键仍由 `[\s\S]*?` 全块规则遮住，只有残缺形态受影响。
- 性能（推测，未实测）：fragment-2/3 每个符合条件的行首都是一个锚点，向右最远要扫到 `-----END PRIVATE KEY-----`（:88-91 无窗口上限），在“大量 base64 形态行 + 一个.End 标记"的大文本上最坏 O(文本²)；这段跑在每一次发给模型的消息上（redaction.ts:300）。建议加窗口行数上限并做基准测试。
- 误遮面：两类残块模式都要求正文全部是 base64 字符集、且紧挨 BEGIN/END 标记或逐行相连，普通文字（非相邻、含空格标点）匹配不了；测试也覆盖了“不遮普通文字”。这一点与作者说法一致。

**M2｜文档与本次代码矛盾（作者声明后续 PR 改，但在当前树上是不一致的事实）**
- docs/architecture-v0.1.md:82 及 docs/execution/specs/2026-09-07-srt-unified-execution-design.md:431 仍写着“输出含机器秘密（包括只剩开头行或结尾行的私钥片段）时只交出说明和真实退出码，不交正文”、“输出文件正文检查机器秘密（含只有开头行或结尾行的片段）”——与现行为（照常交出、由出口遮盖遮值、完整输出遮文字再编码）**相反**，读文档与代码即可证实。
- packages/sensitive-capture/README.md:11 未提及新增的 `redactPrivateKeyFragments`。
- 建议：趁未合并顺手标注或改写，至少在后续 PR 说明里引用这些行，别让下一个人按文档去查代码。

**M3｜`.claude/rules/prompt-prefix.md` 规则文本没有覆盖本次改动所依据的授权**
- 规则 5（prompt-prefix.md:36）把出口遮盖列为唯一例外，并写“同一段内容每次遮出的字节相同”——其中“遮出的字节是否会因**遮盖规则版本升级**而变一次”没有写。本次“残缺私钥”规则会让已发历史里含残缺块的消息字节变一次，依据是作者转述的口头同意（2026-11-07）。仓库里同类先例（I-78 的固定文字清单变化、prompt-prefix.md:53）都落了文档；建议把本次同意也落成 ADR/文字记录，否则这条改动在现有规则框架里是“未授权先例”。

### 中低（3 条）
**L1｜`packages/application/src/services/model-egress.ts:224-235`｜拒发时的 withheld 记录：残留密钥一律记在失败的当前 part 名下**
- `redactMachineSecrets(result.text, …)` 只扫当前 `part` 的文本（:230），归因也固定用当前 `part`（:231）。已经读完的 part 不会残留（自检已过），所以实际影响是轻微误归因，不是漏记；“已遮过且没发出去的这次请求里所有值都改记 withheld”的行为与作者说法一致，测试断言了卡片和密钥两条都 `withheld`（model-egress.unit.test.ts:498-524）。

**L2｜`packages/platform-node/src/files/pi-host-publication.ts:116-137`｜fullOutput 遮后放不下时的回落**
- `fileBudget` 按未遮的文件大小算（:120；上限检查在 pi-output-export.ts:28），遮后如果变长（如多处短值被换成 `[MACHINE_SECRET_REDACTED]`/`[密钥]`，或密码名下边缘短值），`fitOutput` 放不下就静默回落到"完整输出超过上限，未保留”（:129-137），文案与真实原因（遮盖后变大）不符。`byteLength`/`digest`/`redacted` 三者一致描述遮后字节（pi-output-export.ts:56-64）；消费端逐个核对过：pi-write-evidence.ts 只查特定字段、production-sandbox-tool-result.ts:107-110 只透传、production-background-commands.ts:427-448 只取 content，没有会拒绝新字段的校验端。
- 这回答作者“遮后长度变化、fitOutput 放不下”的提问：**不会崩**，代价是模型看不到完整输出、且看到的理由措辞不准。

**L3｜测试覆盖缺口**
- `packages/runtime-pi/test/host-read-only-executor.unit.test.ts:134-144` 改成"原样返回”后没有断言“到模型时被遮"（同 PR 里 agent-service 侧的同类测试都补了 `toolResultSentToModel` 断言，例如 production-host-read.unit.test.ts:127）。
- 后台命令输出（pi-coding-request.ts 的 `streamOutput` 改动）：单测只断言原始字节照常写到 stdout 通道（pi-coding-program.unit.test.ts:436-462），没有“这内容最终进模型时被遮”的直接用例；前台有 E2E [R2-T14]（test/integration/product-path-browser.test.ts:1977、2013、2089）。后台到模型一路的遮盖**未核实**有直接覆盖。

## 通过项（核对过、无问题）
删除整段拦下的 13 处（host-file-read、read-only-executor、pi-host-publication withhold/pi-output 拒收、workspace-copy、sandboxed-coding-operations、production-file-preparation、production-host-read、production-sandbox-services:1956、pi-coding-request streamOutput、exa 两处、deepseek 一处、web-provider-failure 失败类型）逐一对上 diff。`OUTPUT_REDACTED` 在全仓库无残留引用（grep 0 命中）。登记表删 10 个文件、deepseek 2→1、exa 4→2 与源码现存调用数逐一对上（deepseek-web-provider.ts:76、exa-public-search.ts:121,217、pi-output-export.ts:43）；`check-egress-redaction.mjs` 的机械检查对未登记/数目不符会失败，反向有 `test/tooling/egress-redaction-check.test.mjs`。新规则的反向用例存在且改回即败：private-key-fragments.unit.test.ts（新文件）、model-egress.unit.test.ts:527-546（请求里遮残钥）、pi-output-export/sandboxed-coding-operations/workspace-copy 的新用例。`MachineSecretRuleId ⊂ EgressRedactionRuleId` 证实（redaction.ts:34-43）；残缺私钥记 `private-key-block` 证实（machine-secrets.ts:101）。`withheld` 链路两端核对：port 常量原本就有 `withheld`（ports/sensitive-interceptions.ts:35，即 I-73 要求的“两端校验”成立）、sqlite `oneOf(SENSITIVE_INTERCEPTION_OUTCOMES)`（sqlite-sensitive-interception-operations.ts:55）、控制中心筛选与文案已存在（apps/control-center/src/sensitive-interceptions.ts:13-18,75-77,123-127）。导入等编辑流程的写前读（production-file-preparation.ts:46-48、sandboxed-coding-operations.ts:161-164）只留 NUL 检查，与前述原则一致。

## 侧重检查
走的普通流程：主人说“读一下 home 里的 keys.txt" → 能力程序 executeHostFileReadCapability（NUL 检查在，密钥检查已删）或 host-read-only-executor（同上，结果原样返回）→ production-host-read 组装 `pi-result.v1` 信封（无密钥检查）→ 存入历史 → 下一轮请求组装（pi-model-transport.ts:313）→ `Exchange.wrapFetch` → 四路径之一 → 每串 `redactForEgress`（残缺私钥规则先于其他机器密钥规则，redaction.ts:300）→ `assertMachineSecretFree` 自检 → 有残留则整次拒发并记 withheld → 显示侧用 `restore` 把 `[密钥]` 换回原文。
结论：主路径全覆盖、有单测+E2E 双层；**无覆盖**的路径是出口遮盖的 `data:`/opaque 跳过分支（H1）、后台输出进模型遮盖（L3）、以及残缺私钥正则的性能（M1c）。

## 必答问题逐条回答
1. **开头不变吗**：是。工具结果仍是每轮末尾追加的新消息，没有改写系统提示、工具定义或历史中的既有消息文本本身。唯一的例外是出口遮盖规则的固有性质（规则 5 允许的例外）：**残缺私钥**规则上线后，历史里含残缺块的消息在每次发送时被遮，已发历史字节一次性改变——作者已声明 Andy 同意；核对范围：`redactForEgress` 的消费方除模型聊天/embeddings 外还有 gmail 超长正文预览（gmail-body.ts:198）与邮件检查（proactive-mail-check-service.ts:192-217），前者属轻微溢出，后者仍属发往模型文字，未发现更大范围。同意范围**基本没超**，gmail 预览一处除外。
2. **同文不同字节**：残缺私钥规则只依赖文本自身，确定性成立；不再发现本次改动新增的不确定来源。已有的不确定来源（点名值的先后遮盖、遮盖密钥轮换、固定文字清单变化）维持原状且 prompt-prefix 规则已约束。`redacted: true` 只出现在新产生的信封里，历史旧信封不受影响。
3. **自动检查与反向用例**：有。三组：`SENSITIVE_GATE_CALLS` 机械核对（数调用、未登记即失败）+ 其工具测试；残缺私钥的新单测（revert 即败）；三类新遮盖行为在 model-egress / pi-output-export / production-foreground-result / E2E [R2-T14] 的断言（revert 即败）。缺口是 L1/L3 所列的归因与后台路径。
4. **每个值的两端核对**：逐个过完——`withheld`（port 常量、sqlite oneOf、UI 全链路已在）；`redacted: true`（生成端唯一，消费端 4 处均只透传或取特定字段，无一拒绝）；`reason` 更新的 baseline 条目（digest 未变，文案与新行为一致）；登记表删除项（源码 grep 证实对应调用确实只剩 0 或已减数）；`redactPrivateKeyFragments` 两端一致。唯一没做两端核对的是 `data:`/opaque 跳过分支——它们不是本次新增的值，但成了本次依赖，见 H1。
