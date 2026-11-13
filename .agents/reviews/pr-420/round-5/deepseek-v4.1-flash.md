## 结论（按严重度从高到低）

### 读代码证实的

**1. 中·安全（fail-open）：受限记忆正文读不出来时，同文提议仍会被导出**
- 文件:行：`packages/persistence-sqlite/src/data-export/snapshot.ts:72-82`、`snapshot.ts:272-280`、`export.ts:472-484`
- 问题：摘要集合只收录“能读出来的”受限记忆文字。payload 不可读时被静默跳过，随后 `restrictedProposal` 对未链接的提议返回 false，于是正文与受限记忆相同的提议照常进入明文/封存文件。实际不可读来源包括 `storage_kind !== 'sqlite_blob'`（文件外存 `ciphertext_file`）、`deletion_pending`/`deleted_verified`、payload 缺失。
- 证据：
  - `snapshot.ts:272-280`：`if (!row || row.storage_kind !== "sqlite_blob" || ... ) { payloads.set(ref, { unavailable: true }); continue; }`
  - `export.ts:473-475`：`const text = texts.get(str(row["content_ref"])); if (text !== undefined) restrictedDigests.add(proposalTextDigest(text));`
  - `export.ts:479-484`：未链接、摘要不在集合、正文也取不到时直接 `return ... && ...`，即 `false`，提议被导出。
- 建议：对受限记忆 payload 不可读的情况显式处理（例如把该 ref 标为“无法证明安全”并让导出失败，或至少把该受限记忆计入一个“未校验”清单并拒绝输出相关提议），不要静默放行。也可考虑直接查 `payloads.content_digest` 等不依赖解密的字段做兜底。

**2. 中·可用性（新增失败路径）：所有受限记忆及其历史 payload 被解密，任一条解密/UTF-8 解码失败会阻断整份导出**
- 文件:行：`export.ts:90-99`、`snapshot.ts:235`、`export.ts:61`
- 问题：本轮把 `restrictedMemoryTexts` 加入了 `refs`（`snapshot.ts:235`），于是 `texts` 循环会 `unprotect` + `decoder.decode` 这些本来不导出的正文。`decoder` 是 `{ fatal: true }`，`unprotect` 也可能因密钥缺失/密文损坏抛错；此前这些受限 payload 不会被触碰，导出可以成功。
- 证据：`export.ts:61` `const decoder = new TextDecoder("utf-8", { fatal: true });`；`export.ts:91-99` 对 `snapshot.payloads` 逐条 `decoder.decode(await ...unprotect(...))`。
- 建议：对受限记忆只做“能读则算摘要”，但把解密/解码失败与“不可读”区分：要么捕获并降级（配合第 1 条的 fail-closed 决定），要么只读取摘要所需的最小信息，避免无关的损坏受限数据阻断导出。

**3. 低·覆盖：新增的“历史版本”分支没有任何反向用例**
- 文件:行：`snapshot.ts:76-82`；测试 `test/integration/data-export-external-proposals.test.ts:310-355`
- 问题：代码新读 `memory_history_events.content_ref`，但反向用例的受限记忆没有 `versions`（`seedMemory` 默认空），fixture 只有在传 `versions` 时才生成旧版本 payload（`test/integration/data-export-fixture.ts:145-173`）。若历史分支被删掉/写错，现有测试仍会通过。
- 证据：反向用例只调用 `seedMemory(source, { id: "memory-restricted", text: restricted, classification: "restricted" })`，没有 `versions`。
- 建议：加一条用例：受限记忆 `versions` 含旧文本 X，当前文本 Y；分别放一条正文为 X 的提议和一条正文为 Y 的提议，断言两条都不导出、明文和封存文件都没有。

**4. 低·文档/代码措辞不一致：`omitted` 的 reason 对“改过文字再保存进受限记忆”的提议不准确**
- 文件:行：`export.ts:594-596`；`docs/adr/0246-...md:61`
- 问题：我把 `proposal-restricted-link` 这类“正文已与受限记忆不同、但因链接被整条排除”的提议也计入了同一个 omitted 项，reason 却写“正文就是那条受限记忆的文字”。ADR 决定 7 已区分“保存进受限记忆的提议”与“同文提议”，reason 没跟上。
- 证据：`reason: "正文就是那条受限记忆的文字，和受限记忆一样不导出..."`，而测试 `proposal-restricted-link` 的正文是“改过文字之前的原话”。
- 建议：改为“正文与受限记忆相同，或该提议已保存进受限记忆”等覆盖两类原因的说法。

**5. 低·非预期字节变化：受限提议现在会参与 `existingPlaceholderMax` 扫描**
- 文件:行：`export.ts:134-148`
- 问题：第 4 轮 `snapshot.externalProposals` 在 SQL 里已排除受限提议；本轮改为全量返回，`existingPlaceholderMax` 会扫描到受限提议的 `subject_ref/client/source_key`。如果受限提议里恰有 `[已扣留:999]`，导出中其他遮盖占位编号会整体后移。虽然确定、无文字泄漏，但与本轮意图无关，且会改变导出字节。
- 证据：`JSON.stringify([... snapshot.externalProposals, snapshot.externalProposalKeys, snapshot.externalProposalUnkeyed])` 后匹配 `/\[已扣留:(\d{1,6})\]/`。
- 建议：扫描时改用 `exportedProposals` 及仅属于它们的 keys/unkeyed，避免被不导出的行影响。

**6. 低·覆盖：`supersededBy` 被置空、固定编号/不带编号客户端不写出的泄漏路径没有专门用例**
- 文件:行：`export.ts:490-515`（`proposalIds` 只含导出提议、`supersededBy` 过滤、keys/unkeyed 按 id 取）
- 问题：代码看起来正确，但测试没有“导出提议被受限提议替换（supersededBy 指向被排除项）”和“受限提议带 keys/unkeyed”的用例，无法防止将来回归。
- 建议：补一条：受限提议 P 带 key/unkeyed 且被导出提议 Q 的 `supersededBy` 指向；断言 Q 的 `supersededBy` 为 null、P 的 key/unkeyed 不出现。

### 推测（未完全核实，需产品或需求确认）

**7. 低·推测：受限记忆的 `quote_ref`（原话）未参与比较**
- 文件:行：`snapshot.ts:76-82` 只取 `content_ref`；fixture 显示历史原话是独立 payload（`data-export-fixture.ts:162-171`）
- 说明：ADR 只承诺“当前文字和历史版本”，因此实现与 ADR 一致。但如果“受限记忆的文字”也包括其 `quote_ref`，则正文等于该原话的提议仍会被导出。若需求包含原话，应把 `quote_ref` 也纳入 `restrictedMemoryTexts`。

## 侧重检查

- 错误路径：确认了新增的 `unprotect`/`fatal` 解码失败会从“只影响该条不可读”升级为“整份导出失败”（见问题 2）；并确认 payload 不可读时摘要集合静默缺失导致 fail-open（问题 1）。
- 不合规范/不可信输入：新 SQL 全部使用 `@ownerId/@agentId` 绑定，无拼接注入；`proposalTextDigest` 对任意字符串安全；未发现新的可被提议正文触发的解析/正则灾难性回溯。
- 安全/隐私：确认被排除提议的正文不会经 `originals`、`supersededBy`、`keys`、`unkeyedClients`、封存文件带出（`proposalIds` 只含导出提议；keys/unkeyed 只按导出 id 取值）。但发现 fail-open（问题 1）和 `quote_ref` 缺口（问题 7，推测）。
- 资源耗尽：本轮会把所有受限记忆的当前及历史 payload 解密到 `texts`，无上限/配额；受限记忆异常多或历史很长时导出内存与耗时上升。属既有“全量加载”模式的放大，非新增独立缺陷。
- 不可撤销操作：本轮仍是只读导出，没有新增写库或删除路径；被排除的提议在导入新库后永久缺失，属 ADR 有意的数据丢弃。
- 规则/文档一致性：ADR 决定 7 与门槛已同步更新；发现 omitted reason 措辞与实现不一致（问题 4）。
- 依赖：`agent-service` 已声明依赖 `persistence-sqlite`（`apps/agent-service/package.json:20`），未发现包级循环依赖；但把 MCP 规范化放到 `persistence-sqlite` 再经包根桶导出，层次上偏耦合（不是错误）。
- 未运行任何测试（本次只允许读文件和 git 命令），因此“104 条通过”未实测。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本轮改动只涉及数据导出（`persistence-sqlite/src/data-export/*`）、MCP 提议文本规范化搬家和测试/文档，没有触碰提示词、工具定义、历史消息或出口遮盖；发给模型的内容仍只在末尾追加，每轮变化的值也不因本改动进入请求开头。依据 `prompt-prefix.md`，此 PR 不改变请求前缀。

2. **同一段文字会不会在不同请求里变成不同字节？** 不会由本改动引入。`proposalTextDigest` 是纯函数，`restrictedDigests` 只做集合成员判断（与插入顺序无关），提议输出顺序仍由 SQL 的 `ORDER BY received_at, id` 决定。导出清单的 `exportedAt` 本来就是既有的“时间字段”，不属于本轮新增的不确定性。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有新增反向用例（`data-export-external-proposals.test.ts:310-367`），门槛从 103 提到 104（`scripts/check-data-export.mjs:17`）。我按 1531e3d 的旧 SQL 复核：旧实现只排除“与受限记忆链接的提议同摘要”的提议，测试里的 `proposal-restricted-pending` / `proposal-restricted-copy` 不满足，会被导出，从而触发隐藏断言失败——反向用例是真的。缺口是历史版本分支、payload 不可读分支、`supersededBy`/keys 路径没有专门反向用例（见问题 3、5、6）。

4. **每个新值的产生端/使用端都能接受吗？**
   - `restricted_link`（`snapshot.ts:86-88`）只在本文件 `export.ts:478-480` 使用，SQLite 布尔表达式返回 0/1，`=== 1` 判定正确；`memory_id` 为 NULL 时为 NULL，不会误判。
   - `restrictedMemoryTexts`（`snapshot.ts:32,72-82`）唯一消费方是 `export.ts:472-484`，只用于求摘要；同时被加入 `refs` 以便加载 payload，未直接序列化。
   - `normalizeProposalText` / `proposalTextDigest` 新从 `persistence-sqlite` 导出（`data-export/index.ts:42`），`agent-service` 与测试使用；实现与旧文件逐字符相同，`mcp-write.test.ts:812` 的规范化断言仍成立。
   - 排除提议后 `supersededBy` 置空、keys/unkeyed 不写出；导入端 `verify.ts:125-126` 只要求“非空则必须是 superseded”，允许 superseded 的 `supersededBy` 为 null；`import.ts:718-720` 也会再次过滤为 null。两端可接受。
   - 没有新增持久化字段，因此没有新的“能通过校验却 INSERT 失败”的输入；排除只减少行，不会引入新的外键/唯一约束冲突。

5. **受限 payload 读进内存后会不会被别的代码写进导出/封存？** 没有直接遍历 `snapshot.payloads` 的导出逻辑；`export.ts:90-99` 只做解码，`buildEvidence` 只按具体 ref 取用，`originals` 只在 `exportedText` 命中导出行时写入。因此新增的受限 payload 不会被无差别写出。但要注意第 2 条的失败路径和 `originals` 之外的既有 decision/rules 泄漏（作者已声明是 PR 前行为，本轮不计）。

## 对作者五个核对点的回答

1. 提议之外的其他导出文件（决策/规则/合并记录）确实仍是既有行为；本轮没有新增从这些文件带出受限记忆正文的路径。但 `quote_ref` 缺口（推测）值得产品确认。
2. `supersededBy` 不会带出被排除提议编号（`proposalIds` 只含导出项）；固定编号/不带编号客户端也不写出被排除提议的；封存文件没有被排除提议的正文或摘要（反向用例覆盖明文+封存）。缺专门用例但代码成立。
3. 规范化搬家后行为一致（同一实现、同一正则、同一 NFC/spaces/trim 顺序），`agent-service` 依赖关系允许该 import，未发现循环依赖。
4. 受限 payload 不会被别处遍历后写出；证据见必答 5。
5. 没有发现新的“通过校验却 INSERT 失败”的输入；相反是少写了被排除的行。
