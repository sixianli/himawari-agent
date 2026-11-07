## 侧重检查（先列查过的路径与结论）

- **错误路径（遮盖失败/退回）**：填充字符被耗尽、重演（rehearsal）还原失败时都退回整段旧规则检查；正式还原失败时 `redactedOrRefused` 把 `EgressRedactionError` 转成 `ModelEgressRefusedError`，请求不发出（fail-closed）。`packages/sensitive-capture/src/redaction.ts:215-236`、`packages/application/src/services/model-egress.ts:476-486`。结论：错误路径安全，但 catch 分支在现有实现下近乎不可达。
- **不可信输入**：输入或已记名值含全部 34 个候选填充字符时退回旧检查；输入里含单个候选时换一个（`redaction.ts:214-219`）。但固定文字是**按内容**匹配的，不只匹配 Himawari 实际写入的位置，见结论第 4 条。
- **安全（机器密钥）**：还原固定文字后仍执行 `assertMachineSecretFree`，所以固定文字里的机器密钥仍会被拒绝（`model-egress.ts:217-221`）。结论：没有放松机器密钥检查。
- **资源耗尽**：`trustedSpans` 对每条固定文字做一次全程 `indexOf`，整体约 T×N，不是无界循环；未做压力测试，见结论第 3 条（推测影响）。
- **不可撤销操作**：本次增量只改测试夹具；UI `clear` 路径未改。
- **规则/文档/代码一致**：I-78、`kv-cache-guide.md`、`prompt-prefix.md` 主体一致；发现一处文档只覆盖“以后改提示词”的方向，未覆盖本次上线的一次性变化，见结论第 2 条。
- **未核实**：不能运行测试；作者所说“Hermes 上修复前失败、修复后通过”和“CI policy 失败”的具体 job 名称未独立核实。

## 结论（按严重度）

### 1. 低（维护性）：夹具仍硬编码复制打包清单，下一次加包会重演同样的 ENOENT
- 文件:行：`test/tooling/artifact.test.mjs:571-588`，`scripts/package-node-runtime.mjs:13-30`
- 问题：作者本轮只把 `packages/sensitive-capture` 补进夹具。逐项比对后，夹具 16 项与 `internalRoots` 16 项**集合相等**（顺序不同，但夹具只用来建文件，顺序无影响）。所以作者“两份清单现在一致”的说法成立。但这个列表是第二份手工副本，正是上一轮失败的根因：`9ac0769e` 只在 `internalRoots` 加了 `packages/sensitive-capture`，夹具没跟，才报 ENOENT。
- 证据：`package-node-runtime.mjs:28` 有 `"packages/sensitive-capture"`；夹具 `artifact.test.mjs:587` 现在也有。`git diff 9ac0769e^ 9ac0769e -- scripts/package-node-runtime.mjs` 只加了这一行，未改夹具。
- 建议：从 `scripts/package-node-runtime.mjs` 导出 `internalRoots`（或一个 `runtimeInternalRoots()`），夹具直接用它构造 `roots`，彻底消除漂移；若不想导出，至少在夹具测试里断言 `new Set(roots)` 等于导出的清单，让失败信息变成“清单不一致”而不是难懂的 ENOENT。
- 补充核对“还有没有别处需要跟着加”：没有。`copyInternalPackage` 对 `packages/sensitive-capture` 无特殊处理，夹具循环已为每个 root 建了 `package.json`、`src/migrations` 和 `compiled/<root>/src/main.js`（`artifact.test.mjs:593-610`），足够打包。

### 2. 低（文档/缓存）：本次上线会一次性改变部分已发请求开头，规则只写了“以后改提示词”的情形
- 文件:行：`.claude/rules/prompt-prefix.md:53`，`packages/sensitive-capture/src/redaction.ts:210-237`，`packages/application/src/services/model-egress.ts:192-222`
- 问题：出口遮盖每次发送都会重算历史（`maskTree` 遍历全部 messages/system），本次把目录固定文字改为不遮。对已经存在的对话，若冻结的系统提示/历史里含过去被误遮的目录文字（I-78 明确记的 `1000`），部署后该对话的请求开头会变一次，之后才恢复只追加。I-78 说明 Andy 已同意，这不算未授权改动，但规则第 53 行只提醒“以后改了提示词文字……会变一次”，没有提醒“这次上线本身会让老对话变一次”。
- 证据：`docs/incidents-and-gates.md:116` 写“发给模型的整理记忆指令被改成 confidence 是 0 到 [验证码#…]，从出口遮盖上线起……一直是坏的”；`redaction.ts:233` 每次都用当前 `trusted` 重新遮。
- 建议：在规则或 I-78 里补一句：本修复上线时，受影响的既有对话会各重算一次；上线后同构建内字节稳定。

### 3. 低（性能，影响为推测）：`trustedSpans` 每个字符串都扫一遍全文
- 文件:行：`packages/sensitive-capture/src/redaction.ts:180-193`，`packages/prompt-catalog/src/trusted.ts:10-14`
- 问题：目录里 100+ 条目会产生上百条固定文字，每条都对整段输入做 `indexOf`。对长工具结果/网页正文，成本约为“固定文字条数 × 输入长度”，且每条消息可能触发一次（大消息还可能重演一遍旧规则）。
- 证据：`for (const value of trusted) { for (let position = input.indexOf(value); ...; position = input.indexOf(value, position + 1)) ... }`（`redaction.ts:186-193`）。
- 建议：只在已知的提示词位置检查固定文字（若有位置信息），或对固定文字建一次多模式匹配/前缀树；至少给输入长度设上限或在超长时直接退回旧检查。
- 说明：这是读代码确认的算法行为；“会不会真的拖慢到影响可用性”未实测，属推测。

### 4. 低（范围/文档一致性）：固定文字“按内容”信任，用户粘贴的同样文字也被豁免
- 文件:行：`packages/sensitive-capture/src/redaction.ts:180-204`，`.claude/rules/prompt-prefix.md:53`
- 问题：`trustedSpans` 在整个输入里查找目录文字，不区分来源。规则写的是“Himawari 自己写的固定文字”，但实际是“任何位置出现这段文字”。用户把某段提示词原文粘进对话、或工具结果包含这段文字时，该段同样不检查。对已发历史还可能造成一次性遮法变化。
- 证据：`for (const value of trusted) for (let position = input.indexOf(value); ...)`（无来源/位置限制）。
- 建议：若可拿到消息角色/层信息，只在期望的提示词层启用；否则在规则里把“按内容匹配”这一实际语义写清楚，避免读者以为有来源校验。

### 5. 低（重复常量）：24 字符阈值定义了两份，没有交叉校验
- 文件:行：`packages/prompt-catalog/src/entry.ts:59,68`，`packages/sensitive-capture/src/redaction.ts:172,210-211`
- 问题：`TRUSTED_TEXT_MINIMUM_LENGTH` 与 `TRUSTED_TEXT_MINIMUM_CHARACTERS` 都是 24，产生清单时过滤一次、使用时又过滤一次。若有人只改一份，测试不会报错（例如把目录侧调大，列表仍全部 ≥24，现有断言照样通过）。
- 证据：`entry.ts:68` 用 `TRUSTED_TEXT_MINIMUM_LENGTH`；`redaction.ts:211` 用 `TRUSTED_TEXT_MINIMUM_CHARACTERS`。
- 建议：让一处成为唯一真相（导出并引用），或加一条断言两者的值相等。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
- 本轮增量（只在 `test/tooling/artifact.test.mjs:587` 加一行夹具）：不会，纯测试数据。
- 整个 PR：**会变一次**，不是新增每轮变化的值。原因是出口遮盖每次发送都按当前规则重算全部历史/系统提示（`model-egress.ts:192-222`），而本次把目录固定文字从“检查”改成“不检查”；I-78 已承认 `confidence 是 0 到 1000` 过去被遮，部署后受影响对话的开头会变一次。除此之外，没有把时间、路径等每轮变化的值塞进系统提示或历史，每轮变化的值仍在最后一条消息里（测试 `trusted-prompt-egress.unit.test.ts:109-124` 验证目录条目原样发送）。因此严格答案是：**对受影响的既有对话不是“只在末尾追加”，会有一次性重算；之后同构建内稳定。** 规则第 53 行只写了“以后改提示词”的方向，建议补上本次上线的情形（结论第 2 条）。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
- 同一构建、同一前文下：不会。`TRUSTED_PROMPT_TEXTS` 由 `Set` 去重后按“长度降序 + 字典序”排序并冻结（`entry.ts:61-75`、`trusted.ts:10-14`），findings 顺序由固定枚举产生；填充字符的选择虽依赖输入和已记名值，但最终会被 `restoredText` 全部还原、不出现在输出里（`redaction.ts:239-255`）。已有“同内容两次发送字节相同”的用例（`trusted-prompt-egress.unit.test.ts:186-191`）。
- 跨构建/改提示词：会，清单随目录文字变化；这已在规则第 53 行写明。依赖前文“点名值”的遮盖差异是既有且被规则允许的例外（`prompt-prefix.md:54`）。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**
- 有。`package.json` 的 `check:prompt-catalog` 已纳入 `trusted-prompt-egress.unit.test.ts`、`trusted-text.unit.test.ts`、`sensitive-interceptions.unit.test.ts`（本轮 diff 已核对）。
- 反向用例是双向的：把清单置空时 `1000` 必须被遮（`trusted-prompt-egress.unit.test.ts:99-107`）；不带清单的底层函数保持旧行为（`trusted-text.unit.test.ts:10,66,115,123-126`）；UI 反向断言聊天记录仍显示“你的话”（`sensitive-interceptions.unit.test.ts:96-104`）。若实现把“信任”写死，这些用例会失败。
- 本轮夹具修复没有独立反向用例：修复前该测试本身因 ENOENT 失败，修复后通过（作者在 Hermes 的验证我未复现）。没有断言“夹具清单 == 生产清单”，所以未来再次漂移仍会以同样的 ENOENT 形式失败，而不是清晰的断言失败。建议见结论第 1 条。

**4. 改动产生/修改的每个值，使用方都能接受吗？**
- 本轮新增值 `"packages/sensitive-capture"`：产生处 `scripts/package-node-runtime.mjs:28`，使用处 `test/tooling/artifact.test.mjs:587`。两端都只需路径存在；夹具已为它准备 `package.json` 与 `compiled/.../src/main.js`，可接受。
- `TRUSTED_PROMPT_TEXTS`：`string[]`，被 `ModelEgress` 作为 `trusted` 默认值（`model-egress.ts:198`），再被 `redactForEgress` 过滤 `>=24`（`redaction.ts:210-211`），类型和长度都接受。
- `EgressRedactionError`：`redaction.ts:513` 产生，`model-egress.ts:483` 用 `instanceof` 消费；两处都从 `@himawari-agent/sensitive-capture` 根导出，链路完整。
- UI 使用的 `source`/`part`/`purpose`：数据库侧 `0078_sensitive_interceptions.sql:6-14` 的 CHECK 枚举与 `ports/sensitive-interceptions.ts:3-25` 一致，且 `source`/`part` 为 `NOT NULL`；本次只读不写，不存在新增后端标识或非法值。
- 两个 24 字符常量：两端目前都接受，但存在漂移风险，见结论第 5 条。

**作者说法核对**：`e8f1a11b` 只加第 3 轮复核记录、`687a8f01` 只加夹具一行，均经 `git log`/`git diff --stat` 证实；`9ac0769e` 起打包清单含 `packages/sensitive-capture` 也经 `git diff` 证实；“夹具现在一致”成立（集合相等）；“这个用例还有别处要加”核对结果为不需要。
