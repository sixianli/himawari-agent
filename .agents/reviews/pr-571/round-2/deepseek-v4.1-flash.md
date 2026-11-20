## 侧重检查

这一轮查过的范围：`git diff a4c09a07..0be5e8e1` 的全部 28 个文件；其中完整读了 `run-stage-03.py`、`run-service-probe.py`、`check-p5-scratch-cleanup.py`、`download-question-12.py`、`failure-scene.py`、`maintenance-common.mjs`、`S7-switch-start-readback.py`、`S7-startup-readback.mjs`、`S6-service-read.py`、`finalize-cloud-inputs.py`、`cloud-seal.mjs`、`make-packet.py` 的相关函数，以及新增测试。未重读增量没碰到、行为也没被增量改变的旧代码。

- **采样失败改警告后有没有安全判断被静默放行**：查了 `resourceSamplingErrors|resourceSamplingWarnings|spaceSample|scratchPeakBytes|rootLowestFreeBytes` 的所有读写端。清理是否允许由 `check-p5-scratch-cleanup.py:294` 的 `deleteAllowed`（进程身份、存活进程、引用搜索）决定；`run-stage-03.py:195-206` 和 `run-service-probe.py:118-130` 都不拿资源采样结果做删除判断。维护脚本的空间采样只是记录，`readCatalogResume` 里原来的 `MAINTENANCE_SPACE_SAMPLING_FAILED` 已删除，没有磁盘余量门槛依赖它。**结论：没有发现“采样失败导致静默允许清理/越过磁盘门槛”的路径。** 但下面第 1 条是一个会挡住 S6 的硬失败，不是静默放行。
- **重试会不会让“被拦截”变成通过**：`download-question-12.py:52-67` 只对 5xx、DNS、连接重置、超时重试；跳转白名单、大小限制、4xx 立即失败。`probe-authorized-network.mjs:94` 用 `curl --retry 2`（没有 `--retry-all-errors`/`--retry-connrefused`），`:102` 用 `--fetch-retries=2`；403/策略拦截不会被重试。测试 `test_policy_and_client_results_are_checked_once` 和 `test_curl_retries_only_transient_results_and_never_an_allowlist_block` 覆盖了这两点。**结论：没有发现策略拦截被重试放行的路径。**
- **105 秒启动等待**：worker 等的是 agent-service 发布 boot binding（`service-main.ts:82-125`），超时抛 `WORKER_STARTUP_TIMEOUT`（`:121-122`），`writeServiceDiagnostic` 写 `service.failed`（`:236-240`），`pair-supervisor.mjs` 看到子进程退出后以 `pair.child_exit` 停整对服务。主 unit 是 `Type=exec` 且没有 `TimeoutStartSec`（`himawari-prod.service.draft:8-31`），所以 systemd 的默认启动超时不会先卡住这段 105 秒等待；S7 切换脚本自己的等待期限是 120 秒（`S7-switch-start-readback.py:297`），`make-packet.py:173` 要求 `budget+margin ≤ workerWait`。**结论：systemd 不会先触发；产品影响是 agent-service 真起不来时，worker 晚约 60 秒才报错。**
- **失败事件排除名单**：见下面第 4 条。当前产品只有 `memory.embedding_catch_up_failed` 会带 `retryInMs`（`apps/agent-service/src/service-main.ts:1956-1961`），所以现在不会误放行；但匹配条件本身是泛化的，属于未来风险。
- **改动字段的所有使用端**：`resourceSamplingWarnings`/`resourceSamplingVanishedEntries`、`spaceSamplingWarnings`、`downloadRetries`、`startupFailureEvents`/`startup_failure_events`、`cgroup_pids`、`startupReadyBudgetSeconds`、`DEFAULT_STARTUP_WAIT_TIMEOUT_MS`、`adapterSha256` 都逐个查了产生端和消费端，详见必答问题 4。**发现一个不同步的值：`cleanupHelper.sha256`。**

## 上一轮意见复核

- 第 1 轮第 1 条（`os.walk` 吞目录列举错误）：只改好了一半。带 `tally` 的采样路径现在会记 `warnings`/`vanished`；但 `directory_bytes(evidence)` 和 `run-service-probe.tree_bytes` 仍然静默吞掉目录列举错误，见下面第 2 条。
- 第 1 轮第 2 条（“修复前两条都失败”不能证明第二条反向用例）：已改好。I-107 现在明确写了“这条在修复前也通过，只防以后被误吞”，测试也改名为回归保护。
- 第 1 轮第 3 条（`scratchPeakBytes` 静默偏小）：按已知取舍处理了：I-107 明确记录了这个偏差和 `resourceSamplingVanishedEntries`，并说明没有门槛消费这两个数。可以接受。

## 意见

### 1. 高 — 修改 `check-p5-scratch-cleanup.py` 后没有同步 `cloud-inputs.draft.json` 的 `cleanupHelper.sha256`，S6 会以 `BOUND_CLEANUP_HELPER_CHANGED` 失败（读代码证实）

文件:行：`scripts/delivery-mode/packet-template/acceptance/cloud/cloud-inputs.draft.json:120-122`、`scripts/delivery-mode/packet-template/acceptance/cloud/finalize-cloud-inputs.py:66-68`、`scripts/delivery-mode/make-packet.py:631-645`、`scripts/delivery-mode/packet-template/acceptance/helpers/check-p5-scratch-cleanup.py:81`。

问题：本增量把清理 helper 的异常捕获从 `(FileNotFoundError, ProcessLookupError)` 扩成 `(FileNotFoundError, ProcessLookupError, RuntimeError, ValueError)`，helper 字节变了；但 `cloud-inputs.draft.json` 里的 `cleanupHelper.sha256` 仍是旧值 `4dd065f5...`，而 `make-packet.py` 的 `regenerate_hashes` 只重写 `manifest['files']` 和四个 `OWNED-SHA256SUMS`，**不会更新 `cleanupHelper.sha256`**。出包后的包会在 S6 的 `finalize-cloud-inputs.py` 用它和实际 helper 字节比较，失败。

证据：
```python
# finalize-cloud-inputs.py:66-68
helper = stage / 'packet/acceptance/helpers/check-p5-scratch-cleanup.py'
if manifest['cleanupHelper']['path'] != str(helper) or sha(read(helper, 0)) != manifest['cleanupHelper']['sha256']:
    raise RuntimeError('BOUND_CLEANUP_HELPER_CHANGED')
```
```python
# make-packet.py:634-645（只刷新 files 和 OWNED）
for relative in manifest['files']:
    manifest['files'][relative] = file_sha(packet / 'acceptance/cloud' / relative)
...
for name, root in OWNED_SUMS.items():
    ...
```
`git log` 也显示 helper 最后修改于 `8de0a1697`，而 `cloud-inputs.draft.json`、`OWNED-SHA256SUMS` 最后修改于更早的 `12c8bfb75`；本次 diff 没有更新 `cleanupHelper.sha256`。我没有运行 `sha256sum`，但 helper 内容变了而固定摘要没变，按 `finalize-cloud-inputs.py` 的字节比较必然不相等。

影响：`run-stage-03.py:34`、`check-entry-paths-06.py:39-42`、`run-network-preparation.py:23-38` 也都会拿同一个固定摘要比对。默认流程里 `S6_ACCEPTANCE` 在停服前（`deploy.sh:78`），只是白跑一次；但如果按 `HIMAWARI_DEPLOY_ACCEPTANCE_AFTER_STOP=1`（`deploy.sh:80`），S6 在停服后，按现在“不回滚、保留现场”的策略，服务会真的停着。Hermes 演练发现不了，因为 `run-hermes-rehearsal.py:147` 会用自己的实际 helper 摘要覆盖 manifest；出包检查也发现不了，因为 `check-packet-consistency.py` 只检查 `draft['files']` 和 OWNED，不检查 `cleanupHelper.sha256`。

建议：把 `cleanupHelper.sha256` 更新为新 helper 的摘要；更稳的是让 `regenerate_hashes` 也更新这个字段（helper 路径没有占位符，可直接对 `packet/acceptance/helpers/check-p5-scratch-cleanup.py` 算摘要）。同时加一条检查：渲染出包后断言 `draft['cleanupHelper']['sha256'] == sha(packet/.../check-p5-scratch-cleanup.py)`；现有 `test_regenerated_hashes_satisfy_the_packet_consistency_check` 不会覆盖它。

### 2. 低 — 非采样路径仍会静默吞掉目录列举错误，与 I-107 的“列不出的子目录记成警告”不完全一致（读代码证实）

文件:行：`scripts/delivery-mode/packet-template/acceptance/cloud/run-stage-03.py:68-76,215`、`scripts/delivery-mode/packet-template/measurement/probe/run-service-probe.py:48-49`。

问题：`directory_bytes` 的 `onerror` 在 `tally is None` 时直接 `return`，而 `run-stage-03.py:215` 的 `directory_bytes(evidence)` 正好不传 tally；`run-service-probe.py` 新加的 `tree_bytes` 则连 `onerror` 都没有。这两处遇到列不出的子目录时不会记警告，只是少算字节。

证据：
```python
# run-stage-03.py:69-71
def listing_failed(error):
    if tally is None:
        return
...
# run-stage-03.py:215
record['intentionallyRetainedEvidenceBytes'] = directory_bytes(evidence)
```
```python
# run-service-probe.py:48-49
def tree_bytes(directory):
    return sum(file_bytes(Path(parent) / name) for parent, directories, names in os.walk(directory) for name in names)
```

影响：只影响证据字节统计和 `scratchPeakBytes`，没有门槛消费这些数，所以严重度低；但这是上一轮第 1 条没有完全消掉的同一类行为，且 I-107 的表述看起来像所有列不出的子目录都会成为警告。

建议：`directory_bytes` 在 `tally is None` 时也至少 `raise`，或在 `tree_bytes` 里传入一个会记录 `onerror` 的 tally；如果保留静默，I-107 应写明“仅限带 tally 的采样路径”。

### 3. 低 — 维护脚本“采样失败改为警告”在 sampler worker 提前报错时仍可能因 `postMessage` 抛错而失败（推测）

文件:行：`scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:883-903`。

问题：`await ready` 失败时代码只把 `samplerFailure` 设为 true，然后继续执行真正的维护命令；但 finally 里仍然无条件调用 `sampler.postMessage({ kind: "stop" })`。Node 的 `Worker` 在已经 `error`/`exit` 后再 `postMessage` 会抛 `ERR_WORKER_NOT_RUNNING`（这一点我没有在代码里实际执行验证，标为推测）。如果确实如此，这个原本想“采样错误只记警告”的路径仍会在 finally 抛出，连 `retainedJson` 都不会写，维护步骤照旧失败。

证据：
```javascript
let samplerFailure = false;
try {
  await ready;
} catch {
  samplerFailure = true;
}
...
} finally {
  sampler.postMessage({ kind: "stop" });
  try {
    await exited;
  } catch {
    samplerFailure = true;
  }
}
```

影响：只影响 sampler 线程本身崩掉、而不是“ready 里带 errors”的情况；前者本来就是更严重的异常，但和“资源/空间采样错误改为警告”的说法不完全一致。测试 `MaintenanceSpaceSamplingTest` 只检查源码字符串，`verify-fixtures` 只调用 `spaceSamplingWarnings`，都没有覆盖 worker 提前失败。

建议：在 `samplerFailure` 为 true 时跳过 `postMessage`，或把 `postMessage` 包在 try/catch 里；再加一条 fixture：让 sampler 在 ready 之前抛错，断言维护命令仍执行且记录里有 `SAMPLER_RESULT_MISSING`/`SAMPLER_EXIT_FAILED` 警告。

### 4. 低 — 启动失败事件的排除条件过宽：任何带 `retryInMs` 的事件都被放过，不只已知可重试事件（推测/未来风险）

文件:行：`scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs:64-67`、`scripts/delivery-mode/packet-template/systemd/S7-switch-start-readback.py:46-50`。

问题：现在的条件是“事件名包含 failed/error/... 且没有 `retryInMs` 才算失败”，再额外放过 `memory.embedding_catch_up_failed`。目前全仓库只有 `apps/agent-service/src/service-main.ts:1961` 给 `memory.embedding_catch_up_failed` 写 `retryInMs`，所以当前不会误放行；但将来如果某个真正致命的事件也带了这个字段，切换读回会静默放过。另一个小问题是 `memory.embedding_catch_up_failed` 被写成无条件非致命，虽然产品当前总会带 `retryInMs`。

证据：
```javascript
// S7-startup-readback.mjs:66
return records.filter((item) => !Object.hasOwn(item, "retryInMs") && !nonFatal.has(item.event) && /(?:failed|...)/i.test(String(item.event))).map(...)
```
```python
# S7-switch-start-readback.py:50
return [value.get('event', '') for value in messages if isinstance(value, dict) and 'retryInMs' not in value and value.get('event') not in STARTUP_NON_FATAL_EVENTS and any(...)]
```

建议：把“可重试”限定为明确的 `(event, retryable)` 白名单，或要求事件带结构化的 `retryable: true`/`willRetry: true`，而不是只看字段是否存在；同时加一个反向用例：一个名字含 failed、但带 `retryInMs` 的未知事件仍应失败，或明确把已知可重试事件列全。

### 5. 低 — `adaptation-manifest.json` 的说明字段没有同步新增的 curl/npm 重试行为（读代码证实，文档一致性）

文件:行：`scripts/delivery-mode/packet-template/acceptance/cloud/adapters/probe-authorized-network.mjs:94,102`、`scripts/delivery-mode/packet-template/acceptance/cloud/adaptation-manifest.json` 中 `probe-authorized-network` 的 `additionalChanges`/`timingChanges`。

问题：本增量给 curl 加了 `--retry 2`、给 npm 加了 `--fetch-retries=2 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=3000`，但 adaptation manifest 只更新了 `adapterSha256`，描述字段没有提这两项。`adapterSha256` 有测试 `test_every_adapter_hash_in_the_adaptation_manifest_matches_its_file` 校验，描述字段没有任何门槛核对，属于文档和代码不一致。

证据：
```javascript
// probe-authorized-network.mjs:94
const curl = `/usr/bin/curl --silent --show-error --fail --max-time 15 --retry 2 --cacert ...`;
// :102
install: `... --fetch-retries=2 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=3000 ...`
```
manifest 里对应条目的 `additionalChanges` 仍是“print the host diagnostic... / remove two comments”，没有重试说明。

建议：在 `additionalChanges` 或 `timingChanges` 里补上重试参数及“403/4xx 不重试”的边界；如果能加一条测试断言描述里包含 `--retry`/`--fetch-retries`，以后就更容易发现漏更新。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不涉及。这个增量没有改系统提示、工具定义、历史消息、遮盖或压缩代码；唯一的 `apps/` 产品代码改动是 `apps/execution-worker/src/service-main.ts:32` 的等待常量，它只影响启动等待时间，不进入模型请求。因此发给模型的内容仍然只在末尾追加，每轮变化的值仍然只能在最后一条消息里；依据的“已发内容只追加”规则没有被触碰。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
本增量不涉及模型请求，因此不会。新加的运行记录字段（`resourceSamplingWarnings` 的异常文本、`downloadRetries` 的错误文本、`resourceSamplingVanishedEntries`）会随运行环境变化，但它们是验收/维护证据，不是模型输入；`startupFailureEvents` 只解析日志事件名和 `retryInMs`，不序列化进模型请求。

**3. 有没有对应的自动检查，反向用例真的会失败？**
大部分有：`ServiceProbeSamplingTest`、`ScratchRegistrationPollTest`、`ServiceReadCgroupTest`、`QuestionTwelveDownloadRetryTest`、`AuthorizedNetworkRetryTest`、`MaintenanceSpaceSamplingTest`、`StartupFailureEventTest`、`ProductionStartupBudgetTest`，以及 `verify-failure-scene-fixtures.py`、`verify-startup-readiness-fixtures.mjs`、`maintenance/verify-fixtures.mjs`；I-107 也改正了“回归保护在修复前也通过”的说法。
**缺口**：(a) 第 1 条的 `cleanupHelper.sha256` 没有任何测试，且 `check-packet-consistency.py` 不检查它，反向用例不会失败；(b) `run-service-probe.tree_bytes` 和 `directory_bytes(evidence)` 的目录列举错误没有反向用例；(c) sampler worker 在 ready 前报错的路径没有 fixture；(d) 第 4 条的 `retryInMs` 泛化排除没有“未知致命事件带 retryInMs”的反向用例。

**4. 每个改动的值，产生端和使用端是否都能接受？**
- `cleanupHelper.sha256`：产生/固定在 `cloud-inputs.draft.json:122`；使用端 `finalize-cloud-inputs.py:67`、`run-stage-03.py:34`、`check-entry-paths-06.py:41`、`run-network-preparation.py:37` 都用实际 helper 字节比对。**不接受，见第 1 条。**
- `resourceSamplingWarnings` / `resourceSamplingVanishedEntries`：产生于 `run-stage-03.py:213`；`S7-switch-start-readback.py`、`S9-clean-transport.py`、`finalize-binding-inputs.py`、`cloud-seal.mjs` 已不再要求旧的 `resourceSamplingErrors`，只有 Hermes fixture `test-resource-retention.py:108` 读新字段。可以接受。`run-service-probe.py` 也写 `resourceSamplingWarnings`，但目前没有下游读者要求它。
- `spaceSamplingWarnings`：产生于 `maintenance-common.mjs:865-866,905`；`verify-fixtures.mjs:660-664` 消费，旧的 `MAINTENANCE_SPACE_SAMPLING_FAILED`/`NOT_READY` 已无读者；`readCatalogResume` 也不再要求它。可以接受。
- `downloadRetries`：产生于 `download-question-12.py:66`；`run-question12-downloads.sh`、`finalize-cloud-inputs.py` 只读 `downloads`、`passed` 等既有字段，不拒绝新增字段。可以接受。
- `startupFailureEvents` / `startup_failure_events`：分别供 `S7-startup-readback.mjs:213` 和 `S7-switch-start-readback.py:312` 使用，两个实现当前一致，fixture 分别覆盖。可以接受；但第 4 条的泛化条件需要收紧。
- `cgroup_pids`：供 `S6-service-read.py:139` 产生 `remainingPids`；`S7-switch-start-readback.py:250` 和 `S9-clean-transport.py:284` 只要求其为空。cgroup 文件消失时返回空列表，语义上等于“没有剩余进程”，可以接受。
- `startupReadyBudgetSeconds=90` 与 `DEFAULT_STARTUP_WAIT_TIMEOUT_MS=105000`：产生于 `andy-production.json:25` 和 `service-main.ts:32`；`make-packet.py:165-175` 在出包时解析 worker 源码并拒绝 `budget+margin > wait`，`ProductionStartupBudgetTest` 校验了 90 秒预算、105 秒等待、120 秒切换期限。可以接受。
- `adapterSha256`：产生于 `adaptation-manifest.json`，测试用实际 adapter 文件校验，已同步。可以接受。
- `vanished` 类型：只由 `failure-scene.py:51` 产生，`verify-failure-scene-fixtures.py:89` 消费；没有其他 schema 强制要求 `mode`/`uid`。可以接受。
