## 总体判断

改动方向正确：把“列出后消失”的文件按 0 字节计，确实是验收采样的竞态修复。未发现会改变模型请求开头或线上升级清单的高危问题。有三处低风险问题：目录遍历错误仍会被吞掉、第二条反向用例的证明力不足、子树消失时 `scratchPeakBytes` 会静默偏小。以下未实际运行测试或上线检查，涉及“会通过/失败”的结论均为读代码推断。

### 1. 低 — `os.walk` 仍会吞掉目录列举错误，“其他读取错误仍然失败”只对文件大小读取成立

文件:行：`scripts/delivery-mode/packet-template/acceptance/cloud/run-stage-03.py:66-67`、`scripts/delivery-mode/test_make_packet.py:1469-1474`、`docs/incidents-and-gates.md:142`

问题：`directory_bytes` 调用 `os.walk(directory, followlinks=False)`，没有传 `onerror`。Python 的 `os.walk` 在 `onerror` 为 `None` 时会静默忽略子目录 `scandir` 的错误。`file_bytes` 只把文件 `lstat` 的 `FileNotFoundError` 按 0 计；子目录在遍历时不可读或消失，不会进入 `resources.errors`。测试只给 `Path.lstat` 打了 `PermissionError`，没有覆盖目录列举错误。

证据（读代码证实）：
- `run-stage-03.py:66-67`：`os.walk(directory, followlinks=False)`，没有错误回调。
- `run-stage-03.py:60-64`：只捕获 `FileNotFoundError`。
- `test_make_packet.py:1472-1474`：只 patch `Path.lstat`，所以“其他读取错误”实际只验证了文件级读取错误。

建议：给 `os.walk` 传 `onerror`，对 `FileNotFoundError` 继续忽略以保留竞态修复，对其他 `OSError` 重新抛出；同时加一条“子目录列举时报 `PermissionError`”的用例。若有意忽略所有目录列举错误，则把 I-107 的“其他读取错误仍然失败”改成“其他文件大小读取错误仍然失败”。

### 2. 低 — “修复前两条都失败”不能证明第二条反向用例

文件:行：`scripts/delivery-mode/test_make_packet.py:1445-1451`、`1454-1474`

问题：`sampling_functions` 先断言源码里同时存在 `file_bytes` 和 `directory_bytes`。修复前源码里没有 `file_bytes`，两条测试都在这个断言处失败；但第二条要验证的行为是“`PermissionError` 仍然抛出”，旧实现的 `(Path(parent) / name).lstat()` 本来就会抛出 `PermissionError`。也就是说，如果提取器允许缺少 `file_bytes`，第二条测试在旧实现上会通过。它是有价值的防回归守卫，但不是“修复前失败、修复后通过”的行为回归证明。

证据（读代码证实）：
- `test_make_packet.py:1447-1449`：`wanted = {'file_bytes', 'directory_bytes'}`，随后断言两者都存在。
- 旧实现见 diff 的删除行：`sum((Path(parent) / name).lstat().st_size for ...)`，没有捕获异常。

建议：把提取器改成“只取存在的函数”，或另写一条直接对旧写法断言 `PermissionError` 的测试；事故清单中把第二条描述为“防止以后把其他错误也吞掉的守卫”，不要写成修复前失败的反向证据。

### 3. 低 — 整棵子树消失时 `scratchPeakBytes` 会静默偏小；目前没有门槛消费它

文件:行：`scripts/delivery-mode/packet-template/acceptance/cloud/run-stage-03.py:60-67`、`79`、`147-149`、`209`

问题：现在所有 `FileNotFoundError` 都返回 0。如果整个 `node-compile-cache` 一类子目录在遍历中消失，`os.walk` 会跳过它，`scratchPeakBytes` 被低估且 `resourceSamplingErrors` 为空。整个 `scratch` 根目录被删不会被放过：最终 `scratch.lstat()` 会抛错并写入 `runnerErrors`。但“子目录整体消失”只影响统计值。

证据（读代码证实）：
- `run-stage-03.py:79`：`scratchBytes` 只在 `self.scratch.exists()` 时统计，否则直接写 0。
- `run-stage-03.py:147-149`：最终校验 `scratch.lstat()` 的身份，根目录消失会使验收失败。
- 全仓库检索 `scratchPeakBytes`：只出现在验收报告、S6 读回、Hermes 演练记录和 `cloud-seal`/`S9` 对 `resourceSamplingErrors` 的检查中，没有和磁盘门槛比较。因此目前不会因低估而“越过磁盘门槛”。
- 推测（未来风险）：如果以后拿 `scratchPeakBytes` 做磁盘门槛，静默低估会变成真实问题。

建议：在 `resources.jsonl` 或 `run-report.json` 记录“因消失而跳过”的条目数；在 I-107 里写明“根目录消失由最终 `lstat` 检出，子目录消失只影响统计”。若不想增加字段，至少在事故条目里明确这是已知取舍。

## 侧重检查

- 错误路径：`file_bytes` 只吞 `FileNotFoundError`，其他异常继续抛出（`run-stage-03.py:60-64`）；最终采样 `resources.stop()` 的异常仍会进入 `resources.errors` 并导致 `RESOURCE_SAMPLING_FAILED...`（`run-stage-03.py:176-184`）。目录列举错误是漏洞，见意见 1。
- 不可信输入：`directory_bytes` 的调用方是已验证的 `scratch` 和 `evidence`；`os.walk(followlinks=False)`，文件用 `lstat`，没有新增跟随符号链接的路径。未发现新的路径穿越或权限问题。
- 安全：改动没有引入密钥、网络、子进程或权限提升；只影响验收证据统计。
- 资源耗尽：每个文件仍然是一次 `lstat`，没有新增循环或缓存；消失文件返回 0 反而减少了异常。但会低估峰值，见意见 3。
- 不可撤销操作：采样不再因单文件消失而失败时，验收可能继续走到 `shutil.rmtree(scratch)`；这只在验收本身通过后发生（`run-stage-03.py:186-199`），且 scratch 根身份在删除前仍被校验。子目录消失不会把失败的验收变成通过。
- 规则/文档一致性：改动没有触碰提示词、工具定义、历史或遮盖代码；I-107 的“其他读取错误仍然失败”与 `os.walk` 的实际行为不完全一致，见意见 1；“修复前两条都失败”的证明力不足，见意见 2。
- 未核实：没有运行 `test_make_packet.py`、`npm run check` 或 `verify-packet-consistency`；没有生产证据文件；仓库外是否有工具读取 `question-12-inputs.json` 的内层摘要未查。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只在 `scripts/delivery-mode/` 的验收脚本、测试和事故文档中，没有修改系统提示、工具定义、历史消息、遮盖逻辑，也没有把 `scratchBytes`/`run-report` 写入任何模型请求。这个改动不涉及“发给模型的内容只追加”，因此原有约束保持；新增的会变值 `scratchBytes` 只写入验收证据，不进入请求。模型请求开头仍然只在末尾追加，这个改动没有破坏它。

2. **会不会让同一段文字在不同请求里变成不同的字节？** 对模型请求不会：没有新的模型请求内容。对出包渲染也不会：`regenerate_hashes` 按文件内容计算摘要，结果由文件字节决定，不依赖时间或无序集合。运行时的 `scratchBytes` 会因采样时机和文件竞态而不同，但它只出现在 `resources.jsonl` 和 `run-report.json`，不是模型请求或提示词的一部分。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有：`AcceptanceScratchSamplingTest` 两条测试，位于 `scripts/delivery-mode/test_make_packet.py:1444-1474`；`package.json:53` 的 `check:delivery-packet` 会运行它，且 `check:steps` 包含 `check:delivery-packet`。第一条反向用例在旧实现上会因 `FileNotFoundError` 失败，能证明修复；第二条在旧实现上本应通过，只是因为新增的 `file_bytes` 让提取断言先失败，证明力不足，见意见 2。目录级错误没有用例，见意见 1。我没有实际运行测试。

4. **每个改动值的产生方和使用方是否匹配？**
   - `file_bytes` 的返回值是整数：只被 `directory_bytes` 求和使用，没有格式或范围校验，调用方接受普通整数。
   - `directory_bytes` 的返回值：用于 `Resources.sample` 的 `scratchBytes` 和 `intentionallyRetainedEvidenceBytes`，最终写成 JSON 数字，没有其他校验。
   - `INTENDED_CHANGES` 新增 `acceptance/cloud/run-stage-03.py`：唯一使用方是 `test_make_packet.py:327` 的集合比较；该文件确实与第十二次冻结版本不同，所以从代码看应匹配（未运行）。
   - `cloud-inputs.draft.json` 和 `acceptance/OWNED-SHA256SUMS` 内的摘要：由 `make-packet.py:631-645` 的 `regenerate_hashes` 在 `assemble` 和 `freeze` 中重新计算（`make-packet.py:924`、`953`）；`run-stage-03.py` 启动时的 `manifest['files']` 校验、`check-entry-paths-06.py`、`finalize-cloud-inputs.py`、`check-packet-consistency.py:38-43,82-92` 都按最终文件字节比较，能接受更新后的值。
   - `verify-packet-consistency.py` 的 `accepts the current packet` 应接受重新生成摘要的最终包；`edited_listed_script` 仍会因 `run-stage-03.py` 被改而报 `CLOUD_INPUT_DIGEST_STALE run-stage-03.py`（`verify-packet-consistency.py:91-96`，`check-packet-consistency.py:38-43`）。未实际运行。
   - `basis-04/run-stage-03.py` 是独立保留的 basis-04 快照，有自己的 inventory 和 manifest；本次没有更新它，从 `basis-04-inventory.json` 看它是历史保留件，不需要同步。
   - `fixtures/twelfth-frozen-sha256.json` 是有意的旧基线，`run-stage-03.py` 的旧摘要留在其中，靠 `INTENDED_CHANGES` 放行。
   - `question-12-inputs.json` 内层 `files["run-stage-03.py"]` 是 `a3acc6...`，既不等于旧模板的 `91b912...` 也不等于本次的新值；它在本次改动前就已经不匹配。我没有找到当前代码读取这个内层 `files` 的地方（只有 basis-04 的同名文件被 basis-04 自己的检查读取），仓库外是否使用未核实。
