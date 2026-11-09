## 结论

本轮只看 `aff8e4ee` 相对 `1f16c11b` 的增量：`scripts/model-review/opencode-review.mjs` 的 `probeRefused`/`REFUSAL_PATTERNS`、`test/tooling/opencode-review.test.mjs` 的一条用例，以及第 4 轮记录。三种拒绝来源与三条模式基本对得上，对五条 allowed 探针也不会再被提交说明误伤。**没有发现会放过真实拒绝（fail-open）的缺陷**；发现的是测试覆盖缺口、locale/路径健壮性、一个残余误判面和一处作者说法与代码不一致。

## 问题（按严重度从高到低）

### 1. 中：正向模式只用手写字符串验证，没有把真实 `bash -r` / git 替身的输出回灌给 `probeRefused`
- 文件:行：`test/tooling/opencode-review.test.mjs:751-801`，`scripts/model-review/opencode-review.mjs:2006-2015`
- 问题：新用例的「应判为被拒」全部是手写字符串（`test:752`、`test:756`、`test:766`）。真实 `bash -r` 只在另一个用例里被验证成 `.toContain("restricted")`，从未调用 `probeRefused`：
  - `test/tooling/opencode-review.test.mjs:1046-1048`：`expect(viaShell(...).text).toContain(GIT_REFUSED)` / `.toContain("restricted")` / `.toContain("restricted")`。
  - 也就是说，如果真实报错的前缀变了（locale、shell 路径带空格、不同 bash 版本），单测仍会通过，只有花真钱前的完整自检才会暴露，而完整自检依赖已安装的 opencode 和网关。
- 证据：
  - `scripts/model-review/opencode-review.mjs:2009`：`/^\S+: (line \d+: )?[^\n]*: restricted/`
  - `test/tooling/opencode-review.test.mjs:756`：`output: "/bin/bash: line 1: f: restricted: cannot redirect output"`（固定样例，不是实际运行的输出）
- 建议：在 `installGitGuard` 的集成用例里，把 `viaShell("git log -1 --oneline > written.txt")` 和 `viaShell("cd …")` 的**实际 stdout+stderr** 传给 `probeRefused(...)` 并断言为 `true`；同时把真实 `git show --stat HEAD`、`git blame -L 1,1 -- <文件>`、`git status --short` 的输出断言为 `false`。这比继续加手写字符串更能守住「形状」。

### 2. 低：`bash -r` 的 `restricted` 受语言环境影响，guard shell 没有强制 `LC_ALL=C`
- 文件:行：`scripts/model-review/opencode-review.mjs:649-658`（wrapper）、`571-579`（环境白名单含 `LANG`/`LC_ALL`/`LC_CTYPE`）、`2009`（英文模式）
- 问题：`opencodeEnv` 原样保留 `LANG`、`LC_ALL`、`LC_CTYPE`，而 guard shell 只是：
  ```js
  `exec ${JSON.stringify(realBash)} -r "$@"`,
  ```
  没有设置 `LC_ALL=C`。bash 的报错经 gettext 本地化后可能不再包含英文 `restricted`，导致真正的 `bash -r` 拒绝被判成「没被拒」。
- 后果：写/读探针会报 `PROBE_NOT_REFUSED`（`opencode-review.mjs:2085`），整轮复核起不来；是 **fail-closed**，不是安全漏洞。且旧实现同样依赖英文 `": restricted"`，这不是本轮引入的回归。
- 建议：wrapper 改为 `exec env LC_ALL=C ${JSON.stringify(realBash)} -r "$@"`（同时不要让 locale 影响判据），并在上述集成用例里固定 locale 跑一遍。
- 类似残余：`realBash` 路径若含空格（`^\S+:` 要求前缀无空格）也会漏判；虽然 `command -v bash` 通常是 `/bin/bash`，建议一并考虑。

### 3. 低（残余误判，非本轮引入）：未缩进的提交元数据行仍可能被第三条模式命中
- 文件:行：`scripts/model-review/opencode-review.mjs:2009`
- 问题：只有提交**说明**缩进四格；`git show --stat HEAD` 的 `Author:` 行从列 0 开始。若 PR 提交的作者名被构造成 `x: restricted`，则会打印出
  `Author: x: restricted <…>`，第三条模式
  `/^\S+: (line \d+: )?[^\n]*: restricted/`
  会命中（`^\S+:` 匹配 `Author:`，`[^\n]*` 匹配 `x`，再匹配 `: restricted`），于是 allowed 探针被误判为被拒（`PROBE_READ_COMMAND_BLOCKED`，`opencode-review.mjs:2079-2080`），复核无法启动。
- 证据：正则本身如上；`git show` 的 `Author:` 行不带缩进是 git 的公开输出格式（本仓库 fixture 未实测这一点，标注为推测的输出形状）。作者名由提交者控制，属于不可信输入。
- 说明：旧版 `refusalCandidateLines` 只过滤空白开头行，再 `includes(": restricted")`，同样会命中，所以**不是回归**。但这说明「按真正打印出来的形状做精确匹配」对提交元数据仍不精确。
- 建议：把第三条限定为 shell 程序前缀（例如 `(?:^|/)[^\s/]*bash: …`），或对写/读探针改成「退出码 + 目标文件不存在/副本无改动 + 已知拒绝来源」分类，不要单靠整行文本。

### 4. 低（说法与代码不一致）：作者说该用例「六个断言」，实际是 9 个 `expect`，本轮只新增 4 个
- 文件:行：`test/tooling/opencode-review.test.mjs:751-801`；提交说明 `aff8e4ee` 也写「那条用例现在六个断言」。
- 证据：该 `it("counts only an explicit refusal as refused")` 内共有 9 个 `expect`（`752`、`753`、`759`、`760`、`763`、`769`、`783`、`789`、`795`）。本轮 diff 实际只新增 4 个：1 个 opencode 话术正向（`763-768`）+ 3 个 `--oneline` 反例（`783-801`）。「正向三条 + 反向三条 + 缩进一条」是 7 条，也对不上 9 条。
- 影响：不改变代码正确性，但属于材料与代码不一致，容易被下一轮当成事实引用。

## 读代码证实的 / 推测的

**读代码证实：**
- 本轮增量确实只有 `opencode-review.mjs`、测试和 round-4 记录（`git show --stat aff8e4ee`）。
- 三种拒绝来源与模式对得上：
  - git 替身：`opencode-review.mjs:638` `process.stderr.write([GIT_REFUSED, problem].join(" ") + "\n")`；`checkGitArgs` 只在有问题时返回非空字符串（`544-558`），因此 `^REVIEW_GIT_REFUSED \S`（`2008`）成立。
  - `bash -r`：用例里的真实形状是 `/bin/bash: line 1: f: restricted: cannot redirect output`（`test:756`），`^\S+: (line \d+: )?[^\n]*: restricted` 能命中；`cd` 的 `bash: cd: …: restricted` 也能命中。
  - opencode 权限拒绝：本环境里实际出现的报错就是列 0 开头的 `The user has specified a rule which prevents you from using this specific tool call…`，`^The user has specified a rule which prevents you`（`2007`）能命中。
- 五条 allowed 探针（`opencode-review.mjs:1741-1745`）的输出形状：`--oneline` 以短哈希+空格开头、`git diff --stat` 行以空格或数字开头、`git show --stat` 说明缩进四格、`blame` 以哈希开头、`status --short` 以状态码开头；三条模式不会命中这些正常行（`Author:` 例外见问题 3）。
- 被删除的 `REFUSAL_TEXTS` / `refusalCandidateLines` 全仓库无其他引用；测试的 import（`test:19-72`）不含这两个名字，只 import `GIT_REFUSED`、`probeRefused`（`33`、`62`）。
- `probeRefused` 仅被 `checkProbeRequests` 使用（`2079`、`2085`），不参与任何发给模型的提示词构造。
- R4-2/R4-3 的代码事实与提交说明里的纠正一致：
  - `scripts/check-incident-gates.mjs:27` 比较表头列；`:32` 只解构前 7 列，数据行多出来的列被忽略。
  - `scripts/check-markdown-tables.mjs:8` `const SCANNED_DIRECTORIES = ["docs"]`，不扫 `.agents/`，所以 `files=403 errors=0` 对 `.agents/` 下的表格没有证据力。

**推测 / 未核实：**
- 问题 3 中「作者名含 `x: restricted` 会让 `git show --stat` 的 `Author:` 行命中」是按 git 输出格式推断，未在本仓库实际构造提交验证；攻击收益是让复核起不来（DoS），不是绕过沙箱。
- 若 opencode 对 stderr 逐行加前缀（例如 `[stderr] …`）或把 stdout/stderr 无换行拼接，行首锚定的模式会漏判；当前 fixture（`test/tooling/fixtures/opencode-review/glm-events.jsonl`）只展示成功命令的原始输出，无法证实/证伪。
- 未核实（工具不能运行测试）：本轮真实运行 `SELF_CHECK_OK`、「164 条全过」、`biome format`/`biome lint` 的结果。
- 第 4 轮记录 `.agents/reviews/pr-312/round-4/judgments.md`、`verdicts.jsonl` 在本检出中不存在（`read` 返回 File not found；`.agents/**` 未展开），且 git 访问 `.agents/reviews/**` 被 `REVIEW_GIT_REFUSED records-path` 拦住，**读不到，未据其下结论**；只能核对提交说明里转述的 R4-2/R4-3，并已用脚本源码验证其与代码一致。

## 侧重检查

- **错误路径**：无关失败（`/bin/bash: f: No such file or directory`）仍判 `false`（`test:760-762`），不会把普通错误当成拒绝；三种真实拒绝源逐条对照了产生处（`638`、`test:756`、本环境实见的权限话术）。结论：正确。
- **不可信输入**：提交标题/说明来自被复核的 PR。新的行首锚定已挡住 `--oneline` 标题和缩进说明这两个主要来源；未缩进的 `Author:`/签名元数据仍可构造命中（问题 3，非本轮引入）。结论：主要面已修，仍有残余。
- **安全 / fail-open**：allowed 探针除文本外还要求 `call.status === "completed"`（`2079`），真实被拒一定 status 非 completed，故 allowed 方向不会因文本漏判而放行；write/read 探针漏判只会得到 `PROBE_NOT_REFUSED`（`2085`），自检失败，属 fail-closed。唯一理论上的 fail-open 是「本应被拒却成功执行、且输出恰好以拒绝字样开头」；写探针成功时 stdout 基本为空，读探针还有 marker/leak 兜底（`2082`）且副本已用 sparse-checkout 排除 `.agents/reviews`（`2358`）。结论：未发现实际可用的绕过。
- **资源耗尽**：三条正则无嵌套量词，`[^\n]*: restricted` 单字面量回溯是线性的；`split("\n")` 逐行匹配，输入来自固定的几条只读 git 命令，不构成 ReDoS/内存风险。
- **不可撤销操作**：本轮改动只改判定函数和测试，不新增写文件、删除、提交、推送等操作。
- **规则/文档与代码一致**：`.agents/instructions/model-review.md:87`「只认 opencode 的权限拒绝、git 替身的 `REVIEW_GIT_REFUSED` 和受限 bash 的 `restricted` 三种文字」与代码三条模式一致；`:90` 关于复合命令由 opencode 按片段判权限的说法，与本环境实际拒绝 `git show … | grep …` 的现象一致。R4-2/R4-3 的代码事实见上。`.claude/rules/prompt-prefix.md` 不受本改动影响。

## 必答问题

1. **不会改变模型已经见过的请求开头。** `probeRefused` 只在自检里由 `checkProbeRequests` 调用（`opencode-review.mjs:2079`、`2085`），不进入 `buildPrompt`、系统提示、工具定义、历史或遮盖；本轮 diff 也没碰这些路径。发给模型的内容仍是固定前缀，变化值只在末尾追加，符合 [prompt-prefix 第 4、10 条](../../.claude/rules/prompt-prefix.md#rules)。
2. **不会让同一段文字在不同请求里变成不同字节。** 新判据是编译期常量正则（`2006-2010`），不依赖时间、随机数或前后文，也没有 `g`/`y` 导致的 `lastIndex` 状态；同一段文字每次判定结果相同。自检里的 `randomBytes` marker 是既有逻辑，且不进模型请求的开头。
3. **有自动检查，反向用例确实会失败。** 新用例覆盖了 `--oneline` 形状的三个反例（`test:783-801`）和缩进说明反例（`769-782`）；若还原成第 2 次的「只在不缩进的行里做子串匹配」，`--oneline` 的 `REVIEW_GIT_REFUSED` 用例必然返回 `true`，对 `expected false` 报 `expected true to be false`，这一点由代码可直接证实。缺口是「真实 `bash -r`/真实 allowed 输出回灌」没有自动检查（问题 1）。
4. **两端都接受。** 产生的值只有 `REFUSAL_PATTERNS` 和 `probeRefused` 的布尔结果：生产端在 `opencode-review.mjs:2006-2015`，消费端是 `2079`/`2085` 和测试 `752-801`，都期望布尔/正则，没有序列化或跨模块契约。被删的 `REFUSAL_TEXTS`、`refusalCandidateLines` 全仓库无其他引用（测试 import 也没有），不会出现「一端删了、另一端还在用」的 I-73 式错配。R4-2/R4-3 转述的纠正与 `check-incident-gates.mjs:27,32`、`check-markdown-tables.mjs:8` 一致；但第 4 轮记录文件本身在本检出中读不到，未核实其原文。
