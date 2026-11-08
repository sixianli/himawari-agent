## 复核结论

### 发现的问题（按严重度）

#### 1. 中｜`scripts/delivery-mode/test_deploy.py:557-563`｜新反向用例会因为“提交号不一致”而不是“缺已安装探测检查”而通过

问题：这个用例想证明“记录里缺 `acceptance/cloud/adapters/probe-foreground.mjs` 这一项的旧包会被 `deploy.sh` 拒绝”，但它写给磁盘的 `packet-checks.json` 里 `commit` 是模块常量 `'b'*40`，而测试装置早已把磁盘上的 `packet-parameters.json`、`packet-checks.json` 和 `bindings.json` 改成了临时 git 仓库的真实提交号。于是 `generated-packet-gate.py` 先报 `PACKET_COMMIT_MISMATCH`，用这个原因就让 `deploy.sh` 以 6 退出。即使把 `generated-packet-gate.py:32-36` 那段“必须列出全部检查项”的逻辑删掉，这个用例仍然会通过。

证据（本人读到的代码）：

- `test_deploy.py:15`：`COMMIT = 'b' * 40`
- `test_deploy.py:30-35`：
  ```python
  def generated_records(commit=COMMIT, failed=()):
      ...
      record = {'passed': not failed, 'commit': commit, ...}
  ```
- `test_deploy.py:261-268`：setUp 先用 `generated_records()` 写入，随后 `self.commit = self.commit_checkout(root)`。
- `test_deploy.py:284-290`：`commit_checkout` 把 `bindings.json` 的 `candidate.testedCommit` 和 `packet-parameters.json` / `packet-checks.json` 的 `commit` 都改成真实的临时提交号。
- `test_deploy.py:557-563`：新用例又调用一次 `generated_records()`，只把 `record` 写回 `packet-checks.json`，`record['commit']` 因此退回 `'b'*40`。
- `generated-packet-gate.py:27-28`：
  ```python
  if parameters.get('COMMIT') != commit or record.get('commit') != commit:
      found.append('PACKET_COMMIT_MISMATCH ...')
  ```
- `generated-packet-gate.py:32-36`：缺项本来也会被 `PACKET_CHECK_NOT_PASSED` 拦下（这证明产品行为本身是对的）。

结论：被复核的行为（缺这一项会被拒）确实成立，但新用例没有单独证明它；这是“反向用例不会因为目标逻辑被移除而失败”的情形，正好违反必答问题 3。

建议：不要用 `generated_records()` 的新副本覆盖已修正提交号的记录。改为基于磁盘上已由 `commit_checkout` 修好的记录删除该项，或显式 `record['commit'] = self.commit` 并同步 `packet-parameters.json` 的 `COMMIT`。同时断言拒绝原因，例如直接调用 `generated-packet-gate.problems(...)` 或捕获 stderr，要求包含 `PACKET_CHECK_NOT_PASSED acceptance/cloud/adapters/probe-foreground.mjs`，这样提交号、schema 等其它原因不会顶替目标原因。

#### 2. 低｜`scripts/delivery-mode/test_deploy.py:559`｜检查名写死，未用 `checks_runner.INSTALLED_PROBE`

问题：用例把 `'acceptance/cloud/adapters/probe-foreground.mjs'` 写成字面量，而生产代码在 `run-packet-checks.py:34` 用 `INSTALLED_PROBE` 常量产生同名项。名字一旦变化，过滤会删不到任何项，用例会在 `len(...) - 1` 断言上失败（会暴露，不会静默），但定位不如直接用常量清楚。

证据：`test_deploy.py:559` 的字面量；`run-packet-checks.py:34` 的 `INSTALLED_PROBE = 'acceptance/cloud/adapters/probe-foreground.mjs'`。

建议：改用 `generated_records` 模块（或导入 `run-packet-checks.py`）里的 `INSTALLED_PROBE`，与产生端共用同一个值。

### 推测（未读代码证实）

- 无。上述第 1 条的两端（写记录、读记录）都已读到。

---

## 侧重检查

- 错误路径：新用例只测 `deploy.sh` 的 `not-generated`（退出码 6）路径；但正如第 1 条，触发原因被提交号不一致掩盖，无法区分是目标错误还是别的错误。
- 不合规范/不可信输入：本轮增量是测试，不接收外部输入；`generated_records()` 读取的 `run-packet-checks.plan` 是本地受控模块。
- 安全：无新增密钥、无网络、无权限变更。
- 资源耗尽：`DeployHarness` 每个用例建临时目录并在 `tearDown` 清理；新用例无额外长任务、无子进程泄漏。
- 不可撤销操作：新用例不接触生产，`deploy.sh` 在 gate 阶段失败，`cleanup before` 尚未执行，`calls == []` 断言正确对应“服务器上什么都没做”。
- 规则/文档一致性：`docs/incidents-and-gates.md` 的 I-81 与产品行为（`generated-packet-gate.py` 会因缺项拒绝）一致；但新用例的名字“checked before the installed probe existed”描述的是旧包，实际构造的是“新记录删一项”，与第 1 条同源。
- 未核实：按本轮要求只审了 `e087c03b` 相对 `fbac0836` 的增量，未重新逐行审阅 900 秒超时、`--pi-tools`、报告行数、`adapterSha256` 测试和 I-81 全文（这些属于前几轮改动）。

---

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。本增量只改 `scripts/delivery-mode/test_deploy.py`（及复核记录文件），不触碰系统提示、工具定义、历史消息或遮盖。整个 PR 里与模型相关的探针是独立的验收脚本（`packages/runtime-pi/scripts/probe-foreground.mjs`），它自己 import Node 模块、向 stdout 打一行 JSON，未出现在 `packages/**.ts` 的模型请求组装路径中，也不是 Pi 适配器。所以发给模型的内容仍只在末尾追加，每轮会变的值没有进入请求头部。依据 prompt-prefix 规则第二、一节。
2. **同一段文字会不会在不同请求里变成不同字节？** 本轮增量不产生发给模型的文本。探针报告含 `platform`、`nodeVersion`、`toolDigests` 等随主机变化的值，但那是验收报告，不进入模型请求。因此对模型侧确定性无影响。
3. **有没有对应的自动检查，反向用例真会失败吗？** 有：`npm run check` 通过 `check:delivery-packet`、`check:delivery-deploy` 分别运行 `test_make_packet.py`、`test_deploy.py`，出包时 `run-packet-checks.py` 还会在 Hermes 上真跑探测。但本轮新增的反向用例**不能**保证“缺项”这一目标逻辑被移除时失败（见发现 1），只会在“探测项从 plan 名单里消失”时失败。这是一个真实的测试有效性缺口。
4. **改动产生或修改的每个值，两端是否都能接受？** 本轮没有新增生产值；它引用的是 `plan()` 产生的检查名和 `generated-packet-gate.py` 的 `required` 名单，二者由同一 `run-packet-checks.plan()` 计算，生产端是一致的（`generated-packet-gate.py:32` 重新调用 `plan(..., True, migrating)`）。唯一不一致是测试里手写的字面量（发现 2）。更广范围的值（`adaptation-manifest.json` 的 `adapterSha256`、`sourceSha256`）在前几轮已由 `test_every_adapter_hash_...` 与 `adapter_drift` 覆盖，本轮未复核其次要细节。
