# 复核结论

增量改动是只读的控制中心/运维读取路径，没有触碰模型请求组装。没有发现高严重度问题；主要问题是「清洗只做了一半」以及若干跨契约/资源边界的不一致。

## 一、读代码证实的问题（按严重度）

### 1. 中：`clean` 只清洗 `floorHits`，`memoryByMail` 和「清洗后变空」的编号仍会让整个查询失败

- 文件:行：`apps/agent-service/src/production-observation.ts:321-329`；`apps/agent-service/src/production-gap-cases.ts:32-39`；`packages/gateway-contracts/src/validation.ts:88-99`
- 问题：`forMail` 只对 `field === "floorHits"` 调用 `clean`，记忆编号原样返回。`clean` 会把全控制字符的编号变成空串；而快照末尾的 `gatewayV2MessageSchema.parse(snapshot)` 对 `ruleIds`/`memoryIds` 用的是 `boundedString(256)`，它明确拒绝控制字符和空串（`input.length === 0`）。写入侧的 `validateInputs` 对这两类值只校验长度 1..256，不校验可打印字符，所以库里一旦有这类值，`decision.email.read` 会整体抛 `ContractValidationError`，不是降级显示。
- 证据：
  ```ts
  (inputs[field][messageId] ?? []).map((id) =>
    field === "floorHits" ? clean(id, 256) : id,
  ),
  ```
  ```ts
  export function clean(text: string, limit: number): string {
    let kept = "";
    for (const character of text.replace(/\p{Cc}+/gu, " ").trim()) { ... }
    return kept;
  }
  ```
  ```ts
  if (typeof input !== "string" || input.length === 0 || input.length > maximum ||
      [...input].some((character) => { const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f; })) fail(...)
  ```
  ```ts
  const ids = (value: unknown, max: number) =>
    Array.isArray(value) && value.length <= max &&
    value.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 256) &&
    new Set(value).size === value.length;
  ```
- 建议：用一个统一的编号规范化函数处理 `floorHits`/`memoryByMail`（必要时也包括键），对清洗后为空或仍不合法的条目直接丢弃并当作「无记录」；或在写入侧就用与快照相同的校验拒绝非法编号。现在 README/说明里的「规则编号清洗」并不等于「非法编号不再让页面失败」。

### 2. 低：`forMail` 直接索引未校验形状的 JSON，特定编号会触发 TypeError

- 文件:行：`apps/agent-service/src/production-observation.ts:320-329`
- 问题：`inputs[field][messageId]` 没有检查 `inputs[field]` 是否为对象、`messageId` 是否为自有属性、取到的值是否为数组。查询入参 `messageId` 的正则允许 `__proto__`、`constructor` 这类字符串；若恰好存在同名处理记录，直接索引会拿到 `Object.prototype`/`Function`，随后 `.map` 抛错，返回 500。若历史数据里 `floorHits` 字段被写成 `null`/非对象，也会同样抛错。
- 证据：
  ```ts
  const forMail = (field: "floorHits" | "memoryByMail" | "relatedByMail") =>
    inputs && fields.has(field)
      ? [ ...new Set((inputs[field][messageId] ?? []).map(...)) ].sort()
      : null;
  ```
- 建议：用 `Object.hasOwn(inputs[field], messageId)` 且 `Array.isArray(...)` 判断后再用，否则返回空数组。这个问题在本轮之前就存在，但正好落在本轮修改的表达式里。

### 3. 低：`readMailTrace` 无上限地读取同一封邮件的全部 Muse 条目

- 文件:行：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:528-539`（无 `LIMIT`）；对比同文件 `573-595` 的 gap 查询有 `LIMIT 1000`
- 问题：同一封邮件可以对应任意多条 `muse_reference_entries`（`paired_message_id` 无唯一约束）。服务端为了「比较须看全部条目」把全部行读入内存，只在展示时 `slice(0, 20)`。Muse 条目数量不可控时会形成读取放大；虽然解密只做 20 条，但 SQL 行和对象仍是全量。
- 证据：
  ```sql
  FROM muse_reference_entries e
  LEFT JOIN muse_intake_items i ...
  WHERE e.owner_id = ? AND e.agent_id = ? AND e.paired_message_id = ?
  ORDER BY e.muse_at, e.id
  ```
  对比 gap 查询结尾：`ORDER BY e.muse_at, e.id LIMIT 1000`
- 建议：比较用的「是否有 reminded 条目」用 SQL 聚合（如 `EXISTS(... muse_reminded = 1)`）或单独查询，展示用的 20 条再单独取；或至少加一个硬上限并让 `truncated` 的表达与上限一致。

### 4. 低：邮件快照的 `memoryIds` 与依据链快照的 `memoryId` 校验不一致，新增的「下划线记忆编号」用例不符合真实领域约束

- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:1049`（依据链 `memoryId: machineString`）对 `packages/gateway-contracts/src/contracts-v2.ts:1105`（邮件 `memoryIds: nullable(array(boundedString(256)))`）；`packages/domain/src/identifiers.ts:39`
- 问题：邮件快照接受 `_memory-c`，依据链快照的 `memoryId` 使用 `machineString`，首字符必须是字母或数字。测试在 `test/integration/decision-email.test.ts:59` 写入 `_memory-c`，但真实 `MemoryId` 不允许下划线开头；而前端打开邮件页后会再用同一个 `decisionId` 调 `decision.chain.read`。该用例在邮件层通过，却没有证明真实数据在这两个快照之间一致。
- 证据：
  ```ts
  // 依据链
  memoryId: machineString,
  // 邮件
  memoryIds: nullable(array(boundedString(256))),
  ```
  ```ts
  const MACHINE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  ```
- 建议：两个快照对同一来源的 memory id 使用同一校验器；测试里用真实领域允许的编号，或明确这是一条「防御性契约」用例。

### 5. 低：规则编号在两个页面使用的规范化函数不同，高亮可能对不上

- 文件:行：`apps/agent-service/src/production-observation.ts:325-326`（`clean`：把连续控制字符合并成一个空格、`trim`、截断到 256）对 `apps/agent-service/src/production-decision-chain.ts:56-62`（`displayRuleId`：逐字符替换 `<0x20`/`0x7f`，不合并、不 `trim`）；消费方 `apps/control-center/src/components/decision-chain-drawer.tsx:169-170`
- 问题：邮件页用清洗后的 `floorHits` 生成 `thisMail.ruleIds`，依据链用 `displayRuleId` 生成 `ruleId`，再比较是否「这封邮件用到」。对单个控制字符两者结果一致（测试用的 `rule\nwith\tcontrol` 恰好如此），但连续控制字符、前后空白会产生不同字符串，导致高亮丢失或同一编号显示不同。
- 证据：
  ```ts
  const displayRuleId = (ruleId: string) =>
    [...ruleId].map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : character;
    }).join("");
  ```
  ```ts
  {thisMail?.ruleIds.has(rule.ruleId) ? ` · ${message("decision.email.thisMail")}` : ""}
  ```
- 建议：抽一个共享的展示用编号规范化函数，两个只读快照都用它。

### 6. 低：作者说明的「4 类回归用例」与本轮增量不符；展示上限 20 在文案里硬编码

- 文件:行：`test/integration/decision-email.test.ts:348`（本轮唯一新增的 `it`）、`:303`（20/21 用例在 `9d3a4b` 已存在）、`:55-59`/`:283-284`（控制字符/下划线是通过改 fixture 覆盖旧用例）；`packages/application/src/ports/decision-ledger.ts:199`、`apps/control-center/src/i18n/resources/zh-CN.ts:1033`、`en.ts:1095`、`ja.ts:1096`
- 问题：`git diff 9d3a4b..d063` 在 `decision-email.test.ts` 只新增了一个 `it`（比较看全部条目），20/21 截断用例在上一轮提交已有；其余两类是改既有用例的 fixture。这与「这一轮补了 4 类回归用例」的表述不完全一致。另外 `MAIL_TRACE_MUSE_LIMIT = 20` 是常量，但三语文案把 20 写死，改上限时文案会过期。
- 建议：说明改成「本轮补 1 条新用例并扩展 2 类 fixture 覆盖，20/21 用例沿用上一轮」；文案从常量生成或至少同步维护。

## 二、推测 / 未核实

- 上述「控制字符编号」在正常生产数据里很难触发：`floorHits` 的规则编号来自固定常量（`packages/application/src/services/proactive-rules.ts:29-33`、`:66-81`），记忆编号由领域 `createMemoryId` 生成。因此问题 1/2/5 更像是对损坏/旧库数据的防御缺陷，而不是正常路径缺陷——能否触发取决于是否存在历史畸形数据或直接改库（**推测**）。
- 无法核实 `docs/assets/p1-5/email-decision-demo.webm` 的内容是否与字幕一致（二进制变更，只能确认文件被更新）。
- 未运行任何测试；以下关于「会不会失败」的判断来自读代码推理，不是执行结果。

## 三、侧重检查

- 错误路径/不合规输入：已核对不存在邮件、他人邮件、扣留正文、旧记录无 inputs、跳过邮件；这些路径都有返回值/测试。控制字符与字段形状是剩余缺口（问题 1、2）。查询入参由 `gmailMessageId` 在契约层校验，`readMailTrace` 的 SQL 使用参数绑定，未发现注入。
- 安全：`readMailTrace` 按 `owner_id/agent_id` 过滤，测试验证了他人邮件返回空；`prod-read.sh gmail-decisions` 固定查询、只读打开、`JSON.stringify` 输出、字段截断，未发现把邮件/记忆正文带出。新增页面只读，未引入写入或不可逆操作。
- 资源耗尽：问题 3 是唯一明确的放大点（同一邮件条目数不受限）。
- 规则/文档一致性：ADR 0197 与实现基本一致（20 条、旧记录 null、共用 `mailComparisonBucket`、按 owner 隔离）；`test-and-production-hosts.md` 对 `gmail-decisions` 的描述与脚本一致。不一致处是作者说明的用例归类，以及问题 6 的硬编码 20。

## 四、必答问题

1. **不会改变模型看到的请求开头。** 本次增量没有修改系统提示、工具定义、历史消息、遮盖或任何请求组装代码；新增的 `decision.email.read` 只被控制中心只读查询使用，`clean` 只用于控制中心快照。发给模型的内容仍然只追加，没有新增每轮变化的值进入请求头。依据：diff 未触及 `packages/prompt-catalog`、运行时/线程/遮盖相关文件。
2. **不会造成同一段文字在不同请求里变成不同字节。** `clean` 是纯函数，只依赖输入文本和长度；规则编号排序、去重固定；Muse 条目按 `muse_at, id` 排序；邮件快照没有当前时间字段（没有 `generatedAt`）。因此新接口本身的输出是确定的。它也不在模型请求路径上，所以不影响提示缓存字节。
3. **有对应的自动检查，但覆盖面有缺口。** 新增的「比较看全部条目」用例（`test/integration/decision-email.test.ts:348`）在旧实现「先 slice 再比较」时会得到 `himawariOnly` 而不是 `both`，会真的失败；控制字符 fixture（`:55-58`、`:283`）在没有 `clean` 时会因 `boundedString` 拒绝控制字符而失败；20/21 截断用例（`:303`）会区分 `>` 和 `>=`；`prod-read` 的双引号编号用例（`test/tooling/prod-read.test.mjs:267-291`）会暴露 JSON/SQL 转义问题。**没有**覆盖「全控制字符清洗成空串」和「记忆编号含控制字符」，且「下划线记忆编号」不符合真实领域约束，属于合成用例。
4. **逐值核对结果：**
   - `decision.email.read` / `decision.email.snapshot`：契约、操作清单、网关路由、控制中心可用性判断、浏览器 fixture、单元测试一致。
   - `messageId`：gap case 生产端用 `GMAIL_MESSAGE_ID_PATTERN` 过滤，消费端查询用同一正则，测试还断言了与存储层正则的 source/flags 相同（`decision-email.test.ts`），这符合 I-73 的双端核对；长度 256/257 也有用例。
   - `MAIL_TRACE_MUSE_LIMIT = 20`：生产端 slice/truncated 与契约、界面结构一致；但三语文案硬编码 20，见问题 6。
   - `comparison`：`MailComparisonBucket` 的四个值 + `noMuseEntry`/`noHimawariRecord` 都在契约枚举和三语文案里有对应分支。
   - `ruleIds`：生产端清洗后为不落控制字符的字符串，消费端 `boundedString(256)` 可接受；但与依据链的 `displayRuleId` 规范化不完全一致（问题 5）。
   - `memoryIds`：生产端不清洗，消费端 `boundedString(256)`；与依据链的 `machineString` 不一致，且空串会被拒绝（问题 1、4）。
   - `title`/`text`：经 `clean` 后长度受限，空结果返回 null，符合 `proactiveTextSchema`。
   - 时间/ID 字段（`museAt`、`processedAt`、`entryId` 等）：数据库有长度/枚举约束，但时间格式写入侧没有像校准读取那样统一断言；若旧库有非规范时间，快照解析会失败（**推测**，未在增量中验证）。
