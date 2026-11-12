结论：本 PR 的 diff 只有 `docs/` 和 `.agents/reviews/` 下的记录，没有代码或测试改动；所以**当前**发给模型的请求不会变。但文档里有几处会误导后续编码，最重的是 ADR 0242 的读取级别上限漏掉 `today_context`，以及 ADR 0219 新补的遮盖说明与现有代码和测试相反。

## 一、读代码/文档证实的发现

### 1. 高 — 读取级别上限漏掉 `today_context`，默认 private 的接入仍能读到 sensitive

**文件:行**：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:86,89-93,196`；`apps/agent-service/src/production-mcp-read.ts:940-959`；`apps/agent-service/src/service-main.ts:2266`；`apps/agent-service/src/production-reminder-writer.ts:286-289`

**问题**：决定 4 只让 `start_here`、`find_memories`、`rule_book` 过读取级别检查，但决定 2 明确保留 `today_context`。`today_context` 会返回提醒正文和近两天对话摘要，摘要按 `modelVisibleClassifications()` 取 public/private/**sensitive** 三级，提醒也只排除 `restricted`。因此新建的 private 接入仍可通过 `today_context` 读到 sensitive 内容，直接绕过决定 4。决定 4 之后实际有 4 个读工具，后果里的“三个读工具各一条”也少算了一个。

**证据**：
- ADR 0242:86：“`today_context` 保留，给对话中途刷新‘今天’用。”
- ADR 0242:89-90：“`start_here`、`find_memories`、`rule_book` 走同一道检查。”
- ADR 0242:196：“读取上限以下的接入读不到上限以上的内容，三个读工具各一条。”
- `production-mcp-read.ts:940-959` 的 `#todayContext` 返回 `reminders` 和 `recent.output`。
- `service-main.ts:2266`：“`allowedClassifications: modelVisibleClassifications(),`”
- `production-reminder-writer.ts:288`：“`memory.dataClassification !== "restricted"`”

**建议**：把 `today_context` 纳入同一道上限检查，并把接入的读取上限传进摘要和提醒过滤；提醒目前只排除 restricted，需要按上限过滤。补三条反向用例：private 接入经 `today_context` 和 `start_here` 都读不到 sensitive 提醒/摘要；并把“三个读工具”改为“四个读工具”。

### 2. 中高 — ADR 0219 新注和 ADR 0242 决定 14 对“现有遮盖行为”的描述与代码、测试相反

**文件:行**：`docs/adr/0219-read-only-mcp-entry-with-static-token.md:72,76`；`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:148`；`packages/sensitive-capture/src/redaction.ts:552-568`；`packages/sensitive-capture/test/redaction.unit.test.ts:369-384`

**问题**：新注说“一起遮时前面多一个敏感值，后面的占位编号全变”。但 `maskSensitiveTexts` 先用内部 tag 关联，最后把 `#tag` 去掉了，返回给外部的占位符本来就不带序号；现有测试还明确断言：同一段被点名的文字，不管同批里多一个无关敏感值，字节相同。真正的跨字段依赖是另一条规则：一个“裸值”只有在同一批里被另一段点名为密码/验证码时才会被遮。ADR 0242 决定 14 的“按字段各自编号”并没有解决这个依赖，反而可能基于错误前提做出无意义或引入新字节变化的改动。

**证据**：
- ADR 0219:72：“返回给对方的占位符只写类别（例如 `[密码]`），不带序号，所以同一段文字的遮法不随这次一起返回的其他无关内容变化。”
- ADR 0219:76：“因为一起遮时前面多一个敏感值，后面的占位编号全变。”
- `redaction.ts:566-568`：最后执行 `replace(EGRESS_PLACEHOLDER_PATTERN, "[$1]")`，把 `#tag` 去掉。
- `redaction.unit.test.ts:380-384`：`expect(withOthers[1]).toBe(alone[0]);`，断言字节相同。
- `redaction.unit.test.ts:369-378`：裸值因同批另一段点名而被遮，这是真正的上下文依赖。

**建议**：改正这条注和决定 14 的前提。若目标是确定性，需要明确处理“裸值因同批点名而被遮”这条规则；不要以“占位编号会变”为理由改成按字段编号。补一条测试：同一裸值文本在有/无命名文本时的字节行为，并说明是否接受这种差异。

### 3. 中 — ADR 0227 决定 3“权限按配置给、不再按客户端发令牌”没有补注，和 ADR 0242 冲突

**文件:行**：`docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md:67-69,115-116`；`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:76-77`

**问题**：ADR 0242 把权限、暂停/撤销、读取级别都挂到“接入编号”上；ADR 0227 决定 3 仍写着“读写权限按配置给，不再按令牌分”“所以不用再给每个客户端发一把单独的写令牌”。PR 只在 ADR 0227 的“后果”里补了“来源只能靠客户端自称”一条，没有改决定 3。后续编码线程读 ADR 0227 时不会知道权限已经改成按接入分配，可能实现成全局配置。

**证据**：
- ADR 0227:67：“**读写权限按配置给，不再按令牌分。**”
- ADR 0227:69：“所以不用再给每个客户端发一把单独的写令牌。”
- ADR 0242:76：“服务端只存密钥的摘要，按密钥认出是哪个接入，生成自己的接入编号。”
- ADR 0242:77：“权限和统计都挂在接入编号上：暂停、撤销……能读到哪一级、推来的要不要先问。”

**建议**：在 ADR 0227 决定 3 下补注，说明 ADR 0242 的接入密钥是身份/统计键，不等同于旧的写令牌，并写清它和 `runPolicy.mcpRead.proposals` 的关系；或者明确说明哪一部分仍是全局配置。

### 4. 中 — “全量名单删除”依赖的调用方身份没有定义

**文件:行**：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:99,194`

**问题**：决定 6 说“助手程序每次附上全部编号；模型自己调用时不认这个名单”，但没定义服务端如何区分“助手程序”和“模型调用”。助手程序用 Cloudflare 服务令牌 + 接入密钥（决定 11），模型客户端也用同一个接入密钥；如果两者无法区分，模型可能伪造全量名单触发删除，或者助手程序无法触发删除。后果里的反向检查“删除只认助手程序的全量名单”目前没有可实现的判据。

**证据**：
- ADR 0242:99：“助手程序（决定 10）每次附上‘我这边现有的全部编号’……模型自己调用时不认这个名单，免得漏报被当成删除。”
- ADR 0242:194：“删除只认助手程序的全量名单；已确认的不跟着删。”

**建议**：为全量同步定义独立权限/独立凭据或独立工具，并在服务端强制；补反向用例：模型携带“全量名单”不能删除任何项目笔记。

### 5. 中 — “专属网址”与“网址是同一个”冲突；多人时服务令牌无法按登录人找库

**文件:行**：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:75,136,150`；`docs/adr/0162-receive-muse-data-through-a-service-token-and-an-app-secret.md:39`

**问题**：决定 1 说每个接入得到“带随机密钥的专属网址”，决定 16 又说“网址是同一个”，需要先按登录的人找到库，再认接入密钥。同时决定 11 的助手程序用 Cloudflare 服务令牌过第一道门，服务令牌不是“登录的人”。多人部署时，服务端没有说明如何从服务令牌找到某个人的数据库。

**证据**：
- ADR 0242:75：“每个接入由主人在网页上建，得到一个带随机密钥的专属网址。”
- ADR 0242:136：“凭据：Cloudflare 服务令牌过第一道门，接入密钥定身份。”
- ADR 0242:150：“网址是同一个（前提 18），服务端先按登录的人找到库，再在这个库里认接入密钥。”
- ADR 0162:39：服务令牌是 `CF-Access-Client-Id` / `CF-Access-Client-Secret`，不是用户登录身份。

**建议**：明确“同一个基础网址 + 每个接入的密钥放在路径/头/查询”的关系；为服务令牌路径定义属主绑定（例如服务令牌绑定到某个 owner，或全局按接入密钥反查属主），否则多人时助手程序无法选库。

### 6. 中 — 接入密钥/接入编号的格式、长度、URL 安全位置未定义，存在泄露风险

**文件:行**：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:75-78,203`；`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:63`；`packages/gateway-contracts/src/validation.ts:49-56`

**问题**：密钥可能放在 URL 子路径，失败时还建议改到查询参数；查询参数会进入访问日志、代理日志、Referer。ADR 没有要求日志脱敏、密钥轮换或短有效期。接入编号要写进决策记录 `subjectRef`，该字段接受 1-256 字符文本；如果接入编号将来进入 `machineString` 字段，按现有规则只允许 `[A-Za-z0-9][A-Za-z0-9._:-]*`、最长 128，UUID 里的 `-` 或带路径的编号都会失败。

**证据**：
- ADR 0242:75：“带随机密钥的专属网址。”
- ADR 0242:203：“不行就把密钥换到查询参数或请求头。”
- `sqlite-decision-ledger-operations.ts:63`：“`if (write.subjectRef !== null && !text(write.subjectRef, 1, 256))`”
- `validation.ts:53-54`：“`input.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)`”

**建议**：优先放请求头，不要把密钥放查询参数；规定 URL 安全、定长的接入编号，并声明它只用于文本字段（`subjectRef` 1-256），不得进入 `machineString` 字段；对访问日志/代理日志做密钥脱敏，明确轮换和撤销行为。

### 7. 中低 — 外部稳定编号“任意文字”和项目名缺少长度、规范化、凭据剥离

**文件:行**：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:96-97,114,192`

**问题**：`sync_memories` 的稳定编号被定义为“笔记文件路径之类，任意文字”，项目名来自仓库远程地址或目录名。ADR 没有规定长度上限、NFC/控制字符规范化、日志/页面编码；如果后续实现把稳定编号交给现有 `machineString`，路径、空格、中文都会被拒。仓库远程地址还可能带 `https://user:token@host/repo.git` 这类凭据，助手程序直接发送会给服务端和页面带来泄露风险。

**证据**：
- ADR 0242:96：“每条有对方自己的稳定编号（笔记文件路径之类，任意文字）……”
- ADR 0242:114：“项目名由助手程序取仓库的远程地址，没有就用目录名……”
- ADR 0242:192：“稳定编号（含路径、空格、中文、超长）……都通过；把服务端生成编号换成直接用对方的编号，必须失败。”
- `validation.ts:49-56` 的 `machineString` 只允许 1-128 个受限字符。

**建议**：明确稳定编号和项目名用 text 列存储、单独限长（例如 1-1024），做 NFC 和控制字符清理；从远程地址中剥离 userinfo/令牌，只保留 host/path；日志和页面统一编码。补反向用例：超长、控制字符、带凭据远程地址。

### 8. 中低 — `sync_memories` 只写了“超上限不写半批”，没有定义写入中途失败的事务语义

**文件:行**：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:100`；`docs/adr/0219-read-only-mcp-entry-with-static-token.md:83`

**问题**：决定 6 只承诺“超过上限整批拒绝，不写半批”，没有说明待确认表/决策记录写到一半失败时怎么办。外部读取在 ADR 0219 决定 5 里有明确的 fail-closed 规则，`sync_memories` 没有对应规则，后续实现可能留下半批。

**证据**：
- ADR 0242:100：“超过上限整批拒绝，不写半批。”
- ADR 0219:83：“决策记录写不进去时，这次读取按失败处理：不把内容交给对方，只回工具错误。”

**建议**：规定整批事务边界、失败回滚、幂等重试和“写入失败时返回逐条结果还是整批错误”；补反向用例：模拟中途数据库失败，库里不能留半批。

### 9. 低 — 内部引用“决定 10”应为决定 11

**文件:行**：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:99`；对照 `:133-140`

**问题**：决定 6 写“助手程序（决定 10）”，但“第一档用一个装在主人电脑上的助手程序”是决定 11；决定 10 是分档表。

**建议**：改为“决定 11”。

### 10. 低 — `amends` 没有双向 `amended_by`

**文件:行**：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:6`；`docs/adr/0031-isolated-tool-execution.md:139`

**问题**：仓库 ADR 0031 明确约定部分修正用双向 `amends` / `amended_by`，本 PR 只在新 ADR 写了 `amends`，四份旧 ADR 的 front matter 没有 `amended_by`。不过近期 ADR 也有只写正文注、不写 `amended_by` 的做法，所以这可能是有意的局部惯例；若按 ADR 0031 的约定，这里是缺失的。

**建议**：给四份旧 ADR 补 `amended_by: "docs/adr/0242-..."`，或在本 ADR 说明为何不采用双向元数据。

### 11. 低 — 案例 91 的“之前没人注意”和“只按格式遮密码、卡号”说得过满

**文件:行**：`docs/engineering-casebook.md:5755`；`docs/adr/0219-read-only-mcp-entry-with-static-token.md:65,71-74`

**问题**：ADR 0219 决定 3 已写 `find_memories`“只返回模型能看到的那几档记忆”，而 ADR 0193 已把 sensitive 定为模型可见；说“之前没人注意”不准确。遮盖实际还覆盖验证码、证件号、机器密钥，不只是密码和卡号。

**建议**：改成“文档里没有把它当成对外暴露面来处理”或类似表述，并补全遮盖类别。

## 二、推测 / 未核实

- **外部资料引文未核实**：前提 13、14、15 引的 Claude Code、Codex 文档，以及案例 91 的 Claude、mem0、Supermemory 引文，都无法离线核对。尤其前提 14 只引了“Plain text on `stdout` is added as extra developer context”“Hooks are enabled by default”，并没有证明 Codex 的钩子事件与 Claude Code **同名**；决定 11 的“共用一个程序”因此缺少证据支持。
- **`/mnt/project-files/...` 未核实**：前提 1-4、19、编码任务清单、ADR 0228 的设计都引用了仓库外文件，无法读取。仓库内已确认没有 ADR 0228 和 `external_memory_proposals` 表，所以“还没进 main”这一条成立；其设计内容未核实。
- **`.agents/reviews/topic-p5-memory-hub/` 未核实**：文件在提交中存在（diff stat 显示 2932 字节等），但当前稀疏检出没有这些文件，`git show` 也被工具拒绝，无法核对 0.26 美元、六处错误、两个模型的具体说法。
- **作者跑过的文档检查未核实**：只读到了检查脚本和链接目标，无法确认 `validate_docs.py --strict` 等实际输出；文档链接、锚点、ADR 编号从阅读看是成立的。
- **“Himawari 自己发给模型的请求不变”**：本 PR 没有代码改动，当前成立；但 ADR 0242 决定 5 会往提示词目录加新条目，新增条目会进入 `TRUSTED_PROMPT_TEXTS` 一类固定文字集合。虽然大概率不影响旧请求，仍建议用 `check:prompt-prefix` 或专门测试确认新条目不会进入已有会话的系统提示/工具定义。

## 三、侧重检查

- **错误路径**：`sync_memories` 只定义了超上限整批拒绝，缺少中途写入失败、决策记录失败、逐条校验失败的完整语义，见发现 8。外部读取原有的 fail-closed 规则没有平移到新写入路径。
- **不合规范/不可信输入**：稳定编号“任意文字”、项目名来自远程地址、贴回文本交给低价模型解析，都存在未限长、未规范化或提示注入风险；发现 6、7 和“未核实”里的解析调用是相关点。项目笔记虽然加了“不是指令”的固定标签，但仍是另一个 agent 的不可信内容，模型端没有代码级隔离。
- **安全**：接入密钥可能进 URL/查询参数和访问日志；`today_context` 漏掉读取上限，会泄露 sensitive 提醒/摘要；服务令牌路径在多人场景下无法按登录人找库。以上分别见发现 1、5、6。
- **资源耗尽**：请求体已有 65,536 上限，但批量条数、稳定编号长度、项目笔记文件大小/数量、助手程序扫描目录的规模都没有具体上限；ADR 只列了“每个上限要在页面上显示”，没有给值。建议在编码任务里明确数值并补超限用例。
- **不可撤销操作**：对外不删除主人电脑上的文件，项目笔记删除留历史，已确认记忆不随来源删除，这些设计是安全的。但“全量名单删除”的调用方身份未定义，仍可能被模型误触发，见发现 4。
- **规则/说明/代码一致性**：ADR 0219 的遮盖注与代码相反（发现 2）；ADR 0227 决定 3 没有随 ADR 0242 更新（发现 3）；`amends` 缺少双向元数据（发现 10）；案例 91 的两处措辞过满（发现 11）。

## 四、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**当前不会。** 本 PR 只改文档，没有代码或测试改动，所以系统提示、工具定义、历史消息、遮盖结果都保持原样；当前的发给模型内容仍然只在末尾追加，每轮变化的值仍然在最后一条消息里（符合 `.claude/rules/prompt-prefix.md` 第 1、4、10 条）。

就 ADR 0242 描述的**未来**实现而言：`start_here` 是外部 MCP 的工具结果，按设计固定在最后追加；它把主人概况/规则摘要放前、今天的情况放后，符合“固定的在前、会变的在后”（ADR 0242:84）。`today_context` 仍返回 `now` 和 `today`（`production-mcp-read.ts:946-948`），必须保持为工具结果/最后一条消息，不能塞进系统提示或工具定义。另一个需要补证的是决定 5 新增的提示词目录条目：`check:prompt-prefix` 管不到 MCP 这一侧，ADR 自己也承认（:191），所以“Himawari 自己发给模型的请求不变”目前是**设计承诺**，还没有对应的自动检查证明。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**本 PR 没有代码改动，所以当前运行行为不变。** 但 ADR 0242 决定 14 和 ADR 0219 新注对现状的判断是错的：`maskSensitiveTexts` 返回的占位符会去掉内部 tag，现有测试明确断言同一段被点名文字不受同批无关内容影响（`redaction.unit.test.ts:380-384`）。真正会让同一段文字字节不同的是“裸值只有同批另一段点名时才被遮”这条规则（`redaction.unit.test.ts:369-378`，ADR 0219:73 已写明）。决定 14 的“按字段各自编号”没有解决这一点，反而可能引入新的字节变化。

另外，ADR 0242 自己要求“所有列表固定排序”（:148），但目前的检查只列了“同一份数据生成两次 `start_here`，字节相同”（:199），没有覆盖 `find_memories`、`rule_book`、`sync_memories` 的逐条结果和统计页面。建议为这些输出各补一条确定性和排序用例。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**没有可执行的改动，也没有新增测试。** 作者说“没有可执行改动，没有跑测试”是准确的。文档类检查是否存在、是否通过，我无法运行确认；从阅读看，新增的 `#case-memory-hub` 锚点、案例链接、ADR 链接和 `amends` 目标路径都存在。

问题在于：没有任何自动检查把“文档对现有代码的描述”与代码对上，所以新注里“后面的占位编号全变”这种错误不会被文档检查发现；相反，现有的 `redaction.unit.test.ts:380-384` 是一条会否定该说法的测试，但它不会在文档检查里跑。ADR 0242“后果”里列的检查（:191-200）都还是未来任务，反向用例尚未实现，不能说它们会失败。建议至少先补两类门槛：`today_context` 的读取上限反向用例；`sync_memories` 的整批失败/半批反向用例。

### 4. 改动产生或修改的每个值，两端都能接受吗？

- **`amends` 的四个路径**：`0219`、`0225`、`0226`、`0227` 都存在；但四份旧 ADR 没有 `amended_by`，和 ADR 0031 的双向约定不完全一致（低严重度，见发现 10）。
- **接入编号**：`subjectRef` 接受 1-256 字符文本（`sqlite-decision-ledger-operations.ts:63`），所以只要接入编号不超过 256 就能写入决策记录；但 ADR 没有规定格式和长度，也没有说明它是否会进入 `machineString` 字段。若进入，现有规则只允许 1-128 个 `[A-Za-z0-9._:-]` 字符（`validation.ts:49-56`），带 `-` 的 UUID 或带中文的编号会失败。见发现 6。
- **稳定编号**：ADR 正确地把“对方的稳定编号”当业务键、不直接当记忆编号（前提 10），这避开了 `machineString` 对路径的限制；但唯一键表、日志、页面能否接受“任意文字”没有说明，需要明确 text 列、限长和规范化。见发现 7。
- **项目名**：由远程地址/目录名生成，需先剥离凭据再规范化；ADR 目前没有这一层。见发现 7。
- **新工具名和参数**：`start_here`、`sync_memories`、`find_memories` 的 `project`/`auto` 目前没有代码；现有 `find_memories` 的 schema 是 `additionalProperties: false`（`production-mcp-read.ts:442`），编码时必须同时改 MCP 层 schema，不能只改检索层。ADR 已经说“两个参数在 MCP 这一层处理”（:88），这点是对的。
- **读取级别值**：`today_context` 的摘要消费者目前只接受 `modelVisibleClassifications()`（`service-main.ts:2266`），提醒消费者只排除 restricted（`production-reminder-writer.ts:288`），它们都还**不接受**新的接入读取上限。这是本 PR 最具体的“两端不匹配”，见发现 1。
- **案例 91 的 0.26 美元、六处错误、两个模型的讨论记录**：声称的出处是 `.agents/reviews/topic-p5-memory-hub/usage.jsonl` 和同目录文件；这些文件在提交中存在，但我无法读取内容，**未核实**。案例里的本地代码引文和设备/外部文档引文，分别属于“已核对”和“未核实”。

## 五、作者说法核对

- “只改文档，没有代码改动”：**正确**。
- “新增 ADR 0242、案例 91、四份旧 ADR 的注”：**正确**；注里的决定编号大多对得上（0219 的 2/3/4、0225 的 6/9、0226 的 9、0227 的 1），但 0219 决定 4 的**理由**错误，0227 的注没有覆盖决定 3。
- “前提 9：外部读取能读到 sensitive；`recallOutsideRun` 传的 `"public"` 是输出下限”：**与代码一致**（`production-memory-recall.ts:148,185,333`；`model-visibility.ts:10-14`）。
- “ADR 0242 声称 Himawari 自己发给模型的请求不变”：**当前代码不变**；未来实现仍需补 `check:prompt-prefix` 覆盖不到的 MCP/提示词目录验证。
- “案例 91 的结果数据写未测量”：**正确**；但 0.26 美元、六处错误和外部引文我无法核对，标**未核实**。
