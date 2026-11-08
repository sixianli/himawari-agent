# PR 307 第 2 轮 逐条判断（只跑 DeepSeek，增量 d1b03b6..e1ec166）

## 会出错，中、高：无
## 会出错，低（1 项）
- r2-9 运行手册 196 行“不写进仓库、配置文件或日志”与网址就存放在配置目录的事实措辞冲突；199 行 `status` 与 `HEARTBEAT ok` 并列易误读。只是措辞，建议改为“不写进仓库、命令行或日志”并分开写两条命令的输出。

## 不成立
- r2-1（模型标“高”）：Healthchecks.io 官方文档写 /log “Sends logging information to Healthchecks.io without signaling success or failure”“The check's status will remain the same”，slug 网址同样支持 /log（https://healthchecks.io/docs/http_api/）。文档没明说是否重置计时，但只有成功 ping 才算心跳；手册验收（停服务约 6 分钟收到通知）正是对这一点的实测，装生产前必须做。附带：模型担心“两段网址的 /log 不可用”，文档的端点表列出了 `<ping-key>/<slug>/log`。

## 可以更好（不改，列给 Andy）
- r2-2 崩溃重启循环：每次“能就绪几分钟再崩”的循环要连续 5 分钟没有一次就绪才告警。这是作者为避免上线误报做的取舍；建议在手册“没覆盖”补一句。本次 I-83 类故障（始终起不来）仍会告警。
- r2-3 手工暂停忘记恢复：建议手册加“恢复后确认页面重新在线”。
- r2-4 / r2-5 / r2-8：与第 1 轮 ds-7 / ds-5 / glm-4 同，作者已在手册写明重跑和用 journalctl 确认。
- r2-6 以 root 从可写目录安装：单管理员生产机，操作者自己拷贝；加固建议。
- r2-7 HTTPError 未关闭：短命进程。

## 未核实
模型推测 I-83 的“心跳覆盖错内核重启”说法：内核不符时服务启动即失败（sandbox-host-verifier.ts），不会就绪，推断成立，未读完整调用链。
