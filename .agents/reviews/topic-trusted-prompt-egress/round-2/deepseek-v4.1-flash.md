## 结论概览

方案对主问题的诊断是对的：`MEMORY_CAPTURE.text` 里“验证码”与“confidence 是 0 到 1000”确实在 40 字窗口内，`1000` 会被 `redaction.ts:256-266` 当成验证码。用“固定指令不参与检查”来修复方向合理。

但方案把“受信任”实现成**对整个请求里任意字符串做内容匹配**，信任范围过宽；并且它改变了每次发送时对已冻结系统提示和历史的再遮盖输入，却没有完整处理随之而来的字节稳定性和漏遮路径。门槛部分也有几处不能真正证明“撤掉修复就会失败”。我建议把信任改成**按构造点/层的显式区间**，或者至少只跳过“完全落在固定文字内部”的匹配，不要把所有窗口都在固定文字边界切断。

---

## 已证实的问题（按严重度）

### 1.【高】内容匹配 + 切断关键词窗口会制造漏遮路径，方案的风险评估不完整

**问题**
方案第 1 节明确写“关键词窗口不会跨过受信任区间，也不会跨到另一段缝隙”。这意味着：

- 如果“验证码”在主人消息/工具结果的前一段，真正的验证码在后一段，而两段之间夹着任何一段不少于 24 字的固定文字，**真正的验证码不会被遮**。
- 如果一段数字/卡号/证件号正好跨在固定文字边界上，匹配会被切成两段，可能整段不再满足规则。
- 密码赋值 `密码：值`、`尾号` 前缀、日本个人番号关键词等规则都按同一字符串匹配；固定标签和动态值一旦被切开，动态值会漏遮。

方案的风险节只说“外来内容原样包含一整段固定指令……代价是这个秘密照样是外来内容自己带来的”。这只覆盖了“秘密也由外来内容提供”的情况，没有覆盖：

- 主人自己粘贴固定指令原文，把关键词和真实验证码分开；
- 工具结果/网页内容回显了主人的一条带关键词的消息，同时攻击者插入一段固定指令把二者隔开；
- 未来任何模板提示词把“密码：”之类的固定标签放在 slot 前面，slot 里的真实值会漏遮。

**证据**
- `packages/sensitive-capture/src/redaction.ts:67`：`CODE_WINDOW = 40`。
- `redaction.ts:256-266`：验证码依赖前后 40 字窗口。
- `redaction.ts:215-220`：密码规则把标签和值放在同一个正则匹配里。
- `redaction.ts:245-254`：日本个人番号依赖关键词窗口。
- 方案第 1 节：“关键词窗口不会跨过受信任区间，也不会跨到另一段缝隙。”
- 现有设计本来就用固定 footer 隔开运行环境块（`docs/adr/0164-move-changing-values-out-of-the-request-head.md:66`），但方案把这种“隔断”扩大到了全部提示词文字。

**建议**
把规则改成“**只跳过完全落在受信任区间内的匹配；只忽略完全落在受信任区间内的关键词；非受信任文字里的关键词仍然可以跨边界看窗口**”。这样：

- `MEMORY_CAPTURE.text` 里的 `1000` 完全落在受信任区间内 → 不遮（修复 bug）；
- 固定文字里的“验证码”完全在受信任区间内 → 不提供关键词（修复误报来源）；
- 主人消息里的“验证码”和后面的真实值即使中间夹着固定文字 → 仍能遮。

如果实现上难以做“跨边界窗口”，至少应只信任**已知构造点**的固定文字，而不是任意出现位置；并补一条安全反向用例：在关键词和真实验证码之间插入一整段固定指令，验证码仍必须被遮。

---

### 2.【高】清单随提示词目录变化，老对话的已发字节会在以后再次变化，与规则第 6 条冲突

**问题**
方案说“改提示词文字会改变清单，但改提示词本来就只对新对话生效；老对话冻结的旧文字不在新清单里时，按修复前的方式整段检查，字节和修复前一样。”这个推理不成立：

1. 本次修复上线后，老对话每次发送都会用**当时的清单**重新遮盖冻结的系统提示和历史。
2. 以后某次提示词改动把旧文字 `T_old` 从目录删掉/替换成 `T_new`，`T_old` 不再受信任。
3. 如果 `T_old` 里原来有一个误报（例如“验证码……1000”），老对话的冻结系统提示会重新被遮，**已发前缀字节发生变化**。
4. 这违反“改了提示词文字，只对新对话生效”（`.claude/rules/prompt-prefix.md:41-43`），也违反“已发内容不得改动”（同文件第 35 条）。

方案只考虑了“修复上线这一次”的字节变化，没有考虑“以后的提示词改动会再次改变老对话的再遮盖结果”。

**证据**
- `.claude/rules/prompt-prefix.md:35-36`：历史存遮盖前内容，每次发送按确定规则重新遮盖；密钥不变、前面的历史不变时字节相同。
- `.claude/rules/prompt-prefix.md:41-43`：系统提示和工具按对话冻结；改提示词文字只对新对话生效。
- `docs/adr/0165-freeze-the-request-head-per-conversation.md:58-62`：冻结的是组装好的系统提示字节，出口层每次请求再接占位符说明。
- `packages/application/src/services/model-egress.ts:189-219`：每个字符串在发送时重新跑 `redactForEgress`。
- 方案“对请求开头的影响”最后一段的推理。

**建议**
二选一，并写进 ADR：

- **版本化/冻结清单**：把受信任文字清单和线程的系统提示冻结代数绑定，老对话继续用冻结时那一版的清单；或
- **只增不减**：保留历史提示词文字的“已废弃受信任清单”，目录删掉旧文字后旧文字仍受信任；或
- 明确接受“以后改提示词会让老对话缓存再失效一次”，并把它写成 ADR 后果，更新 `.claude/rules/prompt-prefix.md` 的例外说明。

无论选哪种，都应加一条测试：模拟目录文字变化后，重新遮盖同一段老历史，字节不变（或按 ADR 预期变化）。

---

### 3.【中】门槛测试有几处不能真正反向验证，且没有接进 `npm run check`

**问题**

- `check:egress-redaction` 是**静态检查脚本**，不是 vitest 命令。方案说“放进 `check:egress-redaction` 或 `check:prompt-catalog` 的 vitest 命令”，但前者没有 vitest 命令可放。新测试必须显式加到 `check:prompt-catalog` 的 vitest 文件列表，或新建一个 `check:*` 并加入 `check:steps`。
- `check:prompt-prefix` 只跑名字带 `[I-66]` 的用例；把 `[I-78]` 加到 `prompt-prefix.compat.test.ts` 也不会被 `npm run check:prompt-prefix` 跑到。
- “对目录里每个条目，用无害的假值（例如‘示例’）填满槽位”不能覆盖“固定文字里的关键词 + 动态 slot 里的数字”这种边界；应使用带数字/秘密形状的填充值（如 `示例482910`、`hunter22abc`）。
- “固定指令末尾紧挨着 JSON，JSON 里有一个不带关键词的 6 位数字 → 不遮”对真实的 `memoryCapturePrompt` 不是有效复现：`MEMORY_CAPTURE.text` 最后一个敏感关键词离结尾很远，修复前也不会遮。真正复现是 `confidence 是 0 到 1000`，方案已有单独用例，这条边界用例应改成正向/反向都成立的构造，或删除。
- 反向用例“清单为空时会被遮”只证明了函数会遮，不证明生产接线；需要让正向用例走**生产工厂**（`createProductionModelEgress`）并在测试里用空清单版本证明失败，或加静态检查确认生产工厂传入了清单。
- 现有 `egress-himawari-text.unit.test.ts` 的第一个用例目前没有传 `trusted`；如果不同时更新它传入真实清单，它并不能守住方案声称的“两阶段 known”行为。
- I-78 要写进 `docs/incidents-and-gates.md`，状态 `已落门槛` 时门槛单元格必须含一个**真实存在的仓库路径**，否则 `check:incident-gates` 会失败。方案只说“上面的测试文件”，没有给路径。

**证据**
- `package.json:42`：`check:egress-redaction` 是 `node scripts/check-egress-redaction.mjs`。
- `package.json:44`：`check:prompt-catalog` 只跑固定几个文件。
- `package.json:27`：`check:steps` 是实际的门槛链。
- `scripts/check-prompt-prefix.mjs:8-10,27`：只取 `[I-66]`。
- `packages/application/test/egress-himawari-text.unit.test.ts:33-38`：`redactForEgress` 调用没有 `trusted`。
- `scripts/check-incident-gates.mjs:65-70`：`已落门槛` 必须写出存在的路径。

**建议**
把门槛拆成一组明确的用例：

1. **生产接线正向**：用 `createProductionModelEgress` + 真实 `PiModelTransport` / `PiRuntimeAdapter` 发本机回环请求；断言 `memoryCapturePrompt` 的 `confidence 是 0 到 1000` 原样发出，`report` 为空。
2. **生产接线反向**：测试专用工厂传空清单，断言同一请求 `1000` 被遮且 `report` 非空。
3. **通用目录用例**：每个 `fixedPrompt` 原文包含关键词和数字时原样通过；每个 `templatePrompt` 用含数字/密码形状的填充值填 slot，断言固定文字不被遮，且 slot 里的真实秘密按规则被遮。
4. **安全反向**：在主人/工具内容的“验证码”和真实值之间插入一段完整固定指令，真实值仍必须被遮（或明确接受风险并写进 ADR）。
5. **边界**：重复出现、嵌套/重叠的受信任文字、空字符串、空清单、超长输入、跨边界数字。
6. **确定性**：同一输入遮两次字节相同。
7. **接线检查**：`check:steps` 里至少有一个步骤会跑这些用例；I-78 的门槛单元格写具体测试文件路径，并让该文件在 `check` 中真实存在。

另外，建议把 `[I-78]` 用更明确的命令名如 `check:egress-trusted`，避免和 `[I-66]` 的过滤逻辑混淆。

---

### 4.【中】`trusted` 作为公共选项没有校验；空字符串会等于关闭全部遮盖

**问题**
方案把 `trusted` 设计成 `readonly string[]`，但没有规定空字符串、重复项、未排序、超长项的处理。按最直接的实现：

- `trusted` 含 `""` 时，空串在任意位置都能匹配，可能把整个输入当成受信任区间，**所有遮盖失效**。
- 未排序清单若实现依赖“最长优先”，不同调用方顺序不同会得到不同结果。
- 清单过长/过大没有上限。

`redactForEgress` 是公开函数，`credentialFindings`、`findSensitiveValues`、`locateMaskedValues`、`maskSensitiveText` 都直接调用它（`redaction.ts:301-321`）。即使生产只传 `trustedPromptTexts()`，未来测试或其他调用方也可能传入不安全清单。

**证据**
- `packages/sensitive-capture/src/redaction.ts:48-53`：`EgressRedactionOptions` 没有 `trusted` 校验。
- `redaction.ts:171`：公开导出。
- `redaction.ts:301-321`：多个调用方使用默认选项。
- 方案第 1 节只说“已排好序的固定文字清单”，没有说函数会校验。

**建议**
在 `redactForEgress` 内部：

- 过滤空字符串和纯空白项；
- 去重；
- 不依赖调用方顺序（内部排序或匹配算法本身不依赖顺序）；
- 对清单数量和单项长度设上限，超出时拒绝或截断并记录；
- 明确空清单等价于“没有受信任文字”，而不是“全部信任”。

并补一个测试：`trusted: [""]` 不能关闭遮盖。

---

### 5.【中】清单注入点前后矛盾：`ModelEgress` 自动取清单 vs 生产调用点传入

**问题**
方案第 2 节说“`ModelEgress` 构造时从 `@himawari-agent/prompt-catalog` 取这份清单”。但第 3 节又说“有人从生产调用点撤掉清单时，正向用例就会失败”。如果 `ModelEgress` 自动取，生产就没有“调用点清单”可撤；如果从生产调用点传入，方案第 2 节的描述就不对。

这不是文字问题，会影响测试和耦合：

- `ModelEgress` 是通用出口，自动依赖提示词目录会把“模型网关”与“提示词文字”绑死。
- 大量单元测试直接 `new ModelEgress(...)`（如 `packages/application/test/model-egress.unit.test.ts:21`、`packages/testing/src/model-egress.ts:4`）。自动取清单会改变所有测试的默认行为。
- 生产工厂是 `createProductionModelEgress`（`apps/agent-service/src/production-model-egress.ts:64-88`），这是唯一适合注入的位置。

**证据**
- `packages/application/src/services/model-egress.ts:472-481`：`ModelEgress` 构造器。
- `apps/agent-service/src/production-model-egress.ts:64-88`：生产工厂。
- `packages/application/test/model-egress.unit.test.ts:21`：测试直接构造。
- `packages/testing/src/model-egress.ts:4`：测试 helper。

**建议**
在 `createProductionModelEgress` 里注入 `trustedPromptTexts()`，`ModelEgress` 的 `trusted` 选项默认空；生产路径测试用 `createProductionModelEgress`。再加一个静态检查（可以放进 `check:egress-redaction` 或新检查）确认生产工厂确实传入了非空清单，避免有人删掉。

---

### 6.【低】性能上限说法不准确：工具结果/网页内容不是“几十 KB”

**问题**
方案说“请求体里的字符串最长几十 KB”。但网页抓取内容在 `public-web-adapter.ts` 允许 `maximumCharacters: 200_000`，附件长文本也可能很大；这些内容会进入 `tool_result` / `file` 等字符串。按约 100 个受信任片段、每个字符串做 `includes`，最坏情况下是“100 × 200K”级别的比较，不是可以无条件忽略的常数。

这不是阻塞项，但方案里的“开销可以忽略”结论缺少依据。

**证据**
- `packages/integration-web/src/public-web-adapter.ts:120`：`maximumCharacters: 200_000`。
- `packages/application/src/services/model-egress.ts:189-219`：每个字符串单独跑遮盖。
- `packages/sensitive-capture/src/redaction.ts:256-266`：本来就对每个数字跑窗口。

**建议**
用真实上限做一次基准测试；如果清单增长，考虑多模式匹配（如 Aho–Corasick）或只对非 `tool_result`/`web_page`/`file` 的层做内容信任。至少把方案里的“几十 KB”改成“受实际字符串上限约束”，并给出测量结果。

---

### 7.【低】第 4 节 UI 改法描述不准确，且缺少边界规则

**问题**

- “对话里的聊天调用：`对话「标题」· 你的话`”**已经是现状**（`sensitive-interceptions.tsx:99-104` 对 thread 记录显示 title + part，chat 的 part 是 `owner_message`），这不是本次改动。
- 方案没有定义 `purpose` 为 `null`、`"other"`、未知值时的显示规则；数据库只校验 `purpose` 是 1-64 字符的字符串（`sqlite-sensitive-interception-operations.ts:49`），不是枚举。
- “出处是 `tool_result`、`file` 等更具体的值时照常显示”没有定义优先级：当 `purpose` 是后台用途、`part` 是 `memory_source`/`memory_candidate`/`tool_result` 时，到底显示 purpose 还是 part？方案没有说。
- `memory-episode-${index}` 被归一化这一点**已核实正确**：`production-memory-episode` 传原始字符串，`service-main.ts:1923` 用 `modelUsagePurpose` 归一；但方案不应只凭这一条就认为所有 purpose 都安全。

**证据**
- `apps/control-center/src/components/sensitive-interceptions.tsx:99-116`：`where()` 逻辑。
- `apps/control-center/test/sensitive-interceptions.unit.test.ts:65`：现有断言就是“对话「家里网络设置」 · 你的话”。
- `packages/application/src/ports/model-usage.ts:58-63`：`modelUsagePurpose` 归一。
- `apps/agent-service/src/service-main.ts:1919-1930`：`modelUsagePurpose(purpose)`。
- `packages/persistence-sqlite/src/sqlite-sensitive-interception-operations.ts:49`：`purpose` 只做长度校验。
- `packages/application/src/services/sensitive-interception-recorder.ts:63-81`：egress 记录的 purpose 来自 `context.purpose`。
- `packages/application/src/services/sensitive-interception-recorder.ts:83-109`：memory audit 记录 purpose 固定为 `"memory-capture"`。

**建议**
在 `where()` 里写清楚：

- 如果 `purpose === "chat"`，显示 part（保持现状）；
- 如果 `purpose` 是已知后台用途且 `part` 是 `owner_message`/`system` 等“泛化”值，显示 purpose；
- 如果 `part` 是 `tool_result`/`file`/`command_output`/`web_page`/`mail`/`memory_source`/`memory_candidate` 等具体值，part 优先或按明确规则显示；
- `purpose` 为 null/未知时回退到 part，不要显示“其他”；
- 组件测试覆盖：chat、thread-title、memory-capture、memory_source、tool_result、null purpose、未知 purpose。

---

### 8.【低】规则/文档/ADR 没有同步更新

**问题**
方案只加 I-78 事故条目，没有 ADR，也没有更新规则文件。这个改动改变的是出口遮盖的输入和稳定性保证，属于 `.claude/rules/prompt-prefix.md` 第 11 条和 ADR 0165/0164 的范围。至少应更新：

- `.claude/rules/prompt-prefix.md` 第 11 条/第 5 条：说明“受信任固定文字清单”是再遮盖的另一个输入，以及它的版本/冻结方式。
- `docs/kv-cache-guide.md`：同上。
- `docs/adr/0164...` 里“用不含数字、超过 40 字的固定句结尾”的说明：如果方案认为 footer 不再必要，应写明它现在只是纵深防御；否则保留并说明仍是必需的。
- 新增 ADR（或修订 ADR 0167/0148），记录“内容匹配信任”的取舍、漏遮风险、版本化决定。
- `packages/sensitive-capture/README.md` 如果新增 `trusted` 选项，说明它不属于识别规则，但仍影响出口行为。

**证据**
- `.claude/rules/prompt-prefix.md:35-36,52-53`。
- `docs/kv-cache-guide.md:97`。
- `docs/adr/0164-move-changing-values-out-of-the-request-head.md:66`。
- 方案第 5 节只写“事故清单加 I-78”。

**建议**
把 ADR/规则更新作为方案的一部分，而不是实施时顺手补。尤其要写清楚第 2 条里的“提示词目录改动是否会使老对话字节变化”。

---

## 推测的问题

以下问题不是从当前代码直接证实的，但按方案的实现方式很可能出现：

1. **未来模板提示词把敏感标签放在 slot 前**（如 `密码：${slot}`）会漏遮。当前目录里没有这种模板（我扫过 `memory.ts`、`chat.ts`、`tool.ts`、`background.ts`、`mail.ts`），但方案的门槛用“示例”填充值抓不到它。
2. **未来新增的短固定片段（<24 字）含敏感关键词**，不会被纳入受信任清单，仍可能误遮动态数字。当前含关键词的条目都远长于 24 字（`memory.capture`、`mail.judgment`、`chat.egress-legend*`、`tools.web-fetch`），所以现在没问题。
3. **内容匹配的漏遮在真实生产中的触发频率**取决于主人/工具内容是否原样包含整段提示词；这无法从代码核实，只能靠测试和风险接受。
4. **清单增长后的性能**：目前约 100 段，若未来继续增长且遇到 200K 字符串，最坏比较次数会明显上升。

---

## 侧重检查

我按你给的侧重点逐项检查过：

- **错误路径**
  - `ModelEgress.#prepare` 对非 URL、请求自带 body、无 body、非文本 body、非 JSON、未知路径都会 `refuse`（`model-egress.ts:162-231`）。新增 `trusted` 不改变这些路径。
  - `redactForEgress` 的 `observe` 抛错被吞掉，不影响遮盖结果（`redaction.ts:178-185`）。
  - `assertMachineSecretFree` 在 `model-egress.ts:213-217` 对遮盖后的结果再检查；即使受信任文字里有机器密钥形状，也会被拒绝，这一点是安全的。
  - **问题**：`trusted` 为空字符串/空项时没有错误路径定义，可能静默关闭遮盖（见第 4 条）。

- **不合规范或不可信输入**
  - `tool_result`、`web_page`、`file`、`mail`、`command_output` 是不可信内容；方案的 content matching 会信任这些字符串里任意出现的固定文字（见第 1 条）。
  - `purpose` 从 DB 读回后只做长度校验，不保证是枚举；UI 必须处理 null/未知（见第 7 条）。
  - 模板 slot 的填充值由模型/工具/主人提供，未来可能出现“固定标签 + 动态秘密”的组合（推测问题 1）。

- **安全**
  - 主要风险是受信任文字造成的**漏遮**，不是机器密钥泄漏（机器密钥仍由 `assertMachineSecretFree` 兜底）。
  - 内容匹配信任使攻击者只要能让不可信内容包含一段公开的提示词文字，就能切断关键词窗口；如果该字符串里同时有主人的真实秘密（例如工具结果回显），就可能漏遮。
  - 方案对“固定指令本身不含秘密”的判断成立（我扫过目录，除示例占位符 `尾号1111`、`1000` 外没有真实秘密）。
  - 历史再遮盖的字节稳定性问题（第 2 条）既是缓存问题，也是“已发内容不得改”的规则问题。

- **资源耗尽**
  - 每个字符串对约 100 段固定文字做字面匹配；网页内容上限 200,000 字符（`public-web-adapter.ts:120`），不是方案说的“几十 KB”。需要真实基准；目前看不是阻塞项，但如果清单扩大，建议多模式匹配或限制到非不可信层。

- **不可撤销的操作**
  - 方案本身不写数据库、不改历史存储、不删除内容，UI 只读；没有不可撤销的数据操作。
  - 但“再遮盖结果变化”会让老对话的已发前缀失效一次（或多次），属于需要 Andy 明确同意的缓存/规则后果，不是代码上的不可逆写入。

- **规则文件、说明文档和代码是否一致**
  - 不一致点：方案只加事故，没有 ADR/规则更新；`prompt-prefix.md` 第 11 条的例外还是按“值”描述，没有提到“固定文字清单”这个新输入；ADR 0164 仍把 footer 当作必要措施，而方案说它不再必要。
  - `check:egress-redaction` 是静态脚本，方案却把它当成 vitest 命令来挂测试，这是文档/命令不一致（第 3 条）。

---

## 如果由我来定，我会怎样改这份方案

1. **先确认主 bug 的最小修复面**
   - 只针对已确认的 `memoryCapturePrompt` 误报做测试和修复，不要一上来把“所有提示词文字”都纳入信任。
   - 用现有 `prompt-prefix.compat.test.ts` 的回环抓包方式证明：修复前 `1000` 被遮、修复后原样发出。

2. **优先考虑结构分离，而不是全局内容信任**
   - 对后台调用（整理记忆、起标题、邮件判断、情景摘要、合并记忆），把固定指令和动态 JSON 放到**不同的消息/字符串**（例如固定指令进 system，数据进 user），或至少保证它们不是同一个字符串。
   - 这样 egress 的每个字符串只包含“固定”或“动态”之一，根本不需要内容匹配；也不会切断主人/工具内容里的关键词窗口。
   - 代价是请求结构变化、模型输入位置变化，需要重新看整理记忆/标题的输出；但这比引入一个全局信任匹配的漏遮面更可控。如果团队不接受结构变化，再走第 3 条。

3. **如果必须保留内容匹配，改成“显式区间 + 精确规则”**
   - 由提示词构造层返回 `{ text, trustedRanges }`，或至少只在 `system`/后台固定指令/已构造的固定前缀上启用，不要在所有 `tool_result`/`web_page`/`file` 字符串里按内容信任。
   - 规则改为：
     - 完全落在受信任区间的匹配不遮；
     - 完全落在受信任区间的关键词不提供上下文；
     - 非受信任文字里的关键词仍可跨边界看窗口；
     - 跨边界的数字/卡号/证件号匹配要显式处理，不能简单切段。
   - 对 `trusted` 做空串过滤、去重、数量/长度上限；不依赖调用方排序。

4. **清单的稳定性**
   - 在 ADR 里明确：清单是再遮盖的输入，必须版本化或只增不减；否则以后改提示词会让老对话缓存再次失效。
   - 如果决定“每次改提示词就接受一次老对话前缀变化”，就把它写进 `prompt-prefix.md` 和 ADR，并加测试证明这是预期行为。

5. **门槛**
   - 新增一个真实的 `check:*` 步骤或扩展 `check:prompt-catalog`，把 `[I-78]` 用例列进去，确保在 `check:steps` 中运行。
   - 用 `createProductionModelEgress` 做正向；用空清单版本做反向；用危险填充值（数字、密码形状）覆盖模板 slot；加“受信任文字夹在关键词和真实秘密之间仍要遮”的安全反向。
   - 更新现有 `egress-himawari-text` 测试传入真实 `trusted`，否则它守不住两阶段 known 行为。
   - I-78 的门槛单元格写具体测试文件路径；确认 `check:incident-gates` 能通过。

6. **UI 改动单独做，规则写清楚**
   - chat 保持现状；background 在 thread 内显示 purpose；`tool_result`/`file`/`memory_source`/`memory_candidate` 等具体 part 的优先级写清楚；null/未知 purpose 回退到 part。
   - 增加组件测试，而不是只依赖 Playwright。

7. **文档**
   - 新增 ADR 或修订 ADR 0167/0148；同步更新 `.claude/rules/prompt-prefix.md`、`docs/kv-cache-guide.md`、ADR 0164 的 footer 说明、`sensitive-capture/README.md`。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**结构上不会，字节上会有例外。**

- 方案没有增加、删除、重排请求字段；系统提示、工具定义、历史、最后一条消息的顺序不变；每轮变化的时间、记忆、运行环境仍然只在最后一条消息里。工具定义本来就不参与遮盖（`model-egress.ts:325-344,441-448`），不会因新清单改变。
- **但是**，系统提示和历史里存的是遮盖前内容，每次发送时重新遮盖（`.claude/rules/prompt-prefix.md:35-36`；`docs/adr/0165...:58-62`）。本次修复会改变“哪些固定文字被跳过”，因此：
  - 如果已发历史里粘贴过整段固定指令，或系统提示里恰好出现误报，部署后这些前缀的字节会变一次。
  - 以后改提示词目录时，老对话的冻结系统提示可能因为清单变化而再次改变字节（第 2 条）。这不是“只在末尾追加”。
- 每轮会变的值是否都在最后一条消息：**是**，本次改动没有把时间、记忆、运行环境等挪到系统提示或历史；它只改变遮盖函数。

结论：**请求结构仍然只追加；但“已发字节永远不变”不成立，方案对第 2 条的例外说明也不完整**，需要 Andy 明确接受并写进 ADR。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**在同一构建、同一清单、同一历史前缀下，基本仍然确定；但有三个新增变量：**

1. **清单随提示词目录变化**（第 2 条）：同一段老历史在不同构建下可能被遮成不同字节。
2. **清单本身如果有空串、重复、未排序**，不同调用方/实现可能得到不同结果（第 4 条）。
3. **按缝隙切分后，跨边界匹配和 known 替换的边界条件会变**：同一段文字单独出现 vs 被固定文字包围时，可能因为边界字符消失而多遮/少遮（第 1 条）。

另外，方案里的“先对所有缝隙逐段认值、再统一 known 替换”必须明确是**对单个输入字符串**做的，不能对整个请求体做；否则后面消息里认出的值会回头改前面已发历史，直接违反规则第 11 条。方案文字“所有缝隙”容易被实现成请求级，需要在方案里写死“每次 `redactForEgress` 调用内部”。

结论：**不是无条件确定**；需要固定清单版本、校验清单、明确两阶段作用域。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有，但按方案现在的写法不够。**

- 正向：真实 `PiModelTransport`/`PiRuntimeAdapter` + 真实 `ModelEgress` 回环抓包，方向正确。
- 反向：
  - “清单为空时会被遮”只测函数，不证明生产接线；需要生产工厂空清单版本或静态接线检查。
  - “每个条目用‘示例’填槽”不能覆盖“固定关键词 + 动态数字”的边界；要用危险填充值。
  - “固定指令末尾紧挨 JSON 的 6 位数字”不是 `memoryCapturePrompt` 的真实复现，修复前可能也不会遮。
  - 现有 `egress-himawari-text` 用例没有传 `trusted`，不能守住两阶段 known。
  - 新测试没有明确接进 `check:steps`；`check:egress-redaction` 是静态脚本，不是 vitest；`check:prompt-prefix` 只跑 `[I-66]`。
  - I-78 的门槛单元格需要真实路径，否则 `check:incident-gates` 会失败。

结论：**方向对，但反向证明链不完整；需要补齐并真正接入 `npm run check`。**

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐个核对：

- **`trusted` 选项**
  - 产生：`trustedPromptTexts()` 或生产工厂。
  - 使用：`redactForEgress`。
  - 校验：目前没有。空串可关闭遮盖，重复/无序可能改变匹配，超长无上限。需要加校验（第 4 条）。
- **`trustedPromptTexts()`**
  - 产生：`packages/prompt-catalog`，通过 `Object.values(catalog)` 过滤 `PromptEntry`（现有测试 `prompt-catalog.unit.test.ts:156-165` 就是这么做的）。
  - 使用：`ModelEgress` / 生产工厂。
  - 校验：需要确认它只包含 `PromptEntry`，不包含函数/非文本对象；排序固定；在测试中校验每个条目都覆盖。当前目录没有集中 registry，靠 `Object.values` 可行，但建议显式导出 `PROMPT_ENTRIES` 或至少加测试防止遗漏。
- **`purpose`**
  - 产生：egress context（`pi-runtime-adapter.ts:999-1004` 固定 `"chat"`；`production-model-composition.ts:463-471` 后台 `text.purpose`；`sensitive-interception-recorder.ts:83-109` memory audit 固定 `"memory-capture"`）。
  - 使用：DB `purpose` 字段（只做 1-64 字符校验）、去重键（`sqlite-sensitive-interception-operations.ts:61-75` 含 purpose）、UI `where()`、i18n `sensitive.purpose.*`。
  - 两端校验：生产后台的 `purpose` 在 `service-main.ts:1923` 经过 `modelUsagePurpose` 归一为枚举；`memory-episode-${index}` 会在进入 egress 前变成 `memory-episode`，所以 DeepSeek 的担心不成立。但 UI 仍需处理 null/未知/其他值；方案没有定义回退规则（第 7 条）。
  - 去重键含 purpose 是已存在的；方案不改 purpose 值，所以不会产生新的重复记录。
- **I-78 编号/路径**
  - 产生：事故清单。
  - 使用：`scripts/check-incident-gates.mjs`。
  - 校验：编号不能重复，日期/次数/状态合法，`已落门槛` 必须含存在的仓库路径。I-78 当前未被占用（表里最大 I-77），但门槛路径必须在实施时写实。

结论：**`purpose` 部分基本能接受（且 `memory-episode` 归一化已核实），但 `trusted` 选项和 UI 回退规则需要补校验；I-78 的路径也要写实。**
