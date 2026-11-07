## 结论

这个增量本身没有发现高、中严重度问题。第 4 轮指出的“提交号不一致掩盖真正原因”确实已修好，改后的测试会精确锁定拒绝原因，反向失效也能被断言抓住。主要缺口是反向验证只在 Hermes 上人工做过，仓库里没有可重复证据；另外若干说法因 sparse checkout 或无法执行而无法在本环境复核。

## 读代码证实的事项

- 旧版确实会因提交号不一致而“顺带”失败。`git diff e087c03..HEAD` 显示旧用例用 `generated_records()`（默认 `COMMIT = 'b' * 40`，`test_deploy.py:15`）覆盖磁盘记录；而 `DeployHarness.setUp()` 先把三处提交号改成真实 git commit（`test_deploy.py:284-291`），覆盖后 `packet-checks.json.commit` 与 `packet-parameters.json.COMMIT`、`bindings.json.testedCommit` 不一致，`generated-packet-gate.py:26-28` 会报 `PACKET_COMMIT_MISMATCH`。
- 新版改为读磁盘记录：`record = json.loads(path.read_text())`（`test_deploy.py:561`），不再退回常量提交号。
- 新版先断言完整记录无问题：`self.assertEqual(gate.problems(self.packet), [])`（`test_deploy.py:562`）。而 `generated-packet-gate.py:32` 的 `required` 来自 `plan(..., True, migrating)`，`run-packet-checks.py:158` 在该分支加入 `INSTALLED_PROBE`；因此这条断言同时隐含证明了记录里确实有该检查项。
- 删除项使用生产常量：`run-packet-checks.py:34` 定义 `INSTALLED_PROBE = 'acceptance/cloud/adapters/probe-foreground.mjs'`，`test_deploy.py:559` 加载同一常量，`:563` 按它删除。
- 断言消息格式与实现一致：`generated-packet-gate.py:36` 是 `'PACKET_CHECK_NOT_PASSED ' + name + ' ' + json.dumps(results.get(name))`；缺项时 `results.get(name)` 为 `None`，`json.dumps(None)` 为 `'null'`，所以 `test_deploy.py:565` 的期望字符串精确匹配。`record['passed']` 仍为 `True`，不会额外触发 `PACKET_CHECKS_FAILED`（`generated-packet-gate.py:37-38`）。
- 部署路径也核对过：`deploy.sh:54-57` 在脚本检查、验收检查之前运行 gate，失败即 `result not-generated PACKET 6`，因此 `test_deploy.py:566-567` 的 `(6, 'not-generated', [])` 是可达且无服务端调用的。
- 真实包记录确实带 `commit`：`make-packet.py:655-660` 的 `fetch_checks` 会把 `commit`（以及 `host`、`checkedAt`）写进 `packet-checks.json`，所以测试构造的字段与生产一致。
- 该文件之外，`e087c03..HEAD` 只改了第 4 轮复核记录和 `usage.jsonl`，没有改任何请求组装代码。

## 推测 / 未核实

- “在 Hermes 上把 gate 的必需检查逻辑改成不检查，该用例失败”：从静态逻辑看会失败——若 gate 不再要求该检查，删项后 `gate.problems` 返回 `[]`，与 `test_deploy.py:565` 的非空期望不符；若生产者 `plan()` 删掉该检查，setUp 记录也不含它，同样与期望不符。但本环境不能运行测试或 SSH，实际失败未核实。
- “恢复后 `test_make_packet` + `test_deploy` 153 项通过”：未核实（无法执行）。
- `.agents/reviews/pr-280/round-4/*`：当前是 sparse checkout（`git status` 显示 93% 文件在场），这些文件不在工作区；`git diff` 受 records-path 规则拒绝，因此前四轮原话与我是否一致未核实。
- 旧包场景是“当前完整记录删一项”的模拟，而不是真正旧版本生成的记录（旧 schema、旧检查集合）。对本次要验证的 gate 分支足够，但不是端到端旧包回放。

## 侧重检查

- 错误路径：缺 `packet-parameters.json`、缺 `packet-checks.json`、提交号不一致、schema 不一致、必需检查缺项、`passed != true`，分别对应 `generated-packet-gate.py:19-38` 的不同返回；新测试覆盖的是“缺一个必需检查项”这条，且用精确列表排除其它原因混入。
- 不可信/不规范输入：gate 用 `json.loads` 读冻结包里的 JSON；测试改写的 JSON 仍是合法结构，只删一个列表项，没有引入异常形状。
- 资源耗尽：测试在临时目录运行，`TemporaryDirectory.cleanup()` 回收；gate 失败在 `deploy.sh:54`，不会进入安装/验收等重资源步骤。
- 不可撤销操作：失败发生在任何 `S*` 服务端步骤之前，断言 `calls == []`；lock 由 `deploy.sh:47` 的 trap 清理，没有触达真实主机。
- 安全：无秘密写入；提交号、检查名、错误串都不含敏感信息；测试不联网。
- 规则/文档一致性：增量是测试文件，未改提示词、模型请求或文档；`.claude/rules/prompt-prefix.md` 与 `AGENTS.md:40-43` 的“只追加”规则未被触碰，也没有产生新的不一致。

## 必答问题

1. **不会改变模型已见过的请求开头。** 本次增量只改 `scripts/delivery-mode/test_deploy.py` 和复核记录，不涉及系统提示、工具定义、历史消息、遮盖或压缩代码；发给模型的内容仍由原来的组装路径决定，仍只在末尾追加，每轮会变的值仍只在最后一条消息里。依据 [.claude/rules/prompt-prefix.md#rules](/private/var/folders/l2/yz2r8t351wn81jsl2zv3nnsh0000gn/T/opencode-review-FDRoq7/repo/.claude/rules/prompt-prefix.md:31) 第 1、2、4 条。
2. **不会让同一段文字在不同请求里变成不同字节。** 增量不生成模型输入；它产生的只有临时目录里的测试 JSON，内容来自确定性夹具，删除操作保持列表顺序，未加入时间、随机或无序集合。真实包的 `checkedAt` 是出包记录字段，不属于模型请求，也不在本次改动里。
3. **有对应的自动检查，反向用例逻辑上会失败。** 新用例 `test_deploy.py:557-567` 同时验证“完整记录通过”和“删除必需检查后精确拒绝”，并跑到真实 `deploy.sh` 的 code 6 路径；若 gate 不再要求该检查，`:565` 的精确断言会失败。反向验证目前只是作者在 Hermes 上的人工操作，未入库、本环境无法复现，建议把该证据写进提交说明或在仓库内加一个可重复的反向测试。
4. **本次增量产生/修改的值，使用方都能接受。**
   - 检查名 `installed_probe`：产生于 `run-packet-checks.py:34`，被 `plan()`（`:158`）用作清单项的 `name`，测试 `:559` 取同一常量、`:563` 按它删除、`:565` 用同一名字构造期望；两端一致。
   - 拒绝消息 `PACKET_CHECK_NOT_PASSED <name> null`：由 `generated-packet-gate.py:36` 产生，唯一使用方就是测试 `:565`；格式逐字一致，`null` 来自 `json.dumps(None)`。
   - 修改后的 `packet-checks.json`：消费方是 `generated-packet-gate.py:24,33-36`；删除一项只让 `results` 查不到该名字，`commit`、`currentSchema`、`targetSchema`、`passed` 均保持合法，因此只报缺项，不会混入提交号或 schema 错误。
