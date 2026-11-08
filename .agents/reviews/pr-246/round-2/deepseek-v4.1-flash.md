# PR #246 复核（85b35b0，增量 b1217d2c..85b35b0）

## 结论摘要

第 2 轮把上一轮指出的几处改对了：`set default` 不再只看“是否出现”；收据 `osRelease` 只接受单个词；提示改成完整带引号的启动项路径并引用回滚一节；补了对应反向用例。核对代码后，仍有 1 个检查逻辑的漏拦缺口（`next_entry` 会完全掩盖 `saved_entry`），以及解析器、收据来源、文档措辞的几处低风险问题。没有发现会改变模型请求开头或让同一段文字字节不确定的改动。

---

## 发现（按严重度）

### 中：`next_entry` 非空时完全不看 `saved_entry`，一次性选择用掉后仍会重启进别的内核

- 文件:行：`scripts/delivery-mode/deploy-preflight.py:55`、`scripts/delivery-mode/deploy-preflight.py:172`
- 问题：检查只解析一个目标（`next_entry` 优先）。当 `next_entry` 指向运行内核、而 `saved_entry` 指向另一个内核时，`NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL` 会通过；但 `next_entry` 是 GRUB 的一次性变量，这次启动后会被清掉（Ubuntu `00_header` 生成 `set next_entry=`、`save_env next_entry`），下一次重启就回落到 `saved_entry`，服务又会在别的内核上起不来。
- 证据（亲自读到）：

```python
# deploy-preflight.py:55
'target = environment.get("next_entry") or environment.get("saved_entry", "")\n'
```
```python
# deploy-preflight.py:172
('NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL', bool(facts.get('runningKernel')) and facts.get('nextBootKernel') == facts.get('runningKernel')),
```

  测试反而把“只取 next_entry”固定成了期望行为，没有覆盖“`next_entry` 正确、`saved_entry` 错误”的组合：

```python
# test_deploy.py:296-299
def test_one_time_next_entry_wins_over_saved_entry(self):
    saved = self.ADVANCED + '>' + self.entry_id('6.8.0-142-generic')
    self.assertEqual(self.next_boot(saved_entry=saved, next_entry=self.ADVANCED + '>' + self.entry_id('6.8.0-147-generic')), '6.8.0-147-generic')
    self.assertEqual(self.next_boot(saved_entry=saved, next_entry=''), '6.8.0-142-generic')
```

- 影响场景（推测，需要真实状态才能触发）：运行 142，`saved_entry=147`，有人执行 `grub-reboot` 把 `next_entry` 设为 142 后尚未重启；此时上线前检查会通过，上线继续；此后任何一次重启先安全地进 142，再下一次重启就进 147，服务停摆。这正是本 PR 想拦的状态，但被一次性的 `next_entry` 掩盖了。
- 建议：对 `next_entry` 和 `saved_entry` 分别解析；要求两者（存在时）都等于运行内核，或至少在 `next_entry` 存在时单独校验 `saved_entry` 并在不一致时拦下/告警。补一条用例：`runningKernel=142, nextEntry=142, savedEntry=147` 必须失败。
- 性质：漏拦逻辑已由代码证实；具体状态是否在生产出现属推测。

### 低：`set default` 取的是“最后一行文本”，不是“最后一行实际执行”

- 文件:行：`scripts/delivery-mode/deploy-preflight.py:56-57`
- 问题：实现把所有 `set default=` 行按文本顺序取最后一个（排除 next_entry 那一行），不解释 GRUB 的 `if/else` 条件。自定义 grub.cfg 里一次不执行的 `set default="${saved_entry}"` 排在真正执行的 `set default="0"` 后面时，检查会误判为通过（漏拦）；反过来，后面有条件出现的非 saved 默认也会误拦。作者材料说“取最后一行生效的 `set default`”，与代码实际行为不完全一致。
- 证据：

```python
# deploy-preflight.py:56-57
'    defaults = [line.strip() for line in config.splitlines() if line.strip().startswith("set default=") and line.strip() != \'set default="${next_entry}"\']\n'
'    kernel = resolve(menu(config), target) if target and defaults and defaults[-1] == \'set default="${saved_entry}"\' else ""\n'
```

  现有用例只覆盖了“末尾追加一条无条件的 `set default="0"`”和“注释行”：

```python
# test_deploy.py:315-318
def test_a_later_default_overrides_the_saved_entry(self):
    saved = self.ADVANCED + '>' + self.entry_id('6.8.0-142-generic')
    self.assertEqual(self.next_boot(config=self.grub_config() + 'set default="0"\n', saved_entry=saved), '')
    self.assertEqual(self.next_boot(config=self.grub_config() + '# set default="0"\n', saved_entry=saved), '6.8.0-142-generic')
```

- 建议：生产门槛宁可保守——只接受标准 `00_header` 生成的两种写法（`${next_entry}` 与 `${saved_entry}` 各一次），出现任何其它 `set default=` 行就判失败并交人看；或明确在 `[I-81]` 的未覆盖清单里写上“不解释 `set default` 所在的条件分支”。同时修正“最后一行生效”的措辞。
- 性质：代码行为已证实；自定义 grub.cfg 的实际触发属推测，仓库里没有真实 grub.cfg 样本。

### 低：`qualifiedKernel` 取“mtime 最新的收据”，不是运行服务实际使用的那份收据

- 文件:行：`scripts/delivery-mode/deploy-preflight.py:65`、`scripts/delivery-mode/deploy-preflight.py:130`
- 问题：服务启动时读的是部署包写死的资格目录（`S7-startup-readback.mjs:13` 的 `/var/lib/himawari/qualification/__PKT_LABEL__-__PKT_DATE_COMPACT__`），并断言 `receipt.osRelease === release()`（`S7-startup-readback.mjs:115`）。上线前检查却在资格根目录下按修改时间取最新收据。若资格根目录里有更新的、但不是当前服务使用的收据（例如失败尝试留下的非空目录），检查比较的对象就可能不是服务真正会校验的那份。
- 证据：

```python
# deploy-preflight.py:65
'receipts = sorted(pathlib.Path(sys.argv[1]).glob("*/installation-receipt.json"), key=lambda path: (path.stat().st_mtime, path.parent.name))\n'
```
```javascript
// S7-startup-readback.mjs:13
const qualification = "/var/lib/himawari/qualification/__PKT_LABEL__-__PKT_DATE_COMPACT__";
// S7-startup-readback.mjs:115
assert.equal(receipt.osRelease, release(), "__PKT_LABEL_UPPER___STARTUP_RECEIPT_KERNEL_CHANGED");
```

  文档已如实写了“最新收据按修改时间、同时间按目录名取”，但没写“这和运行服务实际用的收据可能不是同一份”。
- 影响：多数情况下“最新”就是当前部署的收据（新收据在部署签名阶段才产生，预检查更早），所以风险低；但若存在残留资格目录或时间戳异常，可能误拦/误放。
- 建议：优先从正在服务的版本/unit 推出其资格目录，直接读那份收据；退而求其次，至少校验所选目录名与当前部署标签一致。补一条“存在更新但不是本次部署的收据”的用例。
- 性质：两端代码已证实；生产上是否会出现这种目录状态属推测。

### 低：提示和运行手册说“什么都不改”，但 `deploy.sh` 在预检查之前已经执行了清理

- 文件:行：`scripts/delivery-mode/deploy-preflight.py:207`、`scripts/delivery-mode/deploy-preflight.py:209`、`docs/runbooks/production-server-access-runbook.md:64`、`scripts/delivery-mode/deploy.sh:69`
- 问题：新的两条提示都写了“Nothing was changed”，运行手册写“什么都不改”。预检查本身确实只读，但 `deploy.sh` 在第 69 行先执行了 `cleanup before 1`（释放残留、删除旧临时产物），所以从整次上线流程看，预检查失败前生产机并非“什么都没改”。
- 证据：

```bash
# deploy.sh:69-73
cleanup before 1
echo "DEPLOY_PREFLIGHT_START ..."
if ! /usr/bin/python3 -I "$here/deploy-preflight.py" "$packet"; then
  echo "DEPLOY_PREFLIGHT_FAILED: the running release was not changed" >&2
```

  既有测试也证明清理发生在预检查之前：

```python
# test_deploy.py:586-589
def test_successful_deploy_cleans_the_server_before_the_preflight_and_after_the_switch(self):
    ...
    self.assertEqual((calls[0], calls[1], calls[-1]), ('cleanup-apply', 'S1_TRANSPORT', 'cleanup-apply'))
```

- 建议：把措辞改成“运行中的发布、服务和 GRUB 没有被改”（与 `deploy.sh` 的 `DEPLOY_PREFLIGHT_FAILED` 一致），或明确“预检查本身只读；失败前上线流程可能已清理过旧残留”。
- 性质：代码与测试已证实。

### 低：提示里的 `grub-set-default` 顺序/占位符容易误用

- 文件:行：`scripts/delivery-mode/deploy-preflight.py:207`
- 问题：提示先让执行 `grub-set-default 'gnulinux-advanced-<uuid>>...'`，最后才说“若 grub.cfg 不按 saved 启动，先把 `GRUB_DEFAULT=saved` 写进 `/etc/default/grub` 并 `update-grub`”。但 `grub-set-default` 在 `GRUB_DEFAULT` 不是 `saved` 时会直接报错，顺序应先设 `GRUB_DEFAULT=saved` 再 `grub-set-default`。另外示例带 `<uuid>` 占位符，若被原样复制，会写入一个无效 `saved_entry`，重启时可能回落到第一个菜单项（正是 147）。
- 证据：

```python
# deploy-preflight.py:207（节选）
"... run grub-editenv /boot/grub/grubenv list, then point GRUB at the running kernel with its full quoted entry path ... for example: grub-set-default 'gnulinux-advanced-<uuid>>gnulinux-<runningKernel>-advanced-<uuid>' ... If grub.cfg does not boot the saved entry, set GRUB_DEFAULT=saved in /etc/default/grub and run update-grub first. ..."
```

- 建议：把“先设 `GRUB_DEFAULT=saved` + `update-grub`”放到 `grub-set-default` 之前；示例明确标注“占位符必须替换”，或给出一条从 `grub-editenv list`/`grep menuentry_id_option` 取实际值的命令。运行手册的回滚一节本身还有 `cp`/`grub-reboot` 步骤，提示直接让人执行 `grub-set-default` 与手册的流程也不完全一致，建议让提示只说“按手册第 1 步先设 saved，再执行第 2 步”而不重复命令。
- 性质：提示文本已证实；复制占位符导致的具体后果属推测。

### 信息：解析器只对手写 fixture 验证，没有真实 Ubuntu grub.cfg 样本

- 文件:行：`scripts/delivery-mode/test_deploy.py:264-280`（fixture）
- 现状：`linux=linux/linuxefi`、`boot=/boot` 或空、`submenu`、`$menuentry_id_option`、函数/`if` 块都按 Ubuntu `10_linux` 的格式手写覆盖了；`test_remote_script_reads_the_three_kernel_facts` 也确实在本机把整段远程脚本跑了一遍，验证了引号拼接。但仓库里没有任何从生产或真实 Ubuntu 24.04 抓下来的 grub.cfg，因此“真实生产 grub.cfg 不会被误判”这一点未核实。
- 建议：把一次真实生产 `grub.cfg`（可脱敏 UUID）作为 fixture 加一条测试，或至少在 `[I-81]` 的未覆盖里写明“未用真实 grub.cfg 验证”。

---

## 作者说法核对

| 作者说法 | 核对结果 |
|---|---|
| 新检查读 `/boot/grub/grub.cfg`、`/boot/grub/grubenv` 和 `/boot` | 属实（`deploy-preflight.py:16-18,129`） |
| grub.cfg 必须按 `saved_entry` 启动，`next_entry` 优先 | 属实（`:55-57`），但“最后一行生效”实际是“最后一行文本”，见上 |
| 按序号、标题、菜单项标识匹配，子菜单用 `>` | 属实（`resolve`，`:41-51`），测试覆盖序号/标题/id |
| 对应的 `/boot/vmlinuz-<版本>` 必须是文件 | 属实（`:58`）；只按版本名查 `/boot`，不核对 `linux` 行里的实际路径（低风险） |
| 任何异常输出空答案，空答案失败 | 属实（`except Exception: print("")`；`checks` 要求非空且相等） |
| 保留 `RUNNING_KERNEL_MATCHES_QUALIFICATION` | 属实（`:173`） |
| 删掉 dpkg 读已装内核的 shell | 属实（历史：`b6e5db33` 加入、`b1217d2c` 删除；净 diff 中已无 dpkg） |
| 收据 `osRelease` 只接受单个词 | 属实（`:67`，`re.fullmatch`） |
| 由 `npm run check:delivery-deploy` 运行 | 属实（`package.json:44`；`check:steps` 收录；`test/tooling/run-all-checks.test.mjs:60`） |
| 生产 11-07 状态必须通过 | 只用合成 fixture 验证（`test_deploy.py:245-247`）；真实生产 grub.cfg 未核实 |
| 失败提示给完整带引号路径、要求 Andy 同意、引用回滚一节 | NEXT_BOOT 提示属实；QUALIFIED 提示也有“owner's approval”和回滚引用，但没有带引号路径示例 |
| 运行手册/I-81 已补说明 | 属实（runbook:64、I-81 行），但“什么都不改”措辞与 preflight 前清理不符（见上） |

---

## 侧重检查

- **错误路径/异常输入**：`grub.cfg`/`grubenv`/`installation-receipt.json` 的读取全部包在 `try/except Exception`，异常一律输出空答案；`checks()` 用 `bool(runningKernel)` 和字符串相等，缺字段/空值都失败。坏 JSON、缺 grubenv、非字符串 `osRelease` 都有用例。失败关闭方向正确。
- **不可信输入/注入**：远程脚本用 `shlex.quote` 包裹所有常量与路径，参数来自 packet binding；Python 端只做文本解析，没有 `eval`/`exec`；round-2 的 `re.fullmatch` 阻止了收据内容换行后往 facts 里注入新键。`vmlinuz-(\S+)` 不匹配空白，`nextBootKernel` 无法注入换行。未发现可利用的命令/事实注入。
- **安全**：检查本身只读（`uname`、`df`、`find /tmp`、`sha256sum`、读 `/boot` 与资格目录、`systemctl show`）；建议的 `grub-set-default`/`grub-editenv` 是人工操作，提示要求 owner 同意，不会自动执行。提示会建议修改 `grubenv` 的 `next_entry`（丢弃一次性选择），但只在检查失败、且目标不是运行内核时给出，方向正确；真正的风险是上面“`next_entry` 掩盖 `saved_entry`”导致该提示不出现。
- **资源耗尽**：只读整个 `grub.cfg`（很小）、glob 资格目录、读 1024 字节 grubenv；没有递归展开或无界循环。没有新增资源耗尽风险。
- **不可撤销操作**：自动流程没有不可撤销操作；`grub-set-default` 持久修改启动项，但可再用 `grub-set-default` 改回，且需人工批准。提示里的 `<uuid>` 占位符是人为误用的风险点（见上）。
- **规则/文档与代码一致性**：`[I-81]` 的未覆盖项基本如实（仅上线时检查、非上线日重启、initrdfail、`GRUB_DEFAULT` 非 saved、条件 `if` 菜单项、按 mtime 取收据）；未提及“条件 `set default`”“`prev_saved_entry` 具体机制”“预检查前已清理”和“未用真实 grub.cfg 验证”。运行手册新增条目的“什么都不改”不准确。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
不会。改动只落在 `scripts/delivery-mode/deploy-preflight.py`、`scripts/delivery-mode/test_deploy.py`、`docs/` 和 `.agents/` 复核记录；没有触碰系统提示、工具定义、历史消息、遮盖代码或提示词目录。新增的 `runningKernel`/`nextBootKernel`/`qualifiedKernel` 只出现在上线前检查的 `PREFLIGHT_FACTS` 和 `PREFLIGHT_*` 日志里，不会进入模型请求。发给模型的内容仍然只在末尾追加，每轮会变的值没有进入请求开头。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)（已读第 4、5 条）。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会（就模型请求而言）。本 PR 没有改任何序列化进模型请求的内容；新增值不是请求的一部分。脚本内部 `facts` 的键顺序来自固定顺序的远程输出，检查结果列表是固定字面量顺序，提示文本由固定的 facts 插值生成；没有依赖对象遍历顺序或数据库返回顺序。依据：[字节必须确定](../../.claude/rules/prompt-prefix.md#deterministic)（已读第 10、11 条）。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
有。`scripts/delivery-mode/test_deploy.py` 的 `KernelPreflightTest` 和 `KernelPreflightHintTest` 都带 `[I-81]`，由 `npm run check:delivery-deploy`（`package.json:44`）运行；它属于 `check:steps`（`package.json:27`），并被 `test/tooling/run-all-checks.test.mjs:60` 固定。
- `checks()` 层反向用例断言具体失败名（如 `test_deploy.py:249-256`），比只断言“非零”更强；解析层反向用例断言空输出（`:307-329`）；提示层断言出现/不出现对应提示（`:751-775`）。
- 按旧实现推断，round-2 的两条关键反向用例会失败：`test_a_later_default_overrides_the_saved_entry`（旧实现只判断 `'set default="${saved_entry}"' in config`，会错误通过）、`test_a_receipt_kernel_that_is_not_one_plain_word_gives_no_answer`（旧实现不带正则，会把换行/列表内容原样打印）。
- 不足：没有覆盖“`next_entry` 正确但 `saved_entry` 错误”、条件 `set default`、真实生产 `grub.cfg`。另外本环境只能读代码，**未实际执行** `npm run check:delivery-deploy`。

**4. 改动产生或修改的每个值，使用它的地方都能接受吗？**

| 值 | 产生处 | 使用处 | 核对 |
|---|---|---|---|
| `runningKernel` | `deploy-preflight.py:15,128`（`/usr/bin/uname -r`） | `checks():172-173`、提示 `:207,209`、测试 | 字符串；非空才通过；与 Node `release()`/收据 `osRelease` 同格式（S7:115 证明服务也是拿 `release()` 比较） |
| `nextBootKernel` | `:129` 调 `READ_NEXT_BOOT_KERNEL` | `checks():172`、提示 `:207` | 只可能是 `vmlinuz-(\S+)` 或空；空则失败；与 `runningKernel` 同格式 |
| `qualifiedKernel` | `:130` 调 `READ_QUALIFIED_KERNEL`，取收据 `osRelease` | `checks():173`、提示 `:209` | 正则允许 `6.8.0-142-generic` 这类值；空/非字符串则失败 |
| `GRUB_CONFIG`/`GRUB_ENVIRONMENT`/`BOOT_DIRECTORY` | `:16-18` | 远程脚本 `:129`、提示 `:207`、测试 patch `test_deploy.py:337` | 都是绝对路径常量；测试用 patch 覆盖后能跑通 |
| 检查名 `NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL`/`RUNNING_KERNEL_MATCHES_QUALIFICATION`、提示前缀 `PREFLIGHT_NEXT_BOOT_KERNEL`/`PREFLIGHT_QUALIFIED_KERNEL` | `:172-173`、`:206-209` | 只有本文件日志、测试和 `[I-81]` 文档；未找到其它解析器 | 一致；`PREFLIGHT_FACTS` 的 JSON 新增键也没有别的消费者 |
| 收据字段 `osRelease` | `cloud-seal.mjs:500`、各 `hermes-*-seal.mjs` 的 `osRelease: release()` | 服务 `S7-startup-readback.mjs:115` 的 `assert.equal(receipt.osRelease, release())`；上线前检查 `READ_QUALIFIED_KERNEL` | 两端都是内核 release 字符串，格式一致；但预检查取的是“mtime 最新”收据，不是服务实际用的那份（见低风险发现） |

没有发现两端校验格式不兼容的问题；真正的不一致是“取哪一份收据”的语义，而不是值格式。

---

## 未核实

- 生产机 2026-11-07 的真实 `/boot/grub/grub.cfg`/`grubenv` 内容与格式（本环境不能读 `/boot`，仓库里也没有真实样本）；因此“生产正常状态一定通过”只对手写 fixture 验证过。
- 无法实际运行 `npm run check:delivery-deploy` 或任何测试（工具限制只允许 git 命令与读文件），测试是否全绿、反向用例在旧提交上是否确实失败，是按代码阅读推断的。
- `.agents/reviews/pr-246/round-1/judgments.md` 等第 1 轮复核原文在仓库中不可读（`git show` 被记录路径保护拒绝，工作树中不存在），只能从代码/测试/文档增量判断第 2 轮是否改对。
- `prev_saved_entry` 与 `initrdfail` 在真实生产上是否被触发（作者已在 `[I-81]` 标为未覆盖；`prev_saved_entry` 机制确实存在于 Ubuntu `00_header`，但生产 grubenv 是否有该变量未核实）。
