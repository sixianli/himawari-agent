CLAIM|1|找不到|-|记录 .agents/reviews/topic-agent-secret-vault/round-4/deepseek-v4.1-flash.md|未读到
CLAIM|2|找不到|-|它找到 13 处问题|未读到
CLAIM|3|一致|.agents/evidence/secret-vault/plan-v4.md:29|v4 写“锁屏点批准、系统要求 Face ID”|你在锁屏点“批准”，系统要求 Face ID 解锁。
CLAIM|4|一致|.agents/evidence/secret-vault/plan-v4.md:54|v4 只绑定“办事编号、项、网站、过期时间”|签名绑定办事编号、项、网站、过期时间，只能用一次
CLAIM|5|一致|.agents/evidence/secret-vault/plan-v3.md:30|v3 把种子存服务器，一次批准就同时拿到密码和验证码，两步等于一步|6. **两步验证**：存种子，程序当场算 6 位码填进去，种子和码都不进模型、不落库。
CLAIM|6|一致|packages/runtime-sandbox/src/network-egress.ts:138|现在的代理对 https 只做转发，看不到内容（前提 5）|server.on("connect", (req, clientStream, head) => {
CLAIM|7|一致|apps/execution-worker/src/program-secret-injection.ts:39|现有那段把真值直接交给沙箱程序的代码（前提 6）改成只给替身|values[name] = await input.secrets.resolve(secret.secretRef, secret.secretVersion);
CLAIM|8|找不到|-|和收件箱方案定的“碰外面的账号先问，‘以后都行’不算数”一致|未读到
CLAIM|9|一致|clients/apple/Sources/HimawariCore/KeychainValueStore.swift:54|不复用现有钥匙串封装，它设的是“只在本机”（前提 7）|item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
CLAIM|10|一致|clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift:75|现有代码里 confirm 这一种已这样设（前提 8）|let flags: SecAccessControlCreateFlags = role == .confirm ? [.privateKeyUsage, .userPresence] : [.privateKeyUsage]
CLAIM|11|一致|packages/platform-node/src/payload-protector.ts:184|仓库已有的信封加密（前提 10）用的是服务器自己的钥匙|readonly #keys: HostSecretMaterialSource;
CLAIM|12|一致|packages/application/src/services/web-capability-service.ts:250|现有“先准备、执行前核对页面没变”的机制已按完全一致的网址来源和页面版本核对（前提 13），接在它上面|const origin = exactOrigin(input.finalUrl);
CLAIM|13|一致|packages/application/src/services/web-capability-service.ts:319|现有“先准备、执行前核对页面没变”的机制已按完全一致的网址来源和页面版本核对（前提 13），接在它上面|if (inspected.pageVersion !== action.pageVersion || inspected.finalUrl !== action.finalUrl) {
CLAIM|14|找不到|-|照收件箱方案定的权限规则每次单独问（前提 1）|未读到
CLAIM|15|一致|package.json:68|过现有 npm run check:prompt-prefix|"check:prompt-prefix": "node scripts/check-prompt-prefix.mjs",
CLAIM|16|找不到|-|ADR 0285 决定 7，“改 Andy 外面的账号和设备、改他定的规则，没读过外来内容时直接做，读过就问……发出去、删东西先问，Andy 给过的长期同意在读过外来内容后不算数”（分支 claude/project-thread-1uwmti，docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:41，未合入 main）|未读到
CLAIM|17|一致|packages/runtime-sandbox/src/network-egress.ts:138|沙箱出口代理对 https 只做隧道：`server.on("connect", (req, clientStream, head) => {`（packages/runtime-sandbox/src/network-egress.ts:138）|server.on("connect", (req, clientStream, head) => {
CLAIM|18|一致|apps/execution-worker/src/program-secret-injection.ts:39|现有沙箱程序拿到真值：`values[name] = await input.secrets.resolve(secret.secretRef, secret.secretVersion);`|values[name] = await input.secrets.resolve(secret.secretRef, secret.secretVersion);
CLAIM|19|一致|apps/execution-worker/src/program-secret-injection.ts:53|`return Buffer.from(JSON.stringify({ ...rest, secrets: values }));`（apps/execution-worker/src/program-secret-injection.ts:39、53）|return Buffer.from(JSON.stringify({ ...rest, secrets: values }));
CLAIM|20|一致|clients/apple/Sources/HimawariCore/KeychainValueStore.swift:54|现有钥匙串封装只在本机：`item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`（clients/apple/Sources/HimawariCore/KeychainValueStore.swift:54）|item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
CLAIM|21|一致|clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift:75|现有安全芯片钥匙：`let flags: SecAccessControlCreateFlags = role == .confirm ? [.privateKeyUsage, .userPresence] : [.privateKeyUsage]`（clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift:75）|let flags: SecAccessControlCreateFlags = role == .confirm ? [.privateKeyUsage, .userPresence] : [.privateKeyUsage]
CLAIM|22|一致|packages/platform-node/src/payload-protector.ts:16|仓库信封加密用服务器钥匙：`PAYLOAD_ALGORITHM = "aes-256-gcm-envelope-v1"`（packages/platform-node/src/payload-protector.ts:16、183）|export const PAYLOAD_ALGORITHM = "aes-256-gcm-envelope-v1" as const;
CLAIM|23|一致|packages/platform-node/src/payload-protector.ts:183|`class EnvelopePayloadProtector`（packages/platform-node/src/payload-protector.ts:16、183）|export class EnvelopePayloadProtector implements PayloadProtectorPort {
CLAIM|24|一致|AGENTS.md:43|发给模型的内容只追加：“已经发出去的内容不得改动、重排或删除……系统提示和工具按对话冻结”（AGENTS.md“发给模型的内容只追加”一节）|已经发出去的内容不得改动、重排或删除，只能在末尾追加；每轮会变的内容只放在最后一条消息里；系统提示和工具按对话冻结。
CLAIM|25|一致|AGENTS.md:51|“`npm run check:prompt-prefix` 是阻断检查”（AGENTS.md“发给模型的内容只追加”一节）|`npm run check:prompt-prefix` 是阻断检查。
CLAIM|26|一致|docs/adr/0031-isolated-tool-execution.md:39|浏览器自动化必须在隔离环境：“浏览器自动化……默认必须在独立隔离执行环境执行”（docs/adr/0031-isolated-tool-execution.md:39）|浏览器自动化、第三方 CLI，以及其他可能修改文件、访问网络、启动进程或产生外部副作用的 Agent 工具，默认必须在独立隔离执行环境执行
CLAIM|27|一致|packages/application/src/services/web-capability-service.ts:250|先准备再执行、核对完全一致的网址来源和页面版本：`const origin = exactOrigin(input.finalUrl);`（packages/application/src/services/web-capability-service.ts:250、319）|const origin = exactOrigin(input.finalUrl);
CLAIM|28|一致|packages/application/src/services/web-capability-service.ts:319|`if (inspected.pageVersion !== action.pageVersion || inspected.finalUrl !== action.finalUrl) {`（packages/application/src/services/web-capability-service.ts:250、319）|if (inspected.pageVersion !== action.pageVersion || inspected.finalUrl !== action.finalUrl) {
CLAIM|29|一致|.agents/evidence/secret-vault/plan-v3.md:77|其余前提同 v3（.agents/evidence/secret-vault/plan-v3.md 前提 1–16）|16. 记忆方案 v3 第 5 条

未能核对的部分：.agents/reviews/topic-agent-secret-vault/round-4/deepseek-v4.1-flash.md 在仓库里不存在（读取也被 git 的 records-path 规则拒绝），无法确认“13 处问题”；docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md 在当前提交、基线提交和本地所有 ref 里都不存在，无法核对决定 7 的原文及分支内容；两处“收件箱方案”规则也找不到对应文档。
