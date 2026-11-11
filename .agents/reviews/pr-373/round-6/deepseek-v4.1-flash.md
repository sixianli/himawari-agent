## 发现的问题（按严重度）

### 中：真实存储错误里的 `PORT_` / `SQLITE_` / `DECISION_` 代码会被丢成 `unknown`

**文件：** `packages/application/src/services/review-prereview.ts:100-107`

**问题：** `failureCode()` 只看 `error.message`，不看 `error.code`。但真实 SQLite/端口错误把机器码放在 `.code`，`message` 是人读说明。因此作者第 2 条声称“收 PORT_、SQLITE_、DECISION_ 开头的代码”在实际存储失败路径上基本不成立，实际会写 `PREREVIEW_STORE_FAILED:unknown`。

**证据：**

```ts
// review-prereview.ts:100-107
function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^(MODEL|PREREVIEW|PORT|SQLITE|DECISION)_[A-Z0-9_]{1,80}...$/u.test(message)
    ? message
    : "unknown";
}
```

```ts
// packages/application/src/ports/common.ts:34-47
export class ApplicationPortError extends Error {
  readonly code: PortErrorCode;
  ...
  constructor(code: PortErrorCode, message: string, ...) {
    super(message);
    this.code = code;
  }
}
```

```ts
// packages/persistence-sqlite/src/sqlite-review-prereview-operations.ts:275, 287
this.fail("PORT_INVALID_OPERATION", "Prereview record is invalid");
if (!owned) this.fail("PORT_NOT_FOUND", "Prereview subject not found");
```

```ts
// packages/persistence-sqlite/src/sqlite-worker.ts:986-1003
const sqliteCode = ...;
if (sqliteCode === "SQLITE_BUSY" || sqliteCode === "SQLITE_FULL") {
  return {
    kind: "application",
    code: "PORT_CONFLICT",
    message: sqliteCode === "SQLITE_BUSY" ? "SQLite writer remained busy" : "SQLite is full",
    details: { sqliteCode },
  };
}
return {
  kind: "persistence",
  code: sqliteCode,
  message: error instanceof Error ? error.message : "SQLite worker operation failed",
  ...
};
```

新集成测试用的是 `throw new Error("SQLITE_BUSY")`（`test/integration/review-prereview-production.test.ts:415-417`），这不是真实适配器的错误形态，所以测试通过并不能证明生产路径会保留代码。

**建议：** 优先读取 `(error as { code?: unknown }).code`（或 `ApplicationPortError.code`），在 `code` 不匹配时再退回 `message`；或者删掉 `PORT_` / `SQLITE_` / `DECISION_` 这三个实际不起作用的允许项，并把说明改成只支持 `MODEL_` / `PREREVIEW_`。补一条使用真实 `ApplicationPortError` 或真实 SQLite 错误的反向/正向测试。

---

### 低：作者第 3 条“写结果失败时仍写入一行带费用的失败记录”只在 `recordFailure` 也成功时成立

**文件：** `packages/application/src/services/review-prereview.ts:266-275`

**问题：** `store.record()` 失败后，代码会再调 `store.recordFailure()`。如果同一个底层写故障是持续的（只读、磁盘满、数据库持续 busy），`recordFailure` 也会失败，此时不会留下带费用的失败行，只会在内存里退避。ADR 第 51 行已经承认“连失败记录也写不进时，只在内存里退避”，但作者本轮的表述是无条件“仍写入”。

**证据：**

```ts
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

新测试只让 `record` 失败，`recordFailure` 仍委托真实 store（`review-prereview-production.test.ts:405-428`），所以没有覆盖两者同时失败的路径。

**建议：** 把说法限定为“在失败记录可写时”，并补一条 `record` 与 `recordFailure` 都失败的测试，断言服务不崩、下一轮被内存退避挡住。

---

### 低：针对新前缀白名单没有真正会失败的反向用例

**文件：** `test/integration/review-prereview-production.test.ts:373-398`、`405-428`

**问题：** 现有反向用例的错误消息是 `"disk read failed for 我想记住的事"`，旧的正则 `^[A-Z][A-Z0-9_:.-]{0,100}$` 也会把它判成 `unknown`。没有用例验证“大写但不在白名单里的代码，例如 `EIO` / `ENOSPC` / `UNKNOWN_UPPER` 必须变成 `unknown`”。因此如果白名单被改回旧逻辑，现有测试仍会通过。作者第 2 条的关键限制实际上没有反向保护。

**建议：** 增加 `throw new Error("EIO")`、`throw new Error("ENOSPC")`、`throw new Error("SOMETHING_BAD")` 的用例，期望 `PREREVIEW_STORE_FAILED:unknown`；同时补真实 `ApplicationPortError("PORT_NOT_FOUND", "...")` 的预期，明确 `.code` 是否应保留。

---

## 推测与未核实

- 新增 `review.prereview` 会把整段固定提示词加入 `TRUSTED_PROMPT_TEXTS`（`packages/prompt-catalog/src/trusted.ts:10-14`），这是所有出口遮盖共用的信任清单。原则上，只有旧历史里出现**完全相同**的整段新提示词时，遮盖字节才会变化；我没有找到对应测试，也没有实际构造这种历史，所以只能标为低概率风险，需靠 `npm run check:prompt-prefix` 或额外测试核实。
- `#invoke()` 生成的 `MODEL_FAILED:${event.errorCode}` 不会经过 `failureCode()` 的正则（`review-prereview.ts:376-378`）。当前 Pi 适配器的失败码是常量（`pi-model-transport.ts:281-306, 408-430`），所以没有发现实际泄露；但如果以后 `event.errorCode` 变大或带其他格式，存储值不会受白名单约束。
- 数据导出的 `EVIDENCE_SCHEMA` 新增了必填的 `prereviews`，但 `FORMAT_VERSION` 仍是 `himawari.data-export.v1`（`packages/persistence-sqlite/src/data-export/schemas.ts:3, 299-328`）。由于导入本来就要求 `migrationSequence` 精确相等，升级后的旧备份通常已经在更早一步被拒绝，因此我暂时没有把它认定为实际回归；如果将来要在同一迁移序列内改证据格式，应把新字段设为 optional 或升 `FORMAT_VERSION`。
- 未运行任何测试或 `check:prompt-prefix`（复核工具只允许读取和 git 命令）；以下“自动检查”结论来自阅读测试源码，不代表实际执行通过。

---

## 侧重检查

- **错误路径：** 检查了模型输出过大/非法、`model.failed`、`store.record` 失败、`ownerHistory` 失败、`recordFailure` 失败、失败退避和每日上限。主要问题见上面第 1、2、3 条；服务本身在 `ProductionProactive.prereview()` 外层会捕获异常，不会把定时检查打崩。
- **不合规范或不可信输入：** `parsePrereview` 只接受对象、允许的 rating、整数且 0–1000 的 confidence（`review-prereview.ts:78-98`）；SQLite 写入前 `checkAttempt()` 校验 group、时间、分类、摘要、费用、耗时和 subject 归属（`sqlite-review-prereview-operations.ts:262-288`）；`listDone` 对 subject 数量和 id 长度有上限（同文件 `subjects()`）。未发现新的越权或注入问题。
- **安全：** 预评 prompt 只放 `group/category/text`，不放 `ownerRating`（`review-prereview.ts:64-75`，并有单测 `review-prereview.unit.test.ts:29-33`）；文字经 `maskSensitiveText` 遮盖；`visibleClassification()` 会排除缺少分级或 restricted 的条目。未发现新增泄露路径。
- **资源耗尽：** 输出上限 4096 字节、单轮 `perRun`、每日 `dailyLimit`、每日 `dailyCostMicros`、候选 subject 上限 2000 都存在；未发现明显无界循环。`ownerHistory` 查询窗口由 `historyDays` 限制。
- **不可撤销操作：** `decision_prereviews` 有 UPDATE/DELETE 触发器，且只在所属决策/邮件删除时级联删除；集成测试覆盖了不可改和级联删除（`review-prereview-production.test.ts:505-551`）。未发现新问题。
- **规则/文档/代码一致性：** ADR 0237 第 63 行（命令行取窗口最新版本）、第 72 行（只跑一个服务实例）与代码路径基本一致；配置键 `runPolicy.proactive.reviewPrereview.*` 与解析器、ADR 一致。唯一明显不一致的是失败代码来源，见第 1 条。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会改变既有会话的请求开头。** 本次增量没有改已有系统提示、工具定义或历史消息，只新增了一个独立的背景预评调用：

- `prereviewPrompt()` 把固定目录文字放最前，把本条目的 `group/options/category/text` 作为最后一行 JSON 追加：`packages/application/src/services/review-prereview.ts:64-75`。
- 单测明确验证“固定文字在前、本条数据在后”，并验证同样输入字节相同：`packages/application/test/review-prereview.unit.test.ts:13-27`。
- Pi 背景调用使用固定 `EGRESS_PLACEHOLDER_LEGEND` 系统提示，实际 prompt 放在最后一条 user 消息：`packages/runtime-pi/src/egress-context.ts:23-27`，测试见 `packages/runtime-pi/test/pi-model-transport.unit.test.ts:540-562`。
- 每轮变化的条目文字、类别等都在最后一条消息里；时间只是 Pi 消息的 timestamp 元数据，没有进入 prompt 文本。

**保留意见：** 新增 `review.prereview` 会扩大全局 `TRUSTED_PROMPT_TEXTS`，极端情况下可能改变旧历史中恰好包含同一长段固定文字时的遮盖字节；这是上面“推测与未核实”里的低概率风险，未实际验证。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**预评 prompt 本身不会。** `prereviewPrompt()` 的 JSON 键顺序固定、`prereviewOptions()` 的选项顺序固定；`maskSensitiveText()` 在没有 `tag`/`trusted` 选项时使用固定的 `[标签]` 占位符，`redactForEgress()` 不依赖后续内容（`packages/sensitive-capture/src/redaction.ts:244-275, 310-317, 542-544`）。单测覆盖了同输入同字节和卡号遮盖（`review-prereview.unit.test.ts:25-37`）。prompt 里没有当前时间、版本号、哈希或无序集合。

跨构建版本时，如果提示词目录或遮盖规则变了，同一段文字遮出的字节可能变化；这属于规则允许的版本变化，不是请求之间的上下文依赖。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

- **周报 `emptyCurrent`：** 有单测，且与“没有旧版本时显示通用空文案”的测试互为反向（`weekly-report.unit.test.ts:1074-1109`、`1111-1142`）。如果分支写反，这两条至少一条会失败。
- **写结果失败仍记费用：** 有集成测试（`review-prereview-production.test.ts:405-428`），如果代码不再写失败行，测试会失败；但它模拟的是裸 `Error("SQLITE_BUSY")`，没有覆盖真实 `ApplicationPortError`，也没有覆盖 `recordFailure` 同时失败（见第 2、3 条）。
- **失败代码白名单：** 正向有 `MODEL_OUTPUT_INVALID` 和 `SQLITE_BUSY`，反向只有含中文/空格的消息；**没有**“大写但不在白名单”的用例，因此第 2 条的反向保护不完整。
- **其他：** 有 calibration 单测覆盖“无版本参数时取窗口里最新版本”（`packages/calibration/test/prereview.unit.test.ts:168-176`）；未运行测试，未验证 `check:prompt-prefix`。

### 4. 每个新值的使用端都能接受吗？

已核对的主要链路：

- **配置键 `runPolicy.proactive.reviewPrereview.*`：** `strict-configuration.ts` 的 `rejectUnknown`、默认值和范围校验与 `DEFAULT_REVIEW_PREREVIEW`、服务读取一致；ADR 写的键名一致。
- **`review-prereview` 用途：** 已加入 `MODEL_USAGE_PURPOSES`、迁移 0091 的 `model_usage_observations.purpose` CHECK、控制中心的 `MESSAGE_PURPOSES` 和三种语言文案；服务侧传入的 purpose 能通过后端校验。
- **`hiddenByModel`：** `ProductionProactive` 产出，网关 schema `proactiveReviewSnapshotSchema` 接受为 `integer(0)`，控制中心使用并有 fixture 更新；两端一致。
- **周报 `prereview` / `otherVersions` / `emptyCurrent`：** 生产端 `production-observation.ts` 产出，网关 schema 字段和可空性匹配，`weekly-report.tsx:1394-1401` 使用；`weekly.prereview.emptyCurrent` 已登记到 `MESSAGE_IDS` 和 zh-CN/en/ja 三套资源，无占位符，能通过 i18n 检查。
- **`decision_prereviews` 的 id、`promptId`、`modelRef`、`textDigest`、rating/group/classification：** 服务端构造后由 SQLite 迁移 0091 的 CHECK、`sqlite-review-prereview-operations.ts` 的 `checkAttempt` 和导出 schema 接受；`id` 约 48 字符（<128）、promptId 约 29 字符、digest 64 位十六进制，长度/格式两端一致。导出/导入字段一一对应，且导入顺序先写父表再写 prereview。
- **失败代码：** DB 接受 1–128 字符、服务端也截到 128，长度端一致；但如第 1 条所述，真实错误码没有从 `.code` 取出来，导致实际值往往变成 `unknown`，这是本轮最需要修的使用端不一致。
- **`promptId` / `modelRef` 版本比较：** 服务计算用的 `prereviewPromptId()` 与周报观察端 `service-main.ts:2134-2147` 用的是同一套 `sha256` 和同一个 `modelRef`，命令行周报无版本参数时取窗口最新版本，和 ADR 描述一致。
