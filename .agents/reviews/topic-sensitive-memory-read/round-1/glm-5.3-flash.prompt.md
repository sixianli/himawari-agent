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
仓库就是当前目录，已检出 63ddef5cdbdd8566cd33ef8f183b1f888be4d64e。
问题、目标和约束：
# 问题：让模型能用上主人明说要记的“敏感记忆”（密码、密钥、健康等）

## 目标

主人对 Himawari 说“记住我家 Wi-Fi 密码是 abc12345”后，这条记忆被存成 `sensitive`（敏感）。主人之后问“家里 Wi-Fi 密码是多少”时，模型应该能把它找出来并答对。同样的路径也应该适用于主人明说要记的其他敏感事（比如“我对青霉素过敏”“我的年收入是……”）。

## 约束（来自主人 Andy 的长期规则，原话见来源）

- 用户主权最高，其次边界与可逆性，其次记忆可靠性，其次主动性与效率。来源：`docs/product-vision.md` 第 2 章“核心原则”。
- 需要主人确认的事要压到最少：“需要我确认或介入的事项同样受预算约束：常规判断应由规则手册预先授权，不逐次确认”。来源：`docs/product-vision.md` 第 58 行（原则 2“行动有边界”）。主人也多次说过产品设计尽量别让他人工点头确认。
- 敏感信息只在数据发往外部（模型、网页搜索）时遮盖，内部存储和展示用原文；遮盖成占位符（如 `[密码#abcdefgh]`），模型输出里的占位符在显示给主人时、以及写库前被换回原文。来源：`docs/adr/0183-mask-only-when-data-leaves-and-keep-the-original-inside.md` 的“决定”。
- 发给模型的内容只能在末尾追加，已发出的不得改动；系统提示和工具定义按对话冻结，工具集合变了会让新对话换新一次。来源：`.claude/rules/prompt-prefix.md` 第 4、6、7 条。
- 能动态获取的不写死；不使用贵模型；本机不跑测试。

## 已核对的现状（文件:行）

1. 记忆的数据分级是 public / private / sensitive / restricted。`restricted` 的候选被丢弃；`sensitive` 的存下来。来源：`packages/application/src/services/automatic-memory-service.ts:133-137`。
2. `sensitive` 记忆不进全文索引：`LEXICAL_CLASSIFICATIONS = new Set(["public","private"])`（`packages/memory-engine/src/hybrid-memory-provider.ts:18`），`upsert` 里不在其中的记忆 `terms` 为空（同文件 85-87 行）；也不进向量：只有 `embeddableClassifications` 里的才生成 embedding（同文件 97 行），生产配置里嵌入模型只允许 `public`、`private`（`scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:104-107`）。不进的理由写在设计规格里：“全文索引和向量是明文衍生物 | `sensitive` 以上不进全文和实体索引；全文表不存原文”（`docs/execution/specs/2026-10-25-self-built-memory-engine-design.md:162`）。
3. 对话里模型查记忆用 `recall` 工具：它允许的分级是“不高于本次运行的分级”（`apps/agent-service/src/production-memory-recall.ts:160-163`），普通对话运行是 private，所以 sensitive 记忆被排除。每轮带进上下文的“主人档案块”只取 public、private（`packages/application/src/services/owner-profile-service.ts:17`），并且敏感记忆和事件、健康、财务、其他类不能被主人设成“每次对话都带上”（`docs/execution/specs/2026-10-25-self-built-memory-engine-design.md:112`）。
4. 生产里的聊天模型是外部服务（Vercel AI Gateway 上的 DeepSeek），配置里 `allowedDataClassifications` 只有 `public`、`private`，`disclosure` 是 `external_remote`（同一份配置模板 60-67 行）。也就是说按现有分级门槛，sensitive 的文字本来就不该发给这个模型。
5. 出口遮盖（`redactForEgress`）把密码、验证码、机器密钥、银行卡、证件号换成占位符，其他敏感内容（健康、财务等）不遮；模型输出里的占位符会被换回原文再显示给主人（ADR 0183 决定 3）。
6. 记忆页已有“待批准”流程：自动整理出的敏感候选，主人没明说“记住”时进待批准，主人批准后才存。提醒到点推送时，sensitive 记忆的正文被隐藏（`apps/agent-service/src/production-web-push.ts:486-498`）。
7. 记忆记录的主题（topic）枚举为 health、finance、beliefs、intimacy、third_party、location、legal、other；密码、密钥、证件号、银行卡号在提示词里让模型填 other（`packages/prompt-catalog/src/memory.ts`）。

## 同类产品怎么做（一手来源）

- Claude：默认不存与个人敏感话题相关的内容；主人可以打开“include sensitive topics in memory”，打开后每次保存敏感内容都有提示；不论开关，社会安全号、政府证件号等“sensitive identification numbers”不存。来源：https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it （2026-11-08 读取）。
- ChatGPT：官方记忆说明页（help.openai.com、openai.com）这次读取返回 403，没有一手原文可引；只有二手报道称 OpenAI 说过努力避免主动记住健康等敏感信息，除非用户明确要求。这条标“未核实”。

## 请回答

1. 怎样让 `sensitive` 记忆能被找到，同时不把明文关键词落到全文索引或向量里？（给出具体做法和代价。）
2. 找到之后，内容怎样进模型的请求？哪些情况模型根本不该看到明文（比如密码用占位符），哪些情况要不要主人同意？
3. 主人确认的次数怎样压到最少？哪些可以一次授权、长期有效，哪些可以自动放行？
4. 怎样不破坏 KV 缓存规则（不改已发出的开头，不频繁换工具集合）？
5. 怎样做反向验收（不该读到的时候读不到）？
6. 你认为最小可行的第一步是什么，后面怎么扩？
