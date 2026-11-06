## 发现（按严重度）

### 中：合并前门禁漏判“把未复核文件改名进记录目录”
- 位置：`scripts/model-review/opencode-review.mjs:793`
- 问题：门禁用 `git diff --name-only` 只按新路径判断是否在记录目录内。Git 对 rename 默认只输出新路径，旧路径（被删除的代码文件）不会出现在结果里。
- 证据：
```js
for (const file of git(["diff", "--name-only", complete.head, head], repo).split("\n"))
  if (file && !file.startsWith(`${ledgerPath}/`)) problems.push(`unreviewed ${file}`);
```
我用同一仓库验证过 `--name-only` 的 rename 行为：`git show --name-status 8c5b51fd` 显示 `R098 docs/adr/0148-... docs/adr/0158-...`，但 `git diff --name-only 8c5b51fd^ 8c5b51fd` 只列出 `docs/adr/0158-...`，没有旧路径。
因此 `git mv src/x.mjs .agents/reviews/pr-7/x.mjs` 后，门禁只会看到新路径在记录目录里，删除 `src/x.mjs` 这一未复核改动会被放过。
- 建议：用 `git diff --no-renames --name-only`，或解析 `--name-status` 并要求 rename 的旧路径也在记录目录内。

### 中：环境探针没有放进脚本自己的环境，反向用例无法抓住“退回 `...process.env`”
- 位置：`scripts/model-review/opencode-review.mjs:1231`
- 问题：自检把 `REVIEW_PARENT_CANARY` 放在传给 `runOpencode` 的 `parentEnv` 副本里，而不是 `process.env`。如果以后有人把 `...opencodeEnv(parentEnv)` 改回原来的 `...process.env`，探针变量根本不在 `process.env` 里，`git log $REVIEW_PARENT_CANARY` 不会泄漏标记，自检仍然通过。
- 证据：
```js
parentEnv: { ...process.env, [REVIEW_PARENT_CANARY_ENV]: plan.marker },
```
```js
env: {
  ...opencodeEnv(parentEnv),
```
测试 `test/tooling/opencode-review.test.mjs:819` 的真实自检只断言输出里没有 `GITHUB_TOKEN` 的秘密值，但没有任何探针引用 `GITHUB_TOKEN`，所以旧代码（整份环境传过去）也能通过这条测试。另一条测试 `:482` 是手工篡改 `calls[index].output`，测的是检查器，不是 `runOpencode` 的环境构造。
- 建议：自检时把标记写进真正的 `process.env`（结束后删除），或增加一个测试让 `runOpencode` 用真实父进程环境跑，并确认退回 `...process.env` 时 `SELF_CHECK_FAILED`。

### 中：安装完整性检查只信 npm 的元数据，没有校验实际安装文件
- 位置：`scripts/model-review/opencode-review.mjs:282`
- 问题：`installedIntegrityProblems` 比较的是 `node_modules/.package-lock.json` 里记录的 `integrity` 和锁文件里的 `integrity`，没有对已安装包的实际内容做 sha512 计算。只要 `.package-lock.json` 没变，`node_modules/opencode-*/bin/opencode` 被替换也不会被发现。另外只显式检查了 `node_modules/opencode-ai` 是否存在；其他包若同时从已安装锁文件和磁盘上消失，不会被发现。锁文件或已安装锁文件不是合法 JSON 时，会直接抛 `SyntaxError`，而不是 `OPENCODE_INTEGRITY_MISMATCH`。
- 证据：
```js
const installed = JSON.parse(readFileSync(installedPath, "utf8")).packages ?? {};
const problems = [];
if (!installed["node_modules/opencode-ai"]) problems.push("node_modules/opencode-ai missing");
for (const [name, entry] of Object.entries(installed)) {
  const expected = lock.packages?.[name];
  if (!expected?.integrity || expected.integrity !== entry.integrity)
    problems.push(`${name} ${entry.integrity ?? "no-integrity"}`);
}
```
- 建议：要么明确把这条检查降级为“npm 安装元数据一致性”，要么实际校验安装文件摘要；同时逐项检查锁文件里的必需包是否存在，并把 JSON 解析失败包装成明确的错误码。

### 中：`--report --stop three-rounds` 不验证“三轮没过”，全 `ok` 也放行
- 位置：`scripts/model-review/opencode-review.mjs:838`
- 问题：`three-rounds` 只检查账本里有多少个不同轮次，没有检查这些轮次是否有失败记录。三轮全部 `ok` 时仍会输出“连续三轮没过，按规则停下等 Andy 决定”。
- 证据：
```js
const rounds = [...new Set(reviews.map((record) => record.round ?? 1))];
...
"three-rounds": rounds.length >= 3,
```
测试 `test/tooling/opencode-review.test.mjs:2053-2064` 先写入三轮全部 `ok`，然后断言 `report("three-rounds")` 成功，等于把这个错误行为固定下来了。
- 建议：要求连续三轮存在非 `ok` 记录（或该轮不是完整轮），并核对最新轮次确实属于这三轮；否则报 `REPORT_STOP_INCONSISTENT three-rounds`。

### 中低：`--accept-unreviewed` 没有限制在“连续三轮没过”这一种例外
- 位置：`scripts/model-review/opencode-review.mjs:804`
- 问题：代码只要有问题且传了非空原话就写覆盖记录，不检查轮次、不检查是否真的连续三轮没过，也不要求先有相应报告。文档 `.agents/instructions/model-review.md` 第 6 条说例外只有“连续三轮没过、Andy 看过报告仍说合并”这一种。
- 证据：
```js
const overridden = problems.length > 0 && Boolean(acceptUnreviewed);
...
lines.push(`REVIEW_OVERRIDE quote=${acceptUnreviewed}`);
```
- 建议：在写覆盖记录前核对账本里存在连续三轮未过、且最新状态与覆盖理由一致；否则拒绝。至少把限制写进代码或明确说明这个开关是通用的。

### 低：原始事件目录只按 PR 编号分，不同仓库会撞车
- 位置：`scripts/model-review/opencode-review.mjs:1455`
- 问题：`rawDir` 只使用 `reviewKey` 和轮次，没有仓库标识。同一台机器上两个不同仓库同时复核 `pr-7` 时，会共用 `/tmp/himawari-review-raw/pr-7/round-1`，`keepEarlierAttempt` 可能把另一个仓库的原始事件改名或覆盖。
- 证据：
```js
return join(tmpdir(), "himawari-review-raw", reviewKey(options), `round-${round}`);
```
- 建议：路径里加入仓库路径的摘要（例如 `sha256(resolve(repo)).slice(0,12)`）。

### 低：`--round` 在提示词文件缺失时放行，改变 `--brief` 也能重跑
- 位置：`scripts/model-review/opencode-review.mjs:904`
- 问题：提示词比较只在磁盘文件存在时进行；文件不存在（旧格式、被删除、上次在写提示词前崩溃）时直接放行。作者的说法是“提示词不同时拒绝”，但缺失文件无法比较，等于绕过了这条检查。
- 证据：
```js
const onDisk = promptsOnDisk[model] ?? null;
if (onDisk !== null && onDisk !== prompts[model])
  throw new Error(`ROUND_PROMPT_MISMATCH ${requested} ${model}`);
```
- 建议：新格式的轮次若缺少 `<模型>.prompt.md`，应直接拒绝重跑（或从账本里的 `promptSha256` 比较）。

### 低：文档与边界行为的小偏差
- `scripts/model-review/opencode-review.mjs:1690`：只有 `outcome !== "ok"` 且 `stderr` 非空时才写 `<模型>.stderr.txt`，作者概述的“每轮存 `<模型>.stderr.txt`”并不成立；文档“失败时的报错”是准确的。
- `scripts/model-review/opencode-review.mjs:757`：`resultLine` 直接使用 `record.round`，旧账本没有 `round` 时会打印 `round=undefined`，而其他逻辑都按第 1 轮处理。
- `scripts/model-review/opencode-review.mjs:1527`：`--report` / `--assert-reviewed` 提前返回，跳过参数校验；例如 `--report --accept-unreviewed`、`--report --out` 会被静默忽略。

### 推测（未核实）：`/proc/self/environ` 探针在 macOS 上可能误报
- 位置：`scripts/model-review/opencode-review.mjs:998`
- 问题：探针硬编码 Linux 的 `/proc/self/environ`。macOS 没有 `/proc`。如果 opencode 的 `read` 工具先检查文件是否存在、再检查 `external_directory` 权限，那么 macOS 上会得到“文件不存在”而不是三种拒绝文字之一，自检会以 `PROBE_NOT_REFUSED` 失败。
- 依据：我只能读到代码和 Linux 测试；作者也说明未在 Mac 验证。
- 建议：选择跨平台的不存在路径或可读的仓库外文件（例如 `../outside-a.txt` 已有），或者明确只支持 Linux。

## 侧重检查

- 错误路径：
  - 账本不可提交、无完整轮次、reviewed 不是祖先、`main-ref` 缺失、`main` 未合并：`assertReviewed` 都会放进 `problems`，主程序在未覆盖时退出码 5。已读代码确认。
  - 账本某行非法、`cost` 为负或 `round` 非正整数：`parseUsage` 抛 `USAGE_LEDGER_INVALID`。已读代码确认。
  - `--round` 不存在、已有 `ok`、head 不同、提示词不同：都在启动 opencode 前抛错；测试用不存在的 `HIMAWARI_OPENCODE_BIN` 验证没有进入运行阶段。已读代码确认。
  - 安装锁文件/已安装锁文件 JSON 非法：没有被包装成 `OPENCODE_INTEGRITY_MISMATCH`，见上面的完整性发现。
  - `--report` 的 `run-failed`、`no-error`、`andy-decision` 有一致性检查，但 `three-rounds` 检查不足，见发现。
- 不可信输入：
  - `--pr` 要求正安全整数，`--topic` 要求 `^[a-z][a-z0-9-]{0,62}$`，无法用 `../` 跳出记录目录。已读代码确认。
  - `--main-ref`、`--questions-ref` 直接作为 git 参数传给 `spawnSync`，没有 shell 注入；但调用者可以传 `--main-ref HEAD` 让“main 已合入”恒真，这是门禁约定上的弱点。
  - 模型的 git 参数：含 `agents/reviews` 的参数、`-a`、`--text`、`--binary` 被拒；记录目录在副本工作区被 sparse checkout 去掉、在 `.git/info/attributes` 标成 `-diff`。作者已承认 `git log --raw` 找对象号再 `git show <blob>` 的绕过，代码没有封住。
  - 模型读 `/proc/self/environ`、读/搜索/找仓库外文件：由 opencode 权限拒绝，自检覆盖。
- 安全：
  - `OPENCODE_KEPT_ENV` 确实去掉了 `GITHUB_TOKEN`、`GH_TOKEN`、`AWS_SECRET_ACCESS_KEY`、`OPENCODE_*` 和 `NODE_OPTIONS`；单元测试和真实自检测试存在，但反向用例对“退回整份环境”保护不足，见发现。
  - git 替身仍会剥掉 `GIT_*`、`LD_*` 等，只留 `PATH`、`HOME`、`LANG`、`LC_ALL`、`TERM`。已读代码确认。
  - 安装完整性检查只覆盖 npm 元数据，见发现。
- 资源耗尽：
  - 单个提示词有 100000 字节上限；每个模型每轮仍有 0.2 美元和超时上限，这部分没有被这次改动放松。
  - `stderr` 在 `runOpencode` 里是无上限累积，这是改动前就有的行为，不是本 PR 新增。
  - `assertReviewed`/`reviewReport` 会整份读取账本；账本随轮次增长，但没有新的循环放大。
- 不可撤销操作：
  - `keepEarlierAttempt` 在重跑前把旧文件改名为 `.attempt-n.*`，不会删除原内容；新一次失败后旧的 attempt 仍保留。
  - `assertReviewed --accept-unreviewed` 会向工作区的 `usage.jsonl` 追加覆盖记录，需要线程提交；可以通过 git 回退，不是不可逆。
  - 临时副本在结束时 `rmSync` 删除；这是设计行为。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 本 PR 没有改 opencode 的系统提示和工具定义；`buildPrompt` 只在固定部分新增了按模型固定的 `MODEL_LENSES`，位置在必答问题之后、输出格式之前，不是追加到最末尾。因为每次复核都是新会话，同一模型在会话内（包括追问）这段内容不变，追加的只有 `WRAP_UP_PROMPT`。
   - 每轮变化的值仍然是 `head`、`base`、`previous` 和作者材料，它们都在 `---- 本次材料 ----` 之后的最后一条用户消息里；没有把会变的值放进系统提示或工具定义。
   - 需要注意：相对旧版本的整个 prompt，lens 是“插入固定块”，不是末尾追加；如果试图复用这次改动前建立的会话，前缀会不一致。但本工具每轮新建会话，所以不触发缓存前缀问题。
   - 隐藏 `.agents/reviews` 改变的是模型运行 `git diff/log` 时的工具输出，不是改动已经发出的请求内容；工具定义和系统提示没有变。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   - prompt 里没有时间字段、随机值或无序集合；`questions` 来自按行匹配的 Markdown，顺序固定；`MODEL_LENSES` 按模型常量查找。`head`/`base` 每轮不同，但只出现在最后一条用户消息里。
   - `usage.jsonl` 的 `at` 时间戳和 `promptSha256`、原始事件里的时间戳都没有进入发给模型的 prompt。记录目录的 `-diff` 标记是确定性的，同一个文件每次都会显示为 binary。
   - 两个模型现在的 prompt 内容不同（各自的侧重），这是按模型固定的差异，不是同一段文字被上下文相关地改写；没有遮盖逻辑参与。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   - 有较完整的自动检查：`prepareCopy` 的 sparse checkout/`-diff`、`checkGitArgs` 的记录路径/`-a`/`--text`/`--binary`、`roundForRun` 的四类拒绝、`assertReviewed`/`reviewReport` 的多种账本场景、`installedIntegrityProblems` 和真实 `npm ci` 的篡改锁文件用例。
   - 真正的反向用例：`roundForRun` 拒绝重跑（真实脚本测试，且验证没有写文件）、记录目录被隐藏（真实建仓，验证 diff 不含 `EARLIER_VERDICT`/`cacheRead`）、坏锁文件（真实 npm ci，验证 `OPENCODE_INTEGRITY_MISMATCH`）是有效的。
   - 不足的反向用例：
     - 环境白名单：没有一条测试会在 `runOpencode` 退回 `...process.env` 时失败；真实自检的秘密测试不触发 `GITHUB_TOKEN`，探针模拟测试只测检查器。
     - 合并门禁：没有 rename 用例；`--accept-unreviewed` 没有三轮限制用例。
     - 报告：`three-rounds` 的测试反而断言全 `ok` 三轮也能成功，固定了错误行为。
     - 安装完整性：没有覆盖“实际文件被改但已安装锁文件不变”或“必需包缺失但未出现在已安装锁文件”的用例。
     - 隐藏记录：对象编号绕过按作者说明仍未覆盖。

## 作者说法核对

- T1 环境白名单和 `git log $REVIEW_PARENT_CANARY`、`/proc/self/environ` 探针都存在；但 canary 在 `parentEnv` 副本里，不在脚本自己的 `process.env` 里，反向保护弱于说法。
- T7 `npm ci`、锁文件、目录名带摘要前 12 位、`OPENCODE_INTEGRITY_MISMATCH` 都存在；但“核对已装的每个包的 sha512”实际只核对 npm 元数据，不是实际文件。
- T8 的轮次/模型/head/提示词检查在花钱前执行，失败文件改名也存在；提示词文件缺失时会放行，见低严重度发现。
- T3 的固定记录目录、`--pr`/`--topic`、`--out` 限制、sparse checkout、`-diff`、git 替身拒绝记录路径都成立；`<模型>.stderr.txt` 只在失败且有 stderr 时写，不是每轮都写。
- T2 的祖先、范围、main 合并检查成立；存在 rename 漏判和 `--accept-unreviewed` 未限制的缺口。
- T6 的固定报告行成立；`three-rounds` 的一致性检查不足。
- T5 的 `MODEL_LENSES`、第 4 条必答问题、`--questions-ref` 与代码一致。
