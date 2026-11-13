# PR 470 第 1 轮逐条判断

成立的“会出错”：D1（高），D4–D11（中），D13–D15（低）。全部已改并补用例，改动后跑第 2 轮复核。D2、D3、D12 不成立，理由见下。

- D1（会出错，中高）：成立。改为每条都被拒时抛 PerceptionUploadError.allRejected，传感器报“传不上去”且游标不动；只有部分被拒才跳过那几条。加用例 whenTheServerRejectsEveryRecord…
- D2（不成立）：不成立。客户端按服务器配置开关：没有 device.perception.batch_records 时短信传感器报“服务器还不收”、一条不传（MessagesDatabase.swift tick 开头）；config 里没有 attachments 时输入条拒绝带附件（InputBarModel.send 的 attachmentsUnsupported）。服务器端契约在 PR 451（POST perception）和第 6 批分支 vjxssg（POST attachments、config.attachments）里，客户端字段已逐项对过两边的源码；服务器没合时不会发出请求
- D3（不成立）：不成立。system_api 在 PR 451 的 packages/application/src/ports/perception.ts 的 PERCEPTION_CAPTURE_SOURCES 清单里，message.text 的服务器测试也用它
- D4（会出错，中高）：成立。加 session 计数，begin/close 递增并复位 sending；发送任务每次写状态前核对 session，旧任务的结果丢掉
- D5（会出错，中高）：成立。附件集合一变（add/remove）就清掉 pendingRequestId，下次发送换新编号
- D6（会出错，中高）：成立。游标改为比较后再写：MacAccessSettings.moveMessagesCursor(from:to:) 只有当前游标等于这次开始时的值才写；开关逻辑移到 Core 并加两条 Linux 用例
- D7（会出错，中高）：成立。去掉 NSUnarchiver，改用 Core 里只按长度取字符串、处处检查边界的 TypedStreamText；加正例、长消息、截断、坏长度、非法 UTF-8 用例，macOS 上另有一条用系统 NSArchiver 生成数据再读回的用例
- D8（会出错，中高）：成立（目前没有生产调用点，但这是以后文件动作的安全前提）。realPath 改为对存在的最长前缀调用系统 realpath，剩下不存在的部分再按字面处理；加用例，已确认旧代码在这条用例上失败
- D9（会出错，中高）：成立。canSend 改为有文字或有附件即可
- D10（会出错，中高）：成立。按“条目+动作+绑定”保存 requestId，成功前一直复用；失败时面板显示“没办成，再点一次”
- D11（会出错，中高）：成立。拖入的文件和 chat.db 都在后台读，读完回主线程；拖入时按服务器的 perMessage 截住并提示太多（ContextGathering.merge 加 limit，有用例）。批次条数是服务器配置的值，不在客户端另设上限（项目规则：能变的不写死）
- D12（不成立）：不成立。PR 451 里 POST perception 返回 200 时每条记录都已有结果（stored、duplicate、limit、sense_off 等），这些是服务器的最终决定，不是“未达、待重传”；需要重传的情况服务器返回 5xx，客户端不挪游标（用例 aServerOrNetworkFailureIsNotSkipped…）
- D13（会出错，低）：成立。没有能停下的控制方时不显示“停下”按钮（canStop）；文件动作和停下在 9A、权限审批合并后接线。ResultNotices、撤销、清单界面在本 PR 没有生产入口，用户看不到
- D14（会出错，低）：成立。发出去的消息不再带 sender，加用例；设计文档编号一行改为“来源自带稳定编号的用它的哈希”。RCS 归为 sms 保留：服务器 evidence.service 只认 sms 和 imessage
- D15（会出错，低）：成立。夹具改用 subdirectory 写法；新增 test/tooling/apple-attachment-fixture.test.ts 用网页的 joinDraft 核对夹具并接进 check:apple-design（已反向验证：改动夹具一处就失败）；改名并重写开关用例，测的是 Core 里真实的开关和游标逻辑
