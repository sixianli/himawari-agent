## 上一轮意见核对（增量 `0be5e8e1..281835ded`，实际为提交 `281835ded`）

- **意见 1（清理 helper 摘要）已改好。** `make-packet.py:643` 在 `regenerate_hashes` 里重算 `cleanupHelper.sha256`，`assemble`（`:932`）和 `freeze`（`:961`）都会走到；`check-packet-consistency.py:45-50` 增加了出包检查，`verify-packet-consistency.py:68-70,102` 增加了反向用例，`test_make_packet.py:425-440` 增加了两条测试。补充一点措辞：S6 的 `run-stage-03.py:34-35` 实际抛 `CLEANUP_HELPER_CHANGED`，`BOUND_CLEANUP_HELPER_CHANGED` 是 `finalize-cloud-inputs.py:67-68`，两处读的是同一个清单字段，这次都被覆盖。
- **意见 2（非采样路径静默吞掉列举错误）没有改代码，只改了文档。** `run-service-probe.py:48-49` 仍然 `os.walk(directory)` 不带 `onerror`，`run-stage-03.py:215` 的 `directory_bytes(evidence)` 仍以 `tally=None` 调用、`listing_failed` 直接返回；I-107 现在如实写明“这两处仍静默跳过列不出的子目录，只少算字节，没有门槛用这些数”。因此“文档与代码不一致”这一点已解决，“静默少算”本身仍在，但没有安全门槛依赖它。
- **意见 5（adaptation-manifest 未同步重试说明）已改好。** `adaptation-manifest.json:51` 增加了 curl/npm 重试说明，`test_make_packet.py:1714-1720` 有对应测试。

## 发现的意见

### 1. 低 — 作者说明第 8 条与代码相反：带 `retryInMs` 的事件现在会被判失败

文件：`scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs:64-66`、`.../S7-switch-start-readback.py:46-50`

问题：作者说法是“带 `retryInMs` 的事件和 `memory.embedding_catch_up_failed` 不再判为失败”，但代码只放过 `nonFatal` 集合里的 `memory.embedding_catch_up_failed`；`retryInMs` 不再是免死牌。

证据（读代码证实）：
```js
const nonFatal = new Set(["memory.embedding_catch_up_failed"]);
return records.filter((item) => !nonFatal.has(item.event) && /(?:failed|...|retryable)/i.test(String(item.event)))
```
```python
STARTUP_NON_FATAL_EVENTS = frozenset({'memory.embedding_catch_up_failed'})
return [... if ... and value.get('event') not in STARTUP_NON_FATAL_EVENTS ...]
```
`test_make_packet.py:1796-1797` 明确断言 `future.sync_failed` + `retryInMs` 仍返回该事件；I-28 文档也已改成“名单外的事件即使带 `retryInMs` 也照样判失败”。代码、测试、I-28 三者一致，只有作者说明第 8 条不一致。

建议：把作者说明第 8 条改为“只放过 `memory.embedding_catch_up_failed`；其它事件即使带 `retryInMs` 仍判失败”。

### 2. 低 — 模板 `OWNED-SHA256SUMS` 里清理 helper 和 cloud-inputs 草稿的摘要仍是旧值

文件：`scripts/delivery-mode/packet-template/acceptance/OWNED-SHA256SUMS:59`（另见 `:33`）、`.../acceptance/cloud/cloud-inputs.draft.json:122`

问题：增量把草稿里的 `cleanupHelper.sha256` 从 `4dd065…` 改成 `172b94…`，但 `acceptance/OWNED-SHA256SUMS:59` 仍写 `4dd065…`；草稿文件自身字节已变，`:33` 的 `cloud/cloud-inputs.draft.json` 摘要 `1b84cd…` 也还是改前值。出包时 `regenerate_hashes` 会重算并覆盖这两个值，所以当前不会让 S6 失败；但模板自身不自洽，且现有测试没有断言模板 `OWNED-SHA256SUMS` 与模板文件一致。

证据（读代码证实）：
```
4dd065f51420a0cb63911f62e37dbda95f15f8c5afa2b66327007e3afe9f4bb9  helpers/check-p5-scratch-cleanup.py
1b84cd1004a8557a028bf8d6dbb5544f49d8d223364d9f0992f0f42144ff9a1f  cloud/cloud-inputs.draft.json
```
```json
"sha256": "172b94f4f56a257c76d64a5e4fff076ca9cfa129635f2f6a5e0352192b5213ef"
```
`make-packet.py:645-653` 只把 `OWNED-SHA256SUMS` 当成员列表用，摘要会被重写，因此不是当前出包失败点。

建议：同步模板 `OWNED-SHA256SUMS` 的这两行，或在 `test_make_packet.py` 加一条“模板 OWNED 摘要与模板文件一致”的测试，避免模板内两处摘要长期打架。

### 3. 低 — 新增的 `/packet/` 路径校验只看出现次数，不阻止 `..` 逃出 packet

文件：`scripts/delivery-mode/make-packet.py:631-635`、`.../packet-template/inputs/check-packet-consistency.py:45-50`

问题：`packet_member` 的名字和错误码 `PACKET_STAGED_PATH_OUTSIDE_PACKET` 承诺了“路径在 packet 内”的校验，但实现只要求 `'/packet/'` 出现一次，然后取其后缀；`/x/packet/../secret` 这样的路径能通过，并让 `regenerate_hashes` 去哈希 packet 外的文件。当前 `cleanupHelper.path` 来自受控模板，部署标签也无法改掉尾部固定路径，所以不是现实可利用漏洞；这是防御性校验缺口。

证据（读代码证实）：
```python
def packet_member(staged_path):
    marker = '/packet/'
    if staged_path.count(marker) != 1:
        refuse('PACKET_STAGED_PATH_OUTSIDE_PACKET', staged_path)
    return staged_path.split(marker, 1)[1]
```
检查脚本同样：
```python
helper = packet / helper_path.split('/packet/', 1)[1] if helper_path.count('/packet/') == 1 else None
```
推测：现有输入不会触发；若模板或参数将来允许更自由的路径片段，这里会静默接受越界路径。

建议：用 `Path.resolve()` 后 `relative_to(packet.resolve())` 校验，并显式拒绝含 `..` 的后缀；检查脚本用同一规则。

### 4. 低 — adaptation-manifest 说 `curl --retry 2` 会重试 DNS 失败，按 curl 语义大概率不成立

文件：`scripts/delivery-mode/packet-template/acceptance/cloud/adaptation-manifest.json:51`

问题：清单写“`--retry 2` 只重试 timeouts、DNS failures、408、429 和 5xx”。按 curl 的 `--retry` 语义，默认 transient 错误主要是超时、HTTP 408/429/5xx 等，DNS 解析失败通常要 `--retry-all-errors` 才会重试；适配器并没有加这个开关。测试 `test_make_packet.py:1718-1720` 只断言参数字符串存在，没有验证 DNS 分支。

证据（读代码证实）：适配器 `probe-authorized-network.mjs:94` 是 `--retry 2`，没有 `--retry-all-errors` 或 `--retry-connrefused`；清单第 51 行写入了 DNS。

推测：未在本机运行 curl 验证具体版本行为；如果实际 curl 版本不重试 DNS，清单描述就偏宽。重要的“403 不重试”结论本身是正确的。

建议：把清单措辞收窄为“重试 timeout、408、429、5xx；DNS/连接重置是否重试取决于 curl 版本”，或在有网络的环境补一条 DNS 失败计数用例。

## 侧重检查

**采样改成警告后，安全判断没有被静默放行（读代码证实）。**
- 磁盘余量预检仍是致命：`run-stage-03.py:119-120` 直接用 `root_free()` 的 `rootFreeBeforeBytes`，不经过采样器。
- 清理是否允许仍由清理 helper 的 `deleteAllowed` 决定：`run-stage-03.py:195-201`；采样器不再抛错只会跳过 `resources.errors` 那道早退，`if not record['passed']` 仍保留失败现场（`:193-194`）。
- S6_READ 的身份与清理检查仍致命：`run-service-probe.py:115-118` 的 scratch 身份变化、`:125-130` 的清理未确认仍写入 `errors`，`:138` 仍要求 `errors` 为空。
- 维护步骤的空间采样本来就没有门槛：`maintenance-common.mjs:905-907` 只把 `spaceSamplingWarnings` 写进记录，`verify-fixtures.mjs:660-664` 只断言“不致命”。

**重试不会把“被拦截”变成通过（读代码证实）。**
- 适配器 `--retry 2` 没有 `--retry-all-errors`；`test_make_packet.py:1722-1758` 用本机假代理验证 503 重试、白名单 403 只发一次。
- question-12 的 `transient()` 只认 5xx、DNS、连接重置、超时：`download-question-12.py:52-57`；403/404、跳转未批准、超大小、超时都是 `RuntimeError` 或 4xx，第一次就抛；`test_make_packet.py:1698-1703` 断言只调用一次。

**worker 启动等待 105 秒（读代码证实）。**
- worker 等的是 agent-service 的 boot binding：`apps/execution-worker/src/service-main.ts:107-120` 要求 workerInstanceId、workerBootId、deployment、authorityEpoch、fencingToken 全部匹配。
- 超时后抛 `WORKER_STARTUP_TIMEOUT`（`:121-122`），外层 catch 写 `service.failed` 并返回 1（`:231-241`）；`pair-supervisor.mjs:87-97` 会记 `pair.child_exit` 并停掉整对进程。
- systemd 单元是 `Type=exec`，没有显式 `TimeoutStartSec`（`himawari-prod.service.draft:8`），所以 systemd 的默认启动超时不覆盖应用自身的 105 秒等待；S7 的循环期限是 120 秒（`S7-switch-start-readback.py:297`），预算 90 秒 + 余量 15 秒（`andy-production.json:25-26`）仍小于等待时间，`startup_ready_budget` 会拒绝放不进去的配置（`make-packet.py:169-174`）。既有约束是 S7 调 `systemctl start` 的子进程自身 `timeout=60`（`:296`）以及 systemd 默认 90 秒可能约束 `ExecStartPre`，这不是本次改动引入的。

**失败事件排除名单不宽（读代码证实）。** 全仓库 `retryInMs` 的生产者只有 `memory.embedding_catch_up_failed`（`apps/agent-service/src/service-main.ts:1956-1961`）；其它 `retryable`/`retrying` 事件不带这个字段。名单现在只放过这一个事件，没有放过 `sandbox_runtime.content_audit_retryable` 等真正需要回滚的事件。

**改动的记录字段（读代码证实）。**
- `resourceSamplingErrors` 已在活动模板的读取端全部移除；仅 `acceptance/cloud/basis-04/run-stage-03.py` 还留着，它是被 `cloud-inputs.draft.json:83` 作为冻结载体带上的历史副本，不被执行。
- `cgroupReadback.remainingPids` 在 cgroup 文件消失时为空列表（`S6-service-read.py:36-39`），S7 `:251` 和 S9 `:287` 都只要求它为空，接受这个值。
- 失败现场条目新增 `type: vanished`（`failure-scene.py:50-51`），只被 `verify-failure-scene-fixtures.py` 读取；验收失败时不会进入封存路径。
- `downloadRetries`、`resourceSamplingWarnings`、`resourceSamplingVanishedEntries`、`spaceSamplingWarnings` 都只作为证据字段，没有签名/封存路径要求它们存在或非空。
- `cleanupHelper.sha256/path` 的读取端（`run-stage-03.py:34`、`run-network-preparation.py:37`、`check-entry-paths-06.py:41`、`finalize-cloud-inputs.py:67`、`check-packet-consistency.py:45-50`）都接受 64 位十六进制和同一路径格式；出包时已重算。模板 OWNED 的旧摘要见意见 2。

**错误路径/不可信输入/资源耗尽的残留风险。**
- `check-p5-scratch-cleanup.py:73-83` 的 `identities_now` 吞掉 `RuntimeError`/`ValueError`，可能漏登记畸形 `/proc/<pid>/stat` 的活进程；最终清理另有一次全 `/proc` 扫描（`:228-285`），引用检查仍在，因此没看到“删掉正在使用的 scratch”的路径。这是旧代码，本轮增量未改。
- `packet_member` 的包含性校验见意见 3。
- question-12 每次重试都会重新计 120 秒下载期限，最坏总时长约 3×120+4 秒；外层脚本没有单独超时，属于既有行为，重试只是延长了最坏时间。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？** 不涉及。本轮增量只改出包/验收脚本、S7 读回、说明文档和测试；全量 PR 里唯一的产品代码变化是 `DEFAULT_STARTUP_WAIT_TIMEOUT_MS`（`service-main.ts:32`），不参与构造模型请求。没有改动 system prompt、工具定义、历史消息或遮盖逻辑，也不存在“只在末尾追加”的破坏。`.agents/instructions/prompt-prefix.md` 在本次 sparse checkout 中未检出，未能直接引用该规则文件。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不涉及。改动不进入模型请求内容；`regenerate_hashes` 对同一模板和同一 helper 字节是确定性的，S7 事件匹配也不依赖时间或无序集合。

**3. 有没有自动检查，反向用例真的会失败？** 有检查。`test_the_bound_cleanup_helper_digest_follows_the_helper`、`test_the_template_cleanup_helper_digest_matches_the_template_helper`、`verify-packet-consistency.py` 的新 `case`、`StartupFailureEventTest.test_an_unlisted_failure_event_fails_the_switch_even_when_it_says_it_will_retry`、`verify-startup-readiness-fixtures.mjs` 把 `future.sync_failed` 移入致命列表，以及 `test_the_adaptation_manifest_names_the_retry_flags_the_adapter_uses`。按代码逻辑，旧实现分别会在摘要不一致、缺少新 `case`、放过 `retryInMs` 事件、清单缺少重试说明这些断言上失败。**未实际运行测试**（本次只允许读文件和指定 git 命令），所以“真的会失败”是按断言与旧代码逻辑推断，不是执行结果。测试缺口：没有测试断言 `assemble` 真的调用了 `regenerate_hashes`；模板 `OWNED-SHA256SUMS` 也没有新鲜度测试（见意见 2）。

**4. 每个改动值的直接使用端都能接受吗？** `cleanupHelper.sha256/path` 的 5 个读取端都接受新值；`resourceSamplingWarnings`/`resourceSamplingVanishedEntries` 没有强制读取方；旧 `resourceSamplingErrors` 的活动读取方已清空；`cgroupReadback.remainingPids=[]` 被 S7/S9 接受；`vanished` 条目只被夹具读取；S7 两种实现的事件名单一致；90 秒预算 + 15 秒余量 + 105 秒等待 + 120 秒期限的约束由 `startup_ready_budget` 和 `ProductionStartupBudgetTest` 核住。唯一未同步的是模板 `OWNED-SHA256SUMS` 的旧摘要，但出包时会被重算覆盖（意见 2）。

## 本轮查过的范围

- 增量：`git diff 0be5e8e1..281835ded` 的 15 个文件（10 个代码/文档 + 5 个复核材料）。
- 上一轮意见 1、2、5 的修复情况。
- 作者说法 1–9 对应的 `8de0a1697` 改动：`run-service-probe.py`、`run-stage-03.py`、`maintenance-common.mjs`、`check-p5-scratch-cleanup.py`、`failure-scene.py`、`S6-service-read.py`、`download-question-12.py`、`probe-authorized-network.mjs`、`service-main.ts`、`andy-production.json`、`S7` 两个读回、I-28/I-107。
- 使用端：用 grep 核对 `cleanupHelper`、`resourceSampling*`、`cgroupReadback`、`retryInMs`、`spaceSamplingWarnings`、`downloadRetries`、`vanished`、`startupReadyBudgetSeconds`、`DEFAULT_STARTUP_WAIT_TIMEOUT_MS`。
- 未核实：`.agents/instructions/prompt-prefix.md`（sparse checkout 未检出）、curl 具体版本对 DNS 的重试行为（无法运行）、测试实际执行结果（只允许读文件和指定 git 命令）。
