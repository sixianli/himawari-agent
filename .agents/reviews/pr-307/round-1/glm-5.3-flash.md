# PR #307 复核（心跳告警）

## 结论一览
改动范围核实：diff 只涉及 `docs/incidents-and-gates.md`、`docs/runbooks/production-server-access-runbook.md`、`package.json`、`scripts/operations/heartbeat/` 三个新文件。未发现高危问题。

## 问题清单（按严重度从高到低）

**中｜scripts/operations/heartbeat/himawari-heartbeat.py:38-44 + install-heartbeat.sh:39（unit 无环境净化）——代理环境变量可能让探测误报或漏报【推测，取决于生产环境，未核实】**
证据：`probe_ready` 用 `urllib.request.urlopen`，而 urllib 默认遵循 `http_proxy`/`no_proxy` 环境变量；systemd 单元里没有 `UnsetEnvironment` 或 `NO_PROXY`。若生产机的 systemd 全局环境（`/etc/environment`、`DefaultEnvironment`）里有 `http_proxy`，发往 `http://127.0.0.1:8400` 的探测会被交给代理，代理通常连不进本机回环 → 服务明明正常，每分钟发 `/fail` 误报。建议单元里加 `Environment=NO_PROXY=127.0.0.1,localhost`（或 UnsetEnvironment 相关变量）。

**中｜设计取舍，作者自己问的「重启期间每分钟发 /fail 是否合理」【Healthchecks.io 外部行为部分属推测/未核实】**
证据：himawari-heartbeat.py:69 `send(opener, url + "/fail", ...)` 对一切非 200（含重启、部署的几十秒窗口）立即发失败信号；runbook 第 194、199-200 行配置周期 1 分钟、宽限 5 分钟。Healthchecks.io 收到 `/fail` 会立即判 down 并通知（外部服务行为，未核实）。后果：每次上线/重启服务的几十秒都会产生一对 down/up 通知——这正是「没人知道」要防的场景，但 runbook 的「验收」「没覆盖」两节都没写「正常上线重启也会告警」，Andy 第一次上线就会收到意外推送。替代方案：短抖动只靠 200 心跳断流（周期 1 分钟 + 宽限 5 分钟本来就能约 6 分钟后告警），仅对持续不就绪发 `/fail`；或至少在 runbook 写明预期。

**低｜install-heartbeat.sh:89-93 —— enable 失败留半装状态【读代码证实】**
证据：脚本按「写脚本→写网址→写 unit→`daemon-reload`→`enable --now`」顺序执行，`set -e` 下 `enable --now` 失败（如 systemd 不可用）直接退出，已写的 `/usr/local/sbin/himawari-heartbeat`、unit、网址文件都留在盘上，无回滚。重跑 install 可恢复，但 runbook 没写这个失败模式。可在失败时提示或先 `enable --now` 后再报告成功顺序调整。

**低｜install-heartbeat.sh:60-63 —— install 对多余参数不校验【读代码证实】**
证据：只检查 `[[ "${1:-}" == --keep-url ]]`，`install --purge`、`install --keep-url 任意串` 都被静默当成普通 install 处理（`--purge` 被忽略、多余参数丢弃）。建议参数数不符时 `usage`。

**低｜timer 与失败 oneshot 的节奏【推测，未核实】**
证据：unit 是 `Type=oneshot`（install-heartbeat.sh:42），timer 用 `OnBootSec`+`OnUnitActiveSec`；ping 发不出去或网址文件损坏时脚本 exit 1/2，service 进入 failed 态。`OnUnitActiveSec` 对 failed 的 oneshot 是否仍保持每分钟触发，systemd 各版本行为有争议。即便节奏被破坏，Healthchecks.io 超时告警仍会发（它只看收没收到信号），所以不漏报，但「恢复后自动恢复心跳」需在 Ubuntu 24.04 实测一次失败路径（例如临时放无效网址再恢复）。

**低｜docs/runbooks/production-server-access-runbook.md:198 —— 校验描述与代码不完全一致【读代码证实】**
证据：runbook 说「只接受 `https://hc-ping.com/` 开头、只含字母数字、`_`、`-` 的网址」；实际正则（himawari-heartbeat.py:8）还允许可选的第二段 slug（如 `/himawari-prod`，测试 `test_a_project_ping_key_url_with_a_slug_is_accepted` 也覆盖了）。建议文档补一句。

**低｜测试覆盖缺口【读代码证实】**
- `status` 分支无任何测试。
- systemd 沙箱指令、timer 真实触发、`enable --now` 真实效果：测试全部用假 `systemctl`（test_heartbeat.py 的 `HEARTBEAT_SYSTEMCTL`），真实 Ubuntu 24.04 上只有 runbook 的人工验收步骤，无自动检查。
- Healthchecks.io 对 `/fail` 的真实语义：未核实（外部服务）。

## 读代码证实的（作者说法与代码一致处）
- `/health/ready` 存在且就绪 200/否则 503：packages/platform-node/src/http-gateway-server.ts:917-923。端口 8400 与多处文档一致（docs/adr/0089-web-push-only-entry.md:57 等，实际文件名为 0089-web-push-only-owner-entry.md）。
- 服务按 Host 头校验来源但豁免 `/health/*`（docs/runbooks/production-web-entry-runbook.md:68），所以心跳的默认 Host 头不会被 403 拦下——这条没写进 runbook 心跳节，但成立。
- `check:heartbeat` 已挂进 `check:steps`（package.json），且 scripts/run-all-checks.mjs:32 从 `check:steps` 解析步骤清单，`npm run check` 会跑它。
- I-83 行新增的 `scripts/operations/heartbeat/` 路径存在；scripts/check-incident-gates.mjs:65-70 会校验 gate 列反引号路径存在，不会因为这一行挂掉。
- runbook 的 BL-20261021-009 链接目标存在。
- 网址校验两端同源：install 校验（install-heartbeat.sh:71 调 `himawari-heartbeat.py --check-url-file`）和运行时校验用同一个 `PING_URL` 正则，不存在两端规则漂移。
- 网址不落命令行/日志：install 从 stdin 读（`head -c 600 > staging`），运行时只把网址放进请求 URL，失败输出只有 `HEARTBEAT_PING_FAILED`，测试 `test_a_failed_ping_is_an_error_exit_without_the_url` 和 install 测试都断言了 URL 不出现在输出。
- URL 文件换成别的主机发不出去：正则 fullmatch 锚定 `https://hc-ping.com/` 且字符集受限（含对查询串、多段路径、非 ASCII、超长的反向用例）。
- systemd 限制可跑：`ProtectSystem=strict` 只把文件系统变只读，脚本读 `/etc` 不写盘；root 读自己 0600 文件走属主位，不需要 capability；`AF_INET` 在允许列表；`python3 -I` 运行无后缀文件没有问题。

## 侧重检查：一条普通流程的走查
安装（root，stdin 给网址）→ 校验（失败即退出，测试证实零副作用）→ 落盘脚本/unit/网址 → `enable --now` timer → 每分钟 timer 触发 oneshot → 读 `/etc/himawari/healthcheck-url` → GET `127.0.0.1:8400/health/ready` → 200 发 GET 心跳 / 非 200 发 POST `/fail` + 原因 → Healthchecks.io 超时兜底。
无测试覆盖的路径：`status` 分支；真实 systemd 的 enable/timer/沙箱（假 systemctl）；Healthchecks.io 真实行为；生产安装本身（PR 有意不动生产，属预期）；`enable --now` 失败的半装恢复路径。

## 必答问题

1. **请求开头**：不会变。diff 只新增运维脚本、改 npm 脚本表和两份文档，完全没有触碰系统提示、工具定义、历史消息或出口遮盖相关代码；发给模型的内容不因此改动。（读 diff 证实）
2. **确定性**：不会。新代码不进入模型请求路径，没有引入依赖前后文的遮盖、时间字段或无序集合。（读 diff 证实）
3. **自动检查**：有——`check:heartbeat` 已进 `check:steps`，随 `npm run check` 运行。反向用例（9 种非法网址不发网络包、缺文件、ping 失败、503/204/无连接）都有断言；但我无权执行命令，「反向用例真的会失败」只核实到断言逻辑，未实际运行。systemd 在真实 Ubuntu 24.04 上的行为无自动检查，只靠 runbook 人工验收。
4. **每个值的产生端/消费端**：URL 文件路径（install 写 `/etc/himawari/healthcheck-url` ↔ 脚本默认值一致，权限 0600↔root 读取一致）；网址正则（两端同一模块）；unit/服务名（install ↔ status/remove ↔ runbook 的 journalctl 命令一致）；ExecStart 路径 ↔ `script_path` 一致；端口与端点 ↔ http-gateway-server.ts:917 一致；`check:heartbeat` ↔ test 文件路径一致；I-83 引用路径存在。未发现 I-73 式「两端校验不一致」的问题。
