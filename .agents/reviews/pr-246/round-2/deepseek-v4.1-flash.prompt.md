你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 85b35b0072f326f61b29f95fc422bb5f77eb20b0。
对比基准是 f0478c4de46347f87e23ff4d131e26f4c7f41d13，先运行 git diff f0478c4de46347f87e23ff4d131e26f4c7f41d13..85b35b0072f326f61b29f95fc422bb5f77eb20b0 看改动。
上一轮复核到 b1217d2cf5178f11b63bd5c677a579419dbd27cd，先看 git diff b1217d2cf5178f11b63bd5c677a579419dbd27cd..85b35b0072f326f61b29f95fc422bb5f77eb20b0 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR #246 代码复核材料

## 问题

生产服务启动前会拿当前内核（`os.release()`）和沙箱资格验证收据里记的内核比较，不一样就拒绝启动（`scripts/delivery-mode/packet-template/signing/cloud-protected-prepare.mjs:41`、`systemd/S7-startup-readback.mjs:115`、`packages/platform-node/src/capabilities/sandbox-host-verifier.ts:214`）。2026-10-19 生产重启进了自动装上的新内核，服务停了约 51 小时。2026-10-22 起生产把 GRUB 固定为启动 6.8.0-142（`GRUB_DEFAULT=saved`，`saved_entry` 指向 142），新内核 147 装着但不是默认启动项（`docs/runbooks/production-server-access-runbook.md:63`）。

这个 PR 的目标：上线前检查（`scripts/delivery-mode/deploy-preflight.py`，在上线时通过 ssh 以 root 在生产机上只读执行）发现「重启后会进一个不是当前运行内核的内核」时拦下这次上线。

## 这个 PR 的第一版为什么要改

第一版检查「已装的最新同类内核必须等于运行内核」（`NEWEST_INSTALLED_KERNEL_IS_RUNNING_KERNEL`）。生产正常的锁定状态（运行 142、已装 147、GRUB 固定 142）会被它判失败，每次上线都会被拦，而且它提示卸载 147（等于丢掉回退内核）。所以改成读 GRUB 下次实际会启动哪个内核。

## 现在的做法（作者的说法）

- 新检查 `NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL`：远程执行一段 Python（`READ_NEXT_BOOT_KERNEL`），读 `/boot/grub/grub.cfg`、`/boot/grub/grubenv` 和 `/boot`：
  - grub.cfg 必须含 `set default="${saved_entry}"`（GRUB 上游 `util/grub.d/00_header.in` 在 `GRUB_DEFAULT=saved` 时生成这一行），否则答案为空（失败）。
  - 有非空的 `next_entry` 就用它，否则用 `saved_entry`（同一文件里生成的 `if [ "${next_entry}" ] ; then set default="${next_entry}" ... else set default="${saved_entry}" fi`）。
  - 启动项写法按 GRUB 手册可以是序号、菜单标题或菜单项标识，子菜单用 `>` 分隔；按 grub.cfg 的 `menuentry` / `submenu` 结构逐级匹配，取匹配到的菜单项里 `linux` 行的 `vmlinuz-<版本>`。
  - 对应的 `/boot/vmlinuz-<版本>` 必须是文件，否则答案为空。
  - 任何异常都输出空答案，空答案判失败。
- 保留 `RUNNING_KERNEL_MATCHES_QUALIFICATION`（运行内核必须等于最新安装收据记的内核）。
- 删掉 dpkg 读已装内核的那段 shell。
- 测试在 `scripts/delivery-mode/test_deploy.py` 的 `KernelPreflightTest`（`[I-81]`），由 `npm run check:delivery-deploy` 运行。测试用按 Ubuntu `10_linux` 生成格式写的 grub.cfg，生产 11-07 的状态（运行 142、保存项是 `gnulinux-advanced-<uuid>>gnulinux-6.8.0-142-generic-advanced-<uuid>`）必须通过；反向：保存项指 147、`next_entry` 指 147、grub.cfg 不按保存项启动、指向子菜单或固件设置、内核文件不在、序号越界、没有 grubenv，都失败；另有一条把整段远程脚本在本机 bash 里跑一遍，确认引号转义正确。
- `docs/incidents-and-gates.md` 的 I-81 行按新门槛改写。

## 约束

- 这是只读检查，不得改生产机任何状态。
- 不写代码注释。
- 已知没覆盖：Ubuntu 的 `initrdfail` 回退（启动失败后改用上一个启动项）；非上线日的重启（靠锁定内核和另做的心跳告警）。

## 想请你重点看

- 解析 grub.cfg 的做法在真实 Ubuntu 24.04 云服务器的 grub.cfg 上会不会误判（例如 `function` 块、`if` 块、引号转义、`linuxefi`、单独 `/boot` 分区时路径是 `/vmlinuz-...`）。
- 有没有哪种状态会让检查放过一个重启后会进别的内核的服务器（漏拦），或者拦下生产正常状态（误拦）。
- 失败提示给出的操作是否正确、安全。

## 第 2 轮：相对 b1217d2c 的改动

按第 1 轮意见改了（判断见 `.agents/reviews/pr-246/round-1/judgments.md`）：失败提示给完整带引号的启动项路径、要求先经 Andy 同意并引用运行手册回滚一节；grub.cfg 取最后一行生效的 `set default`；收据 osRelease 只接受单个词；补了用例；运行手册和 I-81 行补了说明。请先看增量是否把问题改对、有没有改出新问题。
