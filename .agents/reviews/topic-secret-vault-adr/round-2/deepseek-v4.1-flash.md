CLAIM|1|一致|docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md:49|ADR 0286 定了密码、密钥一律不存进记忆|密码、密钥由程序识别后拒存，主人明说“记住”也不存；修改 ADR 0185 里“明说记住就存成敏感”这一条。
CLAIM|2|一致|docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md:69|ADR 0286 改由“以后接密码管理器”|- **密码、密钥也当普通信息记。** 改由以后接密码管理器，填表时由工具取值直接填，模型看不到值（另开线程做）。
CLAIM|3|一致|docs/execution/specs/2026-11-25-secret-vault-design.md:9|详细设计见密钥保险箱设计规格|# 密钥保险箱
CLAIM|4|一致|AGENTS.md:14|AGENTS.md 第 14 行“原则之间冲突时按这个顺序裁决：用户主权，其次边界与可逆性，其次记忆可靠性，其次主动性与效率”|- 原则之间冲突时按这个顺序裁决：用户主权，其次边界与可逆性，其次记忆可靠性，其次主动性与效率。
CLAIM|5|一致|docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md:69|ADR 0286 第 69 行“改由以后接密码管理器，填表时由工具取值直接填，模型看不到值（另开线程做）”|- **密码、密钥也当普通信息记。** 改由以后接密码管理器，填表时由工具取值直接填，模型看不到值（另开线程做）。
CLAIM|6|一致|docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:41|ADR 0285 第 41 行“发出去、删东西先问，Andy 给过的长期同意在读过外来内容后不算数”|发出去、删东西先问，Andy 给过的长期同意在读过外来内容后不算数；花钱每次问。
CLAIM|7|一致|packages/runtime-sandbox/src/network-egress.ts:138|沙箱出口代理对 https 只做隧道，看不到内容|  server.on("connect", (req, clientStream, head) => {
CLAIM|8|一致|apps/execution-worker/src/program-secret-injection.ts:39|现在的沙箱程序直接拿到真值：第 39 行|      values[name] = await input.secrets.resolve(secret.secretRef, secret.secretVersion);
CLAIM|9|一致|apps/execution-worker/src/program-secret-injection.ts:53|现在的沙箱程序直接拿到真值：第 53 行|  return Buffer.from(JSON.stringify({ ...rest, secrets: values }));
CLAIM|10|一致|clients/apple/Sources/HimawariCore/KeychainValueStore.swift:54|现有钥匙串封装只存在本机|        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
CLAIM|11|一致|clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift:75|每台已配对手机已有一把每次使用都要 Face ID 或锁屏密码的安全芯片签名钥匙|        let flags: SecAccessControlCreateFlags = role == .confirm ? [.privateKeyUsage, .userPresence] : [.privateKeyUsage]
CLAIM|12|一致|packages/platform-node/src/device-request-signature.ts:292|服务器已能验证这把钥匙的签名|    if (!keys.confirm || !check(confirmMember, keys.confirm))
CLAIM|13|一致|packages/platform-node/src/paired-device-service.ts:360|服务器只认自己发过的随机数|    if (verified.confirmed && !this.#challengeValid(current.id, verified.nonce, now))
CLAIM|14|一致|packages/platform-node/src/paired-device-service.ts:366|服务器拒绝重放|    const nonce = await this.#options.store.recordNonce({
CLAIM|15|一致|packages/platform-node/src/paired-device-service.ts:363|服务器拒绝已注销的手机|      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.DEVICE_REVOKED, 403);
CLAIM|16|一致|docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md:12|ADR 0185 里“明说记住就存成敏感”早已由 ADR 0286 改为一律不存|> 2026-11-24 补：密码、密钥“明说记住就存成敏感”已由 [ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 改为一律不存；证件号、银行卡号当普通信息记，不再标敏感。
CLAIM|17|一致|docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md:69|补上 ADR 0286 第 69 行留下的“以后接密码管理器”|- **密码、密钥也当普通信息记。** 改由以后接密码管理器，填表时由工具取值直接填，模型看不到值（另开线程做）。
CLAIM|18|不一致|packages/runtime-sandbox/src/network-egress.ts:224|现有代理只转发 https|    parentProxy: Object.freeze({ http: url, https: url, noProxy: "" }),
CLAIM|19|一致|apps/execution-worker/src/program-secret-injection.ts:53|现有把真值直接交给沙箱程序的做法|  return Buffer.from(JSON.stringify({ ...rest, secrets: values }));

Apple 开发者文档第 9、10 条、业界做法、原型链接以及 Andy 的讨论和拍板过程不在仓库内，未核对。方案拟新增的五道检查、保险箱工具、浏览器填表和分四步实施等内容按题目要求未当作现状核对。
