你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 9470f9a6be50503385237c3712b1b72f58cfdab5。
问题、目标和约束：
# 问题：CI 彻底不再使用 GitHub Actions 产物（artifact）

## 问题
仓库 sixianli/himawari-agent 是私有仓库，免费账号。CI 跑在 Andy 租的 CI 服务器（OVH VPS，自托管 runner ci-vps-1、ci-vps-2，同一台机器）上。作业之间传报告和构建已经改为放在 CI 服务器本机共享目录 /srv/gh-runner-share（ADR 0238，scripts/ci/run-share.mjs，按 runId-attempt 分目录，每小时清理 6 小时前的目录）。

但 GitHub 上仍有这些产物上传/下载：
- .github/workflows/ci.yml：六个检查作业各有一个“保留失败诊断”上传（.ci-output/public/diagnostics/，保留 1 天）；汇总作业 ci/required 上传 gate-<runId>-<attempt>（.ci-output/gate/，保留 1 天）。
- .github/workflows/main.yml：main/evidence 作业用 scripts/ci/main-evidence.mjs discover 找到已合并 PR 的成功运行和它的 gate 产物，再用 actions/download-artifact 下载、verify 核对 gate 内容（context、testedCommit、policy、toolchain），然后上传 main-evidence-<runId>；confirm 作业下载这个 main-evidence 产物，跑 scripts/ci/main-confirm.mjs，再上传 main-confirmation 报告。
- .github/workflows/quality.yml：只能手动触发，有十几个上传/下载。
- scripts/ci/check-policy.mjs 规定了这些上传的路径和保留天数。

## 已核对的事实
- 2026-11-12 07:13 JST（22:13Z）ci/required 的 gate 上传仍报 “Artifact storage quota has been hit”。旧产物 4.2 GB 已于约 9 小时前删除。
- GitHub 官方计费页（https://docs.github.com/en/billing/concepts/product-billing/github-actions）：免费账号产物存储 500 MB，与 Packages 共享；“Storage charges accrue every hour based on your actual usage throughout the month”；“your accrued storage charges reset to zero at the start of each billing cycle”；没有付款方式时 “usage is blocked once you use up your quota”。所以本账单周期内上传一直被拦。
- GitHub 官方计费文档：“Logs and job summaries do not count towards storage usage.”（日志和作业摘要不算存储）
- 规则：Andy 绝不在 GitHub 上花钱（不开付费、不设预算）。合并前 PR 最新提交上的 ci/required 必须成功（ADR 0241，PR 409 即将合并）。
- main.yml 的作业都 runs-on: ci-vps，和 PR 的作业在同一台机器上，能读到共享目录。
- main-evidence.mjs discoverEvidence 已经通过 API 要求 PR 运行 conclusion==success 且 24 小时内；之后还要求 gate 产物存在并核对其内容。

## 目标
1. 所有工作流不再上传或下载 GitHub 产物，CI 在额度被拦时也能变绿。
2. main 合并后的轻量确认（只在 PR 已经全绿时走轻量路径）保留同等可信度：能证明 PR 运行确实是对同一个提交、同一套 policy/工具链跑出的成功结论。
3. 失败时人和代理仍能看到诊断（不用登录 CI 服务器）。
4. 用自动检查（check-policy 硬规则 + 反向测试）防止以后又有人加回产物上传。
5. 不花钱，不另租机器。

## 约束
- 不写代码注释；改 docs/ 要走文档治理；新 ADR 号用 0242。
- 共享目录磁盘有限（单轮约 300 MB，作业前要求 16 GiB 空闲）。
- CI 服务器上的文件 Andy 和代理看不到（只有 Andy 能 ssh）。

请出你的方案：要改哪些文件、gate 结论放哪里、保存多久、main 确认怎么证明、诊断怎么给人看、怎么防回归、有什么风险。
