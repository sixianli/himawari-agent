# PR #246 第 4 轮复核结论

我核对了 `f0478c4..b8566755` 的完整改动和 `720b2ad5..b8566755` 的增量，重点按“解析真实 Ubuntu grub.cfg 会不会误判/漏拦”“提示是否安全”“两端取值是否同源”检查。以下按严重度排列。

## 发现

### 1. 中｜`scripts/delivery-mode/deploy-preflight.py:58-61`｜检查依赖上游文本的逐字匹配，却只用合成 grub.cfg 验证

证据（我读到的代码）：
```
'    lines = [" ".join(line.split()) for line in config.splitlines()]\n'
'    defaults = [line for line in lines if line.startswith("set default=")]\n'
'    standard = defaults == [\'set default="${next_entry}"\', \'set default="${saved_entry}"\'] and \'if [ "${next_entry}" ] ; then\' in lines and lines.index(\'if [ "${next_entry}" ] ; then\') + 1 == lines.index(defaults[0]) and lines[lines.index(defaults[1]) - 1] == "else"\n'
```
测试里的 grub.cfg 是手写的（`test_deploy.py:266-282`），`test_production_state_of_november_7_passes`（`test_deploy.py:245-247`）也只用这份合成配置；I-81 行自己写明“解析只用按 Ubuntu `10_linux` 格式手写的 grub.cfg 验证过，没有用生产的真实文件”（`docs/incidents-and-gates.md:119`）。

影响：只要生产真实文件在这一行上有一处不同（例如 `]; then` 没有分号前空格、`else` 前有别的行、GRUB 版本措辞不同），`standard` 为假，答案为空，`NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL` 永远失败，每次上线都被拦——正是这个 PR 想避免的误拦，只是从“误判已装内核”换成了“误判文件格式”。这是失败关闭，不会放行；但会阻塞上线。

建议：把生产机 `/boot/grub/grub.cfg` 只读抓回来做固定测试样本（脱敏后入库），或在测试里加入真实文件生成路径；解析改成结构化定位（先找 `if [ "${next_entry}" ] ; then` 块和它的 `else`/`fi`，再检查两分支里各只有那一行 `set default`），不要把整行文本当契约。

### 2. 中｜`scripts/delivery-mode/deploy-preflight.py:53-54`｜只验 vmlinuz，不验 initrd，也不读 initrdfail

证据：
```
'def installed(kernel):\n'
'    return kernel if kernel and (pathlib.Path(sys.argv[3]) / ("vmlinuz-" + kernel)).is_file() else ""\n'
```
I-81 行也承认“`initrdfail` 回退……不读，`initrd.img` 是否存在不查”（`docs/incidents-and-gates.md:119`）。

影响：如果目标内核的 `initrd.img-<版本>` 丢失/损坏，重启会在 initrd 阶段失败，Ubuntu 的 initrdfail 回退可能改启动上一个菜单项；此时检查仍会算作“下次启动 = 运行内核”而放行，重启后服务可能进到别的内核并因资格收据不符起不来。这是真实的漏拦路径，不只是理论：检查读取的状态和真实启动链路不一致。

建议：`installed()` 同时要求 `/boot/initrd.img-<kernel>` 是文件（或至少把缺失判失败），并在文档“未覆盖”里保留 initrdfail；若要更稳，读 grubenv 的 `initrdfail` 出现时直接拒绝。

### 3. 低｜`scripts/delivery-mode/deploy-preflight.py:216`｜两条失败提示同时出现时，前缀说的目标和示例命令不一致

证据（同一行）：
```
... ('first resolve PREFLIGHT_QUALIFIED_KERNEL below, then point GRUB at the kernel it settles on; ' if facts.get('qualifiedKernel') != facts.get('runningKernel') else '') + ... 'point GRUB at the running kernel with its full quoted entry path ... grub-set-default \'gnulinux-advanced-<uuid>>gnulinux-' + facts.get('runningKernel', '<kernel>') + '-advanced-<uuid>\' ...
```
当收据内核与运行内核不同时，前缀让人先按 `PREFLIGHT_QUALIFIED_KERNEL` 选定目标，但后面的具体示例始终用 `runningKernel` 生成 `grub-set-default`。如果按提示选择“启动收据记的内核”，示例却把 GRUB 指回运行内核，操作会指错。`test_deploy.py:794-795` 只断言前缀出现，没有断言示例目标随选择变化，也没有断言两条提示的先后（“below”是否真的在下面），所以这个不一致不会被测试发现。

建议：把示例里的 `<kernel>` 改成“最终选定的目标内核”（例如在同时失败时用 `qualifiedKernel`，或明确写“二选一后替换示例中的内核”），并补测试同时断言两条提示的相对顺序。

### 4. 低｜`scripts/delivery-mode/deploy-preflight.py:74-75`｜预检取的收据和服务实际使用的那份不是同一个来源（Q4 两端核对）

证据：
```
'    receipts = sorted(pathlib.Path(sys.argv[1]).glob("*/installation-receipt.json"), key=lambda path: (path.stat().st_mtime, path.parent.name))\n'
'    release = json.loads(receipts[-1].read_text()).get("osRelease", "") if receipts else ""\n'
```
预检在 `newQualificationEvidenceRoot` 的父目录下按 mtime 选“最新”收据；而服务启动时用的是它配置里指向的那份收据（`packages/platform-node/src/capabilities/sandbox-host-verifier.ts:214` 比较 `qualification.osRelease !== release()`；`scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs:106-115` 读并校验同一份 `installation-receipt.json`）。两边不是按同一个路径定位：只要父目录里有一份 mtime 更新、但不是当前服务在用的收据（例如失败/预置留下的目录），`RUNNING_KERNEL_MATCHES_QUALIFICATION` 就可能比错对象，误拦或误放。I-81 行已把“按修改时间、同时间按目录名取”列为未覆盖，但这是两端取值一致性问题，值得在代码里消掉而不是只写进未覆盖。

建议：直接传服务实际使用的 qualification 目录（从绑定/unit 里取），或先核对 `newQualificationEvidenceRoot` 的父目录里哪一份是当前 unit 引用的，再做比较；至少不要只按 mtime。

### 5. 低｜作者说法与代码/文档不完全一致

- 作者“现在的做法”写“grub.cfg 必须含 `set default="${saved_entry}"`……否则答案为空”；实际代码还要求 `set default="${next_entry}"`、两行顺序以及分别紧跟 `if`/`else`（`deploy-preflight.py:58-61`）。第 4 轮说明和 I-81 行是准确的，这段总述没同步。
- 作者写“有非空的 `next_entry` 就用它，否则用 `saved_entry`”；实际若 `saved_entry` 解析失败，`nextBootKernel` 也会被强制置空（`deploy-preflight.py:62-66`）。这是更保守的失败关闭，不是错，但描述漏了。
- I-81 行说“`if` 块里有条件出现的菜单项按总在处理，只影响用序号写的启动项”；其实用菜单项标识/标题引用一个只在条件块里出现的菜单项也会受影响，同样可能解析到实际启动时不存在的项。

## 侧重检查

- 错误路径：`READ_NEXT_BOOT_KERNEL` 用一个大 `try/except Exception` 包住读文件、`shlex.split`、`resolve`、`installed`，任何异常都输出空 `nextBootKernel`/`savedBootKernel`（`deploy-preflight.py:55-69`），再经 `checks()` 的空值比较判失败，整体失败关闭；`READ_QUALIFIED_KERNEL` 同理（`73-78`）。这一点是对的。
- 不可信输入：grub.cfg 按 UTF-8 读取、非 UTF-8 会抛异常并转为空答案（失败关闭）；`shlex.split` 遇到不配对的引号也会被外层捕获。`READ_QUALIFIED_KERNEL` 用 `re.fullmatch(r"[0-9A-Za-z.+~_-]+")` 限制输出，能阻止换行/`=`/shell 元字符污染 `key=value` 事实流和 `echo "qualifiedKernel=$(...)"`（`74-76`、`139`）。`nextBootKernel` 由 `\S+` 截取，不能含空白/换行，且 python 直接打印、不经过 shell，未发现命令注入。
- 资源耗尽：解析是逐行线性扫描，正则无回溯风险，读入的是小文件；未发现明显放大。
- 不可撤销操作：预检本身只读（只有 `read_text`/`stat`/`glob`/`is_file`），符合约束。提示里的 `update-grub`、`grub-set-default`、`grub-editenv unset next_entry` 会改启动配置，但要求“经 Andy 同意”并指向运行手册回滚节（`docs/runbooks/production-server-access-runbook.md:115-125`）；没有提示先备份 grubenv，但回滚节第 1 步会备份 `/etc/default/grub`。主要风险是第 3 条的示例目标可能指错，以及 `update-grub` 对用序号写的 `saved_entry` 可能改变序号含义（生产用标识路径，暂不影响）。
- 文档/代码一致：I-81 行与第 4 轮代码一致；运行手册新增段（`production-server-access-runbook.md:64`）与代码一致。只有上面第 5 条的作者总述和“只影响序号”的措辞需要修正。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。这个 PR 只改 `scripts/delivery-mode/deploy-preflight.py`、`test_deploy.py`、两处文档和评审记录，没有触碰系统提示、工具定义、历史消息、遮盖或模型请求组装。发给模型的内容仍然只在末尾追加；没有把每轮变化的值放进系统提示/工具定义。依据是你给的第 4 条规则（`prompt-prefix.md:35`）。新增的“发给别处的内容”是经 ssh 发给生产机的远程脚本，不是发给模型的。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
对模型内容不会。远程脚本本身由常量和绑定路径经 `shlex.quote` 拼成，没有时间/随机值；`READ_NEXT_BOOT_KERNEL` 的输出对同一份文件是确定的。唯一带排序依赖的是 `READ_QUALIFIED_KERNEL` 按 mtime 选最新收据（`deploy-preflight.py:74-75`）：同一逻辑状态若 mtime 变了，`qualifiedKernel` 可能变；这只影响上线预检，与模型请求字节无关，但属于上面第 4 条的两端一致性问题。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
有：`KernelPreflightTest`（`test_deploy.py:234-401`）和 `KernelPreflightHintTest`（`766-795`），由 `npm run check:delivery-deploy`（`package.json:44`）运行，`check:steps` 也包含它。按代码读，反向用例确实会得到空答案/失败：保存项指 147（`297-298`、`252`）、`next_entry` 指 147（`300-302`）、`next_entry` 指 142 而保存项 147（`306-308`）、非标准 `set default`（`317-334`）、子菜单/固件项（`336-345`）、内核文件缺失、序号越界、无 grubenv（`336-345`）、收据内核不是单个词（`378-384`）。第 4 轮新增的顺序颠倒、`else` 改成 `fi`、多空格 `set default`、`--id` 用例也针对地覆盖了 `standard` 的分支。
但有两处缺口：只断言“`first resolve ... below` 出现”，没断言两条提示的先后（第 3 条）；“生产 11-07 状态”用的是合成 grub.cfg，不是真实文件（第 1 条）。另外我受工具限制只能读代码、不能运行测试，以上是读代码判断，未实际执行。

**4. 每个新值/新键的两端是否都能接受？**
- `runningKernel`：`uname -r` 产生（`deploy-preflight.py:15,137`），`checks()`（`181-182`）和两条提示（`216,218`）消费；空值判失败，消费端只做字符串相等比较，无格式限制，OK。
- `nextBootKernel`/`savedBootKernel`：`READ_NEXT_BOOT_KERNEL` 产生（`65-66`），`checks()` 和提示消费；空值判失败，OK。
- `qualifiedKernel`：`READ_QUALIFIED_KERNEL` 产生，先经 `[0-9A-Za-z.+~_-]+` 校验（`75-76`），`checks()` 和提示消费。校验比服务端更严：服务端直接比较原始 `osRelease`（`sandbox-host-verifier.ts:214`、`S7-startup-readback.mjs:115`），若收据里是合法但带 `:` 等字符的内核名，预检会判“读不出”而失败。这是失败关闭，可接受，但要注意可能误拦。
- `GRUB_CONFIG`/`GRUB_ENVIRONMENT`/`BOOT_DIRECTORY`：在 `remote_script`（`138`）和提示/测试中使用，一致。
- 两个新检查名：`checks()` 产生（`181-182`），`main()` 的提示分支消费（`215-218`），测试也引用；`deploy.sh` 只看退出码，没有外部白名单，OK。
- 测试夹具 `GOOD_FACTS` 已加入四个新键（`test_deploy.py:28`），`run-all-checks` 的映射未变，OK。
- 唯一两端不同源的是 `qualifiedKernel` 的“哪份收据”（第 4 条）。

**总体判断**：第 4 轮把“只认 saved 那一行”收紧成“上游两行且紧邻”，方向对，测试也跟着补了；没有发现会直接放行到别的内核的确定性代码错误，但“严格文本 + 只用合成文件”的误拦风险和“只查 vmlinuz”的漏拦风险是这版最值得在真实生产文件上先验证的两点。
