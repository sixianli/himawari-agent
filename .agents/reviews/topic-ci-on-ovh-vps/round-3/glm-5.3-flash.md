检查确认了 `check-policy.mjs:53-83` 的升级函数、`check-policy.mjs:209` 的标签写死、`resolvePolicySource`（check-policy.mjs:965-1027）的升级链与 `policySha256` 按 `bytes` 计算。接下来核对 main-workflow、quality-policy、runner 脚本里的写死值。
main-workflow.mjs:48 确认写死 `hermes-home`（main-workflow.mjs:48），`runners.sh:9,16,71` 确认 runner 名和 sudoers 用户写死。继续读 quality 相关和其余写死处。
quality-policy.mjs:119,170 也写死了 `ubuntu-24.04`。继续找必答问题引用的规则与事故文件、以及其余文档。
规则文件 `.claude/rules/prompt-prefix.md` 与 I-73 已确认存在并读到要点。下面核对 runner 安装/注册/恢复脚本里的写死名字和主机检查，以及 Runbook 的 bwrap 一节。
Runbook 484-619 的 bwrap/AppArmor 做法与方案说法一致。继续看暂停/恢复脚本与测试里的名字写死。
现有 `policy.test.mjs:675-741` 已证实「整份升级/混写拒绝/超时不符拒绝」的测试模式。继续核对 install-dependencies、check-srt-boundary、package.json 的 check 步骤与相关 ADR/文档。
`npm run check`（package.json:27）确实包含 `check:ci-policy`（package.json:76），且不含 `check:srt-boundary`（package.json:37）——方案这两条说法与代码一致。找剩下两个文档引用。
发现方案引用的 `delivery-mode.md`、`test-trigger-timing.md` 在 `.agents/instructions/` 下。读这三份指令文档。
再抽查两处：暂停脚本与测试的覆盖范围（侧重检查），及 job-started.sh 的磁盘底线。
代码侧已基本读齐。补四条一手来源核对外部事实（rootless docker、playwright install-deps、cloud-init preserve_hostname、GitHub runner 标签调度）。
核心事实已核齐。最后查一下引用 ADR 0160/0171/0173 的文档面，作为文档一致性检查的输入。
# 审核报告：CI 从 Hermes 搬到 OVH VPS

已读：`check-policy.mjs`、`main-workflow.mjs`、`quality-policy.mjs`、三个工作流、`ci/policy.json`+schema、`scripts/operations/hermes-runner/*`、`test/tooling/policy.test.mjs`、`test/tooling/hermes-runner-scripts.test.mjs`、安装 Runbook 484–619、`.agents/instructions/` 三份、ADR 0160/0168/0169/0171/0173、package.json；一手来源核对 rootless Docker、Playwright、cloud-init、GitHub runner 标签。

## 侧重检查（走的流程与结论）

普通流程：PR 推送 → `ci.yml` policy job（checkout→install-tools→install-dependencies→run.mjs→publish→工件）→ build/test/browser/node-floor/coverage/security → `required` 汇总。
- 有覆盖：工作流结构、动作锁定、策略-工作流一致性由 `check:ci-policy`（package.json:76，属于 `npm run check`）逐 job 校验；暂停/恢复、job-started、slice 的脚本逻辑有 `test/tooling/hermes-runner-scripts.test.mjs`（用 fake box 全流程仿真，测试文件 1–80、160–540 覆盖对账、标签、超时）。
- 无测试覆盖、只能靠一次性验收的路径：VPS 准备脚本整体（root、幂等性、重启后不复发）、hostname/cloud-init 持久化、AppArmor+bwrap 在 runner 账号下真实可用（`check:srt-boundary` 不在 `npm run check`，package.json:27 vs 37，方案说法属实）、quality.yml 的 Docker 隔离两套方案（都未验证过）、runner 账号的 nft/sudoers 实际生效。方案第四节已安排验收，建议把「准备脚本连跑两次无差异」和「VPS 重启后主机名不变」加入验收清单。

## 证实的（按严重度从高到低）

**【中】1. runner 账号层的位置在共享母机上，方案只按 22 GB 算自身配额**（推测，标注）
方案写「VPS 是共享物理机」（第八节），却按整机 22 GB 设 `MemoryHigh=19G/20G`。共享母机下容器/vTPU 的真实内存往往不是 22 GiB，两个 runner 各 `MemoryMax=15G` 相加 30G 超过整机 2 倍，`gh-runners.slice` 的 `MemoryMax=20G` 对共享 cgroup 父级的约束意义存疑（systemd 对非独立父级的 `MemoryMax` 语义 vs 同级组都不透明）。改法：先在 VPS 上读 `systemd-cgtop`/`cat /proc/meminfo` 确认真实可用内存，再定 19G/20G；并把「1.4 GiB 留给 ssh」的算法（hermes-runbook.md:64 对 Hermes 的写法）对新主机重做一遍。

**【中】2. `quality-policy.mjs` 里写死的不止 docker socket，还有 `runs-on`**
quality-policy.mjs:119、170 两处把每个 quality job 的 `"runs-on"` 写死为 `"ubuntu-24.04"`（这是 GitHub 托管 runner 标签，与通用 OS 标签同名冲突风险最大的一处）。方案第五节只点了 brands 和 `unix:///var/run/docker.sock`（quality-policy.mjs:24），没提这两行。若只改方案五里点到的两处，第二个 PR 合并后 quality 会继续投给镜像库的 GitHub 托管 runner（计费/未封锁流量）。改法：把 `runs-on` 改成新 labell（第三账号方案）列进第五节。

**【中】3. 暂停/恢复对账写死了 GitHub runner 名与标签，方案开关改名但没把这两个值列入清单**
- runners.sh:9,16 `RUNNER_NAME=hermes-home / hermes-home-2`（注册名与单元模板共同来源，register-runner.sh:29 `--labels hermes-home`）。
- mac-runners.sh:2 `LABEL=hermes-home`。
- test/tooling/hermes-runner-scripts.test.mjs:206-216（`[11,"hermes-home"]`、`hermesNames`、`labels`）。
方案二节只给了 workflow/policy/schema/check 的清单，三节只说 sudoers 用户、目录、单元名。改名 `ci-vps-1/2` 后，如果这四个文件不同步，暂停/恢复的对账会打出 `RUNNER_PAUSE_FAILED GitHub has 0 runners named hermes-home-2` 并拒绝执行（hermes-runner-scripts.test.mjs:354 的既有行为）。**注意与首跑顺序交互**：先注册 `ci-vps-1/2` 后改名清单若漏，所有暂停/恢复不工作，但 CI 本身照常——失败会拖到有人需要暂停时才暴露。改法：那份「写死处清单」应同时含 GitHub 标签、GitHub runner 名、sudoers 用户、挂载目录等 4 类值，每类给出全部出现位置；测试文件 `hermes-runner-scripts.test.mjs` 的名量/标签量也必须一起改（方案已提改名，但没点名这几行）。

**【低】4. 文档一致性：三个点名位置的漏改**
方案对文档只写了「delivery-mode.md:27、test-trigger-timing.md:17、runbook、test-and-production-hosts.md」。核对发现 CI 位置还写在 AGENTS.md:7（「CI 按 ADR 0160 在 Hermes 上的自托管 runner 里运行」）、ADR 0160 的正文与链改关系（0168/0169/0171/0173 都是 `amends: 0160`，ADR 0168:7、0169:7、0171:7）。工程实践里 supersede 一份广泛被引用的 ADR 必须同时改 `docs/adr/0092`（superseded_by 指向 0160）与 `docs/adr/0170`。改法：补上 AGENTS.md:7、0092、0170 三处；adrs 的 `amends` 链要重排而不是原地写「取代」，否则语义断。新她那里 ADR 编号应沿用 `check:adr-numbers` 检查（package.json:33），落 PR 前本地跑一次。

**【低】5. 首次跑失败的兜底里，「混写被拒」是正确行为但会连累合并闸门**
updateRunnerLabel 的条件设计（整份旧时升级、混写交 schema 拒）与既有 `upgradeHostedRunnerPolicy` 的先例一致（check-policy.mjs:53-83，测试 policy.test.mjs:712-741 同模式）， estudi反向用例模式是现成的，可照搬。但混写被拒的故障面是整个 `npm run check:ci-policy` 变红，也就是闸门本身失效——这时 PR 无法过闸，修起来又要动 `ci/policy.json`，在 VPS 还没通时闭环很偠（第八节的「不把标签改回」原则正确）。改法：第一个 PR 合并时即使被拒，复杂情况应立 PR 的理由（可机器改）；建议把「混写」的失败信石暴露成 `UPGRADE_RUNNER_LABEL_REJECTEDmixed-hermes-home` 这样可 grep 的错误信息，便于 AI/人接手时定位。

## 推测/未核实（我查不到的）

- VPS 内存 22 GB、cloud-init `preserve_hostname: false`、AppArmor 限制已置 1、盘大小与随机读性能：均为 VPS 现场事实，无法在此环境验证。对应缓解（`preserve_hostname: true` 防改回）与 cloud-init 文档一致：`preserve_hostname` 置真后 cc_set_hostname/cc_update_hostname 均不动 hostname（https://docs.cloud-init.io/en/19.4/topics/modules.html ，https://docs.cloud-init.io/en/latest/_sources/reference/yaml_examples/update_hostname.rst.txt）。
- brands 走 root 预装+官方 apt 源：与 Playwright 官方「Chrome/Edge 按默认不装、Playwright 的 `PLAYWRIGHT_BROWSERS_PATH` 不影响 branded 浏览器位置」（https://playwright.dev/docs/browsers）一致，预装+启动前检查的路子是成熟做法；版本不锁定（跟随 apt 更新）与现状一致，不是回归。
- `member.node` 等工具链一致性校验（check-policy.mjs:1039-1044）不涉及 runner，方案不动 node 版本，无该处风险。

## 我的方案差异（我会怎么改）

1. 保留本方案骨架（分两步、改名 `ci-vps`、升级函数复用 hosted 升级的先例、rootless Docker 优先于 docker 组——rootless 是官方推荐「以非 root 跑 daemon 以缓解 runtime 漏洞」的隔离方式，https://docs.docker.com/engine/security/rootless/ ；docker 组等价于主机 root 的通行证，在跑不可信 PR 代码的机器上尤其值得避开）。
2. 两处编辑：把第二节「写死处清单」扩成四类值全列出（GitHub 标签≈runners.sh/测试、runner 名、sudoers 用户、文档链）——避免第一笔账漏 item 后在紧急回退时才踩到。
3. 第一节删掉「预期内存增速」的数字，改成「落机先实测可用内存再定额度」，避免把 Herms 经验直接平移到共享母机。
4. 第三个 PR 之外，把 `upgradeHostedRunnerPolicy` 的「目标标签同时改成 ci-vps」从「第一 PR 顺带」提升为显式测试：混写校验（check-policy.mjs:209 的平台断言与 schema enum）两类测试要分开写，防止未来的「补一刀」改动只改了 209 漏了 70（或相反），这是该文件里天然的"两处常改一处忘"。
5. 加一条临时自检：`workflow_dispatch` 带 `base_sha` 烟测已支持（ci.yml:15-20），建议在 VPS 注册后、开第一 PR 前手动 dispatch 一次 dry-run，避免 GitHub「标签不匹配任务排到 24 小时失败」平台行为（https://docs.github.com/en/enterprise-server@3.13/actions/how-tos/hosting-your-own-runners/managing-self-hosted-runners/using-self-hosted-runners-in-a-workflow ）带来的首踩。

## 必答问题

1. **不涉及。** 本方案全部改动在 CI 基础设施（工作流 triggers/runs-on、策略升级函数、runner 运维脚本、文档），不触碰系统提示、工具定义、历史消息、遮盖或任何发给模型的内容；`check:prompt-prefix` 检查链（packages/runtime-pi/test/prompt-prefix.compat.test.ts）原样保留。规则（.claude/rules/prompt-prefix.md, AGENTS.md:40-43）未受扰动。这是运维面改动，不构成 prompt 改动。
2. **不涉及。** 无遮盖逻辑与敏感处理改动；新增动态值（VPS IP、runner 名、内存额度）只在 CI/运维面，不进入模型请求。v2 上没有依赖上下文的序列化改动可核（writer 面 I-73 是同型问题——清单 id 与后端校验的断连——本方案里最接近的、已核实的对照是 `ci-vps` 值在 check-policy.mjs:62,70,209 与 main-workflow.mjs:48、schema、工作流三方的三方一致， reviewed ok）。
3. **有自动检查，反向用例会失败。** `check:ci-policy`（package.json:76）已在校验链里会拉出残留 hermes-home（check-policy.mjs:209 的平台断言会拒非 `macos-15`/新标签的写法；main-workflow.mjs:48 拒 main.yml 的残留）。新增升级函数的测试模式与现有先例一致（policy.test.mjs:697,711-741 已有「整份照搬/混写拒/时限不符拒」三种反向，可直接沿用模板），「升级后过校验」的正向在改动前必失败。清单：三份 workflow 文件无 hermes-home 的扫描测试也应新增（或扩进 `check:ci-policy`），反向（塞回 hermes-home）失败——目前方案只会在 CI 的 coverage 桶里跑（policy.json:148 `tooling`），建议也挂进 `npm run check` 的一次性验证里而非只 trust CI。
4. **逐值核对结果：**
   - `ci-vps` 标签：8 处一致（ci.yml 6 处、main.yml 2 处、actionlint.yaml:3、policy.json enum、schema:64、check-policy.mjs:62/70/209、main-workflow.mjs:48、mac-runners.sh:2/runners-register/register-runner.sh:29 对账层）——改法指向正确，但 GitHub 端 runner 实际标签要等注册才产生，注册前 tag mismatch 会静默排队（见上面第 5 点）。
   - `ci-vps-1/2` runner 名：产生上端 register-runner.sh/runners.sh:9,16；消费端 pause/resume 对账 mac-runners.sh + 测试：**方案未列成品属性（见证实点 3）**。
   - `preserve_hostname: true` + hostname `ci-vps`：消费端 install-runner.sh:16、register-runner.sh:8、uninstall-runner.sh:8 的主机名守卫——与 cloud-init 文档语义一致，测试文件里 hostname 断言要同步。
   - sudoers 用户 `ubuntu`：产生端 runners.sh:71 的 `runner_sudoers_line` 一处产生统一行，消费端 only systemd-generated 的 sudoers 生成逻辑内部一致；注意 mac-runners 对 `andy` 这名如何行使（只通过远端 runner 脚本，不依赖 sudoers 操作）——无明显断点。
   - 内存 19G/20G/15G/14G：产生端 gh-runners.slice 服务模板（gh-runners.slice 文件），消费端 systemd——**共享母机的前置未核实（见证实点 1）**。
   - quality 的 socket 可配置：产生端/消费端与 `CONTAINER_RUNTIME` env（quality-policy.mjs:22-25）一致，可配置化是对「禁死 unix socket」这个既有事实的最小破坏。
   - `upgradeHostedRunnerPolicy` 目标标签也改 ci-vps（方案二最后一句）：与 check-policy.mjs:70、resolvePolicySource:993 的链序（hosted→artifact→[新 runnerLabel]→validate）十分一致，`allowLegacyCoverage/allowLegacyIntegration` 的老基线行为不受影响（check-policy.mjs:995-997 只是放宽 meta 校验，与 runner 无关）——准。

---

简短结论：方案主体可执行，方向正确（分步、升级函数沿用先例、rootless 优先），但**「写死处清单」必须扩成四类值**（第 3 点是它会拖到紧急时刻才爆的），**共享母机内存要走实测**（第 1 点），且两处文档链（AGENTS.md:7、ADR amends 链）要进 PR 范围（第 4 点）。
