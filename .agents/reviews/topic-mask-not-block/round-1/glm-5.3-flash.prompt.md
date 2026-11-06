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
仓库就是当前目录，已检出 058293d161876f45283f9e168d4bbe89da3fd8cb。
问题、目标和约束：
# 去掉“整段拦下”，改成只遮敏感值（独立出方案的材料）

请读仓库代码、上网查一手资料，独立给出一套能直接动工的方案。不要只复述下面的事实。

## 问题

Himawari 现在有 49 处在“认出敏感信息”后把**整段内容**拦下：
- 整段不发给模型，例如读文件、命令输出、网页结果被整个替换成错误；
- 整段不存，例如记忆候选、提醒、对话检查点被拒；
- 或者整个操作失败，例如文件复制、导出被拒。

这些拦截在 2026-08-26 就有了（提交 `8f3cddb3`）。那时还没有“遮值”能力。2026-11-01 才加上“发给模型前把敏感值换成占位符”的出口遮盖（ADR 0146、ADR 0148；`packages/application/src/services/model-egress.ts`），之后每次发给模型的请求都会把密钥、密码、验证码、银行卡号、证件号换成 `[密钥]`、`[密码#xxxx]` 这类占位符。

## Andy 的决定（2026-11-06）

- 原话：“把‘整段整段拦截’这种一刀切的操作从项目里面去掉，只遮盖那些是敏感字段的部分。”
- 复制、导出文件这类要求字节原样的操作：原话“这些本来就不应该遮啊”。也就是不遮。线程建议它们原样放行，不拦也不遮。
- 线程建议保留、Andy 尚未单独确认的两类：
  - 遮完之后的自检（`model-egress.ts:214`：遮完仍有密钥就不发）和发给模型前的同类检查（`packages/platform-node/src/trusted-model-provider.ts:127`）；
  - 配置文件校验（`packages/platform-node/src/strict-configuration.ts:1183`：不许把密钥直接写进配置文件，密钥应放进钥匙串）。

  请你也判断这两类该不该保留。

## 已核对的事实

- **整段拦下的 49 处**（`origin/main` 上的 `git grep -n -E 'scanMachineSecrets\(|containsToolOutputSecret\(|assertMachineSecretFree\(|containsRestrictedIdentifier\('`，去掉测试和识别包本身）：
  - `apps/agent-service/src/capability-programs/host-file-read.ts`：第 146 行
  - `apps/agent-service/src/capability-programs/pi-coding-request.ts`：第 207 行
  - `apps/agent-service/src/production-coding-workflow.ts`：第 175 行
  - `apps/agent-service/src/production-file-preparation.ts`：第 52,68 行
  - `apps/agent-service/src/production-host-read.ts`：第 77,78 行
  - `apps/agent-service/src/production-memory-capture.ts`：第 281,752 行
  - `apps/agent-service/src/production-memory-control.ts`：第 167,168 行
  - `apps/agent-service/src/production-muse-intake.ts`：第 392,393,457 行
  - `apps/agent-service/src/production-reminder-writer.ts`：第 196,197 行
  - `apps/agent-service/src/production-sandbox-control.ts`：第 831 行
  - `apps/agent-service/src/production-sandbox-services.ts`：第 1962 行
  - `apps/agent-service/src/production-thread-titles.ts`：第 74,94 行
  - `packages/application/src/services/automatic-memory-service.ts`：第 104,278,303,78 行
  - `packages/application/src/services/host-file-read-service.ts`：第 153 行
  - `packages/application/src/services/model-egress.ts`：第 214 行
  - `packages/application/src/services/reflection-service.ts`：第 144 行
  - `packages/application/src/services/thread-checkpoint-service.ts`：第 192,228,235 行
  - `packages/application/src/services/workspace-copy-service.ts`：第 74 行
  - `packages/platform-node/src/deepseek-web-provider.ts`：第 33,77 行
  - `packages/platform-node/src/exa-public-search.ts`：第 121,217,251,320 行
  - `packages/platform-node/src/files/pi-host-publication.ts`：第 139,154,160,161,193 行
  - `packages/platform-node/src/files/pi-output-export.ts`：第 43 行
  - `packages/platform-node/src/files/sandboxed-coding-operations.ts`：第 165 行
  - `packages/platform-node/src/strict-configuration.ts`：第 1183 行
  - `packages/platform-node/src/trusted-model-provider.ts`：第 127 行
  - `packages/platform-node/src/typesafe-jev-transport.ts`：第 295,387 行
  - `packages/runtime-pi/src/host-read-only-executor.ts`：第 143 行
- **识别和遮盖的函数都在 `packages/sensitive-capture`**（ADR 0167），网页端（`apps/control-center`）也引用这个包：
  - `scanMachineSecrets`：只判断有没有机器密钥；
  - `containsToolOutputSecret`：同上，另加私钥边界；
  - `assertMachineSecretFree`：有就抛错；
  - `containsRestrictedIdentifier`：银行卡、证件号一类，在 `identifiers.ts`；
  - `redactForEgress`：遮全部五类，返回遮好的文字；
  - `redactMachineSecrets`：只遮机器密钥；
  - `redactWebContentSecrets`：网页导入用，输出标记不同。
- **出口遮盖**：每次请求都对整段历史（包括工具结果）重新遮一遍，历史里存的是遮盖前的原文（`.claude/rules/prompt-prefix.md` 第 5 条）。
  - 遮盖必须是确定的：同样的内容和密钥，每次遮出同样字节（第 10、11 条）。
  - 已经发给模型的内容不得改动，只能在末尾追加（第 4 条）。
- **发给模型以外的服务**：网页搜索的查询词发给 Exa、DeepSeek 搜索（`packages/platform-node/src/exa-public-search.ts:217`、`packages/platform-node/src/deepseek-web-provider.ts:77`），不经过出口遮盖。
- **TypeSafe 代码审核调用不经过出口遮盖**（`packages/platform-node/src/typesafe-jev-transport.ts`）。
- **“敏感信息拦截记录”**（第 1 步，已上线）：
  - 记录有三种结果：遮住、整段没发给模型、没记进记忆；
  - “整段没发给模型”目前没有接线；
  - 端口在 `packages/application/src/ports/sensitive-interceptions.ts`。
- **另一个线程在做“Himawari 自己写的固定指令不检查”**，即识别时排除我们自己的提示词文字。
- **测试**只能在云服务器或 Hermes 上跑，不在 MacBook 上跑。快速模式的门槛是 `npm run check`，`npm run check:prompt-prefix` 检查请求开头是否只追加。

## 请回答

1. 把 49 处逐个分类：改成遮值、原样放行、保留（自检或配置校验之类），每处写理由。
2. 存进数据库的内容（记忆、提醒、对话检查点、对话标题）：存遮好的文字，还是存原文、发出时再遮？各自的代价是什么？
3. 发给模型以外服务的查询词：怎么遮？遮了会不会让搜索失效？
4. 改完后，记录页面的“整段没发给模型”这一类还要不要？
5. 这个改动会不会改变模型已经见过的请求开头？
6. 怎么测：每一类至少一个正向、一个反向的端到端用例；怎么证明以前被拦下的内容现在只遮了值？
7. 分几个 PR、什么顺序。
