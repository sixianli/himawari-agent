## 读代码证实的发现（按严重度）

### 高

**1. `scripts/delivery-mode/deploy-preflight.py:205`：失败提示给出的 `grub-set-default` 修法在生产子菜单场景下不完整，且可能把 GRUB 默认项设错**

证据（提示原文只要求“内层菜单项 id”）：

```python
'... As root, point GRUB back at the running kernel with grub-set-default and the id of its menu entry (grep menuentry_id_option ' + GRUB_CONFIG + '), and clear a one-time choice with: grub-editenv ' + GRUB_ENVIRONMENT + ' unset next_entry. ...'
```

但生产保存项是“父菜单 > 子菜单项”的完整路径，测试和运行手册都这么写：

```python
# test_deploy.py:246
self.assertEqual(self.next_boot(saved_entry=self.ADVANCED + '>' + self.entry_id('6.8.0-142-generic')), '6.8.0-142-generic')
```

```text
# docs/runbooks/production-server-access-runbook.md:63
GRUB_DEFAULT=saved，saved_entry 指向 142
```

问题：

- 提示没有说明保存项必须是 `gnulinux-advanced-<uuid>>gnulinux-6.8.0-142-generic-advanced-<uuid>` 这种完整路径，只拿内层 id 去 `grub-set-default`，很可能匹配不到。
- 即使只看内层 id，`>` 在未加引号的 shell 命令里是重定向符号；操作者照着提示手敲，可能只把 `>` 左边传给 `grub-set-default`，右边被当成文件名。
- 提示还建议无条件 `unset next_entry`；如果 `saved_entry` 本身已经指 147，清掉 `next_entry` 后仍然会进 147。

建议：在提示里打印带引号的完整命令（明确要求 `'父>子'` 整体加引号），或直接指向运行手册的 Rollback 一节；先让操作者用 `grub-editenv list` 确认 `saved_entry`，确认它已指 142 后才清 `next_entry`。

> “内层 id 不会自动补父路径”“无效 default 会回退到第一个菜单项”属于对 GRUB 行为的推测，未在本机执行验证；但“生产保存项是完整父子路径”是测试和文档里读到的。

---

### 中

**2. `scripts/delivery-mode/deploy-preflight.py:64,128,171`：`RUNNING_KERNEL_MATCHES_QUALIFICATION` 用的是“父目录下 mtime 最新的收据”，不一定是运行中服务实际使用的那份收据**

证据：

```python
# deploy-preflight.py:64
'receipts = sorted(pathlib.Path(sys.argv[1]).glob("*/installation-receipt.json"), key=lambda path: (path.stat().st_mtime, path.parent.name))\n'
# deploy-preflight.py:128
'... shlex.quote(str(Path(binding[\'service\'][\'newQualificationEvidenceRoot\']).parent)) ...'
# deploy-preflight.py:171
('RUNNING_KERNEL_MATCHES_QUALIFICATION', bool(facts.get('runningKernel')) and facts.get('qualifiedKernel') == facts.get('runningKernel')),
```

而服务启动侧校验的是**本次部署自己的资格目录**里的收据：

```text
# S7-startup-readback.mjs:13
const qualification = "/var/lib/himawari/qualification/__PKT_LABEL__-__PKT_DATE_COMPACT__";
# S7-startup-readback.mjs:106,115
const receiptBytes = qualifiedFile("installation-receipt.json");
assert.equal(receipt.osRelease, release(), "__PKT_LABEL_UPPER___STARTUP_RECEIPT_KERNEL_CHANGED");
```

```text
# sandbox-host-verifier.ts:214
qualification.osRelease !== release() ||
```

问题：预检读的是父目录里所有历史收据中 mtime 最新的一个，服务实际用的是自己那份资格目录的收据。两者可能不同：例如上一次失败/中止的资格验证留下的非空目录、测试资格验证留下的更新收据，都会让预检误拦。并且在 `SERVICE_ACTIVE` 通过时，服务自己的启动检查已经保证“运行内核 = 它自己的收据内核”，所以这个新检查在正常情况下基本只增加误拦风险，不能发现新问题。

建议：改成读取运行中服务实际使用的那份收据（从当前运行版本的 runtime protection/config 指向的目录），或者只比较“上一次成功部署”的资格目录；如果保留“最新收据”的写法，应在文档中明确这个限制并过滤掉失败/中止的目录。

---

**3. `scripts/delivery-mode/deploy-preflight.py:26-40,48,56`：解析器只识别 `$menuentry_id_option` 字面量，不建模 `if` 块，且用子串判断“按保存项启动”**

证据：

```python
'        if line.startswith(("menuentry ", "submenu ")) and line.endswith("{"):\n'
'            words = shlex.split(line[:-1])\n'
'            node = {"title": words[1], "id": words[words.index("$menuentry_id_option") + 1] if "$menuentry_id_option" in words else "", ...}\n'
...
'        elif line.endswith("{"):\n'
'            stack.append(("other", None))\n'
...
'    kernel = resolve(menu(config), target) if target and \'set default="${saved_entry}"\' in config else ""\n'
```

问题：

- 只认 `$menuentry_id_option`，不认字面量 `--id '一些id'`；作者说“按菜单项标识匹配”只对 Ubuntu 生成的 `$menuentry_id_option` 写法成立。
- 只压栈 `{` 块，不压栈 `if ... then`；如果某个 `menuentry/submenu` 写在运行时 `if` 块里，解析器会无条件计入，序号型 `default` 可能整体错位。
- `set default="${saved_entry}"` 只是全文件子串匹配；写在注释里、或后面还有另一个 `set default=...` 覆盖时，仍会通过。

Ubuntu 24.04 默认 `grub.cfg` 的菜单项通常在顶层，因此生产默认布局大概率没事；但这是边界/非默认配置的漏拦或误拦风险，属于推测，未在真实生产 `grub.cfg` 上核实。

建议：按块结构记录顶层菜单项，跟踪 `if/fi` 深度；支持 `--id`；不要只做子串匹配，至少解析出有效的顶层 `set default`。

---

**4. `scripts/delivery-mode/deploy-preflight.py:57`：只检查 `vmlinuz-<版本>`，不检查同版本的 `initrd.img`**

证据：

```python
'    print(kernel if kernel and (pathlib.Path(sys.argv[3]) / ("vmlinuz-" + kernel)).is_file() else "")\n'
```

`/boot/initrd.img-<版本>` 缺失时内核起不来，Ubuntu 的 `initrdfail` 回退可能改用上一个启动项（可能是 147）。作者已在 I-81 里写明“initrdfail 不读”，所以这是已知未覆盖；但既然已经在 `/boot` 里查文件，顺手查 `initrd.img-<版本>` 成本很低，能减少“内核文件在、initrd 不在”的漏拦。

建议：同时要求 `initrd.img-<kernel>` 是文件；或把“initrd 缺失”明确列入 I-81 未覆盖。

---

**5. `scripts/delivery-mode/deploy-preflight.py:207`：`RUNNING_KERNEL_MATCHES_QUALIFICATION` 的提示建议重启/重新资格验证，但没有要求 owner 批准，也没有沿用运行手册里更安全的“一次性 `grub-reboot` + 保留当前内核作为退路”**

证据：

```python
'... boot the kernel the receipt records, or qualify the running kernel first with the sandbox qualification procedure before deploying'
```

运行手册的 Rollback 明确写了更安全的做法：

```text
# docs/runbooks/production-server-access-runbook.md:121-122
2. `grub-set-default` 设为当前内核作为退路，`grub-reboot` 设为已验收内核只用一次，`grub-editenv list` 核对后 `reboot`。
3. 重启后按[结果验证](#verification)检查；正常后再 `grub-set-default` 设为已验收内核。
```

重启/重新资格验证都是不可撤销、影响可用性的操作；同一文件里现有的文档工具提示还专门写了 “with the owner's approval”，这条却没有。

建议：在提示里引用运行手册的 Rollback 流程，明确需要 owner 批准，并说明保留当前内核作为回退。

---

**6. `scripts/delivery-mode/deploy-preflight.py:65,187`：`osRelease` 未经校验直接 `print`，可能通过换行向 facts 注入其他键**

证据：

```python
# READ_QUALIFIED_KERNEL
'    print(json.loads(receipts[-1].read_text()).get("osRelease", "") if receipts else "")\n'
```

```python
# main
facts = dict(line.split('=', 1) for line in child.stdout.splitlines() if '=' in line)
```

如果最新的 `installation-receipt.json` 里的 `osRelease` 含换行（或恶意构造），远程输出会多出若干行；`facts` 解析后，后面的行可以覆盖前面的 `uid`、`hostname`、`runningKernel` 等键。资格目录由 root 创建、收据本应签名，但 `READ_QUALIFIED_KERNEL` **不验证签名**，所以这是“不可信输入”的低概率但真实缺口。

建议：对 `osRelease` 做单行/字符集校验（例如 `^[0-9A-Za-z.+~_-]+$`），或在读取时 `splitlines()` 后只取第一行；更稳妥的是验证收据签名，或只信任服务实际使用的资格目录。

---

### 低

**7. `scripts/delivery-mode/test_deploy.py:234-353`：反向用例存在，但真实布局覆盖不足；`TAG = '[I-81]'` 没有出现在测试方法名里**

已覆盖：`next_entry` 优先、保存项指 147、子菜单/固件、内核文件缺失、序号越界、无 grubenv、收据 mtime/同时间目录名。未覆盖：

- `linuxefi`；
- 单独 `/boot` 分区时的 `/vmlinuz-...`；
- 字面量 `--id`；
- `if` 块里的菜单项；
- `grub.cfg` 缺失/不可读；
- `grub.cfg` 有 `set default="${saved_entry}"` 但后面又被覆盖；
- 真实 Ubuntu `24.04` 的完整 `grub.cfg` 样本。

另外：

```python
# test_deploy.py:234-235
class KernelPreflightTest(unittest.TestCase):
    TAG = '[I-81]'
```

文档 I-81 说“带 `[I-81]` 的用例”，但测试方法名里没有 `[I-81]`，只有一个未使用的类属性 `TAG`。这不影响现有 `check:incident-gates`，但和仓库里其他事故测试的命名习惯不一致。

建议：补上述 fixture/反向用例；把 `[I-81]` 放进测试方法名，或删除无用的 `TAG`。

**8. `docs/incidents-and-gates.md:119` 与 `docs/runbooks/production-server-access-runbook.md:62`：文档与代码基本一致，但运行手册没有提到新增的 GRUB 下次启动检查**

I-81 行写的检查名、文件、反向用例与代码一致；未覆盖项“最新收据按修改时间、同时间按目录名取”也与代码一致。但运行手册的“启动前检查核对的系统状态”仍只列内核版本与收据、bwrap 等，没有说要检查“重启后会进哪个内核”，而这次新增的正是上线前的关键门槛。失败提示和运行手册的 Rollback 建议也不一致（见发现 1、5）。

建议：在运行手册的 Live-State Preflight 或 Safety and Preconditions 里补一句：自动上线检查会读 `grub.cfg`/`grubenv`，要求“下次启动内核 = 运行内核”；修法引用 Rollback 一节。

**9. `scripts/delivery-mode/deploy-preflight.py:56,170`：检查要求 `GRUB_DEFAULT=saved` 的精确字符串，合法的数字默认项也会被拦**

代码只有在 `'set default="${saved_entry}"' in config` 时才解析保存项。生产当前确实是 `GRUB_DEFAULT=saved`（运行手册第 63 行），所以生产正常状态会通过；但这是检查的隐含前提，不是“任意配置下都能算出下次启动内核”。如果以后生产改成数字默认项、且数字确实指向运行内核，会误拦。

建议：在 I-81 或提示里明确“本检查只支持 GRUB_DEFAULT=saved”；需要通用支持时，应解析实际生效的 `set default`，而不是只认 saved 写法。

---

## 推测 / 未核实

- 2026-10-19 生产重启进新内核、停服约 51 小时，以及 Hermes 内核从 185 到 198：只读了作者材料和文档，未读生产/Hermes 机器，**未核实**。
- 2026-11-07 生产 `GRUB_DEFAULT=saved`、`saved_entry` 指向 142：只读了 `docs/runbooks/production-server-access-runbook.md:63` 的文档，未读生产机，**未核实**。
- 真实生产 `grub.cfg` 里是字面量 `$menuentry_id_option`、精确的 `set default="${saved_entry}"`、菜单项在顶层：依据测试和作者材料推断，未读真实文件，**未核实**。
- `grub-set-default` 对“内层子菜单 id”的处理、以及无效 default 时 GRUB 是否回退到第一个菜单项：属 GRUB 行为推断，未执行验证。
- 生产是否存在“失败/测试资格验证留下的非空收据目录”导致发现 2 的误拦状态：未读生产目录，**未核实**。
- 测试未实际运行（工具限制只能读、grep、glob 和指定 git 命令），只做了静态核对。

---

## 侧重检查

- **只读与不可逆操作**：`remote_script` 新增内容只有 `uname`、读取 `grub.cfg`/`grubenv`、`Path.is_file()`，没有写操作；整个 preflight 仍是只读。失败提示会建议 `grub-set-default`、`grub-editenv`、重启、重新资格验证，这些本身没有自动执行，但提示不完整/顺序不安全（发现 1、5）。
- **不可信输入**：`grub.cfg`、`grubenv`、`installation-receipt.json` 都是 root 权限文件；解析器异常全部输出空、判失败，属于 fail-closed。缺口是收据未验签、`osRelease` 未做单行校验，存在低概率 facts 注入（发现 6）；路径来自常量/binding，且用了 `shlex.quote`，未发现 shell 注入。
- **资源耗尽**：只读小文件；`glob("*/installation-receipt.json")` 的规模受资格目录数量限制；外层 SSH 有 60 秒超时；未发现新的资源耗尽路径。
- **错误路径**：缺少 `grub.cfg`/`grubenv`/`vmlinuz`、收据损坏或最新收据损坏，都会得到空答案并判失败；不会放过。错误提示对“解析失败”和“确实会进别的内核”区分不足，一律写 “an unknown kernel”，可能误导排障（见发现 3 的建议）。
- **规则/文档一致性**：I-81 行的检查名、文件引用、反向用例、未覆盖项与代码基本一致；作者关于第一版“看最新已装内核、提示卸载 147”的说法，用 `git show b6e5db33` 核对属实；`b6e5db33..b1217d2c` 确实删掉了 dpkg shell，最终版本读 GRUB。运行手册未更新新增门槛（发现 8），失败提示与运行手册 Rollback 不一致（发现 1、5）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果？**

不会。`git diff f0478c4..b1217d2c` 只改了 `scripts/delivery-mode/deploy-preflight.py`、`scripts/delivery-mode/test_deploy.py` 和 `docs/incidents-and-gates.md`；没有改提示词、工具定义、历史组装、出口遮盖或压缩代码。新增的 `runningKernel`、`nextBootKernel`、`qualifiedKernel` 只出现在上线预检的 SSH 输出、日志和测试里，不进入模型请求。因此发给模型的内容仍然没有在本改动下被追加以外的方式改动，也没有把每轮变化的值塞进系统提示/工具定义。

**2. 同一段文字会不会在不同请求里变成不同的字节？**

对模型请求不会：本改动没有触碰任何模型请求的序列化、遮盖或资料块。对上线预检输出，`qualifiedKernel` 依赖收据的 mtime/目录名，`nextBootKernel` 依赖当时的 grub 状态，确实不是跨时间稳定的；但这些只在部署日志里，不是模型请求内容，也不影响 KV 缓存。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

有。`package.json` 的 `check:delivery-deploy` 运行 `scripts/delivery-mode/test_deploy.py`，`check:steps` 包含它，`test/tooling/run-all-checks.test.mjs` 也把它映射到该文件。新增 `KernelPreflightTest` 覆盖了指定反向用例：保存项指 147、`next_entry` 指 147、grub.cfg 不按保存项启动、指子菜单/固件、内核文件缺失、序号越界、无 grubenv、运行内核/收据为空。静态阅读这些断言，如果移除或反转 `NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL`、`RUNNING_KERNEL_MATCHES_QUALIFICATION`，对应测试会失败；整段远程脚本的引号转义也有一条实际在 `bash` 下跑的用例。受工具限制我没有实际执行测试，且测试覆盖有发现 7 列出的缺口。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

逐个核对结果：

- `runningKernel`：生产者是 `/usr/bin/uname -r`，消费者是两条检查、失败提示和测试。格式与 Node `release()` 在 Linux 上一致，可接受。
- `nextBootKernel`：生产者是 GRUB 解析器，消费者是与 `runningKernel` 严格相等比较和提示。内核版本字符串与 `uname -r` 同格式（都来自 `vmlinuz-*`），正常情况下可接受；但解析器对 `--id`、`if` 块、被覆盖的 default 的假设有缺口（发现 3）。
- `qualifiedKernel`：生产者是最新收据的 `osRelease`，消费者是 `RUNNING_KERNEL_MATCHES_QUALIFICATION` 和提示。`osRelease` 与 `release()` 一致，但预检选的是“mtime 最新收据”，服务实际用的是本次资格目录的收据（发现 2）；而且没有验签、没有单行校验（发现 6）。
- `GRUB_CONFIG`/`GRUB_ENVIRONMENT`/`BOOT_DIRECTORY`：只被 `remote_script` 使用，路径在 Ubuntu 24.04 上存在；没有发现其他消费者需要更新。
- `newQualificationEvidenceRoot`：`release-cleanup.py`、`maintenance-common.mjs` 把它当精确目录用；新代码用它的 `.parent` 做 glob。`bindings.draft.json:118` 和测试的路径格式一致，可接受；但预检同时还要求该目录 `TARGET_PATH_ABSENT`，所以重试时会先被这个检查拦住，这一点和现有 I-56 行为一致。
- 检查名 `NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL`、`RUNNING_KERNEL_MATCHES_QUALIFICATION`：只被 `checks()`、`deploy.sh` 的退出码、测试和 I-81 文档使用，没有发现不一致。
- `I-81`：全仓只有这一行，`check:incident-gates` 的格式/路径要求可满足；门槛里引用的 `scripts/delivery-mode/deploy-preflight.py`、`scripts/delivery-mode/test_deploy.py` 都存在。
- 最需要核对两端的“值”是失败提示让操作者写入的 `saved_entry`：生产需要“父菜单>子菜单项”的完整 id（测试第 246 行），而提示只写“the id of its menu entry”（第 205 行），两端不一致（发现 1）。
