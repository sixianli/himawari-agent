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
仓库就是当前目录，已检出 2995d5359933f8a57e974c61a2de9c9eb5e5d469。
问题、目标和约束：
# 问题
自托管 CI runner（OVH VPS，Ubuntu 24.04，两个 runner，各有独立目录且互相看不到，每个 runner 一个无 sudo 的系统账号，systemd 加固，只能写自己的 runner、home、logs 目录）里，每个 CI 任务都从 github.com 下载锁定版本的工具（node、npm、CPython、actionlint、gitleaks、semgrep wheels 等，摘要写在 ci/toolchain-lock.json），以及测试 test/tooling/review-gateway.test.mjs 里还会下载真的 Magpie 程序（摘要写在 scripts/model-review/gateway-lock.json）。2026-11-08 GitHub 返回 HTTP 504 持续几十分钟，下载只重试 3 次（间隔 10~20 秒；Magpie 用 curl --retry 2），任务失败，ci/required 变红，合并被卡住。重跑时 504 仍在。

# 目标
CI 不再因 github.com 的 504 整批失败；不降低“固定版本、摘要不符不使用”的供应链保证。

# 约束
- 不能把 GitHub token 放到 VPS；不杀 runner 进程；不放宽任何测试超时；不用 GitHub 的 actions/cache（Andy 为省钱已删，见 docs/adr/0174-no-github-cache-and-one-day-artifacts.md）。
- 测试不许用假替身替代真程序（review-gateway 的 6 个用例要启动真的 Magpie）。
- 要写出缓存怎样清理和失效、磁盘占用、怎样保证摘要不符不使用（含反向用例）。
- 方案要有业界做法和一手来源。

# 已核对的事实
- scripts/ci/install-tools.mjs：downloadAttempts=3（:260），等待 10~20 秒（:262-264），下载物写进任务工作区 .ci-output/tools/downloads（ci.yml:49），任务结束 job-completed.sh:13 把整个工作区删掉；已有“文件存在就校验摘要再复用”（:302-305），但只在同一工作区内；写入用 writeFileSync wx（:308），非原子。
- scripts/model-review/gateway.mjs：安装目录 join(homedir(), ".cache", ...)（:205-206），curl --retry 2（:210）；测试运行的 HOME 在工作区内（scripts/ci/run.mjs:135 的 isolatedEnvironment，install-tools.mjs:313-317），推断每个任务都重新下载（未在 VPS 实测）。
- runner 服务可写路径：runner、home、logs（scripts/operations/ci-runner/gh-runner.service.in:34）；每日清理 clean-old.sh:21 会删三天没变的 _work 下一级目录。
- 现在 github.com 的发布文件地址仍返回 504；nodejs.org、registry.npmjs.org 正常。
# 说明
下面没有给你任何方案，请从问题本身出发，提出你认为最好的方案，不要局限于你以为的常见做法。
