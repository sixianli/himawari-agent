你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 9e8b991852770e504ad18a2cc9c9f8668cdc20ea。
对比基准是 12ce0d0ad0f318f031a00a4f73e423283199ce15，先运行 git diff 12ce0d0ad0f318f031a00a4f73e423283199ce15..9e8b991852770e504ad18a2cc9c9f8668cdc20ea 看改动。
上一轮复核到 644486e6e79800650b3accb70c6938bed3087956，先看 git diff 644486e6e79800650b3accb70c6938bed3087956..9e8b991852770e504ad18a2cc9c9f8668cdc20ea 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 404：服务器设备配对和设备接口（iOS 第 1 批）

## 要解决的问题
让 Andy 的 iPhone、Apple Watch、Mac 上的 Himawari 客户端能安全地连到服务器：配对、用设备密钥签名每个请求、读对话列表、往已有对话发消息、收事件流；主人在网页上确认、改名、移除设备，并看到服务器对设备的十项上限。

## 设计依据
- docs/execution/specs/2026-11-11-apple-device-body-design.md（设备身份和配对、硬上限表）
- docs/execution/plans/2026-11-11-apple-device-body-plan.md 的“第 1 批的任务”

## 约束
- 设备请求按 RFC 9421 固定写法验签：ecdsa-p256-sha256（IEEE P1363 原始签名）、覆盖 @method @authority @path @query，有正文时再覆盖 content-digest、content-type；参数 created、nonce、keyid、alg、tag="himawari-device-v1"。
- 时间差容许 runPolicy.device.signatureToleranceSeconds（默认 60 秒），随机值保留两倍容许时间，每台设备最多保留 device.nonce.retained 个，满了拒绝新请求（429）。
- 配对码 16 字节随机、只存 SHA-256、10 分钟有效、只能用一次；配对后设备是 pending，主人确认后才能用。
- 确认时为设备建一行 devices（浏览器设备）和一条 product_sessions（内部会话），设备的对话请求复用网页的对话网关和访问策略；内部会话不带“近期身份验证”证据。
- 吊销设备时同时吊销它的内部会话和浏览器设备行，正在开着的事件流在下一次心跳时断开。
- 迁移号 0093 是临时号；第 1 批只做单用户。
- 数据导出导出设备的编号、名字、种类、状态、发布渠道、配对和最后在线时间；公钥、配对码、随机值不导出，导入时不恢复设备。
- 不写代码注释（项目规则）。

## 作者的说法（请核对）
1. 任何没在允许清单里的 /api/device/v1/ 路径都返回 404 DEVICE_PATH_NOT_ALLOWED，不会落到别的路由。
2. 重放、改查询、改正文、换主机名、时间差过大都会被拒绝；签名验证在任何写库动作之前。
3. 同一条设备消息（同 messageId）重复发送只进对话一次。
4. 内部会话的编号和 authentication_ref 不出现在任何响应里，设备会话过不了需要本人在场的审批。
5. 吊销后设备的请求、内部会话和已开的事件流都失效。
6. 导出文件里不出现公钥、配对码哈希、随机值。

7. 设备事件流只发设备界面会显示的对话事件（建、分叉、改名、归档、恢复、删、消息、运行取消、任务处理）；其余事件只发一个 device.scanned 帧带游标，游标不丢。
8. 新增设备路由：POST threads（requestId 去重建对话）、GET threads/{id}（after 之后的消息）、GET threads/{id}/execution-stream（运行进度，心跳时复查设备是否还有效）、POST payloads/text（一次最多 100 个，找不到的返回 null）。都走同一套签名和设备状态检查。
9. 配对核对数字 = SHA-256("himawari-pairing-v1" ‖ 设备公钥 DER ‖ 确认公钥 DER) 前 4 字节大端 % 1000000，补零 6 位；只在 pending 时给网页，和 Apple 客户端测试向量一致（971525）。
10. 二维码里的可选 access（clientId、clientSecret）只从 secretReferences 里成对声明的两个密钥读，不进普通配置、日志；只声明一个或重复声明，启动配置被拒。
11. 配对时把两把公钥规范成 DER SPKI 再比较和存储；两把是同一把（哪怕写法不同）拒绝。
12. 同一主人同时只有一个有效配对码；内部会话的 recent_authenticated_at 是 1970-01-01（永远不算近期）。
13. 设备路由的请求体上限是 device.request.body_bytes（可配到 16 MiB），不受网页 256 KiB 默认上限影响；管理路由拒绝多余字段。

## 第 1 轮复核后的处理
- 已改：事件过滤、无斜杠路径、单个有效配对码、反泄漏断言扩到消息和列表、recent_authenticated_at 值、请求体上限、公钥规范化、多余字段、correlationId。
- 不改（文档问题，已报设计线程）：设计文档“九个配置键”应为十个；计划里 web-session/确认键测试是旧方案 A 的残留；改名不同步浏览器设备行的 label 是设计决定。

## 前几轮处理
- 第 1–3 轮的中高意见都已修改（见 b376f01d、6dc31b89、b00250b2）。

## 第 4 轮（644486e6）做了什么
合并 main（12ce0d0a），迁移改名 0094；在网关 v2 接上设备管理五个类型（apps/agent-service/src/production-device-control.ts、production-approval-gateway.ts、production-http-composition.ts，packages/platform-node/src/paired-device-service.ts 等）。

## 第 5 轮：本轮只看 `git diff 644486e6e..HEAD -- apps packages test`
第 4 轮意见的处理：
- 已改（中）：/api/control-center/v1/config 的 installedGatewayV2Operations 加上五个 device.*。
- 已改（中）：确认、改名、移除的重试。ProductionDeviceControl.#change：服务报 PORT_CONFLICT 时读一次设备列表，当前修订号正好是 expectedRevision + 1 且结果已经是这次要的（confirm：active；rename：未移除且同名；revoke：revoked）就返回同一个 resultRef 和 replayed:true，否则原样抛出。没有用回执表，因为 device.pairing.start 同一个码重发本来就只留这一个码，另外三个命令靠 expectedRevision 就能判断。
- 已改（低）：设备名隐藏字符改按 Unicode 类别 Cc、Cf、Zl、Zp 拒绝。
- 已改（低）：access 两个值启动时按合约上限校验（非空、不超过 256 个字符），不合格以 PRODUCTION_HTTP_SECRET_MATERIAL_INVALID 拒绝启动。
- 不改：access 也出现在 REST pairing-codes 的 pairingUri 里（二维码需要，test/integration/device-api.test.ts 已有断言），上一轮说法 17 应读作“网关侧只出现在 device.list.snapshot”；设计文档两处由设计线程在 PR 405 改。

## 本轮作者的说法（请核对）
20. 重试判断不会把别人的修改误报成重放成功：修订号必须正好加一，而且状态或名字必须等于这次命令要的结果。
21. 重试返回的 resultRef 和第一次相同。
22. 设备名规则在合约、REST 配对、REST 改名、网关改名四处是同一个函数。
