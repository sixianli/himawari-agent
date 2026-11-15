本轮范围：只审 `9b5b252..cf83b9e` 的 4 个代码/测试文件，其余是复核记录；沿证据回查了 `suggestionId` 全链路、手动新建长度上限和服务端校验。未实跑 Swift/Node 测试。

**上一轮两条意见核对**

- 上一轮意见 1（人物建议 ID 超 `machineString` 128 上限）：主体已修好。新 ID 固定为 `person-suggestion:` + 32 位十六进制，共 50 字符，符合 `machineString` 的 128 长度和字符集；使用端都只当作不透明字符串。但旧数据没有迁移，见下面意见 3。
- 上一轮意见 3（手动新建无长度上限）：新建路径已加上 500 上限，主体改好；但只覆盖新建，编辑路径仍未限制，且长度单位与服务端不一致，见下面意见 2。

### 1. 中 - 新增的“敏感重传”测试 mock 自相矛盾，在 Mac 上会失败

文件：`clients/apple/Tests/HimawariManageTests/MemoryDecisionTests.swift:16-27、80-85`；`clients/apple/Sources/HimawariCore/MemoryCreatePlan.swift:21-22`

问题：增量把上传 mock 的返回值改成了按分类生成，但分类查询 mock 仍硬编码 `contentRef:"ref-1"`。第一次上传是 `private`，现在返回 `ref-private`，与查询结果里的 `ref-1` 不相等。`MemoryCreatePlan.make` 对 `item.contentRef == contentRef` 有硬校验，不相等就回退到 `category:"other"`、`sensitive:true`、`topic:"other"`。测试却断言 `category == "health"`、`topic == "health"`，因此会失败。

证据（读代码证实）：
```swift
// MemoryDecisionTests.swift:18-21
var classification = "private"
...
return DeviceResponse(status: 200, body: Data(#"{"payloadRef":"ref-\#(classification)"}"#.utf8))
// MemoryDecisionTests.swift:25-27
if case .string("memory.classify.read")? = body["type"] {
    let item = #"{"contentRef":"ref-1","category":"health",...}"#
// MemoryCreatePlan.swift:21-22
guard let item, item.contentRef == contentRef, !item.failed else {
    return MemoryCreatePlan(category: "other", sensitive: true, topic: "other")
// MemoryDecisionTests.swift:80-81
XCTAssertEqual(payload["category"], .string("health"))
XCTAssertEqual(payload["topic"], .string("health"))
```
这是按代码路径推演必然失败；我未在 Mac 上实跑。作者说的“Linux swift test 通过”不覆盖这个测试：`Package.swift:21-24` 在 Linux 下把界面 targets 置空，`HimawariManageTests` 在 `#else` 分支（`Package.swift:40`）。

建议：让分类查询 mock 回显请求里的 `contentRefs[0]`，或让第一次上传返回 `ref-1`；然后在 Mac 上跑 `HimawariManageTests`。同时保留一个“contentRef 不匹配必须回退到 sensitive/other”的反向用例，Core 侧已经有类似用例，但 Manage 侧这条测试目前连正向路径都没通过。

### 2. 低 - 500 字上限按 Swift 字符簇计，不能保证服务端 2000 上限；编辑路径仍无上限

文件：`clients/apple/Sources/HimawariManage/Memory/MemoryAddSheet.swift:7、44、61-63`；`clients/apple/Sources/HimawariManage/Memory/MemoryEditSheet.swift:48`；`packages/gateway-contracts/src/validation.ts:102-116`；`apps/agent-service/src/production-memory-control.ts:155-163`

问题：Swift 的 `text.count` 和 `prefix` 按扩展字符簇计，服务端 `boundedString(2000)` 按 JavaScript 字符串 UTF-16 长度计，`singleLine` 又按 Unicode 码点截 2000。一个组合字符或 ZWJ emoji 序列可以占多个码点/多个 UTF-16 单元，所以 500 个 Swift 字符仍可能超过服务端 2000，原来的“读回被截断”问题在极端输入下仍存在。另外，`MemoryEditSheet` 仍然没有上限；之前已经存在的超长记忆被读成截断文本后，编辑保存仍会丢尾部。

证据（读代码证实单位不同）：
```swift
// MemoryAddSheet.swift:7,44,62
static let characterLimit = 500
.disabled(trimmed.isEmpty || trimmed.count > Self.characterLimit || saving)
if text.count > Self.characterLimit { text = String(text.prefix(Self.characterLimit)) }
```
```ts
// validation.ts:105-108
typeof input !== "string" ||
input.length === 0 ||
input.length > maximum ||
```
```ts
// production-memory-control.ts:155-163
const singleLine = (text: string) =>
  [...text]
    ...
    .slice(0, 2000);
```
触发需要极端字符组合，这一点是推测；单位不一致本身是读代码证实的。

建议：按服务端同一单位限制，例如用 `text.utf16.count` 并留余量；或在服务端对记忆正文做同一上限的强制校验/规范化。若要覆盖原意见里的“编辑保存丢尾部”，`MemoryEditSheet` 也应加同样的上限，或禁止保存被截断的原文。

### 3. 低 - 人物建议 ID 只改新写入，旧库里已经存在的超长 ID 不会修复

文件：`packages/persistence-sqlite/src/sqlite-memory-book-operations.ts:358-369、456-472、603-605`；`packages/persistence-sqlite/src/migrations/0057_memory_page.sql:62-74`

问题：新函数只在 INSERT 时生成新 ID；`listPersonSuggestions` 原样返回 `s.id`，`decidePersonSuggestion` 也按传入的旧 ID 查找。仓库里没有迁移去重写 `memory_person_suggestions.id`。由于表有 `UNIQUE (person_id, candidate_id)`，同一对人物再次出现时 `ON CONFLICT DO NOTHING` 不会生成新行，旧 ID 会一直保留。如果旧库里存在超过 128 字符的 pending 建议，`memory.overview.read` 的 `suggestionId` 或 `memory.person.respond` 的 `resultRef` 仍会撞上 `machineString` 校验。

证据（读代码证实旧行不会重写）：
```sql
-- migrations/0057_memory_page.sql:62-71
CREATE TABLE memory_person_suggestions (
  id TEXT PRIMARY KEY,
  ...
  UNIQUE (person_id, candidate_id),
```
```ts
// sqlite-memory-book-operations.ts:603-605
function personSuggestionId(personId: string, candidateId: string): string {
  const digest = createHash("sha256").update(`${personId}\n${candidateId}`).digest("hex");
  return `person-suggestion:${digest.slice(0, 32)}`;
}
```
旧格式在增量前是 `person-suggestion:${personId}:${candidate}`。生产库里是否已有超长旧行属于推测，需查部署数据；代码里确实没有迁移。

建议：补一个数据迁移，按新规则重写现有 `memory_person_suggestions.id`，或在读取时过滤/转换超长旧 ID；加一个测试，从包含旧格式超长行的数据库启动并验证 overview 与 respond 都可用。

**侧重检查**

- 错误路径：`classify` 失败、返回空项、`contentRef` 不匹配都会回退为 `sensitive/other`，Core 测试覆盖；敏感重传失败会直接抛出，不会继续 create；`memory.person.respond` 找不到建议会返回 `MEMORY_PERSON_NOT_FOUND`；外部拒绝按能力表走 tighten，测试确认 0 次 challenge。以上代码路径可接受，唯一发现是意见 1 的测试本身失败。
- 不可信输入：新建文本的单位问题见意见 2；控制字符在 overview 的 `singleLine` 里会被替换成空格，不会撞上 `boundedString` 的控制字符限制；分类结果的 `category/topic` 都在合约枚举内，create payload 可接受。
- 安全：敏感文本先以 `private` 上传、再以 `sensitive` 重传（`MemoryAwaitingActions.swift:91-97`）。服务端每次上传生成独立 payload，所以会留下 private 副本；这与 Web 现有的 `protectedRef` 行为一致，不是本轮新增的生产行为，我未把它列为新缺陷；若要求敏感内容绝不以 private 落盘，这是既有风险。
- 资源耗尽/不可撤销操作：`createHash` 每个建议只算一次，500 上限降低输入规模；增量没有新增删除、撤销或不可逆命令。
- 规则/文档一致性：本轮没有改提示词组装、工具定义或遮盖逻辑，与 `prompt-prefix.md` 的“只追加”规则不冲突；仓库文档没有约定 `person-suggestion` 的具体 ID 格式，因此没有发现文档与代码不一致。

**必答问题**

1. 不改变模型已经见过的请求开头。本轮改动不碰系统提示、工具定义、历史消息或遮盖；`suggestionId` 只存在数据库和网关合约里，模型提示里用的是 `personId`，没有变化。新增的 `memory.classify.read` 是独立的分类后台调用，不改对话请求；每轮会变的值没有进入系统提示或工具定义。就本增量而言，可以说“不涉及，仍只在末尾追加”。（分类器提示词本身不在增量内，未核实。）
2. 不会。新 ID 是 `personId + candidateId` 的 SHA-256 确定性截取，同一对人物每次得到同样字节；500 截断只取决于当前输入；没有引入依赖前后文的遮盖、时间字段或无序集合。测试 mock 的 `ref-<classification>` 只影响测试，不是生产序列化。
3. 有部分检查，但不够，而且新增测试会失败。意见 1 有集成测试检查 `^person-suggestion:[0-9a-f]{32}$` 和“不包含 personId”，旧格式会在这两条上失败，属于有效反向用例。意见 3 的 500 上限没有自动检查，且 `HimawariManageTests` 在 Linux 不构建；意见 1 对应的新增敏感重传测试因为 mock 的 `contentRef` 不匹配，按代码推演会失败，不能算有效通过。旧数据库迁移也没有测试。
4. `suggestionId` 链路两端都能接受：产生处是 `sqlite-memory-book-operations.ts:603-605`；读取映射到 `production-memory-control.ts:1285-1292`；overview 合约是 `contracts-v2.ts:2411` 的 `machineString`；手机端解码后在 `MemoryAwaitingActions.swift:61` 原样回传；命令合约是 `contracts-v2.ts:2745` 的 `machineString`；服务端按字符串查找 `sqlite-memory-book-operations.ts:456-472`；成功结果又把同一个 ID 作为 `resultRef` 返回（`production-memory-control.ts:1718`）。50 字符的 `person-suggestion:<32 hex>` 全部通过。`characterLimit` 只是 UI 值，没有序列化消费端。旧行是例外，见意见 3。没有新增配置键或清单项。

**未核实**

- Mac 上 `HimawariManageTests` 的实际运行结果；我只按代码推演。
- 生产库是否已有旧格式、超长的 `memory_person_suggestions.id`。
- 旧行在服务端输出校验时具体先在哪一步失败；合约里 `suggestionId` 和 `resultRef` 都是 `machineString`，但未核实所有出口都执行该校验。
