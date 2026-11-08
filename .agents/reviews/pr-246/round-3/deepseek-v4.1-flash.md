## 结论

第 3 轮增量（`85b35b0..720b2ad`）确实按上一轮意见改对了三件事：分别读取 `next_entry` 与 `saved_entry`、两者都要等于运行内核、失败提示先要求审批并引用运行手册。生产的正常锁定状态（运行 142、`saved_entry` 指向 142、无 `next_entry`）按代码会通过。剩下的主要问题是：对新门槛「grub.cfg 只能按保存项启动」的校验是**按行集合**做的，没有校验这些 `set default` 的结构和位置，因此存在漏拦；另有几处取值来源、提示措辞和测试覆盖的低风险问题。

---

## 发现（按严重度）

### 1. 中：`set default` 只按「集合」校验，无法保证保存项是真正生效的最后一个默认项（漏拦）
- 文件:行：`scripts/delivery-mode/deploy-preflight.py:57-58`
- 问题（读代码证实）：代码先把所有以 `set default=` 开头的行收成集合，再排除恰好等于 `set default="${next_entry}"` 的行，要求剩余集合等于 `{'set default="${saved_entry}"'}`。它不关心 `next_entry` 那一行在 `if` 的 then 分支、也不关心 `saved_entry` 那一行在 `else` 分支，更不关心先后顺序。于是只要这两行的**集合**对，就算通过。
- 证据：
  ```python
  '    defaults = {line.strip() for line in config.splitlines() if line.strip().startswith("set default=") and line.strip() != \'set default="${next_entry}"\'}\n'
  '    entries = menu(config) if defaults == {\'set default="${saved_entry}"\'} else []\n'
  ```
- 反例（读代码可推出，不需要真实机器）：若 grub.cfg 把顺序写成
  ```
  set default="${saved_entry}"
  set default="${next_entry}"
  ```
  且 grubenv 没有 `next_entry`，本函数会输出 `nextBootKernel=142 / savedBootKernel=142` 并通过；但 GRUB 实际先设 142、再执行 `set default=""`，空默认值会落到第一个菜单项（生产第一个通常是 147），重启后进 147。同理，把 `if [ "${next_entry}" ]` 的条件写反（`-z`）也会被放过，因为两行的字符串集合不变。
- 建议：不要只看集合，按 GRUB 生成的标准块校验结构：要求 `set default="${next_entry}"` 位于 `if [ "${next_entry}" ]` 的 then 分支、`set default="${saved_entry}"` 位于对应 `else` 分支；或直接匹配整段标准块。也可以在解析后模拟一次「next_entry 为空时依次执行各行」得到最终默认值，再解析该值对应的菜单项。至少补一条「顺序颠倒/条件写反应失败」的用例。

### 2. 中低：菜单项 id 只认字面量 `$menuentry_id_option`，换成 `--id` 会整段解析失败（误拦，不会漏拦）
- 文件:行：`scripts/delivery-mode/deploy-preflight.py:28`（`menu()`）、`:64-66`（异常兜底）
- 问题（读代码证实）：`words.index("$menuentry_id_option")` 找不到该 token 就抛 `ValueError`，被外层 `except` 吞掉，结果两个内核都输出空，上线被拦。Ubuntu `10_linux` 生成的是字面量 `$menuentry_id_option`（运行手册 119 行的 `grep -oE "menuentry_id_option '[^']+'"` 也依赖它），所以生产大概率没事；但这不是对所有真实 grub.cfg 都成立，作者也承认只用按 Ubuntu 格式手写的 fixture 验证过。
- 证据：
  ```python
  '            node = {"title": words[1], "id": words[words.index("$menuentry_id_option") + 1] if "$menuentry_id_option" in words else "", ...
  ```
- 建议：同时接受 `--id` 和 `$menuentry_id_option`；把一份真实（脱敏）生产 grub.cfg 作为 fixture 加进 `KernelPreflightTest`，这是目前「未核实」里最该补的一项。

### 3. 低：`RUNNING_KERNEL_MATCHES_QUALIFICATION` 读的是「按 mtime 最新的收据」，与运行中服务实际校验的收据路径/签名不完全一致
- 文件:行：`scripts/delivery-mode/deploy-preflight.py:71-73`、`:136`；对照 `scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs:106-115`
- 问题（读代码证实）：预检从 `qualification/*/installation-receipt.json` 里按 `(mtime, 目录名)` 取最新的一份，只信 `osRelease`，不校验 `installation-receipt.sig`；而服务启动时是从本次 `newQualificationEvidenceRoot` 下的固定收据读取并验证签名（`verify(...installation-receipt.sig)`）后才比较 `osRelease`。
- 证据：
  ```python
  '    receipts = sorted(pathlib.Path(sys.argv[1]).glob("*/installation-receipt.json"), key=lambda path: (path.stat().st_mtime, path.parent.name))\n'
  '    release = json.loads(receipts[-1].read_text()).get("osRelease", "") if receipts else ""\n'
  ```
  ```js
  const receiptBytes = qualifiedFile("installation-receipt.json");
  assert(verify(null, receiptBytes, publicKey, qualifiedFile("installation-receipt.sig")), ...);
  assert.equal(receipt.osRelease, release(), ...);
  ```
- 影响（推测）：如果 `/var/lib/himawari/qualification` 下存在比运行中服务使用的那份更新的收据（例如某次失败/演练留下的收据），预检可能拿错基准而误拦；反之，若最新收据签名无效但 `osRelease` 恰好等于运行内核，预检会通过，而服务仍会因签名失败拒绝启动。生产是 root 目录、权限 0，不构成新的提权面。
- 建议：明确这个检查的语义。若想模拟服务启动，应读取运行中部署对应的收据（而不是按 mtime 猜）并校验签名；若只作为启发式，请在 I-81 里写清「不校验签名、按 mtime 取最新」，避免读者以为它等价于服务的启动校验。

### 4. 低：失败提示让操作者把 GRUB 指向「运行内核」，但真正绑定的目标是收据里的内核；两条提示同时出现时指引冲突
- 文件:行：`scripts/delivery-mode/deploy-preflight.py:213`、`:215`
- 问题（读代码证实）：`NEXT_BOOT_KERNEL` 的提示写「point GRUB at the running kernel」；而 `RUNNING_KERNEL_MATCHES_QUALIFICATION` 的提示写「boot the kernel the receipt records」。当两者都失败（运行内核本身就与收据不符）时，两条建议互相矛盾；按第一条做可能重启进一个服务仍会拒绝的内核。
- 证据：
  ```python
  '... point GRUB at the running kernel ... grub-set-default \'gnulinux-advanced-<uuid>>gnulinux-' + facts.get('runningKernel', '<kernel>') + '-advanced-<uuid>\' ...'
  '... either boot the kernel the receipt records ... or qualify the running kernel first ...'
  ```
- 建议：在 `qualifiedKernel` 已知且合法时，NEXT 提示应指向收据内核（或明确「先解决 QUALIFIED 那条，再按收据内核设保存项」）；两条提示的先后顺序也应在测试里固定。

### 5. 低：解析对 `set  default=`（多个空格）等合法写法视而不见，可能漏掉隐藏的默认项
- 文件:行：`scripts/delivery-mode/deploy-preflight.py:57`
- 问题（读代码证实）：`.strip().startswith("set default=")` 只认单个空格。GRUB 脚本里 `set  default="0"` 仍是合法的「设默认项」，但不会被计入 `defaults`，于是即使真实默认项是 0，也可能被判定为 `{saved_entry}` 而通过。
- 建议：用正则 `^set\s+default\s*=`（并处理引号）匹配，或按 GRUB 语法解析赋值。这与发现 1 属于同一类结构校验问题。

### 6. 低：测试不是端到端，且缺少 `--id`/结构反向用例
- 文件:行：`scripts/delivery-mode/test_deploy.py:245-247`、`:249-254`、`:342-355`
- 问题（读代码证实）：`test_production_state_of_november_7_passes` 先用 `next_boot()` 验证解析结果，再用硬编码的 `nextBootKernel=...`、`savedBootKernel=...` 调 `failed()`，没有把解析输出真正喂给 `checks()`；只有 `test_remote_script_reads_the_three_kernel_facts` 把远程脚本在 bash 里跑了一遍。结构类反例（发现 1、2、5）都没有用例。
- 建议：加一条「临时目录里的 grub.cfg/grubenv → `READ_NEXT_BOOT_KERNEL` 输出 → 解析成 facts → `checks()` 必须通过/失败」的端到端用例；补 `--id`、`set  default`、顺序颠倒、条件写反四条反向用例。

### 7. 低：文档与代码的措辞差异
- 文件:行：`docs/incidents-and-gates.md:119`、`docs/runbooks/production-server-access-runbook.md:64,77`
- 问题（读代码证实）：I-81 写「除了 `next_entry` 那一行，只能有 `set default="${saved_entry}"`」，读者会以为代码校验了行数和位置；实际代码是集合校验，允许重复、任意位置（见发现 1）。运行手册第 77 行说 `grub-editenv list` 只应出现 `saved_entry`，但代码也允许 `next_entry` 指向运行内核并通过。两者不是错误，但比代码更严。
- 建议：I-81 改成准确描述（「其余默认项必须是 saved_entry 那一行；不校验其在 if/else 中的位置」），或先把代码改成结构校验再保留现在的措辞；运行手册可写「通过时也接受 `next_entry` 指向运行内核，但建议没有 `next_entry`」。

---

## 侧重检查

- **错误路径（读代码证实）**：`GRUB_CONFIG`/`GRUB_ENVIRONMENT` 缺失或不可读、`menu()` 中 `shlex.split`/`words.index` 失败、`resolve` 越界、内核文件不存在、没有任何收据，都会走到 `except` 输出空答案，`checks()` 因 `runningKernel` 非空但 `nextBootKernel`/`savedBootKernel` 为空而失败（`deploy-preflight.py:178`）。SSH 非零时 `main()` 提前返回 1（`:191-194`）。远程命令用 `;` 连接而不是 `&&`，单个子命令失败会被后续行继续执行，但缺字段仍判失败，属于 fail-closed，安全。
- **不合规范输入（读代码证实）**：`grub.cfg`/`grubenv` 是 root 只读文件，解析全在 Python 内，不经过 shell；`next_entry`/`saved_entry` 只用于 `resolve` 和拼 `/boot/vmlinuz-`，没有拼接进 shell 命令。内核字符串最终要与 `uname -r` 完全相等，构造 `../` 之类的值不可能通过。
- **安全（读代码证实 + 推测）**：收据只校验 `osRelease` 的字符集、不验签（发现 3）；因为目录是 root 独占，不构成新的越权面，但语义上弱于服务自身校验。失败提示里的 `runningKernel` 来自 `uname -r`，Linux 下不可能含单引号，提示文本的引号注入风险可忽略。
- **资源耗尽（读代码证实）**：只读 `grub.cfg`/`grubenv`（正常几百字节到 1 KiB）和每个收据目录；`int(part)` 在 Python 3.11+ 有位数上限会抛错并 fail-closed，旧版 Python 下超长数字串可能耗 CPU，但输入是 root 文件。
- **不可撤销操作（读代码证实）**：远程脚本全部是读取/查询（`read_text`、`is_file`、`uname`、`df`、`sha256sum`、`systemctl show/is-active`、`git cat-file -e`），没有写操作；修复动作全部在提示里，且要求先经 Andy 同意并引用运行手册回滚一节，符合「只读检查」约束。
- **规则/说明与代码一致**：第 3 轮新增的 `savedBootKernel`、双内核要求已同步进 `checks()`、提示、GOOD_FACTS、测试、I-81 和运行手册，基本一致；不一致点见发现 1、3、7。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次改动只涉及 `scripts/delivery-mode/deploy-preflight.py`、`test_deploy.py` 和两份文档；发给模型的内容（系统提示、工具定义、历史消息、遮盖结果）没有一处被修改。模型侧请求仍然「只在末尾追加」，不存在把每轮会变的值塞进开头的问题。依据：规则文件 `[发给模型的内容只追加](.claude/rules/prompt-prefix.md#rules)`；该文件不在当前检出里（`glob` 未找到，未核实原文），但改动范围本身已足以判定与本问题无关。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。新增的 `nextBootKernel`/`savedBootKernel` 只在本机/生产机之间传递，不进入任何发给模型的文本；没有依赖前后文的遮盖、时间字段或无序集合被加入模型请求。改动中唯一的「集合」是 grub.cfg 解析里的 `defaults`，它只影响预检判定，不参与模型内容。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有。`package.json:44` 的 `check:delivery-deploy` 就是 `python3 -I scripts/delivery-mode/test_deploy.py`，并且 `test/tooling/run-all-checks.test.mjs:60` 强制它属于 `npm run check:steps`；`KernelPreflightTest`/`KernelPreflightHintTest` 带 `[I-81]`。
   - 反向用例确实会失败（读代码证实）：`test_a_reboot_into_another_kernel_is_refused`（`test_deploy.py:249-254`）对 `savedBootKernel=147`/空 断言 `NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL` 失败；旧实现只比较 `nextBootKernel` 时这条会通过，所以能挡住回退。片段级也有 `test_a_one_time_entry_does_not_hide_the_saved_entry`（`:306-309`）、`test_a_later_default_overrides_the_saved_entry`（`:325-329`）、缺 grubenv/内核文件/越界等（`:331-340`）。
   - 缺口：没有发现 1/2/5 对应的结构类反向用例，且解析→`checks()` 没有端到端串联（见发现 6）。

4. **改动产生/修改的每个值，每个使用它的地方都能接受吗？**
   - `nextBootKernel`、`savedBootKernel`：产生于 `READ_NEXT_BOOT_KERNEL`（`:59-63`），使用于 `checks()`（`:178`）、失败提示（`:213`）、`GOOD_FACTS` 和测试（`test_deploy.py:28,246-254,293-295,352`）。两端格式一致（`key=value`，空值表示失败），可以接受。
   - `READ_QUALIFIED_KERNEL` 的 `osRelease`：产生于收据，使用于 `RUNNING_KERNEL_MATCHES_QUALIFICATION`（`:179`、`:215`）；字符集 `[0-9A-Za-z.+~_-]+` 与 Node `os.release()` 的 Linux 输出兼容，非法值会被判空从而 fail-closed。但使用端（服务 `S7-startup-readback.mjs:106-115`）还要求验签和固定路径，预检没有对齐（发现 3）。
   - `GRUB_CONFIG`/`GRUB_ENVIRONMENT`/`BOOT_DIRECTORY`：产生于模块常量，使用于 `remote_script`（`:135`）和测试 mock（`test_deploy.py:348`），一致。
   - 检查名 `NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL`/`RUNNING_KERNEL_MATCHES_QUALIFICATION`：使用于提示分流（`:212-215`）、I-81 文档和测试断言，名称与新语义（同时检查 saved）略不符，但文档已说明，功能无影响。
