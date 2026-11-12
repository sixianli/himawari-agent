## 复核结论（按严重度从高到低）

### 1（中）ADR 0238 关于「重跑失败作业不受影响」的说法与代码机制矛盾
- **文件**：`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:62`（后果段）
- **问题**：ADR 说「GitHub 的『重跑失败作业』会用新的尝试号，上游作业重新存一份，不受影响」。但按 GitHub 公认语义（离线无法核实文档原文，标注为推测），「重跑失败作业」不会重跑已成功的上游作业，`build` 不会再次 `put`。
- **证据（读代码证实）**：`scripts/ci/run-share.mjs:34-38` 运行目录名含 `GITHUB_RUN_ATTEMPT`（`return `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}``），新尝试号是一个全新空目录；`scripts/ci/run-share.mjs:95-97` `get` 对本尝试目录取文件，取不到即 `CI_SHARE_MISSING` 失败（ci.yml:225-228、280-283 的取构建步骤）。即：新尝试里上游没重跑 → 新目录里没有 `build-linux-x64` → browser/coverage 的 get 必然失败，除非整轮重跑。这也和 `aggregate.mjs:91` 自己的口径（attempt 不符时报「rerun the complete workflow」）一致。
- **建议**：把该句改成「重跑失败作业会换新尝试号，已成功作业不重跑、其报告不在新尝试目录里，get 会以 `CI_SHARE_MISSING` 失败；要重跑请整轮重跑」。

### 2（低-中）「禁止 download-artifact」这条新硬规则的反向用例没有真正触达它
- **文件**：`test/tooling/policy.test.mjs:557-560`；`scripts/ci/check-policy.mjs:469-498`
- **证据**：反向用例推入的是 `{ uses: "actions/download-artifact@v4" }`，而 `validateWorkflow` 的逐步循环先断言「Action must use a full commit SHA」（check-policy.mjs:479-482），新规则在循环之后（495-498）。用例只 `expect(...).toThrow()`，所以会因 SHA 断言先失败——新规则本身从未被反向用例验证过。
- **建议**：反向夹具改用锁文件里 `actions/download-artifact` 的完整 40 位 SHA，让失败点落在 495-498 的规则上。

### 3（低）`collect` 部分缺失时静默成功，缺少机器可读的失败信号
- **文件**：`scripts/ci/run-share.mjs:117-129、153-156`
- **证据**：collect 把每个 `get` 的异常吞进 `missing` 数组，命令输出 `[`CI_SHARE_COLLECT ${collected}`, ...missing].join("\n")`，退出码 0。缺失的判定完全交给下一步 `required.mjs`（aggregate.mjs:48-55、172-176 确实会把缺失/上游非 success 判为失败，claim 3 成立）。目前有 `policy.test.mjs`/`ci-optimization.test.mjs` 锁住 collect→required 的步骤顺序（check-policy.mjs:499-514），所以现状安全；但这层安全依赖「两条步骤的顺序和存在」被硬规则锁住这一事实。
- **建议**：可接受；若想加固，collect 在 `missing` 非空时向 stderr 写一行明确提示（不改退出码），方便日志排查。

### 4（提示）运维侧把共享根目录的 setgid 弄丢时，报错不指向根因
- **文件**：`scripts/ci/run-share.mjs:40-47`
- **证据**：`sharedDirectory` 只检查目标运行目录自身的 mode，若已是 `2770` 就直接通过，不校验组归属；组继承完全依赖根目录 `/srv/gh-runner-share` 的 setgid（`install-runner.sh:95` `install -d -m 2770 -o root -g "$RUNNER_SHARE_GROUP"`）。根目录 setgid 丢失时新建子目录不继承 `gh-ci-share` 组，另一 runner 的 get/collect 会以文件系统 EACCES/ENOENT 而非 `CI_SHARE_*` 报错。重跑安装脚本可修复（GNU `install -d` 对已存在目录也应用 mode）。runbook 故障表已列 `CI_SHARE_ROOT_*` 的排查项，但未列 setgid 丢失这种症状。
- **建议**：runbook 故障表补一行「跨 runner 读不到对方文件 → `stat -c '%a %G' /srv/gh-runner-share` 应为 `2770 root gh-ci-share`，不对就重跑安装脚本」。

### 未核实项
- `main.yml`/runbook 的 `contract_sha256` 新哈希、GitHub 矩阵作业 outputs 的合并语义（claim 1 后半）、`SupplementaryGroups` 在实际服务重启后的生效、startup_failure 不再出现——这些依赖外部平台/运行环境，本仓库内无法验证。runbook 已把「重跑一次安装脚本、首轮验收看 `CI_SHARE_COLLECT 8`」写进验收步骤，与代码期望（8 个成员：policy、static、build、browser×3、coverage、security，见 `ci/policy.json` 与 `aggregate.test.mjs:127` 的 expected=8）一致。

## 侧重检查（测试覆盖、文档一致性、一条普通流程的走查）

**流程**：PR push → `ci.yml` policy（install-tools → install-dependencies → run.mjs → publish → `run-share put`）→ static/build → browser/coverage（`get build-linux-x64` → run → put）→ `required`（install-tools → collect → required.mjs → 上传 gate → `remove`）。

- 覆盖到的：`run-share.test.mjs`（put/get/collect/remove/摘要篡改/非法名/umask 独立性，均含反向）；`gate-lifecycle.test.mjs:500+`（CLI 真进程入口，篡改后退出码 1 且不留半份文件）；`policy.test.mjs`（put 唯一性、输出键=成员键、get/collect/remove 存在性与条件、权限只读，反向用例齐全）；`ci-optimization.test.mjs`（required 步骤顺序、任何 job 无写权限、I-93 反向）；`ci-runner-scripts.test.mjs`（clean-old 删 6 小时前目录、timer 每小时、单元模板 SupplementaryGroups/ReadWritePaths/HIMAWARI_CI_SHARE、安装回滚删组和目录、卸载 all 删组）。
- **没有测试覆盖的路径**：① 两个真实账号经 SupplementaryGroups 的跨账号并发读写（单元测试同 uid，只能靠 runbook 手工验收，runbook 验证第 5 条已补 `stat` 检查）；② 真实 GitHub 上矩阵各 leg 的 outputs 合并进 `needs.browser.outputs`（平台行为）；③ `required` 被 cancel-in-progress 取消导致 remove 未执行 → 依赖 clean-old 每小时兜底（clean-old 本身有测试）；④ 磁盘满时 put 在 staging 阶段失败（走 COPY_CHANGED/异常路径，staging 会被 `remove`/clean-old 清走，无单独用例）。
- 文档一致性：ADR 0201 状态改 superseded、设计文档与 incidents I-93 的更新都与代码一致（`main-workflow.mjs:60` 的 `full-inputs` 现在拒绝 `full` 带权限；`check-policy.mjs:432` 只在声明了 permissions 时校验，required 不声明即继承工作流级只读）。ADR 0238 提到 `quality.yml` 仍按 `report-` 模式下载（`quality-policy.mjs:188`）但已按 ADR 0176 停用——与代码一致。
- 约束核对：未发现代码注释（`run-share.mjs` 无注释）；job 数量与 DAG 未变（`check-policy.mjs:402-408` 强制 job 集合与 `ci/policy.json` 一致，needs 集合 415-418 一致）；未引入缓存/付费项。

## 作者说法逐条核对

1. **摘要核对**：成立（put 复制后复核 `run-share.mjs:84-87`，get 复制后复核 101-104，反向用例 run-share.test.mjs:81-101）。**矩阵 output 键互不覆盖**：代码侧正确（每 leg 只写自己的键），但依赖 GitHub 对矩阵作业 outputs 的合并行为，未核实——建议首轮运行后确认 `needs.browser.outputs` 三键齐全。
2. **成立**（代码侧）：组由根目录 setgid 继承（install-runner.sh:95），`sharedDirectory` 对 mode 已正确的目录不再要求属主（run-share.mjs:44-46），文件统一 660/2770（run-share.mjs:49-57、82-83），umask 007 且恢复（165-172，测试覆盖）。运行时双账号行为未实测。
3. **成立**：`aggregate.mjs:48-55`（needs result 非 success 即 fail）+ 172-176（缺失成员 fail）；collect 部分缺失不会导致通过。
4. **成立**：`record_created_paths` 只记不存在的路径（runners.sh:108-114），组只在新建议录（install-runner.sh:90-93），回滚删 created-paths 与 created-groups（runners.sh:160-170）；测试断言回滚后 `/srv/gh-runner-share` MISSING 且 groupdel 被调用。
5. **成立（代码侧）**：ci.yml 所有 job 无 permissions 声明、工作流级只读（ci.yml:21-23）；main.yml `full` 无权限（diff）；`validateCallerGrantsCalledPermissions`（main-workflow.mjs:14-37）会拒绝任何 job 重新申请写权限（反向用例更新）。「不会再 startup_failure」是对 I-93 规则的推断，最终以合并后实际运行为准。

## 必答问题

1. **不适用**。改动全部在 CI 工作流、CI 脚本和运维脚本，不触及任何发给模型的内容（系统提示、工具定义、历史、遮盖）；没有 CI 值被拼进提示词。发给模型的内容仍是只追加，结论：无影响。
2. **不会**。新增的摘要计算确定（路径按 localeCompare 排序、内容 SHA-256，run-share.mjs:59-65、artifact-files.mjs:40-71），只用于同一次运行内 put/get 两端核对，不跨请求比较，也不进模型请求。无带时间的字段进入任何共享输出。
3. **有**：`npm run check` 内的 `check:ci-policy`（check-policy.mjs、main-workflow.mjs）+ `test/tooling/{run-share,policy,ci-optimization,gate-lifecycle,ci-runner-scripts}.test.mjs`；反向用例大多真失败。例外见上面第 2 条发现：download-artifact 禁令的反向用例因 SHA 断言先失败，未触达新规则本身。
4. **逐值核对（产生端 → 使用端）**：`HIMAWARI_CI_SHARE`（单元模板 env → run-share.mjs:26-32 + runbook）；`gh-ci-share`（install-runner.sh:90-95 → SupplementaryGroups、目录组、uninstall/runbook）；`/srv/gh-runner-share`（install → ReadWritePaths、clean-old.sh、uninstall）；`RUNNER_SHARE_KEEP_MINUTES=360`（runners.sh:7 → clean-old.sh `-mmin +`）；输出键 `default/linux-x64/chromium/firefox/webkit`（put `--output-key "$CI_MATRIX"` → job outputs 映射 → `needs.*.outputs` → collect 的 `<job>-<member>` 命名；两端一致性由 check-policy.mjs:516-533（put 端命令与输出键=成员键）和 402-408（job id ≡ check id）共同锁死）；64 位十六进制摘要（treeDigest → 两端 `DIGEST` 正则）；错误码 `CI_SHARE_*` 与 runbook/ADR 文字逐一相符。唯一两端对不上的值是 ADR 0238 的「重跑失败作业不受影响」（发现 1）。
