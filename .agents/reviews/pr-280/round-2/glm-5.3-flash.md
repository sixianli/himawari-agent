# 复核报告（pr-280 第 2 轮，提交 abc09416）

说明：本检出为稀疏检出，`.agents/reviews/pr-280/round-1/` 的材料被工具拒绝读取，第 1 轮意见原文未核实；本轮意见按第 2 轮提交说明与代码逐条对照。本机不运行测试，作者声称的 Hermes 验证（退出码 0/1、152 项通过、`npm run check` 41 步）均标「未核实」。

## 侧重检查（走查的流程和结论）

从出包到上线的普通流程：`make-packet.py prepare`（Hermes，`--pi-tools` 取自 `builder.json` 的 `piToolBin`，make-packet.py:648 与 hermes/builder.json:10）→ Hermes 跑 `run-packet-checks.py`（新增 INSTALLED_PROBE 检查：安装候选压缩包、复制 bash/rg/fd、900 秒运行验收探测并核数）→ 冻结 → `deploy.sh` 本地跑包内 `check-packet-consistency.py` → 生产 S6 由 `run-network-preparation.py:163-164` 真跑 `adapters/probe-foreground.mjs`。
结论：新检查确实插在了「生成上线包时运行、生产验收之前会先拦下」的位置，能挡住 I-81 这类“断言与产品行为脱节”再次发生。走查中发现并核对的点（均读代码证实）：模板 `OWNED-SHA256SUMS`、`cloud-inputs.draft.json` 里 probe-foreground 相关哈希是旧值，但 `regenerate_hashes`（make-packet.py:467-481）出包时按实际文件重算、只保留成员列表，`check-packet-consistency.py:82-92` 校验的是渲染后清单，两端闭环成立，不出错；`probe-source/packages/runtime-pi/scripts/probe-foreground.mjs` 与 `packages/runtime-pi/scripts/probe-foreground.mjs` 逐字节相同（blob diff 为空）。没有测试覆盖的路径：生产 S6 本身（已知限制，I-81 已注明）、超时杀进程后的孤儿沙箱收尾（见下）、`check:secrets` 规则是否真会抓整段密钥字面量（本机未核实）。

## 问题清单（按严重度从高到低）

1. **低 | scripts/delivery-mode/run-packet-checks.py:131-134 | 超时只杀直接子进程，可能短时间内留下未释放的命名空间容器。**
   证据：`subprocess.run(..., timeout=INSTALLED_PROBE_TIMEOUT_SECONDS)` 超时后写 `INSTALLED_PROBE_TIMEOUT` 返回 1；探测进程（包内 probe-foreground.mjs:145-161）经 `prepareSandboxJobHost` 作为它的子进程启动各作业宿主和 bwrap 沙箱，SIGKILL 探测进程不会杀掉这些孙进程，它们要各自等 `deadlineAt`（≤60 秒）和 `cleanupTimeoutMs 5000` 才清理，期间每个沙箱命名空间未 released；探测自己的 `finally rm`（probe:356-358）也不会执行，`run_check` 的 `shutil.rmtree(scratch, ignore_errors=True)`（run-packet-checks.py:186-188）会绕过仍被占用的目录。**推测**（未在真实 Hermes 沙箱里验证孤儿实际存活时长；料想 60 秒内自清）。建议：验证孤儿行为；必要时超时改向进程组发信号，或接受并在 I-81 的“未覆盖”里写一句。

2. **低 | run-packet-checks.py:131-135 | 超时恢复时丢弃已读到的部分 stdout，只留 INSTALLED_PROBE_TIMEOUT 一行。**
   证据（读代码证实）：`TimeoutExpired` 分支不执行 `output.write(result.stdout)`，此前收集的部分输出（各 jobId/失败摘要已在 stderr 实时写入 output，损失有限）。建议：超时分支把已收到的 stdout 也写出；或至少在文档中说明诊断要靠 stderr。

3. **低 | scripts/delivery-mode/test_make_packet.py:1193-1236 | 两个新用例在 /usr/bin:/bin 没有 rg 的机器上静默退化。**
   证据（读代码证实）：`test_fd_comes_...` 和 `test_a_probe_that_never_returns_...` 都包在 `if shutil.which('rg', path='/usr/bin:/bin'):` 里，否则只断言 `found is None` / `code == 1`（而后者此时是 PI_TOOLS_MISSING 路径的返回值，不是超时路径），超时逻辑在 mac 上完全不测。这与已知限制（仅在 Hermes 有意义）一致，但值得在测试或 I-81 里点名，避免误以为本机也覆盖超时。

4. **信息（非本 PR 引入，顺带指出）** | scripts/delivery-mode/packet-template/acceptance/cloud/question-12-inputs.json:30/37 | 活模版的 `files` 映射里 `adapters/probe-foreground.mjs` 仍是旧哈希 2cbb0a9c、`probe-source/...` 仍是旧哈希 c5bc50f2（本 PR 改了这两个文件但没改这里）。
   证据（读代码证实）：全库检索只发现 basis-04 的历史脚本读取该文件的 `files` 映射；现行流程校验的是 `cloud-inputs.draft.json`（出包时刷新）与 `adaptation-manifest.json`（本 PR 已更新，且有新测试 test_make_packet.py:1243-1251 核对哈希↔文件）。且该映射在本 PR 之前就已与实际不符（行 43 audit=1a4a06b0 vs 实际 933cc99e，行 46 model、行 47 probe 同样），所以判定为死数据而非会算错包的值。建议：要么在文件里注明“历史记录、不校验”，要么把它纳入与 basis-04 相同的冻结快照，防止未来有人把它的更新当成必须项或反过来拿它当真。

5. **信息 | docs/incidents-and-gates.md:119 | I-81 措辞与代码一致，个别概括偏窄。**
   证据（读代码证实）：15 分钟=900（:37）、fd 只取 `--pi-tools` 目录/不存在或无 fd 即失败（:104-107,118）、bash/rg 取 /usr/bin:/bin（:106）、报告行数校验（:94-96）、不含 `HIMAWARI_QUALIFY_INSTALLED_RUNTIME` 且探测脚本确实不读它（probe-foreground.mjs:26 只读 `HIMAWARI_PROBE_RUNTIME`）、检查名=包内路径（:34,158）。偏窄处：说 `InstalledProbeCheckTest` “覆盖计划、判定和缺工具目录”，现在还覆盖超时、行数形态、manifest 哈希↔文件、计数来源；只是概括未更新，不构成错误。

作者说法核对结果：三份 probe-foreground.mjs（runtime-pi 源、adapters 拷贝、probe-source 拷贝）改动一致、basis-04 有意不动且 OWNED-SHA256SUMS/basis-04 记录把它当冻结快照——证实；INTENDED_CHANGES 恰加两个文件（test_make_packet.py:28）——证实；manifest 两个哈希更新——证实；`regenerate_hashes` 会重算 OWNED/cloud-inputs 哈希故模板旧值无害——证实。Hermes 实测数字未能核实。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。改动只涉及打包/验收工具、探测脚本、文档和复核记录；系统提示、工具定义、历史消息、遮盖结果均未触碰（probe 脚本输出只进包材料与验收报告，不发模型）。所有会变的值都在包/报告内部，不存在对请求前缀的追加或改写。
2. **同一段文字会不会变成不同字节？** 新增值全部是常量或静态哈希：900 秒（run-packet-checks.py:37）、期望计数 22 来自模板正则、manifest 两个哈希是文件内容的确定函数（并有对称测试核对）、密钥字面量按固定写法拆分（"sk-" + 固定后缀）。没有时间字段、没有依赖前后文的遮盖变化、没有无序集合进入发送内容。`pi_tools` 依主机文件系统取 bash/rg，只影响门槛通过与否，不影响发模型的字节。
3. **有没有对应的自动检查，反向用例会不会真失败？** 有两层。本地 `npm run check` 的 `check:delivery-packet`（package.json:43 指向 test_make_packet.py）覆盖：manifest 五个 adapter 哈希↔文件、判定正向/反向（reports 空列表、None、held、非 dict 行都返回具体拒绝码，test_make_packet.py:1208-1216）、计数来源=生产 runner 且恰为 22、`--pi-tools` 传参、缺工具目录在安装前失败。真正的运行层检查（跑候选包里的验收探测）只在 Hermes；反向证据是作者用 f0478c4d 旧断言跑新检查退出码 1（代码路径：rc≠0 → failed 列表 → `PACKET_CHECKS failed`+退出 1，run-packet-checks.py:136-141,236-241），沿用这一“第一次断言失败即整包失败”的机制。未核实之处：作者声称的 Hermes 复跑数字；`test_a_probe_that_never_returns_...` 的超时路径是单测逻辑验证，真实 bwrap 孤儿行为未验证（问题 1）。
4. **每个新值的生产端/使用端核对：**
   - `INSTALLED_PROBE_TIMEOUT_SECONDS`：:37 生成，:131 使用，测试 mock 同名常量——两端可接受。
   - `INSTALLED_PROBE` 名称/包内路径：:34/:158 生成，plan/日志名使用，文件真实存在，I-81 与之一致——可接受。
   - 期望计数 22：模板 run-network-preparation.py:164 生成（`pi['passed'] != 22`，恰一次由 :77-80 强制），probe 报告 `passed=reports.length`=22（我逐个数了 22 个 `run(...)`；useInstallation 时跳过最后两个不可用任务是既有行为），使用端 `expected_probe_count`+`installed_probe_problem`，测试两端断言——可接受。
   - manifest `sourceSha256 86870af8` / `adapterSha256 45248cdd`：生成+使用两端有校验（出包时 make-packet.py:435-441 对 git 提交核 sourceSha；本地测试对文件核 adapterSha；probe-source 拷贝与源逐字节相同）——可接受。
   - `--pi-tools`（`settings['piToolBin']`）：hermes/builder.json:10 生成、make-packet.py:648 传递、:200-225 接收、`pi_tools` 消费，缺目录/缺 fd 即失败；fd 只从该目录取与现有预检（run-release-walkthrough.sh:20 要求 toolbin 里有可执行 fd、rg 走 PATH 回退）语义一致——可接受。
   - `INTENDED_CHANGES` 两项：twelfth-frozen 逐字节回归要求，已加且无第三项遗漏（改动文件清单全含：manifest、adapter、probe-source 在列表内，run-packet-checks/test/doc/make-packet 属脚本不在 frozen 对比范围）——可接受。
   - `INSTALLED_PROBE_TIMEOUT` 字符串只写日志，无校验方——可接受。

## 结论

本轮增量（超时、fd 来源收紧、报告行数校验、哈希测试、I-81 措辞）与代码一致，未发现会算错包或拦不住旧断言回归的缺陷；均可合并。遗留的两点值得跟进：超时杀进程后孤儿沙箱在真实 Hermes 上的收尾行为未验证（低风险，60 秒内自清的推断），以及 `question-12-inputs.json` 的 `files` 映射是既存的死数据、建议明确其地位以防未来误用。
