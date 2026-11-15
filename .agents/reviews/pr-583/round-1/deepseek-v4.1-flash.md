## 侧重检查

- **错误路径**：网址文件不存在、不可读、超长、非 ASCII、非法 URL 都分别返回 `HEARTBEAT_URL_UNREADABLE` / `HEARTBEAT_URL_INVALID`，且不会发起网络请求（`himawari-heartbeat.py:20-35,63-82`）。安装中途失败时，新网址已写入、旧网址可能尚未删除，重跑可继续，未发现会丢新网址的路径。
- **不可信输入**：安装从标准输入最多读 600 字节（`install-heartbeat.sh:54`），网址校验最多读 513 字节（`himawari-heartbeat.py:12,23`），URL 用严格正则整串匹配；网址不进入命令行、unit 或日志。结论：这部分没有发现问题。
- **安全**：新目录 `0700`、文件 `0600`，且 unit 的 `CapabilityBoundingSet=` 没被放宽；旧网址在安装和移除时被删。发现一处属主假设未落实，见意见 1。
- **不可撤销操作**：`rm -f` 删除旧网址不可恢复；`install` 删旧网址前已确保新网址写好，可以接受；但 `remove` 不带 `--purge` 也删旧网址，见意见 3。
- **资源耗尽**：读取都有字节上限，暂存目录由 `mktemp -d` + `umask 077` 创建，未发现无界读取。
- **规则/文档/代码一致**：runbook、I-110 条目、测试名与 `package.json` 的 `check:heartbeat` 基本一致；不一致处见意见 1–3 和必答问题 4。

## 意见

### 1、中、安装只改权限位、不校验也不强制目录和文件属主，与 runbook 和测试名的「only root owns」不符

文件: `scripts/operations/heartbeat/install-heartbeat.sh:60-64`、`scripts/operations/heartbeat/test_heartbeat.py:218-256`、`docs/runbooks/production-server-access-runbook.md:196`

问题：这次事故的根因是「属主不是 root 且没有 DAC 绕过能力」，但安装脚本只 `mkdir -p` 后 `chmod 0700`，没有 `chown root:root`，也没有检查 `/etc/himawari-heartbeat` 已存在时属主是不是 root；`--keep-url` 分支也只 `chmod 0600`，不会修属主。`chmod` 不改变属主。测试名为「only root owns」，实际只断言了 `0700`，没有任何属主断言。

证据（读代码证实）：

```bash
mkdir -p "$(dirname "$url_path")"
chmod 0700 "$(dirname "$url_path")"
...
if [[ "$keep" == 1 ]]; then chmod 0600 "$url_path"; else install -m 0600 "$staging/url" "$url_path"; fi
```

测试只检查模式：

```python
self.assertEqual(stat.S_IMODE((self.root / "etc/himawari-heartbeat").stat().st_mode), 0o700)
```

推测：如果该目录在此前某次非 root、带 `HEARTBEAT_ROOT` 的安装或人为复制中已经存在且属主不是 root，脚本会「成功」但 systemd 里没有 `CAP_DAC_OVERRIDE` 的 root 仍读不到，重现同一个 `HEARTBEAT_URL_UNREADABLE`，而这条测试仍通过。正常从 root 在 `/etc` 下新建时属主确实是 root，所以生产主路径大概率没问题。

建议：新建时用 `install -d -o root -g root -m 0700`（仅真实安装时），或 `mkdir` 后显式 `chown root:root`/核对 `stat -c %u` 为 0，不符合就失败；`--keep-url` 也核对文件和目录属主。测试至少断言产物属主等于安装者（或在 root 下等于 0，非 root 时跳过），并把测试名改成它真正验证的内容，或补上属主验证。

### 2、低、`install --keep-url` 无法从旧位置迁移，受影响机器照「只重装脚本不换网址」操作会得到 `HEARTBEAT_URL_MISSING`

文件: `scripts/operations/heartbeat/install-heartbeat.sh:50-52`、`docs/runbooks/production-server-access-runbook.md:198`

问题：`--keep-url` 只认新路径 `$url_path`，不读旧位置 `$legacy_url_path`。而生产机上目前网址只在旧位置，runbook 却把 `install --keep-url` 写成通用的「只重装脚本不换网址」做法。

证据（读代码证实）：

```bash
if [[ "$keep" == 1 ]]; then
  [[ -f "$url_path" ]] || { echo "HEARTBEAT_URL_MISSING" >&2; exit 2; }
```

runbook 第 198 行：「只重装脚本不换网址用 `install --keep-url`」。在尚未迁移的机器上这条命令会在写任何文件之前失败；随后必须改走从 Mac 重新喂网址的 `install`。所幸失败在改动之前，不会破坏旧安装。

建议：在 `keep` 分支里若新路径不存在但旧位置存在，可从旧位置复制到暂存并安装到新路径，再删旧位置；或至少在 runbook 明写「第一次从旧位置迁移必须用 `install < 网址文件`，`--keep-url` 只在迁移后可用」，并加一条对应测试。

### 3、低、`remove`（不带 `--purge`）也会删掉旧位置网址，和「`remove` 保留网址、`--purge` 才删」的说明不一致，且没有测试

文件: `scripts/operations/heartbeat/install-heartbeat.sh:35-36`、`docs/runbooks/production-server-access-runbook.md:201`

问题：`purge=0` 时新路径网址被保留，但旧位置网址无条件删除。对尚未迁移的机器，旧位置就是本机唯一副本；runbook 只说「连同专属网址一起删用 `remove --purge`」，没有说明普通 `remove` 也会删旧网址。这个新行为也没有测试覆盖。

证据（读代码证实）：

```bash
[[ "$purge" == 1 ]] && rm -f "$url_path"
rm -f "$legacy_url_path"
```

建议：把删旧位置也收进 `purge == 1` 的分支；如果坚持要清理旧秘密，就在 runbook 和 I-110 里明确写「普通 remove 也会删旧位置残留」，并加反向测试。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次 diff 只动了心跳运维脚本、测试和文档，没有碰系统提示、工具定义、历史消息、遮盖或请求组装；心跳网址也不会发给模型。因此「只在末尾追加」「每轮会变的值只放最后一条消息」这些规则不受影响，属于不适用而非被破坏。依据：[prompt-prefix.md 第 4 条](../../.agents/instructions/prompt-prefix.md#rules)。

2. **不会让同一段模型文本在不同请求里变成不同字节。** 模型请求路径完全没有改动；心跳脚本里变化的只有「就绪/不就绪原因」这种本机日志内容，不进模型上下文，改动也没有引入时间戳、无序集合或依赖前后文的遮盖。心跳网址本身是固定秘密，每次读取相同。

3. **有自动检查，反向用例在路径、权限、清理三项上确实会失败。** `npm run check:heartbeat`（`package.json:55`）在 `check:steps`（`package.json:27`）里，即 `npm run check` 的一步；新测试位于 `test_heartbeat.py:218`。读代码判断：把 `DEFAULT_URL_FILE` 改回 `/etc/himawari/` 会使第 219 行失败；删掉 `chmod 0700` 会使第 226 行失败（脚本内先 `umask 022`，目录默认是 0755）；删掉安装时的旧位置清理会使第 225 行失败。未覆盖的是：目录/文件属主（意见 1）、`--keep-url` 从旧位置迁移（意见 2）、普通 `remove` 删旧网址（意见 3），以及真实 systemd 加固下的读取（I-110 已声明未覆盖，靠生产机看到一次 `HEARTBEAT ok` 验收）。

4. **逐个值核对：**
   - 新路径 `/etc/himawari-heartbeat/healthcheck-url`：产生于 `install-heartbeat.sh:14` 和 `himawari-heartbeat.py:9`，使用于 `install` 的写入/保留/清理（`:51-52,64`、`:35`）以及 Python 的默认 `--url-file`（`:58`）。两端字符串一致，测试第 219、226 行固定了路径和目录模式，systemd unit 不写死路径，重装后读取的是新默认值，结论是两端接受。
   - 旧路径 `/etc/himawari/healthcheck-url`：只产生于 `:15`，只在安装和移除时被 `rm -f` 使用（`:36,96`），没有读取者；旧版已安装脚本会被新安装覆盖，旧 unit 不含路径，因此不会留下继续读旧位置的消费者。
   - 事故编号 `I-110`：生产于 I-110 行和 runbook 引用，`check-incident-gates.mjs` 只校验格式、唯一性和门槛文件存在，均满足；没有其他代码消费该编号。未核实：清单里 `I-109` 在当前提交不存在，`check-incident-gates` 不要求编号连续，可能是另一在途分支预留，若没有则只是缺号。
   - 测试名 `test_url_file_lives_in_a_directory_only_root_owns_and_the_old_copy_is_removed` 在测试文件里确实存在，但如意见 1 所述，「only root owns」没有被测试验证。
   - 唯一两端没接上的假设是「新目录和文件属主一定是 root」：产生端只设置了模式，使用端（systemd 中无 `CAP_DAC_OVERRIDE` 的 root）依赖属主，见意见 1。
