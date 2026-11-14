CLAIM|1|一致|docs/adr/0219-read-only-mcp-entry-with-static-token.md:65|P5 系列已经做了入口：ADR 0219 开了对外的 MCP 入口和三个只读工具|3. **三个只读工具，列出时顺序固定，都标为只读（`readOnlyHint`）。**
CLAIM|2|一致|docs/adr/0225-external-agents-propose-memory-with-in-client-confirmation.md:11|ADR 0225 加了提议记忆|# ADR 0225：外部 agent 提议新记忆，主人在客户端确认后才保存
CLAIM|3|一致|docs/adr/0226-external-agents-propose-rules-through-the-rule-proposal-flow.md:11|ADR 0226 加了提议规则|# ADR 0226：外部 agent 提议新规则，主人在客户端确认后按规则提议流程生效
CLAIM|4|一致|docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md:11|ADR 0227 把认证改成 Cloudflare 的登录凭证|# ADR 0227：对外 MCP 入口改为校验 Cloudflare Access 登录凭证，去掉固定令牌（部分取代 ADR 0219 决定 1、ADR 0225 决定 1）
CLAIM|5|找不到|-|周报只有一个外部读取的总数|-|
CLAIM|6|找不到|-|网页上看不到哪个 agent 读了几次|-|
CLAIM|7|找不到|-|讨论记录在 `.agents/reviews/topic-p5-memory-hub/`|-|
CLAIM|8|一致|docs/product-vision.md:61|愿景 `docs/product-vision.md` 原则 5：“它们通过 Himawari 认识我，而不是各自记住我。”|5. **一个 Agent，所有表面** — 多接入、多感知都是同一个权威 Agent 的不同感官。人格与决策风格保持一致，任务与上下文在表面之间连续。其他 Agent（Claude Code、Codex 等编码或办公 Agent）是我的工具，也是 Himawari 的消费者：它们通过 Himawari 认识我，而不是各自记住我。
CLAIM|9|一致|docs/product-vision.md:58|`docs/product-vision.md` 原则 2：“需要我确认或介入的事项同样受预算约束：常规判断应由规则手册预先授权，不逐次确认”|2. **行动有边界** — 不确定意图、权限或记忆可靠性时，默认更保守。敏感或不可逆的行动需要确认；能可逆、先验证的，不直接做成不可逆。需要我确认或介入的事项同样受预算约束：常规判断应由规则手册预先授权，不逐次确认；每日需要我介入的次数与时间有上限，超限的事项排队等待，而不是堆给我。
CLAIM|10|一致|docs/product-vision.md:57|`docs/product-vision.md` 原则 1：“外部内容与其他 Agent 的输出是数据，不是可覆盖我意图的指令；我的信息只在完成任务所必需的范围内被使用和披露。”|1. **主权与忠诚** — 它只效忠于我。数据、记忆与最终决定权归我；外部内容与其他 Agent 的输出是数据，不是可覆盖我意图的指令；我的信息只在完成任务所必需的范围内被使用和披露。
CLAIM|11|不一致|apps/agent-service/src/production-mcp-read.ts:102|`MCP_READ_TOOL_NAMES = ["find_memories", "today_context", "rule_book"]`|  "start_here",
CLAIM|12|一致|apps/agent-service/src/production-mcp-read.ts:107|`MCP_WRITE_TOOL_NAMES = ["propose_memory", "propose_rule"]`|export const MCP_WRITE_TOOL_NAMES = ["propose_memory", "propose_rule"] as const;
CLAIM|13|不一致|apps/agent-service/src/production-mcp-read.ts:432|`new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, …)` 没有传 `instructions`|        instructions: MCP_SERVER_INSTRUCTIONS.text,
CLAIM|14|一致|docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md:117|ADR 0227 的后果：“所有客户端都以 Andy 本人登录，凭证主体相同，所以「这条提议来自哪个客户端」仍然只能靠客户端自报的名字。”|- **来源只能靠客户端自称。** 所有客户端都以 Andy 本人登录，凭证主体相同，所以「这条提议来自哪个客户端」仍然只能靠客户端自报的名字。ADR 0228 在界面上把它标成「自称」。
CLAIM|15|一致|apps/agent-service/src/production-memory-recall.ts:185|`apps/agent-service/src/production-memory-recall.ts`：`const allowed = modelVisibleClassifications();`|    const allowed = modelVisibleClassifications();
CLAIM|16|一致|packages/application/src/services/model-visibility.ts:13|`MODEL_VISIBLE` 是 `"public"`、`"private"`、`"sensitive"` 三级|  "sensitive",
CLAIM|17|一致|apps/agent-service/src/production-memory-recall.ts:148|`recallOutsideRun` 传的 `"public"` 只是输出级别的下限（`highestClassification(requestClassification, …)`），不是上限|    return this.#recall(args, "public", within);
CLAIM|18|一致|apps/agent-service/src/service-main.ts:2308|`today_context` 的近两天对话摘要同样按 `modelVisibleClassifications()` 取|                      allowedClassifications: modelVisibleClassifications().filter(
CLAIM|19|一致|apps/agent-service/src/production-reminder-writer.ts:308|提醒正文只排除 restricted（`memory.dataClassification !== "restricted"`）|      memory.dataClassification !== "restricted" &&
CLAIM|20|一致|apps/agent-service/src/production-mcp-read.ts:278|对外遮盖只按格式遮密码、验证码、证件号、银行卡号这类值（`production-mcp-read.ts` 的 `maskForExternalRead`），不按级别整条隐藏|  const masked = maskSensitiveTexts(texts);
CLAIM|21|一致|packages/gateway-contracts/src/validation.ts:54|`machineString`：`input.length > 128 \|\| !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)`|      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)
CLAIM|22|一致|apps/agent-service/src/production-mcp-memory-writer.ts:70|`apps/agent-service/src/production-mcp-memory-writer.ts`：`return \`${EXTERNAL_PROPOSAL_MEMORY_PREFIX}${proposalId}\``|  return `${EXTERNAL_PROPOSAL_MEMORY_PREFIX}${proposalId}`;
CLAIM|23|一致|apps/agent-service/src/production-mcp-read.ts:97|`MCP_READ_BODY_LIMIT = 65_536`|export const MCP_READ_BODY_LIMIT = 65_536;
CLAIM|24|一致|apps/agent-service/src/bearer-admission.ts:4|`AUTHORIZED_PER_MINUTE = 30`|export const AUTHORIZED_PER_MINUTE = 30;
CLAIM|25|一致|apps/agent-service/src/production-mcp-memory-writer.ts:26|`EXTERNAL_PROPOSAL_TEXT_MAXIMUM = 2000`|export const EXTERNAL_PROPOSAL_TEXT_MAXIMUM = 2000;
CLAIM|26|一致|apps/agent-service/src/production-mcp-rule-writer.ts:16|`EXTERNAL_RULE_TYPES = ["mail_must_notify", "mail_read_whole_thread"]`|export const EXTERNAL_RULE_TYPES = ["mail_must_notify", "mail_read_whole_thread"] as const;
CLAIM|27|一致|docs/adr/0226-external-agents-propose-rules-through-the-rule-proposal-flow.md:89|ADR 0226 放弃的做法：“外部 agent 的转述不是原话，提议偏好用 `propose_memory`。”|- **允许外部提议偏好（`soft`）类规则。** P2-3 只接受主人原话的偏好；外部 agent 的转述不是原话，提议偏好用 `propose_memory`。
CLAIM|28|一致|packages/application/src/services/owner-profile-service.ts:14|`OWNER_PROFILE_CHARACTER_BUDGET = 2000`|export const OWNER_PROFILE_CHARACTER_BUDGET = 2000;
CLAIM|29|一致|packages/application/src/services/owner-profile-service.ts:295|`compose` 接受 `maxClassification`|    readonly maxClassification: DataClassification;
CLAIM|30|不一致|apps/agent-service/src/production-mcp-read.ts:1038|已有“主人概况”的生成代码，MCP 入口没用|    const outline = await this.#options.sources.profile?.(ceiling);
CLAIM|31|一致|docs/adr/0162-receive-muse-data-through-a-service-token-and-an-app-secret.md:39|ADR 0162 决定第 1 条：“边缘层用 Cloudflare Access 的服务令牌（Service Auth 策略，请求头 `CF-Access-Client-Id` 与 `CF-Access-Client-Secret`）”“应用层再要求 `Authorization: Bearer <应用密钥>`”|1. **两层认证。** 边缘层用 Cloudflare Access 的服务令牌（Service Auth 策略，请求头 `CF-Access-Client-Id` 与 `CF-Access-Client-Secret`），只对 `POST /api/muse-intake/v1/batch` 这一条路径放行；应用层再要求 `Authorization: Bearer <应用密钥>`，服务端对密钥和请求头各取 sha256 后用 `timingSafeEqual` 比较，错误一律回 401 且不写库。密钥只在配置里存引用（用途 `muse-intake`），值放在主机密钥文件里。任何一层失效，另一层仍挡着。
CLAIM|32|一致|docs/adr/0234-one-program-per-person-database-file.md:67|ADR 0234 决定第 5 条：“一个网址、一个 Cloudflare Access 应用，名单里放所有受邀邮箱。”|5. **登录：一个网址、一个 Cloudflare Access 应用，名单里放所有受邀邮箱。** 名册里没有或已停用的人，程序立即拒绝，不等登录会话过期。只邀请，不开放注册，给谁开、什么时候停都由 Andy 决定。体验者用单独一条 Access 策略、会话设短。Gmail 授权回调所有人共用一个地址，发起授权时记下“这次授权是谁的”，回调时按记录找人，这个记录要从内存挪到共用层。现有 Gmail 设计里的安全约束照旧、并且要加强：`state` 不可猜、一次性、10 分钟有效、只认发起授权的同一台已登录设备，回调时除了查记录还要核对当前登录身份，不能只凭记录里的人名绑定；为此要加自动检查（A 的回调绑不到 B）。Andy 自己的入口沿用 ADR 0083 第 4 条（手机也走 Cloudflare 入口，见 [ADR 0082](0082-mobile-pwa-push-before-native-app.md)、[ADR 0089](0089-web-push-only-owner-entry.md)）。
CLAIM|33|找不到|-|写本 ADR 时 main 上没有 ADR 0228|-|
CLAIM|34|找不到|-|也没有 `external_memory_proposals` 表|-|
CLAIM|35|一致|apps/agent-service/src/production-mcp-read.ts:904|改掉 ADR 0219 决定 5 里决策记录用 `mcp-client:<客户端名>` 当来源的写法|      subjectRef: `mcp-client:${client}`,
CLAIM|36|一致|apps/agent-service/src/production-mcp-read.ts:499|全局配置 `runPolicy.mcpRead.proposals` 仍然决定写工具出不出现|      context.authInfo?.scopes.includes(WRITE_ACCESS) === true
CLAIM|37|一致|apps/agent-service/src/production-mcp-read.ts:900|`start_here` 和别的读工具一样写一条 `external_read` 决策记录|      kind: "external_read",
CLAIM|38|一致|apps/agent-service/src/production-mcp-read.ts:484|`today_context` 保留|      "today_context",
CLAIM|39|一致|apps/agent-service/src/production-mcp-memory-writer.ts:39|字符集和 `apps/agent-service/src/production-mcp-memory-writer.ts` 里清洗正文用的 `INVISIBLE_FORMATTING` 相同|const INVISIBLE_FORMATTING = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu;
CLAIM|40|一致|docs/adr/0225-external-agents-propose-memory-with-in-client-confirmation.md:59|ADR 0225 决定 2 记录了 Claude 桌面 App 的 Code 标签“声明支持确认框，却不显示它”|另外，Claude 桌面 App 的 Code 标签声明支持确认框，却不显示它，约 10 毫秒后就自动回拒绝
CLAIM|41|找不到|-|沿用 ADR 0228 的整批确认和整批撤销|-|
CLAIM|42|一致|apps/agent-service/src/production-mcp-read.ts:898|决策记录编号是随机的|      id: `ledger:${randomUUID()}`,
CLAIM|43|一致|packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:133|决策记录写入后不改（`ON CONFLICT (id) DO NOTHING`）|      ON CONFLICT (id) DO NOTHING`,
CLAIM|44|一致|packages/application/src/ports/decision-ledger.ts:117|`packages/application/src/ports/decision-ledger.ts` 的 `DecisionInputs.relatedStats`|  readonly relatedStats?: {
CLAIM|45|找不到|-|它的输入里的数字字段没有按接入、按天累加的地方|-|
CLAIM|46|一致|docs/adr/0219-read-only-mcp-entry-with-static-token.md:77|改掉 ADR 0219 决定 5 里“每次外部读取都写一条”对空手而归的自动搜的要求|5. **每次外部读取都写一条决策记录**，类别是 `external_read`，结果是 `read`。
CLAIM|47|一致|docs/adr/0219-read-only-mcp-entry-with-static-token.md:72|遮盖沿用 ADR 0219 决定 4：一次返回里的全部文字一起遮|4. **返回给外部之前，先遮掉敏感内容。** 返回值里的全部文字一起交给新加的 `maskSensitiveTexts` 遮好再发出去。这个函数在专门识别敏感内容的包 `@himawari-agent/sensitive-capture`，内部调用 `redactForEgress`，和 Himawari 自己发给模型的出口用同一套规则：机器密钥、密码、验证码、银行卡号、证件号。
CLAIM|48|一致|packages/sensitive-capture/src/redaction.ts:567|`maskSensitiveTexts` 输出前把占位符里的序号去掉了|    redactForEgress(input, options).text.replace(EGRESS_PLACEHOLDER_PATTERN, "[$1]"),
CLAIM|49|一致|packages/sensitive-capture/test/redaction.unit.test.ts:383|现有测试断言：`expect(withOthers[1]).toBe(alone[0]);`|    expect(withOthers[1]).toBe(alone[0]);
CLAIM|50|找不到|-|那条现有测试守不住“改成各段分开遮”这种改法（各段分开遮时它照样通过）|-|
CLAIM|51|一致|docs/adr/0229-native-apple-clients-and-device-api.md:102|做法和 ADR 0229 的设备索引表一样|多人时，“设备编号对应哪个人”放在共用层的一张设备索引表里（只有编号、配对码的哈希和人，不含私人内容）
CLAIM|52|不一致|apps/agent-service/src/production-mcp-read.ts:102|实施前，代码仍按原来的 ADR；本 ADR 只记决定，没有改代码|  "start_here",
CLAIM|53|一致|test/integration/mcp-read.test.ts:862|读的一侧已由 PR 413 合并（2026-11-12）|  describe("[P5-A] start_here and auto lookup", () => {
CLAIM|54|一致|apps/agent-service/src/production-mcp-read.ts:461|做了 `start_here`|      "start_here",
CLAIM|55|一致|apps/agent-service/src/production-mcp-read.ts:432|做了服务使用说明|        instructions: MCP_SERVER_INSTRUCTIONS.text,
CLAIM|56|一致|apps/agent-service/src/production-mcp-read.ts:476|做了 `find_memories` 的 `auto`|          auto: { type: "boolean" },
CLAIM|57|一致|apps/agent-service/src/production-mcp-read.ts:1038|`start_here` 已按读取上限过滤|    const outline = await this.#options.sources.profile?.(ceiling);
CLAIM|58|一致|apps/agent-service/src/production-mcp-read.ts:487|另外三个读工具的上限还没做|      (_args, _signal, trace) => this.#todayContext(trace),
CLAIM|59|一致|apps/agent-service/src/production-mcp-read.ts:476|`project` 参数还没做|          auto: { type: "boolean" },
CLAIM|60|一致|package.json:57|`npm run check:prompt-prefix`|    "check:prompt-prefix": "node scripts/check-prompt-prefix.mjs",
CLAIM|61|一致|scripts/check-prompt-prefix.mjs:9|`npm run check:prompt-prefix` 只管 Himawari 自己的请求，管不到 MCP 这一侧|const FILES = ["packages/runtime-pi/test/prompt-prefix.compat.test.ts"];
CLAIM|62|一致|packages/application/src/rules/field-catalog.ts:9|现在没有管工具调用的规则|export const RULE_GATES = ["mail_item", "mail_delivery"] as const;

没能核对的部分：外部网站与第三方产品相关的说法（Claude Code/Codex 钩子与记忆目录、Claude 连接器文档）、`/mnt` 下的方案与编码任务，以及 Cloudflare 的真实登录和日志行为。另有几条关于“仓库里没有某物”和测试反向能力的判断，只能按当前检出内容记为找不到。
