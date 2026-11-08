# PR #307 复核（HEAD `e1ec166`，增量 `d1b03b6..e1ec166`）

先说明一处核对结果：**本次实际复核的 HEAD 与作者材料描述不一致**。材料说“不就绪时向 `网址/fail` POST，Healthchecks.io 收到 `/fail` 立刻告警”，但 `e1ec166` 已把失败信号改成 `/log`（`himawari-heartbeat.py:77`），`/fail` 路径已经不存在；测试也从断言 `/fail` 改成断言 `/log`（`test_heartbeat.py:91,100,116`）。下面按当前代码评。

---

## 一、读代码证实的问题

### 1. 【高】核心告警路径完全依赖 Healthchecks.io 的 `/log` 语义，仓库内没有任何验证
- 文件:行：`scripts/operations/heartbeat/himawari-heartbeat.py:71-78`
- 证据：
  ```python
  problem = probe_ready(opener, arguments.ready_url, arguments.timeout)
  if problem is None:
      send(opener, url, None, arguments.timeout)
      print("HEARTBEAT ok", file=output)
  else:
      send(opener, url + "/log", problem.encode("ascii"), arguments.timeout)
      print("HEARTBEAT skipped " + problem, file=output)
  ```
  测试只用一个假的 opener 记录调用，不验证外部语义：`test_heartbeat.py:86-92` 断言的是“发了 `POST …/log`”，`test_heartbeat.py:118-124` 里 `Pings.fail=True` 只会让本地把请求记下来。
- 问题：新方案里，服务不就绪时**不发任何成功 ping**，是否告警完全取决于 Healthchecks.io 在连续 5 分钟没有成功 ping 后超时。这个前提（`/log` 不刷新 last ping、不改变超时判定）既不在代码里，也没有任何自动检查；按我对 Healthchecks 文档的了解 `/log` 确实只记日志、不改状态，但**无法上网核实，仓库里也没有证据**。如果 `/log` 被当成一次“活动”而重置计时，结果就是服务停机时永远不告警——正好是本 PR 要消灭的那个故障。
- 建议：装到生产机后**必须先做运行手册里的 6 分钟停服验收**（或用一个临时 check 做对照实验），确认 `/log` 不推迟告警；此外最好让这条依赖有可回归的证据（验收记录或外部实验），不要只靠“文档说”。

### 2. 【中】短暂不就绪/崩溃重启循环会被漏报
- 文件:行：`himawari-heartbeat.py:71-78`、`docs/runbooks/production-server-access-runbook.md:194`
- 证据：唯一决定“是否算心跳成功”的是 `if problem is None` 时的成功 ping；不就绪只写 `/log`。运行手册把宽限设为 5 分钟。
- 问题：只有在“连续 5 分钟一次 200 都没探到”时才告警。如果服务处于“能就绪几分钟 → 崩几十秒 → 再起来”的循环（或每次都能在探测的那一分钟内恢复），心跳会一直绿，但用户侧在反复失败。原来（`d1b03b6`）每次不就绪都发 `/fail` 能立刻发现这种情况；这次为避开上线误报，把它一起牺牲了。I-83 关联的 Hermes 事故就是崩溃重启循环，这一改动对同类故障的检测变弱。
- 建议：折中方案是“连续 N 次（如 3 次）不就绪才发 `/fail`”，或在上线期间才切到“只记日志”，而不是永久只靠超时；至少要在运行手册的“没覆盖”里写明崩溃循环这一漏报场景。

### 3. 【中】运行手册要求上线/回滚时手动暂停 Healthchecks 检查，忘记恢复就永久静默
- 文件:行：`docs/runbooks/production-server-access-runbook.md:194`
- 证据：“上线或回滚预计超过 5 分钟时，先在 Healthchecks.io 页面点这条检查的暂停，做完再恢复。”
- 问题：暂停后若忘记恢复，之后任何停机都不会告警，而且脚本本身无法察觉“检查被暂停”。这会引入一个新的、无代码护栏的漏报渠道。
- 建议：不要依赖手工暂停；可行做法是部署脚本在停服前给一个本地标记文件，让心跳脚本在标记存在时发 `/start` 或直接跳过（并记录），部署完自动清除；至少在运行手册里加一步“恢复后确认页面重新在线”，并写明忘记恢复的后果。

### 4. 【低】`install` 失败时可能留下半装状态，且没有验证首次运行真的成功
- 文件:行：`scripts/operations/heartbeat/install-heartbeat.sh:59-60,92-93`
- 证据：
  ```bash
  install -m 0755 "$here/himawari-heartbeat.py" "$script_path"
  if [[ "$keep" == 1 ]]; then chmod 0600 "$url_path"; else install -m 0600 "$staging/url" "$url_path"; fi
  ...
  "$systemctl_command" daemon-reload
  "$systemctl_command" enable --now himawari-heartbeat.timer
  echo "HEARTBEAT_INSTALLED"
  ```
- 问题：网址文件先于单元写入；若 `enable --now` 失败，脚本非零退出，但脚本/网址/单元已落盘。更关键的是脚本没有启动一次并检查结果。对**全新**安装，如果 timer 从未成功 ping，Healthchecks 的 check 可能还处于“新建、从未 ping”的状态，未必会告警，于是“装了一半”与“装好了”在监控上可能都是安静的。测试 `test_install_writes...` 用假 systemctl，只验证命令被调用，不模拟 enable 失败或首次运行失败。
- 建议：`enable` 后主动 `systemctl start himawari-heartbeat.service` 并检查退出码/输出；失败时明确提示“已写文件但首次运行失败，当前没有告警”。运行手册也应强调首次必须看到 `HEARTBEAT ok`。

### 5. 【低】`RestrictAddressFamilies=AF_INET AF_INET6` 可能影响域名解析（未在真实 Ubuntu 24.04 验证）
- 文件:行：`scripts/operations/heartbeat/install-heartbeat.sh:76`
- 证据：`RestrictAddressFamilies=AF_INET AF_INET6`
- 问题：脚本目标是 `hc-ping.com`，需要 DNS。glibc 的 `dns` 走 AF_INET/AF_INET6 的 UDP 没问题；但如果该机的 NSS 配置使用 `nss-resolve`（systemd-resolved 的 varlink）或 nscd（AF_UNIX），`socket(AF_UNIX)` 会被这条限制拒绝。Ubuntu 24.04 默认 `/etc/nsswitch.conf` 一般是 `files … dns`，大概率没事，但作者自己也说“加固选项没有在真实 systemd 上跑过”，这一条正是最可能踩坑的地方。
- 建议：在真实主机上用这个 unit 跑一次并确认 `HEARTBEAT ok`；如果解析失败，考虑加 `AF_UNIX`（或在验收 checklist 里明确检查 DNS 解析是否正常）。

### 6. 【低】以 root 安装来自可写目录的脚本（TOCTOU/提权面）
- 文件:行：`install-heartbeat.sh:10,55,59`
- 证据：`here="$(cd "$(dirname "$0")" && pwd)"`，随后用 `$here/himawari-heartbeat.py` 校验并 `install` 到 `/usr/local/sbin`。
- 问题：运行手册让人“把 `scripts/operations/heartbeat/` 目录拷到生产机”再以 root 运行。如果拷到普通用户可写目录，本地低权限用户可在校验后替换 `.py`，而它以 root 每分钟执行；同理被替换的脚本可能把网址外传。单管理员生产机上风险有限，但这是清晰的提权面。
- 建议：要求从 root 拥有、非 world/group 可写的目录运行安装，或安装前检查 `$here` 的属主与权限；更稳妥的是把源脚本固定在只读目录。

### 7. 【低】错误响应对象 `HTTPError` 未关闭
- 文件:行：`himawari-heartbeat.py:44-45`
- 证据：
  ```python
  except urllib.error.HTTPError as error:
      return "ready answered HTTP " + str(error.code)
  ```
- 问题：`HTTPError` 本身是可读的响应对象，未 `close()`。这是每分钟启动一次的短命进程，影响很小，属稳健性 nit。
- 建议：`error.close()` 后再返回。

### 8. 【低】`install` 静默忽略未知参数
- 文件:行：`install-heartbeat.sh:44`
- 证据：`[[ "${1:-}" == --keep-url ]] && keep=1`，其余多余参数不报错。
- 问题：`install --keepurl`（拼错）会走“从 stdin 读新网址”分支；若在终端运行会无提示阻塞，或读入非预期内容。`remove`/`status` 同理。
- 建议：对多余参数走 `usage`。

### 9. 【低】文档与代码不一致
- 文件:行：`docs/runbooks/production-server-access-runbook.md:199`、`:196`
- 证据：`:199` 写“`bash install-heartbeat.sh status`，或 `journalctl …`，正常时输出 `HEARTBEAT ok`”。但 `status` 分支只调用 `systemctl is-active` / `list-timers`（`install-heartbeat.sh:24-27`），本身不输出 `HEARTBEAT ok`；`HEARTBEAT ok` 只在 `himawari-heartbeat.py:75` 由服务写进 journal。
- 另：`:196` 说网址“不写进仓库、配置文件或日志”，但它实际就存放在 `/etc/himawari/healthcheck-url` 这个配置文件里，措辞自相矛盾（作者想说的应该是“不写进仓库里的配置文件”）。
- 建议：把“`status` 正常输出 `HEARTBEAT ok`”改成“journal 里正常输出 `HEARTBEAT ok`”；把“配置文件”限定为“仓库内的配置文件”。

---

## 二、推测 / 未核实

1. **`/log` 在“项目 Ping Key + slug”形式的两段式网址上是否可用**：校验和测试都接受 `https://hc-ping.com/<key>/<slug>`（`himawari-heartbeat.py:11`、`test_heartbeat.py:158-163`），但实际请求会变成三段的 `…/<key>/<slug>/log`。若 Healthchecks 对 ping-key 网址不支持这个位置，则“记录原因”会 404（`send` 抛错 → `HEARTBEAT_PING_FAILED`、退出 1），但超时告警仍成立。未核实。
2. **I-83 新增的“非上线日重启靠心跳告警”是否成立**：心跳只看 `/health/ready`。我读到内核校验在 `sandbox-host-verifier.ts:214`（`qualification.osRelease !== release()`），且 `production-sandbox-services.ts:191` 在组装沙箱服务时调用 `verifySandboxHost`；如果内核不符会让整服务启动失败，心跳就能发现。但我没有把整条启动调用链读完，无法确认“内核不对但 HTTP 服务仍能 ready”的情况不存在。若存在，则 I-83 的这句话（`docs/incidents-and-gates.md:121`）把“心跳告警”说成能覆盖错内核重启是过度承诺。
3. **空 `CapabilityBoundingSet=` 下读 root 0600 文件**：按 Linux 权限模型，uid 0 读自己拥有的 0600 文件不需要 `CAP_DAC_OVERRIDE`，应可用；但同样未在真实主机上验证。
4. **`-I` 运行无 `.py` 后缀文件**：`python3 -I /usr/local/sbin/himawari-heartbeat` 只依赖标准库，理论上没问题；未实机验证。

---

## 三、侧重检查（错误路径 / 不可信输入 / 安全 / 资源 / 不可逆操作 / 文档一致）

- **不可信网址输入**：`PING_URL` 用 `fullmatch` 锁定主机只能是 `hc-ping.com`，字符集 `[A-Za-z0-9_-]`，禁止端口、查询串、userinfo、换行、NUL、非 ASCII（`himawari-heartbeat.py:11,28-34`）；`fail/start/log` 后缀被拒绝（`:13,33`），防止把“成功/失败/启动”端点写进配置。即使网址文件被替换成别的主机，请求也只会发往 `hc-ping.com`。**结论：主机固定，无法把请求导向别处。**
- **网址泄露面**：所有输出都是固定字符串（`himawari-heartbeat.py:66,69,75,78,80`），异常被捕获后只留固定错误串；安装从 stdin 读、校验用临时文件、unit 的 `ExecStart` 不含网址（`test_heartbeat.py:212,216`），临时目录 `umask 077` + `mktemp -d`（`install-heartbeat.sh:45-47`）。**结论：没有把网址写进 journal/命令行/unit 的路径。**
- **资源耗尽**：网址文件读取上限 513 字节（`himawari-heartbeat.py:12,23`），两次网络请求各 10 秒、`TimeoutStartSec=30`（`install-heartbeat.sh:69`），oneshot 短命进程。**结论：有界。**
- **不可逆操作**：`remove --purge` 永久删除专属网址（`install-heartbeat.sh:34`，测试 `test_heartbeat.py:250-257`），删掉后只能去 Healthchecks 重建 check；`install` 覆盖旧网址也无备份。属可接受但值得在运行手册提醒。
- **错误路径覆盖**：503、非 200、连接被拒、非 HTTP 应答、无效/缺失网址文件、ping 失败都有用例（`test_heartbeat.py:86-177`），反向用例是真的会失败（把 `/log` 改回 `/fail`、删掉保留后缀检查、去掉 chmod 都会红）。
- **文档/代码一致**：发现第 1、9 条，以及“作者材料仍是 `/fail` 描述”的不一致。

---

## 四、必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动只新增 `scripts/operations/heartbeat/`、`package.json` 的一个检查项、两份文档；`himawari-heartbeat`/`install-heartbeat` 没有被任何产品代码导入（全仓库只有测试、文档、package.json 引用）。发给模型的内容仍只在末尾追加，每轮变化的值仍只在最后一条消息里，系统提示/工具定义/历史/遮盖都没有触碰。依据：`.claude/rules/prompt-prefix.md:27-29`（固定在前、会变的在后）与 `:35`（已发内容只追加）。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会。该改动不参与模型请求组装；心跳日志正文只由固定字符串和 HTTP 状态码拼成（`himawari-heartbeat.py:43,45,47,77`），不含时间、随机值或无序集合。依据规则 `:51-54` 的确定性要求与本次改动无关。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有：`package.json:45` 新增 `check:heartbeat`，并在 `check:steps`（`package.json:27`）中，被 `scripts/run-all-checks.mjs:32-37` 实际执行。反向用例是真的：把不就绪分支改回 `/fail` 会让 `test_heartbeat.py:91,100,116` 失败；删掉 `RESERVED_SUFFIXES` 会让 `:137-149` 失败；去掉 `--keep-url` 的 chmod 会让 `:232-237` 失败；不接 `BadStatusLine` 会让 `:165-177` 报错。
但**最关键的假设没有自动检查**：`/log` 不重置 Healthchecks 超时、真实 systemd 下 unit 能运行、首次安装真的会告警，这些只能靠运行手册里尚未执行的手工验收。因此“检查存在”不等于“告警路径被验证”。

**4. 每个产生/修改的值，使用它的地方都能接受吗？逐个核对：**
- `/etc/himawari/healthcheck-url`：`himawari-heartbeat.py:9` 的默认值与 `install-heartbeat.sh:14` 的 `url_path` 一致（生产 `prefix` 为空）；一致。
- `/usr/local/sbin/himawari-heartbeat`：`install-heartbeat.sh:13` 写入、`:68` 的 `ExecStart` 读取、`:33` 删除；一致。
- `himawari-heartbeat.service` / `.timer`：`:15-16` 定义、`:25-26,32-33,93` 使用、测试 `:210-215,242-254` 校验；一致。
- 网址字符集与保留后缀：`himawari-heartbeat.py:11,13` 与运行手册 `:196` 的描述一致；测试 `:126-149` 覆盖。
- 退出码 0/1/2：生产端唯一的消费者是 systemd oneshot（非 0 记为失败），`install` 里 `--check-url-file` 用 0/非 0 判断；两者都能接受。
- `HEARTBEAT*` 输出串：`HEARTBEAT ok` 被运行手册 `:199` 和测试 `:84` 引用，其余仅内部/测试使用；没有外部校验依赖。
- 周期 1 分钟 / 宽限 5 分钟：**只存在于运行手册 `:201`**，代码不生产也不校验，Healthchecks 页面配置漂移不会被任何检查发现——这是一个“值只在文档里”的断点，建议在验收记录里固化实际配置。
- 文档 `status` 输出：与 `install-heartbeat.sh:24-27` 不一致（见第 9 条）。
- 作者材料里的 `/fail` 立即告警：与当前代码 `himawari-heartbeat.py:77` 不一致（材料基于 `d1b03b6`，HEAD 已是 `e1ec166`）。

**总体判断**：安全性（网址不可导向他处、不泄露）和错误路径处理较扎实，自动检查也真实有效；主要风险集中在“告警是否真的会响”——`/log` 外部语义未验证、崩溃循环漏报、手工暂停忘记恢复。建议至少补上前两项的验证/设计折中，再上生产。
