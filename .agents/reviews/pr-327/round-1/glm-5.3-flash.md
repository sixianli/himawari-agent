## 侧重检查

我走的流程：`git diff 基准..HEAD` 确认改动范围只有 `scripts/operations/prod-read.sh` 和 `test/tooling/prod-read.test.mjs`（docs 的 agent-rulebook-inventory.md 改动在本范围之前已 squash 合并，见 98e21c6 的 merge 说明「already squash-merged in #326」）。然后走了一条最普通的使用流程：**操作者在 Mac 上跑 `prod-read.sh rule-memories`**：

1. 入口参数检查 `scripts/operations/prod-read.sh:173-175`（无参数才放行，多余参数走 usage）；
2. `database_query rules`（43-46 行）→ ssh 用 unquoted heredoc（`<<JS`）把 JS 送进生产机 `/opt/himawari/node/bin/node`；
3. 远端 JS 85-91 行：`SELECT id, status, tentative, classification, importance_permille, confidence_permille, inference, recorded_at, updated_at, valid_to, superseded_by, use_count FROM memory_records WHERE category='rule' ORDER BY recorded_at` → `shorten` → `JSON.stringify(…, null, 1)`。

未测试覆盖的路径：真正 ssh 到生产机后的行为（测试用假 ssh 只拿到脚本文本）；`shorten` 对 rules 模式结果的截断行为只在 rows 模式其它测试（测试 120-150 行）间接验证过，没有针对 rules 输出的独立用例，但会走同一函数；`console.log` 的序列化格式本身没有断言。第二段流程 `system-instruction`（108-118 行）：无参数检查 → ssh 读 `/etc/himawari/config.json` → 只打印 `systemInstruction`。`configuration.configuration?.runPolicy` 兜底分支没有任何测试走（也不该走，见下）。

## 发现的问题（严重度从高到低）

**1. 中·scripts/operations/prod-read.sh:113 — 配置解析兜底分支和真实解析器不一致，是死代码**
证据（已核实）：`packages/platform-node/src/strict-configuration.ts:1186-1211` 的 `rejectUnknown` 只允许 `runPolicy` 等列出的顶层键；顶层出现 `configuration` 键会整个配置被拒（"configuration: must not have unknown fields"），`service-main.ts:649` → `JsonFileConfigurationPort.load()`（strict-configuration.ts:1566）把 JSON 直接交给 `parseProductConfiguration`，中间没有再包一层。所以脚本 113 行 `configuration.runPolicy ?? configuration.configuration?.runPolicy` 的后半段永远不会命中真实生产配置；若生产配置真是包了一层 `configuration`，那它在产品里本身就解析失败，不可能是「生效的配置」。测试（test/tooling/prod-read.test.mjs:215-221）也没有覆盖这个分支。
建议：删掉 `configuration.configuration?.runPolicy` 兜底，只留 `configuration.runPolicy`，避免误信「磁盘上有第二种合法形态」。

**2. 低·scripts/operations/prod-read.sh:85/88 — 对外名 `rule-memories` 和远端模式名 `rules` 两个词，靠测试字符串捆住**
证据：外层 case（173-175 行）只认 `rule-memories`，内部发的是 `rules`；test/tooling/prod-read.test.mjs:186 断言 `result.calls` 含 `--no-warnings - rules`。内层数据/SQL 全是字面量、无参数注入，安全上没问题；只是命名双轨，将来改名时容易只改一头（有测试兜着，算可接受）。
建议：保持现状即可，或在使用说明里注明两个名字的关系。

**3. 低·scripts/operations/prod-read.sh:88 — 输出含全部状态的规则，不只是生效的；且 `recorded_at` 可空**
证据：SELECT 没有 `status` 或有效期过滤，`archived/trashed/deletion_pending` 的规则也会列出来（分类值本身在 0001_initial_product_schema.sql:398 是状态枚举，清单用途可以接受，但「实际有哪些规则」的读者要自己过滤）。`recorded_at` 来自 0053_memory_episodes.sql:1 `ALTER TABLE memory_records ADD COLUMN recorded_at TEXT`，可空且未见回填迁移；排序时 NULL 排最前，输出顺序确定但含义未核实（推测：是否所有生产记录都有 recorded_at 不确定）。
建议：查询侧不变也行，但文档里注明输出不含生效性过滤。

**4. 信息·docs/agent-rulebook-inventory.md:149 与脚本设计相反措辞**
证据：该行写「需要的话：Andy 同意后，我用只读方式列出所有 rule 类记忆（条数、**原话**、立下的日期、是否待确认），补进这一节」；本次脚本刻意排除原话和 content_ref（88 行 SELECT 不含 content_ref，成品输出亦断言不含）。文档承诺含原话、实现只给元数据，方向不一致。另外 runbook `docs/runbooks/production-web-entry-runbook.md:79` 未提这两个新查询和配置文件路径。
建议：把清单文档里那句改成「只列元数据」并补 runbook 一行。

## 结论（读代码证实 vs 推测）

**读代码证实的**：改动只涉及只读运维脚本和其测试，不触及任何发给模型的内容生成路径（无提示词、遮盖、上下文选择代码被改）；`rule-memories` 选的 12 列全部在真实迁移列里（0001:393-408、0052:1-6、0053:1、0054:1），且不含 `content_ref`、`owner_id`、`agent_id`、`source_thread_id`、`policy_version`、`provider_record_id`——只要不选 `content_ref` 就不会带出 payload 引用，内容原文在 payloads 表里根本不查；`category='rule'` 是 0052 CHECK 里的合法值；机器秘密类列名遮盖正则（脚本 50 行）对 rules 模式不必要但仍在路径上；`system-instruction` 只打印字符串 `systemInstruction`，不含 `secretReferences` 等其余配置；`systemInstruction` 是 `parseRunPolicy`（strict-configuration.ts:1124-1129）的必填字符串字段，`typeof !== "string"` 报错对合法生产配置不应触发；`/etc/himawari/config.json` 与 spec `docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md:299` 记载的生产配置路径一致。测试（test/tooling/prod-read.test.mjs:179-242）真的守约束：rules 用例断言 stdout 不含 `secret-ref`、远端 JS 不含 `content_ref`，且 `content_ref` 不在遮盖正则里，一旦有人把 `content_ref` 加进 SELECT，明文引用会被打印、断言会红——反向用例会失败；system-instruction 用例配置里埋了 `secretReferences`、断言 stdout 恰为 `"hello\n"`，多余输出会红；缺字段负例断言非零退出+空 stdout；多传参数负例断言 64+零 ssh 调用，也会在脚本放行参数时失败。

**推测**：生产库的 `recorded_at` 是否全量回填未核实；生产配置文件当前形态只能核实为「解析器只接受顶层 runPolicy」，磁盘文件内容本身在仓库外。

## 必答问题逐条回答

1. **会不会改变模型已见过的请求开头？** 不会。已核实 diff 范围只有 ops 脚本和测试，未触碰提示词组装、遮盖、上下文选择、工具定义等任何产品代码；发给模型的内容与本次改动完全无关，「只追加 / 值在最后一条消息里」的规则没有被撼动。
2. **同一文字会不会在不同请求里变成不同字节？** 不会。没有引入时间字段、依赖前后文的遮盖或无序集合；rules 输出按 `recorded_at` 静态排序、键序来自列序，同为确定性输出，且这些输出发给操作者而非模型。
3. **有没有自动检查、反向用例会不会失败？** 有，`test/tooling/prod-read.test.mjs`（tooling 项目，CI 覆盖）。我的推演：把 `content_ref` 加回 SELECT、把整个配置 dump 进 stdout、让两个查询接受参数、缺 `systemInstruction` 时静默成功——这四种修改分别会让 4 条断言变红，反向用例真实有效。未覆盖的只有远端 ssh 真实执行和 `configuration` 包裹层的死分支。
4. **每个新值两端都核对过吗？** `PROD_CONFIGURATION=/etc/himawari/config.json`（生成于脚本 8 行，消费于 109-110 行远端命令 + 测试 219 行断言；与 Gmail spec 299 栏给出的一致）；模式名 `rules`（生成于 175/85，消费于远端 dispatch 85 行 + 测试 186 行断言，无未竟校验）；查询名两个（usage 文本 23-24 行与 case 标签 173/177 一致）；`category='rule'` 字面值落进 schema CHECK 合法枚举（0052:1）；输出 JSON 格式无自动化消费者（grep 仓库内无任何别的代码解析这两个查询的输出），纯人工使用，可接受。唯一不匹配值是 113 行的 `configuration.configuration` 兜底路径，见问题 1（中）条。
