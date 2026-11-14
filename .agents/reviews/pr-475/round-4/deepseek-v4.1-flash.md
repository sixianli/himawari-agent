## 结论

合并冲突的实质处理基本正确：`memory.rule.respond` 的 `undo`/`confirm`/`reconfirm` 仍可达，`builtInRules` 与 `review` 是两份独立状态，recall 仍会因带外来标记的记忆设置 `externalContent`。没有发现会直接导致合并后功能出错的代码缺陷。

下面按严重度列出问题；真正的代码风险只有一条低严重度的“兜底分支”问题，其余是材料/流程与部署兼容性。

---

## 一、读代码证实的问题

### 低：复核材料漏列了 6 个实际冲突文件

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:268`、`apps/agent-service/src/production-runtime-tools.ts:755-761`、`apps/control-center/src/components/rule-receipt.tsx:224-277`、`packages/gateway-contracts/src/contracts-v2.ts:1974-2029`、`packages/gateway-contracts/test/gateway-v2.fixture.ts:967-993`、`package.json` 的 `check:apple-design`/`typecheck`
- 问题：材料说冲突文件只有 6 组，但 `git show --cc --name-only ad387e8...` 实际列出 18 个冲突文件。材料完全没提 `production-owner-rules.ts`、`production-runtime-tools.ts`、`rule-receipt.tsx`、`contracts-v2.ts`、`gateway-v2.fixture.ts`、`package.json`。
- 证据：
  - `git show --cc --name-only --format="" ad387e811...` 的输出包含上述 6 个文件。
  - 被漏掉的 `production-owner-rules.ts` 确实带有 main 的语义改动：
    - `readonly reviews: Pick<RuleReviewOwnerStorePort, "act">;`（`production-owner-rules.ts:268`）
    - `? await this.#options.reviews.act({ ... action: "restore" ... })`（`production-owner-rules.ts:742-748`）
  - 相关接线在最终树中都在：`service-main.ts:1510`、`production-http-composition.ts:1136` 都传了 `reviews: repository.ruleReviews()`。所以本次没有接错，但材料无法据此提醒复核者检查这一点。
- 建议：材料应按 `git show --cc` 的真实冲突清单逐条列出；尤其是 `production-owner-rules.ts` 的 `reviews` 注入和 `reconfirm` 语义、`production-runtime-tools.ts` 的 recall 错误文案、`rule-receipt.tsx` 的 main 回执卡与 PR 内置规则块并存，以及 `contracts-v2.ts`/fixture 的 `builtIn` 字段。

### 低：`memory.rule.respond` 的兜底分支会把未知 action 当作 `undo`

- 文件:行：`apps/agent-service/src/production-memory-control.ts:1724-1729`
- 问题：新增了 `ask_first`/`allow_directly` 后，代码依赖前面的 1659-1671 提前拦截；最后的通用分支仍写成
  ```ts
  action === "confirm"
    ? (await control.confirm(target)).ruleId
    : action === "reconfirm"
      ? (await control.reconfirm(target)).ruleId
      : (await control.undo(target)).ruleId;
  ```
  只要将来新增 action 而忘记提前拦截，或调整分支顺序，未知 action 会静默执行不可撤销的 `undo`（把规则 retired）。
- 证据：上面 `production-memory-control.ts:1724-1729`；`OWNER_RULE_ACTIONS` 现在有 5 个值（`contracts-v2.ts:1974-1980`），而通用分支只显式处理 2 个。
- 建议：把最后一条改成显式 `action === "undo"`，其余显式抛 `INVALID_OPERATION`；这样新增 action 时不会默认落到撤销。

---

## 二、推测 / 未核实

### 低（推测）：`builtIn` 是快照必填字段，混合版本部署时规则页会整块失败

- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:2010-2019`、`apps/control-center/src/memory.ts:160-164`
- 问题：`memory.rules.snapshot.payload.builtIn` 现在是必填数组。若新网页资源遇到旧 agent-service（滚动发布/缓存旧前端反向请求旧实例），旧响应没有 `builtIn`，`gateway-client.ts:268-270` 的 `gatewayV2MessageSchema.parse` 会拒绝整个快照，`useMemory` 的 `catch` 只把 `failed` 置真，规则页不会降级显示旧规则列表，而是整块不可用。
- 证据：schema 中 `builtIn: array(...)`（无 `?`，不在可选分支）；网页直接 `setBuiltInRules(result.payload.builtIn)`。
- 未核实：仓库里没有读到发布是否保证网页与 agent-service 同版本切换；如果总是同包发布，这条不构成问题。
- 建议：若存在混合版本窗口，把 `builtIn` 在契约或读取端按可选处理并默认 `[]`；否则至少在发布说明中明确这是不兼容的网关快照变更。

---

## 三、侧重检查

- **错误路径：外来标记写失败**
  - `ContextExternalContent.#write` 失败会抛 `ExternalContentMarkNotWrittenError`（`context-external-content.ts:207-241`）。
  - `ProductionRuntimeTools.execute` 在未发出时返回 `not_sent`/`external_content_mark_failed`；若已有执行意图记录则继续抛错，避免把可能已执行的调用说成未发出（`production-runtime-tools.ts:1227-1256`）。
  - 结论：失败关闭，且区分“确定没发出”和“可能已发出”，符合 ADR 的取舍。
- **不可信输入：动作规则开关**
  - `setAskFirst` 先查规则是否存在，再拒绝非 `allow_preauthorized` 的规则（`action-rule-switches.ts:77-84`）。
  - 网关命令的 action 是枚举（`contracts-v2.ts:2023-2028`），`target` 是 `machineString`。
  - 结论：两端校验一致，未知规则返回 `ACTION_RULE_NOT_FOUND`，不可放松的规则返回 `ACTION_RULE_HAS_NO_SWITCH`。
- **安全：`ask_owner` 是否会被既有长期授权绕过**
  - 我专门查了授权路径：`ask_owner` 最终走 `#policy.evaluate`（`owner-scope-authorization.ts:276-283`），权限引擎会先查 grants（`action-policy-service.ts:360-405`）。
  - 但长期 grant 只允许安全 READ/LOW（`grant-service.ts:71-81`、`action-intent-snapshot.ts:156`），而 `ask_owner` 规则要求 `action_kind != "READ"`（`action-rules.ts:119`）；一次性 grant 又绑定具体 intent 指纹。因此非 READ 的“先问”动作不能被既有 grant 直接放行。
  - 结论：未发现“先问”被长期授权静默绕过的路径。
- **资源耗尽**
  - 内置动作规则固定 4 条，开关状态每个规则一条记录；`externalContentSourceRefs` 按来源去重、排序，单条 ref 截到 512，来源名最多 256（`context-external-content.ts:33-55`）。
  - 结论：没有随轮数无界增长的集合进入模型可见内容。
- **不可撤销操作**
  - 任务取消被 `action_preauthorize_own_task_cancel` 直接放行，但仍保留“只能管这一轮自己开出来的任务”的既有检查（`production-runtime-tools.ts:1258-1286`、`production-tool-actions.ts:114-136`）。
  - 结论：ADR 说明与代码一致。
- **规则/文档一致性**
  - ADR 0257 新值表里的 `builtIn`、`ask_first`/`allow_directly`、`action-rule:<id>`、`refused`、`toolRefusals`、`target_type` 与代码一致。
  - 唯一不一致是上面的“材料冲突清单”不完整，不是 ADR 与实现不一致。

---

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。仍然只在末尾追加；每轮会变的值仍在最后一条消息里。**

依据和核对结果：

- `git diff 94a958..ad387e8 -- packages/prompt-catalog apps/agent-service/test/__prompt_golden__` 为空：系统提示、工具定义 golden 都没有变。
- 新增的 `target_type` 只进规则字段目录和动作闸门（`field-catalog.ts:118-124`、`action-rules.ts:41-50`），不进入模型请求。
- recall 的 `externalContent` 只在内部返回值里（`production-memory-recall.ts:312-317`），`#recall` 返回给模型的仍是 `output`（`production-runtime-tools.ts:745-752`），没有新增模型可见字段。
- `builtIn` 是 `memory.rules.snapshot` 的控制中心查询字段（`production-memory-control.ts:893-901`），不进入任何模型上下文。
- 因此符合 `.claude/rules/prompt-prefix.md:27-28` 的“固定在前、会变的在后；每轮变化只放最后一条用户消息”。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**本改动没有把新的不确定性引入模型可见内容。** 新增的持久化值都做了固定化：

- `externalContentSourceRefs` 先按来源去重、排序，再生成（`context-external-content.ts:33-55`）。
- `ruleSource` 对 `externalOrigins` 去重后排序（`production-owner-rules.ts:332-343`）。
- `#externalSources` 返回前 `sort()`（`owner-scope-authorization.ts:230-235`）。
- `builtIn` 列表来自固定顺序的 `BUILT_IN_ACTION_RULES`；`generatedAt` 只出现在控制中心快照里，不在模型请求里。

一个非阻断的注意点：`externalContentSourceRefs`/`ruleSource` 使用 `localeCompare(..., "en")`，这些值是持久化标识而不是模型可见文本；如果要求跨运行环境的严格字节一致，建议改成按 Unicode 码点比较，但当前不影响请求前缀。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有，且反向用例是实打实的。** 我只读了测试，没有运行。

- 外来标记本身：`apps/agent-service/test/context-external-content.unit.test.ts`
  - 正向：带标记的记忆才 `mark("recalled_external_record")`（22-37 行）。
  - 反向：不带标记、空列表不写标记（39-48 行）。
- recall：`apps/agent-service/test/production-memory-recall.unit.test.ts:397-414`，正向带 `external-content:` 为 true，普通记忆为 false。
- 冲突重点：undo/confirm/reconfirm 在最终控制层仍可达，已有 P2-3 集成用例在 `actionRules` 已安装的情况下逐条走过（`test/integration/production-memory-capture.test.ts:2352-2375`、`2441-2449`、`2488-2493`）。
- 内置规则与开关：`test/integration/tool-action-registry.test.ts` 覆盖关掉后改问、打开后直接做、先问规则改不了；`apps/control-center/test/owner-rules.unit.test.ts:279-340` 覆盖只有“直接做”的规则有开关，以及反向切换。
- 规则 id 冻结：`test/tooling/rule-ids-frozen.test.ts:46-57` 的反向用例会把改名的规则同时报成“缺失”和“未登记”；该测试已由 `check:rule-registry` 运行（`package.json:61`）。
- 拒绝次数上限：`packages/runtime-pi/test/pi-tool-progress-guard.compat.test.ts` 覆盖连续/累计到上限停下、低于上限不停、普通错误不计入；配置范围在 `startup-configuration.unit.test.ts` 也有反向用例。

覆盖缺口：没有一个测试同时加载 `builtInRules` 和 `review` 两份快照来断言互不覆盖；代码上它们用独立 `useState`，`setRules`/`setBuiltInRules` 与 `setReview` 互不写对方（`memory.ts:156-178`），所以风险低，但可以补一条组合用例。

### 4. 每个新值的产生处和使用处能否接受？

逐个核对结果：

| 值 | 产生处 | 使用处 | 两端校验 |
|---|---|---|---|
| `memory.rules.snapshot.payload.builtIn` | `production-memory-control.ts:893-901`，始终返回数组 | 网页 `memory.ts:160-164`；网关 schema `contracts-v2.ts:2010-2019`；集成测试 `production-memory-capture.test.ts:2164-2176` | schema 要求数组、`revision >= 1`、outcome 枚举、`askFirst` 可空；测试用 `gatewayV2MessageSchema.parse` 校验 |
| `ask_first` / `allow_directly` | 网页 `rule-receipt.tsx:264-267` | 网关枚举 `contracts-v2.ts:1974-1980` → 控制层提前分支 `production-memory-control.ts:1659-1671` → `setAskFirst` | 枚举两端同源；`setAskFirst` 再校验规则存在且可切换（`action-rule-switches.ts:77-84`） |
| `external-content:<record>\|<origin>` | `externalContentSourceRefs`（`context-external-content.ts:33-55`）、`ruleSource`（`production-owner-rules.ts:332-343`） | `carriesExternalContent` / `isExternalContentSourceRef`（`context-external-content.ts:82-88`）、`memorySourceState`（`memory-source.ts:35-40`）、recall（`production-memory-recall.ts:264`） | 写入和读取共用 `EXTERNAL_CONTENT_SOURCE_REF_PREFIX`；单条长度受 512 限制；来源名最多 256；测试覆盖截断与同来源去重 |
| `refused` | `runtime-tool-authorization.ts:21-37`、适配器 preflight `pi-runtime-adapter.ts:2190-2200` | `pi-runtime-adapter.ts:1557-1572` → `PiToolProgressGuard.observe` | 端口类型 `intelligence.ts:481` 有 `refused?: true`；守卫只认 `true`，普通失败不计数 |
| `target_type` | `actionGateFacts`（`action-rules.ts:48`） | 内置规则表达式、字段目录 | 字段目录登记（`field-catalog.ts:118-124`），规则表达式类型检查；所有 action facts 都经 `actionGateFacts` 产生 |
| `runPolicy.toolRefusals` | `strict-configuration.ts:1381-1394` | `PiToolProgressGuard`（`pi-tool-progress-guard.ts:44-56`）、适配器注入（`pi-runtime-adapter.ts:1469`） | 配置解析限制 1..1000 / 1..10000，拒绝未知键；守卫再拒绝非正整数 |
| `action-rule:<id>` 状态键 | `action-rule-switches.ts:54/98` | `owner-scope-authorization.ts:290` 的 `#standingAuthorization` | 两端都调用同一个 `actionRuleAuthorizationKey`（`owner-scope-authorization.ts:69-70`） |

唯一需要额外注意的是上面“推测”里的跨版本问题：`builtIn` 在 schema 中是必填，新网页对旧服务的快照会整块解析失败。其余值的产生处和使用处校验一致。
