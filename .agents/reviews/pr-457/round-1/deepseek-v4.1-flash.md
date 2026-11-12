## 结论

对照代码后，没有发现会改变模型请求开头或产品行为的改动；这个 PR 确实只动 CI/运维脚本、运行手册和测试。但有两处需要修：运行手册的封存摘要没有随契约源文件更新；恢复脚本会放过“某个 runner 同时带着自己标签和别人的标签”的中间状态，正好覆盖了作者声称要防的“给 3 号加了 `ci-vps`”。

## 发现（按严重度）

### 1. 中 — 运行手册声称“重新封存”，但 `contract_sha256` 没有变

文件：`docs/runbooks/ci-vps-runner-runbook.md:5`、`:13-15`

问题：这个提交改了 `scripts/operations/ci-runner/` 下的契约源文件，但没有更新运行手册第 5 行的封存摘要。提交说明写“运行手册改成三个 runner 并重新封存”，与 diff 不一致；这里也没有 `Docs: deferred (fast mode)` 之类暂缓标记。按仓库规则，完整模式文档严格校验会继续报 `contract_sha256 does not match`。

证据（亲自读到）：

```text
docs/runbooks/ci-vps-runner-runbook.md:5
contract_sha256: "sha256:fcfda7ac3bc85dbb980e9dfa7d2ffb2bade4325fef1698cbe0d39441254613a4"

docs/runbooks/ci-vps-runner-runbook.md:13-15
<!-- runbook-contract:
- scripts/operations/ci-runner
-->
```

而同一提交的 diff 改了 `runners.sh`、`gh-runner.service.in`、`gh-runners.slice` 等文件，`git diff` 里没有第 5 行的变化。

`.agents/instructions/document-governance.md:56` 明确要求：

```text
当改动涉及某个 Runbook 的契约源文件……要对照新代码审查这个 Runbook，
然后在同一个提交里用 runbook.py seal ... --confirm-reconciled --apply 重新封存它。
```

建议：重新运行 `runbook.py seal --confirm-reconciled --apply` 并提交新的 `contract_sha256`；如果确实要 defer，按 `delivery-mode.md:26` 在提交说明写 `Docs: deferred (fast mode)`，并记录这份 Runbook。

### 2. 中 — 恢复脚本把 `extra` 一律当成可接受，3 号带着 `ci-vps` 也会启动服务

文件：`scripts/operations/ci-runner/mac-runners.sh:89-96`、`scripts/operations/ci-runner/resume-runners.sh:26-31`

问题：`label_states` 只要 runner 带着自己的标签、另外还带着任意受管标签，就归为 `extra`；`resume-runners.sh` 的失败分支只拦 `off`、`unread`、`foreign`，不拦 `extra`。因此下面两种违反运行手册停止条件的状态会被放行并启动服务：

- `ci-vps-gate` 同时带 `ci-vps-gate` 和 `ci-vps`；
- 检查 runner（例如 `ci-vps-2`）同时带 `ci-vps` 和 `ci-vps-gate`。

运行手册 `docs/runbooks/ci-vps-runner-runbook.md:262` 明确写：

```text
- `ci-vps-gate` 带上了 `ci-vps` 标签，或者 `ci-vps-2` 带上了 `ci-vps-gate` 标签。
```

证据（亲自读到）：

```bash
# mac-runners.sh:89-96
elif [ "$(managed_labels_on "$labels")" = "$own" ]; then
  states="$states $name=on"
elif [ -z "$(managed_labels_on "$labels")" ]; then
  states="$states $name=off"
elif has_label "$labels" "$own"; then
  states="$states $name=extra"
else
  states="$states $name=foreign"
fi
```

```bash
# resume-runners.sh:26-31
STATES=$(label_states "$NAMES" "$TABLE")
case " $STATES " in
  *=off\ * | *=unread\ * | *=foreign\ *)
    echo "RUNNER_RESUME_INCOMPLETE labels: $STATES; services not started, queued jobs keep waiting, run resume-runners.sh again"
    exit 1
    ;;
esac
```

推测的影响：如果 3 号已经被加上 `ci-vps`，恢复后它会被启动并开始接检查作业；3 号只有 2 GB 内存上限，检查作业可能 OOM。这不是实测结论，但符合代码和限额。

建议：把 `extra` 改成按 runner 区分状态。只允许“检查 runner 1 额外带 `ci-vps-gate`”这一种应急状态；对 3 号带 `ci-vps`、2 号带 `ci-vps-gate` 一律判失败并拒绝启动服务。补一条“两个标签同时存在”的反向用例；现有测试只测了 3 号“只带 `ci-vps`”的 `foreign` 情况。

### 3. 低 — 运行手册多处仍按“两个 runner”写，和三个 runner 的代码不一致

文件：`docs/runbooks/ci-vps-runner-runbook.md:68`、`:149`、`:275`、`:277`

问题与证据：

- `:68` 仍写“低于 16 GiB（两个任务可能同时占盘）”，但现在最多可能有 3 个 runner 同时占盘。
- `:149` 写“两个入口都在 Andy 的 Mac 上”，但暂停、恢复、应急一共是三个入口；新增的 `gate-fallback.sh` 也共用同一把锁。
- `:275` 说“三个 runner 的 `disk.log`”，但清理范围只列了：

```text
只能清 `/srv/gh-runner/runner/_work`、`/srv/gh-runner-2/runner/_work` 下没有任务在用的旧目录
```

漏了 `/srv/gh-runner-gate/runner/_work`。如果磁盘是被汇总 runner 占满，按这行处理不会清到正确目录。

- `:277` 的诊断命令仍是：

```text
sudo journalctl -u gh-runner -u gh-runner-2 --since <时间>
```

漏了 `gh-runner-gate`，虽然同一行的处理里已经写了要重启 `gh-runner-gate`。

建议：把这些“两个”改成三个，并把 3 号的 `_work` 和 `journalctl` 补进排错步骤。

### 4. 低（代码已证实，影响为推测）— `gate-fallback.sh on` 不检查 1 号是否在线

文件：`scripts/operations/ci-runner/gate-fallback.sh:29-38`

问题：`on` 只检查 `ci-vps-1` 是否还有 `ci-vps` 标签，不检查它的 status 是否为 `online`。如果 1 号标签还在但已经离线，脚本仍会打印 `GATE_FALLBACK_ON` 并说汇总作业改由 1 号接，实际上 `ci/required` 仍会排队。

证据：

```bash
has_label "$(runner_field "$TABLE" "$FALLBACK" 5)" "$RUNNER_CHECK_LABEL" || {
  echo "GATE_FALLBACK_FAILED $FALLBACK does not carry $RUNNER_CHECK_LABEL, so the runners are paused; run resume-runners.sh first"
  exit 1
}
...
echo "GATE_FALLBACK_ON $FALLBACK now also takes $RUNNER_GATE_LABEL jobs (status=$(runner_field "$TABLE" "$FALLBACK" 3))"
```

这里虽然把 `status` 打出来了，但没有把它作为成功条件。建议在 `on` 时要求 `status=online`（至少不是 `offline`），否则打印失败并以非零退出，避免操作者误以为应急已经生效。

## 侧重检查

- **错误路径**：检查了 `gate-fallback.sh` 的 on/off 读 GitHub 失败、加/删标签失败和回读校验；检查了 `pause-runners.sh` 的删除失败回滚、`resume-runners.sh` 的标签状态机、`uninstall-runner.sh` 缺账号/缺 `nft` 路径、`install-runner.sh` 的 ERR/INT 回滚。发现的主要问题是 `resume` 的 `extra` 状态没有作为失败处理。
- **不可信输入**：新增的外部值只有 GitHub API 返回的 runner id 和标签列表。删除/新增标签时实际使用的标签名来自 `RUNNER_LABELS` 常量，runner id 来自 GitHub 的数字 id，没有看到把任意标签名直接拼进删除 URL 的路径。
- **安全**：1/2/3 号的 `InaccessiblePaths` 都藏了另外两个 runner 的目录；`ghgate.slice` 与检查 runner 的 slice 分开；防火墙和窄 sudo 规则按 `installed_runner_ids` 重新生成，3 号被纳入。没有发现目录互相可见或权限直接放宽。
- **资源耗尽**：`18G + 2G = 20G` 不超过 22G 主机内存，和手册一致；但 2 GB 对汇总作业是否足够没有实测，作者也明确说没有在真实 CI 服务器上跑过。
- **不可撤销操作**：`uninstall-runner.sh 3` 会删除 3 号的用户和 `/srv/gh-runner-gate`，回滚手册已写明；`gate-fallback` 只改 GitHub 标签，可逆。没有发现新的、会误删 1/2 号数据的路径。
- **规则/文档/代码一致性**：发现运行手册封存摘要未更新，以及多处“两个 runner”的残留文本。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这个 diff 只涉及 `.github/workflows/main.yml`、`scripts/ci/main-workflow.mjs`、`scripts/operations/ci-runner/*`、运行手册和测试，没有改提示词目录、运行时、应用层或任何组装模型请求的代码。按 `.claude/rules/prompt-prefix.md` 的要求，发给模型的内容仍是“系统提示、工具定义、历史不变，只在末尾追加”；这个 PR 没有新增每轮变化的值，`main-confirmation` 并发组也不是发给模型的字段。没有逐行重审现有提示词实现，因为本 PR 未触及那部分。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。没有新增时间字段、随机值、遮盖逻辑或依赖前后文的序列化；测试拆分和并发组改动都不进入模型请求。唯一新增的运行时值是 CI 的 `github.run_id`，而且是被移出并发组，与模型内容无关。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   - 有：`test/tooling/ci-runner-scripts.test.mjs` 覆盖 3 号标签、服务文件、内存池、目录隐藏、暂停/恢复、应急、卸载；`test/tooling/ci-optimization.test.mjs` 覆盖 `main-confirmation` 和 `cancel-in-progress`，`main-workflow.mjs` 里同步了硬规则；`security-published.test.mjs` 拆成每个登记文件一条用例。
   - 作者声称的反向场景大多能对应到实际断言：3 号标签写错、恢复时给 3 号加 `ci-vps`、1 号看得到 3 号目录、暂停只去 `ci-vps`、`RUNNER_IDS` 漏 3、并发组改回带运行号、`cancel-in-progress` 改 `true`，都会让现有断言失败。
   - 缺口：没有测“3 号同时带 `ci-vps` 和 `ci-vps-gate`”或“2 号带 `ci-vps-gate`”这种 `extra` 中间状态，所以第 2 条发现不会被现有测试拦住；运行手册封存摘要也没有自动检查（完整文档校验已不在 `npm run check` 里，只能手动运行技能）。
   - 我没有运行 `npm run check` 或 vitest，作者报告的 122 条通过和反向验证未独立核实。

4. **每个值的产生方和使用方两端都能接受吗？**
   - `RUNNER_IDS="1 2 3"`：`install-runner.sh`、`uninstall-runner.sh all`、`installed_runner_ids`、`runner_label_for_name`、测试都按列表循环；`register-runner.sh` 和 `uninstall-runner.sh` 分别接受 `1|2|3` 和 `2|3|all`，两端一致。
   - `ci-vps` / `ci-vps-gate` / `RUNNER_LABELS`：注册、暂停、恢复、对账、`runner-pause.sh` 消息都使用同一组常量；`has_label` 已改成显式传标签，没有发现还依赖旧全局 `$LABEL` 的调用。
   - `gh-runner-gate` 用户名、`/srv/gh-runner-gate`、`gh-runner-gate.service`、`ghgate.slice`：安装/备份/卸载、防火墙和 sudo 规则、其他 runner 的 `InaccessiblePaths`、`gh-runner-nft.service`、`prepare-vps.sh`、运行手册都按同一名字消费，未发现漏项。
   - 内存和进程数：`runners.sh` 生成的 `14G/15G/2048`、`2G/2G/2G/1024` 与模板、slice、测试和手册中的 `systemctl show` 期望值一致。
   - `main-confirmation`：`main.yml`、`scripts/ci/main-workflow.mjs:47` 和 `test/tooling/ci-optimization.test.mjs` 三处一致，没有其他消费者。
   - `security-published` 的每条登记项：`entry.path`、`fileSha256`、`findings` 的产生方是 `ci/security-exceptions.json`，使用方仍是同一个扫描函数，拆分前后语义等价。
   - **不通过的一项**：运行手册的 `contract_sha256` 是给文档校验器消费的封存值，契约源文件已经变化但摘要未更新，见第 1 条发现。

**未核实**：未在真实 VPS 上验证 systemd/cgroup 的 `MemoryMin` 行为、2 GB 是否足够汇总作业、3 号与 1/2 号的实际隔离效果；也未独立运行 `npm run check`、vitest 或文档严格校验。
