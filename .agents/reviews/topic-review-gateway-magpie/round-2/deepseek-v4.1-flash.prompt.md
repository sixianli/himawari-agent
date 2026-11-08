你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 5cedac651d45dda582b8ce0a201b8826e11ec8e0。
待审核的方案：
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


---

# 线程的方案（请审核）

## 1. 安装：环境启动脚本 + 仓库里的锁文件

- 仓库新增 `scripts/model-review/gateway-lock.json`：Magpie 命令行版的版本号、下载地址、SHA-256；插件包名、版本、npm 的 integrity。
- 新增安装脚本 `scripts/model-review/install-gateway.mjs`：按锁文件下载 Magpie 到 `~/.cache/himawari-magpie-<版本>/magpie`，校验摘要，不符就删掉并报错；把插件包按 integrity 下载到同一目录备用；首次运行 Bun 也在这里触发下载。
- himawari-cloud 环境的启动脚本只加一行：`if [ -d himawari-agent ]; then (cd himawari-agent && node scripts/model-review/install-gateway.mjs) || true; fi`。跑完被快照，之后的新会话不再下载。复核脚本开跑时如果发现没装（例如 Mac、或快照过期后的第一次），自己调用同一个安装脚本，和现在装 OpenCode 的做法一致。
- 不用旁路 Docker 容器：要装的只有一个 30 MB 的程序和一个插件，容器方式还要每次启动 dockerd、单独配置代理和证书。

## 2. 每次复核起一个全新的 Magpie，跑完关掉

- 复核脚本在本次的临时工作目录里建一个“便携 Magpie”：把锁定的程序复制进去，旁边建 `data/`，另建一个隔离的 HOME。这样配置、用量记录、插件登录都只属于这一次，不受上一次影响，跑完随临时目录一起删除。
- 用命令行按仓库里的配置生成本次的 Magpie 设置：`provider add`、`provider set url=`、`plugin add <本地插件包>`、在隔离 HOME 放只含 `proxy-injected` 的桌面登录文件后 `plugin login workbuddy-ai "WorkBuddy AI desktop's sign-in"`、`group add ... routing=order`。
- `magpie serve` 监听 `127.0.0.1` 的一个空闲端口（不用固定的 3425，避免和别的 Magpie 冲突），等 `/v1/models` 返回后再启动 OpenCode。脚本结束、收到中断信号时一并停掉。
- 自动更新：每次都是从锁定的程序复制出的新副本，开跑前和跑完各检查一次 `magpie --version` 等于锁定版本，不等就停（`GATEWAY_VERSION_CHANGED`）。查清怎么关掉自动更新后在启动参数或环境变量里关掉。

## 3. 配置放仓库，密钥放网络密钥

- 新增 `scripts/model-review/gateway.json`（不含任何密钥）：
  - 服务方：`workbuddy-ai`（插件，桌面登录文件方式）、`opencode-go`（预设，`url=https://opencode.ai/inference/go/v1`，密钥写 `proxy-injected`）。
  - 对外模型名和路由组：`deepseek-v4.1-flash` → `workbuddy-ai/deepseek-v4.1-flash-sg`、`opencode-go/deepseek-v4.1-flash`；`glm-5.3-flash` → `workbuddy-ai/glm-5.3-flash`、`opencode-go/glm-5.3-flash`；`routing=order`，`stays=auto`。
  - 每个对外模型的输出上限取各成员中最小的（DeepSeek 12.8 万，GLM 3.2 万），推理强度档位取各成员都支持的。
  - CodeBuddy 积分底线 20。
- 真凭证只在云端环境的网络密钥里：`www.workbuddy.ai`（已存）、`opencode.ai`（已有）。Mac 上用 Magpie 自己的登录，同一份 `gateway.json`。

## 4. OpenCode 只认对外模型名

- OpenCode 配置只有一个服务方 `review`：`@ai-sdk/openai-compatible`，`baseURL` 指向本次 Magpie，`apiKey` 写占位值；模型 `deepseek-v4.1-flash`、`glm-5.3-flash` 分别对应 `group/<名>`，写明输出上限和 `variants`。
- `REVIEW_MODELS` 改为 `review/deepseek-v4.1-flash`、`review/glm-5.3-flash`；账本里的 `model` 短名不变，所以 `--models`、`--round`、`SUBSTITUTES`、已有账本都照常用。
- `MIN_OUTPUT_TOKENS` 改成按模型：DeepSeek 至少 10 万，GLM 3.2 万（实测单步最多 3,010）。

## 5. 花费上限：请求发出前拦住

- 保留现有的 `spend-guard.mjs` 和 0.2 美元/模型、1 美元/0.5 美元先问线不变。在 OpenCode 的模型配置里写保守单价（按 Go 上同一模型的价格），这样 OpenCode 每步算出的美元费用不再是 0，插件照旧在请求发出前拦。这和 ADR 0117 第 3 条“按 Vercel 保守价格记账”是同一个做法。
- 真实花费另记：每次跑完读本次 Magpie 的用量记录，按服务方汇总，写进 `usage.jsonl` 的新字段 `providers: { "workbuddy-ai": { credits, requests }, "opencode-go": { usd, requests } }`。复核记录必须带这个字段（`USAGE_LEDGER_INVALID` 一并检查）。
- 积分底线：开跑前查 CodeBuddy 剩余积分（插件的用量查询，经 Magpie 或直接调用）。剩余减去本次最多可能用掉的（每个模型按实测最大值的 3 倍估，DeepSeek 约 13、GLM 约 6）低于 20，就在本次生成的路由组里去掉 `workbuddy-ai` 成员，只走 Go，并打印 `GATEWAY_CREDIT_FLOOR`。查不到积分时同样去掉，不猜。
- 两家都不可用：Magpie 返回错误，脚本按现有的 `api-error` 处理（重试一次、`SUBSTITUTES` 换模型）。

## 6. 自检

- 现有自检（只读限制、git 替身、写文件探针、费用插件拦截、输出上限、推理强度）照跑，但请求改为经过本次的 Magpie 发到本机假服务器：Magpie 里加一个指向假服务器的自定义服务方，路由组只含它。这样自检也检查了“OpenCode → Magpie → 上游”这一跳，`max_tokens`、`reasoning_effort` 透传对不对。
- 新增网关探针：假服务器先返回一次 500 再正常，检查 Magpie 换到了第二个成员；检查 Magpie 版本；检查 `gateway.json` 里每个模型在真服务方的清单里存在、输出上限不低于声明值（这一步要联网，放在自检之后、花钱之前，失败就以 `GATEWAY_PREFLIGHT_FAILED` 停）。

## 7. 和发给模型内容的规则

- 同一次复核的追问（收尾）沿用同一个 OpenCode 会话，Magpie 的 `stays=auto` 让它留在同一个账号；只有出错换服务方时缓存失效一次，这是故障时的代价，写进 ADR。
- 插件会在 CodeBuddy 拒绝某些系统提示时改写系统提示（加逗号或移进用户消息），只在被拒时发生，同一进程内确定；记进 ADR 的风险。

## 8. 切换

- 新增 `--gateway magpie`（默认关），Go 用完前照旧直连；Andy 同意后改成默认开，直连方式保留一个版本作为退路，再删掉。

## 9. 测试

- `test/tooling/opencode-review.test.mjs` 增加：配置生成（`gateway.json` → Magpie 命令、OpenCode 配置）、积分底线（剩余 25、19、查不到）、用量汇总、版本校验、锁文件摘要不符时拒绝。
- 用真 Magpie 程序和本机假服务器的集成用例：路由、失败转移、费用插件经 Magpie 仍能拦住第 4 次请求。
- 反向用例：去掉积分底线检查、去掉版本检查、把 Go 地址改回 `/zen/go/v1`，对应用例必须失败。

## 10. 文档

- 改 `.agents/instructions/model-review.md`“怎么跑”一节；新增 ADR“复核模型调用经 Magpie 路由”；工程案例库按规则判断是否值得写。

## 风险

- Magpie 是 0.1.x、发版频繁；社区插件的桌面登录文件格式可能变。靠锁版本和联网预检兜住。
- CodeBuddy 条款风险（社区插件接入）Andy 已在生产上接受，复核沿用。
- 积分和生产 Himawari 共用；底线 20 只保证复核不把最后 20 积分用掉。

## 要你回答

请审核上面的线程方案：找出漏掉的场景、判断错的地方、和业界成熟做法不一致的地方、会削弱现有只读限制或费用上限的地方，以及上面“已核实的事实”里你认为不可靠、需要先核实的地方。每条写明依据（文件:行或网址加原话）和你建议的改法。
