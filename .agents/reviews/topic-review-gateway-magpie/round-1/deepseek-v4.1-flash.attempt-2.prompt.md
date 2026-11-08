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
仓库就是当前目录，已检出 5cedac651d45dda582b8ce0a201b8826e11ec8e0。
问题、目标和约束：
# 问题：方案讨论和代码复核的模型调用，改为经 Magpie 路由

## 背景

本仓库在写代码前做方案讨论、合并前做代码复核，都用 `scripts/model-review/opencode-review.mjs` 启动 OpenCode 1.19.5，让 `opencode-go/deepseek-v4.1-flash` 和 `opencode-go/glm-5.3-flash` 只读地审代码（规则见 `.agents/instructions/model-review.md`）。脚本现在把服务方写死为 OpenCode Go（`scripts/model-review/opencode-review.mjs:24`、`:96` 的 `provider: { "opencode-go": ... }`），费用上限按 OpenCode 每步报的美元费用算（每个模型一次运行 0.2 美元，见同文件 `COST_LIMIT_PER_MODEL_USD` 和 `scripts/model-review/spend-guard.mjs`）。

Andy 的 OpenCode Go 套餐（每月 10 美元）额度快用完了。他还有一个腾讯 CodeBuddy 国际版（WorkBuddy AI，`www.workbuddy.ai`）免费账号，里面有同样的两个模型。

## Andy 的目标（原话整理）

1. 复核时，Claude Code（云端线程）只关心“用哪个模型、什么推理强度”；OpenCode 也只关心这两样，不关心背后是哪家服务方。
2. 在 OpenCode 和服务方之间放一层 Magpie 路由。Magpie 里登记 Andy 现有的服务方（CodeBuddy 国际版、OpenCode Go，以后可能更多），账号套餐和 API 密钥都能接。
3. Magpie 和 OpenCode 都跑在 Claude Code 云端线程自己的容器里，不连 Andy 的云服务器 `84.247.157.41`（那台机器上的 Magpie 是生产 Himawari 在用的）。
4. CodeBuddy 剩余积分低于 20 时不再给复核用，留给生产 Himawari（两者用同一个账号）。
5. 凭证选择：CodeBuddy 的登录凭证已经存进云端环境的网络密钥，由出口代理代填，容器里不放真凭证。
6. OpenCode Go 额度用完之前，复核继续按现在的方式用 Go；新方案做好、Andy 同意后再切。

## 约束

- 改的是复核机制本身，规则在 `.agents/instructions/model-review.md`；现有的只读限制（git 替身、受限 bash、禁止写文件、禁止联网的代码复核）、费用先问线（代码复核 1 美元、方案讨论 0.5 美元）、`usage.jsonl` 账本、开跑前自检都不能被削弱。
- 发给模型的内容只追加、同一对话送到同一个服务方（`.claude/rules/prompt-prefix.md` 第 4、9 条）。
- 不写代码注释；新增行为要有测试（项目规则）。
- 不得调用 Claude、OpenAI 这类贵模型（`.claude/rules/owner-standing-rules.md`）。
- 云端容器用完就删。

## 已核实的事实（2026-11-07 在云端容器里实测）

1. 云端环境官方说明：不能替换基础镜像；启动脚本（setup script）跑完会被拍成文件系统快照，约 7 天或改脚本、改网络设置时重建；快照不保存正在运行的程序；网络密钥由出口代理在请求离开容器后补上，启动脚本发出的请求拿不到网络密钥；可以用 `docker compose` 在旁边跑自己的镜像。来源：https://code.claude.com/docs/en/cloud-environments （“Replacing the base image entirely isn't supported yet”“Anthropic snapshots the filesystem and reuses that snapshot”“Setup script requests: Claude Code connects to the agent proxy when it launches, after the setup script has run”）。
2. Magpie（https://github.com/yetone/magpie ，`docs/reference.md`）有纯命令行版本，`magpie serve` 只跑网关，监听 `127.0.0.1:3425`，对外是 OpenAI 兼容接口；路由组 `magpie group add <名> models=a,b routing=order` 按顺序用第一个，失败（429、5xx、连不上）就换下一个；`stays=` 控制同一对话固定在同一个账号；`magpie usage --csv` 每条请求记服务方、实际模型、token、`cost_usd`、`credits`、`tries`、`session`。版本 0.1.3232 的 `magpie-cli-linux-amd64` 从 `https://usemagpie.ai/api/latest` 给的地址下载，SHA-256 与该接口给的一致。文档说“every build updates itself”。便携模式：程序旁边有 `data` 目录时，配置都放在那里。
3. CodeBuddy 国际版靠社区插件 `@magpie-community/opencode-workbuddy-auth@0.2.24` 接入（Magpie 用 Bun 运行它）。插件的登录方式有：浏览器登录（凭证 1 年有效）、读 WorkBuddy 桌面版的登录文件（`~/.local/share/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info`，格式见插件 `index.mjs` 的 `readDesktop`）、API 密钥（要 Pro 套餐，Andy 不买）。实测：在隔离的 HOME 下放一份只含假凭证 `proxy-injected` 的桌面登录文件，`magpie plugin login workbuddy-ai "WorkBuddy AI desktop's sign-in"` 成功，代理补上真凭证，模型清单、对话、积分查询都正常。
4. Magpie 启动插件时自动带上 `HTTPS_PROXY`、`NODE_EXTRA_CA_CERTS`，Magpie 自己的请求也走代理。Node 程序默认不走代理，要加 `NODE_USE_ENV_PROXY=1`，否则代理不补凭证、返回 401。
5. 云端环境里 OpenCode Go 的网络密钥只对 `opencode.ai/inference/go/` 路径生效。Magpie 的 Go 预设默认发往 `https://opencode.ai/zen/go/v1`，结果 401；`magpie provider set opencode-go url=https://opencode.ai/inference/go/v1` 后正常。
6. 账号模型和上限（从 `/v3/config` 读）：`deepseek-v4.1-flash-sg`（上下文 100 万，输出 12.8 万，积分倍率 0.11）、`glm-5.3-flash`（100 万 / 3.2 万 / 0.08）。免费版 `deepseek-v4.1-flash` 已不在清单里。免费套餐每月 100 积分加 150 赠送积分，实测时已用约 11.3。
7. OpenCode 1.19.5 不读插件的实时模型清单，只认配置里声明的模型；声明模型时要写输出上限和推理强度档位（`variants`）。
8. 端到端实测：OpenCode 只配一个 `@ai-sdk/openai-compatible` 服务方指向 `http://127.0.0.1:3425/v1`，模型写 `group/deepseek-v4.1-flash`（路由组：CodeBuddy 在前、Go 在后），用复核脚本的只读机制复核 PR 273 第 1 轮：12.9 分钟正常结束，38 步，单步最多 5,922 个 token；途中 CodeBuddy 断开一次，Magpie 把 5 次请求转给 Go，之后回到 CodeBuddy。花费：CodeBuddy 4.37 积分，Go 0.029 美元。OpenCode 每步报的费用是 0，所以脚本现有的美元上限和 `spend-guard.mjs` 插件对这条路不起作用。
9. GLM-5.3-Flash 经 CodeBuddy 跑同一轮：17 步，单步最多 3,010 个 token（上限 3.2 万），没有截断。
10. CodeBuddy 的 DeepSeek 2026-11-07 07:07–07:30 JST 前后故障约 20 分钟（错误码 11134 “the model provider is temporarily unavailable”），同时 GLM 正常。
11. 相关已关闭事故：I-76（OpenCode 配置里写了 `apiKey` 就不再用 auth.json 的密钥）、I-77（费用线要由 OpenCode 进程内的插件在请求发出前拦，不能靠脚本事后停进程）。见 `docs/incidents-and-gates.md`。

## 要你回答

请给出你认为最好的实现方案：Magpie 怎么装、怎么启动和停止、配置和凭证放哪、路由组和模型名怎么定、费用和积分上限怎么在请求发出前拦住、积分底线 20 怎么执行、开跑前自检要改什么、怎么测试、怎么在 Go 用完前后切换、有什么风险。指出上面事实里你认为不可靠或缺失、需要先核实的地方。
