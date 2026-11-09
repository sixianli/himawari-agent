I'll start by examining the diffs at issue.
# PR 317 第 2 轮复核结论

## 摘要

安装的“先装到临时目录、校验后改名”对**冷 HOME 下的全新安装（`prefix` 尚不存在）是成立的**：两个进程各用独立 staging，输家改名失败时看到赢家的可执行文件就复用，不会互相删除。但**重装路径（缓存损坏）仍然直接 `rmSync(prefix)`**，与上一轮要解决的失败模式是同一个，只是窗口更窄；另外全新路径遇到“目录非空但没有可执行文件”的旧残留时无法自愈。新增用例只覆盖了冷启动竞争，未覆盖重装竞争和失败路径清理。

---

## 发现的问题（按严重度排序）

### 1. 中：重装路径仍会删除共享的正式缓存，并发时仍可能删掉别人刚装好的目录

文件：`scripts/model-review/opencode-review.mjs:462`

问题：作者说“重装路径同样走这条”，但重装分支在调用 `installBesideThenRename` 之前仍然直接删除共享的 `prefix`。这正是上一轮意见要消除的动作，只是发生在缓存损坏时。

证据（我亲自读到）：
```js
459:  const reused = existsSync(binary);
460:  if (!reused) installBesideThenRename(prefix, lockDir, binary, lock);
461:  let problems = installedIntegrityProblems(prefix, lock);
462:  if (problems.length > 0 && reused) {
463:    process.stderr.write(`OPENCODE_REINSTALL ${prefix} ${problems.join(" | ")}\n`);
464:    rmSync(prefix, { recursive: true, force: true });
465:    installBesideThenRename(prefix, lockDir, binary, lock);
```
两个进程同时判定“缓存损坏”时，若 A 已 `rmSync(prefix)` 并完成 staging、`renameSync` 就位，而 B 在 461→464 之间被调度延迟到 A 改名之后，B 的 `rmSync(prefix)` 会删掉 A 刚装好的目录；A 回到 466 重新做完整性检查就会看到 `installed-lock-missing` 而抛错。这仍是“一个进程删掉另一个进程的安装”。

建议：重装路径不要删除共享 `prefix`。用 `mkdir` 排他锁串行化同一 `prefix` 的安装；或把旧目录 `rename` 到唯一的 `.stale-<pid>-<rand>` 再装入 staging，成功后再删旧目录。另加一个覆盖重装路径并发的用例。

### 2. 中低：全新安装遇到“非空但没有可执行文件”的旧残留时无法自愈，且抛的是未归类错误

文件：`scripts/model-review/opencode-review.mjs:446`

问题：全新路径不再先清 `prefix`。若 `prefix` 目录存在（例如旧版本 `npmCi` 在 npm ci 中途被杀留下的非空目录）但没有 `node_modules/.bin/opencode`，则 `renameSync(staging, prefix)` 因目标非空失败，catch 里 `existsSync(binary)` 为假又原样抛出（通常是 `ENOTEMPTY`），staging 在 finally 被删掉，结果每次运行都失败，缓存永远修不好。旧实现 `npmCi` 开头有 `rmSync(prefix)`，不会这样。

证据：
```js
446:    try {
447:      renameSync(staging, prefix);
448:    } catch (error) {
449:      if (!existsSync(binary)) throw error;
450:    }
...
459:  const reused = existsSync(binary);
460:  if (!reused) installBesideThenRename(prefix, lockDir, binary, lock);
```
（`reused` 为假，所以即使 461 检出不完整，也不会进入 462 的重装分支。）

另外，这里抛出的原始 `ENOTEMPTY/EEXIST` 不属于文档和调用方认识的 `OPENCODE_INSTALL_FAILED`/`OPENCODE_INTEGRITY_MISMATCH`，测试里 `first.err.includes("OPENCODE_INSTALL_FAILED")` 也识别不到。

建议：在锁保护下，把无法复用的旧 `prefix` 原子移到一边（`rename` 到唯一旧名）再重试 `rename`，或在确认它没有可执行文件时清掉；同时把这类失败归一成现有错误码，并补“旧残留可自愈”的用例。

### 3. 低：进程被杀后遗留的 staging 目录没有清理机制

文件：`scripts/model-review/opencode-review.mjs:440`、`:452`

问题：`finally` 只在进程正常走到 finally 时清理 staging。CI/开发机上进程被 SIGKILL/OOM 杀掉时，`<prefix>.staging-<pid>-<rand>` 会永久留在 `~/.cache`，每个都是完整的 opencode 安装。反复失败会累积磁盘占用；没有任何启动时清扫旧 staging 的逻辑。

证据：
```js
440:  const staging = `${prefix}.staging-${process.pid}-${randomBytes(4).toString("hex")}`;
...
451:  } finally {
452:    rmSync(staging, { recursive: true, force: true });
453:  }
```
建议：安装前清扫同前缀下 pid 已不存在的 `.staging-*`（或超过一定时长的），或至少写进文档。

### 4. 低：新竞争用例只验证成功路径，未验证失败路径与重装路径；修前是否必失败未核实

文件：`test/tooling/opencode-review.test.mjs:971`

问题：用例只做“两个进程同时装同一新目录，都成功、只剩 `shared`”：
```js
999:      const [first, second] = await Promise.all([runOne(), runOne()]);
...
1005:      ]).toEqual([0, 0, false, false]);
...
1011:      expect(readdirSync(root)).toEqual(["shared"]);
```
它没有覆盖：重装路径并发、npm/完整性失败后是否留下 staging、上面第 2 条的旧残留自愈。也没有一个确定性的“反向”用例能证明改回旧实现必然失败（旧实现下两个 `npmCi` 会互相删除目录，理论上会失败，但依赖调度时序，不能保证每次都红）。

建议：用可注入的假 npm 或人为延迟 staging 的 rename，构造确定性时序；补重装并发用例；失败路径断言 `readdirSync(root)` 里没有任何 `.staging-`。

### 5. 低：I-77 文档把“延后 step_finish”的具体用例笼统算到两个文件

文件：`docs/incidents-and-gates.md:115`

问题：该行改成“`opencode-review.test.mjs` 和 `opencode-review-merge-gate.test.mjs` 里带 `[I-77]` 的用例：延后 `step_finish` 时……”。实际带 `[I-77]` 且做“把 `step_finish` 延后 1 秒”的两条核心用例只在 `test/tooling/opencode-review.test.mjs:1824/1849`；`merge-gate` 里的 `[I-77]` 是硬杀在途、追问、插件等，另有一个延后的追问调工具用例但并未带 `[I-77]` 标签。文档前后覆盖面没大错，但表述不够精确。

建议：写成“`opencode-review.test.mjs` 的延后 `step_finish` 用例，以及两个文件里其余 `[I-77]` 用例”。

---

## 读代码证实的 / 推测的分开说明

**读代码证实：**
- 全新安装路径每个进程使用独立 staging，校验 staging 后才 `renameSync`，`finally` 清理 staging；改名失败且共享 `binary` 已存在时复用（`opencode-review.mjs:439-453`）。
- 重装路径在 465 行之前仍执行 `rmSync(prefix)`（`:464`）。
- 完整性检查没有被新流程绕过：staging 装好后 `installedIntegrityProblems(staging, lock)` 校验，改名后 `installOpencode` 又对 `prefix` 再校验一次（`:443-445`、`:461`、`:466-469`）。
- 新竞争用例确实存在，位于 `test/tooling/opencode-review.test.mjs:971-1015`，两个测试文件都通过 `opencode-review.fixtures.mjs:141/165/237` 的 `opencodeBinary()` 使用同一个默认 `prefix`，因此 CI 里两个文件并行时竞争场景真实存在。
- `.agents/instructions/model-review.md:95/99`、`docs/incidents-and-gates.md:108/115/125` 的测试文件指向与代码核对：[I-77]、[OpenCode 401] 在两个文件中都有；I-86 相关用例确实在 `opencode-review-merge-gate.test.mjs`（`record-secret-like`、`record-unreadable`、`maskSecretLike` 等）。

**推测（未运行、无法在本次约束下核实）：**
- 第 1 条需要 B 在 461→464 之间被延迟到 A 完成改名，窗口窄，发生概率低，但代码路径确实存在。
- 第 2 条的旧残留状态来自“旧版本 npm ci 中途被杀”这类场景，本次没有现场复现。
- 新用例在修改前是否必然失败：按旧代码 `npmCi` 先 `rmSync(prefix)` 推断大概率失败，但依赖时序，未核实。
- 作者说 Hermes 上测试通过：材料中没有可直接核对的运行结果，未核实。

---

## 侧重检查

- **错误路径**：staging 的 `finally` 清理正确；完整性失败、npm 失败都会走到 finally。但重装失败会先丢掉旧缓存（`:464` 在安装之前），且旧残留无法自愈（第 2 条）。
- **不合规范/不可信输入**：`prefix` 来自 `homedir()` + 固定摘要，`lockDir` 来自模块路径，staging 名只用 `process.pid` 与 `randomBytes(4)`，没有外部可控输入进入路径拼接，未见路径穿越问题。
- **安全**：安装仍使用提交的锁文件与 `npm ci`；完整性只核对 npm 的 `.package-lock.json` 元数据、不重算磁盘文件摘要，这是 `model-review.md:81` 已写明的既有局限，不是本次引入，也没有被改名流程绕过。错误信息只含路径/包名，不含密钥。
- **资源耗尽**：冷 HOME 下两个进程各跑一次完整 `npm ci`（而不是共享一次），网络/磁盘峰值翻倍；被 SIGKILL 时遗留的 staging 没有清理（第 3 条）。
- **不可撤销操作**：重装路径的 `rmSync(prefix)` 是不可撤销地删除共享缓存，且可能影响正在使用该二进制运行的另一进程（第 1 条）。
- **规则/文档与代码一致**：测试文件位置基本核对一致（I-76/I-77/I-86 指向的文件确实存在相应用例）；I-77 描述有一处不精确（第 5 条）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本 PR 自己的改动只改 `installOpencode`/`installBesideThenRename` 的本地安装步骤、测试和文档文字；`installOpencode` 返回的仍是可执行文件路径，未触碰 `buildPrompt`、`reviewConfig`、系统提示、工具定义、历史或遮盖。`staging` 路径里的 pid/随机数只用于文件系统操作，不进入任何请求。文档 `.agents/instructions/model-review.md` 是复核问题来源，但 `questionsSource` 默认取 base 提交（`opencode-review.mjs:1082` 附近），且一次复核运行内提示词只构建一次、追问只在末尾追加，因此不存在“改历史/改请求头”。（注意：`07d0bf75..HEAD` 的 diff 还夹带 main 合入的 `opencodeChildEnv`、`englishMessages`、`REFUSAL_PATTERNS` 等，不属于本 PR 自有改动，我未将其纳入本次结论，但就代码看它们也不改写提示词内容。）

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。新增的 `staging` 路径含 `process.pid` 和随机数，但只在本机文件系统使用；既不入提示词，也不写入 `usage.jsonl`/记录文件。错误消息里可能出现 staging 路径，但错误文本不会发给模型或持久化为记录内容。其余安装逻辑是确定性的。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有新增用例（`opencode-review.test.mjs:971`），覆盖“两个进程同时装同一新目录，都成功且不残留 staging”。但它不是严格的反向用例：没有覆盖重装路径并发、失败路径清理、旧残留自愈；“改回旧代码必然失败”只是按旧 `npmCi` 先 `rmSync(prefix)` 的推断，未运行核实，且时序依赖。建议补确定性故障注入用例。

**4. 每个新产生的值，使用它的地方都能接受吗？**
- `staging` 路径：产生于 `:440`，被 `npmCi`、`installedIntegrityProblems`、`renameSync`、`rmSync` 使用，均为通用路径，无额外校验要求。
- `prefix`/`binary`：`installOpencode` 仍返回 `binary`，`main` 的 `runOpencode` 契约不变；`opencodeInstallDir` 未改。
- 错误码：新增路径可能抛出原始 `ENOTEMPTY`，调用方和文档只认识 `OPENCODE_INSTALL_FAILED`/`OPENCODE_INTEGRITY_MISMATCH`，存在两端不一致（见第 2 条）。
- 文档中的测试文件/用例名：与仓库里实际存在的 `[I-77]`、`[OpenCode 401]`、I-86 用例基本能对上；I-77 描述略有出入（见第 5 条）。
- 没有新增配置键、清单项或序列化格式。
