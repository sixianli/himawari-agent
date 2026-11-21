## 复核结论

以下按严重度从高到低排列。每条都注明「证实」（我亲自读到的代码）与「推测/未核实」；未运行任何测试，凡涉及运行结果的地方都只作静态推断。

### 1 高（潜在）Python 材料仍钉在 x86_64，ARM 包要么被拒、要么装错架构，与 ADR 的 PR 1 说法矛盾
- 文件:行：`scripts/delivery-mode/make-packet.py:50`、`:550`；`scripts/delivery-mode/packet-template/install/p5-materials.json:26-28`；`ci/toolchain-lock.json:70-78`；`docs/adr/0283-move-production-to-the-oracle-arm-machine.md:70`。
- 问题：这次只把 Node 摘要、fd、`/lib64`、服务账号参数化了，Python 归档仍写死 x64；ADR 却说 PR 1 要「Node 和 Python 按平台从 `ci/toolchain-lock.json` 取」。
- 证据：
  - `make-packet.py:50`：`PYTHON_MATERIAL = ('python-3.12.10.tar.gz', 'f50d08e0304b15d752b22932047135c1dc02f81977b284e51288be9d90627bca')`；`:550` 用它做 `PACKET_PYTHON_MATERIAL_CHANGED` 校验。
  - `p5-materials.json:26-28` 仍写死 `"bytes": 34392187` 和同一个 `sha256`。
  - `ci/toolchain-lock.json:70-73` 的 `f50d08e0…` 是 `linux-x64` 的 Python；`:75-78` 的 `linux-arm64` Python 摘要是 `235d0666…`，与上面不同。
  - `platforms.json`/`platform_parameters()` 里没有任何 Python 字段（`make-packet.py:427-446`）。
- 影响（证实）：ARM 构建即使提供了 ARM 的 Python 归档，`describe_materials` 也会因摘要不等于 `f50d08e0…` 直接 `PACKET_PYTHON_MATERIAL_CHANGED`；若放宽校验，包会带上 x64 Python，`install/__PKT_LABEL__-artifact-install.mjs:53` 会在 ARM 上安装并运行 x64 Python。目前 ARM 因 fd 未钉住会先被拒，所以是潜在问题而非当前线上故障。
- 建议：把 Python 归档名/字节数/摘要放进 `platforms.json` 和 `platform_parameters()`，同时替换 `PYTHON_MATERIAL` 与 `p5-materials.json` 的写死值，并加 ARM 用例；或者明确把 Python 参数化移到 PR 2/3 并改掉 ADR 的 PR 1 说法。

### 2 中 ARM「不留 x64 痕迹」的测试不成立；包内仍有 `/lib64` 和 `linux-x64`
- 文件:行：`scripts/delivery-mode/test_make_packet.py:524-542`；`packet-template/acceptance/cloud/adapters/probe-foreground.mjs:100`、`probe-authorized-network.mjs:81`、`probe-network-boundary.mjs:72`、`probe-linux-worker-loss.mjs:35`、`probe-public-search.mjs:40`；`packet-template/acceptance/cloud/basis-04/run-stage-03.py:253,260,478`；`basis-04/candidate-inputs.json:2`；`fixtures/twelfth-parameters.json:4`。
- 问题：测试名和作者说法是「arm64 渲染不留 x64 痕迹」，但测试只检查了 4 个旧值，ARM 渲染结果里仍保留大量 x64 专用内容。
- 证据：
  - `test_make_packet.py:528` 的 `self.render(**arm64)` 只是把 `platform_parameters()` 的 9 个键覆盖到 `TWELFTH` 上；`TWELFTH['ARTIFACT_NAME']` 仍是 `linux-x64-abi127-…`（`twelfth-parameters.json:4`），会渲染进 `p5-materials.json`、`S9-clean-transport.py` 的 `ARCHIVE_NAMES`。
  - 循环（`:529-535`）只断言没有 `e6ec2c…`、`761c72…`、`e79642…`、`x86_64-unknown-linux-musl`、`process.arch === "x64"`、`\b999\b|\b988\b`；**没有**检查 `linux-x64`，也**没有**全局检查 `/lib64`（只在 `:541` 检查了 `cloud-seal.mjs`）。
  - 渲染后仍保留 `/lib64` 的文件包括 `acceptance/cloud/adapters/*.mjs` 和 `basis-04/*.mjs`；`basis-04/run-stage-03.py:253,260,478` 仍匹配/读取 `linux-x64`、`build-linux-x64`。
- 影响：ARM 包里的验收脚本仍是 x64 形状，在目标机没有 `/lib64`、也没有 `build-linux-x64` 的情况下验收会失败；测试却会通过。ADR 第 70 行确实把 `acceptance/cloud/adapters/`、`basis-04/`、`probe-source/` 的改动推到 PR 3，所以这是已知延期，但测试名/说法夸大了 PR 1 的能力，也没有反向用例能发现这些残留。
- 建议：把测试名和结论收窄为「本 PR 参数化的子集」；对应当清理的文件显式断言无 `linux-x64`/`/lib64`；把延期文件列成清单并加一个「剩余 x64 痕迹」白名单测试，避免以后误以为 ARM 包已可用。

### 3 中 x64「逐字节不变」没有被这次改动的文件直接覆盖
- 文件:行：`scripts/delivery-mode/test_make_packet.py:26-37`（`INTENDED_CHANGES`）、`:324-329`（对 `TWELFTH_FROZEN` 的 golden 比对）、`:502-511`（新 x64 测试）。
- 问题：作者说新测试验证「x64 渲染和改动前逐字节相同」，但新测试只抽查了几个子串；真正的 golden 测试又把本次改到的大多数文件排除在比对之外。
- 证据：
  - `:324-329` 只要求「不在 `ADDED_FILES` 且不在 `INTENDED_CHANGES` 的文件」等于 `TWELFTH_FROZEN`。
  - `INTENDED_CHANGES`（`:26-37`）包含 `signing/cloud-seal.mjs`、`systemd/S7-startup-readback.mjs`、`install/S9-clean-transport.py`、`steps/run-step.py`、`acceptance/cloud/download-question-12.py`、`run-question12-downloads.sh`、`inputs/bindings.draft.json`、`maintenance/S9-control-files.py` 等——本次改动的大部分文件都在里面，因此这些文件的 x64 字节变化不会让任何测试失败。
  - `:502-511` 只检查 `S7-startup-readback.mjs` 里含 Node 摘要、`cloud-seal.mjs` 里含 `"/lib64",`、`collect-installer-dependencies.mjs` 里含 `process.arch === "x64"`、`download-question-12.py` 里含 `x86_64-unknown-linux-musl`、`S2-stop-and-inspect.py` 里 `999/988`。
- 影响（推断）：我逐处核对了替换值，x64 下占位符都渲染回原字符串，理论上逐字节不变；但这是静态推断，没有测试能保证这些被改文件的完整字节没变（例如多一个空格、少一个换行都不会被发现）。
- 建议：给本次改到的每个文件加一份「改动前 x64 渲染」的哈希基线并逐文件断言，或直接对比上一提交的渲染结果；不要只依赖子串抽查。

### 4 中/低 `platform_parameters` 不校验类型/范围，且把值原样插进 root 运行的脚本
- 文件:行：`scripts/delivery-mode/make-packet.py:427-446`；`render()/substitute` 在 `:512-518`。
- 问题：`serviceUid`/`serviceGid` 和平台字段没有类型、范围、格式校验，直接 `str()` 后插进 Python/JS/shell；缺键时抛 `KeyError` 而不是 `PACKET_*`。
- 证据：`:445-446` 直接 `fixed['serviceUid']`、`fixed['serviceGid']`；`:438-443` 直接取 `platform[...]`；`substitute()` 用 `str(parameters[key])` 替换，不区分字符串/数字/源码片段。若实例文件写成 `"serviceUid": "999); ..."` 或平台字段不是预期类型，会在生产 root 脚本里形成语法错误甚至代码注入，而不是被拒绝。
- 影响：实例文件与 `platforms.json` 是仓库内容，威胁模型与直接改脚本同级，所以不是新的提权面；但这是新引入的「未校验值 → root 脚本」路径，和项目其它地方的严格校验风格不一致。
- 建议：校验 uid/gid 是正整数且在上限内，平台字段是预期类型、摘要为 64 位十六进制、三元组/架构在白名单内；缺键/类型错用 `PACKET_PLATFORM_INVALID`、`PACKET_SERVICE_ACCOUNT_INVALID` 拒绝。除 `LIB64_ITEM` 这个有意做源码片段的例外，其余值尽量用带引号的安全序列化。

### 5 低 Node/fd 摘要与 `ci/toolchain-lock.json` 重复且无交叉校验；ARM 摘要未核实
- 文件:行：`scripts/delivery-mode/platforms.json:4,10`；`make-packet.py:429-446`；`ci/toolchain-lock.json:18-27`；ADR `:70`。
- 问题：ADR 说 Node/Python 按平台从工具链锁取，但代码根本不读 `ci/toolchain-lock.json`，而是在 `platforms.json` 里另存一份 Node 二进制摘要和 fd 摘要。
- 证据：`ci/toolchain-lock.json:23-26` 只有 Node 压缩包摘要 `cc8bc82b…`；`platforms.json:10` 是解压后二进制摘要 `41c1ec75…`，两者不是同一层级，无法从锁直接推出。代码里没有任何 `toolchain-lock` 读取或比对。ARM 的 Node 二进制摘要 `41c1ec75…` 和 fd 压缩包摘要 `d76c4317…` 我无法离线验证（未核实）。
- 影响：工具链升级后 `platforms.json` 不会自动跟随，可能悄悄要求旧二进制；错误摘要会在安装/启动时失败（fail-closed），但会浪费一次构建/部署。ADR 的「从 toolchain-lock 取」表述不准确。
- 建议：要么从 `ci/toolchain-lock.json` 派生/交叉校验 Node/fd 摘要，要么加一个测试用锁定的压缩包重新计算并比对；在 PR 里注明 fd ARM 资产摘要的来源。

### 6 低 `question-12-inputs.json` 内部的 `files` 哈希不会被重新生成（ARM 潜在过期）
- 文件:行：`scripts/delivery-mode/make-packet.py:687-702`；`packet-template/acceptance/cloud/question-12-inputs.json:48-63`。
- 问题：`regenerate_hashes()` 只更新 `cloud-inputs.draft.json['files']` 和四个 `OWNED-SHA256SUMS`，不更新 `question-12-inputs.json` 自己的 `files` 映射；里面列着 `run-network-preparation.py`、`download-question-12.py`、`run-question12-downloads.sh` 的哈希，这些文件在 ARM 下会变。
- 证据：`:690-691` 只遍历 `cloud-inputs.draft.json` 的 `files`；`:694-702` 只重算 `OWNED_SUMS`。`question-12-inputs.json:49-50,62` 是另一份独立哈希表。x64 下这些文件渲染后与旧版相同，所以当前不会失败；我也没有找到主 `question-12-inputs.json` 的 `files` 映射在运行链里被读取（`basis-04/check-entry-paths-06.py` 读的是它自己目录的副本），所以目前是潜在问题（未核实是否有仓库外消费者）。
- 建议：在 `regenerate_hashes()` 里一并重算该映射，或删掉这份冗余映射；加一条一致性测试。

### 7 低 `run-packet-checks.py` 对缺失 `PLATFORM` 会抛 `KeyError`，且直接拿它做 glob
- 文件:行：`scripts/delivery-mode/run-packet-checks.py:165-170`。
- 问题：`json.loads(... )['PLATFORM']` 对旧包/被裁剪的 `packet-parameters.json` 不是干净拒绝；`PLATFORM` 也没有白名单校验就直接拼进 glob。
- 证据：`:166` `platform = json.loads((packet / 'packet-parameters.json').read_text())['PLATFORM']`；`:167` `glob(platform + '-abi127-*-1.tar.gz')`。新生成的包一定有这个键，所以严重度低。
- 建议：用 `.get('PLATFORM')`，缺失时给 `PACKET_CHECKS_PLATFORM_MISSING`；并用已知平台名白名单校验后再 glob。

---

**侧重检查**

- 错误路径：`PACKET_PLATFORM_UNKNOWN`、`PACKET_PLATFORM_UNPINNED` 实现正确，测试也覆盖了未知/缺失平台和 ARM 未钉住值（`test_make_packet.py:520-522,544-547`）。但缺键、类型错会变成 `KeyError`/运行时语法错误，不是 `PACKET_*` 拒绝（第 4、7 条）。
- 不合规范/不可信输入：实例文件和 `platforms.json` 的值被原样插入 root 脚本，没有类型/范围/格式校验；`PLATFORM` 也未做白名单校验（第 4、7 条）。fd 的 ARM URL/摘要无法离线核实（未核实）。
- 安全：没有新增机密、网络下载或提权路径；`SERVICE_UID/GID` 等值来自仓库文件，威胁模型与直接改脚本同级，未发现新的权限扩大。但原始插值确实把「配置错误」放大成「root 脚本代码注入/语法错误」。
- 资源耗尽：没有新增循环或大文件读取；`platforms.json` 很小，`render` 逻辑未变；未发现新的资源耗尽面。
- 不可撤销操作：本 PR 只做出包/模板/测试，没有执行生产写操作；ARM 未钉住时在构建前就拒绝，属于 fail-closed。
- 规则/文档与代码一致性：ADR 的「Node 和 Python 按平台从 `ci/toolchain-lock.json` 取」与代码不符（Python 完全没参数化，Node 摘要另存且不读锁）；「ARM 渲染不留 x64 痕迹」的测试说法与代码不符（第 1、2、5 条）。`scripts/platform-assumptions.json` 的改动我逐项核对过，计数与代码一致：`make-packet.py` lib64=2、`fixtures/twelfth-parameters.json` lib64=1/linux-x64=2/x86_64=1、`platforms.json` lib64=2/linux-x64=1/x86_64=1、`test_make_packet.py` lib64=2/linux-x64=8/arch-x64=2/x86_64=2、`andy-production.json` linux-x64=1；移除的旧条目也确实不再出现。

**必答问题**

1. **会不会改变模型已经见过的请求开头？不会。** 这次 diff 只改出包模板、出包脚本、测试、`platform-assumptions.json`、ADR 和复核材料，没有改系统提示、工具定义、历史消息或出口遮盖的组装代码。依据 [prompt-prefix.md](.agents/instructions/prompt-prefix.md) 第 1–4 条，模型内容仍是工具定义→系统提示→历史→最后一条用户消息，只在末尾追加；本 PR 没有把每轮会变的值塞进请求开头。未核实的是 `.agents/reviews/...` 这些复核材料是否被送给复核模型——它们本身是复核记录，不是生产请求。

2. **会不会让同一段文字在不同请求里变成不同字节？不会引入请求级不确定性。** 改动产生的值都来自静态文件；`unpinned` 用 `sorted`，`describe_materials` 用 `sorted`，`packet-parameters.json` 用 `sorted(parameters.items())`，`material_cache` 用 `sort_keys`，没有时间字段或无序集合。`platforms.json` 本身在两次构建之间被改会改变产出，但那是配置变更，不是同一请求/同一实例下的不确定性。这些脚本也不是模型输入。

3. **有没有对应的自动检查，反向用例是否真的会失败？部分有。** 真正的反向用例存在且会失败：`PACKET_PLATFORM_UNPINNED`（用真实 ARM 的 `fdBinarySha256: null`）、`PACKET_PLATFORM_UNKNOWN`（未知/缺失平台）、`PACKET_ARTIFACT_COUNT 0`（平台决定候选包）。但「x64 逐字节不变」没有直接覆盖本次改到的文件（第 3 条），「ARM 不留 x64 痕迹」也不会被剩余 `/lib64`/`linux-x64` 触发失败（第 2 条）。

4. **每个新值的生产者和消费者是否都能接受？** 逐项核对：
   - `PLATFORM`：生产者是实例文件 `host.platform` + `platforms.json`；消费者是 `describe_materials`、`candidate_values`、`run-packet-checks.candidate_archive`。`linux-x64`/`linux-arm64` 都能被接受；但缺失键会 `KeyError`（第 7 条）。
   - `NODE_ARCH`/`NODE_SHA256`/`FD_TRIPLE`/`FD_SHA256`/`FD_BINARY_SHA256`/`SERVICE_UID`/`SERVICE_GID`：x64 都渲染回原值，消费者（JS/Python/shell/JSON）都能接受；ARM 下服务账号、Node、fd 字段在语法上也能被接受。
   - `LIB64_ITEM`：只用在 JS 数组里（`cloud-seal.mjs:342`、`read-driver.mjs:43`）。空串时 `cloud-seal.mjs` 变成一行空白、`read-driver.mjs` 变成 `"/lib",  "/proc"`，语法都合法；没有 JSON 用法，作者的重点 3 成立。
   - 但 Python 材料仍是 x64（第 1 条），ARM 验收副本仍含 `/lib64`/`linux-x64`（第 2 条），所以 ARM 的「生产—消费」链并不完整。
   - `platform-assumptions.json` 的计数与代码一致（见侧重检查）。
   - `question-12-inputs.json` 内部 `files` 哈希不会随 ARM 重新生成（第 6 条，潜在）。
   - 另外（推测/未核实）：`linux-arm64` 这个平台名不在 `ci/policy.json` 的 build targets，也不在 `ci/result.schema.json:233`、`ci/evidence.schema.json:123` 的枚举里（只有 `linux-x64`/`macos-arm64`）。如果 PR 2 的 ARM 构建走现有 CI 结果/证据路径，会被 schema 拒绝；若走 ADR 说的目标机独立构建账号，则可能不受影响，需要 PR 2 确认。
