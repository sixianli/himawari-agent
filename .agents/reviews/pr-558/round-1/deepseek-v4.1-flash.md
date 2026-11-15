### 1. 高｜迁移把历史“想一想”对话一并标成 `owner`，旧的想一想对话仍会出现在列表、搜索、导出和推送里

文件:行：`packages/persistence-sqlite/src/migrations/20261115045512_thread_origin.sql:1`；`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1437`

问题：迁移只加默认值，没有回填，所有已有对话（包括线上已经存在的想一想对话）都会变成 `origin = 'owner'`。而新增的过滤条件按 `origin = 'owner'` 保留，所以这些旧想一想对话继续出现在主人可见的地方。下一个 PR 的到期清理又只删 `origin = 'think'`，这些旧行也不会被自动清掉。

证据：
- `ALTER TABLE threads ADD COLUMN origin TEXT NOT NULL DEFAULT 'owner';`
- `const conditions = ["owner_id = ?", "agent_id = ?", "origin = 'owner'", lifecycle];`

建议：明确二选一：(a) 加一次性回填，证据可用 `thread_command_receipts` 中 `command_type = 'thread.create'`、`idempotency_key` 以 `think-thread:` 开头且 `thread_id` 以 `thread:think:` 开头的记录，最好再与 `think_inbox` 行交叉核对，避免客户端伪造；(b) 明确接受旧对话继续可见，并在 PR 乙的删除逻辑里单独处理旧行。仅凭编号前缀回填不安全，因为客户端可以自己指定 `threadId`。

### 2. 中｜网关 v2 事件流仍未过滤想一想运行的事件

文件:行：`packages/persistence-sqlite/src/sqlite-durable-operations.ts:5536-5542`、`:5563-5574`

问题：作者列的“对话事件”只修了 v3 的 `listGatewayEvents`。v2 的 `queryGatewayTrace` / `gatewaySubscription` 仍只检查 `threads.status = 'open'`；归档的想一想对话仍是 `status = 'open'`（只是 `archived_at` 非空），条件照样通过。控制中心确实订阅 `/api/gateway/v2/events`（`apps/control-center/src/sse-synchronizer.ts:29-33`），只是当前 `onEvent` 只触发刷新（`apps/control-center/src/app.tsx:311-314`），所以至少会把想一想运行的 `scopeId`、`eventType`、`payloadRef` 送到主人浏览器；是否显示成可见条目未核实。

证据：
```sql
AND (thread_id IS NULL OR EXISTS (
  SELECT 1 FROM threads WHERE threads.id = gateway_stream_events.thread_id
    AND threads.status = 'open'
))
```

建议：在这两处加 `NOT EXISTS (... threads.origin = 'think')`，或改为按运行/线程的 origin 过滤。另请确认 `gateway_stream_events` 在生产是否还有人写；我没找到 `appendEvent` 的生产调用方，若该流已废弃，应删掉或在文档里标明。

### 3. 中｜搜索结果本身的 `origin` 过滤没有会被反向用例抓住的检查

文件:行：`packages/persistence-sqlite/src/sqlite-thread-operations.ts:2031`；`test/integration/think-runner.test.ts:470-472`

问题：新增测试只检查 `pendingSearchProjection` 不返回想一想对话，没有向搜索投影表写入想一想线程的行再调用 `search()`。删掉 `search()` 里的 `current_thread.origin = 'owner'`，现有用例仍会通过，因为该线程根本没被索引。

证据：
- `"current_thread.origin = 'owner'",`
- 测试只调用 `.pending({ ownerId: OWNER_ID, agentId: AGENT_ID, projectionVersion: "v-test", limit: 50 });`

建议：增加一个存储层用例：给想一想线程手工写入 `thread_search_projection` / `thread_title_search_projection`，再调用 `search()`，断言只返回对照的 `owner` 对话。这样移掉该条件时用例会失败。

### 4. 低｜设置并发测试不能证明存储层新错误文字被走到

文件:行：`test/integration/think-settings.test.ts:324-334`；`apps/agent-service/src/production-think-settings.ts:111-113`；`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:113-115`

问题：应用层在调用存储层前已经会抛出同样的 `THINK_SETTINGS_CHANGED`。如果第二个请求在第一个写完后才读，测试会走应用层预检，而不是存储层新改的错误文字；因此把存储层改回旧文字，这个用例未必失败。

证据：
- `throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "THINK_SETTINGS_CHANGED");`
- `return this.fail("PORT_CONFLICT", "THINK_SETTINGS_CHANGED");`

建议：直接对 `ThinkInboxStorePort.changeSettings` 造两个同 revision 的并发调用，或让测试明确强制两个请求都先通过应用层预检，再断言存储层错误码/文字。此条部分属于推测，取决于测试调度。

### 5. 低｜“客户端不能传 `origin`”只有通用 schema 保证，没有针对 `thread.create` 的反向测试

文件:行：`packages/gateway-contracts/src/thread-contracts-v3.ts:130-137`；`packages/gateway-contracts/src/validation.ts:187-189`；`packages/application/src/services/product-thread-gateway-adapter.ts:742-750`

问题：结论是对的：`object()` 会拒绝未知字段，adapter 也只传固定字段，所以客户端无法让 `origin = 'think'`。但现有未知字段测试只覆盖 `thread.set_answer_locale`，没有专门覆盖 `thread.create` 传 `origin`。

证据：
- `if (!expectedKeySet.has(key)) fail(\`${path}.${key}\`, "unknown field");`
- adapter 的 `thread.create` 分支没有传 `origin`。

建议：在 `thread-contracts-v3.contract.test.ts` 增加一条 `thread.create` payload 带 `origin: "think"` 的拒绝用例；这是对作者说法 1 的直接自动检查。

### 6. 低｜迁移测试把逐表逐行相等改成 `objectContaining`，削弱了所有表的迁移无损断言

文件:行：`test/integration/sandbox-reservation-administration.test.ts:757-760`

问题：为了容纳新列，测试从整行相等改成只要求原字段存在，等于允许任意表以后多出意外列。这个改动不是必须的，可以只对新列做显式断言。

证据：
```ts
expect(migrated[table]).toEqual(rows.map((row) => expect.objectContaining(row)));
```

建议：保留原表的严格相等（只比较旧列），另加一条断言：旧 `threads` 行迁移后 `origin = 'owner'`；这样既验证新列默认值，也不会放宽其他表。

### 7. 低｜聊天导出的索引说明仍宣称所有进行中/已归档/回收站对话都会导出

文件:行：`packages/persistence-sqlite/src/data-export/chats.ts:453`；`docs/adr/0235-chat-history-export.md:54`

问题：代码已排除想一想对话并在 `omitted` 里计数，但导出索引仍写“进行中、已归档和回收站里的对话都在”；ADR 0235 的范围说明也没有提这个排除。主人从导出包里看不到想一想对话是预期，但文件里的说明与实际内容不一致。

证据：
- `共 ${threadLines.length} 个对话、${messageTotal} 条消息（进行中、已归档和回收站里的对话都在；正在删除和已删除的不在）。`

建议：更新索引文案，明确“想一想时开的对话不在导出中”，并在 ADR 0235 的范围段补一句；架构文档已更新，但这两个面向导出的说明没有同步。

**侧重检查**

- 错误路径：迁移是单条 `ALTER TABLE`；设置冲突的文字已核对；标题服务在第一次读取后即按 `origin` 返回。没有发现新增的删除或不可撤销操作。
- 不合规范/不可信输入：`thread.create` 的 v3 schema 严格拒绝未知字段，adapter 不接收 `origin`，作者说法 1 成立。`origin` 列本身没有 `CHECK` 约束，但目前只有内部创建路径能写，属防御性不足而非可利用问题。
- 安全/隐私：按编号直接读、fork、删除想一想对话没有拦截，这与作者明确声明的“不是安全边界”一致，我没有把它算成缺陷。v2 事件流是实际漏点，见意见 2。历史数据是最大缺口，见意见 1。
- 资源耗尽：新过滤都在 `LIMIT` 之前生效，不会让隐藏事件挤占分页；v3 事件游标和 web push 游标不会跳过隐藏项，可能反复扫描隐藏行，但想一想运行事件数量有限，未发现明显放大。没有新增用户可控的无限输入。
- 规则/文档一致性：`meta.json` 的 `alters` 声明正确，时间戳迁移会被自动加载；架构文档已同步；导出索引和 ADR 未同步，见意见 7。
- 删除路径：事件/运行过滤依赖 `threads` 行仍存在（`NOT EXISTS` 在父行删除后会变为真）。正常治理删除会删运行，且 `thread_gateway_events` 对线程是 `ON DELETE CASCADE`，当前不致漏出；这是设计上的 fail-open，未来新增删除路径时要复查。

**必答问题**

1. **模型请求开头是否改变？** 没有。本次 diff 没改系统提示、工具定义、历史消息或遮盖；`origin` 只进入 domain/persistence/gateway 内部对象，`threadSummary` 和 prompt/context 代码都没有读取它。对想一想对话的改动只是不再发起起标题的模型请求。仍只在末尾追加，没有新增每轮变化的值；`origin` 不是每轮变化的字段。结论：不影响已有对话的请求前缀。

2. **同一段文字会不会在不同请求里变成不同字节？** 没有新增这种行为。`origin` 是固定枚举，不是时间字段；没有引入无序集合参与序列化；`THINK_WORTH_DEFAULTS` 的属性顺序固定。聊天导出清单新增一个固定位置的 `omitted` 条目和计数，但那是导出文件，不是模型输入，且计数本来就随数据变化。

3. **自动检查是否覆盖？反向用例会不会失败？** 大部分覆盖：列表、v3 事件、待索引、首页运行、Apple、网页推送、记忆每日摘要、聊天导出、起标题都有新增用例；按测试数据推断，移除对应过滤会让这些用例失败。缺口是：搜索 `search()` 的条件没有反向用例（意见 3）；`thread.create` 带 `origin` 没有专门反向用例（意见 5）；设置并发用例不能确定走到存储层错误（意见 4）；迁移旧行默认值没有显式断言（意见 1、6）；v2 事件流没有测试（意见 2）。

4. **迁移只加一列带默认值、不影响旧行吗？** SQL 机制上成立：SQLite 的 `ADD COLUMN ... NOT NULL DEFAULT` 不会重写旧行。但逻辑上旧想一想对话会得到 `owner`，因此继续被所有新的 `origin = 'owner'` 过滤条件保留下来，这是本次改动最实质的缺口；见意见 1。
