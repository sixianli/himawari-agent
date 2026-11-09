以下结论都基于我亲自读过的代码（提交范围：`1a593a41` 与 `bfa69c5c`，并对照基线 `8b16d692`）。我没有运行任何测试（工具只允许读文件和 git diff/log/show），所以“测试是否真红/真绿”一律标为未核实。

## 结论摘要

核心方案（把遮盖规则版本写进按对话冻结的 `identity_json`，老记录/rollout 读 1，其余写 `EGRESS_RULESET_CURRENT`，egress 按记录版本遮盖）在**已冻结的提示记录**这条主路径上成立：同一对话的一个 generation 内版本不会变，pin 只存 generation、版本仍从同一条不可变记录读出，因此不会在两次请求之间漂移。没有发现“版本在两次请求之间变化但不换新”的代码路径。

但我发现几处需要处理的问题，按严重度排列。

---

## 问题清单

### 1. 中：老对话仍会把宽松写法的密码明文发给模型，而存储侧已把它标成敏感（ADR 已记为“代价”，需 Andy 再确认）

- 文件:行：`packages/sensitive-capture/src/redaction.ts:350-356`、`packages/application/src/services/thread-prompt-bundle-service.ts:240`、`:265`、`packages/sensitive-capture/src/identifiers.ts:16-27`
- 问题：`ruleset < 2` 时两条宽松密码规则完全跳过；所有上线前已有记录（缺字段→1）和 rollout 对话（→1）因此继续原样发送“Wi-Fi 密码 abc12345”。与此同时 `containsCredential`/`classificationWithIdentifiers` 调用 `redactForEgress` 时**不带 ruleset**，用当前规则，会把同一条消息标成 sensitive。也就是系统一边认定“这是秘密”，一边把它原文发给模型。
- 证据：
  - `packages/sensitive-capture/src/redaction.ts:350-356`
    ```
    const looserForms =
      (options.ruleset ?? EGRESS_RULESET_CURRENT) >= EGRESS_RULESET_FIRST_LOOSE_PASSWORDS
        ? ([[PASSWORD_WORDED_ASSIGNMENT, 4], [PASSWORD_BARE_VALUE, 6]] as const)
        : [];
    ```
  - `packages/application/src/services/thread-prompt-bundle-service.ts:240`
    ```
    redactionRuleset: origin === "rollout" ? LEGACY_REDACTION_RULESET : EGRESS_RULESET_CURRENT,
    ```
  - `packages/sensitive-capture/src/identifiers.ts:16-17`
    ```
    export function containsCredential(text: string): boolean {
      return redactForEgress(text).findings.some(...)
    ```
  - ADR 0188 第 60 行已明确写这是“代价”。
- 建议：如果安全优先，建议改成“只对已发过的历史部分用旧版本，追加的新消息用当前版本”：egress 按消息在历史中的位置选 ruleset（`known` 是按从左到右传播的，新消息用 2 不会改变前面已发消息的字节）。这样既不破坏前缀，又不会让老对话的新密码继续外泄。若维持现方案，至少在 ADR/运维文档里给出“批量/按需 rebuild”的操作建议。

### 2. 低-中：`classification_lower` / 手动 rebuild 会在提示词和工具没变的情况下把版本 1→2，ADR 的理由“请求开头本来就整段重算”并不总成立

- 文件:行：`packages/application/src/services/thread-prompt-bundle-service.ts:238-240`、`:74-87`、`:242-249`、`docs/adr/0188-recognize-passwords-without-a-separator.md:58`
- 问题：`#create` 对所有非 `rollout` 的 origin 都写当前版本，包括 `classification_lower` 和 `rebuild_requested`。而 `candidate.systemPrompt`/`candidate.tools` 的构建与数据分类无关（第 242-249 行）；当数据分类降低但模型选择不变、提示词文字也没变时，本轮请求的唯一字节变化就是历史被 2 号规则重新遮盖。ADR 说的“请求开头本来就整段重算”在这种情况下不成立——等于为一个不改变请求头的事件额外付一次缓存失效。
- 证据：
  - `thread-prompt-bundle-service.ts:238-240` 的非 rollout 分支写当前版本；
  - `promptBundleChange` 第 80-81 行先返回 `classification_lower`，此时还没看模型是否变化；
  - `#create` 第 242-249 行只保护 `candidate.systemPrompt`/`candidate.tools`，不含 classification。
- 建议：当新 generation 的系统提示与工具和旧记录逐字节一致时，沿用旧记录的 `identity.redactionRuleset`（或仅对“提示词/工具变化”的换新升级版本）；至少把 ADR 第 58 行改成“可能整段重算，也可能只改变历史遮盖字节”。

### 3. 低：规则文件和 KV 缓存指南没有同步“遮盖字节还取决于对话的规则版本”

- 文件:行：`.claude/rules/prompt-prefix.md:51-53`、`docs/kv-cache-guide.md:60`、`:66`、`docs/adr/0165-freeze-the-request-head-per-conversation.md:83`
- 问题：规则第 10 条写“同样的内容，每次都要序列化成同样的字节”，第 11 条写“一条消息遮成什么样，只能取决于它自己和它前面的内容”。改动后同一段文字在不同对话（版本 1 vs 2）会遮成不同字节；规则文件没有说明“同一对话内才必须一致，且版本随冻结记录固定”。`kv-cache-guide.md` 第 5/11 行仍写“遮盖密钥不变、前面的历史不变时字节相同”，也缺版本条件。另外 ADR 0165 第 83 行仍写 `identity_json` 记“第 2 条的四项输入”，而第 64 行已改成还要带 `redactionRuleset`，同一篇文档前后不一致。
- 证据：上述文件对应行；本 PR 的 `git diff` 没有修改 `.claude/**` 和 `docs/kv-cache-guide.md`（我核对过 `git diff 8b16d692..bfa69c5c -- '.claude/**' 'docs/kv-cache-guide.md'` 为空）。
- 建议：在规则第 10/11 条补一句“遮盖规则本身按对话冻结，版本不同不要求跨对话字节一致；同一对话内版本固定”；同步 `kv-cache-guide.md` 第 5/11 行和 ADR 0165 第 83 行。

### 4. 低：读取侧不校验 `redactionRuleset`，且未知更高版本被当作“只到 2”

- 文件:行：`packages/persistence-sqlite/src/sqlite-thread-prompt-bundle-operations.ts:27-33`（读）、`:158-160`（写校验）、`packages/sensitive-capture/src/redaction.ts:350-351`
- 问题：写入时校验了“是安全整数且 ≥1”，但 `fromRow` 只做 `JSON.parse(...) as ThreadPromptBundleIdentity`，读出来不校验。若 `identity_json` 被迁移/损坏成字符串 `"2"`，`>= 2` 会做类型转换；若是未来版本 `3` 被旧代码读到，`>= 2` 为真只应用 2 号规则，缺了 3 号规则却不会失败（回滚/混跑时是“少遮”，不是“多遮”）。这是 I-73“生产端校验、消费端没核对”的同类问题，只是当前主要写者还是同一份代码。
- 证据：
  - `:31` `identity: Object.freeze(JSON.parse(identityJson) as ThreadPromptBundleIdentity)` 无字段校验；
  - `:158-160` 写入侧有 `Number.isSafeInteger(...) && >= 1` 校验；
  - `redaction.ts:350-351` 只做 `>= 2`。
- 建议：在 `fromRow`/`#open` 校验 `redactionRuleset` 为 `undefined` 或安全整数 ≥1，并对 `> EGRESS_RULESET_CURRENT` 明确策略（采用当前已知规则并告警/失败关闭），避免未来回滚静默少遮。

### 5. 低：ADR 说“三条 `[ADR-0188]` 用例”，但反向用例没有这个 tag，门槛也没有专门的数量要求

- 文件:行：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:655`、`scripts/check-prompt-prefix.mjs:8-10`、`:26-27`、`:43-47`、`docs/adr/0188-recognize-passwords-without-a-separator.md:62`
- 问题：反向用例名为 `"REVERSE: switching an old conversation to the new ruleset..."`，不含 `[ADR-0188]`。它现在能跑，只是因为位于 `describe("[I-66] ...")` 内，被 `-t "\[I-66\]"` 选中；脚本只要求 `passed.length >= 8`（REQUIRED=8），没有单独要求 ADR-0188 的三条。若以后有人把这三条移出该 describe，覆盖率会静默消失，门槛不会报“缺 ADR-0188 用例”。
- 证据：
  - 测试第 655 行无 `[ADR-0188]`；
  - `check-prompt-prefix.mjs:8` `TAG = "[I-66]"`，`:43-46` 只按总数判断。
- 建议：给反向用例补 `[ADR-0188]`，并在脚本里对 `[ADR-0188]` 单独计最低条数（至少 3），或把三条放到独立的 describe 并显式纳入 `-t`。

### 6. 低：常量名叫“规则版本”，但只有宽松密码规则被版本门控

- 文件:行：`packages/sensitive-capture/src/redaction.ts:53-54`、`:345-363`
- 问题：`EGRESS_RULESET_CURRENT` 文档语义是“整套出口遮盖规则的版本”，实际只有两条宽松密码规则受 `ruleset` 控制，其余规则（严格密码、验证码、银行卡、证件号……）无条件是当前规则。将来有人只把常量从 2 加到 3 就以为老对话前缀不会变，是错的。
- 证据：门控只出现在第 350-356 行；`PASSWORD_ASSIGNMENT`、验证码、卡号、证件号等替换均无 `ruleset` 判断。
- 建议：在注释/ADR 里写明“当前版本只覆盖宽松密码规则”，或把规则表按版本组织，避免后续误用。

---

## 侧重检查（错误路径、不合规/不可信输入、安全、资源耗尽、不可逆操作、文档一致）

- 不可信输入/损坏数据：`identity_json` 是 DB 内容，读路径无校验（问题 4）；`redactionRuleset` 不是用户请求字段，用户无法直接注入。已核对 produce→store→open→adapter→egress 两端类型都是 `number | undefined`，SQLite 写入侧校验通过，worker/direct 集成测试覆盖了序列化路径（但测试未实际运行，未核实）。
- 错误路径：pin 失效、record 缺失、指纹不一致都有显式抛错（`RUNTIME_PROMPT_BUNDLE_*`），新字段未引入新的静默降级；`#open` 对缺失字段静默按 1 是设计选择，不是异常吞掉。`redactForEgress` 的 trusted 回退路径（`redaction.ts:265-275`）把 `ruleset` 同时传给 rehearsal 和正式遮盖，无“rehearsal 用新规则、正式用旧规则”的不一致。
- 安全：见问题 1。另核对 `findSensitiveValues`/`locateMaskedValues`/`maskSensitiveText` 仍用当前规则，但它们只用于邮件检查、存储分类、展示，不参与对话请求前缀（`proactive-mail-check-service.ts`、`identifiers.ts`、`platform-node/src/files/pi-output-export.ts`、`gmail-body.ts`），与 ADR 0188 的说明一致。
- 资源耗尽：新增逻辑没有无界循环；宽松正则仍是单字符类 + 有限长度量词和一次 lookahead，未发现新的指数级回溯（第 3 轮加入的 `PASSWORD_VALUE_OPENING`/`PASSWORD_LOOSE_VALUE_START` 是线性的）。未做压力测试，标未核实。
- 不可逆操作：本改动只写新的 generation 行和 pin；`requestThreadPromptRebuild` 只标 `superseded_at`，不删旧行（`sqlite-thread-prompt-bundle-operations.ts:82-94`），没有新增删除/覆盖已发内容。
- 规则/文档一致：见问题 3、5。ADR 0188 与代码基本一致（`EGRESS_RULESET_CURRENT=2`、rollout/缺失→1、非 rollout→当前、不参与换新判断），但 ADR 0165 第 83 行“四项输入”和规则/KV 指南未同步。

---

## 逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？

**对本次改动覆盖的对话主路径：不会，仍然只在末尾追加。** 依据：
- 系统提示和工具仍按 generation 冻结（`thread-prompt-bundle-service.ts:195-205`、`:256-267`），本改动没有把 `redactionRuleset` 放进发给模型的任何字段；它只是 `ModelEgressContext` 的进程内选项（`model-egress.ts:37`、`:226-228`），不序列化进请求。
- 历史仍每轮按同一份冻结记录的版本重新遮盖：有记录（含缺字段→1）走 `#open` 的 `record.identity.redactionRuleset ?? 1`（`thread-prompt-bundle-service.ts:265`）；rollout 写 1（`:240`）；同一 generation 内记录不可变，pin 只存 generation（`:308-329`），因此版本不会在请求之间漂移。
- 每轮会变的内容仍只放在最后一条用户消息里；本改动没有往系统提示/工具里加时间、路径、版本号等会变值。
- 例外（都属规则第 6 条允许的“换新”或既有设计）：`classification_lower`/手动 rebuild 会把版本 1→2，从而改变历史字节，即使提示词/工具没变（问题 2）；`freezeThreadPrompts:false` 或没有 `promptBundles` 的部署本来就不冻结、会用当前版本（这是既有开关，不是本 PR 新增）；ADR 0165 的 rollout 本身可能在冻结新提示词时改变开头（既有行为）。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

- **同一对话、同一 generation 内：不会。** 版本固定；`redactForEgress` 除 `ruleset` 外只依赖文本自身、前面的 `known` 和固定文字清单；`known`/`table` 每个 Exchange 新建，但每次从历史开头重新扫描，顺序确定（`model-egress.ts:128-138`、`model-egress.ts:220-249`）。
- **跨对话或跨 generation：会，且是有意的。** 版本 1 的对话与版本 2 的对话对同一段“Wi-Fi 密码 abc12345”遮出不同字节；换新 generation 时也会变一次。这符合“按对话冻结”的设计，但需要同步规则文件（问题 3）。
- 没有引入时间字段、随机数、无序集合：`identity_json` 的键顺序由固定对象字面量决定，`toolNames` 是数组。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

- 有：
  - `packages/runtime-pi/test/prompt-prefix.compat.test.ts:633-663` 三条（旧版本全程不变 / 新对话第一轮遮盖 / 中途换版本必须断开）。它们位于 `describe("[I-66] ...")` 内，`scripts/check-prompt-prefix.mjs` 用 `-t "\[I-66\]"` 选中，vitest 非零退出会失败。
  - `packages/application/test/model-egress.unit.test.ts:187-217` 覆盖 `ModelEgressContext.redactionRuleset=1` 时不遮、无 context 时遮。
  - `test/integration/thread-prompt-bundles.test.ts:287-333` 覆盖新对话→当前、rollout→1、换新→当前、缺字段→1 且不换新。
  - `packages/sensitive-capture/test/redaction.unit.test.ts:331-338` 覆盖 ruleset 1/2 与默认。
- 反向用例的有效性（读代码判断）：`[1,1,2]` 的第 3 轮会把第 1 轮历史里的 `abc12345` 遮掉，`findPrefixBreak` 比较 `messages` 时会在第 0 条发现 `message-changed`（`test/helpers/prompt-prefix.ts:34-40`）；如果适配器忽略 ruleset（始终当前），正向“旧版本全程不变”会因 `bodies` 不含 `abc12345` 失败。两个方向都能红。
- 缺口：反向用例没有 `[ADR-0188]` tag，门槛没有专门计数（问题 5）；没有专门测试“pin/续跑后 ruleset 仍一致”（代码路径简单，但目前只能靠代码审阅，未核实有测试覆盖）。我未实际运行，无法确认 CI 当前是否全绿。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

- `redactionRuleset`（新字段）：产生于 `#create`（`thread-prompt-bundle-service.ts:238-240`）→ SQLite 写入校验 `Number.isSafeInteger && >=1`（`sqlite-thread-prompt-bundle-operations.ts:158-160`）→ 存进 `identity_json`（`:209-217`）→ 读出 `#open`（`:265`）→ `RuntimePromptBundle.redactionRuleset`（`ports/thread-prompt-bundles.ts:89-92`）→ `pi-runtime-adapter.ts:1567` → `admitPiStream`（`:907`、`:1000-1006`）→ `ModelEgressContext`（`model-egress.ts:37`、`:226-228`）→ `redactForEgress` 的 `ruleset`（`redaction.ts:56-57`、`:350-351`）。两端都接受 `number | undefined`；缺字段按 1，不会被 SQLite/端口拒绝。
- `EGRESS_RULESET_CURRENT` / `EGRESS_RULESET_FIRST_LOOSE_PASSWORDS`：`sensitive-capture` 导出，`application` 依赖已在 `package.json` 且 boundary-policy 允许（`scripts/boundary-policy.mjs:9-19`）。
- 没有新增配置键、清单项或外部协议字段；`thread_prompt_bundles` 表结构不变（不加列）。
- 唯一“生产端有校验、消费端没校验”的错位是问题 4（读路径）；另外未来更高版本被当前代码静默降级为“只到 2”的语义需要明确策略（推测的回滚风险）。

---

## 读代码证实 vs 推测

- 读代码证实：上述所有引用行的行为；版本在 generation 内不可变；pin 只存 generation；rollout/缺字段→1；非 rollout→当前；`promptBundleChange` 不比较版本；egress 只有 `model-egress` 一处把 ruleset 传下去；规则/docs 未同步；`check-prompt-prefix` 的选择方式；反向用例的断链机制。
- 推测/未核实：`classification_lower` 时实际模型是否变化（我未追到该场景下 model 选择的具体分支，只确认 prompt/tools 与 classification 无关）；未来 `EGRESS_RULESET_CURRENT=3` 被旧代码读取的少遮风险；所有测试是否在当前环境通过（不能运行）；worker 协议是否对未知字段有额外裁剪（只看到集成测试按 worker/direct 各跑一遍）。
