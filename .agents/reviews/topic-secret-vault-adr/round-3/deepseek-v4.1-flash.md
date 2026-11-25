CLAIM|1|一致|docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md:49|[ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 定了密码、密钥一律不存进记忆|密码、密钥由程序识别后拒存，主人明说“记住”也不存
CLAIM|2|一致|docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md:69|改由“以后接密码管理器”|- **密码、密钥也当普通信息记。** 改由以后接密码管理器，填表时由工具取值直接填，模型看不到值（另开线程做）。
CLAIM|3|一致|docs/execution/specs/2026-11-25-secret-vault-design.md:9|详细设计见[密钥保险箱设计规格](../execution/specs/2026-11-25-secret-vault-design.md)。|# 密钥保险箱
CLAIM|4|一致|AGENTS.md:14|原则顺序：`AGENTS.md` 第 14 行“原则之间冲突时按这个顺序裁决：用户主权，其次边界与可逆性，其次记忆可靠性，其次主动性与效率”。|- 原则之间冲突时按这个顺序裁决：用户主权，其次边界与可逆性，其次记忆可靠性，其次主动性与效率。
CLAIM|5|一致|docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md:69|密码、密钥不进记忆：[ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 第 69 行“改由以后接密码管理器，填表时由工具取值直接填，模型看不到值（另开线程做）”。|- **密码、密钥也当普通信息记。** 改由以后接密码管理器，填表时由工具取值直接填，模型看不到值（另开线程做）。
CLAIM|6|一致|docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:41|读过外来内容后改外面的账号先问，长期同意不算数：[ADR 0285](0285-one-main-thread-subthreads-and-one-inbox.md) 第 41 行“发出去、删东西先问，Andy 给过的长期同意在读过外来内容后不算数”。|发出去、删东西先问，Andy 给过的长期同意在读过外来内容后不算数
CLAIM|7|一致|packages/runtime-sandbox/src/network-egress.ts:138|沙箱出口代理对 https 只做隧道，看不到内容：`packages/runtime-sandbox/src/network-egress.ts` 第 138 行 `server.on("connect", (req, clientStream, head) => {`。|server.on("connect", (req, clientStream, head) => {
CLAIM|8|一致|apps/execution-worker/src/program-secret-injection.ts:39|现在的沙箱程序直接拿到真值：`apps/execution-worker/src/program-secret-injection.ts` 第 39 行 `values[name] = await input.secrets.resolve(secret.secretRef, secret.secretVersion);`|values[name] = await input.secrets.resolve(secret.secretRef, secret.secretVersion);
CLAIM|9|一致|apps/execution-worker/src/program-secret-injection.ts:53|第 53 行 `return Buffer.from(JSON.stringify({ ...rest, secrets: values }));`。|return Buffer.from(JSON.stringify({ ...rest, secrets: values }));
CLAIM|10|一致|clients/apple/Sources/HimawariCore/KeychainValueStore.swift:54|现有钥匙串封装只存在本机：`clients/apple/Sources/HimawariCore/KeychainValueStore.swift` 第 54 行 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`。|item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
CLAIM|11|一致|clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift:75|每台已配对手机已有一把每次使用都要 Face ID 或锁屏密码的安全芯片签名钥匙：`clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift` 第 75 行 `role == .confirm ? [.privateKeyUsage, .userPresence] : [.privateKeyUsage]`。|let flags: SecAccessControlCreateFlags = role == .confirm ? [.privateKeyUsage, .userPresence] : [.privateKeyUsage]
CLAIM|12|一致|packages/platform-node/src/paired-device-service.ts:360|服务器已能验证这把钥匙的签名、只认自己发过的随机数、拒绝重放和已注销的手机：`packages/platform-node/src/paired-device-service.ts` 第 360 行 `if (verified.confirmed && !this.#challengeValid(current.id, verified.nonce, now))`|if (verified.confirmed && !this.#challengeValid(current.id, verified.nonce, now))
CLAIM|13|一致|packages/platform-node/src/paired-device-service.ts:366|第 366 行 `const nonce = await this.#options.store.recordNonce({`|const nonce = await this.#options.store.recordNonce({
CLAIM|14|一致|packages/platform-node/src/paired-device-service.ts:363|第 363 行 `throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.DEVICE_REVOKED, 403);`。|throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.DEVICE_REVOKED, 403);
CLAIM|15|一致|docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md:12|ADR 0185 里“明说记住就存成敏感”早已由 ADR 0286 改为一律不存|> 2026-11-24 补：密码、密钥“明说记住就存成敏感”已由 [ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 改为一律不存；证件号、银行卡号当普通信息记，不再标敏感。
CLAIM|16|一致|clients/apple/Sources/HimawariCore/KeychainValueStore.swift:54|不复用现有“只在本机”的钥匙串封装（前提 6、9）。|item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
CLAIM|17|一致|packages/platform-node/src/paired-device-service.ts:363|服务器沿用现有的随机数和注销校验（前提 8）。|throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.DEVICE_REVOKED, 403);
CLAIM|18|一致|packages/runtime-sandbox/src/network-egress.ts:138|新写一个出口守门程序（现有代理对 https 只做隧道、看不到内容，前提 4）|server.on("connect", (req, clientStream, head) => {
CLAIM|19|一致|apps/execution-worker/src/program-secret-injection.ts:39|现有把真值直接交给沙箱程序的做法（前提 5）改掉。|values[name] = await input.secrets.resolve(secret.secretRef, secret.secretVersion);
CLAIM|20|一致|package.json:26|接进 `npm run check`|"check": "node scripts/run-all-checks.mjs",
CLAIM|21|一致|package.json:72|过 `npm run check:prompt-prefix`|"check:prompt-prefix": "node scripts/check-prompt-prefix.mjs",

未核对的部分：方案引用的外部网站（Apple 开发者文档、1Password、Muse、Claude 文档）和原型链接，以及方案中属于计划的新增内容（五道保险箱检查、浏览器工具、出口守门程序等）未按现状核对。
