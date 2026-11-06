## 结论

本轮增量（8e378395..a253b15f）确实修了作者列出的几条路径，主要测试也都在。但有两处我读代码能确认的问题：代理凭据检查可被前后空白绕过；例外记录可能把没有结尾换行的账本写坏。另有三处说法/规则与代码不完全一致。测试无法在本环境运行，作者报的 113/1 未核实。

## 读代码证实的问题

### 1. 中：带账号密码的代理值只按“第 0 字节开始的 scheme://”检查，可被空白绕过

- 文件:行：`scripts/model-review/opencode-review.mjs:425`（检查），`:412`（白名单），`:1685`（入口），测试 `test/tooling/opencode-review.test.mjs:2388`
- 问题：`PROXY_ENV` 里的值如果是 `HTTPS_PROXY=" http://u:p@host:3128"`，正则 `^[a-z][a-z0-9+.-]*:\/\/...` 因前面的空格不匹配；而 `HTTPS_PROXY` 又在 `OPENCODE_KEPT_ENV` 中，模型仍能用 `git log $HTTPS_PROXY` 让 shell 展开它（未加引号的展开会去掉前导空白），凭据就可能出现在 git 的报错里。省略 scheme 的 `u:p@host` 也不匹配。测试只覆盖了 `http://u:p@proxy:3128` 和 `https://token@proxy`。
- 证据：
  - `return PROXY_ENV.filter((name) => /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(env[name] ?? ""));`
  - 白名单含 `"HTTPS_PROXY"`, `"https_proxy"`, `"HTTP_PROXY"`, `"http_proxy"`（412-415）。
  - 测试只断言 `http_proxy: "http://u:p@proxy:3128"` 和 `HTTPS_PROXY: "https://token@proxy"`。
- 建议：先 `trim()` 再判断；或在冒号后的 authority 部分只要出现 `@` 就拒绝；补前后空白、无 scheme 的反向用例。至于这些写法是否被 opencode/undici 当作有效代理，属于“推测”，见下。

### 2. 中：账本末尾没有换行时，追加例外会拼坏 JSON

- 文件:行：`scripts/model-review/opencode-review.mjs:855`（比较），`:859`（追加）；普通记录追加在 `:1799`
- 问题：只比较 `onDisk !== shown.stdout`，没有保证文件以 `\n` 结尾。若已提交的 `usage.jsonl` 最后一行没有换行（工作区和 HEAD 内容仍然相等），`appendFileSync` 会把新的例外 JSON 直接接在上一行后面，生成 `{...}{...}`，下一次 `parseUsage` 直接抛 `USAGE_LEDGER_INVALID`。这行例外已经写进文件，只能靠 git 恢复。
- 证据：
  - `const onDisk = existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8") : null;`
  - `if (onDisk !== shown.stdout) ... else { appendFileSync(ledgerFile, \`${JSON.stringify({ at: ..., mode: "override", ... })}\n\`); ... }`
  - `parseUsage` 逐行 `JSON.parse`，失败即 `USAGE_LEDGER_INVALID`（912-930）。
- 建议：追加前判断 `onDisk` 非空且不以 `\n` 结尾时先补一个 `\n`；或在读取账本时显式拒绝没有结尾换行的文件，并给出明确错误码。

### 3. 低：规则说“只改了记录目录”，代码只忽略“本 PR 的记录目录”

- 文件:行：`scripts/model-review/opencode-review.mjs:804`、`:848`；规则 `.agents/instructions/model-review.md:36`；提交说明也写“之后只改了记录目录就……通过”
- 问题：`changedOutside` 只排除 `${ledgerPath}/`（本 PR 的目录）。在例外记录之后，如果只提交了 `.agents/reviews/pr-8/...` 这类**别的**记录目录，`--assert-reviewed --pr 7` 仍会把它列为 `unreviewed`，例外不被认出。第 35 行的普通检查写的是“本 PR 的记录目录”，第 36 行和提交说明写的是“记录目录”，两者不一致。
- 证据：
  - `.filter((file) => file && !file.startsWith(\`${ledgerPath}/\`));`
  - `changedOutside(repo, record.head, head, ledgerPath).length === 0`
- 建议：把第 36 行和提交说明改成“本 PR 的记录目录”；若确实想忽略所有记录目录，改用 `REVIEWS_DIR` 前缀，并补对应测试。

### 4. 低：`nextRound` 仍会把例外记录算成第 1 轮，和“例外记录不算进任何一轮”不一致

- 文件:行：`scripts/model-review/opencode-review.mjs:940-943`；规则 `.agents/instructions/model-review.md:84`
- 问题：`roundForRun` 里过滤了 `mode === "override"`（956-958），但 `nextRound` 没有过滤，例外记录没有 `round` 字段，会按 `record.round ?? 1` 算成第 1 轮。只有在“账本里只有例外记录、没有其他轮次”这种退化情况下才会把下一轮算成 2，但规则的说法是“任何一轮”。
- 证据：`const recorded = records.map((record) => record.round ?? 1); return Math.max(0, ...recorded, ...rounds) + 1;`
- 建议：在 `nextRound` 里也排除 `mode === "override"`；或把规则限定为“`--round` 校验时不算”。

### 5. 低：例外原话里的换行会注入 `--assert-reviewed` / `--report` 的“固定行”

- 文件:行：`scripts/model-review/opencode-review.mjs:852`、`:862`、`:907`；规则 `.agents/instructions/model-review.md:36`
- 问题：`--accept-unreviewed` 的原话和 `--andy-quote` 原样拼进输出行，没有去掉 `\r`/`\n`。传入含换行的字符串时，输出会多出整行，可能伪造出 `REVIEW_CURRENT` 之类的固定行。账本里的 JSON 本身是安全的（`JSON.stringify` 会转义）。
- 证据：
  - `lines.push(\`REVIEW_OVERRIDE quote=${acceptUnreviewed}\`);`
  - `lines.push(\`REVIEW_OVERRIDE quote=${recorded.quote} recorded=${recorded.head}\`);`
  - `\`停下的原因：${STOP_REASONS[stop](andyQuote)}\``
- 建议：对这两个参数拒绝 `[\r\n]`，或把换行替换成空格。考虑到这是线程/Andy 自己的输入，严重度低。

### 6. 低：安装完整性核对的是“安装记录里的摘要”，不是已装文件的摘要

- 文件:行：`scripts/model-review/opencode-review.mjs:282-299`；规则 `.agents/instructions/model-review.md:62`
- 问题：`installedIntegrityProblems` 比较 `node_modules/.package-lock.json` 里记录的 `integrity` 字符串和锁文件是否一致，并不重新计算 `node_modules` 里文件的实际摘要。因此作者说法里的“每次使用前再核对已装的每个包的 sha512”不准确；装好之后再改磁盘上的文件不会被发现。规则文件第 62 行已经写明这个局限，只是说法需要统一。
- 证据：`const expected = lock.packages?.[name]; if (!expected?.integrity || expected.integrity !== entry.integrity) problems.push(...);`
- 建议：把摘要性说法改成“核对 npm 安装记录”，或明确写“不重算已装文件”；若确实需要防磁盘篡改，再补实际哈希校验。

### 7. 低：`parseUsage` 只校验 `cost` 和 `round`，没有校验 `head` / `mode` / `outcome`

- 文件:行：`scripts/model-review/opencode-review.mjs:912-930`；使用处 `:782-796`、`:812-823`
- 问题：账本里一行若有 `outcome:"ok"` 但缺 `head`，`lastCompleteRound` 会返回 `head: undefined`，随后 `merge-base --is-ancestor undefined HEAD` 的结果取决于 Node 对参数的处理：要么被当成字符串 `undefined` 导致 `not-ancestor undefined`，要么抛异常以退出码 2 结束。无论哪种都是失败关闭，但错误信息不清楚；这也属于“不合规范的输入”没有在校验阶段挡住。
- 证据：`record?.round === undefined || (Number.isSafeInteger(record.round) && record.round > 0)` 只校验 round；`head` 直接 `passed.map((record) => record.head)`。
- 建议：在 `parseUsage` 里按本工具生成的记录格式校验 `head`（提交哈希）、`mode`、`model`、`outcome`，不合法直接报 `USAGE_LEDGER_INVALID`。Node 对 `undefined` 参数的具体行为我未实测，标为推测。

## 推测 / 需要实测

- 代理值前后空白、无 scheme 的写法是否会被 opencode/undici 当作有效代理并实际使用，未验证；正则本身不匹配是读代码证实的。
- `git diff --name-only` 对记录目录里非 ASCII 文件名可能输出带引号的路径（以 `"` 开头），导致 `changedOutside` 的 `startsWith(ledgerPath)` 匹配失败，把合法的记录文件报成 `unreviewed`。当前生成的记录文件名都是 ASCII，未实测触发。
- Windows 上 `core.autocrlf` 让 `.prompt.md` 检出为 CRLF 时，`promptOnDisk` 与本次提示词字节不同，`--round` 会以 `ROUND_PROMPT_MISMATCH` 拒绝。脚本主要在 Linux/Mac 用，未实测。
- `npmCi` 用默认环境跑 `npm ci`，生命周期的安装脚本能拿到父进程的令牌；包由锁文件 sha512 固定，按当前威胁模型（不防恶意依赖）不是新问题，只是 T1 之外仍存在的供应链面。
- `--accept-unreviewed` 只信任账本里已有的 `mode:"override"` 记录，不校验原话非空、不重新核对三轮；按约束“不防有人故意埋恶意代码/改账本”，不作为主要问题。

## 侧重检查

我按“错误路径、不合规范输入、安全、资源耗尽、不可撤销操作”检查了这些地方：

- **环境变量与密钥**：读了 `OPENCODE_KEPT_ENV`、`opencodeEnv`、`runOpencode` 的 env 组装和自检探针。白名单里没有 `TOKEN/SECRET/KEY/PASS` 类变量；`REVIEW_PARENT_CANARY` 确实不在白名单，自检会把它写进父进程环境，并用 `git log $REVIEW_PARENT_CANARY` 探针验证；`REVIEW_CANARY` 是故意传给 opencode 的，用于 `GIT_EXTERNAL_DIFF=env` 探针。结论：机制成立；代理是唯一带凭据的白名单项，见问题 1。
- **代理输入**：检查了大小写、`NO_PROXY`、错误信息是否打印值。错误信息只打印变量名，测试断言 `not.toContain("secret")`，这点成立；绕过点见问题 1。
- **账本/参数等不可信输入**：`--pr` 校验为正安全整数，`--topic` 用 `^[a-z][a-z0-9-]{0,62}$` 限制，`--round` 校验正安全整数，避免路径穿越；`git` 都用参数数组调用，没有 shell 注入。账本字段校验缺口见问题 7，例外原话换行见问题 5。
- **破坏性/不可逆操作**：`npmCi` 会 `rmSync(prefix)`，prefix 来自固定缓存目录或测试传入，正常路径范围固定；`keepEarlierAttempt` 只做重命名，可恢复；最实质的是例外追加可能写坏账本，见问题 2。
- **资源耗尽**：`parseUsage` 整个读入账本，`git` 用 `maxBuffer: 1<<28`；`--timeout-minutes` 只校验有限正数，没有上限，传极大值后 Node 定时器会被截断，但属于操作者输入，影响有限。未见模型可触发的内存耗尽路径。
- **隐藏记录目录**：读了 `prepareCopy` 的 sparse checkout、`.git/info/attributes` 和 `checkGitArgs`。我还实际试了 `git show HEAD:.agents//reviews/...`、`.agents/./reviews/...`、`git show HEAD:'.:(icase).AGENTS/REVIEWS/...'`、`git blame ... ':(icase).AGENTS/REVIEWS/...'`，要么“不存在”，要么被替身以 `records-path` 拒绝；没有找到比作者已承认的“`git log --raw` 拿对象编号再 `git show <blob>`”更容易的读法。该已知局限仍在。
- **安装完整性**：读了 `installOpencode` / `installedIntegrityProblems` / `opencodeInstallDir`。锁文件、`npm ci`、安装目录摘要前 12 位、复用前核对、重装一次都成立；核对对象是安装记录而非文件本身，见问题 6。
- **自动检查和反向用例**：见下面第 3 条必答问题。

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**不会改变已发前缀；仍然是只在末尾追加。** 依据代码：

- 每次运行只调用一次 `buildPrompt` 生成一条用户消息（`opencode-review.mjs:193-222`）；模型实际收到的就是这条（`runOpencode` 的 `prompt` 参数，522-535）。
- 决定追问时，复用同一个 `session`，只把 `WRAP_UP_PROMPT` 追加在末尾（724-736、78-79），工具定义不变；`reviewConfig` 的 wrap-up 只把权限 `allow` 改成 `ask`（114-119），没有改工具表。
- `reviewConfig` 的系统提示/工具定义没有出现 `head`、`base`、`previous`、`brief` 之类每轮变化的值；会随轮次变化的材料都在初始用户消息里（`material`，209-221）。
- 新增的 `MODEL_LENSES` 插在固定段里、材料之前（203-208），按模型和模式恒定；它属于这条唯一的初始消息，不是“已发内容之前再插入”，且每个模型每轮都相同。
- 每次复核都是新 opencode 会话（没有跨轮 `--session`），因此不存在“上一轮已见前缀被改写”的问题；跨轮第一次请求的字节可以不同，这是新会话允许的。

我没有实际发请求验证系统提示和工具定义的 wire bytes，只核对了代码和配置结构；自检里对工具表、输出上限、推理强度的断言是间接证据。

### 2. 会不会让同一段文字在不同请求里变成不同的字节（前后文相关遮盖、时间字段、无序集合）？

**不会引入这类不确定性。** 依据：

- 提示词只由 `MODE_TEXT`、必答问题、固定句子、按模型恒定的 `lens`，以及 `head`/`base`/`previous`/`brief` 组成；`lens` 恒定（179-184），问题顺序固定（204-205），没有 Set/Map 的遍历进入提示词。
- `recordText` 是纯函数（1540-1542）：`text.replace(/[ \t]+$/gm, "")` 加结尾换行；同一输入永远得到同一输出，不依赖前后文。`--brief` 用它（1676），`.md`/`.stderr.txt` 也用它（1779、1801）。
- 带时间的 `at` 只写进 `usage.jsonl`（1783），不在提示词里；`REVIEW_RAW_DIR` 里的临时路径只打印到控制台（1756-1759），不在提示词里；随机 marker 只用于自检探针文件。
- `head`/`base`/`previous` 在每次运行开始时解析一次（1491-1495），同一次运行内不会变；不同提交导致不同字节是预期行为。

要注意的是：`--brief` 现在会去掉行尾空格，所以同一段“带行尾空格的原文”在改动前后会得到不同的字节；但这是确定性的规范化，不是随请求/上下文变化。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有对应测试，按代码推断反向用例会失败；但我没有执行测试，作者的“113 通过 1 跳过 / npm run check / build 通过”未核实。**

已读到的对应测试：

- 代理凭据真实入口：`test/tooling/opencode-review.test.mjs:2386-2429`，断言退出码 2、`PROXY_HAS_CREDENTIALS HTTPS_PROXY`、不包含 `secret`。撤掉检查后，后续会走到自检失败（退出码 3）而不是 2，测试会失败。
- 已提交例外与工作区不一致：`:2039-2049`。撤掉 `recorded` 分支，`later.overridden` 会是 false；撤掉 `onDisk !== shown.stdout`，dirty 用例会写账本并返回 overridden=true，测试会失败。
- `--round` 的 `ROUND_CANNOT_VERIFY`：`:2275`；撤掉判断会返回 2，测试会失败。
- `ROUND_MODE_MISMATCH` 与忽略例外记录：`:2349-2384`；撤掉对应判断会返回 1 或抛 `ROUND_HEAD_MISMATCH`，测试会失败。
- `/proc/self/environ` 平台断言：`:433-443`。
- 环境白名单与真实自检：`:821-875`；安装锁与篡改：`:702-777`；记录目录隐藏：`:1047-1090`。
- 反向用例的缺口：没有从真实入口验证 `--brief` 行尾和 `.stderr.txt` 行尾的归一化（只有 `recordText` 单元测试）；没有从 CLI 验证已提交例外的退出码为 0；没有覆盖代理值前后空白/无 scheme；没有覆盖“账本末尾缺换行”；没有覆盖 `nextRound` 对例外记录的处理；没有覆盖“别的 PR 的记录目录”在例外之后变更的情况。

## 未核实

- 测试没有实际运行；作者报的通过数、跳过数、`npm run check`、`npm run build` 都未验证。
- macOS 上 `OPENCODE_KEPT_ENV` 是否足够（作者自己也没把握），未在 Mac 验证。
- `git show <blob>` 绕过 `-diff` 的已知局限仍在，我没有对象编号可实测，但这是 git 的既知语义，作者也已写明。
- 某些推测的触发条件（代理空白/no-scheme 是否被实际代理库接受、非 ASCII 文件名是否被 `git diff --name-only` 加引号、Node 对 `undefined` 参数的行为）未实测。
