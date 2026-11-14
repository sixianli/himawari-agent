# 复核结果

## 发现

### 1. 低 —— 用例没有证明作者所说的“三个 runner 和共享文件都发出了删除命令”

文件：`test/tooling/ci-runner-scripts.test.mjs:1903-1927`

问题：作者说法 2 称这个用例证明脚本对三个 runner 和共享文件都发出了删除命令，并在什么都不剩时报 `UNINSTALL_OK`。实际断言只覆盖了 gate runner 和 `ghgate.slice`：`test/tooling/ci-runner-scripts.test.mjs:1921-1926`。它没有断言前两个 runner 的 `systemctl disable`/`rm -rf`，也没有断言 `gh-runners.slice`、`gh-runner-nft.service`、`gh-runner-clean.service/timer`、`/etc/sudoers.d/91-gh-runner-control` 的删除。`UNINSTALL_OK` 只能间接证明三次 `userdel` 被调用（因为 `id` 假命令靠 `gone-*` 文件判断账号是否还在），不能证明这些 `rm` 调用。`rm -rf /etc/gh-runner /srv/gh-runner-share` 在另一条用例 `:1552` 有断言，但共享 unit 和 sudoers 仍没有覆盖。

证据（本人读到）：

```js
// test/tooling/ci-runner-scripts.test.mjs:1912-1913
"mount -t tmpfs tmpfs /srv && mount -t tmpfs tmpfs /etc || exit 91",
"mkdir -p /etc/systemd/system /etc/sudoers.d || exit 91",
```

```js
// test/tooling/ci-runner-scripts.test.mjs:1921-1926
expect(result.stderr, result.stderr).not.toContain("UNINSTALL_INCOMPLETE");
expect(calls).toContain("systemctl disable --now gh-runner-gate.service\n");
expect(calls).toContain("userdel gh-runner-gate\n");
expect(calls).toContain("rm -rf /srv/gh-runner-gate\n");
expect(calls).toMatch(/^rm -f .*\/etc\/systemd\/system\/ghgate\.slice/m);
expect(result.stdout).toContain("UNINSTALL_OK removed: ci-vps-1 ci-vps-2 ci-vps-gate;");
```

```sh
# scripts/operations/ci-runner/uninstall-runner.sh:25-28,36-39
rm -f "/etc/systemd/system/$RUNNER_UNIT"
rm -rf "$RUNNER_ROOT"
...
rm -f $SHARED_UNITS
rm -f /etc/sudoers.d/91-gh-runner-control
rm -rf /etc/gh-runner "$RUNNER_SHARE_ROOT"
```

由于 `/etc` 和 `/srv` 现在是空 tmpfs，且 `rm` 是只记录调用的假命令（`:1895-1896`），脚本即使漏删这些路径，用例也不会失败。删除命令的覆盖因此变弱。

建议：不要只挂空 tmpfs。可以在 tmpfs 里先建出三类 sentinel（三个 runner 的 unit/root、每个共享 unit、sudoers、`/etc/gh-runner`、`/srv/gh-runner-share`），再断言 `calls` 包含每个路径的 `systemctl`/`rm`/`userdel`/`groupdel` 调用；或者让 `rm` 在 tmpfs 内真实执行，最后断言这些路径都不存在。这样既隔离宿主，又保留“确实删了”的证明。

### 2. 信息（不是本轮引入的缺陷）—— 清单里仍有 `aggregate.mjs` 的 linux-x64 写死

文件：`scripts/ci/aggregate.mjs:201`

读代码证实：`const platform = "linux-x64";` 被 `scripts/platform-assumptions.json` 记为合法。它当前与 `ci/policy.json` 一致（`browser`、`coverage` 的 member 都是 linux/x64），所以不是本轮改动造成的错误；但如果以后让 `browser`/`coverage` 跑在 ARM 上，这里会选错消费平台，而清单不会提示。清单的这次新增项本身没有把不该保留的写死项夹带进来（见必答问题 4）。

---

## 侧重检查

- **`uninstall-runner.sh all` 对真实 `/etc` 的依赖（读代码证实）**：脚本的 `all` 路径调用的外部命令是 `hostname`、`id`、`systemctl`、`pkill`、`rm`、`getent`、`nft`、`userdel`、`groupdel`。用例 `box3()` 在 `:1894-1899` 全部伪造了它们，`id` 在 `:1905-1908` 伪造；此外只用了 shell 内建的 `command -v`、`[`、`echo`。因此空 `/etc` 不会让 NSS、`/etc/passwd`、`/etc/group` 参与判断。`mount`/`mkdir`/`bash` 不依赖 `/etc` 的内容；`mount -t tmpfs tmpfs /etc` 执行时 `/etc` 还在，动态加载器只在之后执行 `mkdir`/`bash` 时用到。未发现脚本的 `all` 路径依赖真实 `/etc` 文件。
- **假命令覆盖范围（读代码证实）**：`all` 分支没有调用 `apply_runner_controls`，所以不会用到 `mktemp`、`cat`、`visudo`、`install`、`ss`；用到的外部命令如上，均已伪造。覆盖是完整的。
- **反向路径（读代码证实）**：`mount` 失败会 `exit 91`，`status` 断言会失败；账号没删干净时 fake `id` 会返回成功，最后由 `UNINSTALL_INCOMPLETE` 触发失败。所以“账号残留”的反向用例仍有效。但“某个共享路径没删”的反向用例不再有效，见发现 1。
- **只删第二个 runner 的用例（读代码证实）**：`:1569-1573` 仍然只挂 `/srv`、`/etc/systemd/system`、`/etc/gh-runner`，但 `2` 分支不检查 `/etc/gh-runner` 是否存在；它只检查 `/etc/systemd/system/gh-runner-2.service` 和 `/srv/gh-runner-2`，两者都在 tmpfs 里。`/etc/gh-runner` 被挂空后 `runner_blocked_ports` 读不到真实 `nft.rules`。因此在 CI 机上不会因“目录本身还在”而失败。隐含风险：如果以后 `2` 分支开始检查 `/etc/gh-runner`，同样的假失败会回来，建议与 `all` 用例统一用整块 `/etc` tmpfs。
- **安全与不可逆操作（读代码证实）**：`asRootInPrivateMounts` 用 bwrap（`:23-37`），挂载发生在 bwrap 的私有挂载空间；宿主机的 `/etc` 不会被替换。用例只创建空 tmpfs 和两个空目录，没有写敏感数据。
- **资源耗尽（读代码证实）**：tmpfs 没有大小上限，但用例只 `mkdir` 两个目录，未向 tmpfs 写数据；风险可忽略。
- **不可信输入（读代码证实）**：`readInventory` 校验 JSON 必须是“类别 → 文件 → 正整数”的对象（`scripts/check-platform-assumptions.mjs:143-150`），未知类别由 `comparePlatformAssumptions` 报 `unknown`（`:111-113`）；`--root` 参数也有校验（`:200-202`）。未发现新的注入面。
- **规则/文档与代码一致性（读代码证实）**：ADR 0253 第 63 行要求“次数多了失败、少了也失败”，`comparePlatformAssumptions` 的 `added`/`stale` 分支（`:107-108`）与此一致；作者说法 1、3、5 与代码一致；说法 2 不完整，见发现 1。

推测（未证实）：
- 动态加载器在缺少 `/etc/ld.so.cache` 时一般会回退到编译期默认库目录，所以在常见发行版上 `bash`/`mkdir` 仍能启动；如果某发行版把库只登记在 cache 且默认路径不含库目录，这个用例可能在那种机器上失败。本环境不能运行，未实测。
- `/srv` 不存在时新用的无条件 `mount -t tmpfs tmpfs /srv` 会 `exit 91`；不过同文件更早的用例（`:1328`）本来就无条件挂 `/srv`，所以不是本轮新增的环境要求。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。`7c1937..f370` 的改动只有 `scripts/platform-assumptions.json`、`scripts/ci/*`、测试、以及合并 main 带来的能力资格/ADR 内容；`git diff --name-status` 中没有 prompt 组装、工具定义、历史序列化或遮盖相关文件。按 `.claude/rules/prompt-prefix.md:35` 的只追加要求，本次没有任何请求内容被改写、重排或删除，也没有把每轮变化的值放进系统提示/工具定义。未运行 `check:prompt-prefix`（工具限制），但改动范围内没有可影响它的代码。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会。改动没有触碰发送给模型的内容；`platform-assumptions.json` 的生成按固定类别顺序和 `files.sort()` 排序（`check-platform-assumptions.mjs:88-95`），且它不进入请求。没有引入时间字段、无序集合或依赖后文的遮盖。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   - 平台清单有 `npm run check:platform-assumptions`（`package.json:63`，并挂在 `check:steps` 里）；`test/tooling/platform-assumptions.test.mjs:84-135` 覆盖了新增、变少、未知类别、缺失/非法清单，并且用 `comparePlatformAssumptions` 的返回值断言会报错，反向用例是真实的。
   - 本轮 CI 用例改动本身就是测试；账号残留的反向用例在 `:1538-1552` 仍有效，但“共享路径没删”没有确定性的反向用例，`all` 用例改成空 tmpfs 后更无法发现这类回归（见发现 1）。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   逐个核对如下（读代码证实）：
   - `scripts/platform-assumptions.json` 只被 `check-platform-assumptions.mjs` 和对应测试消费；新计数是正整数，形状通过 `readInventory` 校验。本轮变化的计数与文件内容一致：
     - `scripts/ci/platforms.mjs`：`linux-x64` 3 处（第 3、11 行），清单 3；
     - `scripts/ci/install-tools.mjs`：`linux-x64` 2 处（第 92、93 行）、`x86_64` 2 处（第 95、98 行）、`amd64` 1 处（第 96 行），清单 2/2/1；
     - `test/tooling/toolchain-platforms.test.mjs`：`linux-x64` 16 处、`x86_64` 1 处，清单 16/1。
     被删掉的 `scripts/ci/browser.mjs`、`build.mjs`、`local.mjs`、`run.mjs`、`test.mjs` 中已搜索不到对应字面量；`browser.mjs:129-131` 改为用 `artifactPlatformKey(...)`，`local.mjs:40` 用 `buildPlatformKey()`。没有发现“清单写合法、文件其实还有”的错位（本环境是稀疏检出，无法重跑扫描核对全部 397 处，只核对了本轮变化项）。
   - 用例里的新路径 `/srv`、`/etc`、`/etc/systemd/system`、`/etc/sudoers.d` 被 `uninstall-runner.sh`/`runners.sh` 按普通绝对路径使用，没有额外校验拒绝它们；假命令也接受这些参数。
   - `expect(result.stderr, result.stderr)` 的第二参数是 Vitest 的自定义失败信息，消费者接受。
   - 未发现清单项里新增了不该保留的写死 x86；`aggregate.mjs:201` 是 main 已有的项，当前与 CI policy 一致。

5. **会不会改变模型已经见过的请求开头？**
   同第 1 条：不会。本 PR 不碰发给模型的内容；本轮两处改动（平台清单重写、CI 用例隔离）都在 CI/测试侧。

---

## 结论

没有发现会改动运行时行为或模型请求的高严重度问题。唯一值得修改的是发现 1：`all` 用例在空 tmpfs + 假 `rm` 的组合下，实际只证明了 gate runner 的部分删除调用和 `UNINSTALL_OK`，没有证明前两个 runner 的 `systemctl`/`rm` 以及其余共享文件、sudoers 的删除；作者说法 2 对此有夸大。建议补 sentinel 和完整调用断言。其余核对项（`/etc` 依赖、假命令覆盖、第二个 runner 用例的 CI 稳定性、平台清单计数、请求前缀）均未发现问题。
