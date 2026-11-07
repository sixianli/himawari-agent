## 结论摘要

- 发现 1 处会让合并前核对漏判的代码缺陷：`changedOutside` 经过 `git()` 的 `stdout.trim()` 后，只含空白或以空白开头的文件名可能被丢掉或误当成记录目录。
- 发现 1 处测试缺口：新接受的 64 位提交哈希没有正向用例，把 `COMMIT_PATTERN` 改回只认 40 位不会让现有测试失败。
- 本轮七项“撤掉修复就会失败”的用例，按测试代码逻辑确实覆盖了；另有若干文档与代码不完全一致、输入校验偏松的问题。
- 未发现 `GITHUB_TOKEN` 一类环境变量仍会传给模型；未发现提示词前缀在同一个会话内被改写；未发现提示词里带时间或无序集合导致同文本变字节。

## 读代码证实的问题（按严重度）

### 中：空白文件名可能让 `--assert-reviewed` 漏报未复核文件

- 文件:行：`scripts/model-review/opencode-review.mjs:806-810`、`scripts/model-review/opencode-review.mjs:1520-1524`
- 问题：`changedOutside` 依赖 `git()` 返回的字符串，而 `git()` 对 `git diff -z --name-only` 的结果做了 `.trim()`。`-z` 输出是用 NUL 分隔的原始路径，`.trim()` 会删掉整个输出最前面的空白字符；如果第一个改动文件叫 `" "`（或只含空白），它的路径会被删空，随后被 `.filter((file) => file && ...)` 丢掉，`assertReviewed` 会误判为没有未复核文件。若文件名是 `" .agents/reviews/pr-7/x"`，去掉前导空格后还会被误当成记录目录而过滤。
- 证据：

```js
function changedOutside(repo, from, to, ledgerPath) {
  return git(["diff", "-z", "--no-renames", "--name-only", from, to], repo)
    .split("\0")
    .filter((file) => file && !file.startsWith(`${ledgerPath}/`));
}
...
function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  ...
  return result.stdout.trim();
}
```

- 建议：给 NUL 分隔输出单独用一个不 `trim()` 的 `gitRaw()`；只处理末尾 NUL/换行，不要删除路径本身的首尾空白。补一条测试：在仅改记录目录之外新增名为 `" "` 的文件后，`assertReviewed` 必须报 `unreviewed`；再加一条 `" .agents/reviews/pr-7/x"` 的用例。该缺陷的触发需要合法但异常的文件名，属于闸门自身漏判，不是“恶意代码例外”能解释的。

### 中：64 位提交哈希没有正向测试，回退不会失败

- 文件:行：`scripts/model-review/opencode-review.mjs:924`；测试见 `test/tooling/opencode-review.test.mjs:2340-2362`、`test/tooling/opencode-review.test.mjs:1892-1902`
- 问题：本轮把 `COMMIT_PATTERN` 从只认 40 位改成认 40 或 64 位，但账本合法用例和 `ok()` 夹具都只用 40 位哈希。把正则改回 `^[0-9a-f]{40}$` 不会让任何现有测试失败，作者的“撤掉修复测试会失败”清单里也没有这一项。
- 证据：

```js
export const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
```

测试里的正向头是 `f.reviewed` 或 `${"a".repeat(40)}`，没有 `repeat(64)` 的合法账本记录。

- 建议：在 `readUsage` 层加正向用例，`head: "a".repeat(64)` 必须通过；再加 39、41、63、65 位的反向用例。若确实要支持 SHA-256 仓库，最好再做一个 SHA-256 临时仓库的 `assertReviewed` 集成用例。

### 低：规则文件没有完全补上本轮新增行为，作者“补全上述规则”的说法不完全准确

- 文件:行：`.agents/instructions/model-review.md:84`、`scripts/model-review/opencode-review.mjs:1026-1027`、`scripts/model-review/opencode-review.mjs:932-941`
- 问题：文档说 `ROUND_CANNOT_VERIFY` 只出现在“提示词文件和账本摘要都没有”时，但代码在“这一轮记录缺 `head`”时也会抛这个错误。`printable`/控制字符拒绝、`recordText` 把回车换成换行、拒绝例外时列出全部原因，也没有写进规则文件。`c6d132f..d2ade1f` 中 `model-review.md` 实际只改了环境变量白名单和账本哈希/换行两处。
- 证据：

```md
提示词文件不在时，改用账本里这一轮记下的 `promptSha256` 比较；两样都没有时以 `ROUND_CANNOT_VERIFY` 拒绝。
```

```js
if (inRound.some((record) => !record.head))
  throw new Error(`ROUND_CANNOT_VERIFY ${requested} head`);
```

- 建议：把“记录缺 `head` 也拒绝”写进文档；把 `printable`、`--main-ref` 控制字符校验、`recordText` 的回车归一化和多原因拒绝格式补上，或把作者的“补全规则”说法收窄。

### 低：`--accept-unreviewed` 和 `--andy-quote` 只拒绝 CR/LF，其他控制字符会原样打印

- 文件:行：`scripts/model-review/opencode-review.mjs:1667-1680`、`scripts/model-review/opencode-review.mjs:864`、`scripts/model-review/opencode-review.mjs:919`
- 问题：这两个值只检查 `[\r\n]`，ESC、退格等控制字符可以通过，随后在 `REVIEW_OVERRIDE quote=...` 和报告原因里原样输出，可能污染终端或伪造输出格式。`--main-ref` 已经用 `hasControlCharacter` 拒绝控制字符，这里没有统一。
- 证据：

```js
} else if (key === "--andy-quote") {
  options.andyQuote = take();
  if (/[\r\n]/.test(options.andyQuote)) throw new Error("ARG_INVALID --andy-quote");
...
} else if (key === "--accept-unreviewed") {
  options.acceptUnreviewed = take();
  if (!options.acceptUnreviewed.trim() || /[\r\n]/.test(options.acceptUnreviewed))
    throw new Error("ARG_INVALID --accept-unreviewed");
```

```js
lines.push(`REVIEW_OVERRIDE quote=${recorded.quote} recorded=${recorded.head}`);
...
`停下的原因：${STOP_REASONS[stop](andyQuote)}`,
```

- 建议：统一用 `hasControlCharacter` 拒绝所有控制字符，或打印时使用 `printable()`。这不影响正常中文和空格。

### 低：普通复核会静默接受并忽略 `--stop`、`--andy-quote`、`--main-ref`

- 文件:行：`scripts/model-review/opencode-review.mjs:1664-1676`、`scripts/model-review/opencode-review.mjs:1706-1714`
- 问题：这些选项在普通 `--mode` 运行里也会被解析进 `options`，但只有 `--assert-reviewed`/`--report` 分支才检查“参数是否属于该子命令”。例如把 `--stop` 或 `--main-ref` 误放到普通复核命令里，脚本会继续花钱运行，不报错也不使用。
- 建议：按运行类型维护允许的选项集合，普通复核里出现 `--stop`、`--andy-quote`、`--main-ref`、`--accept-unreviewed` 时以 `ARG_NOT_FOR_MODE` 拒绝，避免误用。

## 推测与未核实

- `git diff --name-only -z` 中空白文件名的实际行为，我是根据 `-z` 的原始输出语义推断的；受工具限制没有实际创建仓库验证。代码里的 `.trim()` 是确定的。
- `/tmp/himawari-review-raw` 是固定的共享临时目录。多用户 Linux 上若另一个用户先创建并以 0700 拥有该目录，`chmodSync(root, 0o700)` 会因非属主失败，脚本中断。这是可推测的跨用户 DoS，未在多用户环境核实；单用户云端容器不受影响。建议按 uid 或 `mkdtemp` 分目录。
- 未运行 vitest，也未运行真实 opencode / npm；测试与安装结论来自阅读测试源码和作者提供的运行结果。
- Mac 上的环境变量白名单是否足够，未核实。
- `opencode` 自身系统提示是否含临时工作目录等每次运行变化的值，未核实；同一会话内工作目录不变，跨轮是全新会话。

## 侧重检查

- 环境变量与令牌路径：检查了 `OPENCODE_KEPT_ENV`、`opencodeEnv`、`gitChildEnv`、`REVIEW_PARENT_CANARY`、`/proc/self/environ` 探针和 `proxyCredentialProblems`。白名单没有 `GITHUB_TOKEN`、`GH_TOKEN`、`OPENCODE_API_KEY` 等；canary 探针要求 `git log $REVIEW_PARENT_CANARY` 的输出不含标记；代理地址带用户信息的检测覆盖了无协议头、无 `//` 的写法。未发现令牌泄漏路径。
- 只读边界与记录隐藏：检查了 git 替身参数过滤、受限 bash、sparse checkout、`.git/info/attributes` 的 `-diff` 和自检探针。已知局限仍然存在：`git log --raw` 拿到对象编号后 `git show <hash>` 能读记录；`checkGitArgs` 只匹配字面 `agents/reviews`，通配或 `./` 写法可能绕过字符串检查，但作者已明确不防故意绕过。
- 不可信输入与文件名：检查了 `printable`、`hasControlCharacter`、账本递归换行检查、`--topic`/`--pr`/`--round` 校验。`printable` 本身对带控制字符的文件名有效；但 `changedOutside` 的 `.trim()` 使“首项为空白的文件名”绕过，是本次最实质的输入处理问题。
- 不可逆操作：`--accept-unreviewed` 会直接 `appendFileSync` 修改工作区账本。写前检查工作区账本与 `HEAD` 一致，写后若未提交，再运行会得到 `REVIEW_OVERRIDE_REFUSED ledger-differs-from-HEAD`，不会静默通过。没有发现事务回滚，但也没有发现未提交也能通过闸门的路径。
- 资源耗尽：prompt 超过 100000 字节在安装和花钱前拒绝；预算检查在安装前；每个模型有 0.2 美元上限和超时；raw 目录会持续累积，但按设计不进仓库。安装用锁文件校验，下载被替换会被 `npm ci`/`installedIntegrityProblems` 拦住；它确实不检查安装后磁盘文件被改，文档已写明。
- 错误路径：`ROUND_NOT_FOUND`、`ROUND_ALREADY_HAS_RESULT`、`ROUND_HEAD_MISMATCH`、`ROUND_PROMPT_MISMATCH`、`ROUND_MODE_MISMATCH` 都有对应分支；本轮新增的缺 `head` 分支也有测试。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   按当前代码，不会在同一个会话内改写已发内容。`buildPrompt` 把固定说明、必答问题和该模型的侧重放在前面，把 `head`、`base`、`previous`、`brief` 放在最后的 `---- 本次材料 ----` 里；一次复核的第一次请求只有这一条用户消息，因此每轮会变的值都在末尾。追问使用 `--session` 加 `WRAP_UP_PROMPT`，只在对话末尾追加；测试 `expectAppendedTo` 明确检查后一次请求的 `tools` 相同、`messages` 前缀逐字节相同（`test/tooling/opencode-review.test.mjs:1324-1327`、`1483-1484`、`1503-1504`）。`MODEL_LENSES` 是每个模型的固定字符串，不随轮次变化。需要说明的边界：跨不同的复核轮次是全新会话，提示词本来就可以不同；`--base`/`--questions-ref` 变化会改变固定部分，但这不会影响旧会话的已发内容。opencode 自身系统提示的内容未核实。

2. **同一段文字会不会在不同请求里变成不同字节？**
   没有发现。模型可见文本里没有时间字段、随机值或无序集合；`recordText` 对 CR 和行尾空白的处理是确定性的；`questions` 从某个提交读取，`head`/`base`/`previous` 是已解析的提交哈希；`MODEL_LENSES` 是常量。账本里的 `at` 时间戳和 `resultLine` 只进账本/终端输出，不进入模型提示词。`.agents/reviews` 的 `-diff` 隐藏也是固定规则。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   本轮列出的七项修改都有对应测试：代理 `//u:p@...`（`test/tooling/opencode-review.test.mjs:2552`）、文件名转义（`:2043-2064`）、拒绝原因并列（同上）、嵌套列表换行（`:2357`）、缺 `head`（`:2484-2497`）、回车符归一化（`:293`）、目录权限（`:299-308`）。按测试代码逻辑，撤掉对应修复会使这些断言失败；我未实际运行测试，因此只确认了测试代码覆盖。缺口有两个：64 位哈希没有正向测试，回退到只认 40 位不会失败；`changedOutside` 的空白文件名问题也没有测试，现有文件名用例只覆盖了“中间带换行”的名字。

4. **改动产生或修改的每个值，两端是否都能接受？**
    `pr`、`round`、`topic`、`mode`、`head`、`mainRef` 的生成和消费基本对齐：`pr` 是正安全整数并拼成 `pr-<n>`，`round` 是正安全整数，`topic` 有正则，`head` 用 40/64 位正则，`mainRef` 控制字符已拒绝。`promptSha256` 在写入端用当前 prompt 计算，重跑端用同一字符串重新哈希，逻辑一致。仍然偏松的是 `--questions-ref` 只拒绝 `-` 开头、不拒绝控制字符；以及普通运行会静默忽略 `--stop`/`--andy-quote`/`--main-ref`。这两处都不构成令牌泄漏或提示词前缀问题，但建议统一收紧。
