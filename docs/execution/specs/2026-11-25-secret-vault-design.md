---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-11-25"
---

# 密钥保险箱

**审阅状态：已批准。** Andy 2026-11-25 00:35 JST 在“接入密码管理器填表”线程对方案 v5 的三项选择都回“按照你的推荐来”（给 Andy 看的同一份方案：<https://claude.ai/artifact/NZ4EFtUSmhfXqFbw3bkW3T>）。决定和理由见 [ADR 0287](../../adr/0287-passwords-and-keys-live-in-a-vault-the-phone-unlocks.md)。

## 一句话
密码、API key、两步验证种子放进保险箱：服务器只存密文，钥匙在 Andy 的 iPhone 上；她只看得到每一项的名字和允许的网站；每次办事要用时 Andy 在手机上刷脸批准一次，手机只解开这一次用到的几项，由沙箱外的保险箱程序填进网页或在出口替换，她从头到尾看不到值。

## Andy 定的三项
1. **银行、支付、邮箱这类账号这一版也在服务器上填。** 接受下面“剩余风险”第 1、2 条；在 iPhone 上开浏览器填以后再做。哪一项他特别担心，先别放进保险箱。
2. **总钥匙放 iCloud 钥匙串。** 换手机自动带走，和苹果“密码”App 一样的保护；不用打印恢复码。
3. **每次办事批一次。** 一次批准管这一次办事里用到的那几项；批准页上的“2 分钟内有效”指的是一次性随机数的有效期。与收件箱方案定的“碰外面的账号先问，‘以后都行’不算数”一致。

另有一处默认值：后台定时任务要用 API key 时，默认也要 Andy 当时批准；某一项打开“后台也能用”后，这一项的保护降到“钥匙在服务器”，服务器被黑就会泄露。

## 剩余风险
有。任何让 AI 替你填密码的做法都有，1Password 和 Meta 也都写明了它们剩下的风险。这一版把能堵的都堵上了，剩下这几条堵不上：

1. **服务器被黑客悄悄控制期间，你批准过的那几项会泄露。** 不只是“填的那几秒”：黑客进来后可以一直潜伏，等你每批准一次就拿走一项。比“钥匙放服务器”好在：被控制期间你没用到的项、单独被偷走的数据库和备份，都解不开。根本原因是浏览器在服务器上，密码必须在服务器上出现一下。唯一的根治办法是浏览器跑在你自己的设备上（1Password 的做法），以后再做。
2. **被控制的服务器可以在你正好让她办同一件事时，送来一个看起来一模一样的批准请求。** 手机能核对“这一项允许用在这个网站”，但看不到服务器上的浏览器实际开在哪个网站。
3. **允许的网站自己被黑**（页面里被人塞了恶意脚本），能读到刚填进去的密码。这是登录本身固有的，1Password 也这样写。
4. **服务器被控制时，能看到每一项的名字和网站**，也就是知道你用哪些银行，但看不到密码。名字本来就要给模型看，所以不加密。
5. **你习惯性一直点批准**，批准就失去意义。

和 Meta Muse 比：Muse 的真密码放在每个用户自己的虚拟机里，由一个单独的程序保管和填写，填的时候代理被暂停（前提 9）。我们的服务器相当于 Muse 的那台虚拟机，做法一样；多出来的一层是钥匙在你手机上：Muse 那台机器被控制，所有密码都在里面；我们只会泄露被控制期间你批准过的那几项。

## 安全复查后定下的十三条
1. **刷脸真正由硬件强制。** v4 写“锁屏点批准、系统要求 Face ID”，但苹果原文只保证“解锁”（手机本来就开着锁，或用手表解锁时，根本不刷脸）。改成：点通知打开 Himawari 的批准页，批准时用手机安全芯片里的签名钥匙签名，这把钥匙设成每次使用都必须 Face ID 或锁屏密码，这是芯片强制的，App 绕不过去。
2. **iCloud 同步和“每次刷脸”分开。** 苹果说要同步的钥匙串项不能设“只在本机”，能不能同时设“每次刷脸”文档没写。所以总钥匙走 iCloud 钥匙串同步（换手机自动带走），刷脸由第 1 条的签名钥匙负责（签名钥匙每台手机各一把，不同步）。总钥匙能不能也加刷脸，开工第一天在真机上试。
3. **批准不能被挪用。** v4 只绑定“办事编号、项、网站、过期时间”。改成服务器每次发一个一次性随机数，2 分钟内有效、用一次就作废；手机签名同时盖住：随机数、哪台手机、哪一项、确切网站、页面当时的版本号、这次办事的临时公钥、过期时间。
4. **防“检查时是招行页面，填时已经跳走”。** 填之前程序再查一遍浏览器真实地址、表单提交去哪、页面版本，有一样变了就作废重问；填、提交、确认结果由保险箱程序一口气做完，这期间她被暂停，什么都做不了（照 Muse）。
5. **防服务器偷换密文。** 每项的钥匙加密时绑上项编号、字段、版本号。被控制的服务器如果把“银行”那一项的密文偷换到你随手批准的另一项下面，手机解不开，直接报警。
6. **网站按“完全一致”核对。** 协议、域名、端口都要一样，不按“主域名相同”算，免得 evil.cmbchina.com.example 这类骗过去。
7. **两步验证的种子不出手机。** v3 把种子存服务器，一次批准就同时拿到密码和验证码，两步等于一步。改成：种子只在手机上解开，批准时手机算好接下来一分半钟的 6 位码发过去，种子永远不离开手机。
8. **出口守门程序写清楚是重写。** 现在的代理对 https 只做转发，看不到内容（前提 5）。新守门程序：每次办事单独起一个；核对上游网站证书；按网站、请求方式、路径、放在哪个请求头或请求体字段放行；替身值是 256 位随机数，猜不到；真值不许出现在网址里；不记录请求内容；请求和响应有大小、时间上限；出错就拒绝，不放行。现有那段把真值直接交给沙箱程序的代码（前提 6）改成只给替身。网页登录不走守门程序，密码直接填在浏览器里。
9. **锁屏不露内容。** 锁屏通知只写“Himawari 请你批准一次使用”，不写是哪一项；批准页上项的名字和网站来自签过名的清单，服务器改不了；“她要做什么”一栏标明是她说的，只当参考。
10. **换手机、丢手机有完整流程。** 在任何一台苹果设备上注销丢失的手机（它的签名钥匙作废，服务器不再认它的批准）；如果怀疑总钥匙泄露，一键换总钥匙，所有项在手机上重新加密一遍。
11. **办完清登录状态。** 每次办事用一个全新的浏览器，办完关掉、删掉它保存的登录状态（登录状态本身也能被偷去冒充你）；关掉截图、录屏、调试记录。
12. **自动检查从 0 条补回 5 条**（见第 6 节），每条都有“去掉防护就必须失败”的反向用例。
13. **对别家的描述改准。** 见第 5 节。

## 1. 东西放在哪
| 东西 | 放在哪 | 谁能看到真内容 |
|---|---|---|
| 总钥匙（256 位随机数） | iCloud 钥匙串里新建的专用项（同步、端到端加密）；不复用现有钥匙串封装，它设的是“只在本机”（前提 7） | 只有你的苹果设备 |
| 批准签名钥匙 | 每台手机的安全芯片（Secure Enclave，苹果芯片里拿不出来的那块），每次使用必须 Face ID 或锁屏密码；现有代码里 confirm 这一种已这样设（前提 8） | 拿不出来 |
| 每项的小钥匙 | 用总钥匙加密后存服务器，加密时绑上项编号、字段、版本号 | 只有手机能解开 |
| 每项的值（密码、API key、两步验证种子） | 用它的小钥匙加密后存服务器 | 密码和 key 只在批准那次在服务器内存里出现；两步验证种子只在手机上解开 |
| 每项的名字、允许的网站 | 服务器明文（给模型看），加一个用总钥匙算的防篡改签名，带版本号；手机记住最新版本号，拒绝服务器退回旧版 | 模型能看到名字和网站 |

加密在手机上用苹果自带的 CryptoKit（AES-GCM 加密、HPKE 把小钥匙加密给临时公钥）。仓库已有的信封加密（前提 10）用的是服务器自己的钥匙，不能直接拿来当手机这边用，只借它的格式和换钥匙代码思路。

## 2. 请求一个密码的流程
1. 你说“帮我登录招商银行看余额”。
2. 她列出保险箱，只拿到名字和网站。工具一次加齐、按对话冻结，列表排序固定、不带时间（前提 11）。
3. 浏览器在隔离沙箱里打开登录页（前提 12）。她只看到页面的结构摘要（可访问性树，就是读屏软件读的那份），看不到页面源码，也不能在页面里运行脚本（照 Muse，前提 9）。
4. 她说“用招商银行网银填”。
5. 保险箱程序（在沙箱外、单独进程）检查：这一项允许的网站和浏览器真实地址完全一致；表单提交也去这个网站；密码框看得见、在页面本身里（不在嵌入框和 Shadow DOM 里）。现有“先准备、执行前核对页面没变”的机制已按完全一致的网址来源和页面版本核对（前提 13），接在它上面。
6. 不对就拒绝。对就生成一次性随机数和这次办事的临时公钥，推送通知（锁屏只写“请你批准一次使用”）。
7. 你点通知，打开批准页：项的名字、网站来自签过名的清单；手机核对请求的网站在允许列表里，不在就拒绝并提醒你。
8. 你点批准、刷脸：安全芯片签名（盖住第 3 条“这次复查改了什么”列的全部内容）；手机解开这一项的小钥匙（核对绑定的项编号），用临时公钥加密发回；有两步验证的，附上算好的接下来一分半钟的 6 位码。
9. 保险箱程序验签、作废随机数，再查一遍真实地址、表单去向、页面版本，变了就作废重问。她这期间被暂停。
10. 填、提交、确认结果一口气做完；填的时候页面往别的网站发的请求全部拦下。
11. 收尾：清掉内存里的密码、小钥匙、临时私钥；页面上出现密码（原样或 URL 编码、base64、十六进制、JSON 转义后）全部遮掉；失败就清空填过的框；办完关掉浏览器、删掉登录状态。
12. 她只拿到“已登录成功”，告诉你结果。付款、转账、改密码、发出去这类动作，照收件箱方案定的权限规则每次单独问（前提 1）。

## 3. API key 和沙箱程序
程序手里只有替身值（256 位随机数，不可猜）。请求出沙箱时经过出口守门程序：守门程序在沙箱外，用自己的证书解开沙箱发出的 https（沙箱只信任这一张证书），查去哪个网站、什么方法、什么路径、真值放进哪个请求头或请求体字段，都是这一项登记过的才按同样的批准流程拿到真值替换；响应里出现真值就遮掉。Meta Muse 的 Sentinel（前提 9）、Claude 托管 agent 的保险库（前提 15）都是在出口把占位符换成真值，Claude 托管 agent 还按网站名单和放在请求头还是请求体限定替换位置，我们照这个做。守门程序的具体要求见“安全复查后定下的十三条”第 8 条。

## 4. 放密码进来
- **一次导入**：iOS 26 苹果“密码”App 的“导出到其他 App”（苹果和 FIDO 的凭据交换标准）。苹果文档说参与交换要在 App 的“自动填充扩展”（让 App 成为系统密码提供方的那个组件）里声明 SupportsCredentialExchange（前提 3），所以要先给 Himawari 做这个扩展，再在真机上看列表里有没有 Himawari（论坛有人报告不出现，未核实）。不行就靠下面两种。
- **用到才问**：她遇到没存过的网站，推送“需要 xx 的密码”。弹框只列网站相符的已存项；从苹果“密码”选一个时，选中项原来的网站和要去的网站不一致，大字警告并再确认一次（防钓鱼网站骗你把银行密码绑上去）。
- **手动加**：API key 这类。
- 值只在手机上加密后再发给服务器，服务器从头到尾只收到密文。导入的网站统一成“协议+域名+端口”格式，逐个真机验收。

## 5. 安全风险和对策
| 风险 | 对策 | 剩下的风险 |
|---|---|---|
| 服务器被控制（你没在批准时） | 钥匙不在服务器 | 名字和网站泄露；潜伏下来等你批准 |
| 服务器被控制（你批准时） | 只解开用到的项；临时钥匙用完即删 | 这几项泄露，根治要浏览器在你设备上 |
| 被控制的服务器伪造批准请求 | 名字网站来自签名清单；手机核对网站；随机数一次有效 | 你在正好办同一件事时被骗批准 |
| 服务器偷换密文 | 加密绑定项编号、字段、版本 | 无已知 |
| 服务器退回旧的允许网站清单 | 签名带版本号，手机拒绝旧版 | 换新手机后第一次同步前 |
| 网页藏指令骗她去钓鱼网站填 | 允许网站由你定，完全一致核对真实地址 | 被控制的服务器可以谎报地址（见上） |
| 检查后页面跳走再填 | 填前复查；填提交一口气做完；她被暂停 | 无已知 |
| 允许的网站自己有恶意脚本 | 无法防 | 有（登录固有） |
| 网站把密码编码后回显 | 原样和常见编码都遮；填值期间她看不到页面 | 少见的自定义编码 |
| 批准被重放 | 随机数用一次作废，2 分钟过期 | 无已知 |
| 偷听网络 | 小钥匙用临时公钥加密 | 服务器在临时私钥删除前被控制 |
| 手机丢了 | 签名钥匙要 Face ID 或锁屏密码；在其他设备注销这台；远程抹掉 | 对方知道你的锁屏密码 |
| Apple ID 被盗 | 新设备要已有设备担保，或走钥匙串恢复（要设备密码并回短信）（前提 2） | 对方同时拿到 Apple ID、设备密码和你的手机号；这时你苹果“密码”里的也一起丢 |
| 服务器内存里的明文 | 生产机无 swap；关核心转储；可清零的 Buffer；每次办事新浏览器，办完关掉 | Node 和浏览器不能保证每份拷贝都清掉 |
| 出口守门程序本身 | 沙箱外、单独进程和用户、代码最小、不记录请求内容 | 它被攻破等于服务器被攻破 |
| 依赖库被投毒（Playwright、Stagehand） | 锁定版本、只在沙箱里跑、不给它们钥匙 | 有 |
| 你习惯性一直点批准 | 一次办事只问一次；卡片写清楚 | 有 |

和别家比（原文见前提 9、14、15、16）：
- **1Password for Claude**：浏览器和钥匙都在你自己的电脑上，密码不经过任何服务器。比我们少第 1、2 条风险，代价是浏览器要跑在你本机。
- **Meta Muse**：每个用户一台虚拟机，真凭据放在虚拟机里的单独程序里（不在 Meta 的集中服务器），出口按网站、地址、方法、路径和解开的请求内容判断；浏览器子代理只看可访问性树；填表时代理暂停。做法和我们一样，没有“钥匙在手机、每次刷脸”这一层。
- **Claude Code 云端**：GitHub 凭据加密存在 Anthropic 服务器上，不进会话虚拟机，虚拟机里只有这次会话的短期凭据，由代理在服务器那头挂上真凭据。
- **Claude 托管 agent 保险库**：出口把占位符换成真值，按网站名单和放在请求头还是请求体限定。

## 6. 自动检查（硬门槛，接进 npm run check）
- `check:vault-canary`：保险箱放一个特殊值，跑录入、列出、填表、代发、沙箱全流程，扫描每个发给模型的请求、数据库其他表、对话记录、日志、推送正文、沙箱输出；反向：故意让工具结果带值（含编码后的值），必须失败。
- `check:vault-contract`：每个新值（项编号、字段编号、网站、随机数、替身）用同一个规则过所有用到它的地方，反向值必须被拒。
- `check:vault-approval`：重放、过期、换项、换网站、换页面版本、偷换密文、退回旧清单、用已注销设备签名，全部必须被拒。
- `check:vault-egress`：替身放进网址、去没登记的网站或路径、上游证书不对、响应带真值，全部必须被拒或遮掉。
- `check:vault-recovery`：注销设备后它的批准被拒；换总钥匙后旧密文解不开、新密文能用。
- 发给模型的请求开头不变：保险箱工具一次加齐、列表排序固定、无时间字段，过现有 `npm run check:prompt-prefix`。

## 7. 分几步
1. 手机端：专用钥匙串项、安全芯片签名钥匙、加密格式；真机原型先验证三件事（同步项能否加刷脸、批准页刷脸流程、凭据导入列表）。
2. 服务器：保险箱存储、列出工具、批准和随机数、使用记录、注销和换钥匙。
3. 浏览器工具（Playwright + Stagehand）填表、两步验证。
4. 出口守门程序，替换现有真值注入。
每一步都先跑上面对应的自动检查。

### 第一步和第二步做到了哪里

手机核心和服务器放在同一次改动里交付，因为批准流程两头都要有才能测。

- 已做：服务器存储四张表（项、清单、请求、使用记录）、设备接口五条（读清单、读使用记录、改清单、批准、拒绝）、列出工具 `vault_list`（只给名字、类型、网站）、批准推送的发送代码（还没有调用方，见下面“还没接上”）；手机端加密格式、总钥匙（iCloud 钥匙串同步项）、清单签名和防退回、批准时用临时公钥封装项钥匙、换总钥匙（先存“下一把”，服务器收下再换正，中途断了下次打开会接着换完）；页面写好了列表、加一项、手动加、一项的详情、换一个、批准页、丢手机和换钥匙（`clients/apple/Sources/HimawariManage/Vault/VaultPages.swift`）。
- 请求表的 `status` 和使用记录在同一个数据库事务里一起写：批准、拒绝、过期、换钥匙或删项关掉请求，都同时写下对应的使用记录，不会只写一半。服务器先用手机给的临时钥匙解开要交付的值，再写“批准”；解不开或写“批准”失败时，改写成“拒绝”并记一条 `failed`。连这一步也写不进去时，手机收到报错，请求行留在“等待”，过了期限后下次读清单或使用记录时补记成“过期”。
- 两头互相解开对方加密的样例：服务器的样例在手机代码里能解开并验签，手机代码生成的批准封装和字段密文在服务器代码里能解开（`clients/apple/Tests/HimawariCoreTests/Fixtures/vault-contract.json` 的 `vector` 和 `phoneVector`）。
- 第一步定下的读法：
  - “保险箱工具一次加齐”读作：工具列表不随保险箱里有没有东西变化，没开保险箱时工具照样在，只是如实回答“没开”。这一步只加 `vault_list`；填表工具在第三步做好能用时再加，不先放一个用不了的工具。
  - 总钥匙不加刷脸。刷脸由安全芯片里的签名钥匙在批准时强制（Andy 定的第 3 项），总钥匙再加刷脸会让每次打开保险箱都多刷一次。真机上只验证批准页刷脸流程和凭据导入列表两件事。
- 还没接上：设置页还没有进保险箱的入口，点批准通知也还不会打开批准页（推送里带了 `vaultRequestId`，手机端还没有读它的代码）。服务器这一步也还没有调用 `requestRelease` 的地方，所以现在不会发出批准推送。入口和通知跳转要在 Mac 上用 Xcode 编译验证，放到第三步填表接上时一起做。
- 还没做、等对应那一步再显示（不放空行）：从苹果“密码”导入（要真机验证凭据导入列表）、“用到才问”和“网站对不上”两屏（跟第三步的填表一起做）、详情页“后台也能用”开关（服务器还没有后台取用；开关在之前不显示）。

## 前提和来源
1. 读过外来内容后，改外面的账号先问、发出去和删东西先问、“长期同意”不算数：ADR 0285 决定 7，“改 Andy 外面的账号和设备、改他定的规则，没读过外来内容时直接做，读过就问……发出去、删东西先问，Andy 给过的长期同意在读过外来内容后不算数”（分支 claude/project-thread-1uwmti，docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:41，未合入 main）。
2. iCloud 钥匙串：新设备“either by pairing with and being sponsored by an existing iCloud Keychain device, or by using iCloud Keychain recovery”（https://support.apple.com/guide/security/sec0a319b35f/web）；恢复时“the device passcode is used to recover an escrowed keychain”，并要回复短信（https://support.apple.com/guide/security/secure-icloud-keychain-recovery-secdeb202947/web）。同步项：“may not also specify a kSecAttrAccessible value that is incompatible with syncing (namely, those whose names end with ThisDeviceOnly)”，文档没提 kSecAttrAccessControl（https://developer.apple.com/documentation/security/ksecattrsynchronizable）。
3. 凭据交换：“To participate in credential exchange, edit your credential provider extension’s information property list”（https://developer.apple.com/documentation/authenticationservices/ascredentialimportmanager）；论坛报告不出现在导出列表（https://developer.apple.com/forums/thread/819382，未读全文）。
4. 通知按钮 authenticationRequired 只保证解锁：“The system prompts the user to unlock the device”（https://developer.apple.com/documentation/usernotifications/unnotificationactionoptions/authenticationrequired）。
5. 沙箱出口代理对 https 只做隧道：`server.on("connect", (req, clientStream, head) => {`（packages/runtime-sandbox/src/network-egress.ts:138）。
6. 现有沙箱程序拿到真值：`values[name] = await input.secrets.resolve(secret.secretRef, secret.secretVersion);`、`return Buffer.from(JSON.stringify({ ...rest, secrets: values }));`（apps/execution-worker/src/program-secret-injection.ts:39、53）。
7. 现有钥匙串封装只在本机：`item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`（clients/apple/Sources/HimawariCore/KeychainValueStore.swift:54）。
8. 现有安全芯片钥匙：`let flags: SecAccessControlCreateFlags = role == .confirm ? [.privateKeyUsage, .userPresence] : [.privateKeyUsage]`（clients/apple/Sources/HimawariCore/SecureEnclaveKeys.swift:75）。
9. Meta Muse（Meta 官方博客 “How We Built Safety Into Muse”，2026-09-08，https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse）：“code in the runtime cell or a worker only ever sees a “surrogate” token, minted by authd”；Sentinel “can evaluate the destination at both layer 4 and layer 7: the hostname, the resolved and final destination IP address, the port, protocol, HTTP method, path, and the actual decoded request”；“The sub-agent, which drives the Browser, sees an accessibility tree snapshot of the page — not the raw DOM”；“while secure credential storage is filling a form, the agent is paused and can’t act at all”；凭据 “stored in your VM, not in centralized Meta infrastructure”。
10. 仓库信封加密用服务器钥匙：`PAYLOAD_ALGORITHM = "aes-256-gcm-envelope-v1"`、`class EnvelopePayloadProtector`（packages/platform-node/src/payload-protector.ts:16、183）。
11. 发给模型的内容只追加：“已经发出去的内容不得改动、重排或删除……系统提示和工具按对话冻结”；“`npm run check:prompt-prefix` 是阻断检查”（AGENTS.md“发给模型的内容只追加”一节）。
12. 浏览器自动化必须在隔离环境：“浏览器自动化……默认必须在独立隔离执行环境执行”（docs/adr/0031-isolated-tool-execution.md:39）。
13. 先准备再执行、核对完全一致的网址来源和页面版本：`const origin = exactOrigin(input.finalUrl);`、`if (inspected.pageVersion !== action.pageVersion || inspected.finalUrl !== action.finalUrl) {`（packages/application/src/services/web-capability-service.ts:250、319）。
14. 1Password for Claude：“A human approves every credential release”“There are no standing approvals”（https://support.1password.com/1password-claude-security/）。
15. Claude 托管 agent 保险库：“the opaque placeholder is substituted with the real secret at egress. The agent never sees the secret value”；`injection_location` 有 `header`、`body` 两项；`allowed_hosts` “controls which requests use the secret”（https://platform.claude.com/docs/en/managed-agents/vaults）。
16. Claude Code 云端：“GitHub credentials are stored encrypted on Anthropic's servers and never enter the session VM.”“The VM holds a short-lived credential scoped to that session”（https://code.claude.com/docs/en/security/）。
17. 方案讨论和安全审核记录：分支 claude/project-thread-o920tx 的 .agents/reviews/topic-agent-secret-vault/ 第 1–5 轮。
