# 作者说明：PR 459 第 5 轮，只看第 4 轮之后的两处改动

第 4 轮没有中、高意见。之后有两处新改动：

1. 合并 main（带进 PR 440 的平台假设清单检查）后，按 ARM 测试机线程的要求运行 `node scripts/check-platform-assumptions.mjs --write`，更新 `scripts/platform-assumptions.json`：浏览器、构建、本地、运行、测试脚本里不再写死 linux-x64，所以删掉它们的计数；新增 `scripts/ci/platforms.mjs`、`scripts/ci/install-tools.mjs` 和 `test/tooling/toolchain-platforms.test.mjs` 的计数（这些文件按平台列规则或测各平台，写出 x86 字样是有意的）。改后检查通过：PLATFORM_ASSUMPTIONS passed kinds=7 occurrences=397。
2. `test/tooling/ci-runner-scripts.test.mjs` 里“uninstall-runner.sh all 删除第三个 runner”的用例在 CI 机上失败：`UNINSTALL_INCOMPLETE still present: /etc/gh-runner`。原因：用例只在 /etc/gh-runner 上挂空 tmpfs，目录本身仍在；用例里的 rm 是假的，脚本检查 `[ -e /etc/gh-runner ]` 如实报未删干净。CI 机上真有这个目录，本地没有，所以本地一直通过。现在在 bwrap 的私有挂载空间里把整个 /srv 和 /etc 换成空 tmpfs，再建出 /etc/systemd/system 和 /etc/sudoers.d。两个同类用例的断言都把脚本的完整 stderr 作为失败信息。本地先建出 /etc/gh-runner 复现了失败，改后通过。

请重点核对：

1. 把整个 /etc 换成空 tmpfs 后，`uninstall-runner.sh all` 路径上还有没有命令依赖 /etc 下的真实文件（例如 bash、mount、动态链接器、id/getent 的真实实现），在别的机器上会不会因此行为不同或失败；用例里的假命令是否覆盖了脚本在 all 路径上调用的全部外部命令。
2. 这个用例现在是否仍能证明它要证明的事：脚本对三个 runner 和共享文件都发出了删除命令，并在什么都不剩时报 UNINSTALL_OK。
3. 同文件里“只删第二个 runner”的用例还只在 /srv、/etc/systemd/system、/etc/gh-runner 上挂 tmpfs，它在 CI 机上会不会因为同样的原因（目录本身还在、或别的真实路径）失败。
4. platform-assumptions.json 的新计数是否和这些文件现在的内容一致，有没有把不该保留的写死 x86 的地方记成了合法。
5. 这个改动会不会改变模型已经见过的请求开头（本 PR 不碰发给模型的内容，请确认）。
