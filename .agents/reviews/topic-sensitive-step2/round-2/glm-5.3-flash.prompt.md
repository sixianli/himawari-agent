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
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 058293d161876f45283f9e168d4bbe89da3fd8cb。
待审核的方案：
# 方案 v3：敏感信息识别第 2 步——识别规则升级（整合线程方案和两个模型的独立方案）

两个模型独立出方案的原文在 `.agents/reviews/topic-sensitive-step2/round-1/`，花费 0.1186 美元。

## 前提（每条附来源）

1. **Andy 已同意第 2 步的方向**，原话（2026-11-05）是“方案里面需要我拍板的事情我都同意”。其中包括：
   - 两套规则并用，现有规则一条不删；
   - secretlint 只作测试依赖，当标准答案用；
   - 不照搬 detect-secrets 的 `is_sequential_string`、`is_not_alphanumeric_string`、`is_line_allowlisted`；
   - 规则升级会让已发内容变一次，单独写 ADR，加进缓存规则第 4 条的例外。
2. **识别规则只能定义在 `packages/sensitive-capture`**，这个包不读写文件、不访问网络：`docs/adr/0167-sensitive-capture-package.md`。
3. **网页端也引用这个包**（`apps/control-center/src/memory-import.ts`），所以包里不能用 Node 专有模块。
4. **缓存规则第 4 条目前只有三种例外**：`.claude/rules/prompt-prefix.md:35`，原话“例外只有三种”。
5. **历史每次请求都按规则重新遮一遍**：`.claude/rules/prompt-prefix.md` 第 5 条，原话“历史里存的是遮盖前的内容，每次发送时按确定的规则重新遮盖”。
6. **机器密钥识别在约 30 处被用来整段拦下内容**：`grep -rn scanMachineSecrets packages apps`。
7. **secretlint 推荐集 13.1.0（2026-10-26，MIT）有 27 条识别规则**，另有一条用注释关闭检测的 filter-comments。
   - 规则是异步、按文件运行的；npm、gcp 两条依赖文件名或读磁盘。
   - 数据库连接串和 basicauth 两条自带“像示例就跳过”的名单：localhost、example.com、password、user、`${password}` 等；用户名和密码相同也跳过。
   - 来源：`npm pack` 取得的 `module/index.js`，第 6355 行起。
8. **detect-secrets 1.5.0（Apache 2.0）**：
   - 关键词表在 `plugins/keyword.py` 的 `DENYLIST`；
   - 默认过滤器在 `settings.py:139-153`；
   - `keyword.py` 文件头另带 HP 的 MIT 声明（来自 bandit）。
9. **流式遮盖靠 `machineSecretHoldStart` 和手写标记表**（`machine-secrets.ts:91-152`），有两处使用：
   - 模型输出：`packages/runtime-pi/src/pi-model-transport.ts:336`；
   - 实时执行输出：`packages/application/src/services/execution-live-feed.ts:46`。
10. **仓库有机密扫描例外清单** `ci/security-exceptions.json`，测试里的假密钥样例要登记。
11. **直接依赖必须精确固定版本**：`.agents/instructions/pi-and-workspace.md:25`。
12. **另一个线程在做“Himawari 自己写的固定指令不检查”**：本线程 2026-11-06 的交接说明。

## 三方比较后的取舍

| 问题 | 线程 | DeepSeek | GLM | 采用 |
|---|---|---|---|---|
| secretlint 怎么接 | 移植成同步实现，上游只当标准答案 | 同 | 同 | 移植。三方一致；网页端也引用这个包，是额外理由 |
| 新规则进不进“整段拦下” | 分两档：数据库连接串、basicauth 这类只遮值 | 全部进，每条规则带开关，误报大的再降级 | 同 DeepSeek | **都不采用，改用业界做法（Andy 已定）**：先只遮值和记录，观察约 2 周后逐条申请开拦，见设计第 2 节 |
| npm、gcp | 只移植按内容就能认的部分 | 同 | 整条不搬 | 移植按内容就能认的部分：`npm_` 令牌、`_authToken=`、服务账号 JSON 的私钥字段。这些格式固定，漏掉可惜 |
| 密码关键词的赋值写法 | 要求引号那组，加配置写法 | 配置写法那组 | 只要求引号那组 | 两组都用。值的边界沿用现有规则的“到空格、逗号、分号为止”（DeepSeek）：聊天里 `secret: abc123` 没有引号，只用引号那组会漏 |
| 中日韩关键词带词缀 | 只允许英文带 `\w*` | 同，并指出照搬会把“密码规则：至少 8 位”误遮 | 未提 | 只允许英文关键词带词缀 |
| UUID、“像 id”过滤器 | 不搬 | 都搬 | 搬 UUID，请 Andy 定 | **不搬，请 Andy 定**。两个过滤器都会放过真密钥，理由见设计第 3 节 |
| 流式遮盖 | 标记从规则清单生成 | 同，并补 DSA/PGP 私钥边界 | 逐条手写开尾正则 | 从清单生成。测试改用 DeepSeek 的更强写法：任意位置切开，流式结果必须逐字节等于一次性遮盖 |
| 证明不漏、不乱遮 | 标准答案对照、样例、固定指令语料、正常内容语料、性能 | 类似 | 再加：现有每条规则至少一例新旧都命中；提示词金样文件零命中；性能脚本 | 全部采用 |
| 上线 | ADR 加例外，规则文件改第 4 条 | 再加：记录规则集版本、监控、回滚 | 再加：回滚本身也会让已发内容再变一次；上线后看缓存命中报告 | 全部采用 |
| PR 拆分 | 3 个，合并后一起上线 | 类似 | 5 个，先只放对照语料 | 4 个，合并后一起上线一次，见下 |
| 和排除规则谁先 | 排除规则先上线 | 同 | 同 | 一致 |

## 设计

### 1. secretlint 规则移植

- 位置：`packages/sensitive-capture/src/upstream/secretlint/`，每条规则一个文件。文件头写：
  - 原作者版权和 MIT 许可；
  - 上游版本 13.1.0 和原文件路径；
  - 改动摘要：改成同步、去掉文件名判断、去掉 `allows`。
- 规则清单是数据（`rules.ts`），每条写明：
  - `id`（`secretlint-<规则名>`）；
  - `surfaces: { redact, block }`：是否遮值、是否整段拦下；
  - `markers`：流式用的“可能的开头”；
  - 上游的示例跳过名单。
- 移植 27 条里能按内容判断的全部，filter-comments 不搬。
  - AWS 按上游默认：不开账号 ID 规则，加上 40 位 Secret Access Key 的判断。
  - privatekey 按上游的 Base64 校验移植。现有 `private-key-block` 保留，另把 DSA、PGP 加进私钥边界。
- 现有 7 条保留，规则清单里标 `surfaces` 两项都开。
- 测试依赖：`@secretlint/core@13.1.0`、`@secretlint/secretlint-rule-preset-recommend@13.1.0`，精确版本，只出现在 `devDependencies`。加一道检查：识别包的源代码里不得引用 `@secretlint`。

### 2. 整段拦下：先只遮值和记录，按数据逐条开（Andy 2026-11-06 定）

业界做法：新规则先只记录、不拦，数据证明误报少了才拦，而且只拦高把握的规则。
- 微软 Purview 的“模拟模式”：https://learn.microsoft.com/en-us/purview/dlp-simulation-mode-get-started
- Cloudflare 建议先 Flag 再 Block：https://developers.cloudflare.com/ai-gateway/features/dlp/set-up-dlp/
- GitHub 推送保护只拦高把握格式：https://docs.github.com/en/code-security/secret-scanning/troubleshooting-secret-scanning-and-push-protection/troubleshooting-secret-scanning

规则：
1. **约 30 处“整段拦下”继续只用现有 7 条规则**，包括读文件、网页、命令输出、自动整理记忆、提醒、对话检查点。新规则的 `surfaces.block` 一律先设为 false。
   - 曾考虑“存进数据库的地方第一天就用新规则”，已撤回：提醒命中后整条被拒（`apps/agent-service/src/production-reminder-writer.ts:196`），对话检查点命中后整个失败（`packages/application/src/services/thread-checkpoint-service.ts:192`），误报代价和读文件被拦同级。
2. **新规则只遮值、只记录。**“敏感信息拦截记录”就是模拟数据：在读文件、网页、命令输出里命中的，记录的出处是工具结果。
3. **观察约 2 周后逐条申请开拦。**只限没有误报、格式固定的令牌，每条交 Andy 批。要看上下文的（数据库连接串、basicauth）一直只遮值。
4. **已知代价：**观察期内，新格式密钥可能被自动整理记忆以原文存进主人自己服务器上的数据库，之后发给模型时仍会被出口遮盖遮掉。记忆里的凭据怎么处理另有方案，不在第 2 步。
5. 测试锁住：观察期内 `scanMachineSecrets` 只认现有 7 条。

### 3. 聊天里的密码

- 新增规则 `password-keyword-denylist`，排在现有 `PASSWORD_ASSIGNMENT` 后面。已经变成 `[密码#…]` 的值跳过，不重复计数。
- 关键词：
  - 英文用 detect-secrets 的 DENYLIST 原样，允许 `[A-Za-z0-9_]*` 词缀；
  - 中日韩沿用现有关键词，再补“密钥/密鑰”，不允许带词缀。
- 赋值写法：detect-secrets 的“配置写法”和“要求引号”两组都用。值的边界用现有规则的 `[^\s,，;；]+`。这一改动写进许可声明里的“改动摘要”。
- 搬的过滤器：`is_templated_secret`、`is_prefixed_with_dollar_sign`、`is_indirect_reference`，外加“值以 `[` 开头就跳过”。
- 不搬的过滤器，每个都配一个反向测试，锁住“这种值仍然会被遮”：
  - `is_sequential_string`、`is_not_alphanumeric_string`、`is_line_allowlisted`；
  - 所有只针对文件的过滤器；
  - UUID 和“像 id”两个过滤器。理由（线程判断，Andy 在等审核意见后定）：
    - `is_potential_uuid` 在值里**任何位置**搜到 UUID 就跳过（`heuristic.py:52-61`），会放过 `HRKU-` 加 UUID 格式的 Heroku 密钥（https://gitlab.com/gitlab-org/gitlab/-/merge_requests/248117）。secretlint 推荐集也没有 Heroku 规则。
    - `is_likely_id_string` 只要同一行、值的前面出现 `_id` 一类名字就跳过（`heuristic.py:64-83`），会放过 `client_id: x, secret: y` 这种同一行里的真 secret。
    - 不搬的代价只是把真编号也遮成占位符；界面上显示回答时会还原原值。
- 样例：照搬 detect-secrets v1.5.0 仓库的 `tests/plugins/keyword_test.py`，保留 Apache 2.0 和 HP MIT 声明。

### 4. 流式遮盖

- `POTENTIAL_SECRET_MARKERS` 和未结尾判断从规则清单生成，不再手写；新的密码关键词也加进去。
- 测试：每个应遮样例在每一个位置切开，按顺序喂给流式遮盖，结果必须逐字节等于 `redactMachineSecrets(完整文本)`。实时执行输出用的是同一个函数，自动跟上。

### 5. 证明

- **不漏**：
  - secretlint 标准答案对照：上游认出的范围我们都必须遮住；
  - 现有每条规则至少一个样例，新旧版本都命中；
  - 每条新规则的应遮样例。
- **不乱遮**：
  - 现有不应遮的样例继续不遮；
  - 正常内容语料报告（见第 2 节）；
  - 提示词金样文件（`apps/agent-service/test/__prompt_golden__/`）零命中。
- **确定**：同样的内容和密钥，两次遮出同样字节（规则版本不变时）。
- **性能**：先在 Hermes 上测现状，门槛定为“不超过现状的 2 倍”，写进测试。
- 假密钥样例登记进 `ci/security-exceptions.json`，按项目流程交 Andy 审核。

### 6. ADR 和规则文件

新 ADR（编号开工时取下一个未占用的，并查开着的 PR）写：
- 决定：移植哪些规则、跳过哪些和理由、每条规则的 `surfaces`、许可。
- 缓存影响：
  - 上线后每个老对话的第一次请求，缓存整段失效一次，之后稳定；
  - 回滚会让已发内容再变一次；
  - 以后每次规则升级都按这条例外办，并在 PR 里写明。
- 监控：上线后 3 天看 `scripts/operations/cache-hit-report.mjs --by turn` 和 `cache.follow_up_low_hit` 日志，预期第 1 天有一次下降，之后恢复。
- 规则文件：`.claude/rules/prompt-prefix.md` 第 4 条的例外清单加一种——“有 ADR 依据的遮盖规则升级”。

### 7. PR 和上线

| PR | 内容 | 改不改行为 |
|---|---|---|
| 1 | 对照语料、secretlint 测试依赖、标准答案对照测试框架、性能测量、正常内容语料（先只测现有规则） | 不改 |
| 2 | secretlint 规则移植、`surfaces`、流式标记改为生成、私钥边界扩展 | 改 |
| 3 | 密码关键词规则和过滤器 | 改 |
| 4 | ADR、规则文件第 4 条、正常内容语料的命中报告 | 文档 |

- PR 2、3 合并后不单独上线。四个都合并、另一个线程的排除规则也上线后，**一起上线一次**，已发内容只变一次。
- 不在范围内：
  - `redactWebContentSecrets`（网页导入用的另一套输出标记）沿用现状；
  - ADR 0167 记下的几份脚本里的规则副本，不同步。

## Andy 已定（2026-11-06）

1. 整段拦下按设计第 2 节：先只遮值和记录，观察约 2 周后逐条申请开拦。
2. 四个 PR 都合并、并等另一个线程的排除规则上线后，一起上线一次。
3. 方案讨论的花费上限 1.5 美元。

## 还要 Andy 定

1. 密码规则不搬 UUID 和“像 id”两个过滤器（线程推荐不搬，理由见设计第 3 节）。
