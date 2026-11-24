---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md, docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md"
date: "2026-11-25"
---

# ADR 0287：密码和密钥放进保险箱，钥匙在 iPhone 上，每次办事刷脸批一次

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

[ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 定了密码、密钥一律不存进记忆，改由“以后接密码管理器”。Andy 2026-11-24 改为这一版就做，要通用能力（不按具体场景）、对他零门槛，并问“服务器被黑会不会泄露”。方案经 DeepSeek 五轮讨论和一轮攻击者视角的安全审核，定稿为 v5；Andy 2026-11-25 00:35 JST 对其中三项选择都回“按照你的推荐来”。详细设计见[密钥保险箱设计规格](../execution/specs/2026-11-25-secret-vault-design.md)。本 ADR 记下改起来代价大、以后会被问“为什么”的几条。

<a id="premises"></a>

## 前提

1. 原则顺序：`AGENTS.md` 第 14 行“原则之间冲突时按这个顺序裁决：用户主权，其次边界与可逆性，其次记忆可靠性，其次主动性与效率”。
2. 密码、密钥不进记忆：[ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 第 69 行“改由以后接密码管理器，填表时由工具取值直接填，模型看不到值（另开线程做）”。
3. 读过外来内容后改外面的账号先问，长期同意不算数：[ADR 0285](0285-one-main-thread-subthreads-and-one-inbox.md) 第 41 行“发出去、删东西先问，Andy 给过的长期同意在读过外来内容后不算数”。
4. 沙箱出口代理对 https 只做隧道，看不到内容：`packages/runtime-sandbox/src/network-egress.ts` 第 138 行 `server.on("connect", (req, clientStream, head) => {`。
5. 现在的沙箱程序直接拿到真值：`apps/execution-worker/src/program-secret-injection.ts` 第 39 行 `values[name] = await input.secrets.resolve(secret.secretRef, secret.secretVersion);`、第 53 行 `return Buffer.from(JSON.stringify({ ...rest, secrets: values }));`。
6. 现有钥匙串封装只存在本机：`clients/apple/Sources/HimawariCore/KeychainValueStore.swift` 第 54 行 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`。
7. 每台已配对手机已有一把每次使用都要 Face ID 或锁屏密码的安全芯片签名钥匙：`clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift` 第 75 行 `role == .confirm ? [.privateKeyUsage, .userPresence] : [.privateKeyUsage]`。
8. 服务器已能验证这把钥匙的签名、只认自己发过的随机数、拒绝重放和已注销的手机：`packages/platform-node/src/paired-device-service.ts` 第 360 行 `if (verified.confirmed && !this.#challengeValid(current.id, verified.nonce, now))`、第 366 行 `const nonce = await this.#options.store.recordNonce({`、第 363 行 `throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.DEVICE_REVOKED, 403);`。
9. 苹果说要同步的钥匙串项不能设“只在本机”：“may not also specify a kSecAttrAccessible value that is incompatible with syncing (namely, those whose names end with ThisDeviceOnly)”（<https://developer.apple.com/documentation/security/ksecattrsynchronizable>）。
10. 通知按钮的 authenticationRequired 只保证解锁：“The system prompts the user to unlock the device”（<https://developer.apple.com/documentation/usernotifications/unnotificationactionoptions/authenticationrequired>）。

<a id="decision"></a>

## 决定

1. **密码、API key、两步验证种子放进保险箱，不进记忆，她看不到值。** 她只看到每一项的名字和允许的网站，按名字请求使用；值由沙箱外单独的保险箱程序填进网页或在出口替换。补上 ADR 0286 第 69 行留下的“以后接密码管理器”；ADR 0185 里“明说记住就存成敏感”早已由 ADR 0286 改为一律不存，本决定说明这些东西改存在哪里。依据“边界与可逆性”。
2. **服务器只存密文，钥匙在 Andy 的 iPhone 上。** 总钥匙放在 iCloud 钥匙串里一个新建的同步项（Andy 定，换手机自动带走）；不复用现有“只在本机”的钥匙串封装（前提 6、9）。每一项有自己的小钥匙，小钥匙用总钥匙加密，加密时绑上项编号、字段和版本；名字和网站清单由总钥匙算防篡改签名并带版本号。服务器单独被偷（数据库、备份）时一项都解不开。
3. **每次办事批一次，刷脸由安全芯片强制。** 一次批准管这一次办事里用到的那几项（Andy 定）。批准不靠通知按钮（前提 10），而是用每台手机已有的确认签名钥匙（前提 7）签名，盖住：服务器发的一次性随机数（2 分钟有效、用一次作废）、哪台手机、哪几项、确切网站、页面版本、这次办事的临时公钥、过期时间；服务器沿用现有的随机数和注销校验（前提 8）。手机只把这几项的小钥匙用临时公钥加密发回；两步验证种子不出手机，手机算好验证码发过去。“长期同意”对保险箱不适用（前提 3）；后台任务要用某一项，默认也要当时批准，Andy 在那一项上打开“后台也能用”才例外。
4. **这一版在服务器上填，包括银行、支付、邮箱（Andy 定）。** 浏览器在服务器的隔离沙箱里，网站按“协议+域名+端口完全一致”核对，填、提交、确认结果由保险箱程序一口气做完，这期间她被暂停。接受剩余风险：服务器被悄悄控制期间，Andy 批准过的那几项会泄露。根治要浏览器跑在 Andy 自己的设备上，以后再做。依据“用户主权”：Andy 在知道这条风险后选了它。
5. **API key 只在出口替换，沙箱程序只拿替身。** 新写一个出口守门程序（现有代理只转发 https，前提 4）：沙箱只信任它的证书，它按登记的网站、方法、路径和放在哪个请求头或请求体字段，经同一个批准流程拿到真值替换；响应里出现真值就遮掉。现有把真值直接交给沙箱程序的做法（前提 5）改掉。
6. **五道自动检查是硬门槛。** `check:vault-canary`（特殊值不出现在发给模型的请求、其他表、对话、日志、推送、沙箱输出）、`check:vault-contract`、`check:vault-approval`、`check:vault-egress`、`check:vault-recovery`，每条都有“去掉防护就必须失败”的反向用例，接进 `npm run check`；保险箱工具在所有对话里固定提供、列表排序固定、不带时间，过 `npm run check:prompt-prefix`。

<a id="industry"></a>

## 业界怎么做

- 1Password for Claude：每次放出凭据都要人批准，没有长期批准（“A human approves every credential release”“There are no standing approvals”，<https://support.1password.com/1password-claude-security/>）；浏览器和钥匙都在用户自己的电脑上。
- Meta Muse：凭据放在每个用户自己的虚拟机里的单独程序中，代码只拿到替身（“only ever sees a “surrogate” token”），出口按网站、方法、路径和请求内容判断，填表时代理暂停（“the agent is paused and can’t act at all”，<https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse>）。
- Claude 托管 agent 的保险库：在出口把占位符换成真值，按网站名单、放在请求头还是请求体限定（<https://platform.claude.com/docs/en/managed-agents/vaults>）。

我们和 Muse 做法一样，多一层“钥匙在手机、每次刷脸”；比 1Password 多出前面说的剩余风险，换来这一版能在服务器上办事。

<a id="options"></a>

## 放弃的做法

- **钥匙放服务器（信封加密）。** 开发最省，但服务器被偷或被控制时所有项一起泄露。Andy 要“服务器被黑也不泄露”。
- **钥匙只放这台手机的安全芯片。** 更硬，但换手机要靠打印的恢复码，对 Andy 有门槛。
- **锁屏通知按钮直接批准。** 苹果只保证解锁，手机开着锁或用手表解锁时不刷脸（前提 10）。
- **这一版就在 iPhone 上开浏览器填。** 密码永远不出手机，但 iPhone 上要新写一个可远程操作的浏览器，开发量多一大块；Andy 定以后再做。
- **读苹果“密码”App 的条目。** 苹果不给第三方读，只能导入（凭据交换）或用自动填充。

<a id="consequences"></a>

## 后果

- 分四步做：手机端钥匙和加密格式（先在真机上验证 iCloud 同步项能否加刷脸、批准页刷脸流程、凭据导入列表里有没有 Himawari）；服务器保险箱存储、列出工具、批准和随机数、使用记录、注销和换钥匙；浏览器工具填表和两步验证；出口守门程序。每步先接上对应的自动检查。
- 名字和网站以明文存在服务器上并发给模型服务商（她要按名字用），服务器被控制时能看出 Andy 用哪些网站。
- 丢手机时在任何一台苹果设备上注销它，服务器不再认它的批准；怀疑总钥匙泄露时一键换总钥匙，所有项在手机上重新加密。
- iPhone 界面照原型第 63 版第 5 排九屏（<https://claude.ai/artifact/LXSrxAKtr41z2Yz6eJ1Dme>）。
