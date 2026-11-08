## 复核结论

本次 PR 的代码改动只有 `scripts/operations/heartbeat/` 三个新文件、`package.json`、两份文档和 `.agents/reviews/pr-307/` 记录；`git diff --name-status 0f468696..5f562ba5` 共 19 个文件，没有触碰系统提示、工具定义、消息历史、遮盖或压缩代码，因此**不会改变模型已经见过的请求开头**。

但材料与最终代码有一处实质性出入：作者说“不就绪向 `网址/fail` POST，Healthchecks 收到 `/fail` 立刻告警”，实际代码发的是 `/log`，靠 5 分钟宽限超时告警。另有若干运行环境、安全和安装可靠性风险。

---

## 一、读代码证实的问题（按严重度）

### 1. 【中】材料/提交说明与代码不一致：实际发 `/log`，不是 `/fail`

- 文件:行：`scripts/operations/heartbeat/himawari-heartbeat.py:77`；`docs/runbooks/production-server-access-runbook.md:194`
- 问题：作者材料（以及 `d1b03b61` 的提交说明）说“其他情况向「网址/fail」POST 一行原因”“Healthchecks 收到 `/fail` 立刻告警”。实际代码在非 200 时发的是 `url + "/log"`，不是 `/fail`；`e1ec166a` 已经有意把失败信号改成 `/log`，运行手册也按 `/log` 写。两者语义不同：`/fail` 会立即把检查标成 down 并告警，`/log` 只记日志、不改变检查状态，要靠 5 分钟宽限超时才告警。
- 证据：
  - `himawari-heartbeat.py:77`：`send(opener, url + "/log", problem.encode("ascii"), arguments.timeout)`
  - `himawari-heartbeat.py:78`：`print("HEARTBEAT skipped " + problem, file=output)`
  - `docs/runbooks/production-server-access-runbook.md:194`：“不就绪就不发心跳，只把原因记进这条检查的日志，连续超过宽限时间（5 分钟）没收到心跳，Healthchecks.io 才发通知。”
  - `git show e1ec166a` 的提交说明：“不就绪改为 POST /log（不改检查状态），靠宽限 5 分钟没收到心跳才告警”。
- 建议：修正 PR 描述、复核材料和 `d1b03b61` 的说明，明确最终行为是 `/log` + 5 分钟超时。如果确实想要 `/fail` 的即时告警，需要另改，并重新评估上线停服期间的误报（这正是 `e1ec166a` 修掉的问题）。

### 2. 【中】安装不是原子的：URL 在 `enable` 之前就被替换，失败会留下“URL 已换、timer 未启用/未生效”的半装状态

- 文件:行：`scripts/operations/heartbeat/install-heartbeat.sh:59-60`、`92-93`
- 问题：脚本先写脚本文件和 URL 文件，再写 unit，最后才 `daemon-reload` + `enable --now`。如果 `enable` 失败（unit 被 mask、systemctl 不可用、权限/策略拒绝等），URL 已经被替换成新值；如果新 URL 是错的，重跑前这段时间心跳可能已经中断。测试没有覆盖 `systemctl` 失败的路径。
- 证据：
  - `install-heartbeat.sh:59-60`：
    `install -m 0755 "$here/himawari-heartbeat.py" "$script_path"`
    `if [[ "$keep" == 1 ]]; then chmod 0600 "$url_path"; else install -m 0600 "$staging/url" "$url_path"; fi`
  - `install-heartbeat.sh:92-93`：
    `"$systemctl_command" daemon-reload`
    `"$systemctl_command" enable --now himawari-heartbeat.timer`
- 建议：先验证 `systemctl`/unit 环境，再把 URL 换成临时文件，`enable` 成功后再原子替换；或至少把 URL 写入放到 `enable` 之后。补一个“fake systemctl 在 enable 时返回非零”的测试，断言失败后旧 URL 未被覆盖或明确提示恢复步骤。

### 3. 【中低】URL 秘密放在 `/etc/himawari`，该目录对生产账号 `himawari-prod` 可写；root 0600 不能阻止该账号替换/删除，运行时不复核属主/权限/符号链接

- 文件:行：`scripts/operations/heartbeat/himawari-heartbeat.py:22-25`；`scripts/delivery-mode/packet-template/signing/cloud-protected-prepare.mjs:70,175-177`；`scripts/delivery-mode/packet-template/systemd/himawari-prod.service.draft:9,21`
- 问题：heartbeat 以 root 运行、URL 文件 root 0600，但文件所在目录 `/etc/himawari` 必须是生产账号 `himawari-prod` 可写的，因为生产服务启动前的 `cloud-protected-prepare.mjs` 以该账号在 `/etc/himawari` 创建 `config.json.next` 并 `rename` 覆盖 `config.json`。目录可写意味着该账号可以 unlink/替换 `healthcheck-url`（虽然读不到原内容），从而把心跳指到它控制的另一个 Healthchecks 检查并自行保活，绕过告警。运行时的 `open(path, "rb")` 还跟随符号链接，不校验属主、模式、普通文件。
- 证据：
  - `himawari-prod.service.draft:9`：`User=himawari-prod`
  - `himawari-prod.service.draft:21`：`ExecStartPre=... cloud-protected-prepare.mjs --prepare /etc/himawari/config.json`
  - `cloud-protected-prepare.mjs:70`：`assert(process.getuid() > 0, "RUNTIME_ACCOUNT_REQUIRED");`
  - `cloud-protected-prepare.mjs:176-177`：`await writeFile(configPath + ".next", ...); await rename(configPath + ".next", configPath);`
  - `himawari-heartbeat.py:22`：`with open(path, "rb") as handle:`
  - `install-heartbeat.sh:60`：`install -m 0600 "$staging/url" "$url_path"`
- 建议：把 URL 放到 root 独占的子目录（例如 `/etc/himawari/heartbeat/`，root 0700），或使用 systemd `LoadCredential=` 把 root 文件以只读 fd/路径交给服务；运行时用 `os.lstat`/`O_NOFOLLOW` 并断言 regular file、uid 0、模式 0600。
- 说明：生产账号本来就能伪造 `/health/ready` 的响应，这个问题的独立影响有限；但它确实能“替换监视目标、压掉告警”，属于完整性风险。

### 4. 【低】`status` 恒返回 0，并且和 `remove`/`install` 一样强制要求 root

- 文件:行：`scripts/operations/heartbeat/install-heartbeat.sh:18-27`
- 问题：`status` 分支对 `is-active` 和 `list-timers` 都加 `|| true`，最后无条件 `exit 0`，无法用作自动化健康检查；而 root 检查在 `case` 之前，普通用户连只读的 `status` 都跑不了，运行手册的“查看”一节也没有提醒要 root。
- 证据：
  - `install-heartbeat.sh:18-20`：`if [[ -z "$prefix" && "$(id -u)" != 0 ]]; then ... exit 77; fi`
  - `install-heartbeat.sh:25-27`：`"$systemctl_command" is-active ... || true`、`... list-timers ... || true`、`exit 0`
- 建议：`status` 按真实状态返回非零（或至少区分 inactive/failed）；文档写明 `status` 也需要 root，或者把 `status` 的 root 检查移到 `install`/`remove` 分支。

### 5. 【低】就绪地址/端口硬编码为 `127.0.0.1:8400`，与生产配置模板是隐式耦合

- 文件:行：`scripts/operations/heartbeat/himawari-heartbeat.py:10`；`scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:34-37`
- 问题：心跳固定探测 `http://127.0.0.1:8400/health/ready`。当前生产配置模板确实是 `listenHost: 127.0.0.1`、`listenPort: 8400`（已核对），但以后若改端口/监听地址，心跳会静默探测错误的端口：要么一直不就绪（误报），要么打到别的本机 200 服务（假 ok）。安装脚本和运行手册都没有从生产配置读取或核对端口。
- 证据：
  - `himawari-heartbeat.py:10`：`DEFAULT_READY_URL = "http://127.0.0.1:8400/health/ready"`
  - `production-shape-config-template.json:34-37`：`"http": { "listenHost": "127.0.0.1", "listenPort": 8400, ... }`
- 建议：安装时从 `/etc/himawari/config.json` 读取 `http.listenPort`/`listenHost` 并写成 `--ready-url`，或至少在 runbook 的安装步骤里要求核对；如果保持硬编码，加一条“模板端口变了就改这里”的检查。

### 6. 【低】测试没有锁定 systemd 加固项，也没有安装失败路径

- 文件:行：`scripts/operations/heartbeat/test_heartbeat.py:210-215`
- 问题：安装测试只断言了 `ExecStart=` 和 `OnUnitActiveSec=1min`，没有断言 `NoNewPrivileges=yes`、`ProtectSystem=strict`、`ProtectHome=yes`、`PrivateTmp=yes`、`PrivateDevices=yes`、`CapabilityBoundingSet=`、`RestrictAddressFamilies=`。因此加固项被误删/改坏时测试仍然通过；而运行手册把“加固选项没在真实 systemd 上跑过”列为主要风险。另无 `enable` 失败、`daemon-reload` 失败的测试。
- 证据：
  - `test_heartbeat.py:210-213`：只读 service，断言 `ExecStart=/usr/bin/python3 -I /usr/local/sbin/himawari-heartbeat`、不含 `hc-ping`，再断言 timer 含 `OnUnitActiveSec=1min`
- 建议：断言完整 unit 文本（或生成快照），并在 CI 可用的环境跑 `systemd-analyze verify`（或至少在真机验收时执行并记录）；补 `enable` 失败的断言。

### 7. 【低】运行手册的安装命令不是可直接执行的写法

- 文件:行：`docs/runbooks/production-server-access-runbook.md:198`
- 问题：`bash install-heartbeat.sh install < <装有专属网址的文件>` 里的 `< <装有专属网址的文件>` 不是合法的 shell 重定向（`< <(...)` 才是进程替换），照抄会出错或产生歧义。
- 证据：`docs/runbooks/production-server-access-runbook.md:198`：“`bash install-heartbeat.sh install < <装有专属网址的文件>`”
- 建议：写成 `bash install-heartbeat.sh install < /path/to/url-file`，并单独说明 URL 文件权限 0600。

### 8. 【低】`/health/ready` 在未 Wiring health 模型时“失败开放”（默认 ready=true）

- 文件:行：`packages/platform-node/src/http-gateway-server.ts:918-922`；生产 Wiring `apps/agent-service/src/service-main.ts:2099`
- 问题：`const ready = snapshot?.ready ?? true;`，如果 `options.health` 未传入，`/health/ready` 永远 200。当前生产 `service-main` 确实传了 `health`（已核对），所以现在不是 bug；但这是心跳的单一判断源，未来重构若漏传 `health`，心跳会一直绿。
- 证据：
  - `http-gateway-server.ts:918-920`：`const snapshot = options.health?.publicSnapshot(); const ready = snapshot?.ready ?? true; return sendJson(reply, ready ? 200 : 503, ...)`
  - `service-main.ts:2099`：`health,`
- 建议：增加一条生产组装层测试，断言 HTTP 组装一定传入 `health`；或让 `/health/ready` 在缺少 health 时返回 503（失败关闭）。

### 9. 【低】心跳范围不覆盖上游模型/Magpie；运行手册的“没覆盖”也没提

- 文件:行：`packages/platform-node/src/runtime-health.ts:61-68`；`packages/domain/src/durable-state.ts:558`
- 问题：`model-provider` 被登记为 `required: false / NOT_CHECKED`，`ready = live && authorityActive && !requiredUnavailable` 不会因模型供应商/Magpie 不可用而变 false。因此“服务就绪但所有对话都失败”的情况心跳仍是绿的。运行手册的“没覆盖”只写了 Cloudflare 外部入口，没有写模型供应商/Magpie。
- 证据：
  - `runtime-health.ts:61-68`：`this.#dependencies.set("model-provider", ... { required: false, status: "unavailable", reasonCode: "NOT_CHECKED" })`
  - `durable-state.ts:558`：`const ready = input.live && input.authorityActive && !requiredUnavailable;`
- 建议：在运行手册“没覆盖”里明确写“模型供应商/Magpie 故障不会被本机心跳发现”；如果要覆盖，另做外部探测或把模型链路纳入 readiness。

---

## 二、推测 / 未核实

以下内容我无法从仓库代码或本地测试完全证实，需要真实 Healthchecks/真实 systemd/生产现场验证：

1. **Healthchecks `/log` 是否真的不更新 `last_ping`/状态（中）**：整套“不就绪不告警、超过 5 分钟才告警”的设计依赖这一点。代码 `himawari-heartbeat.py:77` 只是发 `/log`；测试 `test_heartbeat.py:86-100` 只断言发出了 `POST .../log`，没有验证外部服务的语义。如果 `/log` 被 Healthchecks 当作心跳，那么服务长期不就绪时永远不会超时告警（漏报）。运行手册的验收“停服约 6 分钟确认收到通知”可以验证这一点，但它是手工步骤，不是自动检查。

2. **`RestrictAddressFamilies=AF_INET AF_INET6` 在 Ubuntu 24.04 上是否够用（中）**：`install-heartbeat.sh:76` 只允许 `AF_INET/AF_INET6`。如果生产机的 DNS 解析路径经过 `nss-resolve`/systemd-resolved（需要 `AF_UNIX`）或 glibc 的接口枚举（可能需要 `AF_NETLINK`），`hc-ping.com` 可能解析失败，导致每次心跳都 `HEARTBEAT_PING_FAILED`、没有成功心跳。运行手册自己写了“systemd 的加固选项没有在真实 systemd 上跑过”。建议在真机 `systemd-analyze verify` + 实际运行，或直接加 `AF_UNIX AF_NETLINK`（对当前脚本无害）。

3. **`url + "/log"` 对 project-key/slug URL 的支持（低）**：如果使用 `https://hc-ping.com/<ping-key>/<slug>` 形式，代码会请求 `.../<slug>/log`。Healthchecks 是否接受这种三段路径未核实；即使 404，也只影响“日志”，不影响超时告警（成功心跳仍能发）。

4. **`/etc/himawari` 实际属主/模式（低）**：从 `cloud-protected-prepare.mjs` 以非 root 生产账号写 `config.json.next` 可以推出该目录对 `himawari-prod` 至少可写，但具体是 owner/group/ACL 我未在现场核实。上面第 3 条的安全影响以此为前提。

5. **真实 ping key 是否存在、URL 是否被 Healthchecks 接受（低）**：安装只校验格式（`himawari-heartbeat.py:11,33`），不校验 key 是否真实存在；拼错但格式合法的 key 会一直 404，安装本身不会发现。运行手册的“装完先看到 `HEARTBEAT ok`”是人工兜底。

6. **生产实际端口/监听地址（低）**：我核对的是仓库里的生产配置模板（8400/127.0.0.1）和 `http-gateway-server.ts:917-922` 的 200/503 语义，现场 `/etc/himawari/config.json` 未核实。

7. **定时器首次触发/5 分钟边界（低）**：`OnBootSec=1min`、`OnUnitActiveSec=1min`、`AccuracySec=5s`，配合 Healthchecks 的 period=1min、grace=5min，实际“停服后多久告警”会随最后一次成功心跳和 timer 抖动有约 1 分钟浮动；运行手册“预计超过 5 分钟时暂停”没有说明这个边界。

---

## 三、侧重检查

- **错误路径**
  - URL 文件缺失/不可读：`read_ping_url` 抛 `HEARTBEAT_URL_UNREADABLE`，退出 2，不联网；已核对，测试覆盖（`test_heartbeat.py:151-156`）。
  - URL 非法（http、错主机、查询串、多行、空格、非 ASCII、过长、`fail/start/log` 后缀）：`PING_URL.fullmatch` 与 `RESERVED_SUFFIXES` 拒绝；测试逐项覆盖且断言没有网络调用（`test_heartbeat.py:126-149`）。
  - 就绪非 200/连接被拒/非 HTTP 响应：分别返回 reason 并发 `/log`；测试覆盖 503、204、连接被拒、`BadStatusLine`（`test_heartbeat.py:86-100,102-116,168-176`）。
  - 心跳发送失败：返回 1 并只打印 `HEARTBEAT_PING_FAILED`，不回显 URL；测试覆盖（`test_heartbeat.py:118-124`）。
  - 安装失败：`daemon-reload`/`enable` 失败会留下已写入的 URL/unit，存在半装状态（见问题 2）；测试没有失败注入。
  - `status`：恒 0（见问题 4）。

- **不合规范/不可信输入**
  - URL 文件最多读 513 字节，安装最多读 600 字节；拒绝非 ASCII、换行嵌在中间、过长内容；主机被正则钉死在 `hc-ping.com`，没有 userinfo/端口/查询串/片段的注入面。
  - 本地 `/health/ready` 的响应体不读，只读 status；reason 只含 HTTP 状态码或固定文字，不含 URL。
  - URL 不出现在 argv、unit、stdout/stderr、journal（代码路径核对；测试也断言输出里没有 `PING`）。
  - 残留信任面：`mktemp -d` 受 `TMPDIR` 影响；安装以 root 运行时若 `TMPDIR`/`HEARTBEAT_ROOT`/`HEARTBEAT_SYSTEMCTL` 被 sudo 保留，存在被诱导写文件/执行命令的可能（需要特殊 sudo 配置，较低）。

- **安全**
  - 加固项本身合理：`NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、`PrivateTmp`、`PrivateDevices`、空 `CapabilityBoundingSet`。root 读取自己拥有的 0600 文件不需要 `CAP_DAC_OVERRIDE`（owner 权限位即可），因此空能力集不会阻止读取。
  - 主要风险是上面第 3 条：URL secret 放在生产账号可写的目录；以及第 2 节的 `RestrictAddressFamilies` DNS 风险。
  - 服务以 root 运行网络客户端不是必需；可用 `User=` + `LoadCredential` 或专用账号降低爆炸半径。

- **资源耗尽**
  - 文件读取有上限（513/600 字节），响应只读 64 字节，没有无界读取。
  - 每次网络操作有 10 秒超时，`TimeoutStartSec=30` 给两次操作留了余量。
  - 长期不就绪时每分钟向 Healthchecks 发一次 `/log`（约 1440 次/天），会累积日志条目，但不会耗尽本机资源；Healthchecks 侧配额/限流未核实。

- **不可撤销操作**
  - `remove --purge` 删除 URL 文件；ping URL 可以从 Healthchecks 检查页面找回，且 `remove` 只删本机文件，不算严格不可逆。
  - `install`（非 `--keep-url`）会覆盖旧 URL；空 stdin 会在覆盖前退出（`head -c 600` → `HEARTBEAT_URL_MISSING`），但非空错误 URL 会直接覆盖，见问题 2。

- **规则/文档/代码一致性**
  - 运行手册“不就绪只记日志”与代码 `/log` 一致；作者材料/`d1b03b61` 说明的 `/fail` 不一致（问题 1）。
  - 运行手册的 `HEARTBEAT ok` / `HEARTBEAT skipped <原因>` 与代码打印一致（`himawari-heartbeat.py:75,78`）。
  - 安装命令占位符写法有问题（问题 7）；`status` 的 root 要求未写（问题 4）。
  - `docs/incidents-and-gates.md` I-83 新增的 `scripts/operations/heartbeat/` 路径存在，`check:incident-gates` 的路径存在性检查可通过（`scripts/check-incident-gates.mjs:65-70`）。
  - `check:heartbeat` 已加入 `package.json` 的 `check:steps` 和 `scripts`；`scripts/run-all-checks.mjs:32` 按 `check:steps` 动态解析，`test/tooling/run-all-checks.test.mjs:73` 只要求每个 step 是字符串，新增 step 不会破坏该测试。
  - `test_heartbeat.py` 没有锁定加固项和安装失败路径（问题 6）。

---

## 四、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。**

依据：
- `.claude/rules/prompt-prefix.md` 第 4 条要求“已经发给过模型的内容不得改动、重排或删除，只能在末尾追加”；第 5 条要求存历史时存实际发出内容；第 10、11 条要求字节确定。
- 本 PR 的实际 diff（`0f468696..5f562ba5`，19 个文件）只有 heartbeat 脚本、`package.json`、运行手册、事故表和 `.agents/reviews/pr-307/` 记录，没有系统提示、工具定义、历史消息、出口遮盖或压缩代码。因此不存在“改请求开头”或“每轮变化值进入系统提示/工具定义”的问题；心跳的 URL、就绪状态、失败原因只发给 Healthchecks，不进入模型请求。
- `e1ec166a..5f562ba5` 里看到的大量应用/提示词文件变化是合并自 `origin/main`（`5f562ba5` 的父提交是 `24a7dda0` 和 `0f468696`），不是本 PR 的提交；本 PR 相对 main 的实际内容仍只有上面 19 个文件。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**不会。**

- 本 PR 没有新增任何模型请求文本，也没有改遮盖规则、JSON 序列化、工具顺序或列表顺序。
- 新增的字符串只有 Healthchecks URL、`HEARTBEAT_*` 输出、就绪状态原因（如 `ready answered HTTP 503`）和文档文字；这些都不进入模型上下文。
- 心跳 URL 和失败原因是确定的（不依赖时间、随机数或无序集合）；即使同一段状态文字被多次发送，也只在外部日志里，不影响模型请求的字节。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有自动检查，但覆盖不完整。**

- `package.json:45` 新增 `"check:heartbeat": "python3 -I scripts/operations/heartbeat/test_heartbeat.py"`，并加入 `check:steps`（`package.json:27`）。
- `npm run check` 由 `scripts/run-all-checks.mjs:32` 读取 `check:steps`；CI 的 static 作业在 `scripts/ci/run.mjs:246` 执行 `npm run check`，所以 `check:heartbeat` 会进 CI。
- 反向用例确实存在且会失败：
  - 把 `/log` 改回 `/fail`，`test_not_ready_service_sends_no_heartbeat...`、`test_a_service_that_does_not_answer...`、`test_a_ready_answer_other_than_200...` 会失败（`test_heartbeat.py:86-116`）。
  - 放宽主机名/字符集/后缀，`test_an_invalid_url_file_makes_no_network_call` 会失败（`test_heartbeat.py:126-149`）。
  - 把非 200 当就绪，`test_a_ready_answer_other_than_200_is_not_ready` 会失败。
  - 把 URL 打进输出，`test_a_failed_ping_is_an_error_exit_without_the_url` 与安装测试会失败（`test_heartbeat.py:118-124,215`）。
  - `--keep-url` 丢 URL、权限不修、`status` 写文件、`remove` 不删文件等都有测试。
- 覆盖缺口：
  - systemd 加固项没有断言（`test_heartbeat.py:210-215`），因此加固被删/改坏测试仍绿。
  - `daemon-reload`/`enable` 失败没有失败注入，半装状态没有测试。
  - Healthchecks `/log` 的外部语义、真实 systemd/DNS、真实 Healthchecks URL 没有自动检查（只能人工验收）。
  - 没有用 `systemd-analyze verify` 校验 unit 语法。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

逐项核对如下：

| 产生/修改的值 | 使用/消费方 | 结论 |
|---|---|---|
| `check:heartbeat`（package.json scripts） | `check:steps`、`run-all-checks.mjs:32`、`test/tooling/run-all-checks.test.mjs` | 通过。动态解析 `npm run <name>`，测试只要求每个 step 是字符串，新增合法。 |
| `/etc/himawari/healthcheck-url` | `himawari-heartbeat.py:9` 的 `DEFAULT_URL_FILE`、安装脚本 `url_path` | 路径一致（生产 `HEARTBEAT_ROOT` 为空时）。 |
| `/usr/local/sbin/himawari-heartbeat` | `install-heartbeat.sh:13` 的 `script_path`、unit `ExecStart`（`install-heartbeat.sh:68`） | 生产一致。`HEARTBEAT_ROOT` 测试模式下 `ExecStart` 不带前缀，但那只用于测试，不是生产。 |
| `http://127.0.0.1:8400/health/ready` | 生产配置模板 `listenHost/listenPort`、`http-gateway-server.ts:917-922` | 当前一致（200/503 语义已核对）；但硬编码与配置耦合，见问题 5。 |
| URL 格式（`https://hc-ping.com/...`） | Healthchecks 的成功 ping、`/log` 追加 | 成功 URL 的 UUID/slug 形式可被接受；`/log` 的 slug 三段路径未核实（第二节第 3 条）。 |
| `/etc/himawari` 目录 | 部署的 `cloud-protected-prepare.mjs` 以 `himawari-prod` 写 `config.json.next`；heartbeat 以 root 读 URL | **不完全一致**：目录对 `himawari-prod` 可写，root 0600 不能阻止其替换 URL；运行时不复核属主/权限。见问题 3。 |
| 1 分钟周期 / 5 分钟宽限 | 只在 `docs/runbooks/...:194,200` 和 timer 的 `OnUnitActiveSec=1min` 出现；Healthchecks 的实际 period/grace 是页面手工设置 | 代码只产生 timer 的 1 分钟；5 分钟宽限是人工配置，没有自动一致性检查。如果 Healthchecks 页面设错，测试发现不了。 |
| `HEARTBEAT_*` 输出字符串 | 人工看 `journalctl`、运行手册描述 | 代码与手册的 `HEARTBEAT ok`、`HEARTBEAT skipped <原因>` 一致；`HEARTBEAT_INSTALLED`/`HEARTBEAT_REMOVED` 只给人工看。 |
| I-83 行新增的 `scripts/operations/heartbeat/` | `scripts/check-incident-gates.mjs:65-70` 的路径存在性检查 | 路径存在，可通过。 |

**总体判断**：本次 PR 的模型请求前缀、字节确定性不受影响；自动检查已接入但未覆盖 systemd 加固和安装失败路径；最大的材料问题是作者把 `/log` 说成了 `/fail`，最大的运行环境风险是 `RestrictAddressFamilies` 下的 DNS 解析和真实 systemd 未验证，最大的安全设计问题是 URL 秘密放在生产账号可写的 `/etc/himawari` 目录且运行时不复核文件身份。
