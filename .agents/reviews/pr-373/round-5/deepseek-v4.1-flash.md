## 侧重检查

我按错误路径、不可信输入、安全、资源、不可撤销操作、文档一致性先查了这些地方：

- **补写失败记录是否会造成 done+failed 双行**：单次运行内**不会**（读代码证实）。`review-prereview.ts:242-271` 的 catch 只包住 `ownerHistory` 与 `record`；`record` 里 `insert` 是最后一步（`sqlite-review-prereview-operations.ts:334-352`），插入成功后没有会抛错的代码，紧接着就是 `recorded += 1`。即使出现“已插入却抛错”的异常包装，`recordFailure` 复用的也是同一个 `attempt.id`，表有 `id TEXT PRIMARY KEY`（`0091_decision_prereviews.sql:2`），且 `INSERT ... ON CONFLICT DO NOTHING`（`sqlite-review-prereview-operations.ts:300-309`），所以不会追加第二行。
- **错误输入/模型输出**：输出上限 4096 字节（`review-prereview.ts:39,376-384`），JSON 解析从第一个 `{` 到最后一个 `}`，rating 走白名单，confidence 必须是 0..1000 的整数（`parsePrereview`，`review-prereview.ts:78-98`）。没有发现新增的越界入口。
- **安全/隐私**：失败原因新增了 `failureCode()` 归一化，确实把含中文、空格、小写的错误信息降为 `unknown`（`review-prereview.ts:100-103`）。但正则仍允许纯大写标识符原样入库，见下方低危发现。
- **资源耗尽**：`minimumPairsToPass` 最多循环 100000 次，但配置上限已改成 999（`strict-configuration.ts:1174-1181`），999 只需要约 3838 对，实际不会打满；每次模型调用的 perRun/dailyLimit/dailyCost 仍生效。
- **不可撤销操作**：`decision_prereviews` 有 UPDATE/DELETE 触发器（`0091_decision_prereviews.sql:63-70`），新增失败行仍是追加；没有发现会改写既有行的新代码。
- **文档一致**：ADR 0237 第 4/5/“放弃的做法”已更新（`docs/adr/0237-model-pre-rates-waiting-decisions.md:52-54,63-64`）。但 `judgments.md` 和 round-4 复核材料在本环境被 `REVIEW_GIT_REFUSED records-path` 拦下，**未核实**第 6 条“理由写在 judgments.md”。

---

## 发现（按严重度）

### 1. 【中】promptId 算法改变会让已有预评全部变成“旧版本”，隐藏门槛与网页周报同时归零，但文档只说明“提示词文字改了”会这样

**文件/行**
- `packages/application/src/services/review-prereview.ts:105-108,155-157`
- `packages/calibration/src/prereview.ts:280-294`
- `packages/persistence-sqlite/src/sqlite-review-prereview-operations.ts:127-128,169-170,247-249`
- `docs/adr/0237-model-pre-rates-waiting-decisions.md:72`

**证据**
```ts
// review-prereview.ts:105-108
export function prereviewPromptId(digest: (text: string) => string): string {
  const options = JSON.stringify(PREREVIEW_GROUPS.map((group) => [group, prereviewOptions(group)]));
  return `${REVIEW_PREREVIEW.id}@${digest(`${REVIEW_PREREVIEW.text}\n${options}`).slice(0, 12)}`;
}
```
```ts
// prereview.ts:286-288
const current = latest
  ? rows.filter((row) => row.modelRef === latest.modelRef && row.promptId === latest.promptId)
  : [];
```
```ts
// sqlite-review-prereview-operations.ts:127-128
WHERE p.owner_id = ? AND p.agent_id = ? AND p.status = 'done'
  AND p.model_ref = ? AND p.prompt_id = ?
```
```md
// ADR 0237:72
提示词文字改了，`promptId` 跟着变，旧版本的预评不再参与一致率……
```

**问题**
这次改动并没有改 `REVIEW_PREREVIEW.text`（`packages/prompt-catalog/src/review.ts` 不在增量里），却改了 `promptId` 的算法（把 options 摘要进去）。因此：
- 已有 `done` 行全部不再被 `listDone` 认出，服务会用新版本重新预评；
- `hiddenByModel` 的 `listPairs` 只取当前版本，自动减少会静默失效，直到重新积累到门槛；
- 网页周报按当前版本固定后，旧行全部落入 `otherVersions`，本组计数为 0，卡片显示空状态。
ADR 的后果只写了“提示词文字改了”，没有覆盖这次“版本号算法/可选评价变化”导致的历史失效；`otherVersions` 的提示虽然有，但空状态文案仍写“这一周还没有模型预评过”。

**建议**
- 若该功能尚未上线，明确在 ADR/变更记录里写“promptId 算法变更会作废旧数据”，并加一条覆盖旧 promptId 的测试。
- 若已有真实数据，考虑一次性回填/双版本过渡，或在网页周报里对“当前版本无数据、但有旧版本”显示独立文案，而不是“这一周还没有模型预评过”。

---

### 2. 【中】“写结果失败也补写失败记录”的自动测试只覆盖“读历史失败”，没有覆盖 `record` 失败；用户关心的“record 成功后不得再写 failed”也没有回归用例

**文件/行**
- `test/integration/review-prereview-production.test.ts:373-403`
- 被测实现：`packages/application/src/services/review-prereview.ts:242-271`
- 幂等插入：`packages/persistence-sqlite/src/sqlite-review-prereview-operations.ts:300-309,334-352`

**证据**
```ts
// 测试里的 broken store
record: (input) => store.record(input),
recordFailure: (input) => store.recordFailure(input),
ownerHistory: async () => {
  throw new Error("disk read failed for 我想记住的事");
},
```
```ts
// 实现的 catch
} catch (error) {
  const failure = `PREREVIEW_STORE_FAILED:${failureCode(error)}`;
  failures.push(failure);
  if (result.reply !== undefined)
    await store
      .recordFailure({ ...attempt, failureCode: failure.slice(0, 128) })
      .then(() => undefined)
      .catch(() => this.#storeFailedAt.set(subject.key, nowMs));
  else this.#storeFailedAt.set(subject.key, nowMs);
}
```

**问题**
新增测试只让 `ownerHistory` 抛错，`record` 是直通实现，所以只验证了“读历史失败”。作者声称的“写结果失败”分支（`record` 抛错）没有直接测试；而“`record` 已成功后再写失败行”正是这轮重点关心的路径，也没有用例。读代码可确认生产实现不会双写（见“侧重检查”），但缺少回归保护。

**建议**
增加两个 store 包装用例：
1. `record` 直接抛错（未插入）→ 应恰好写入一行 failed，且带费用；
2. `record` 先成功写入 done、再抛错（模拟通信层已提交但调用方收到失败）→ 应仍然只有 done，不能多出 failed（靠同 id + `ON CONFLICT DO NOTHING`）。

---

### 3. 【低】`minimumPairs: null` 和网页“—”没有端到端检查，而且配置上限 999 后该分支在生产不可达

**文件/行**
- `apps/agent-service/src/production-observation.ts:333`
- `packages/gateway-contracts/src/contracts-v2.ts:956`
- `apps/control-center/src/components/weekly-report.tsx:843-847`
- `packages/platform-node/src/strict-configuration.ts:1174-1181`

**证据**
```ts
minimumPairs: minimumPairsToPass(prereviewSettings.agreementPermille),
```
```ts
minimumPairs: nullable(integer(1)),
```
```tsx
n:
  report.prereview.minimumPairs === null
    ? "—"
    : format.count(report.prereview.minimumPairs),
```
```ts
hiddenAgreementPermille: number(..., 500, 999),
```

**问题**
代码三端都支持 `null`，但：
- 没有任何测试构造 `minimumPairs: null` 来验证 gateway schema 和网页“—”；
- 配置上限是 999，而 `minimumPairsToPass(999)` 返回有限数（约 3838），所以正常配置下永远走不到 `null`。这条防御路径实际上只在绕过 strict config 或旧配置时才可能触发。

**建议**
要么补一个直接调用 `ProductionObservation`（构造 `agreementPermille: 1000`）并断言快照通过契约、UI 显示“—”的用例；要么在 ADR 里说明这是防御性分支，避免读者误以为 999 会显示“—”。

---

### 4. 【低】只有旧版本预评时，空状态文案会误导

**文件/行**
- `apps/control-center/src/components/weekly-report.tsx:874-876,1394-1396,1436-1442`
- `apps/control-center/src/i18n/resources/zh-CN.ts:1371`

**证据**
```tsx
const prereviewGroups = report.prereview.groups.filter(
  (item) => item.prereviewed > 0 || item.paired > 0,
);
...
{prereviewGroups.length === 0 ? (
  <p className="weekly-empty">{message("weekly.prereview.empty")}</p>
) : ( ... )}
...
{report.prereview.otherVersions > 0 ? (
  <p className="weekly-muse-foot">
    {message("weekly.prereview.otherVersions", { n: ... })}
  </p>
) : null}
```
```ts
"weekly.prereview.empty": "这一周还没有模型预评过、你也打过分的决策。",
```

**问题**
版本切换后的第一周，当前版本的组计数全为 0，但 `otherVersions > 0`。页面会同时显示“这一周还没有模型预评过、你也打过分的决策”和“另有 N 条预评来自旧版本”，前一句与事实不符。

**建议**
当 `otherVersions > 0` 时改用类似“这一周当前版本的预评还没有配对；另有 N 条来自旧版本”的文案，或让空状态区分“没有预评”和“只有旧版本预评”。

---

### 5. 【低】命令行周报不按“服务当前版本”比较，和 ADR/作者说法存在口径差

**文件/行**
- `scripts/calibration-report/report.mjs:105-108`
- `docs/adr/0237-model-pre-rates-waiting-decisions.md:52,63`

**证据**
```js
const prereview = summarizePrereviewWeek(data.prereviews, {
  agreementPermille: DEFAULT_PREREVIEW_AGREEMENT_PERMILLE,
  confidencePermille: DEFAULT_PREREVIEW_CONFIDENCE_PERMILLE,
});
```
没有传第三个 `version` 参数，因此 `summarizePrereviewWeek` 会退回“窗口内最新一条预评的版本”。ADR 第 52 行说“只拿服务当前用的（模型，提示词）版本比较”，第 63 行只说明了命令行不读产品配置导致**门槛**不同，没有说明**版本选择**也不同。

**建议**
在 ADR 里补一句“命令行周报取窗口内最新版本，网页周报取服务当前版本”；如果希望两者一致，让脚本也显式接受版本参数。

---

### 6. 【低】`failureCode` 仍可能把“纯大写但不是错误码”的内容写进元数据表

**文件/行**
- `packages/application/src/services/review-prereview.ts:100-103`

**证据**
```ts
function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_:.-]{0,100}$/u.test(message) ? message : "unknown";
}
```

**问题**
这个正则能挡住含空格、中文、小写的错误信息，符合“代码样式”的初衷；但它也会接受纯大写的任意标识符/令牌，例如某个全大写 secret、用户 ID 或业务键。若底层错误消息恰好是这种形式，会被原样写入 `failure_code`，与“只记代码”目标不完全一致。

**建议**
优先使用 `error.code` 而不是 `error.message`；或把正则收紧为项目已知的错误码前缀/allowlist（例如 `MODEL_*`、`PREREVIEW_*`、`SQLITE_*`），其余一律 `unknown`。

---

### 7. 【推测/低】多实例并发时，同一 subject/版本可能同时存在 done 与 failed 两行

**文件/行**
- `packages/persistence-sqlite/src/migrations/0091_decision_prereviews.sql:48-54`
- `packages/application/src/services/review-prereview.ts:242-271`

**证据**
```sql
CREATE UNIQUE INDEX decision_prereviews_decision_done
  ON decision_prereviews(decision_id, prompt_id, model_ref)
  WHERE status = 'done' AND decision_id IS NOT NULL;
```
唯一索引只约束 `status = 'done'`，failed 行不参与。两个进程若都在 `listDone` 之前进入同一 subject：A 写入 done；B 在 `ownerHistory` 抛错（尚未 `record`）后写入 failed（不同 id），就会出现同 subject/同版本的一 done 一 failed。

**说明**
这是推测，且前提是两个服务实例并发跑预评；单实例有 `#running` 串行保护。统计只读 done 行，成本会按两次真实调用各计一次，因此不是数据错误，但“同一条记录既有 done 又有 failed”的运维观感会变差。

**建议**
若产品允许单实例运行，在 ADR 里写明；否则可考虑给 failed 行也加唯一约束，或在写 failed 前先检查同 subject/版本是否已有 done。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会（读代码证实）。**

- 增量没有改 `packages/prompt-catalog/src/review.ts`，`REVIEW_PREREVIEW.text` 未变。
- 预评请求仍是“固定文字在前、这一条的数据在最后”，且没有时间字段：
  ```ts
  // review-prereview.ts:64-76
  return [
    REVIEW_PREREVIEW.text,
    JSON.stringify({ group, options, category, text: maskSensitiveText(subject.text) }),
  ].join("\n");
  ```
- `promptId` 只用于数据库过滤和版本比较，不进入请求体（`prereviewPrompt` 没有引用它）。
- 主对话的系统提示、工具定义、历史消息、遮盖逻辑都没有在本增量里改动。

所以对主模型对话而言，仍是“只在末尾追加”；对预评这类后台调用而言，仍是“固定指令在前、每条数据在后”，没有把每轮会变的值放进请求头部。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**没有发现新增风险。**

- `prereviewPromptId` 的摘要输入是 `PREREVIEW_GROUPS.map(...)`，顺序来自固定的 `MAIN_CALIBRATION_GROUPS`，options 来自固定的 `APPLICABLE_RATINGS` 加 `"unsure"`（`prereview.ts:18,30-32`；`index.ts:41-58`），不依赖对象遍历或数据库顺序。
- 没有时间、随机数、集合迭代顺序参与摘要。
- `prereviewPrompt` 的 JSON 键顺序写死，`maskSensitiveText` 对同一输入是确定的（`packages/sensitive-capture/src/redaction.ts:542-544` 只是 `redactForEgress(input).text`）。
- `failureCode` 的新归一化只影响数据库元数据，不影响发给模型的文本。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有新增检查，反向用例基本有效；但有缺口。**

新增/修改的检查：
- `packages/calibration/test/prereview.unit.test.ts:164-188`：固定版本优先于最新版本；`minimumPairsToPass(900) === 35`；999 有有限值；**反向** 1000 返回 `null`。
- `packages/application/test/review-prereview.unit.test.ts:82-96`：摘要输入包含固定文字和每类可选评价。
- `packages/platform-node/test/startup-configuration.unit.test.ts:1494`：**反向** 1000 配置必须抛错。
- `test/integration/review-prereview-production.test.ts:373-403`：读历史失败后写带费用的 failed 行，并计入日上限。
- `apps/control-center/test/weekly-report.unit.test.ts:1074-1105`：**反向** 5 个全零组必须显示空状态。
- `test/integration/review-prereview-browser.test.ts:145-156`：浏览器里全零组不渲染任何 `[data-prereview-group]`。

这些反向用例如果撤掉对应修复，会分别失败：不固定版本会选到 `model-b`；1000 不再被配置拒绝；全零组会渲染成 5 个 tile。

缺口：
- 没有 `minimumPairs: null` 的契约/UI 用例；
- 没有 `record` 写失败后补 failed 的用例；
- 没有“record 已成功再抛错不得写 failed”的用例；
- 没有 ProductionObservation 实际使用服务当前版本的端到端用例；
- 命令行周报的预评段落没有集成测试。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐项核对如下：

| 值 | 产生处 | 使用处 / 校验 | 结论 |
|---|---|---|---|
| 新算法的 `promptId`（`review.prereview@<12hex>`） | `review-prereview.ts:105-108,155-157` | `listDone`/`listRecentFailures`/`listPairs` 的等值过滤（`sqlite-review-prereview-operations.ts:127-128,169-170,247-249`）；DB `prompt_id` 长度 1..128（`0091:22`）；导出 schema `text(1,128)`（`schemas.ts:323`）；导入同长度 | 接受。长度远小于 128，格式无额外校验 |
| `version` 对象 `{modelRef,promptId}` | `service-main.ts:2138-2154` | `production-observation.ts:241-245` → `summarizePrereviewWeek` 只做等值比较（`prereview.ts:280-294`） | 接受 |
| `minimumPairs: number \| null` | `production-observation.ts:333` | 网关契约 `nullable(integer(1))`（`contracts-v2.ts:956`）；网页 `=== null ? "—"`（`weekly-report.tsx:843-847`）；CLI 报告用 `?? "无限"`（`prereview.ts:330`） | 接受；但 null 路径缺少测试且生产配置下不可达 |
| `hiddenAgreementPermille` 上限 999 | `strict-configuration.ts:1174-1181` | 预评服务 `reduction.hiddenAgreementPermille`；网关快照仍允许 0..1000（只读字段，不是配置入口） | 接受；999 有测试，1000 有反向测试 |
| 新失败码 `PREREVIEW_STORE_FAILED:<code>` / `unknown` | `review-prereview.ts:263-269` | `recordFailure` 校验长度 1..128（`sqlite-review-prereview-operations.ts:357-362`）；DB `failure_code` 长度 1..128（`0091:20`）；导出 schema `text(1,128)`（`schemas.ts:322`） | 接受；`slice(0,128)` 保证不超长 |
| 失败记录里的费用/耗时 | `attempt.costMicros/durationMs`（`review-prereview.ts:228-241`） | DB `cost_micros >= 0`、`duration_ms` 0..86400000（`0091:27-28`）；导出 schema 同范围（`schemas.ts:331-332`） | 接受；测试断言了费用 300 |
| `minimumPairsToPass` 返回类型从 `number` 变 `number \| null` | `prereview.ts:358-364` | 仅 `production-observation.ts:333` 与 `prereview.ts:330` 使用，均已处理 null | 接受 |

整体上，新增/修改的值都能被下游校验接受；主要问题不是“某端拒绝”，而是版本切换后的数据语义和测试覆盖。

---

**未核实项**：`.agents/reviews/pr-373/judgments.md` 与 round-4 复核材料在当前环境被 `REVIEW_GIT_REFUSED records-path` 拦截，无法核对第 6 条“不改代码的理由”；我没有运行测试，只按代码和测试内容判断反向用例的有效性。
