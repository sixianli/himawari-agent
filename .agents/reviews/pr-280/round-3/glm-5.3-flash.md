合并增量里 `scripts/delivery-mode/`、`docs/incidents-and-gates.md`、`packages/runtime-pi/` 都没有变化，只有 `.agents/instructions/delivery-mode.md` 一行改了 CI 主机指引。下面看本 PR 自己的改动全文。
出现一个关键疑点：`adaptation-manifest.json` 改了哈希，但引用它的几个清单（OWNED-SHA256SUMS、cloud-inputs.draft.json、question-12-inputs.json）还在本 PR 未改的文件里。先看这些清单谁在校验。
疑点升级：`question-12-inputs.json` 里 `adapters/probe-foreground.mjs` 和 probe-source 副本的哈希还是旧值，而这个文件本 PR 未改。需要确认 `inputs/check-packet-consistency.py`（deploy 时本地跑）是否校验这份清单。
最后补两个核对点：`test_deploy.py` 里 record 的名字清单是否用包含 hermes-only 检查的 plan 生成，以及 probe 报告行数（22 项场景）与测试锚定值一致。
复核完成。先给结论，再给证据。

## 发现的问题（按严重度从高到低）

**1.【低】`docs/incidents-and-gates.md:119` —— I-81 对失败条件的描述不完整**
问题：I-81 写“工具目录不存在或里面没有 fd 时检查失败”，但代码里 `pi_tools` 是三项都查：`run-packet-checks.py:79` `found = {'bash': shutil.which('bash', path='/usr/bin:/bin'), 'rg': shutil.which('rg', path='/usr/bin:/bin'), 'fd': shutil.which('fd', path=directory)}`，`if not directory or not Path(directory).is_dir(): return None`（78 行）+ `return found if all(found.values()) else None`（80 行）。bash 或 rg 在 `/usr/bin:/bin` 找不到时同样失败。
证据：如上所引。建议：补半句“或系统目录里没有 bash/rg”。

**2.【低】`run-packet-checks.py:103-106` —— 探测超时杀进程时不走生产的清理方式，残留可能留在原地**
问题：`subprocess.run(..., timeout=INSTALLED_PROBE_TIMEOUT_SECONDS)` 超时杀的是直接子进程（node），生产的探测链路（`packet-template/acceptance/cloud/run-network-preparation.py:59`）每个子命令都包了 registered cleanup helper（`--owned-processes` 清理帮手）；新检查没有。被杀后已装候选副本（`scratch/prefix`）和可能未释放的沙箱命名空间留在 `/tmp/hXXXX` 里，直到 /tmp 清理；报告里的“命名空间已释放”是从探测自己的输出断言的，不是安装后独立复核。
证据：`run-packet-checks.py:103-108`（subprocess.run 全文）、`run-network-preparation.py:59-60`。这属于测试性残留，不影响“失败即拒绝上线包”的判断（返回码 1）。建议：超时分支之后补一次对 scratch 目录的删除或在 I-81 的“未覆盖”里写明这一条。

**3.【信息】`packet-template/acceptance/cloud/question-12-inputs.json:30,37,49,53` —— 内嵌哈希是旧值，且没有自动校验消费它**
问题：该文件 `files` 字典里 `adapters/probe-foreground.mjs` 仍是旧哈希 `2cbb0a9c…`（新值是 `45248cdd…`），probe-source 副本仍是 `c5bc50f2…`（新值 `86870af8…`）。我沿消费链查了：`check-packet-consistency.py`（35-44 行）只核 `cloud-inputs.draft.json['files']` 和各 `OWNED-SHA256SUMS`；`finalize-cloud-inputs.py:59`、`run-network-preparation.py:74`、`run-question12-downloads.sh:58` 读的都是 cloud-inputs 这一份；当前版 `check-entry-paths-06.py` 不读 question-12-inputs.json（读它的是 basis-04 自己的脚本）。所以这次不会像 I-81 那样在生产验收里爆炸——但这是一处“没有人读所以没人发现过期”的字段。
证据：如上。建议：如果当前模板确实没有消费者，在 `regenerate_hashes`（`make-packet.py:467`）里一并覆盖，或在文件里注明该 `files` 字典已被 cloud-inputs 取代。
（附：`cloud-inputs.draft.json:59,64,97` 和 `acceptance/OWNED-SHA256SUMS` 里同样是旧哈希，但这两个会被 `make-packet.py:467-481` 的 `regenerate_hashes` 在打包时按真实字节重算，封包后一致，不算问题。）

**4.【信息】合并增量核对（第 3 轮要点）**
`git diff abc09416..fbac0836` 里 `scripts/delivery-mode/`、`docs/incidents-and-gates.md`、`packages/runtime-pi/` 为空——本 PR 自己的改动没有被 main 的改动碰过；唯一涉及交付文档的冲突性修改是 `.agents/instructions/delivery-mode.md` 一行（CI 从 Hermes runner 改指 ADR 0176/VPS，属 main 内容，与上线包仍在 Hermes 构建的描述不矛盾，`builder.json` 的打包路径未动）。`I-81` 在 docs 中只出现一次，无重复编号。main 把 runner 目录从 `hermes-runner` 改名 `ci-runner`，`run-iapcket-checks`/`make-packet` 无引用，不受影响。

## 读代码证实的与作者说法一致的部分

- 三份 `probe-foreground.mjs`（源、模板 adapter、模板 probe-source 副本）都改成“退出码 0、输出原样”：共三处 diff，`assert.equal(secret.result.exitCode, 0)`、`assert.equal(secret.output, "sk-" + "abcdefghijklmnopqrstuv\n")`；`basis-04/probe-foreground.mjs` 确实未改。
- 场景数 22：probe 在 `useInstallation=true` 时跳过 316/318 两项，实际 `run()` 调用 22 次，与 `run-network-preparation.py:164` 的 `pi['passed'] != 22` 一致；测试也锚定 `expected_probe_count(template) == 22`。
- probe 不读 `HIMAWARI_QUALIFY_INSTALLED_RUNTIME`（通读 `packages/runtime-pi/scripts/probe-foreground.mjs`，环境变量只读 `HIMAWARI_LIVE_SANDBOX_PROBE / PROBE_RUNTIME / PROBE_SCRATCH / PROBE_FD / RG / BASH`），I-81 的解释成立。
- scratch 约束成立：`short_scratch()`（42-50 行）造 `/tmp/h<4位>`、0700、同 uid；与 `scratch-root.mjs:5-15` 的正则、owner、mode、`TMPDIR/HIMAWARI_TEST_TEMP_ROOT` 一丒豁验完全吻合。
- `--pi-tools ↔ piToolBin` 两端配对：`make-packet.py:648` ↩ `hermes/builder.json:10`，缺目录时返回 1 且不装东西（有测试）。
- 旧上线包会被拒：`generated-packet-gate.py:32-36` 用当前 `plan(..., True, …)` 要求 record 里每个检查 exit 0，旧 record 缺新检查时报 `PACKET_CHECK_NOT_PASSED … null`——“合并后需重新生成”是真的。
- 第 2 轮四项修改全部到位：900 秒（37 行 + 超时测试）；fd 只从 `--pi-tools`、bash/rg 只从系统目录（79 行 + 测试）；报告行数与行内容校验（94-98 行 + 6 个失败用例）；`test_every_adapter_hash_in_the_adaptation_manifest_matches_its_file` 新增并覆盖 5 条 adapter 条目。

## 侧重检查（测试覆盖、文档一致性、普通流程）

流程：`make-packet.py prepare`（模板渲染、adapter_drift、重算哈希）→ Hermes 上 `run-packet-checks.py --pi-tools`（新检查：装候选、复工具、按生产环境变量跑 adapter、核报告）→ `record.json` → freeze → deploy（generated-packet-gate / check-packet-consistency）→ 生产 S6 验收里 `run-network-preparation.py` 再跑同一 adapter。
- 测试覆盖：判定逻辑、计划位置、缺工具、超时、哈希↔文件、清单同步（数量单源）都有单测，属 `check:delivery-packet`（`npm run check`）。
- 无自动化覆盖（标出）：① 新检查的未被 mock 的真实路径（真实装候选+真跑迭代探测）——只在 Hermes 手动跑过一次（I-81 复现记录）；② 生产 Ubuntu 24.04 上从未自动执行过这批探测，仍以生产验收首跑为准（I-81 已写明）；③ deploy 门“缺一项检查”对 installed probe 具体的反向断言（用例构造 record 时用同一 plan 生成名字，等于同源，未单独模拟缺检查的失败）。
- 文档与代码一致：除第 1 条的低级措辞差异外，I-81 其余陈述（检查名、环境变量、15 分钟、计数来源、qualification、行数、命名空间）与代码逐条对上。
- 作者声称的“npm run check 41 步 / 149→152 项”、“Hermes 新旧脚本退出码”无法在本地核实，标未核实。

## 必答问题

1. **不会改变模型见过的请求开头。**改动只有验收/打包脚本、探测脚本和 incident 文档；没有任何系统提示、工具定义、历史或遮盖代码被改（diff 文件清单核实）。发给模型的内容仍然是只在末尾追加，无新会变的值进入请求。
2. **不会。**本 PR 没有触及任何请求序列化或遮盖路径；新引入的随环境变化的值（record 里的 `seconds`、probe 报告里的 `nodeVersion/toolDigests/platform`）只进上线包证据与日志，不进模型请求。
3. **有自动检查，反向用例真实失败。**`InstalledProbeCheckTest` 13 个用例含明确反向（两个计数、资格签发、held 命名空间、行数不符、无报告、缺工具、超时），从断言本身可确认对应分支会返回 1；端到端反向（旧断言跑新检查退出 1）只在 Hermes 手动复现一次，未自动化——I-81 已如实标注这一限制。
4. **每个新值两端都核过，可接受。**检查名（`plan()` 单源 → record → `generated-packet-gate`/`test_deploy` 同源消费，旧包会被拒）；`--pi-tools` ↔ `builder.json:piToolBin`；`HIMAWARI_PACKET_PI_TOOLS`、`INSTALLED_PROBE_*` 只在检查器内部；manifest 两个哈希由 `adapter_drift`（`make-packet.py:439`）对打包提交逐一核对、adapter 哈希另有逐文件测试；probe 来源/adapter 条目还有“打包提交里文件必须与 manifest 相符”的测试。唯一的缺口是第 1、3 条列出的文档措辞和无人消费的过期哈希，均为低危/信息级。
