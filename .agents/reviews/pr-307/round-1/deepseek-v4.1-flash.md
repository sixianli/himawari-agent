下面结论来自只读检查：`git diff ab4421d..d1b03b6`、六个改动文件全文，以及它们引用的健康检查、部署/回滚脚本和校验脚本。我没有运行测试（本次只允许读和 git 查询）。

## 读代码证实的发现（按严重度）

### 1. 中：正常部署、回滚都会触发失败告警（告警疲劳）
- 文件:行：`scripts/operations/heartbeat/himawari-heartbeat.py:75`，`scripts/delivery-mode/packet-template/systemd/S2-stop-and-inspect.py:247`，`scripts/delivery-mode/rollback-remote.py:42`
- 问题：服务不就绪就立刻 `POST url + "/fail"`；而上线流程本来就会停生产服务，回滚也会停。定时器不随上线流程暂停，所以每次部署/回滚期间至少会发一次 `/fail`，Healthchecks.io 会当失败告警。例行重启/启动期（`OnBootSec=1min`）也可能在服务就绪前告警。
- 证据：
  - `himawari-heartbeat.py:74-76`：`else: send(opener, url + "/fail", problem.encode("ascii"), ...)`。
  - `S2-stop-and-inspect.py:247`：`command(['/usr/bin/systemctl', 'stop', 'himawari-prod.service'], 90)`。
  - `rollback-remote.py:42`：`subprocess.run(['/usr/bin/systemctl', 'stop', unit], ...)`。
  - 定时器 `install-heartbeat.sh:83-86`：`OnBootSec=1min`、`OnUnitActiveSec=1min`。
- 建议：上线/回滚脚本在停服务前暂停 Healthchecks.io 检查（或停 `himawari-heartbeat.timer`）并在恢复后重新启用；或给心跳加“启动/部署宽限”，不要第一次非 200 就发 `/fail`。运行手册也要写明这一步。

### 2. 中：一次 200 就能把检查清成“在线”，可能掩盖间歇性崩溃
- 文件:行：`scripts/operations/heartbeat/himawari-heartbeat.py:39-41,69-73`
- 问题：只要某一次探测拿到 200 就发成功心跳。服务若“启动后短暂就绪、随后崩溃并 10 秒重试”（与 I-83 的崩溃重启模式相近，但端口能短暂打开的情况），每分钟采样可能正好命中就绪窗口，把 Healthchecks.io 的倒计时清掉。对 2026-10-19 那次“始终起不来”的场景能报，但对短窗口崩溃循环存在漏报可能。
- 证据：`if response.status == 200: return None`；`if problem is None: send(opener, url, None, ...)`，没有连续成功阈值。
- 建议：成功信号要求连续 N 次成功（或先 `/start` 再在稳定后发成功），失败也要求连续 N 次；至少写进“没覆盖”的已知限制。

### 3. 中：安装只校验网址语法，不验证 Healthchecks.io 真的接受这个 key
- 文件:行：`scripts/operations/heartbeat/himawari-heartbeat.py:10,18-33`，`scripts/operations/heartbeat/install-heartbeat.sh:55`，`test_heartbeat.py:155-160`
- 问题：`PING_URL.fullmatch` 只保证是 `https://hc-ping.com/<1-64>/<1-64>`；key 写错、检查被删、项目 ping key 与 slug 不匹配时，安装照样成功。之后每分钟都会 `HEARTBEAT_PING_FAILED`，但安装那一刻没有任何“请求真的落地”的证据。这正是 I-73 的教训：清单里的 id 要能通过后端校验，不能只看本地格式。
- 证据：
  - `install-heartbeat.sh:55` 只跑 `--check-url-file`。
  - `himawari-heartbeat.py:48-51` 的 `send` 只在运行期发出请求，安装期不发。
  - `install-heartbeat.sh:94` 仍会打印 `HEARTBEAT_INSTALLED`。
- 建议：`install` 时可选地发一次探测（成功 URL 或专用 ping）并要求 2xx；或至少明确要求按运行手册到 Healthchecks.io 页面确认在线。不要把“语法通过”当成“告警已生效”。

### 4. 中低：`install --keep-url` 不修复已有网址文件的权限，和“root 0600”的说法不一致
- 文件:行：`scripts/operations/heartbeat/install-heartbeat.sh:48-50,60`
- 问题：`--keep-url` 只 `cp` 到临时目录做校验，成功时跳过重新安装，因此原文件的属主/权限不会被改成 0600。若文件曾被手工创建为 0644、或从备份恢复成 0644，重装后依然是全局可读，泄露 ping key。
- 证据：`cp "$url_path" "$staging/url"`，随后 `[[ "$keep" == 1 ]] || install -m 0600 ...`。
- 建议：`--keep-url` 时也校验 `stat` 的属主和 mode，不符就修正或拒绝；测试补一条“0644 的已有文件必须被修正/拒绝”的反向用例。

### 5. 中低：systemd 加固只做了字符串断言，真实运行路径没有自动检查
- 文件:行：`scripts/operations/heartbeat/test_heartbeat.py:193-198,229-233`，`install-heartbeat.sh:68-77`
- 问题：测试只断言 unit 文本里出现 `ExecStart=...`，然后用 `python3 -I` 直接跑安装后的脚本，从未在 `ProtectSystem=strict`、空 `CapabilityBoundingSet`、`RestrictAddressFamilies=AF_INET AF_INET6` 下实际执行。作者重点问的几项（root 读 0600、无 `.py` 后缀、地址族限制）都没有被自动验证。
- 证据：测试 `self.assertIn("ExecStart=/usr/bin/python3 -I /usr/local/sbin/himawari-heartbeat", service)`；实际运行是 `subprocess.run(["python3", "-I", str(installed), ...])`，没有经过 systemd。
- 建议：在 Hermes/生产只读演练里用 `systemd-run` 跑一次带同样加固的单元；或把不能自动化的部分写进运行手册的验收步骤。

### 6. 低：测试用的环境变量在生产脚本里仍然生效，`HEARTBEAT_SYSTEMCTL` 会被当命令执行
- 文件:行：`scripts/operations/heartbeat/install-heartbeat.sh:11-12,18,92-93`
- 问题：`systemctl_command="${HEARTBEAT_SYSTEMCTL:-systemctl}"` 会执行任意路径；`HEARTBEAT_ROOT` 非空还会跳过 root 检查。这两个只是为了测试，但生产脚本没有把它们限制成“仅测试”开关。若 root 执行时环境被影响（如 `sudo -E` 或上层服务），等于以 root 执行任意程序。
- 证据：`"$systemctl_command" daemon-reload`、`"$systemctl_command" enable --now ...`。
- 建议：改成显式测试参数（如 `--root`/`--systemctl` 只在 `--test` 下允许），或至少在脚本里拒绝非 root 之外的人设置这些变量。

### 7. 低：安装失败会留下半装状态，且没有安装后自检
- 文件:行：`scripts/operations/heartbeat/install-heartbeat.sh:57-94`
- 问题：先写网址文件、脚本和 unit，再 `daemon-reload`、`enable --now`。如果 `enable` 失败，`set -e` 退出，但包含密钥的网址文件、脚本和 unit 都已落盘；没有回滚，也没有在启用后检查 `systemctl is-active`。首次安装时 unit 即使启用成功，ExecStart 指向错误或首次运行失败也不会被安装流程发现。
- 证据：`install -m 0600 ... "$url_path"` 在 `enable --now` 之前；`enable` 之后只 `echo "HEARTBEAT_INSTALLED"`。
- 建议：调整顺序（先写 unit/daemon-reload/enable，再写网址），或在启用后跑一次服务并检查 `HEARTBEAT ok`/timer active，失败则回滚或打印明确恢复步骤。

### 8. 低：运行手册与代码/实际行为有几处不一致
- 文件:行：`docs/runbooks/production-server-access-runbook.md:196,199,202`
- 问题：
  1. 196 行说网址“只含字母数字、`_`、`-`”，实际正则还允许一个 `/`（项目 ping key + slug，`himawari-heartbeat.py:10`）。
  2. 199 行把 `status` 和 `HEARTBEAT ok` 放在一起；`status` 输出的是 `is-active`/`list-timers`，`HEARTBEAT ok` 来自 journal（`install-heartbeat.sh:24-27`、`himawari-heartbeat.py:73`）。
  3. 202 行验收“停服务约 6 分钟确认失败通知”：停的只是 `himawari-prod.service`，定时器仍在跑并会立即发 `/fail`，6 分钟既不需要，也没有验证“整机停/定时器停 → 超时告警”那条路径。
- 建议：196 行补“最多一个 `/`”；199 行区分两条命令的输出；202 行分别写清 `/fail` 路径和“停掉 `himawari-heartbeat.timer` 超过宽限”的超时路径。

### 9. 低：心跳 URL 正则接受 `/fail` 形式的 URL，误填会导致永久失败
- 文件:行：`scripts/operations/heartbeat/himawari-heartbeat.py:10,72-75`；`test_heartbeat.py:155-160`
- 问题：`https://hc-ping.com/<uuid>/fail` 也能通过正则（被当成“第二段 slug”）。若操作者把 Healthchecks.io 上的 fail URL 粘进来，正常成功心跳会 GET 到 `/fail`，检查会一直显示失败；失败时又发 `/fail/fail`。测试只覆盖了“项目 key + slug”的成功路径，没有覆盖 slug 的失败路径。
- 建议：拒绝最后一段为 `fail`（或 `start`）的网址，或明确支持并加对应测试。

### 10. 低：本机端口 8400 在脚本里硬编码，与生产配置的耦合没有自动校验
- 文件:行：`scripts/operations/heartbeat/himawari-heartbeat.py:9`，`scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:36`
- 问题：`DEFAULT_READY_URL = "http://127.0.0.1:8400/health/ready"`，生产配置是 `"listenPort": 8400`。今天一致；以后改端口时心跳会一直报 `/fail`（假告警，不会静默），但仓库里没有检查把这两处绑在一起。
- 建议：安装时从生产配置读取端口，或至少加一条文档/测试记录这个耦合。

### 11. 低：`probe_ready`/`send` 没捕获 `http.client.HTTPException`
- 文件:行：`scripts/operations/heartbeat/himawari-heartbeat.py:44,77`
- 问题：本地 `/health/ready` 返回畸形响应时（`BadStatusLine`、`IncompleteRead` 等不属于 `OSError`/`ValueError`），会抛未捕获异常，脚本以 traceback 失败，且这一轮不会发 `/fail`（要等 Healthchecks.io 超时才告警）。
- 建议：捕获 `http.client.HTTPException` 并当作“ready did not answer”发 `/fail`。

## 推测/未核实

- **Healthchecks.io `/fail` 立即告警**：这是外部服务行为，代码里无法核实；我按作者说法接受，但未验证。
- **换 key 后“新检查从不 ping 会不会告警”**：取决于 Healthchecks.io 对从未 ping 过的检查的策略，未核实；因此第 3 条才建议安装时主动验证。
- **`RestrictAddressFamilies=AF_INET AF_INET6` 与 DNS**：libnss_dns 用 AF_INET/AF_INET6 没问题；但如果生产机的 NSS 走 `nss-resolve`/`nscd` 的 AF_UNIX/D-Bus，则可能解析失败。生产机的 `/etc/nsswitch.conf` 未核实。
- **`ProtectSystem=strict` + 空 `CapabilityBoundingSet` 读 0600 文件**：从权限模型看 root 作为文件属主有 owner read 位，应该可以；但没有在真实 unit 下跑过（见第 5 条）。
- **部署/回滚的完整时长**：我只确认了它们会停服务，没有实测停服持续多久；按流程（S2 停到 S7 再启动）推断会超过 1 分钟，足够触发至少一次 `/fail`。

## 侧重检查

查过并给出结论的路径：

- **错误路径/不可信输入**：URL 文件读取有 513 字节上限；只接受 ASCII；`fullmatch`，不能注入 userinfo、端口、查询串、额外路径（除了一个 `/`）；`/fail` 是用受限 URL 拼出来的。见 `himawari-heartbeat.py:18-33`、测试 `test_heartbeat.py:126-146`。结论：主机的替换面被限制在 `hc-ping.com`，但 `/fail` 作为输入 URL 可被误接受（第 9 条）。
- **网址泄露面**：脚本的 stderr 只有 `HEARTBEAT_URL_UNREADABLE/INVALID`、`HEARTBEAT_PING_FAILED`、`HEARTBEAT fail <reason>`，不含 URL；`install` 从 stdin 读，命令行只传 `--url-file <staging path>`；unit 和测试都断言 unit 里没有 `hc-ping`。见 `install-heartbeat.sh:52-55`、`himawari-heartbeat.py:63-79`、`test_heartbeat.py:195,199`。结论：正常路径不泄露；未捕获的异常 traceback 是否含 URL 未逐一验证（第 11 条）。
- **资源耗尽**：URL 文件最多读 513 字节、心跳响应最多读 64 字节、每分钟一个短进程、无递归/无无界循环。结论：没有明显资源耗尽路径。
- **不可撤销操作**：`remove --purge` 删密钥、`install` 直接覆盖旧 URL 且不备份。属操作者主动行为，低风险；建议保留旧 URL 备份或至少提示。
- **规则/文档/代码一致性**：I-83 只在“未覆盖”里追加心跳说明，没有把它冒充门槛；`scripts/operations/heartbeat/` 路径存在；runbook 的 `#heartbeat` 锚点存在；`check:incident-gates` 不会因为目录路径带尾斜杠而检查它（正则要求最后一段是文件名），但目录确实存在。文档不一致集中在第 8 条。
- **跨组件使用**：部署/回滚会停 `himawari-prod.service` 但不会暂停心跳（第 1 条）；`deploy-preflight` 的 `SERVICE_ACTIVE` 只要求 prod 服务 active，不会被新 unit 触发；仓库里没有其他地方引用 `himawari-heartbeat`，所以上线包不会安装/删除它（符合作者的“不随上线包安装”）。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。依据：`git diff` 只改了 `scripts/operations/heartbeat/*`、两处文档和 `package.json` 的检查脚本；没有任何应用/提示词/遮盖代码引用新目录（`grep heartbeat` 在 `scripts/` 里只匹配到新脚本本身和无关的 `heartbeatMilliseconds`）。因此系统提示、工具定义、历史消息、遮盖结果都不变；发给模型的内容仍然只由原有逻辑在末尾追加。该改动在模型请求路径之外。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。该改动不生成、不修改发给模型的文字，也不涉及 JSON 序列化、集合顺序、时间字段或遮盖。唯一随运行变化的是心跳的失败原因字符串和网址文件内容（`himawari-heartbeat.py:74-76`），它们只进入 Healthchecks.io 的请求，不进入模型请求。

**3. 有没有对应的自动检查，反向用例会真的失败吗？**
有：`package.json:45` 定义 `check:heartbeat`，`package.json:27` 把它加入 `check:steps`，而 `scripts/run-all-checks.mjs:32` 会从 `check:steps` 解析并逐个执行。反向用例从断言看是有效的：
- 非 200 → 期望 `POST PING + "/fail"`（`test_heartbeat.py:86-92`），若把非 200 当就绪会失败；
- 不就绪 → 期望 `/fail`（同上），若去掉 `/fail` 会失败；
- 无效/错误主机 URL → 期望退出 2 且不发任何网络请求（`test_heartbeat.py:126-146`），若放宽主机校验会失败；
- ping 失败 → 期望退出 1 且输出不含 URL（`test_heartbeat.py:118-124`）。
但我没有实际运行（工具限制）。另外有两个缺口：`test/tooling/run-all-checks.test.mjs:58-67` 只钉住了 delivery 系列检查，没有断言 `check:heartbeat` 必须留在 `check:steps`；systemd 加固、`--keep-url` 权限、`enable` 失败后的半装状态都没有反向用例。

**4. 每个产生/修改的值，使用它的地方都能接受吗？逐个核对**
- **心跳网址**：产生于操作者输入 → `/etc/himawari/healthcheck-url`；本地消费方是 `read_ping_url` 的 ASCII + `PING_URL` 校验；远端消费方是 Healthchecks.io。本地校验能阻止换主机，但只做语法校验，不保证远端接受 key（第 3 条）；`/fail` 形式会被误接受（第 9 条）。
- **URL 文件路径**：`himawari-heartbeat.py:8` 默认值、`install-heartbeat.sh:14` 安装路径、runbook、测试显式 `--url-file` 全部一致。
- **安装后的脚本路径 `/usr/local/sbin/himawari-heartbeat`**：`install-heartbeat.sh:13,59` 写入，`:68` 的 `ExecStart` 使用；测试 `:194` 断言一致。注意 `HEARTBEAT_ROOT` 只影响写入路径，不影响 `ExecStart` 里的硬编码路径，测试因此没有真正验证“unit 执行的就是它安装的那个文件”。
- **unit/timer 名**：`himawari-heartbeat.service`/`.timer` 在 install、status、remove、enable 中一致；timer 没有 `Unit=`，systemd 默认找同名 service，正确。
- **`check:heartbeat`**：`package.json:45` 产生，`package.json:27` 的 `check:steps` 使用；`run-all-checks.mjs:8-10` 的 `stepNames` 只接受 `npm run <name>`，本项是纯 npm script，能通过。
- **端口/路径 `127.0.0.1:8400/health/ready`**：脚本常量、runbook、生产配置模板 `listenPort: 8400` 一致；`http-gateway-server.ts:855-859` 的 `HEALTH_PATH` 豁免 Host 检查，`service-main.ts:2102-2121` 在 `/health/ready` 上更新 worker/authority 健康，所以本机无 Host 头也能访问。但端口是两处硬编码（第 10 条）。
- **文档值**：I-83 引用的 `scripts/operations/heartbeat/` 存在；BL-20261021-009 链接存在；runbook 锚点 `#heartbeat` 存在。`check:incident-gates` 不会检查带尾斜杠的路径，但目录存在，当前不报错。

总体上，核心设计（本机就绪探测 + 机器停摆靠 Healthchecks.io 超时）能覆盖 2026-10-19 那次“服务始终起不来/整机不可用”，没有发现会静默漏掉该场景的代码错误。最需要先处理的是**正常部署/回滚会触发的假告警**和**安装时不验证 key 是否被 Healthchecks.io 接受**。
