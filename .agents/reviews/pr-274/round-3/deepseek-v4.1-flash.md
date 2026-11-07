## 结论摘要

作者的四处改动我都对照代码核过了：`lineStartBefore`、`BASE64_DATA_URL` 收紧、登记表计数、测试拼接，都与说法一致；两条反向用例按旧实现推理也确实会失败。但有一条改法是错的：往 `machine-secret-scan-baseline.json` 加条目解决不了 CI 的安全扫描，反而会让 PR 的安全门槛变红。另外 `lineStartBefore` 换来安全的同时丢掉了原来的回看上限，并有过度遮盖的副作用。

下面按严重度排。

---

## 发现

### 1）中高：新增的密钥扫描基线在 CI 里不生效，新复核记录里的 AWS 形状值会挡住安全门槛

**文件:行**
- `scripts/machine-secret-scan-baseline.json:136-142`
- `scripts/ci/check-security.mjs:442-466`
- `scripts/ci/security-owner-review.mjs:222-233`
- `ci/rules/gitleaks.toml:3-4`

**问题**
作者加了这一条基线：

```json
"file": ".agents/reviews/pr-274/round-2/deepseek-v4.1-flash.md",
"ruleId": "aws-access-key",
"digest": "457643f4...",
"count": 1,
"reason": "... the answer is kept verbatim"
```

但 CI 的安全扫描不读当前提交的基线。它把 **baseSha** 的扫描脚本和基线复制到临时快照：

```js
const accepted = git(root, ["show", `${context.baseSha}:${path}`]);
writeFileSync(join(snapshot, path), accepted);
```

然后只从 base 基线里“去掉” owner review 已批准的条目，再扫描：

```js
baseline.filter((item) => !machineExceptions.some(...))
```

所以这条新加的、只存在于 head 的基线条目完全不参与 CI 比对。按 `scripts/scan-machine-secrets.mjs:58-61`，只要观测到的 `aws-access-key` 次数超过 allowlist，就报失败。

而 owner review 的机器密钥豁免又只接受 `credential-assignment`：

```js
entry.id === "credential-assignment" &&
```

因此 `aws-access-key` 连 owner review 这条路也走不了。作者提交说明里的 `npm run check`（39 步）不包含 `scripts/ci/check-security.mjs`，所以本地全过并不代表 CI 安全门槛会过。

另外 `ci/rules/gitleaks.toml` 是：

```toml
[extend]
useDefault = true
```

默认规则含 AWS access token，而现有 allowlist 没有覆盖 `.agents/reviews`。因此 gitleaks 的 current/history 扫描很可能对同一个 `AKIA...` 也报（这一条是**推测**，依据是 gitleaks 默认规则；machine-secrets 那条是**读 CI 代码证实**的机制）。

**触发前提**：仓库里的 `.agents/reviews/...` 是 records path，本次复核工具禁止读取，所以我没能直接看到那句话；但作者正是因为本地扫描命中才加这条基线，且 reason 明说答案里保留了模型原话。按这个前提，CI 会报。

**建议**
- 最稳妥：复核记录里不要写连续的 `AKIA...`，像测试那样拆开（例如 `AKIA` 与 `ABCDEFGHIJKLMNOP` 分开写，或在中间插入不可见/零宽分隔），从根上避免 machine-secrets 和 gitleaks 命中。
- 如果确实要保留样本，需要走 CI 认可的路径：gitleaks allowlist（配 `ci/security-exceptions.json` 的 provenance）和 owner review 的机器密钥豁免；目前 owner review 只支持 `credential-assignment`，要支持 `aws-access-key` 得改 `security-owner-review.mjs` 并重新审批。
- 提交前应跑 `scripts/ci/check-security.mjs`（或等价的 CI security job），不要只跑 `npm run check`。

---

### 2）中低：`lineStartBefore` 把原来的回看上限取消了，超长单行会把整行拉进切片

**文件:行**
`packages/sensitive-capture/src/machine-secrets.ts:98-112`

**问题**
旧实现是：

```js
const earliest = Math.max(cursor, marker.index - KEY_TAIL_WINDOW);
const from = earliest === cursor ? earliest : nextLineStart(input, earliest, marker.index);
```

切片长度最多约 `KEY_TAIL_WINDOW`（19200）加一行。新实现：

```js
const from = lineStartBefore(input, marker.index - KEY_TAIL_WINDOW, cursor);
```

`lineStartBefore` 会把起点回退到“窗口起点所在行”的行首。如果这一行是一整行超长 base64（没有换行），切片就会包含整行：

```js
const tail = KEY_TAIL.exec(input.slice(from, marker.index));
```

不可信工具输出只要满足“一整行很长 + 末尾一个 `-----END PRIVATE KEY-----`”，每次请求都会对整行做一次拷贝和正则扫描，`KEY_TAIL_WINDOW` 的限时/限量设计失效。代码机制已证实；实际是否造成明显资源问题取决于输入大小（**推测**，需要大输入）。

**建议**
保留上限：只有在“窗口起点所在行就是 END 标记前的最后一行”时才回退到该行行首；否则仍用原来的 `nextLineStart`。这样既能修“最后一行超长”的漏遮，又不会把前面任意长的普通行拉进来。补一条多 MB 单行的性能用例。

---

### 3）低：真实图片 data URL 会被 `scanMachineSecrets` 误判并静默改字节

**文件:行**
`packages/application/src/services/model-egress.ts:410-420`
`packages/sensitive-capture/src/machine-secrets.ts:37`

**问题**
新逻辑：

```js
if (BASE64_DATA_URL.test(value) && scanMachineSecrets(value).length === 0) return value;
```

标准 base64 字符集允许出现 `AKIA`/`ASIA` + 16 个 `[A-Z0-9]`，且前面是 `,`/`+`/`/` 时 `\b` 成立。因此真实图片的 base64 如果恰好含有这种序列，会被 `redactMachineSecrets` 静默替换成 `[MACHINE_SECRET_REDACTED]`；请求不会被拒绝，但图片字节被破坏。作者的新测试本身就把 `data:image/png;base64,${AWS_LIKE}` 当作“image”并期望它被遮，说明这是有意取舍；但对真正的图片是误判。

随机标准 base64 命中 AWS 规则的概率极低（约 1e-12 量级/字符），不是常见故障；但问题成立时是“静默改字节”。`credential-assignment` 在合法 data URL 上基本不可能命中（需要 `:` 或中间 `=`），主要风险就是 AWS 形状。

**建议**
如果目标只是“机器密钥不能从 data URL 出去”，可对 data URL 的 payload 做更精确的判定（例如只检查解码后的内容/参数区，或对无法确认是合法图片的字符串才遮）；至少把这类改写写入 report，不要静默改。若决定接受，应在测试和文档里写明“真实图片也可能被改动”的取舍。

---

### 4）低：`lineStartBefore` 会把包含窗口起点的普通长行一并当作密钥遮掉（过度遮盖/数据丢失）

**文件:行**
`packages/sensitive-capture/src/machine-secrets.ts:98-116`

**问题**
回退目标是“包含 `marker.index - KEY_TAIL_WINDOW` 的行”，而不是“END 前最后一行”。当密钥尾很短、但它前面有一段超过 19200 字符的单行时，窗口起点落在那段长行里，新代码会把整段长行拉进 `KEY_TAIL`；由于 `KEY_TAIL` 允许 1–120 行，这段看起来像 base64 的非密钥行会被当成密钥一并遮掉。旧实现会从这段长行之后的行开始遮。

```ts
const from = lineStartBefore(input, marker.index - KEY_TAIL_WINDOW, cursor);
...
const tail = KEY_TAIL.exec(input.slice(from, marker.index));
```

这是“宁可多遮”的方向，不会漏密钥，但会吞掉与密钥无关的大块内容。**读代码证实机制**，实际触发需要“长 base64 行紧挨着 END 前的短尾”。

**建议**
用与发现 2 相同的改法：只在窗口起点所在行就是 END 前最后一行时回退到行首，否则用 `nextLineStart` 前移。补“长普通行 + 短密钥尾”的正反用例。

---

## 读代码证实 / 推测 的区分

- **读代码证实**：CI 安全扫描用 baseSha 的基线（`check-security.mjs:442-466`）；owner review 只允许 `credential-assignment`（`security-owner-review.mjs:225`）；`lineStartBefore` 现在会回退到窗口起点所在行行首且无长度上限（`machine-secrets.ts:98-112`）；`BASE64_DATA_URL` 现在要求 `=` 只在末尾，且扫描无命中才放行（`model-egress.ts:410-420`）；两条新测试在旧实现下会失败（`nextLineStart` 会得到空切片；旧正则放行中间 `=` 且不扫描）。
- **推测**：gitleaks 默认规则会把复核记录里的 `AKIA...` 也报出来（未直接运行 gitleaks）；超长单行会造成实际资源问题（机制成立，影响取决于输入大小）；真实图片被 AWS 规则误判的具体概率（按字符集估算）。
- **未核实**：`.agents/reviews/pr-274/round-2/deepseek-v4.1-flash.md` 的原文、`judgments.md`、`usage.jsonl` 无法读取（records path 被工具拒绝）；作者“`lastLinePartial` 只在截尾方向出现所以不成立”的论证未看到原文。

---

## 侧重检查

- **错误路径 / 不合规范输入**：查了空串、只有 END、END 与最后一行同线、多个 END、真实 `\n`、转义 `\n`、转义 CRLF、超长单行。`lineStartBefore` 的返回值被 `floor=cursor` 约束，且回退到不晚于 `marker.index - WINDOW` 的行首，`start <= marker.index`、`end <= input.length`，不会越界；新实现的遮盖范围是旧实现的超集（旧的可匹配位置在新切片里仍能以 `\n`/`\\n` 作为行首），所以**没有新增漏遮**；新增的是过度遮盖和资源放大。
- **安全**：data URL 现在比 `aeffe03f` 更严格：只放行合法形状且机器扫描为空的字符串；中间夹 `=` 的 `password=…` 会走文字遮盖；`scanMachineSecrets` 与 `redactMachineSecrets` 共用同一组 RULES，`assertMachineSecretFree` 仍在最后兜底。未发现新的绕过路径；副作用是真实图片可能被 AWS 形状误判改字节。
- **资源耗尽**：见发现 2。`BASE64_DATA_URL` 本身没有明显 ReDoS（`;`、`/`、`=` 都是确定边界）；但每条历史里的 data URL 现在都会跑 7 条机器密钥正则，超大图片会带来额外线性开销。
- **不可撤销操作**：本次改动没有删除/覆盖用户数据的操作；新增基线是仓库文件变更，不是运行时不可逆操作。
- **规则/文档与代码一致**：`.claude/rules/prompt-prefix.md` 要求“只追加、字节确定、遮盖只取决于内容”。本次请求组装结构没变，遮盖仍是按内容确定性重算；但收紧遮盖规则会让老对话里以前被放行的 data URL/未遮的私钥残块在下次发送时变一次字节，属于一次性缓存失效（见问题 1 的回答）。基线条目的语义与 CI 实际行为不一致，见发现 1。`check-egress-redaction.mjs` 的登记表与实际调用数一致（1 个 `scanMachineSecrets` 调用 + 1 个 `assertMachineSecretFree`）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
结构上不会：没有改工具定义/系统提示/历史消息的顺序，仍然是“固定在前、只追加”；本次也没有新增每轮会变的值，遮盖结果只取决于该段文本本身（以及同一文本内更早的匹配），不依赖后面的消息、时间或集合顺序。例外的代价是：这是收紧遮盖规则，老对话里如果含有以前被 `startsWith("data:")` 放行的内容、或以前没遮住的长私钥残块，下一次发送时这些历史位置的字节会变一次，从该位置起缓存失效。这不是每轮变化，是规则升级的一次性代价；如果要严格保证“发布也不改已发字节”，需要先做历史迁移或明确接受一次失效。

**2. 同一段文字会不会在不同请求里变成不同字节？**
不会引入新的跨请求不确定性。`scanMachineSecrets`、`redactMachineSecrets`、`redactPrivateKeyFragments` 都只读入参；`String.prototype.match/replace` 的全局正则会重置/忽略 `lastIndex`，没有残留状态；`lineStartBefore` 只依赖输入和同一输入内的 `cursor`。没有时间字段、无序集合或依赖后文的遮盖。唯一要记住的是“升级前后的规则不同”，同一版本、同一文本仍然逐字节相同。

**3. 有没有自动检查，反向用例真的会失败吗？**
有两条对应用例：
- `private-key-fragments.unit.test.ts:61-67`“masks a tail whose last line is longer than the look-back window”；
- `model-egress.unit.test.ts:129-146`（中间 `=` 的 `password=…`、data URL 后的 AWS 形状、真实图片保留）。
按旧实现推理，两条都会失败：旧 `nextLineStart` 会让切片为空；旧 `BASE64_DATA_URL` 允许 `=` 出现在任意位置且完全不扫描机器密钥。作者的“换回 aeffe03f 两条新用例失败”与代码一致。
**不足**：没有覆盖 `lineStartBefore` 的游标边界、转义换行下的超长最后一行、发现 4 的“前面长普通行被误遮”、以及“真实图片被 AWS 误判改字节”的取舍；也没有自动检查覆盖“新增基线在 CI 是否真的生效”。所以反向验证对这两点成立，但边界覆盖不完整。

**4. 每个产生/修改的值，使用它的地方都能接受吗？**
逐个核对：
- `lineStartBefore` 的返回值只用作 `slice` 起点；范围受 `cursor` 限制且不越界，唯一问题是长度上限和过度遮盖（发现 2/4）。
- `BASE64_DATA_URL` 的布尔结果只在 `maskTree` 使用，接受。
- `scanMachineSecrets` 的返回值只取 `.length`，返回只读数组，接受。
- `SENSITIVE_GATE_CALLS` 的 `scanMachineSecrets: 1` 与实际调用数一致，`findSensitiveGateViolations` 会按实际计数校验，接受。
- 基线条目的 `file/ruleId/digest/count`：本地 `scripts/scan-machine-secrets.mjs` 接受；但 **CI 的 `check-security.mjs` 使用 baseSha 的基线，不接受 head 新增条目**，这就是发现 1。`ruleId: "aws-access-key"` 还不能走 owner review 的机器密钥豁免（只允许 `credential-assignment`）。
- 测试里的 `AWS_LIKE = ["AKIA","ABCDEFGHIJKLMNOP"].join("")`：源码里不连续，machine-secrets 扫描不会命中，接受。
