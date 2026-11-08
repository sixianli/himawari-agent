# PR 266 第 10 轮复核结论

## 结论摘要

合并结果与作者描述一致：相对 main 只多了 `check:probe-sources`（及它的脚本/记录/测试），相对上一轮只多了 main 的 39 步和两处冲突的正确合并；**没有发现高严重度问题**，没有丢步骤、没有丢断言，`check:probe-sources` 的位置不影响其它步骤。下面列出中低严重度的接线/覆盖面问题。

---

## 问题清单（按严重度）

### 1. 中：新门槛的接线断言只核对“名字存在”，不核对命令内容
- 文件:行：`test/tooling/run-all-checks.test.mjs:54`（对比 `:55-64`）；`package.json:37`
- 问题：main 那段循环对 5 个上线测试命令都断言了**命令原文**，但本分支对 `check:probe-sources` 只断言 `toContain`。若以后有人把该脚本定义改成 `true`/空命令，`check:probe-sources` 就不再运行真正的检查与其测试，而 `run-all-checks.test.mjs` 仍然通过；`probe-sources.test.mjs` 只由这条命令在 `npm run check` 里点名运行，因此这道新门槛可以被静默关闭而没有测试失败。
- 证据（亲自读到）：
  - `test/tooling/run-all-checks.test.mjs:54`：`expect(names).toContain("check:probe-sources");`
  - 同文件 `:55-64`：`for (const [name, file] of [...]) { expect(names).toContain(name); expect(manifest.scripts[name], name).toBe(\`python3 -I scripts/delivery-mode/${file}\`); }`
  - `package.json:37`：`"check:probe-sources": "node scripts/check-probe-sources.mjs && vitest run ... test/tooling/probe-sources.test.mjs"`
- 建议：在 `run-all-checks.test.mjs` 里对 `check:probe-sources` 也断言完整命令原文（和 main 的写法一致）。这正是 main 上 `831db506 接线断言核对命令内容` 修过的那类问题。

### 2. 低：只更新记录的源码指纹即可让门槛通过，构建指纹仍可能是旧的
- 文件:行：`scripts/check-probe-sources.mjs:106-124`
- 问题：检查只核对「记录.sourceSha256 == 当前源码哈希」「记录.builtSha256 == bootstrap 里的指纹」。开发者改源码后，只要重新算一遍 `sourceSha256` 写进记录，不动 `bootstrap` 的旧构建指纹，检查就通过，而 I-79 的 `PROBE_DIGEST_STALE` 仍会在 Hermes 生成包时才暴露。
- 证据（亲自读到）：
  - `scripts/check-probe-sources.mjs:107`：`if (recorded.get(file.built) !== file.builtSha256) ...`
  - `:120-124`：`const actual = sha256(source.bytes); if (actual !== file.sourceSha256) ...`
  - 两处之间没有任何“源码哈希 → 构建指纹”的绑定。
- 说明：I-79 的「未覆盖」已明确承认这一点，所以这是**已声明的残余风险**，不是隐藏缺陷。
- 建议（可选）：在记录里增加构建来源（提交/构建机/构建时间或构建指纹的出处），或让 CI/Hermes 的构建步骤反向生成记录，减少“只改一半”的通过路径。

### 3. 低：`check:probe-sources` 不检查 bootstrap 的 `replace()` 锚点，文档“未覆盖”未提到
- 文件:行：`scripts/check-probe-sources.mjs:54-75`
- 问题：`bootstrapDigests` 只解析 `originals` 块，不检查 `replace("旧锚点", ...)` 的锚点是否仍能在构建产物中命中。若只改锚点文本而不改源码，这道 PR 门槛会通过，仍要靠 Hermes 上的 `check-packet-consistency.py`（`PROBE_ANCHOR_COUNT`）才发现，属于同一种“等到打补丁包才发现”的延迟。I-79 的「未覆盖」只写了编译设置/手工改记录，没写锚点。
- 证据（亲自读到）：
  - `scripts/check-probe-sources.mjs:57-58` 只定位 `const originals = {` / `};`
  - `:62-73` 只解析指纹条目，全文没有 `replace(` 相关逻辑
  - `scripts/delivery-mode/packet-template/inputs/check-packet-consistency.py:121-124` 才有锚点计数检查
- 建议：要么在文档「未覆盖」补一句锚点也要等上线包检查；要么把锚点计数也搬进 PR 检查（需要构建产物，成本更高）。

### 4. 低/信息：测试未固定完整的 40 步清单
- 文件:行：`test/tooling/run-all-checks.test.mjs:52-66`；`package.json:27`
- 问题：测试只断言若干关键名字存在且都是字符串，不校验完整集合。若以后误删 `check:settings-scope` 这类无关步骤，测试不会失败。对你这次关心的“合并有没有丢步骤”，只能靠人工核对；我核对的结果是没有丢（见下）。
- 证据（亲自读到）：`check:steps`（`package.json:27`）共 40 个 `npm run` 段，逐一计数无重复；与 main 的 39 步相比，唯一的“新增”是 `check:srt-version` 后插入的 `check:probe-sources`。
- 建议：如要保持门槛强度，可把 40 步的完整期望列表写进测试。

### 5. 信息/推测：源码哈希按原始字节计算，CRLF 检出会误报
- 文件:行：`scripts/check-probe-sources.mjs:120`
- 问题：`sha256(source.bytes)` 直接对工作区字节哈希；若某台开发机 `core.autocrlf` 把 `.ts` 检出成 CRLF，会误报 `PROBE_SOURCE_CHANGED`。Bootstrap 的解析做了 `\r\n→\n` 归一化（`:55`），源码哈希没有。
- 证据：`:55` 有归一化，`:120` 没有。
- 说明：这是推测，未在 CRLF 环境实测；项目主要在 Mac/Linux（LF）上开发，风险低。

---

## 读代码证实 vs 推测

**读代码证实**
- 合并的两个父提交确为 `894cb9cb` 与 `bc380a6e`（`git show -s --format='%H %P'`）。
- `894cb..269d` 的代码改动只有 `package.json`、`test/tooling/run-all-checks.test.mjs`、以及 main 带来的 `test_rollback.py`、`artifact.test.mjs`（外加评审记录文件）。
- `check:steps` 40 段、无重复；相对 main 只多了 `check:probe-sources`（插在 `check:srt-version` 之后）；相对上一轮只多了 main 的 delivery 四步。
- `run-all-checks.test.mjs` 同时保留了 `check:probe-sources` 断言和 main 的 5 命令循环（`:54`、`:55-64`）。
- `probe-sources.json` 里三个 `builtSha256` 与 `bootstrap.mjs` 的 `originals` 完全一致；source 路径与 built 名一一对应。
- `run-release-walkthrough.sh:23` 新增的 `[[ -f "$source/package.json" ]] || fail "SOURCE_TREE_EMPTY $source" 3` 在 `--preflight` 分支之前；测试 `test_make_packet.py:787-793` 删掉 `package.json` 后断言退出码 3 与 `SOURCE_TREE_EMPTY`。
- `check-incident-gates.mjs` 的路径正则要求带 `/`，新行引用的 `scripts/...`、`test/...` 路径都存在，`package.json` 这种单词不会被误当成门槛文件。

**推测（未实测）**
- 作者“Hermes 上 40 步全过（CHECK_ALL_PASSED 40 steps）”无法在本环境运行验证。
- 三个 `sourceSha256` 是否真的等于当前源码（不能用非允许命令算哈希），只能依赖 `probe-sources.test.mjs` 的“仓库原样通过”用例和作者说法。
- CRLF 误报、TOCTOU（`lstat` 后 `readFileSync`）属于理论风险，未构造环境验证。

---

## 侧重检查

- **错误路径**：记录缺失/不可读/JSON 坏、bootstrap 缺失/不可读/无 `originals` 块/空块、源码缺失/不可读/是目录/被 `..` 或绝对路径指向、bootstrap 条目重复/在块外/名字或摘要格式不合法，都有独立错误码和对应测试（`probe-sources.test.mjs` 覆盖约 20 个反向用例）。预检缺 `package.json` 返回 3。结论：错误路径完整，未见崩溃或静默通过。
- **不规范/不可信输入**：记录字段做严格类型/正则/路径常量约束（`recordProblems`），`source` 必须等于 `packages/runtime-sandbox/src/<built 改名>.ts`，拒绝 `..`、绝对路径、目录、符号链接（`lstatSync(...).isFile()`）；`JSON.parse` 有 try/catch。bootstrap 解析是正则启发式，但块内任何“像条目但不是合法条目”的行都会被 `PROBE_BOOTSTRAP_ENTRY_FORMAT` 拦下。结论：未发现可注入或越界读取。
- **安全**：新脚本只读 `fs`、`crypto`、`path`，不联网、不执行外部命令、记录里无密钥；Hermes 预检只做 `git rev-parse` 和 `-f` 判断。结论：无新增攻击面。
- **资源耗尽**：只读几个仓库内小文件，无网络/无递归遍历用户数据；测试临时目录用 `mkdtemp` 且 `afterEach` 清理。结论：无新增资源风险。
- **不可撤销操作**：新增逻辑均为只读；预检放在构建之前，作用是**减少**浪费的构建。结论：无新增不可撤销操作。
- **规则/文档/代码一致性**：I-79 三种错误码与代码一致；I-80 的检查顺序与 `run-release-walkthrough.sh:17-23` 一致，且“只查 `package.json` 一个文件”与实现一致。唯一发现的文档遗漏是第 3 条的锚点未覆盖。

---

## 作者说法逐条核对

| 说法 | 核对结果 |
|---|---|
| 增量只有合并 main（#271 的 4 个测试接进 check） | 属实。`894cb..269d` 代码改动仅 package.json、run-all-checks.test.mjs 和 main 带来的 test_rollback.py、artifact.test.mjs |
| 冲突只两处 | 属实；`git diff --name-status` 中分支真正改过的只有这两处被合并 |
| package.json 取 main 的 39 步 + 放回 probe-sources，共 40、无重复 | 属实；人工计数 40，且相对 main 只多 `check:probe-sources` |
| run-all-checks.test.mjs 保留两边断言 | 属实（`:54` 与 `:55-64`） |
| 没丢任何一边的步骤/断言 | 属实（人工逐项核对；测试未固定全量清单，见问题 4） |
| probe-sources 位置不影响别的步骤 | 属实；它是只读、独立步骤，runner 会跑完所有步骤（`scripts/run-all-checks.mjs:14-27`），位置只影响输出顺序 |
| 40 步全过 | 未核实（本环境不能运行 npm） |

---

## 必答问题

**1. 会不会改变模型已见过的请求开头？**
不会。改动的文件是 `docs/incidents-and-gates.md`、`package.json`、`scripts/check-probe-sources.mjs`、`scripts/delivery-mode/probe-sources.json`、`scripts/delivery-mode/hermes/run-release-walkthrough.sh`、`scripts/delivery-mode/test_make_packet.py`、`test/tooling/*`，没有系统提示、工具定义、历史消息、遮盖代码或提示词目录的改动。发给模型的内容仍只在末尾追加，每轮会变的值没有被搬到前面（`prompt-prefix.md` 的约束未被触碰）。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。新增的 `Set`/`Map` 只用于错误诊断，不参与任何模型请求或历史序列化；记录 JSON 顺序固定，没有时间/随机/无序集合进入模型输入。遮盖逻辑完全未动。

**3. 有没有自动检查，反向用例真的会失败吗？**
有，且反向用例是真实的：`probe-sources.test.mjs` 的 `[probe-digest-stale]` 等用错误输入断言具体错误码；`test_make_packet.py:787-793` 针对 `SOURCE_TREE_EMPTY`；`run-all-checks.test.mjs` 保证新步骤在 `check:steps` 里。**但**接线只断言名字（问题 1），若命令被改成 no-op，相关测试不会失败——这是本 PR 最值得补的自动检查缺口。

**4. 每个产生/消费的值两端都能接受吗？**
基本能。逐个核对：
- `probe-sources.json` 的 `bootstrap`/`files[].built`/`builtSha256`/`source`/`sourceSha256`：生产者是手工记录，消费者只有 `check-probe-sources.mjs`（严格校验）；其 `built` 名与 `bootstrap.mjs` 的 `originals` 键、以及 `check-packet-consistency.py` 的 `[a-z-]+\.js` + `[0-9a-f]{64}` 正则一致，三个 `builtSha256` 与 bootstrap 逐字相同。
- `check:probe-sources` 配置键：`run-all-checks.mjs` 的 `stepNames` 接受，`run-all-checks.test.mjs` 断言存在。
- `SOURCE_TREE_EMPTY` + 退出码 3：`make-packet.py` 的预检把非零视为预检失败，测试断言 3，两端一致。
- main 带来的 `check:delivery-*` 键与 `python3 -I scripts/delivery-mode/<file>` 命令：文件都存在，测试逐字核对命令，两端一致。
未发现两端校验不一致的值。

---

## 未核实

- 无法运行 `npm run check`，故“Hermes 上 40 步全过”未独立验证。
- 无法计算 SHA-256，故 `probe-sources.json` 的 `sourceSha256` 与当前源码是否匹配未独立验证（仅有测试用例和作者说法）。
- CRLF 检出误报、`lstat`/`read` 之间的 TOCTOU 未构造环境实测。
