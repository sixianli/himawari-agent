CLAIM|1|一致|scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:343|第 334 到 353 行的那一组里有 `/lib64`|          "/lib64",
CLAIM|2|一致|scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:352|用的是 `.map((p) => realpath(p))`|        ].map((p) => realpath(p)),
CLAIM|3|一致|scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:358|同一个文件第 354 到 364 行对 `/etc/mime.types` 等 4 条已经有“不存在就跳过”的写法|              if (error?.code === "ENOENT") return null;
CLAIM|4|一致|test/fixtures/product-path-harness.ts:1593-1597|测试夹具和探测脚本也是同样的无条件写法，例如 `test/fixtures/product-path-harness.ts`|          (entry) => realpath(entry),
CLAIM|5|一致|test/fixtures/mac-sandbox-deployment.ts:143-157|测试夹具和探测脚本也是同样的无条件写法，例如 `test/fixtures/mac-sandbox-deployment.ts`|      ].map((entry) => realpath(entry)),
CLAIM|6|一致|test/integration/sandbox-preparation-control.test.ts:580-593|测试夹具和探测脚本也是同样的无条件写法，例如 `test/integration/sandbox-preparation-control.test.ts`|        ].map((filename) => realpath(filename)),
CLAIM|7|一致|packages/runtime-sandbox/src/policy.ts:66|沙箱策略对交给它的每条路径做严格校验：`packages/runtime-sandbox/src/policy.ts` 的 `canonicalPath` 里有 `if ((await realpath(value)) !== value) throw new Error("SRT_POLICY_PATH_NOT_CANONICAL")`|  if ((await realpath(value)) !== value) throw new Error("SRT_POLICY_PATH_NOT_CANONICAL");
CLAIM|8|一致|scripts/ci/local.mjs:20-26|`scripts/ci/local.mjs` 只接受 `darwin` 加 `arm64` 或 `linux` 加 `x64`，否则抛 `CI_LOCAL_PLATFORM_UNSUPPORTED`|    throw new Error("CI_LOCAL_PLATFORM_UNSUPPORTED");
CLAIM|9|一致|scripts/ci/install-tools.mjs:25|`scripts/ci/install-tools.mjs` 里是 `const platforms = ["darwin-arm64", "linux-x64"];`|const platforms = ["darwin-arm64", "linux-x64"];
CLAIM|10|一致|scripts/ci/build.mjs:133|`scripts/ci/build.mjs` 里是 `process.platform === "darwin" ? "macos-arm64" : "linux-x64"`|    const platform = process.platform === "darwin" ? "macos-arm64" : "linux-x64";
CLAIM|11|一致|scripts/ci/run.mjs:283|`scripts/ci/run.mjs` 里是 `process.platform === "darwin" ? "macos-arm64" : "linux-x64"`|        platform: process.platform === "darwin" ? "macos-arm64" : "linux-x64",
CLAIM|12|一致|scripts/ci/local.mjs:38|`scripts/ci/local.mjs` 里是 `process.platform === "darwin" ? "macos-arm64" : "linux-x64"`|  const platform = process.platform === "darwin" ? "macos-arm64" : "linux-x64";
CLAIM|13|一致|scripts/ci/context.mjs:143|`scripts/ci/context.mjs` 里 `toolchainSha256: fileSha256(path.join(root, "ci/toolchain-lock.json"))`|    toolchainSha256: fileSha256(path.join(root, "ci/toolchain-lock.json")),
CLAIM|14|一致|scripts/delivery-mode/make-packet.py:385|`scripts/delivery-mode/make-packet.py` 按 `linux-x64-abi127-` 找包|    artifacts = sorted(materials.glob('linux-x64-abi127-' + commit + '-*-1.tar.gz'))
CLAIM|15|一致|scripts/delivery-mode/run-packet-checks.py:163|`scripts/delivery-mode/run-packet-checks.py` 按 `linux-x64-abi127-` 找包|    archives = sorted((packet / 'materials').glob('linux-x64-abi127-*-1.tar.gz'))
CLAIM|16|一致|scripts/delivery-mode/packet-template/install/__PKT_LABEL__-artifact-install.mjs:14|`scripts/delivery-mode/packet-template/install/__PKT_LABEL__-artifact-install.mjs` 要求 `process.arch === "x64"`|fail(process.argv.length === 6 && process.platform === "linux" && process.arch === "x64" && process.version === "v22.22.3", "P5_ENVIRONMENT_INVALID");
CLAIM|17|一致|scripts/delivery-mode/packet-template/install/collect-installer-dependencies.mjs:15|`collect-installer-dependencies.mjs` 要求 `process.arch === "x64"`|fail(Object.keys(args).length === 4 && process.version === "v22.22.3" && process.platform === "linux" && process.arch === "x64", "P5_ENVIRONMENT_INVALID");
CLAIM|18|一致|scripts/delivery-mode/make-packet.py:49|`make-packet.py` 里 `PYTHON_MATERIAL` 固定为 `python-3.12.10.tar.gz` 和一个固定摘要|PYTHON_MATERIAL = ('python-3.12.10.tar.gz', 'f50d08e0304b15d752b22932047135c1dc02f81977b284e51288be9d90627bca')
CLAIM|19|一致|scripts/delivery-mode/packet-template/acceptance/cloud/download-question-12.py:14|`scripts/delivery-mode/packet-template/acceptance/cloud/download-question-12.py` 下载的是 `fd-v10.5.0-x86_64-unknown-linux-musl`|fd_url = 'https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-unknown-linux-musl.tar.gz'
CLAIM|20|一致|packages/runtime-sandbox/src/srt-runtime-identity.ts:8-10|`packages/runtime-sandbox/src/srt-runtime-identity.ts` 同时登记了 `x64` 和 `arm64` 的 seccomp 辅助程序摘要|  arm64: "4fee55ac7f22dd023ba1674ff1c3fa1b502ef8121800a78ae1bc9c515091ab17",
CLAIM|21|一致|packages/execution-contracts/src/sandbox-qualification-v1.ts:46|`packages/execution-contracts/src/sandbox-qualification-v1.ts` 的资格回执接受 `architecture` 为 `arm64` 或 `x64`|  architecture: enumeration(["arm64", "x64"]),
CLAIM|22|一致|scripts/delivery-mode/packet-template/signing/cloud-protected-prepare.mjs:40|`scripts/delivery-mode/packet-template/signing/cloud-protected-prepare.mjs` 用 `assert.equal(process.arch, receipt.architecture)`|assert.equal(process.arch, receipt.architecture);
CLAIM|23|一致|scripts/delivery-mode/packet-template/signing/cloud-protected-prepare.mjs:41|和 `assert.equal(release(), receipt.osRelease)` 把回执绑定到当前机器|assert.equal(release(), receipt.osRelease);
CLAIM|24|一致|scripts/delivery-mode/packet-template/signing/cloud-protected-prepare.mjs:40|所以 x64 的回执不能在 ARM 上用，反过来也一样|assert.equal(process.arch, receipt.architecture);
CLAIM|25|一致|packages/runtime-sandbox/scripts/check-srt-boundary.mjs:160|本仓库 `packages/runtime-sandbox/scripts/check-srt-boundary.mjs` 已经有“先过滤掉不存在的目录，再取真实路径”的写法|        .filter((entry) => existsSync(entry))
CLAIM|26|一致|scripts/ci/local.mjs:20-26|`npm test` 一启动就报 `CI_LOCAL_PLATFORM_UNSUPPORTED`|    throw new Error("CI_LOCAL_PLATFORM_UNSUPPORTED");
CLAIM|27|一致|packages/platform-node/src/capabilities/isolation.ts:540-542|它带 `--symlink usr/lib64 /lib64`|          "usr/lib64",
CLAIM|28|一致|scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:334-366|`cloud-seal.mjs` 里的路径字面量仍留在 `readOnlyToolchainPaths: [` 到 `protectedPaths: [` 之间|  readOnlyToolchainPaths: [
CLAIM|29|一致|docs/adr/0176-ci-on-ovh-vps.md:12|ADR 0176：CI 在 OVH 的云服务器上跑|# ADR 0176：CI 全部搬到 OVH 的 VPS 上，注销 Hermes 上的 runner
CLAIM|30|一致|docs/incidents-and-gates.md:112|事故和门槛（I-73：只看改动本身，没核对每个值的产生处和使用处）|双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」
CLAIM|31|一致|docs/runbooks/install-start-stop-runbook.md:11|安装、启动和停止操作手册|# 本地 Node runtime 安装、启停与诊断 Runbook

未核对的部分：ARM 机器上的实测版本与通过数（Node 22.23.5、bwrap 0.11.2、各测试项目通过/失败数、`/lib64` 与 `/usr/lib64` 是否存在、bwrap 带 `--symlink usr/lib64 /lib64` 的退出码 0）无法从仓库文件证实；外部网站（Debian 邮件列表、bubblewrap 手册）和 Andy 的决定卡内容也未核对。
