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
# 敏感信息识别第 2 步：识别规则升级（独立出方案的材料）

请读仓库代码、上网查一手资料，独立给出一套能直接动工的方案。不要只复述下面的事实。

## 背景

`packages/sensitive-capture`（ADR 0167）是 Himawari 唯一定义敏感信息识别规则的包。它不读写文件或数据库，不访问网络，也不依赖 Himawari 的其他包。

已经上线的两步：
- 第 0 步：拆包，行为不变。
- 第 1 步：“敏感信息拦截记录”页面，规则一条不动。

第 2 步要升级识别规则本身。

## 目标（主人 Andy 已拍板）

1. **机器密钥**：在现有规则之上，叠加开源工具 secretlint 推荐规则集（`@secretlint/secretlint-rule-preset-recommend`）的规则。两套并用，现有规则一条不删。
   - 理由：secretlint 的 OpenAI、GitHub、AWS 规则比现有规则严，直接替换会漏掉现在能遮住的密钥。
2. **聊天里随口说的密码**：照搬 detect-secrets 的关键词检测做法（`KeywordDetector` 加它的过滤器），只是把关键词换成中日韩英的。不自己发明新规则。
3. 上一轮双模型审核已经定下：detect-secrets 的这三个过滤器**不照搬**：
   - `is_sequential_string`：会放过 `123456` 这类密码；
   - `is_not_alphanumeric_string`；
   - `is_line_allowlisted`：文本里写一行 `# pragma: allowlist secret` 就能关掉检测，聊天里任何人都能用它绕过。
   只针对文件的过滤器（锁文件、swagger、非文本文件等）也不搬。
4. 规则一变，历史消息每次重新遮盖的结果也会变，这会改动已经发给模型的内容一次。Andy 已同意，并要求单独写一份 ADR，把“遮盖规则升级”加进缓存规则第 4 条的例外（`.claude/rules/prompt-prefix.md` 第 4 条）。
5. 开源许可：照搬规则要保留原作者版权和许可声明，并标明改过哪里。secretlint 是 MIT，detect-secrets 是 Apache 2.0。

## 已核对的事实（附出处）

- **secretlint 推荐集**：最新版 13.1.0，2026-10-26 发布，MIT。
  - 含 27 条识别规则：1password、anthropic、aws、basicauth、cloudflare、database-connection-string、databricks、docker、figma、gcp、github、gitlab、grafana、groq、hashicorp-vault、huggingface、linear、notion、npm、openai、privatekey、sendgrid、shopify、slack、stripe、tailscale、vercel。
  - 另有一条 filter-comments，是用注释关闭检测的过滤器。
  - 部分规则依赖文件名或文件内容：gcp 要读 `.p12` 和 json 文件，npm 只在 `.npmrc` 或 `package.json` 里查。
  - 整个推荐集打包后是一个约 230 KB 的 `module/index.js`，用 `npm pack @secretlint/secretlint-rule-preset-recommend@13.1.0` 可以取到。
  - `@secretlint/core` 提供 `lintSource`。
- **detect-secrets**：1.5.0，Apache 2.0。
  - 关键词检测在 `detect_secrets/plugins/keyword.py`：DENYLIST 有 api_key、password、passwd、pwd、secret、private_key 等，关键词前后可以带 `\w*`。
  - 按文件类型选用不同的“赋值写法”正则；没有文件类型时只用要求引号的那一组。
  - 默认过滤器在 `detect_secrets/settings.py` 第 139-153 行，实现在 `detect_secrets/filters/heuristic.py`：模板占位、`$` 开头、间接引用、像 id 的字符串、UUID 等。
- **我们现有的机器密钥规则**：7 条，在 `packages/sensitive-capture/src/machine-secrets.ts` 第 1-50 行。
  - 规则：private-key-block、authorization-bearer、jwt-token、openai-api-key、github-token、aws-access-key、credential-assignment。
  - 统一替换成 `[密钥]`。
- **我们现有的密码规则**：`packages/sensitive-capture/src/redaction.ts`。
  - `PASSWORD_ASSIGNMENT`：中日韩英关键词，加分隔符“: = 是 为 は”，再加值。
  - 验证码规则：关键词前后 40 个字符内的 4 到 8 位数字。
  - 银行卡、证件号带校验位检查。
  - 被遮的值会被记住，同一次请求里后面的消息再出现时也遮掉（`named-earlier`）。
- **机器密钥识别不只用来遮盖**：`scanMachineSecrets` 和 `containsToolOutputSecret` 在约 30 处被拿来**整段拦下**内容，不发给模型、不保存、或直接报错。用法见 `grep -rn scanMachineSecrets packages apps`，例如：
  - 读文件、命令输出、网页搜索和读网页（`packages/platform-node/src/exa-public-search.ts`）；
  - 自动整理记忆（`packages/application/src/services/automatic-memory-service.ts`）；
  - 提醒（`apps/agent-service/src/production-reminder-writer.ts`）、对话检查点；
  - 出口遮盖后的自检（`packages/application/src/services/model-egress.ts:214` 的 `assertMachineSecretFree`）。

  所以规则一多，被整段拦下的内容也会变多。
- **模型输出的流式遮盖**：`StreamingMachineSecretRedactor`（`machine-secrets.ts` 第 91 行起）。它靠一份“可能是密钥开头”的标记列表，把可疑的结尾先扣住不输出。
- **出口遮盖每次请求都对整段历史重新遮一遍**：历史里存的是遮盖前的原文，见 `.claude/rules/prompt-prefix.md` 第 5 条。遮盖必须是确定的：同样的内容和密钥，每次遮出同样的字节（第 10、11 条）。
- **另一个线程在修误拦截**：自动整理记忆指令里的“0 到 1000”被验证码规则遮掉了。修法是给识别加“排除规则”：Himawari 自己写的固定指令不检查。第 2 步加的新规则也会受益于这层排除。
- **依赖版本**：直接依赖必须精确固定，不许用版本范围（`.agents/instructions/pi-and-workspace.md` 第 25 行）。
- **测试**：只能在云服务器或 Hermes 上跑，不在 MacBook 上跑。`npm run check` 是快速模式的门槛。`npm run check:prompt-prefix` 检查请求开头是否只追加。

## 请回答

1. secretlint 的规则怎么接进来：直接依赖它的包在运行时调用，还是把规则移植成我们自己的同步实现？各有什么代价（同步或异步、包大小、依赖文件名的规则、许可、升级上游时怎么跟）？
2. 新规则用在哪里：只用于“遮盖一个值”，还是也进入那约 30 处“整段拦下”的检查？各自的误报代价是什么？
3. detect-secrets 的关键词检测怎么改造成适合聊天文本的样子：关键词、赋值写法、要保留的过滤器。和现有 `PASSWORD_ASSIGNMENT` 是合并还是并存？
4. 流式遮盖怎么跟上新规则。
5. 怎么证明没有漏遮、误遮可控：测试样本、拿上游实现当标准答案对照、性能基准。
6. 上线时“已发内容变一次”怎么处理，ADR 写什么。
7. 分几个 PR、什么顺序，和另一个线程的“排除规则”谁先谁后。
