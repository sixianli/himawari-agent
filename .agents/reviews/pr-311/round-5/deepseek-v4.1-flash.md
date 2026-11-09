# 复核结论（PR 311 · 第 5 轮材料）

先说结论：本轮新增的 `checkedLost` 小改在“网络读取失败”这条路上是对的，反向用例也确实会失败；但作者声称的“读不到这条记忆（fresh 为 null）时保留详情”只覆盖了网络失败，没有覆盖“快照里没有这条记忆”这条路——后者会让详情抽屉直接关掉。ADR 与代码在这一点上不一致。

---

## 一、读代码证实的问题（按严重度）

### 1. 中：快照里没有这条记忆时，详情会被卸载，而不是保留并显示“来源已不可查”

文件：

- `apps/control-center/src/memory.ts:131-142`
- `apps/control-center/src/components/memory-page.tsx:1440-1441`、`1656-1669`
- `apps/control-center/test/memory-interactions.unit.test.ts:699-716`

问题：

`checkSource` 在读取成功但快照里没有该记忆时，会先 `setOverview(result.payload)`，然后返回 `null`。`MemoryBrowser` 的 `opened` 是从刷新后的 `overview.memories` 里按 `openId` 查的：

```ts
// memory.ts
const result = await client.query(...);
if (result.type !== "memory.overview.snapshot") return null;
setOverview(result.payload);
setFailed(false);
return result.payload.memories.find((item) => item.memoryId === memoryId) ?? null;
```

```tsx
// memory-page.tsx
let opened = openId ? byId.get(openId) : undefined;
...
{opened ? (
  <MemoryDetail key={opened.memoryId} item={opened} ... />
) : null}
```

所以当刷新后的快照不再包含这条记忆时，`opened` 变成 `undefined`，`MemoryDetail` 整个卸载；随后 `.then` 里的 `setCheckedLost(true)` 作用在已卸载的组件上，用户看到的是抽屉关闭，而不是“保留详情并显示来源已不可查”。这与 ADR 第 2 条写的“快照里没有这条记忆时……详情改显示来源已不可查”不一致。

本轮新增的用例只覆盖了另一种 `fresh === null`：`query.mockRejectedValueOnce` 让读取直接 reject；这条路径不会调用 `setOverview`，所以详情能保留。也就是说，新增用例没有覆盖“读取成功但快照缺这条记忆”的分支。

建议：

- 若确实要保留详情，`checkSource` 缺记忆时不要立刻用新快照把当前详情挤掉；可以在 `openId` 未变时保留上一次的 `item`，或把“来源已不可查”作为本地状态覆盖显示。
- 若认为抽屉关闭才是期望行为，则改 ADR 和作者说法，并补一个“读取成功但快照缺这条记忆”的用例把行为固定下来。

### 2. 低：一次临时读取失败会被永久标成“来源已不可查”，且顶部计数不更新

文件：

- `apps/control-center/src/memory.ts:138-141`
- `apps/control-center/src/components/memory-page.tsx:426-427`、`525-531`

问题：

```ts
} catch {
  setFailed(true);
  return null;
}
```

```tsx
const [checkedLost, setCheckedLost] = useState(false);
const origin = checkedLost ? "unavailable" : memorySourceState(item);
```

网络抖动也会走 `catch` → `fresh === null` → `setCheckedLost(true)`。结果详情永久显示“来源已不可查”，并且“跳到原话”按钮消失；用户只能关闭再打开详情才能重试。同时失败路径没有 `setOverview`，顶部 `memorySourceCounts` 的计数不会把这条算进去，详情与顶部数字不一致。ADR 已把这个行为写成有意为之，但从错误路径和无重试角度看仍不理想。

建议：把“读取失败”和“来源确实不可查”分成两种状态；读取失败显示可重试的错误，不要直接使用不可逆的“来源已不可查”文案。

### 3. 低：提醒合成引用的前缀在三处各自硬编码，只有长度常量被测试锁定

文件：

- `apps/control-center/src/memory-source.ts:3`
- `scripts/operations/memory-source-report.mjs:37`
- `apps/agent-service/src/production-reminder-writer.ts:187`
- `test/integration/memory-source-report.test.ts:24-26`

现状：

```ts
export const REMINDER_SOURCE_PREFIX = "memory-content:reminder:";
```

```js
AND p.source_id NOT LIKE 'memory-content:reminder:%'
```

```ts
contentRef = `memory-content:reminder:${input.key}`;
```

测试只锁定了 `SOURCE_REF_MAX_LENGTH === MEMORY_SOURCE_REF_MAX_LENGTH`，没有锁定脚本里的 `memory-content:reminder:%` 与页面常量一致。将来任一处改动，报表和页面的“提醒创建”分类会悄悄分叉，而现有门槛不会失败。

建议：在 `memory-source-report.test.ts` 里加一条前缀一致性断言，或把前缀放到共享包/常量里。

---

## 二、推测 / 未核实

- **资源上限（推测）**：`memory.overview.read` 现在会把所有记忆的 `sourceRefs` 一次性收进 `refsByThread`，再按每 200 个引用分批查询（`production-memory-control.ts:309-319`、`sqlite-memory-book-operations.ts:556-584`）。单条 SQL 有界，但一次概览读取的 SQL 次数随“记忆数 × 引用数”增长，没有总量上限。没有实测，不能断言是实际瓶颈，只是错误路径/资源方向的风险点。
- **合并后测试是否全绿（未核实）**：我不能运行测试。只能确认 `git diff --check` 无冲突标记，且 `2df8cc83..HEAD` 对本 PR 文件只增加了 main 的 proactive 相关改动，没有覆盖本 PR 的 `findOwnerMessages`、`sourceMessageId`、`memory-page` 逻辑。
- **`.agents/reviews/pr-311/round-4/verdicts.jsonl` 的 6 条内容（未核实）**：文件在 git 树里确实存在（`--name-status` 显示 A），但仓库是稀疏检出，`.agents/reviews` 不在工作区，且 `git show` 读取复核记录路径被拒绝，无法核对内容。
- **旧客户端兼容（推测）**：`sourceMessageId` 被加成 `memory.overview.snapshot` 的必填字段（`contracts-v2.ts:955`）。当前仓库内所有生产者和 fixture 都已更新；若存在滚动发布期间“新前端 + 旧后端”的组合，旧快照缺字段是否会被客户端拒绝，取决于部署是否始终同版本，未核实。

---

## 三、侧重检查

我按“错误路径、不合规/不可信输入、安全、资源耗尽、不可撤销操作、文档与代码一致性”逐项看了：

- **错误路径**：`checkSource` 的 reject 会 `setFailed(true)` 并返回 `null`（`memory.ts:138-141`）；成功但缺记忆会 `setOverview` 后返回 `null`。两者的 UI 结果不同，见问题 1、2。
- **不可信输入**：`findOwnerMessages` 全部使用参数绑定，`IN` 占位符数量来自服务端分组的 refs；脚本里唯一拼接的是数字常量 `SOURCE_REF_MAX_LENGTH`，无用户输入。
- **安全/越权**：查询显式限制 `t.owner_id = ? AND t.agent_id = ?`，并排除 `threads.status IN ('trashed','deletion_pending','deleted_verified')`（`sqlite-memory-book-operations.ts:570-578`）；没有新增对外命令，`memory.overview.read` 仍受已安装操作限制。
- **资源**：每 200 个引用一批，单查询变量数约 203，低于 SQLite 常见 999 上限；但总查询次数没有全局上限（见“推测”）。
- **不可撤销操作**：本 PR 不写库、不加迁移。注意 `memory.overview.read` 本身会先调用 `#purgeExpiredTrash()`（`production-memory-control.ts:279`），所以点击“跳到原话”触发的重读也会顺带触发既有的过期回收清理；这不是本 PR 新增的写路径，但“点击核对”并非严格只读。
- **规则/文档一致性**：
  - ADR 关于 `MEMORY_SOURCE_REF_MAX_LENGTH`、JS `.length` vs SQL `length()` 的说明与代码一致。
  - ADR 关于“快照里没有这条记忆时详情显示来源已不可查”与代码不一致（问题 1）。
  - ADR 关于“另一个对话显示超过 10 秒后请求作废”也与实际触发方式有出入（见下一条）。
- **非本轮引入的观察**：`message-focus.ts:21-23` 的 10 秒作废只在 `takeMessageFocus` 被调用时推进；`chat-history.tsx:114-128` 的 effect 只在依赖变化时运行。如果另一个对话一直显示且没有重新渲染，过期判断不会自己推进，陈旧请求可能超过 10 秒后仍然触发。这不是本轮 `checkedLost` 改动引入的，但和 ADR 的措辞不完全一致。
- **ADR 编号/迁移序号**：本 PR 使用 `0186`，main 上已被 0184、0185 占用，没有冲突；本 PR 不加迁移，main 的 `0081_proactive_push_backoff.sql` 与它无关。另观察到 main 自身存在两个 `docs/adr/0181-*` 文件（`0181-persistent-verified-download-cache-on-runners.md` 与 `0181-drop-node-floor-and-fold-test-into-coverage.md`），不是本 PR 引入，但合并后仓库里确实重复。

---

## 四、作者说法核对

1. **“fresh 为 null 时保留详情并显示来源已不可查，并补了用例”**：部分成立。网络失败路径成立；读取成功但快照缺记忆的路径不成立，详情会关闭。新增用例只测了 reject，没有测“快照缺记忆”。见问题 1。
2. **“ADR 三处措辞更新”**：成立。`0186` 的第 1 条（UTF-16/SQL 长度说明）、第 2 条（读取失败/缺记忆说明）、后果里的常量说明共三处。
3. **“新增 round-4/verdicts.jsonl（6 条低）”**：文件在 git 树中新增属实，内容因稀疏检出和记录路径限制未核实。
4. **“合入最新 main，无冲突”**：从 git 层面成立：`5c019086` 是 merge commit，`git diff --check` 无冲突标记，`2df8cc83..HEAD` 对本 PR 文件只增加 main 的 proactive 改动。测试是否全绿未核实。

---

## 五、必答问题

### 1. 是否改变模型已经见过的请求开头？

**没有证据表明会。** 本 PR 不修改系统提示、工具定义、历史消息、遮盖逻辑，也没有改动 `packages/prompt-catalog` 或 runtime 请求组装代码。本次唯一的契约改动是 UI 用的 `memory.overview.snapshot` 增加 `sourceMessageId`；我用 grep 确认 `memory.overview.read` 只出现在 control-center 的 `memory.ts`、测试和 `production-memory-control.ts`，没有进入模型请求组装。因此发给模型的内容仍然只在末尾追加，每轮会变的值仍然留在最后一条消息里。合并 main 带来的是 main 已有改动，相对 main 没有额外改变模型输入。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会因本 PR 发生。** 新增值都是确定的：`earliestSourceMessage` 先按 `sequence` 排序取最早（`production-memory-control.ts:104-115`），`findOwnerMessages` 每批按 `ORDER BY t.sequence`；`sourceRefs` 由 `sqlite-memory-operations.ts:452-459` 的 `ORDER BY source_type, source_id` 产生。没有把时间字段或无序遍历结果放进模型输入。`message-focus` 里的 `Date.now()` 只影响浏览器高亮。报表脚本的 SQL `length()` 与页面的 JS `.length` 在非 BMP 字符上可能不同，但 ADR 已把它写成已知差异，且这不是同一请求内前后字节变化。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有，且本轮反向用例按代码推理会失败；但不是所有路径都有用例。**

- 本轮新增的 `memory-interactions.unit.test.ts:699-716`：如果删掉 `else setCheckedLost(true)`，`origin` 仍是 `jump`，详情里仍会出现“跳到原话”，`expect(...).not.toContain("跳到原话")` 会失败。因此这条反向用例是有效的。
- 但“读取成功、快照里没有这条记忆”的分支没有用例；新增用例用的是 `mockRejectedValueOnce`，只覆盖 reject。
- 其他反向覆盖：`production-memory-capture.test.ts` 覆盖了 agent 引用不命中、消息被删、线程进回收站/删除中、消息未提交、超长引用不参与匹配；`memory-source-report.test.ts` 覆盖了对话不对、引用对不上、回收站、提醒混真引用等；`message-focus.unit.test.ts` 覆盖了别的对话、消息不存在。未运行测试，以上“会失败”是按代码路径推理的结论。

### 4. 改动产生/修改的每个值，两端是否都能接受？

我逐项核对了：

- **`sourceMessageId`**：产生于 `production-memory-control.ts:347`（`earliestSourceMessage`），值为 `MessageId`；消费端 `contracts-v2.ts:955` 使用 `nullable(machineString)`，`MessageId` 的 `MACHINE_IDENTIFIER_PATTERN` 与 `machineString` 规则一致；UI 的 `memory-source.ts:23` 只做真值判断。通过。
- **`MEMORY_SOURCE_REF_MAX_LENGTH`**：定义于 `contracts-v2.ts:19`，网关过滤和契约 `boundedString(512)` 共用；脚本保留独立 `SOURCE_REF_MAX_LENGTH`，由 `memory-source-report.test.ts:25` 锁定相等。通过（提醒前缀除外，见问题 3）。
- **`memoryBook.findOwnerMessages`**：适配器发送的字符串（`durable-adapters.ts:958`）与 `sqlite-memory-book-operations.ts:106` 的 case 完全一致，端口定义在 `memory-book.ts:121`，没有额外的操作白名单。通过。
- **ADR 编号**：`0186` 在 main 上未被占用；本 PR 不加迁移，不存在迁移序号冲突。通过。
- **i18n 消息 ID**：新增 5 个 ID 已加到 `message-ids.ts`，并在 `en.ts`、`ja.ts`、`zh-CN.ts` 三个资源中都有对应文案；带参数的三个还加进了 `MESSAGE_SAMPLE_VALUES`。通过。
- **浏览器/契约 fixture**：`gateway-v2.fixture.ts:379`、`control-center-browser-server.mjs:849/897` 都补了 `sourceMessageId`；`control-plane-snapshots.json` 里的是 `memory.snapshot`，不是 `memory.overview.snapshot`，不受影响。通过。

**总体判断**：本轮 `checkedLost` 在“网络失败”路径正确，主路径（来源消息被删，记忆仍留在快照里、`sourceMessageId` 变成 null）行为也正确；主要问题是对“快照缺这条记忆”这条路的实现/文档/用例不一致，以及读取失败被当作不可逆来源丢失。建议至少修正 ADR 措辞并补上“快照缺记忆”的用例，再决定该路径是保留详情还是关闭详情。
