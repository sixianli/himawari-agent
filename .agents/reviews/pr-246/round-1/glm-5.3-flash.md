# PR #246 复核报告（基准 f0478c4 → b1217d2c）

## 侧重检查

我走的是最普通的一条使用流程：`deploy.sh:71`（`python3 -I deploy-preflight.py "$packet"`）→ `main()`（deploy-preflight.py:179）→ `ssh root@…`（183，`remote_script` 112-133）→ facts 解析（187）→ `checks()`（154-176）→ 打印 `PREFLIGHT_CHECK/PREFLIGHT_FACTS/提示` → 退出码（216）。

读代码证实的：
- 新增三个远程事实只读：`uname -r`（15）、远程 Python 读 grub.cfg/grubenv/`/boot`（19-60，全部是 `read_text/glob/stat/is_file`，无任何写操作）、读收据（61-68，同样只读）。`remote_script` 仍是 `set -u` 加只读命令。符合“只读检查”约束。
- 测试接线与文档一致：`package.json:44` 的 `check:delivery-deploy` 跑 `test_deploy.py`，且在 `check:steps`（package.json:27）里；`test/tooling/run-all-checks.test.mjs:60` 有脚本↔文件映射；`docs/incidents-and-gates.md:119` 的 I-81 行描述的检查名、反向用例、mtime 并列按目录名取（READ_QUALIFIED_KERNEL:64 的 key `(st_mtime, parent.name)`）都与代码对得上；生产锁定状态（GRUB_DEFAULT=saved、saved_entry→142、hold 排除 `^linux-`）与 `docs/runbooks/production-server-access-runbook.md:63,76,120-122` 一致；测试 fixture 用的 UUID `9a3e62be-…` 即 runbook:118 写的根分区 UUID。
- 这条流程里没有测试覆盖的代码路径：ssh 实际执行、`main()` 的输出/退出码逻辑、两条新提示文案 `PREFLIGHT_NEXT_BOOT_KERNEL`（205）/`PREFLIGHT_QUALIFIED_KERNEL`（207）没有任何断言（既有的类似提示如 `PREFLIGHT_REFREEZE` 在 test_deploy.py:728 有 `assertIn`，三个新内核 fact 的检查和两个远程 Python 脚本有 19 条用例、远端脚本串接还有一条本机 bash 冒烟）。
- GRUB 解析对真实 Ubuntu 24.04 形态的适配（作者点名要我看的几项）：`function savedefault {`/`function gfxmode {` 这类以 `{` 结尾的非菜单行按 ("other",None) 压栈、能正确弹出（32-35）；fixture 里就有 `function savedefault {` 和 `if [ x$grub_platform = xxen ]` 嵌套行；`linuxefi` 被正则 `linux(?:efi)?\s+`（37）覆盖；单独 `/boot` 分区的 `linux /vmlinuz-…` 与 `/boot/vmlinuz-…` 两种写法都被 `\S*/vmlinuz-` 覆盖，且文件检查统一用 `/boot`（57），/boot 挂载时两者等价。序号/标题/id 三种写法、`子菜单>子项` 路径、逐级序号（`1>2`→第 2 个子项，与 GRUB 计数含恢复项的顺序一致）都有正向+反向用例。
- 未核实（我不能上网、不能连生产机、不能运行测试）：GRUB 上游 `00_header.in` 原文是否逐字生成 `set default="${saved_entry}"`（与 Ubuntu 实机格式一致的知识性判断，非本次读代码所得）；生产机 11-07 的真实 GRUB/收据状态；GRUB 对只有叶子 id（不带 `子菜单>` 前缀）的 saved_entry 的实际匹配行为；测试的真实运行结果（反向用例只做了静态核对，见下）。

## 发现（按严重度从高到低）

1. **低 | docs/incidents-and-gates.md:119 及复核材料 | “保留 RUNNING_KERNEL_MATCHES_QUALIFICATION”“删掉 dpkg 那段 shell”的说法相对基准不成立**
   证据：`git diff f0478c4..b1217d2c -- scripts/delivery-mode/deploy-preflight.py` 全为 `+` 行（63 增 0 删）；基准版 f047 的 `checks()`（git show 读得）没有任何内核检查、也没有 dpkg shell；dpkg 版 `NEWEST_INSTALLED_KERNEL_IS_RUNNING_KERNEL` 是分支第一个提交 b6e5db33 引入、后被替换的（`git show b6e5db33 --stat`：+25 行含两项检查）。即相对基准两项内核检查都是本 PR 新增，“删掉/保留”只描述 PR 分支内部演变。
   建议：复核记录里按基准→终态表述，避免“保留/删掉”造成这 PR 只是改写旧检查的印象。

2. **低 | deploy-preflight.py:58-59、205 | 任何解析异常都吞成空答案，失败提示只讲 saved_entry/next_entry，诊断时会误导**
   证据：58-59 `except Exception: print("")`——包括第 27 行 `shlex.split` 在标题含撇号/引号不配对（os-prober 生成的 Windows 等外来项理论上可能）时抛 ValueError，整个检查变空；而 205 的提示只解释保存项/GRUB_DEFAULT，不提示“可能是 grub.cfg 解析不了”。方向是保守误拦，不漏。
   建议：异常时打印一句话到 stderr（或 facts 里带个 reason 字段）区分“读不了/解析不了”和“保存项指向别的内核”；至少在提示里加一句“若 grub-env 与配置看似正常，先手动 `grep menuentry_id_option` 并目视 grub.cfg”。

3. **低 | deploy-preflight.py:64、128 | qualifiedKernel 取“mtime 最新的收据”，但运行服务绑定的是“上次成功上线那一次”的收据目录，一次资格通过但没切上去的失败上线会留下更新的收据目录**
   证据:`cloud-seal.mjs:534` 每个 packet 往自己的 `newQualificationEvidenceRoot` 写收据；运行服务启动时按包模板固定读本次目录（`S7-startup-readback.mjs:13`）。收据目录按 mtime 排序时，一个资格通过、S7 没切完就失败的 packet 会排到正在服务的那个前面（读代码证实；未在生产查过是否真发生过）。若两者内核不同，`RUNNING_KERNEL_MATCHES_QUALIFICATION` 误拦，提示“boot the kernel the receipt records”（207）指的是那个没上线的收据。
   建议：取“收据完整且签到失败可能性低”的口径不变也行，但考虑给提示补一句“若最新目录属于一次没切上去的上线，以其为准”；或只在收据目录数个都同内核时才放行（不必要，仅记录残余误拦可能）。

4. **低 | deploy-preflight.py:205 | 失败提示里 `grub-set-default` 的用法对生产的菜单结构可能不充分**
   证据：生产 saved_entry 形态是 `gnulinux-advanced-<uuid>>gnulinux-…-advanced-<uuid>` 两段路径（I-81 自述 + `test_production_state_of_november_7_passes`），提示只说 “grub-set-default and the id of its menu entry (grep menuentry_id_option …)”——只拿叶子 id 时 GRUB 能否在子菜单结构下按顶层匹配找到**未核实**（GRUB 文档说要用 `>` 分隔的路径；runbook:76 的 `grub-editenv list` 输出也只有完整路径形态）。
   建议：文案改成“完整路径 `子菜单 id>菜单项 id`”，与 saved_entry 已有格式对齐，减少人手操作第二次出错的概率。

5. **低（残余漏拦边界，作者已部分声明）| deploy-preflight.py:170 | 检查通过到真实重启之间 grub.cfg/grubenv 可能变化，且个别 GRUB 状态不在检查范围**
   证据：检查只读启动时的静态文件；`initrdfail`（作者已声明）；检查后被手动 `grub-reboot`/脚本写 next_entry、或菜单顺序因 update-grub 变化时序号型 saved_entry 会指向别的项。生产侧缓解：`52himawari-hold` 排除 `^linux-` 自动装内核（runbook:63，读代码证实），所以“中间装新内核”路径在生产被压住。
   建议：不动代码；在 I-81 的“未覆盖”里把“检查之后被写入 next_entry/重新生成 grub.cfg 的窗口”也记一笔，配心跳告警兜底（已有）。

6. **低 | test_deploy.py（KernelPreflightTest）| 测试缺口：两条新失败提示没有断言；`linuxefi` 分支和“标题带撇号导致 shlex 抛错”无用例**
   证据：test_deploy.py 全文检索无 `PREFLIGHT_NEXT_BOOT_KERNEL`/`PREFLIGHT_QUALIFIED_KERNEL` 断言（对比 line 728 对 `PREFLIGHT_REFREEZE` 的模式）；READ_NEXT_BOOT_KERNEL:37 的 `linux(?:efi)?` 分支 fixture 里没有 linuxefi 行。
   建议：补两条 fixture（linuxefi 行按 142 处理、含撇号标题的 Windows 项不炸出空答案也行炸出也行但要有用例记录行为）；给 205/207 各一条 `assertIn`。

**没有发现的（核实过、无可疑）**：解析器对 `menuentry/submenu`、`{` 计数、`}` 弹栈、序号越界、`0>0` 指向非子菜单、固件项、内核文件缺失、grubenv 缺失/损坏、收据损坏/缺失等都返回空并判失败（保守，全部有对应反向用例且静态核对成立）；`checks()` 两条新检查对 `runningKernel`/`nextBootKernel`/`qualifiedKernel` 的空值处理本身都会失败。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。读代码证实：diff 只改 `deploy-preflight.py`、`test_deploy.py`、`docs/incidents-and-gates.md`（git diff --stat），这三个文件不参与任何模型请求的组装（提示词目录、遮盖、消息序列化代码无一行变动）；preflight 输出只进运维 stdout/exit code（`deploy.sh:71` 读退出码）。所以“仍只在末尾追加、每轮会变的值在最后一条消息”的约束本次未被触碰，前提继续成立。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增值（三个内核 fact）不进模型请求；产出端排序确定（收据 mtime 并列按目录名，READ_QUALIFIED_KERNEL:64），grubenv 的 dict 只做 `get` 查询不遍历输出（54-55），menu() 严格按文件行序构建（24-40）。读代码证实。
3. **有没有对应的自动检查，反向用例会失败吗？** 有：`KernelPreflightTest`（test_deploy.py:234）19 条用例，经 `check:delivery-deploy`（package.json:44）进 `npm run check`。读代码证实正向/反向用例与 `checks()` 语义逐条吻合（如 `nextBootKernel=''` 只挂 `NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL`、`runningKernel=''` 挂两条、远程脚本三种命名法与真实路径解析一致）。未核实：我无法运行测试，未拿到真实运行结果。
4. **每个产出值的产生端与使用端都核对过吗？** 是（读代码证实）：
   - `runningKernel`：产自 `uname -r`；使用于两条检查 + 三处提示。与服务端语义一致：`sandbox-host-verifier.ts:214` 比较的是 `os.release()`，即同为 `uname -r` 值。
   - `qualifiedKernel`：产自最新收据的 `osRelease`（`cloud-seal.mjs:500` 收据里就写 `osRelease: release()`）；使用于检查 + 提示；与 S7 启动时对同一收据的校验（S7-startup-readback.mjs:174-175 调 verifySandboxHost）同源同字段。残余问题见发现 3（失败上线的收据目录可能排到最新，方向是误拦）。
   - `nextBootKernel`：产自远程 Python；使用于检查 + 提示。正确性取决于解析器与 GRUB 启动语义是否一致——序号/标题/id、`>` 路径、子菜单序号计数均对齐；边界（initrdfail、检查后状态变化、叶子 id 的 saved_entry）见发现 5 与未核实项。
   - `GRUB_CONFIG/GRUB_ENVIRONMENT/BOOT_DIRECTORY` 三个常量在 `remote_script`（127）与提示文案（205）中使用同一常量，路径一致；`]key=value` 输出协议与 `main()` 的 `split('=',1)` 解析兼容（内核版本字符串中不含 `=`）。
