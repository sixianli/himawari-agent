## 结论摘要

读代码发现一处会直接让交接流程失败的问题：合并 main 之后，`opencode-review.mjs` 写进仓库的提示词文件是**遮盖后**的，而账本里的 `promptSha256` 是**未遮盖原文**的摘要；`delegate.mjs check` 却拿遮盖后的文件去和未遮盖摘要比对。任何材料里出现像密钥的文字时，合法结果都会被判 `DELEGATION_RECORD_MISMATCH`（`prompt-hash=`）。这是第 6 轮合并引入的两边交互问题，现有 delegate 测试没有覆盖。其余部分（`--require-gateway`、check 的强推/改代码/改账本/符号链接防护、wait、文档主体）与作者说法基本一致。

---

## 读代码证实的问题

### 1.【中】遮盖后的提示词文件与未遮盖的 `promptSha256` 对不上，`check` 会拒绝合法结果

文件:行：
- `scripts/model-review/delegate.mjs:332-336`
- `scripts/model-review/opencode-review.mjs:2992`、`3018`
- `.agents/instructions/model-review.md:92`、`:137`
- `test/tooling/review-delegate.test.mjs:78`、`:95`

问题：main 合并进来的遮盖改动把写进仓库的提示词改成 `maskSecretLike(prompt)`，但账本里的摘要仍是未遮盖原文的 sha256。delegate 的核对直接把文件内容做 sha256 再和账本比，两者在材料含"像密钥"的文字时必然不等。文档一处说"`promptSha256` 是未遮盖原文的摘要"（第 92 行），另一处又说 check 要求"提示词的哈希对得上账本"（第 137 行），自相矛盾。

证据（亲自读到）：
```js
// delegate.mjs:332-336
const prompt = showFile(repo, remote, `${recordsDir}round-${round}/${name}.prompt.md`);
if (prompt === null) problems.push(`missing=round-${round}/${name}.prompt.md`);
else if (sha256(prompt) !== record.promptSha256)
  problems.push(`prompt-hash=round-${round}/${name}`);
```
```js
// opencode-review.mjs:2992
writeFileSync(join(roundDir, promptFileName(model)), maskSecretLike(prompt));
// opencode-review.mjs:3018
promptSha256: createHash("sha256").update(prompt).digest("hex"),
```
```js
// test/tooling/review-delegate.test.mjs:78,95 —— 提示词只有 "prompt\n"，不会触发遮盖
promptSha256: createHash("sha256").update("prompt\n").digest("hex"),
...
[`.agents/reviews/${KEY}/round-1/${name}.prompt.md`, "prompt\n"],
```
影响：只要 `--brief` 或固定问题里出现 `sk-...`、`password: ...`、私钥标记等，云端跑完的真实结果会在 `check` 阶段被以退出码 5 拒绝，Mac 线程会误以为结果不可信。它不会让坏结果被接受（是 fail-closed），但会堵住交接主路径，而这正是遮盖功能本来要处理的场景（I-86 起因就是记录里出现假密钥）。

建议：给账本再加一个"仓库内存放文件"的摘要（例如 `promptFileSha256 = sha256(maskSecretLike(prompt))`），`check` 用它核对文件；`promptSha256` 继续用于补跑的未遮盖比对。或者反过来把两个摘要的语义写清并统一三处（写入、`roundForRun`、`delegate`）。同时补一条 delegate 用例：brief 里放一个拆开写的 `sk-` 假值，跑出的遮盖提示词必须被接受。文档第 137 行相应改成"用存放文件摘要核对"。

---

### 2.【低】`check` 没有记录文件数量/单文件大小上限，恶意或失控的云端线程可让 Mac 做大量读取和哈希

文件:行：`scripts/model-review/delegate.mjs:171-181`、`199-202`、`331-336`、`341-358`

问题：`git()` 的单次输出上限是 256 MB，`showFile` 对整个 blob 读入内存；`added` 的条数只受账本大小限制，随后为每条记录读答案和提示词两份文件，并对提示词做 sha256，另外还要遍历所有改动文件。云端推一个很大的分支就能让 `check` 在 Mac 上持续读盘、占内存、耗 CPU。

证据：
```js
// delegate.mjs:173-175
maxBuffer: 1 << 28,
...
```
```js
// delegate.mjs:331-336 —— 每条新记录都整份读取两个文件
const answer = showFile(repo, remote, `${recordsDir}round-${round}/${name}.md`);
const prompt = showFile(repo, remote, `${recordsDir}round-${round}/${name}.prompt.md`);
```
建议：先用 `git cat-file -s` 或 `git ls-tree -l` 取大小，限制新记录条数、单文件大小和总字节；超过就 `DELEGATION_RECORD_TOO_LARGE` 拒绝，不要先整份读入。

---

### 3.【低】远端分支不存在时 `wait` 把它当成"没变"，白等满 90 分钟

文件:行：`scripts/model-review/delegate.mjs:399-410`、`413-416`

问题：`git ls-remote origin refs/heads/<分支>` 在分支不存在时退出码为 0、输出为空；`remoteHead` 返回 `""`，`waitForBranch` 里 `sha && sha !== tip` 为假，于是继续轮询直到超时，而不是报错或提示分支不存在。

证据：
```js
// delegate.mjs:414-415
const result = git(["ls-remote", "origin", `refs/heads/${branch}`], repo);
return (result.stdout.split("\t")[0] ?? "").trim();
// delegate.mjs:407
if (sha && sha !== tip) return { moved: true, sha };
```
建议：把空 sha 单独判断为 `DELEGATION_BRANCH_MISSING`（或抛 `DELEGATE_GIT_FAILED`），别和"未变化"混在一起。

---

### 4.【低】命令行少给 `--pr/--topic` 时抛内部错误码 `REVIEW_KEY_MISSING`，不是 `DELEGATE_INVALID pr-or-topic`

文件:行：`scripts/model-review/delegate.mjs:43-45`、`495-496`，对照 `64-67`

问题：`parseTask` 在还没调用 `validateTask` 前就自动推导 `brief`；缺 `--pr/--topic` 时 `reviewKey` 直接抛 `REVIEW_KEY_MISSING`。用户看到的不是设计好的 `DELEGATE_INVALID pr-or-topic`。

证据：
```js
// delegate.mjs:495-496
if (task.mode && !task.brief && task.head)
  task.brief = briefPathFor({ pr: task.pr, topic: task.topic, head: task.head, mode: task.mode });
// opencode-review.mjs:2382（reviewKey）
throw new Error("REVIEW_KEY_MISSING");
```
建议：先做 `pr-or-topic` 校验再推导 `brief`，或把推导包在 try 里转成 `DELEGATE_INVALID pr-or-topic`。

---

### 5.【低】服务方允许集合有两个来源：`validateTask` 用本地当前 `gateway.json`，`checkResult` 用交出点的 `gateway.json`

文件:行：`scripts/model-review/delegate.mjs:80-88`、`300-310`

问题：`check` 里 `task.providers` 的合法性先用本地当前文件校验，再用交出点文件算 `allowedProviders`。交接期间若本地 `gateway.json` 变了（例如 pull 了 main），合法的云端结果会被 `DELEGATE_INVALID providers` 拒绝，而不是按交出点判定。

证据：
```js
// delegate.mjs:80-88
const known = readGatewayConfig(undefined, REVIEW_MODELS).providers.map((provider) => provider.id);
requireValue(
  task.providers === undefined ||
    (task.providers.length > 0 &&
      task.providers.every((id) => PROVIDER_PATTERN.test(id) && known.includes(id))),
  "DELEGATE_INVALID providers",
);
// delegate.mjs:310
const allowedProviders = task.providers ?? providersFromTip();
```
建议：`check` 路径统一以交出点的 `gateway.json` 为准（`prompt` 路径可以继续用本地文件），或在文档里写明两边必须一致。

---

## 推测 / 未核实

- "三个测试文件 229 条通过、九处关键逻辑改坏都会失败"：本环境只能跑 git 读操作，**未核实**。
- `himawari-cloud` 是否总会提供 `HTTPS_PROXY` 等代理变量、且代理 URL 不带 `@` 凭证：代码只要求四个变量之一非空，随后 `proxyCredentialProblems` 又会拒绝带凭证的 URL。真实云环境是否满足**未核实**。
- `.agents/reviews/topic-review-delegation/proposal.md` 与 `.agents/reviews/pr-300/**`：当前工作树没有 `.agents/reviews` 目录（git 也拒绝 diff 记录路径），**未核实**。
- 作者关于提交号的叙述有一处小错：`12db3d8d` 实际是"缩短第 5 轮新增用例"，low-fix 记账是 `741cb9334`（`git show --stat 741cb9334` 只改了 `.agents/reviews/pr-300/usage.jsonl`）。所以"12db3d8d 之后本 PR 只有合并"严格说不对，但多出的只是一个账本记录提交，没有代码改动。

---

## 侧重检查（错误路径 / 不可信输入 / 安全 / 资源 / 不可撤销 / 文档一致性）

- **强推**：`merge-base --is-ancestor` 只有返回 1 才报 `DELEGATION_REWRITTEN`，其他非 0 抛 `DELEGATE_GIT_FAILED`（`delegate.mjs:240-245`）。已核实，测试也覆盖（`review-delegate.test.mjs:237-247`、`:462-468`）。
- **改代码 / 改了又还原**：逐提交 `git log -z --name-only` 加最终 `git diff --raw` 双重检查（`delegate.mjs:249-259`），合并提交直接拒绝（`:247-248`）。测试覆盖 revert 和 merge（`:396-432`）。未发现可绕过路径。
- **路径技巧**：记录目录带尾斜杠做前缀，改动路径再用 `^round-(\d+)/[a-z0-9][a-z0-9.-]*\.(?:md|stderr\.txt)$` 限制（`delegate.mjs:31`、`341-358`），子目录、`../`、`briefs/` 等都会被 `unexpected-file=` 拒绝。未发现路径逃逸。
- **符号链接 / 非普通文件 / 删除**：非删除改动必须是 `100644`，删除只允许 `.stderr.txt` 改名为 `.attempt-N.stderr.txt`（`delegate.mjs:260-273`）；测试覆盖符号链接和删除（`:360-394`）。已核实。
- **改旧账本 / 伪造记录**：`after.startsWith(before)` 加"追加行不得与已有行完全相同"（`delegate.mjs:274-293`）；记录字段与 task、文件、提示词摘要逐项核对（`:312-340`）。防误操作成立；账本内容本身仍被信任（文档已写明"防误操作，不防有意"）。
- **`--require-gateway` 是否可绕过**：`parseArgs` 在 `--gateway direct`/缺 gateway 时抛 `not-magpie`（`opencode-review.mjs:2617-2619`），`main` 在 `readGatewayConfig`、`resolveCommits`、读 brief、`installGateway` 之前检查 env/proxy（`:2866-2868`、`:2876`、`:2917`），子命令带它被 `ARG_NOT_FOR_SUBCOMMAND` 拒绝（`:2604-2605`），自检模式跳过代理检查（`:2503`）。已核实。恶意云端线程主动去掉参数不在防护范围内（文档写明的"防误操作"前提）。
- **不可撤销操作**：`--apply` 只合并 `check` 返回的提交号，且要求本地 HEAD 仍等于 tip（`delegate.mjs:373-378`、主流程 `:518`）。已核实。
- **prompt 注入**：任务说明里插值的 branch/tip/head/mode/models/providers/replyTo/brief 都有格式校验（`delegate.mjs:47-103`），brief 内容只作为路径出现，不会进入任务说明正文；材料本身对复核模型的注入是既有行为，不是这次新增。
- **资源耗尽**：见问题 2。
- **git 命令失败**：`check` 抛 `DELEGATE_GIT_FAILED`（退出码 2），测试覆盖不可达 origin（`review-delegate.test.mjs:577-583`）；`wait` 连续 3 次失败才抛（`delegate.mjs:397-406`）。已核实。
- **文档与代码一致**：除问题 1 指出的 `promptSha256` 矛盾外，delegate 一节的其余描述（退出码、`--apply`、服务方来源、控制字符、`estimated=true`、补跑规则）与代码一致。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本次改动不碰 `buildPrompt`、`reviewConfig`（系统提示/工具）和历史组装：`buildPrompt` 仍把固定说明放前面，`head/base/previous/brief` 这些每轮会变的值放在最后的 `material` 里（`opencode-review.mjs:282-305`）；发送给模型的仍是未遮盖的 `prompt`（`opencode-review.mjs:2992-3002`），遮盖只用于写进仓库的存档。delegate 生成的是给一个新云端会话的一次性任务说明，参数固定、无时间字段，逐字节可重复。结论：仍然只在末尾追加，每轮变化的值都在最后一条消息里。需要注意的只是：存档文件字节 ≠ 发出的字节，这一点本身不违反缓存规则，但正是问题 1 的成因。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
对"发给模型的请求"没有新增不确定性：遮盖不作用于发送内容，且 `maskSecretLike` 每次为规则新建 RegExp，结果对同一整段文字是确定的。记录侧存在两个表示不一致：账本哈希是未遮盖原文，仓库文件是遮盖后文本（问题 1）。另外 `private-key-any-block` 的 8000 字符前视意味着：如果将来把遮盖用于会被再次发送的跨轮内容，同一段开头可能因为后面的内容不同而遮成不同字节；目前它只用于完整记录，不影响模型请求字节。

**3. 有没有对应的自动检查，反向用例会不会失败？**
有：`review-gateway.test.mjs:201-247` 覆盖 `--require-gateway` 的 not-magpie/not-cloud/no-proxy/子命令反向用例；`review-delegate.test.mjs:123-199` 覆盖 prompt 字段校验和注入；`:200-823` 覆盖 check 的强推、改代码、改账本、符号链接、删除、控制字符、round/model/provider、补跑改名等；`:825-894` 覆盖 wait 的轮询、上限和 git 失败。问题在于：**遮盖 × `promptSha256` 这个新交互没有测试**，现有 fixture 的提示词是 `"prompt\n"`（`review-delegate.test.mjs:78,95`），永远不会被遮盖，所以这条回归不会被发现；一个含假密钥的 brief 用例会立刻失败。"九处改坏都失败"无法在本环境运行，未核实。

**4. 改动产生/修改的每个值，两端都能接受吗？**
- `promptSha256`：产出在 `opencode-review.mjs:3018`（未遮盖），`roundForRun` 已改成和遮盖后的重建提示词比（`:1613`），但 `delegate.mjs:335` 仍拿遮盖后的文件比未遮盖摘要 → **不接受，问题 1**。
- `gatewayRequiredProblem` 的 `not-cloud`/`no-proxy`：产出 `opencode-review.mjs:2502-2505`，使用于 `main:2866-2867`，文档与测试一致。
- `requireGateway`：产出 `parseArgs:2540`，使用于 `:2618`、`gatewayRequiredProblem:2503`、`main:2866`，一致。
- 账本字段 `mode/head/base/previous/round/model/gateway/providers/substitute/substituteFor`：产出 `opencode-review.mjs:3010-3037`、`:3082-3084`，使用 `delegate.mjs:312-340`、`:360-369`，两端校验一致（`none`/`unknown` 占位也另行放行）。
- `GATEWAY_JSON_PATH`：`delegate.mjs:30` 与 `gateway.mjs:30` 同一个值；合并后 `REVIEW_MODELS`、`parseArgs`、`parseUsage`、`nextRound`、`spentOf`、`resultLine`、`hasControlCharacter` 等导出的名字仍然存在，delegate 的导入没有因 main 的改动断掉。
- 服务方允许集合：`validateTask` 用本地当前 `gateway.json`、`checkResult` 用交出点 `gateway.json`，两个来源可能不一致 → 问题 5。
