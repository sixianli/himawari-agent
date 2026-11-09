# 复核结论（PR 317 第 3 轮）

核对范围：`git diff a5ad7bd..c1c7385`（本 PR 净改动）和 `git diff 03c4476..c1c7385`（第 2 轮之后的增量）。`03c4476..c1c7385` 里混进来的 `registeredTestValues` 等是 main（PR 322，`a5ad7bd` 已含）带来的，净 diff 里没有，不计入本 PR。

## 侧重检查

- **错误路径**：`installBesideThenRename` 的第一次 `renameSync` 失败、`rmSync` 失败、第二次 `renameSync` 失败、`npm ci` 失败都逐个走过。第一次失败后的第二次 rename 没有兜底，见问题 1。
- **并发/误删**：`existsSync(binary)` 与 `rmSync(prefix)` 之间有 TOCTOU 窗口；单进程顺序执行不会误删，并发自愈同一残留目录时会，见问题 1。
- **完整性检查**：staging 在 rename 前由 `installedIntegrityProblems(staging, lock)` 校验，rename 后又由 `installOpencode` 再校验一次，**没有绕过**（`opencode-review.mjs:442-445、463-472`）。`installedIntegrityProblems` 只遍历已安装条目、查不出“少了某个包”，但这是改动前就有的口径，不是本轮引入。
- **不可信输入/安全**：`prefix` 是 `opencodeInstallDir()` 算出来的缓存目录，测试里才传任意路径；`rmSync(..., {recursive:true, force:true})` 删除的是可重建缓存，单进程顺序下不删有可执行文件的目录。gitleaks 白名单限定了规则、路径、值三段，见问题 2、3。
- **资源耗尽**：被 `SIGKILL` 杀掉的安装会留下完整 `<prefix>.staging-*`，没有启动清理，见问题 5；正常路径 `finally` 会删除 staging。
- **规则/文档一致**：`docs/incidents-and-gates.md` 的 I-77 新写法与 `opencode-review.test.mjs:1840,1865`、`opencode-review-merge-gate.test.mjs:284` 的用例位置一致；`.agents/instructions/model-review.md:81` 没写“有残留但没可执行文件”也会自愈，但不与代码矛盾。`round-2/judgments.md` 在稀疏检出里不存在、`git show` 又被记录路径规则拒掉，**其内容未核实**。

## 问题（按严重度）

### 1. 中【读代码证实】并发自愈可能删掉另一个进程刚装好的目录，第二次 rename 仍可能抛 ENOTEMPTY
`scripts/model-review/opencode-review.mjs:446-453`

```js
    try {
      renameSync(staging, prefix);
    } catch (error) {
      if (!existsSync(binary)) {
        rmSync(prefix, { recursive: true, force: true });
        renameSync(staging, prefix);
      }
    }
```

两个进程同时启动、缓存目录都是“非空且没有可执行文件”的残留时：两边第一次 rename 都失败；两边都可能看到 `existsSync(binary)===false`；A 先 `rmSync(prefix)` 并 rename 成功，B 随后仍按刚才的判断 `rmSync(prefix)`，把 A 刚装好的目录删掉；此时 A 的 `installedIntegrityProblems(prefix, ...)` 可能读到目录已不存在而抛 `OPENCODE_INTEGRITY_MISMATCH`，或者正在跑的自检/复核找不到二进制。若 B 再 rename 时 A 又换回来了，第二次 `renameSync` 仍会以 `ENOTEMPTY` 抛出（这个错误没有兜底）。作者已把“补重装并发用例”判成“可以更好，不改”，但这条是第 3 轮新加删除路径带来的破坏性窗口。

建议：给缓存目录加一把 `O_EXCL` 互斥锁（或至少删完后再 `existsSync(binary)` 重新判断，并在第二次 rename 失败时若 binary 已存在就接受），不要让两个进程同时对共享缓存做删+rename。

### 2. 低【读代码证实】新 gitleaks 白名单没有端到端用例，“只放行那一种形式”只在 JS 正则层验证
`test/tooling/gitleaks-allowlist.test.mjs:106-111`、`test/tooling/gitleaks-config.test.mjs:66-92`

新反例只把手构造的样例交给 `new RegExp` 测：

```js
        ["-----BEGIN", "PRIVATE KEY----- $", '{"说明".repeat(5000)}']
          .join(" ")
          .replace("$ {", "${"),
```

但真正要证明的是 gitleaks 会遮住提交 `206eb64e` 第 514 行的命中（我已在该提交确认原文是 ``const lone = `[已遮盖:private-key-header] ${"说明".repeat(5000)}`;``），而 `gitleaks-config.test.mjs` 的 `FIXTURES`（66-92 行）没有 `test/tooling/opencode-review-merge-gate.test.mjs`，参数化的“放宽就失败”用例（233 行起）也没有这条白名单。实际端到端验证只依赖作者在 Hermes 上跑的 `npm run check:gitleaks`（`scripts/check-gitleaks.mjs` 确实扫真实历史并读 `ci/rules/gitleaks.toml`），我没法在这里运行。

建议：在 `gitleaks-config.test.mjs` 的 `FIXTURES` 加这一行，加入 expected 被抑制的清单，并补一条把该白名单路径放宽到 `test/tooling/.*\.test\.mjs` 时必须失败的用例。

### 3. 低【读代码证实】新白名单值没有结尾锚点，比“只那一种形式”宽
`ci/rules/gitleaks.toml:124`

```toml
regexes = ['''^[已遮盖:private-key-header] \$\{"说明"\.repeat\(5000\)\}''']
```

只有 `^` 没有 `$`。如果这段假开头后面再跟真正的密钥正文，`regexTarget = "secret"` 的匹配仍会命中而整条放行。已有的几条（108、116、124 行）也是同样写法，属于沿袭；但本轮新加的这一条仍值得收紧。

建议：在末尾加 `$`（或至少锚定到实际 secret 的完整形状），与测试里“同长度别的值不放行”的意图保持一致。

### 4. 低【推测，未运行 lint】`catch (error)` 的 `error` 已不再使用，可能违反 lint
`scripts/model-review/opencode-review.mjs:448`

`error` 现在在 catch 块里完全没被引用。仓库大量位置用无绑定的 `catch {`（例如 `scripts/check-gitleaks.mjs:53`、`scripts/model-review/opencode-review.mjs:112/355/408`），biome 推荐规则里的 `noUnusedVariables` 有可能报未使用绑定。作者只说“测试和格式检查通过”，没提 lint。

建议：改成 `} catch {`。这条需要实际跑 `npm run lint` 才能从“推测”升级为“证实”。

### 5. 低【读代码证实】被强杀的安装会永久留下完整的 `<prefix>.staging-*` 目录
`scripts/model-review/opencode-review.mjs:440、454-455`

staging 名字带 `process.pid` 和随机串，唯一清理点是本进程的 `finally`；`SIGKILL`/断电时不执行，之后也没有任何启动扫描清掉旧的 `.staging-*`。每个残留都是一整份 `node_modules`，反复失败会占满 `~/.cache`。第 2 轮已判“可以更好，不改”，这里按资源耗尽侧重记录。

建议：安装前扫掉同一 prefix 下过期的 `.staging-*`，或把 staging 放进一个固定子目录并在加锁后清理。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会（本 PR 净改动）。`a5ad7bd..c1c7385` 只改了 `installBesideThenRename/installOpencode`、测试、`ci/rules/gitleaks.toml`、`ci/toolchain-lock.json`、文档；`buildPrompt`、系统提示、工具定义、历史消息拼装都没动。`opencodeBinary()` 在 `main()` 里构建提示词之后才调用，安装的 `npm` 输出只走 `stderr`，不进提示词。发给模型的内容仍遵循“只在末尾追加”，本改动不涉及最后一条消息之外的内容。
需要提醒：`03c4476..c1c7385` 这个增量里能看到 main 的 `registeredTestValues` 遮盖，但它已在基准 `a5ad7bd` 里，不属于本 PR；而且它只改存档/账本里的遮盖结果，不改发给模型的原文。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
本 PR 不会：安装路径只影响文件系统（staging 名含 pid/随机数，但不进模型文本），gitleaks/文档也不参与请求拼装。
补充：main 的 `registeredTestValues` 虽然把值排序（`setRegisteredTestValues`）保证“同一集合同一顺序同一字节”，但集合来自 `base/head/origin/main` 的 `gitleaks.toml`，不同运行可能遮出不同字节——那是 main 的既有行为，不是本轮改动，且只作用于存档而不作用于模型输入。

**3. 有没有对应自动检查，反向用例真的会失败吗？**
- 安装：有新增用例 `opencode-review.test.mjs:1017-1031`；按代码推断，撤回本轮 catch 里的删除分支后，Linux 上 `renameSync` 目标非空会 `ENOTEMPTY`，用例会失败（作者称在 Hermes 上验证过，我无法运行）。用例还断言 `readdirSync(root) === ["shared"]`，能挡住成功路径的半成品；但没覆盖“第二次 rename 失败”和“并发下有可执行文件时不删”的反向场景。
- gitleaks：有 JS 正则层的正反用例（`gitleaks-allowlist.test.mjs:74-81、106-111` 及计数 15），但缺 gitleaks 真实扫描的端到端用例；真正的反向依赖 CI 的 `check:gitleaks`（作者称 `blocking=0`，我未运行）。
- 文档：I-77 只是文字修正，行为由 `--report`/账本测试间接覆盖。

**4. 每个值两端都能接受吗？**
- 新 allowlist 块（`gitleaks.toml:118-124`）：gitleaks 端是合法 Go 正则且有 `condition=AND`、`targetRules=["private-key"]`、路径限定到该测试文件、`regexTarget="secret"`；测试端 `gitleaks-allowlist.test.mjs` 的实际块数为 18、`scoped` 为 15，新块对应 `scoped[11]`，索引与样例数组一致，反向变异能失败。两端可接受。唯一缺口是问题 2 的端到端用例。
- `ci/toolchain-lock.json` 的 `gitleaks.toml` sha256：消费端 `scripts/ci/install-tools.mjs:321` 会重算比对；摘要与规则文件在同一提交（748e7d1）更新，但**数值未核实**（此处不能运行 sha256）。
- 新安装路径的 `prefix/staging/binary`：`installOpencode`、`opencodeBinary()` 和测试都传目录路径，`rmSync/renameSync/existsSync` 都接受；没有调用方依赖“prefix 永不删除”。
- 文档 I-77 文案：与 `opencode-review.test.mjs:1840,1865`、`opencode-review-merge-gate.test.mjs:284` 的 `[I-77]` 用例位置一致；`gitleaks-allowlist.test.mjs` 的 `toHaveLength(15)` 与 TOML 的 18 块减去前 3 块一致。
- `.agents/reviews/pr-317/round-2/judgments.md`：不在稀疏检出里、`git show` 被记录路径规则拒绝，**未核实**。
