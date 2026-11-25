CLAIM|1|一致|docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md:49|定了密码、密钥一律不存进记忆|密码、密钥由程序识别后拒存，主人明说“记住”也不存
CLAIM|2|一致|docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md:69|改由“以后接密码管理器”|改由以后接密码管理器，填表时由工具取值直接填，模型看不到值（另开线程做）。
CLAIM|3|一致|docs/execution/specs/2026-11-25-secret-vault-design.md:9|详细设计见[密钥保险箱设计规格](../execution/specs/2026-11-25-secret-vault-design.md)。|# 密钥保险箱
CLAIM|4|一致|AGENTS.md:14|原则顺序：`AGENTS.md` 第 14 行“原则之间冲突时按这个顺序裁决：用户主权，其次边界与可逆性，其次记忆可靠性，其次主动性与效率”。|原则之间冲突时按这个顺序裁决：用户主权，其次边界与可逆性，其次记忆可靠性，其次主动性与效率
CLAIM|5|一致|docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md:69|密码、密钥不进记忆：[ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 第 69 行“改由以后接密码管理器，填表时由工具取值直接填，模型看不到值（另开线程做）”。|改由以后接密码管理器，填表时由工具取值直接填，模型看不到值（另开线程做）。
CLAIM|6|一致|docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:41|读过外来内容后改外面的账号先问，长期同意不算数：[ADR 0285](0285-one-main-thread-subthreads-and-one-inbox.md) 第 41 行“发出去、删东西先问，Andy 给过的长期同意在读过外来内容后不算数”。|发出去、删东西先问，Andy 给过的长期同意在读过外来内容后不算数
CLAIM|7|一致|packages/runtime-sandbox/src/network-egress.ts:138|沙箱出口代理对 https 只做隧道，看不到内容：`packages/runtime-sandbox/src/network-egress.ts` 第 138 行 `server.on("connect", (req, clientStream, head) => {`。|server.on("connect", (req, clientStream, head) => {
CLAIM|8|一致|apps/execution-worker/src/program-secret-injection.ts:39|第 39 行 `values[name] = await input.secrets.resolve(secret.secretRef, secret.secretVersion);`|values[name] = await input.secrets.resolve(secret.secretRef, secret.secretVersion);
CLAIM|9|一致|apps/execution-worker/src/program-secret-injection.ts:53|第 53 行 `return Buffer.from(JSON.stringify({ ...rest, secrets: values }));`|return Buffer.from(JSON.stringify({ ...rest, secrets: values }));
CLAIM|10|一致|clients/apple/Sources/HimawariCore/KeychainValueStore.swift:54|现有钥匙串封装只存在本机：`clients/apple/Sources/HimawariCore/KeychainValueStore.swift` 第 54 行 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`。|item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
CLAIM|11|一致|clients/apple/Sources/HimawariShell/AppModel.swift:241|每台已配对手机已有一把每次使用都要 Face ID 或锁屏密码的安全芯片签名钥匙|try keys.create(.confirm)
CLAIM|12|一致|clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift:75|每次使用都要 Face ID 或锁屏密码|let flags: SecAccessControlCreateFlags = role == .confirm ? [.privateKeyUsage, .userPresence] : [.privateKeyUsage]
CLAIM|13|一致|packages/platform-node/src/device-request-signature.ts:292|服务器已能验证这把钥匙的签名|if (!keys.confirm || !check(confirmMember, keys.confirm))
CLAIM|14|一致|packages/platform-node/src/paired-device-service.ts:326|只认自己发过的随机数|if (!timingSafeEqual(mac, this.#challengeMac(deviceId, head))) return false;
CLAIM|15|一致|packages/platform-node/src/paired-device-service.ts:375|拒绝重放|if (nonce === "replayed")
CLAIM|16|一致|packages/platform-node/src/paired-device-service.ts:363|已注销的手机|throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.DEVICE_REVOKED, 403);
CLAIM|17|一致|docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md:12|ADR 0185 里“明说记住就存成敏感”早已由 ADR 0286 改为一律不存|2026-11-24 补：密码、密钥“明说记住就存成敏感”已由 [ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 改为一律不存；证件号、银行卡号当普通信息记，不再标敏感。
CLAIM|18|一致|package.json:26|接进 `npm run check`|"check": "node scripts/run-all-checks.mjs",
CLAIM|19|一致|package.json:68|过 `npm run check:prompt-prefix`|"check:prompt-prefix": "node scripts/check-prompt-prefix.mjs",

未核对的部分：方案中属于新增或修改的设计细节（如批准流程的 2 分钟有效期、五道 vault 检查、出口守门程序、浏览器填表流程）未当作现状核对；外部苹果文档和第三方产品描述按规则也未核对。其余列出的仓库现状均已亲自读到对应内容。
