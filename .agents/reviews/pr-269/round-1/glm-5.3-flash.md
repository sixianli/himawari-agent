# 复核结论（60dbe0cc）

先说核对结果：作者的 4 条关键说法与代码一致（两处失败根因、run-release-walkthrough.sh 的 hostname 检查位置、a3ebc700 的改动范围、接入后步骤数 33→34），没有发现「说法与代码不一致」的条目。下面按严重度列出问题。

## 问题清单（按严重度从高到低）

**M（中）｜scripts/delivery-mode/test_deploy.py、test_release_cleanup.py、test_rollback.py、test_untested_claims.py｜同类的 4 个 Python 测试文件仍没有任何自动运行点**
- 证据（读代码证实）：全仓 grep 只有 package.json:40 的 `check:delivery-packet` 引用 `test_make_packet.py`；scripts/ 目录下没有任何其他脚本、CI 工作流或策略文件引用这 4 个测试文件。scripts/git-hooks/commit-msg:4 会运行 `untested-claims.py` 这个被测工具，但不是它的测试。deploy、release-cleanup、rollback 是生产关键路径（install/rollback Docker 恢复、清理规则等，见 docs/adr/0120:89 登记），它们的门槛退化不会被发现。
- 建议：作者本次目标只声明 test_make_packet.py，不算说法错误，但这正是问题 4 指出的残留缺口；建议下一步把这 4 个文件也接入（接入方式与本次一致），或在 backlog 登记。

**L（低）｜test/tooling/run-all-checks.test.mjs:54｜接线断言只防「步骤被删」，不防「步骤被改成必过」**
- 证据（读代码证实）：断言只有 `expect(names).toContain("check:delivery-packet")` 加 line 55 的「每个名字对应一个脚本」；若之后有人把 package.json:40 改成 `python3 -I ... || true`，这条测试仍通过。反向用例（弄坏用例后 rc=1）只有作者在 Hermes 上手工做过一次（提交说明记载），没有固化为自动检查。
- 建议：可接受现状（unittest 失败退出非 0 是标准行为），但建议在 backlog 或提交说明里明确「全过时的反向验证只做了一次」这个事实，或以后加一条“步骤必须真退出”的固定反向用例。

**L（低）｜package.json:40｜`python3` 对执行环境的隐式依赖**
- 证据（读代码证实）：脚本直接用 PATH 里的 `python3`、测试内部用 `subprocess.run(['hostname'])`（test_make_packet.py:583）、`shutil.which('node')`（多处）。CI runner 全部钉在 hermes-home（scripts/ci/check-policy.mjs:70、209，macos-arm64 成员被暂停），与作者验证的主机相同，所以当前成立。
- 推测（未核实）：若按 ADR 0160 试跑后把 runner 换成别的主机，`python3` 或 `hostname` 不在时整步报错。当前不构成问题，仅提示。

**L（低）｜作者声称的「76 个用例」「约 7 秒」未核实**（允许的命令无法运行测试计数）。其余数字（34 步）可数算证实：check:steps 里 33 步 + 新步骤 = 34，与 `CHECK_ALL_PASSED 34 steps` 一致。

## 两处修法的针对性核对（读代码证实）

1. **preflight 用例**：根因成立——builder.json:2 的 hostname 是 `hermes-home`，run-release-walkthrough.sh:11 比较后相等即通过。修法让拒绝路径在任何主机上确定性触发（test:581-585），没丢原语义（「preflight 必须拒绝主机名不符」仍被验证）；工具缺失场景另有 test:776 的独立用例覆盖。断言正则也与消息格式吻合：fail 在写 stdout 之前（sh:11），refuse 的消息是单行 `PACKET_HERMES_PREFLIGHT_FAILED HERMES_WALKTHROUGH_FAILED HOST_UNEXPECTED`（make-packet.py:69-70、574-577）。
2. **模板对比用例**：根因成立——a3ebc700 只改了 packet-template/measurement/probe/bootstrap.mjs 的三行摘要（git show a3ebc700 stat 证据），且该提交就是 058293d1（PR 265 合并）的一部分；twelfth-frozen-sha256.json:109 含该文件，故落在 test:327 的逐文件摘要比对。加进 INTENDED_CHANGES 遵循既有机制（ADR 0086:98 明文要求“改模板时要同时改有意改动清单”），且没有丢验证物：这个文件的真实摘要另有出包检查钉住（check-packet-consistency.py:116 `PROBE_DIGEST_STALE`，出包时经 run-packet-checks 在 Hermes 跑），白名单只放松「对冻结快照逐字节相同」这一层。

## 侧重检查

我走的一条最普通流程：在 Hermes 上改交付脚本 → 提交（commit-msg 钩子）→ 本地 `npm run check` → run-all-checks.mjs 读 check:steps → 到最后一步 `check:delivery-packet`（python3 -I 加载 test_make_packet.py，渲染模板、跑 12 个 TestCase 类，时长约 7 秒）→ 退出码聚合为 `CHECK_ALL_PASSED 34 steps` / `CHECK_FAILED`。
- 已覆盖段：run-all-checks 的收集/汇总逻辑（run-all-checks.test.mjs:8-48）、接线存在性（:50-55）、以及 test_make_packet.py 全文件本身（本次接入后）。
- 无覆盖、也未跑到的代码路径：上面 M 条列出的 4 个兄弟测试文件及 package.json 已定义却不在 check:steps 的 `check:srt-boundary`（它出包时经 run-packet-checks 运行，算有别的运行点）等脚本。此外测试全部只在 Hermes 上自动运行（delivery-mode.md:21 规定），CI 同为 hermes-home 自托管 runner（check-policy.mjs:209），与该流程一致。
- 文档一致性：ADR 0086:98 的“改模板要同步改 INTENDED_CHANGES”与本次修法一致；未发现描述 check 步骤清单/数量的文档需要同步（grep 未见 "33 steps/34 steps" 类文字）。

## 必答问题逐条回答

1. **不会改变模型已见过的请求开头。** git diff 显示改动只有 package.json、test_make_packet.py、run-all-checks.test.mjs 三个文件，不触及系统提示、工具定义、历史或遮盖（prompt-prefix 相关步骤 check:prompt-prefix 在列表中原样保留）。本次改动根本不组装任何模型请求，规则（prompt-prefix.md §2/§4）不适用，但结论同样是“无需动模型请求”。
2. **不会产生跨请求字节漂移。**（读代码证实）新增值只有两处：INTENDED_CHANGES 里的静态文件名（test:32）和测试运行时读 `hostname` 的输出（test:583）——后者只写进临时目录的 builder.json 副本，不进任何发给模型的字节；模板渲染比对的输入（twelfth-parameters.json、冻结摘要、模板文件）在本次改动中未变，同一次 checkout 字段确定。
3. **有对应自动检查，且反向会失败**，含两层：接线层——删除 `check:delivery-packet` 会让 run-all-checks.test.mjs:54 失败（读代码证实 toContain 语义）；测试层——unittest 失败退出非 0 → npm → runAllChecks 记为 CHECK_FAILED（run-all-checks.mjs:16-26）。测试层的反向用例只有作者手工验证过一次（把第十二版对比用例改坏后 rc=1，依作者在 Hermes 的验证记录）、我没有条件复跑，且没有自动化用例防「步骤被改成必过」（见 L 条）。
4. **每个值的产生端和使用端都能接受**（逐个核实）：
   - `check:delivery-packet`（package.json:40）→ 使用处：check:steps（第 27 行，run-all-checks.mjs:8 的正则可解析）和 run-all-checks.test.mjs:54-55；两端一致。
   - INTENDED_CHANGES 新键 `measurement/probe/bootstrap.mjs`（test:32）→ 使用处：test:327 的集合比对；该路径确实在渲染输出内（twelfth-frozen-sha256.json:109 存在同一键且 test:326 先断言路径集合相等）；文件真实摘要在另一端仍有 check-packet-consistency.py:116 钉住，对照 I-73 的教训，这次把“清单里的文件能否过两端校验”问到了。
   - 测试写入临时 builder.json 的 hostname（test:583）→ 使用处 run-release-walkthrough.sh:11 的比较；值必不匹配、流程语义一致；真实上线流程的 builder.json 由 install_scripts() 原样上传（make-packet.py:579-582），测试改动不影响它。
