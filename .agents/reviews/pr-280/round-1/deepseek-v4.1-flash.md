## 结论

改动方向对：新增的 Hermes 检查确实把“上线包里的验收探针 + 真实安装的候选运行时”连起来了，能拦住本次事故。但我读代码后发现 1 个中等资源/失败路径问题、1 个“文档说得比代码强”的问题，以及几个低严重度的校验缺口。作者的说法与代码基本一致，唯 `adapterSha256` 实际没有任何消费者校验。

---

## 读代码证实的问题

### 1. 严重度：中 — 新检查没有超时，也没有走生产的进程清理登记
**文件：** `scripts/delivery-mode/run-packet-checks.py:127`（整体 112-135）

**问题：** 直接 `subprocess.run` 跑验收探针，没有 `timeout`。探针里 `await host.result`（`probe-foreground.mjs:176`）如果一直不返回，整个出包检查会无限挂住。生产路径对同一探针用 cleanup helper 登记并设了 900 秒超时。

**证据：**
```python
127: result = subprocess.run(command, cwd=scratch, env=probe_environment, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=output, check=False, umask=0o022)
```
对比生产：
```python
59: registered_argv = ['/usr/bin/python3', '-I', str(cleanup_helper), '--run', '--owned-processes', ...]
60: result = subprocess.run(registered_argv, cwd=cwd or base, env=environment, ..., timeout=timeout)
```
探针自己的 `finally` 只删目录，不杀进程：
```js
356: } finally {
357:   await rm(root, { recursive: true, force: true });
```
**建议：** 给 `subprocess.run` 加超时并处理 `TimeoutExpired`，写明确失败码；最好复用生产同一套 cleanup helper 或在超时后主动清理沙箱子进程/命名空间。

### 2. 严重度：中/低（文档与代码不一致） — “缺少工具目录时检查失败”并不总成立
**文件：** `scripts/delivery-mode/run-packet-checks.py:98-104`、`docs/incidents-and-gates.md:119`（I-81）

**问题：** `pi_tools` 在给定目录后面拼了 `:/usr/bin:/bin`。传进来的目录为空或错误时，`bash`（必然存在）、`rg`、甚至系统已有的 `fd` 仍会被找到，检查继续跑；而生产的 `prepare-runtime-tools.py` 是固定用 `/usr/bin/bash`、`/usr/bin/rg`、下载并校验版本的 fd 10.5.0。I-81 写“缺少工具目录时检查失败”，测试也只覆盖“环境变量完全没设”。

**证据：**
```python
102: search = directory + ':/usr/bin:/bin'
103: found = {name: shutil.which(name, path=search) for name in ('bash', 'rg', 'fd')}
104: return found if all(found.values()) else None
```
```python
1204: self.assertIsNone(checks_runner.pi_tools({}))
```
生产对 fd 有版本检查：`prepare-runtime-tools.py:68` `if name == 'fd' and version != 'fd 10.5.0'`。

**建议：** 对 fd 只从给定目录解析（或校验版本/摘要），给定目录不存在直接失败；补一条“目录存在但缺 fd”的反向测试。I-81 的措辞改为实际行为。

### 3. 严重度：低 — `adapterSha256` 在主流程没有任何消费者校验；probe-source 副本也不会自动同步
**文件：** `scripts/delivery-mode/packet-template/acceptance/cloud/adaptation-manifest.json:11`

**问题：** 本次改了两个哈希。`sourceSha256` 会被 `make-packet.py:435-441` 的 `adapter_drift` 用 git 内容核对；但 `adapterSha256` 在整个仓库里只有 `basis-04/check-entry-paths-06.py:88` 校验它自己那份，主包的 `check-entry-paths-06.py`、`check-packet-consistency.py`、`run-network-preparation.py` 都不读它。因此这个值写错不会导致任何失败。另外 `acceptance/cloud/probe-source/packages/runtime-pi/scripts/probe-foreground.mjs` 不在 `r2l6-source-manifest.json` 里，`refresh_carried_copies` 不会自动从提交刷新它，本次是手工同步。

**证据：** `make-packet.py:435-441` 只比 `adapter['sourceSha256']`；`r2l6-source-manifest.json` 的 `files` 只有 5 项，没有该 probe-source 副本；`finalize-binding-inputs.py:161-163` 只是把包内副本按自己的哈希绑定，不与提交比较。

**建议：** 在主包一致性检查里加“manifest.adapterSha256 == 实际 adapter 文件哈希”；把 `probe-source/packages/runtime-pi/scripts/probe-foreground.mjs` 纳入某个与提交比对的清单（或新增一条比对规则）。

### 4. 严重度：低 — 报告校验过于宽松
**文件：** `scripts/delivery-mode/run-packet-checks.py:83-95`

**问题：** `report.get('reports', [])` 在 `reports` 缺失或为空时，`all(...)` 返回 True，命名空间检查被跳过；`reports` 不是列表时会抛 `AttributeError` 而不是干净的失败码；也没有要求 `len(reports) == expected`。

**证据：**
```python
93: if not all(row.get('namespaceState') == 'released' for row in report.get('reports', [])):
94:     return 'INSTALLED_PROBE_NAMESPACE_NOT_RELEASED'
```
**建议：** 校验 `isinstance(reports, list)` 且长度等于期望值，再逐项检查。

### 5. 严重度：低 — `binaries.mkdir` 没有 `exist_ok`
**文件：** `scripts/delivery-mode/run-packet-checks.py:123`

**问题：** 若将来候选运行时归档自带 `pi-tools/bin`，这里会 `FileExistsError` 直接崩掉检查。当前候选包显然没有该目录（否则作者在 Hermes 的那次运行就会失败），属于未来风险。

**证据：**
```python
123: binaries.mkdir(parents=True)
```
**建议：** 用 `exist_ok=True`，并明确已存在时是覆盖还是校验摘要。

### 6. 严重度：低（文档） — “按生产相同的环境变量”不严格
**文件：** `docs/incidents-and-gates.md:119` vs `run-network-preparation.py:50`、`run-packet-checks.py:126`

**问题：** 生产环境还设置了 `HIMAWARI_QUALIFY_INSTALLED_RUNTIME`，并通过 cleanup helper 启动；新检查没有这两个。探针本身不读该变量，所以对本次探针行为等价，但“相同环境变量”的表述不准确。

---

## 推测 / 未核实

- `sourceSha256: 86870af8…` 与 `adapterSha256: 45248cdd…` 我无法用允许的工具重算 SHA-256，**未核实数值本身**。不过 `sourceSha256` 错了会在出包时被 `adapter_drift` 硬拒绝；`adapterSha256` 错了不会被发现（见问题 3）。
- 作者所述 Hermes 结果（旧断言退出 1、新脚本退出 0、约 39 秒；`npm run check` 41 步、`build`、149 项测试）**未核实**，本环境不能运行它们。
- 若 Hermes 的 `/usr/bin` 存在 fd，传入错误 `piToolBin` 也不会失败；是否存在**未核实**。Ubuntu 通常装成 `fdfind`，所以实际大概率仍会失败。

---

## 侧重检查

- **错误路径：** 探针非零退出、无报告、非法 JSON、通过数不符、签发资格、命名空间未释放都能拦住（`run-packet-checks.py:82-95`、`129-134`）。缺 `reports` 的畸形报告可漏过（问题 4）。
- **不合规范/不可信输入：** 检查执行的是包内 JS，与既有 `NODE_FIXTURES` 同级信任；`expected_probe_count` 用正则读包内文本，格式一变会 `SystemExit`（失败关闭，可接受）。
- **安全：** 探针里的 `sk-abcdefghijklmnopqrstuv` 是拆开的假值，不是真实凭据；它会进入检查日志，但只是测试假数据。`--pi-tools` 传入的是主机路径，非秘密。
- **资源耗尽：** 无超时、无进程登记是本次最实际的风险（问题 1）。scratch 在 `finally` 删除，但用的是 `ignore_errors=True`。
- **不可撤销操作：** 只写 `/tmp/hXXXX` 和其中的安装前缀，不碰生产路径；探针失败时清理不彻底属于资源问题，不是生产破坏。
- **规则/文档一致性：** I-81 的检查名、计数、资格、命名空间、`--pi-tools` 描述基本准确；“缺少工具目录时检查失败”和“生产相同环境变量”两处偏强（问题 2、6）。
- **作者说法核对：** “三份改、basis-04 不改”确认；“两个哈希、INTENDED_CHANGES 加两个文件”确认；但 `adapterSha256` 没有消费者（问题 3）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动集中在 `docs/`、验收探针、出包脚本和测试；没有改系统提示、工具定义、历史消息、出口遮盖或请求组装。探针输出是验收证据，不进入模型请求。仍然只在末尾追加，符合 [prompt-prefix.md#rules](/.claude/rules/prompt-prefix.md#rules) 第 4、10 条。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会（对模型请求而言）。新增值是内容哈希、从静态正则读出的期望数 22；探针报告里的 `nodeVersion`、`toolDigests` 和日志里的耗时随环境变，但不发给模型。没有引入依赖前后文的遮盖。唯一随主机变化的是 `pi_tools` 从 `/usr/bin` 兜底带来的检查结果差异，但只影响出包门槛，不影响请求字节。

**3. 有没有自动检查，反向用例真的会失败吗？**
有，但不完整。`npm run check` 包含 `check:delivery-packet`（`package.json:27,43`），运行 `test_make_packet.py`；新增 `InstalledProbeCheckTest` 覆盖：只在 Hermes 计划、模板探针存在且计数为 22、干净报告通过、通过数不符、无/非法报告、资格为真、命名空间未释放、重复计数、工具查找、无工具目录时不安装、`make-packet.py` 传 `--pi-tools`。逻辑层面的反向用例会按预期失败。但“旧断言探针 + 新检查”这一真实反向只在 Hermes 手工验证，不在 `npm run check` 里；也没有“传了目录但目录缺 fd”的反向用例（问题 2）。

**4. 每个产生/修改的值的生产者和消费者是否匹配？**
- `sourceSha256`：生产在 manifest，消费在 `make-packet.py:435-441`，错误会硬拒绝，匹配。
- `adapterSha256`：生产在 manifest，主流程无消费者（只有 basis-04 自己校验），不匹配/无校验（问题 3）。
- `--pi-tools` / `HIMAWARI_PACKET_PI_TOOLS`：`make-packet.py:648` 用 `builder.json` 的 `piToolBin` 传入，`run-packet-checks.py:193,217-218` 接收，`pi_tools` 消费；缺变量会失败关闭，匹配（但有 `/usr/bin` 兜底，问题 2）。
- `INSTALLED_PROBE` 路径：计划里用它作检查名和文件路径，包内文件存在，匹配。
- 期望通过数 22：生产在 `run-network-preparation.py:164`，消费者是 `expected_probe_count`；测试硬编码模板等于 22。逻辑一致，但依赖正则精确匹配格式。
- `INTENDED_CHANGES` 两个新条目：由 `test_make_packet.py:327` 消费，匹配。模板里 `cloud-inputs.draft.json`、`OWNED-SHA256SUMS` 仍是旧哈希属正常，`make-packet.regenerate_hashes` 会在出包时重算；`question-12-inputs.json`、`carry-forward-audit.json` 也留着旧哈希，但主流程没有校验它们（已核对，属历史记录）。
