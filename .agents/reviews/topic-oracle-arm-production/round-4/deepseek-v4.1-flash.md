CLAIM|1|一致|scripts/delivery-mode/packet-template/install/__PKT_LABEL__-artifact-install.mjs:14@34f2e1411ce4|出包、安装和封存只支持 x86-64，也只支持“升级一台已在运行的生产机”，没有受支持的路径能在一台新的 ARM 机上第一次装好并重新验收。|fail(process.argv.length === 6 && process.platform === "linux" && process.arch === "x64" && process.version === "v22.22.3", "P5_ENVIRONMENT_INVALID");
CLAIM|2|一致|scripts/delivery-mode/make-packet.py:330|也只支持“升级一台已在运行的生产机”|refuse('PACKET_SERVICE_NOT_ACTIVE', facts.get('active'))
CLAIM|3|找不到|-|没有受支持的路径能在一台新的 ARM 机上第一次装好并重新验收。|-
CLAIM|4|一致|scripts/delivery-mode/packet-template/install/__PKT_LABEL__-artifact-install.mjs:14@34f2e1411ce4|安装脚本只认 x64：scripts/delivery-mode/packet-template/install/__PKT_LABEL__-artifact-install.mjs:14，原话 process.arch === "x64"。|fail(process.argv.length === 6 && process.platform === "linux" && process.arch === "x64" && process.version === "v22.22.3", "P5_ENVIRONMENT_INVALID");
CLAIM|5|一致|scripts/delivery-mode/packet-template/install/collect-installer-dependencies.mjs:15@34f2e1411ce4|安装脚本只认 x64：install/collect-installer-dependencies.mjs:15，原话 process.arch === "x64"。|fail(Object.keys(args).length === 4 && process.version === "v22.22.3" && process.platform === "linux" && process.arch === "x64", "P5_ENVIRONMENT_INVALID");
CLAIM|6|一致|scripts/delivery-mode/hermes/builder.json:2|候选包只在 Hermes 上构建。|"hostname": "hermes-home",
CLAIM|7|一致|scripts/delivery-mode/hermes/build-candidate.sh:46|build-candidate.sh:44-46 只找 linux-x64-abi127-… 的产物。|mapfile -t artifacts < <(ls "$report"/linux-x64-abi127-"$revision"-*-1.tar.gz 2>/dev/null)
CLAIM|8|一致|scripts/delivery-mode/make-packet.py:509@34f2e1411ce4|make-packet.py:509 同样只认 x64。|artifacts = sorted(materials.glob('linux-x64-abi127-' + commit + '-*-1.tar.gz'))
CLAIM|9|一致|scripts/delivery-mode/make-packet.py:552@34f2e1411ce4|make-packet.py:552 同样只认 x64。|archive = next(materials.glob('linux-x64-abi127-' + commit + '-*-1.tar.gz'))
CLAIM|10|一致|scripts/delivery-mode/run-packet-checks.py:166@34f2e1411ce4|run-packet-checks.py:166 同样只认 x64。|archives = sorted((packet / 'materials').glob('linux-x64-abi127-*-1.tar.gz'))
CLAIM|11|一致|scripts/delivery-mode/make-packet.py:330|出包要求目标机上服务已在运行：make-packet.py:329，原话 refuse('PACKET_SERVICE_NOT_ACTIVE'。|refuse('PACKET_SERVICE_NOT_ACTIVE', facts.get('active'))
CLAIM|12|一致|scripts/delivery-mode/deploy-preflight.py:189|deploy-preflight.py:184 也要求服务 active。|('SERVICE_ACTIVE', facts.get('active') == 'active'),
CLAIM|13|找不到|-|项目里没有“新主机第一次安装”的路径。|-
CLAIM|14|一致|scripts/delivery-mode/packet-template/install/p5-materials.json:5|Node 运行时不在包里：packet-template/install/p5-materials.json:5，原话 "nodeAlreadyInstalled": true。|"nodeAlreadyInstalled": true,
CLAIM|15|一致|scripts/delivery-mode/packet-template/install/p5-materials.json:6@34f2e1411ce4|packet-template/install/p5-materials.json:6 写死 x64 的 Node 摘要。|"nodeSha256": "e6ec2c188d83d813f81f2de8aea084d74dce603ac1abedd0a30ad941b10087b2",
CLAIM|16|一致|scripts/delivery-mode/packet-template/install/S1-publish-and-install.py:61@34f2e1411ce4|服务账号 uid 999、组 988 写死在多处：例如 packet-template/install/S1-publish-and-install.py:61，原话 os.chown(evidence,999,988)。|evidence.mkdir(mode=0o700);os.chown(evidence,999,988)
CLAIM|17|一致|scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:441|封存脚本要求主机签名公钥等于第一把钥匙：cloud-seal.mjs:441，原话 qualification/first-20261007/host-qualification-public-key.pem。|const firstPublicKeyPath = root + "/qualification/first-20261007/host-qualification-public-key.pem";
CLAIM|18|一致|scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:446|cloud-seal.mjs:446 不等就报 FIRST_SIGNING_KEY_REQUIRED。|assert.equal(hash(publicKey.export({ type: "spki", format: "der" })), hash(firstPublicKey.export({ type: "spki", format: "der" })), "FIRST_SIGNING_KEY_REQUIRED");
CLAIM|19|一致|scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:436|签名私钥在主机本地 qualification/signing/host-qualification-signing-key.pem（:436）。|const keyPath = root + "/qualification/signing/host-qualification-signing-key.pem";
CLAIM|20|一致|scripts/delivery-mode/packet-template/signing/cloud-protected-prepare.mjs:38-41|启动前检查断言主机名、平台、架构、内核与回执一致：cloud-protected-prepare.mjs:38-41。|assert.equal(hostname(), receipt.host);
CLAIM|21|一致|scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:496-499|回执里这几项由 cloud-seal.mjs:496-499 写入。|host: hostname(),
CLAIM|22|一致|scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:342@34f2e1411ce4|封存脚本无条件把 /lib64 列进只读目录：cloud-seal.mjs:342，原话 "/lib64"。|"/lib64",
CLAIM|23|一致|scripts/delivery-mode/deploy-preflight.py:93|上线前检查按正则抽取只读目录清单的字面数组：deploy-preflight.py:83，原话 re.compile(r'readOnlyToolchainPaths: \[(.*?)protectedPaths: \['。|SANDBOX_READ_ROOTS = re.compile(r'readOnlyToolchainPaths: \[(.*?)protectedPaths: \[', re.DOTALL)
CLAIM|24|一致|scripts/delivery-mode/probe-sources.json:5|scripts/delivery-mode/probe-sources.json 只登记 job-host-main.js、sandbox-sdk.js、sandbox-sdk-worker.js 三个构建文件的摘要，与只读目录清单无关。|"built": "job-host-main.js",
CLAIM|25|一致|apps/agent-service/src/production-run-policy.ts:258|目录授权按主机核对：apps/agent-service/src/production-run-policy.ts:258，原话 grant.hostId !== route.hostId。|grant.hostId !== route.hostId ||
CLAIM|26|一致|apps/agent-service/src/service-main.ts:2500|感知提取不配置也会启动：apps/agent-service/src/service-main.ts:2500，原话 configuration.runPolicy?.perception ?? PERCEPTION_CONFIGURATION_DEFAULTS。|configuration.runPolicy?.perception ?? PERCEPTION_CONFIGURATION_DEFAULTS;
CLAIM|27|一致|apps/agent-service/src/service-main.ts:3030|apps/agent-service/src/service-main.ts:3030 是 perceptionExtraction?.start();。|perceptionExtraction?.start();
CLAIM|28|一致|scripts/delivery-mode/deploy-preflight.py:26|上线前检查 deploy-preflight.py:16-17 读 GRUB 配置。|GRUB_CONFIG = '/boot/grub/grub.cfg'
CLAIM|29|一致|scripts/delivery-mode/deploy-preflight.py:198|会拦下“重启后进的内核不是当前内核”的上线。|('NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL', bool(facts.get('runningKernel')) and facts.get('nextBootKernel') == facts.get('runningKernel') == facts.get('savedBootKernel')),
CLAIM|30|一致|docs/runbooks/ci-vps-runner-runbook.md:57|CI 服务器的做法见 docs/runbooks/ci-vps-runner-runbook.md，原话 /etc/cloud/cloud.cfg.d/99-ci-vps-hostname.cfg（重启后保留主机名）。|/etc/cloud/cloud.cfg.d/99-ci-vps-hostname.cfg`（重启后保留主机名）
CLAIM|31|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:62|ADR 0253 决定 linux-arm64 只做测试：docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:62，原话“ARM 不进 GitHub 必过检查，也不切线上。”|把 linux-arm64 作为测试和资格验收用的平台支持起来，分四个 PR，x64 的托管 CI 和生产行为不变。ARM 不进 GitHub 必过检查，也不切线上。
CLAIM|32|不一致|docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:36|ADR 0266 已修订其中“不进必过检查”一处。|这份 ADR 修订这两处，只限 policy、static、security 三项。
CLAIM|33|一致|docs/runbooks/authority-transfer-runbook.md:272|主控权迁移流程：目标的 epoch 和 fencing token 各等于源值加一。|目标 epoch 与 fencing token 必须各等于源值加一。
CLAIM|34|一致|docs/runbooks/authority-transfer-runbook.md:274|迁移包不带机器机密、可执行文件绑定或平台资格。|迁移包不携带机器秘密、可执行绑定或平台资格。
CLAIM|35|一致|docs/runbooks/authority-transfer-runbook.md:274|目标机要先独立装好。|目标 host 的配置、秘密、能力部署快照和本平台 runtime root 必须独立准备
CLAIM|36|一致|ci/toolchain-lock.json:24|工具链锁已有 Node 22.22.3 的 linux-arm64 条目。|"filename": "node-v22.22.3-linux-arm64.tar.gz",
CLAIM|37|一致|ci/toolchain-lock.json:76|工具链锁已有 Python 3.12.10 的 linux-arm64 条目。|"filename": "cpython-3.12.10+20250529-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
CLAIM|38|一致|ci/toolchain-lock.json:1588|better-sqlite3 是 "decision": "build"（在构建机上从源码编译）。|"decision": "build",
CLAIM|39|一致|scripts/delivery-mode/packet-template/acceptance/cloud/adapters/probe-authorized-network.mjs:81|验收材料里被摘要钉住的探测脚本副本（acceptance/cloud/adapters/、basis-04/、probe-source/）仍写着 /lib64。|"/lib64",
CLAIM|40|一致|scripts/delivery-mode/hermes/capture-build-source-inputs.template.mjs:115|构建脚本写死 Hermes 的主机名、x64 和 uid 1000（capture-build-source-inputs.template.mjs:115）。|require(process.platform === "linux" && process.arch === "x64" && process.version === "v22.22.3" && process.versions.modules === "127" && os.hostname() === "hermes-home" && process.getuid() === 1000 && process.geteuid() === 1000 && process.argv.length === 2 && fileURLToPath(import.meta.url) === tool, "BUILD_CAPTURE_FIXED_HERMES_ENVIRONMENT_REQUIRED");

未核对的部分：前提 13 的 nft 规则、前提 14 的目标机内核与 reboot-required、前提 15 的 /etc/cloud 目录、前提 21 的内存与 systemd 实测，以及前提 19、20 的外部网页，都不在仓库里，无法用文件核对。两处“没有首次安装路径”的否定说法和验收副本“被摘要钉住”的细节也没有找到可直接证明的仓库内容。
