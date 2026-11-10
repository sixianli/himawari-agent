## 结论

未发现高、中严重度问题。这个改动本身是显示层修正：模型侧仍走 `compose`，`outline` 只用于控制中心 `memory.overview.read` 快照；记忆页按 `memoryId` 匹配和编辑，没有按 `text` 匹配。以下问题都是低严重度的文档/测试夹具一致性，以及一处未来维护风险。

## 问题（按严重度从高到低）

### 低 1：ADR 的“门槛”清单没有记录这次新增的页面行检查

- 文件：`docs/adr/0199-show-memory-dates-to-the-model.md:83-88`
- 问题：ADR 写着“门槛（每条去掉对应修改都会失败，已实测）”，但下面只列了 5 条 `[MEMORY-DATE]` 用例，没有列 `production-memory-capture.test.ts` 的 `[MEM-PIN]` / `[MEM-CAT]`。本次新增的“记忆页档案行带日期、页面行字数与 used 对齐”行为实际由这两个用例保护，ADR 没有记录。
- 证据：

  ```text
  - 门槛（每条去掉对应修改都会失败，已实测）：
    - `packages/runtime-pi/test/prompt-prefix.compat.test.ts` `[MEMORY-DATE]`: ...
    - `test/integration/memory-model-visible.test.ts` `[MEMORY-DATE]`: ...
    - `test/integration/context-projection.test.ts` `[MEMORY-DATE]`: ...
    - `apps/agent-service/test/production-model-composition.unit.test.ts` `[MEMORY-DATE]`: ...
    - `packages/application/test/owner-profile-service.unit.test.ts` `[MEMORY-DATE]`: ...
  ```

- 建议：在门槛清单里补上 `test/integration/production-memory-capture.test.ts` 的 `[MEM-PIN]` 和 `[MEM-CAT]`，写明去掉 `outline` 的 `dateNote` 拼接后它们会失败。

### 低 2：ADR 后果句现在字面上不完整

- 文件：`docs/adr/0199-show-memory-dates-to-the-model.md:79`
- 问题：原文写“日期只出现在最后一条用户消息的资料块里”。这句话所在段落讲的是模型请求前缀，本意仍然成立；但本次改动后，日期也出现在控制中心的记忆页快照里，字面上已经不是“只出现在”资料块。容易让后续读者误以为页面上不可能有日期。
- 证据：

  ```text
  - 不改模型已经见过的请求开头：日期只出现在最后一条用户消息的资料块里（前提 5、7）；
  ```

- 建议：改成“发给模型时，日期只出现在最后一条用户消息的资料块里”，或在同句说明记忆页展示的是同一份日期的只读副本。

### 低 3：E2E 假服务器夹具仍返回“无日期档案行”和旧的 used

- 文件：`test/e2e/fixtures/control-center-browser-server.mjs:761-765`、`:814-822`
- 问题：`lines()` 仍直接返回记忆原文，`profileUsage.used` 仍是固定值 `118`。本次改动后，生产上档案行会带日期，且页面行长度加 3 之后应等于 `used`；这个夹具不再符合生产不变量。浏览器验收如果只检查“记忆页能打开”，不会暴露问题，但以后若有人用这个夹具检查页面行/已用字数，会得到与生产不一致的结果。
- 证据：

  ```js
  const lines = (ids) =>
    ids.map((memoryId) => {
      const found = memories.find((entry) => entry.memoryId === memoryId);
      return { memoryId, text: found.text, updatedAt: found.updatedAt };
    });
  ...
  profileUsage: { used: 118, limit: 2000, queued: ["memory-coffee"] },
  ```

- 建议：给夹具的 `lines()` 补上与生产同格式的日期说明，并重算 `used`；或者明确标注这个夹具只模拟旧格式，另加一组带日期的夹具给记忆页验收使用。

### 低 4：`[MEM-PIN]` 只断言“任意日期”，没有断言实际日期

- 文件：`test/integration/production-memory-capture.test.ts:1619-1621`
- 问题：`dated()` 只匹配 `YYYY-MM-DD`，不检查日期值。若 `outline` 误用了 `updatedAt`、错了时区，或格式正确但日期取错，这个用例仍会通过。真正按精确日期覆盖的是 `compose` 的 `[MEMORY-DATE]` 单测，不是 `outline`。
- 证据：

  ```ts
  const dated = (text: string) =>
    expect.stringMatching(new RegExp(`^${text}（记于 \\d{4}-\\d{2}-\\d{2}）$`, "u"));
  expect(profiled()).toEqual([dated("我每天必须喝咖啡"), dated("主人最喜欢的颜色是蓝色")]);
  ```

- 建议：测试时钟是固定的，可以直接断言精确日期（例如 `（记于 2026-10-25）`）；或在 `owner-profile-service.unit.test.ts` 增加 `outline` 在 `Asia/Tokyo`、有 `validFrom`/`validTo` 时的精确文本断言。

### 观察（不是当前缺陷）：`OwnerProfileLine.text` 的语义变了

- 文件：`packages/application/src/services/owner-profile-service.ts:46-50`、`:140-143`
- 说明：接口字段仍叫 `text`，但 `outline` 返回的它现在是“正文 + 日期说明”，不再是原始记忆正文；`compose` 仍然返回正文和 `dateNote` 分开的中间结构。当前所有消费者都只展示它，或把它用作无障碍标签，按 `memoryId` 匹配和编辑；没有消费者把它当原始正文比较。证据：`apps/control-center/src/components/memory-page.tsx:1289` 用 `line.memoryId` 做 key，`:1296` 只展示 `line.text`，`:1310` 用作 aria-label；`:1374-1376` 的 `carried` 集合也只收集 `memoryId`。
- 建议：为了避免以后有人把 `outline.text` 拿去和 `MemoryItem.text` 比较或回写，最好改名成 `displayText`，或在接口上注释“这是展示用文本，含日期说明，不能当作记忆原文”。

## 读代码证实的

- `outline` 只在 `apps/agent-service/src/production-memory-control.ts:555-582` 被调用，用于 `memory.overview.read` 的 `profile` 快照；没有其他生产调用点。全仓匹配 `outline`、`OwnerProfileOutline`、`profileUsage`、`.profile`、`line.text` 后，消费者只有这个控制服务和 `apps/control-center/src/components/memory-page.tsx`。
- 模型路径不走 `outline`，走 `compose`：`packages/application/src/services/context-formation-service.ts:227-235` 调用 `profile.compose(...)`；`packages/runtime-pi/src/pi-runtime-adapter.ts:635-636` 在最后一条用户消息的上下文块里拼日期。这个 PR 没有改这两处。
- “主人的要求”不带日期：`owner-profile-service.ts:203-206` 对 rules 调用 `take(..., false)`，`:190-192` 在 `dated === false` 时把 `dateNote` 设为 `""`；`:217-222` 对档案分区调用 `take(..., true)`。`outline` 的 `line` 对 rules 拼上空字符串，因此 rules 文本仍是原文。
- `usage.used` 在本次改动前就已经包含日期字数：`owner-profile-service.ts:193` 计算 `text.length + dateNote.length + 3`，`:229-233` 用它算 `used`；`outline` 只是原来把 `dateNote` 丢掉了。
- 快照里的 `text` 通过 `apps/agent-service/src/production-memory-control.ts:561-566` 的 `singleLine`，最终由 `packages/gateway-contracts/src/contracts-v2.ts:1191-1196` 的 `boundedString(2000)` 校验；默认预算下 `text + dateNote <= 1997`，能通过。`memoryId`、`updatedAt` 没有变化。
- 记忆页没有按 `text` 匹配、编辑或置顶：置顶命令使用 `overview.memories` 里的 `item.memoryId`（`memory-page.tsx:1287-1312`），详情打开也用 `item`，不是 `line.text`。因此带日期不会破坏置顶、编辑、按 text 查找等流程。
- `[MEM-PIN]` 的 `profiled()` 和 `[MEM-CAT]` 的 `coffee()` 已经按带日期的文本判断（`production-memory-capture.test.ts:1615-1621`、`:1796-1810`）；`[MEM-CAT]` 还保留了“转成 rule 后文本等于原文”的断言（`:1819-1822`），可以防止 rules 被误加日期。

## 推测 / 未核实

- 我未实际运行测试（本次只能读代码和查 git），所以“去掉改动后测试会失败”是按测试代码推断，不是实测结果。
- `characterBudget` 可以配置成大于 2000；那种情况下 `singleLine` 的 `slice(0, 2000)` 可能截掉日期说明，导致页面行长度与 `used` 不一致。生产组装没有传 `characterBudget`（`production-http-composition.ts:1043-1058`），默认是 2000，因此这是理论边界，不是当前生产问题。
- E2E 浏览器验收是否检查了“已用字数”或档案行文本，我没有逐条跑浏览器场景；只确认夹具本身仍是无日期旧格式。

## 侧重检查

- **错误路径**：`memoryDatesOf` 对无效 `recordedAt`、`validFrom`、`validTo` 有退回（`memory-dates.ts:25-32`）；`memoryDateNote` 只使用固定提示词和格式化日期（`:49-58`）。无效的 `updatedAt` 会让 `localDate`/`Intl` 抛错，但 `#select` 在本次改动前就已经为 `outline` 计算 `dateNote`，不是本次新增的错误路径。
- **不合规范或不可信的输入**：日期输入经过 `isDateText` 的格式和 `Date.parse` 校验；日期说明由提示词目录固定文字拼接，页面由 React 转义，没有 HTML/注入风险。
- **安全**：日期只进入控制中心快照，不进入模型请求；页面本来就是 owner 自己的数据。记忆列表已经显示 `recordedAt`（`memory-page.tsx:372`），档案行增加生效/记下日期没有引入新的敏感信息泄露路径。
- **资源耗尽**：没有新增查询、循环或排序；`#select` 本来就会为 `outline` 计算 `dateNote`，本次只是把已算好的字符串拼进去。
- **不可撤销的操作**：没有写入、删除、迁移或外部副作用；`outline` 只读取并组装返回值。
- **规则文件、说明文档和代码一致性**：ADR 的两处主要改写与代码一致；仍有两处低严重度文档/夹具问题，见上面的问题 1、2、3。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。发给模型的内容仍由 `compose` 和 `runtime-pi` 的资料块生成，`outline` 只服务 `memory.overview.read` 页面快照。这个改动没有改系统提示、工具定义、历史消息、出口遮盖，也没有改 `compose` 的拼接。模型侧仍然只在最后一条用户消息的上下文块里带日期；每轮会变的当前时间等值仍只在最后一条消息里，符合 `.claude/rules/prompt-prefix.md` 第 2 条“每轮都会变的内容只放在最后一条用户消息里”和第 4 条“只能追加”。依据代码：`context-formation-service.ts:227-235`、`pi-runtime-adapter.ts:635-636`、`production-memory-control.ts:555-582`。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会引入新的不确定性。时间说明由 `memoryDatesOf` + `memoryDateNote` 按记忆记录和配置时区计算，不读取“今天”；`memoryDateNote` 不使用相对时间。`outline` 的分区和排序沿用固定 `PROFILE_SECTIONS` 和原有排序。唯一的既有变化来源是 `recordedAt` 为空时退回 `updatedAt`，恢复/修改会让日期变一次；这是 ADR 0199 已记录的既有行为，不是本次新增。模型侧日期字节与改动前完全相同。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有。`production-memory-capture.test.ts` 的 `[MEM-PIN]` 要求页面行匹配“正文 + （记于 YYYY-MM-DD）”，并用页面行长度加 3 计算 `used`（`:1619-1623`、`:1641-1642`）；`[MEM-CAT]` 用带日期的前缀判断记忆是否仍在档案里（`:1800-1810`），并用“转成 rule 后文本等于原文”防止 rules 被误加日期（`:1819-1822`）。按代码推断，去掉 `outline` 里的 `${text}${dateNote}` 后这些断言会失败；我未实际运行测试。缺口是：`[MEM-PIN]` 只匹配任意日期，没有固定精确日期；E2E 夹具仍是未改的旧格式；ADR 门槛清单没有记录这两个用例。

4. **每个被改动/产生的值，所有使用它的地方都能接受吗？**
   当前能接受。产生处是 `owner-profile-service.ts:142` 的 `text: `${text}${dateNote}``；使用链是 `production-memory-control.ts:561-566`（`singleLine`）→ `contracts-v2.ts:1193-1194`（`boundedString(2000)`）→ `memory-page.tsx:1296` 展示、`:1310` 用作 aria-label。页面匹配和编辑用 `memoryId`（`:1289`、`:1374-1376`），不用 `text`，所以“带日期后按 text 匹配出错”的担心在当前代码里不成立。`memoryId` 和 `updatedAt` 未变。唯一需要留意的是 `text` 语义已经从“记忆正文”变成“记忆正文 + 日期说明”，未来若有新消费者按原文比较或回写，就会出错；建议改名或加注释。
