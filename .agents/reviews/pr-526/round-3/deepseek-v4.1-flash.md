本轮核对范围：`948f09a..f0b33fb61` 中与 PR 526 直接相关的 `3a8f52fd2`（源码 + 测试）和 `f0b33fb61`（复核账本）；同一范围里还合入了 origin/main 的其他改动（owner-intent、proposals、apple、review-speed 等），未逐行重审，只在与证据相关时跟读。`.agents/reviews` 处于稀疏检出且 `git show` 返回 `REVIEW_GIT_REFUSED records-path`，所以第 2 轮原始答案未能读到。上一轮第 1 条已核对：`readText` 返回 `undefined` 时现在在 `perception-service.ts:677` 抛错并进入失败分支，`perception-search.test.ts:226-258` 同时覆盖 `throw` 和 `undefined`，**确已改好**。以下是本轮增量里另外发现的问题。

### 1. 中：自动重建每个进程只成功跑一次，失败记录在进程内不会重试，新语义下会长期搜不到
文件: packages/platform-node/src/perception-service.ts:632、643-656、658-698

问题：增量把“读不到文本（`undefined`）”也归入逐条失败，但自动重建只在第一次搜索时执行，且逐条失败被吞掉、整个重建仍以成功返回，导致该记录在本进程内永久保持 stale，直到重启或外部显式调用 `rebuildSearchIndex`（生产代码里没有这种调用）。

证据（读代码证实）：
```ts
#ensureSearchIndex(scope) {
  const cached = this.#searchIndexReady.get(key);
  if (cached) return cached;            // 645-646：解析后永久缓存
  const pending = this.rebuildSearchIndex(scope).then(...)
  this.#searchIndexReady.set(key, pending); // 654
}
...
if (stale.length === 0) return rebuilt;      // 671：失败记录已进 failed，循环照常“成功”结束
...
if (text === undefined) throw new Error("PERCEPTION_INDEX_TEXT_MISSING"); // 677
...
} catch {
  failed.push(record.id);                    // 693-694：只跳过，不算整体失败
}
```
`search()` 只在 `632` 等待一次 `#ensureSearchIndex`；`rebuildSearchIndex` 的生产调用点只有 `647`，其余都在测试里。若密钥暂时不可用或 payload 读失败恢复后，下一次搜索不会再尝试。

建议：`rebuildSearchIndex` 返回失败数或失败 id，`#ensureSearchIndex` 在有失败时不缓存“已完成”，或在后续搜索按退避重试失败集合；也可在失败时保留旧词表但把记录标记为仍需重试的独立状态。

### 2. 低：失败时既不“写空词表并记当前版本”，也不再索引 evidence 名称，与作者说法和原兜底行为不一致
文件: packages/platform-node/src/perception-service.ts:673-695、679；apps/agent-service/src/production-http-composition.ts:1408-1414

问题：作者说“重建时分词或读文本失败的记录写空词表并记当前版本”，代码实际只在成功时调用 `replaceSearchTerms`，失败只 `failed.push`，版本保持旧值。并且抛错发生在计算 `indexText` 之前，因此连地址、歌名等 evidence 名称也没有索引；改动前 `readText` 返回 `undefined` 时会用 evidence 文本建索引，现在这条兜底被一并去掉了。对 `contentRef !== null` 但文本暂时读不到的记录，搜索直接失去全部命中能力。

证据（读代码证实）：
```ts
let text: string | undefined;
if (record.contentRef !== null) {
  text = await index.readText(record.contentRef);
  if (text === undefined) throw new Error("PERCEPTION_INDEX_TEXT_MISSING"); // 677
}
const indexText = [text ?? "", perceptionSearchEvidenceText(record.type, record.evidence)] // 679
  .filter(...).join(" ");
...
await this.#options.store.replaceSearchTerms({ ... }); // 686-691：只有成功才写
...
} catch {
  failed.push(record.id);                    // 693-694：不写版本、不写词表
}
```
`readPerceptionText` 在 payload 不存在时确实返回 `undefined`（`production-http-composition.ts:1408-1413`），所以这条路径真实存在。

建议：若希望“读文本失败仍可按地点/标题搜到”，在失败分支用 `perceptionSearchEvidenceText(...)` 写入 evidence 词表但保持旧版本（继续 stale，后续重试）；若确实决定什么都不写，就同步改正 PR 说明，避免文档与代码相反。

### 3. 低：新测试夹具把索引版本写死为 `...:2000`，没有验证 `indexTermLimit` 参与版本联动
文件: test/fixtures/device-api-harness.ts:317-319；对比 packages/platform-node/src/perception-service.ts:685、apps/agent-service/src/production-http-composition.ts:1435

问题：生产版本串包含 `indexTermLimit`，但测试夹具无论 `termLimit` 是多少都写 `"perception-search-test:rules:2000"`。新加的“上限为 6”用例又手工把版本改成 `"old"` 再重建，所以如果生产版本串漏掉上限，或上限变化不触发 stale，测试仍然全绿。“改上限后自动重建”这一关键契约没有自动检查。

证据（读代码证实）：
```ts
version: "perception-search-test:rules:2000",   // 317
rebuildBatch: 2,
termLimit: options.indexTermLimit ?? 2000,      // 319
```
```ts
version: `${searchTokenizer.projectionVersion}:${PERCEPTION_SEARCH_INDEX_RULES}:${perceptionSearchSettings.indexTermLimit}`, // production:1435
```
测试本身只在 `perception-search.test.ts:216-222` 手工把版本替换成 `"old"` 后调用重建。

建议：夹具按 `termLimit` 生成版本串，并加一条反向用例：旧版本含 `2000`，新配置为 `6` 时首次搜索应把记录重建为新版本、词数变为 6；把版本串里的 `${indexTermLimit}` 删掉时该用例必须失败。

**侧重检查**

- 错误路径：`document` 抛错在写入路径被 `.catch(() => undefined)` 吞掉，记录无 `searchVersion`，留待重建；重建中的 `readText` 抛错/返回 `undefined` 都被 `catch` 收进 `failed`，且 `excludeRecordIds` 会把它排除，因此不会死循环（`perception-service.ts:531-537`、`664-695`）。已读代码证实。
- 不可信输入：evidence 只有在 `PERCEPTION_RECORD_TYPES` 里声明为字符串且标了 `search` 的字段才进索引，且 `validatePerceptionFields` 会拒绝未知键、校验字符串长度与数字范围（`packages/application/src/ports/perception.ts:234-247`、`305-342`；落点 `perception-service.ts:429-430`）。查询路径本轮未改。
- 安全：索引只写 HMAC 摘要词（`browser-thread-search.ts:106-118`），不落明文；但重建会先解密 `sensitive/private` 记录再建词表，搜索结果也在 `production-search.ts:329-333` 的分类过滤之前读取并解密文本。作者“解密在分类过滤前只发生在服务器内存”与代码一致；仅有一个生产调用方，未发现本轮引入的新泄露路径。已读代码证实。
- 资源耗尽：首次搜索会不限总量地遍历所有 stale 记录，批量只限制每次查询条数；失败集合 `failed` 会在每批查询里整体 JSON 序列化进 `json_each`，极大范围失败时是 O(n²) 级别的重复序列化。这是既有结构，本轮把“文本缺失”也加入失败会放大它，但不是增量新增代码行，未单列为意见。
- 不可撤销操作：`replaceSearchTerms` 在事务内先删后写，语句失败会回滚；截断到更少词是不可逆的索引收缩，但按设计如此。迁移只新增表，`version` 有 `CHECK (length(version) BETWEEN 1 AND 128)`，生产版本串最长约 72 字符，能通过（`20261114175847_perception_search_index_state.sql:1-7`）。已读代码证实。
- 规则/说明一致性：`.agents/instructions/prompt-prefix.md` 本轮未改；作者关于“失败写空词表并记当前版本”的说法与代码不一致，见意见 2。

**必答问题**

1. **会不会改变模型已见过的请求开头：不涉及。** 本轮增量只改感知搜索索引的构建、上限和测试夹具，没有改系统提示、工具定义、历史消息或遮盖；感知内容仍只作为 `perception_read` 的工具结果在末尾追加（`prompt-prefix.md:27-30`、`36`）。没有新增“每轮会变”的值进入请求前缀，发给模型的内容仍只在末尾追加。
2. **同一段文字会不会变成不同字节：不会。** 词表由带密钥的 HMAC 摘要构成，输入相同、owner/agent/projection 版本相同则字节相同；`canonicalTokens` 先去重且保持固定顺序，版本串只含 key 版本、规则和数字上限，不含时间或数据库返回顺序（`browser-thread-search.ts:22-46`、`production-http-composition.ts:1435`）。词数上限截断也按固定数组顺序，结果确定。
3. **有没有自动检查、反向用例是否真会失败：有，但有一处缺口。** `perception-search.test.ts:192-206` 覆盖首次搜索自动重建；`208-224` 覆盖写入和重建的词数上限；`226-258` 覆盖 `throw`/`undefined` 两种失败并验证记录保持 stale、修好后能重建。若去掉 `undefined` 抛错，第二次 `rebuildSearchIndex()` 会返回 0 且 `indexRows(bad)` 为 0，用例会失败；若去掉 `.slice(0, termLimit)`，中文长句会写入多于 6 个词，用例也会失败。缺口是意见 3 的版本联动没有覆盖。测试未实际运行（工具限制），仅为静态核对。
4. **增量产生/修改的每个值，使用端是否都能接受：能。** `searchIndex.termLimit` 只在 `production-http-composition.ts:1437` 和 `device-api-harness.ts:319` 产生，配置校验为 `[1, 100000]`（`strict-configuration.ts:1546`），使用端只有 `perception-service.ts:536` 和 `685` 的 `slice`；`document` 改为返回完整数组后，两个使用端都先截断，没有第三处调用；`readText` 的 `undefined` 语义只在 `676-677` 消费并转成失败；`searchVersion` 最终写入 `perception_search_index_state.version`，满足迁移的 1..128 长度约束（`sqlite-perception-operations.ts:393-396`、迁移第 3 行）。没有发现使用端校验会拒绝的值。

**读代码证实的 / 推测**

- 读代码证实：上一轮第 1 条已改好；增量新增的 `termLimit` 两端都有且校验匹配；版本串长度能通过数据库 CHECK；evidence 字段在索引前经过白名单和长度校验；失败记录不会导致重建死循环。
- 推测：失败记录进程内无法自动恢复的实际影响取决于密钥/payload 故障的真实频率和进程重启周期；`failed` 集合在系统性故障下的 O(n²) 开销只是按代码结构推断，未做压力验证。
