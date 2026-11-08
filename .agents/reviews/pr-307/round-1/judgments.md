# PR 307 第 1 轮 逐条判断

复核提交 d1b03b6，基准 ab4421d。模型意见按线程核对（读代码，必要时运行）分类。

## 会出错，中、高（1 项）
- ds-1 / glm-2（两个模型都提）：部署和回滚会停 himawari-prod.service（`S2-stop-and-inspect.py:247`、`rollback-remote.py:42`），心跳定时器不暂停，每次正常上线都会向 /fail 发信号并告警。运行手册没写这个预期。作者可选：上线前暂停检查并在手册写步骤，或只对持续不就绪发 /fail，或至少写明预期。

## 会出错，低
- ds-4 `--keep-url` 不修复已有网址文件权限（需手工建 0644 文件才触发）。
- ds-5 systemd 加固无真实环境检查（线程在容器里无法运行 systemd，未实测；失败是响亮的）。
- ds-7 / glm-3 enable 失败留半装状态，重跑可恢复。
- ds-8 / glm-6 运行手册 196 行字符集描述与正则不符（正则还允许一个 / 加第二段）。
- ds-9 把 /fail 网址粘进 install 会被接受，之后一直失败告警。
- ds-11 本机端口返回非 HTTP 内容时 `BadStatusLine` 未捕获（线程用假服务实测：退出码 1、traceback、没发 /fail，靠 Healthchecks.io 超时告警）。
- glm-7 `status` 分支无测试。

## 可以更好（不改，列给 Andy）
- ds-3 安装时不验证 key 是否被 Healthchecks.io 接受。建议不采纳：手册验收第一步已要求“页面显示检查在线”。
- ds-10 端口 8400 硬编码。建议不采纳：端口变了会响亮失败。
- glm-4 install 多余参数静默忽略。建议不采纳。

## 不成立
- ds-2 “一次 200 清成在线”：不就绪的采样会立即发 /fail，崩溃循环不会静默（`himawari-heartbeat.py:72-75`）。
- ds-6 HEARTBEAT_SYSTEMCTL 环境变量：能控制 root 环境的人已经是 root，没有不可信输入路径。
- glm-1 代理环境变量：systemd 服务不读 /etc/environment，仓库里没有 DefaultEnvironment 设置（grep 无结果）。
- glm-5 失败的 oneshot 会不会停止定时：systemd 文档把 OnUnitActiveSec 定义为“相对于该单元上次被激活的时间”，没有区分成败（https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html）。

## 必答问题
两个模型都答：不改变模型请求开头（只改运维脚本和文档）；有自动检查 check:heartbeat。DeepSeek 补充：test/tooling/run-all-checks.test.mjs 没钉住 check:heartbeat 留在 check:steps（可以更好）。

## 费用
账本累计 0.2976 美元（含 GLM 第一次因 opendesign 上游 400 失败、重跑一次；账本按保守口径记，实际约 0.10）。
