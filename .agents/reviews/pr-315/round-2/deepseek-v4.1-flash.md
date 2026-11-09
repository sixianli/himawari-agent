## 结论（按严重度）

### 高

**1. lookbehind 被加到整个关键词表上，中文/日文/韩文关键词前面紧挨 ASCII 字母时也认不出，属于回归**
- 文件：`packages/sensitive-capture/src/redaction.ts:79`（配合 `:81-89`）
- 问题：`PASSWORD_LOOSE_KEYWORDS = (?<![A-Za-z0-9_])(?:${PASSWORD_KEYWORDS})` 的 lookbehind 在**整个 alternation 外面**，不只作用于英文关键词。于是 `wifi密码 abc12345`、`Wi-Fi密码 abc12345`、`路由器password ...` 这类中文/日文/韩文关键词前紧挨 ASCII 字母的写法，两条新规则全部失效；第 1 轮代码没有这个 lookbehind，本来能遮。
- 证据：
  - `redaction.ts:79`：`(?<![A-Za-z0-9_])(?:${PASSWORD_KEYWORDS})`
  - `redaction.ts:68-69`：关键词表里同时有 `密码`、`口令`、`パスワード`、`비밀번호` 和 `password|passwd|pwd`
  - `redaction.ts:86-89`：bare 规则直接使用 `PASSWORD_LOOSE_KEYWORDS`
  - ADR 0188:32 与作者说法 1 都写“**英文**关键词前面不能紧挨字母、数字或下划线”，与实现不一致。
- 影响：本该防止秘密外发的功能漏遮，密码原样发给模型/搜索。这是安全方向的回归，比误遮更值得优先修。
- 建议：把 lookbehind 只套在 ASCII 关键词上，例如 `(?<![A-Za-z0-9_])(?:password|passwd|pwd|PIN\s?码|PIN\s?碼)|(?:密码|密碼|口令|...|パスワード|...|비밀번호|...)`，并补 `wifi密码 abc12345` 这类正例。

### 中

**2. 只剥“句末”标点，值开头的引号/括号被当作值吞掉且不补回，输出被改坏；带引号的日期/网址/路径反而继续被误遮**
- 文件：`packages/sensitive-capture/src/redaction.ts:91、93-94、342-346`
- 问题：`PASSWORD_LOOSE_VALUE` 允许 `' " ( ) : . /` 等，`PASSWORD_TRAILING_PUNCTUATION = /[.:)'"]+$/u` 只剥尾部。raw 的前导标点留在 `value` 里，`maskPassword` 用 `lead + 占位符` 把它整个丢掉，只有尾部通过 `raw.slice(value.length)` 补回。
- 证据：
  - `redaction.ts:78`：值字符类包含 `' " ( ) : . /`
  - `redaction.ts:91`：只匹配结尾
  - `redaction.ts:343-346`：`value = raw.replace(..., "")`；`return \`${maskPassword(lead, value)}${raw.slice(value.length)}\``
- 实例（读代码可确定）：
  - `password is "hunter22abc"` → `password is [密码]"`（左引号丢失，右引号保留）
  - `password is (2026-11-08)` → 因左括号使 `NOT_A_PASSWORD_VALUE` 的 `^` 锚点失配，日期被当密码遮，输出 `password is [密码])`
  - `password is "https://example.com"`、`password is "/home/user1"` 同样绕过了 ADR 0188:37 的网址/路径排除
- 建议：前后标点对称处理——把值前后的引号/括号/句读剥掉并原样补回（或把前导标点并入 `lead`），再用剥离后的值跑 `NOT_A_PASSWORD_VALUE`；补引号包裹的日期/网址/路径反向用例。

**3. 值只认 ASCII，混合值只遮 ASCII 前缀，非 ASCII 后缀原样外发；文档写“认不出”与代码不符**
- 文件：`packages/sensitive-capture/src/redaction.ts:78、342-346`；ADR 0188:46
- 问题：第 1 轮的 `PASSWORD_VALUE = [^\s,，;；]` 能整段吞下非 ASCII；本轮改成 `[^\s,;\[\]\u0080-\u{10FFFF}]` 后，值在第一个非 ASCII 字符处截断，只遮 ASCII 前缀，紧邻的非 ASCII 后缀留在明文。
- 证据：`redaction.ts:78` 排除 `\u0080-\u{10FFFF}`；`redaction.ts:342-346` 只对截断出的 `value` 做替换。ADR 0188:46 写“含中文的值认不出，留作已知缺口”，实际是“部分遮、部分外发”。
- 实例：`密码设为 abc12345中文` → `密码设为 [密码]中文`，若真实口令是 `abc12345中文`，`中文` 被发给模型。
- 建议：要么把紧邻的非 ASCII 连续段一并遮掉，要么明确写进 ADR“混合值会残留非 ASCII 后缀”；至少不要让文档误称“认不出”。

### 低

**4. 最小长度在剥标点之前检查，会误遮短于文档下限的值**
- 文件：`packages/sensitive-capture/src/redaction.ts:82、87、343`
- 问题：`{4,}` / `{6,}` 约束的是含尾部标点的 raw；`value.length === 0` 之外不再检查长度。ADR 0188:34-35 说“值至少 4/6 个字符”，且“句末标点不算在值里”。
- 证据：`redaction.ts:343-344` 先 `value = raw.replace(...)`，只判断 `value.length === 0`；正整数约束在 `redaction.ts:82、87` 的 raw 量词上。
- 实例：`password is 123.` → raw `123.` 满足 `{4,}`，剥掉 `.` 后遮了 3 位；`password is 1...` 甚至遮 1 位；`密码 12345.` 遮了 5 位。
- 建议：剥完标点后再校验长度（`value.length >= 4` / `>= 6`），并补边界用例。

**5. `pwd 2>/dev/null` 这类终端命令会被当密码遮**
- 文件：`packages/sensitive-capture/src/redaction.ts:69、86-89、93-94`
- 问题：`pwd` 在关键词表里；`2>/dev/null` 是 ASCII、含数字、又不以 `/` 开头，会通过 `NOT_A_PASSWORD_VALUE`，被 bare 规则整段遮。第 1 轮意见只修了“`pwd` 换行后的路径”，同类的“`pwd 2>...`”仍会误遮，可能落在工具结果里。
- 证据：`redaction.ts:69` 含 `pwd`；`:78` 值类允许 `>`；`:93-94` 只排除以 `/` 开头的路径。
- 说明：这是按正则语义推出的结果，未实际运行。
- 建议：把 `pwd` 后跟重定向/数字文件描述符（如 `2>`, `2>&1`, `>/dev/null`）的情况排除，或不要用 `pwd` 这种高频命令词做裸值关键词。

**6. 新增的反向/稳定性用例有几条其实测不到本轮改动**
- 文件：`packages/sensitive-capture/test/redaction.unit.test.ts:320-326、92、102`
- 问题与证据：
  - `masks a looser password form the same way whatever came before it`（`:320-326`）分别对每一行单独调 `redactForEgress`，`afterOthers[1]` 就是同一行的红acted 结果，恒等于 `alone`；任何“只依赖单行”的实现都会通过，测不出“追加后旧字节不变”。应改成对 `lines.join("\n")` 或共享 `known` 的多轮序列取同一片段比较。
  - `"password was updated on 2026/11/08"`（`:102`）在旧代码下也不会被遮（`was` 后的 `updated` 无数字，lookahead 已失败），不能作为日期分支的反向用例。
  - `"密码 a1b2c 太短"`（`:92`）在 round 1 的 bare 规则已经是 `{6,}`，不能反向验证本轮的 `{4,}` 改动。
  - 缺少 `wifi密码 abc12345` 正例、引号/括号包裹的日期/网址/路径反向用例、`pwd 2>/dev/null` 反向用例。
- 建议：按上述补齐，尤其为 lookbehind 和“前导标点”各加一条会真正失败的用例。

## 对作者说法的核对
- “英文关键词前面不能紧挨字母、数字、下划线（lookbehind……中文关键词前面可以是汉字）”：**与代码不一致**，lookbehind 作用于全部关键词（见第 1 条）。
- “句末的 `. : ) ' "` 不算在值里，剥掉后再遮、再原样补回”：**只对句末成立**，句首同样的字符会被吞掉（见第 2 条）。
- “带词规则的值至少 4 个字符，没有分隔符的至少 6 个”：量词作用在剥标点前的 raw 上，实际可遮更短的值（见第 4 条）。
- “含中文的值认不出”：实际会部分遮、部分外发（见第 3 条）。
- “NOT_A_PASSWORD_VALUE 扩到 ISO 带时间、美式日期、网址、以 `/` 开头的路径”：代码确实加了（`:93-94`），但带前导引号时会失效（见第 2 条）。

## 侧重检查
- **不可信/不合规输入**：新正则都是单字符类加线性量词，`(?=CHAR*\d)`、`[T.\d:+\-Z]*`、`\S*` 均无嵌套量词，没看到 ReDoS 或异常抛出路径；`u` 标志下 `\u0080-\u{10FFFF}` 合法。
- **占位符保护**：`PASSWORD_LOOSE_VALUE` 同时排除 `[` 和 `]`，所以去掉 `(?!\[)` 后宽松规则仍无法进入 `[密码#...]`、`[密钥]`；严格规则自身的 `(?!\[)` 未改，顺序安全。生产 `tag` 是 8 个小写字母（`model-egress.ts:112-125`），不会在占位符内制造新的关键词匹配。
- **错误路径**：`redactedOrRefused` 仍把 `EgressRedactionError` 转成拒绝发送（`model-egress.ts:501-511`）；新逻辑没有新增 throw；非 ASCII 填充符不会被宽松值类吞掉，trusted 恢复路径不受影响。
- **资源耗尽/不可撤销操作**：无循环写、无删除/提交类操作；正则线性。
- **文档一致**：ADR 0188 与 0166 的括注方向正确，但 0188 关于 lookbehind 作用范围、“含中文的值认不出”、最小长度的表述与代码有上述偏差。
- **未核实**：没有实际执行测试或 `npm run check:prompt-prefix`；`.agents/reviews/pr-315/round-1/judgments.md` 被记录路径策略拒绝读取，round 1 结论以题目摘要为准。

## 必答问题
1. **会不会改变模型已见过的请求开头？** 请求组装本身仍是“只在末尾追加”，会变的运行环境/记忆/时间仍由最后一条消息承载，本次改动没有向系统提示或工具定义加入每轮变化的值；工具定义在 `model-egress.ts:394、470-475` 不经过遮盖。但遮盖规则本身变宽：已发历史里若有文字命中新规则，重发时会被遮成不同字节，该对话开头会变一次——ADR 0188:54 已写明这一代价。就本次实现而言，遮盖结果只取决于当前这段文字和它前面已点名的值，不依赖后文。
2. **同一段文字会不会在不同请求里变成不同字节？** 给定相同的 `known`/`trusted`/密钥，不会：没有时间、随机数、无序集合参与；`tag` 是 kind+value 的确定性签名；`known` 只向前累积，后追加的消息不会回头改旧消息。唯一会变的是轮换遮盖密钥或更换 trusted 清单，属于既有机制。
3. **有没有自动检查，反向用例真会失败吗？** 有新增正/负例和 `check:prompt-prefix` 这道门；第 1 条列出的多数负例在回退到 round 1 时确实会失败（`1Password`、`notpassword`、`pwd\n/...`、网址、ISO/美式日期、`密码设为8位以上`、`密码 我已经用了3年`、`password is a1`）。但第 6 条列出的几条测不到对应改动，且新增的“前缀稳定”用例是同义反复；`wifi密码`、引号场景没有用例，所以当前测试**不会**拦住第 1、2 条问题。
4. **每个产生/修改的值，使用方都能接受吗？** 本次没有新增 ID、配置键或清单项，输出仍是 `[密码]` / `[密码#tag]`；内部常量只在本文件使用。我核对了使用方：`model-egress`（tag/known/table、fingerprint）、`locateMaskedValues`、`restoration.placeholderTable`、`proactive-mail-check-service.sentBodyValues`、`identifiers.containsCredential`。值改成“剥掉尾标点后的字符串”后，这些使用方都能接受：`known` 后续匹配仍能命中带尾标点的再次出现，`table` 恢复靠占位符 + 外部补回的尾标点也成立。**但**前导标点被 `value` 吞掉、又不进 `table`，恢复/展示会丢字符（第 2 条）；这是本次两端校验里唯一发现的实质不一致。
