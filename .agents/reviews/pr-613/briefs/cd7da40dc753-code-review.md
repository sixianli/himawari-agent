# PR 613 第 1 轮复核材料

这是 ADR 0283（`docs/adr/0283-move-production-to-the-oracle-arm-machine.md`，生产从 Contabo 的 x86-64 机器迁到 Oracle 东京的 ARM64 机器）五个 PR 里的第 1 个：上线包的目标平台和服务账号改由实例文件决定，现有 x64 生产的产出要逐字节不变。

改了什么：

- `scripts/delivery-mode/platforms.json`（新增）：`linux-x64` 和 `linux-arm64` 两项，各写 Node 架构名、Node 二进制摘要、fd 的目标三元组和压缩包摘要、fd 解压后二进制摘要、是否有 `/lib64`。ARM 的 fd 解压后摘要还没钉住，写 `null`。
- `scripts/delivery-mode/make-packet.py`：新函数 `platform_parameters(instance)` 读实例文件的 `host.platform`，不在表里报 `PACKET_PLATFORM_UNKNOWN`，有 `null` 值报 `PACKET_PLATFORM_UNPINNED`；服务账号的 uid/gid 从实例文件的 `fixedByTemplate` 取。候选包的文件名匹配从写死的 `linux-x64-abi127-…` 改成按平台。
- `scripts/delivery-mode/run-packet-checks.py`：`candidate_archive` 从 `packet-parameters.json` 读 `PLATFORM`。
- `scripts/delivery-mode/instances/andy-production.json`：加 `"platform": "linux-x64"`。
- `packet-template/` 下 38 个文件：写死的 999/988、x64、Node 和 fd 摘要、`/lib64` 换成 `__PKT_SERVICE_UID__`、`__PKT_SERVICE_GID__`、`__PKT_NODE_ARCH__`、`__PKT_NODE_SHA256__`、`__PKT_FD_TRIPLE__`、`__PKT_FD_SHA256__`、`__PKT_FD_BINARY_SHA256__`、`__PKT_LIB64_ITEM__` 占位符。
- 测试：`test_make_packet.py` 新增 `PlatformTemplateTest`（x64 渲染和改动前逐字节相同、arm64 渲染不留 x64 痕迹、未钉住的值被拒、未知平台被拒、按平台选候选包）；`fixtures/twelfth-parameters.json` 加 9 个新键；`test_collect_dependencies.py`（main 新加的）把 `__PKT_NODE_ARCH__` 填成当前 node 的架构。
- `scripts/platform-assumptions.json` 重新计数。
- 最后一个提交合入了 main：`make-packet.py` 里两边各加的 `platform_parameters` 和 `material_cache` 都保留；ADR 因 main 占了 0282 改为 0283。

请重点看：

1. 有没有模板里还写死 x64、999、988、`x86_64`、`/lib64` 却没换成占位符的地方，会让 ARM 渲染出错误的包。
2. 有没有占位符在某条渲染路径上没被替换（例如某个脚本直接读模板原文、不经 `render()`），会把 `__PKT_…__` 原样带进上线包或测试。
3. `__PKT_LIB64_ITEM__` 渲染成空串时，所在的 JSON 或 JS 数组语法是否还对。
4. x64 的产出是否真的逐字节不变，包括 `OWNED-SHA256SUMS` 和被摘要钉住的文件。
5. 合并 main 后，`material_cache` 和 `platform_parameters` 在 `base_parameters` 里有没有键名冲突或顺序问题。
