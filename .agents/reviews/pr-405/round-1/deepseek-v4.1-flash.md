# PR 405 复核意见

先说结论：改动确实只有文档和设计素材，没有运行时代码；表名 `paired_devices` 的改名核对无误，14 张截图与文档描述的数量、页面名也对得上。但存在一个规则层面的高严重度问题，以及一个“收紧”档的安全设计缺口；另外，文档承诺的 `check:client-parity` 目前并不存在。

## 读代码证实的问题（按严重度）

### 1. 高：直接改写了已接受 ADR 的决定，而不是新建取代 ADR

**文件:行**：`docs/adr/0229-native-apple-clients-and-device-api.md:95`、`:97`、`:102`

**问题**：本 PR 把已合并、已接受 ADR 的决定 3 从“聊天和语音原生、不常用页面嵌网页”改成“全部原生”，并把决定 4 里“换网页会话用确认密钥”改成“改这一档用确认密钥”。这是在原地改写一个已接受 ADR 的决定内容，而仓库规则要求决定变化时新建 ADR 取代旧 ADR。

**证据**：

- ADR 自己的 frontmatter 仍是 `superseded_by: ""`，本 PR 也没有新增任何 ADR 文件（`git diff --name-status` 只有 docs 和 assets）。
- ADR 正文保留了旧内容痕迹：“（2026-11-12 修订。原先写的是‘聊天和语音用原生界面做，不常用的页面嵌网页’……）”，说明这是对原决定的改写，而不是补充说明。
- `.agents/instructions/document-governance.md:18` 明确写：“决定改变时，就地取代先前那份 ADR……；绝不改写先前 ADR 的决定内容。”

**建议**：按 ADR Supersession 流程新建一份 ADR（编号接在现有最大编号之后），用 `amends`/`supersedes` 指向 0229，并撤销 0229 决定正文的原地改写；或者至少把这次变化完整落成新 ADR，旧 ADR 保持原决定不变。当前做法违反项目文档治理规则。

---

### 2. 高：“收紧”档按“消息类型”分档，无法区分暂停和恢复，设备密钥可能重新开启感知

**文件:行**：`docs/execution/specs/2026-11-11-apple-device-body-design.md:204-213`，重点 `:210`、`:213`

**问题**：设计写的是“网页用的每一种查询和命令（网关消息类型）登记进能力表，每种标一档”，`POST gateway` 也按“这种消息类型是哪一档”放行。但现有网关里同一个消息类型同时承担“关”和“开”两个方向，按消息类型只能选一个档：

- `memory.settings.set` 的载荷只有一个 `capturePaused: boolean`；`capturePaused: false` 就是恢复记忆采集。
- `proactive.settings.set` 的载荷包含 `enabled`、`quietHours`、`importantSenders`；同一个类型既用于关闭也用于重新开启，还顺带修改免打扰时段和重要发件人。

因此：

- 如果把它标成“收紧”，只拿设备密钥的人可以发送 `capturePaused: false` / `enabled: true`，在没有面容或解锁的情况下重新开启采集/主动提醒，直接违反“重新打开和恢复属于‘改’”。
- 如果把它标成“改”，那么关闭感知也必须刷面容，违反“关掉或暂停某一项感知只用设备密钥签名”。
- 同一类型还携带与“感知变少”无关的字段（如 `quietHours`、`importantSenders`），标成“收紧”后设备密钥可以改这些设置，而不是只让采集变少。

**证据**：

- `packages/gateway-contracts/src/contracts-v2.ts:1494-1497`：`memory.settings.set` 的载荷是 `payload: object({ capturePaused: booleanValue })`。
- `packages/persistence-sqlite/src/sqlite-memory-book-operations.ts:213-218`：`kind: input.capturePaused ? "memory_capture_paused" : "memory_capture_resumed"`，明确同一个命令能写入“暂停”或“恢复”。
- `apps/control-center/src/memory.ts:221`：`setPaused: (paused) => send("memory.settings.set", () => ({ capturePaused: paused }))`，UI 用同一条命令双向切换。
- `packages/gateway-contracts/src/contracts-v2.ts:500-506`：`proactive.settings.set` 同时携带 `enabled`、`quietHours`、`importantSenders`。
- 设计 `:733` 列出的反向用例只有“‘改’档只用设备密钥签被拒”等，没有“只剩设备密钥时把 `capturePaused` 从 true 改回 false 必须被拒”这一类用例。

**建议**：把能力表的粒度从“消息类型”改成“消息类型 + 操作/字段方向”，或者把暂停和恢复拆成两个不同的消息类型（例如 `perception.pause` 与 `perception.resume`），恢复、重新开启、扩大范围一律走“改”档并要求确认密钥。反向用例至少覆盖：

- 设备密钥签 `capturePaused: false` 被拒；
- 设备密钥签 `enabled: true` 被拒；
- 设备密钥签带 `quietHours`/`importantSenders` 的 `proactive.settings.set` 被拒或只允许纯收紧字段。

---

### 3. 中：`check:client-parity` 当前不存在，但 ADR 和设计已把它写成保证

**文件:行**：`docs/adr/0229-native-apple-clients-and-device-api.md:95`、`docs/execution/specs/2026-11-11-apple-device-body-design.md:215`、`:733`

**问题**：ADR 写“`check:client-parity` 保证……”，设计的“值”表也把 `npm run check:client-parity` 和 `test/integration/device-gateway.test.ts` 列为自动检查。但当前仓库没有这个 npm script、没有对应脚本、也没有对应测试文件。实施计划把脚本放到第 11 批，所以今天这条“保证”不成立。

**证据**：

- `package.json:27` 的完整 `check:steps` 列表里没有 `check:client-parity`。
- 全仓库找不到 `scripts/check-client-parity*`。
- 全仓库找不到 `test/integration/device-gateway.test.ts`。
- 作者列的已通过检查里也没有 `check:client-parity`，与 ADR 把它写成现有保证不一致。

**建议**：要么在本 PR 就补上脚本和反向用例，要么在 ADR/设计里明确写成“第 11 批新增，当前尚不存在”，不要用现在时写成已经保证。如果保留为未来检查，至少加一条设计验收项：脚本未实现前不得声称 parity 已经受到自动保护。

---

### 4. 中：`check:client-parity` 声称读取的 `control-center-inventory.ts` 不是完整的消息类型清单

**文件:行**：`docs/execution/specs/2026-11-11-apple-device-body-design.md:215`；`apps/control-center/src/app/control-center-inventory.ts:194-211`、`:378-395`、`:397-417`

**问题**：设计说检查读“网页的页面清单（`apps/control-center/src/app/control-center-inventory.ts`）”，并保证“网页新增一种消息类型……检查就失败”。但该文件是少数“surface”的合同清单，不是完整的网关消息类型枚举：

- `memory` 只列了 `memory.overview.read` 和 `memory.mutate`，没有 `memory.settings.set`、`memory.rules.read`、`memory.rule.respond` 等实际使用的类型。
- `settings` 的 `queries` 和 `mutations` 都是空数组。
- `sessions-devices` 的 `queries` 和 `mutations` 也都是空数组。
- `packages/gateway-contracts/src/contracts-v2.ts:22-58` 里有大量实际消息类型，例如 `memory.settings.set`、`proactive.settings.set`、`owner.preferences.set`、`search.authorization.set`、`push.kind.set` 等，这些都不在该清单的 `queries`/`mutations` 里。

因此，如果 `check:client-parity` 只读这个文件，网页在 `settings`/`sessions-devices` 等页面上新增消息类型并不会被发现；设计的“新增一种消息类型就失败”是过度承诺。

**建议**：让检查同时从 `GATEWAY_V2_MESSAGE_TYPES`、thread v3 合同等权威枚举读取消息类型，或者把 `control-center-inventory.ts` 变成由合同生成、覆盖全部操作且与页面映射的完整清单。反向用例应构造“在某个页面新增一个未登记的消息类型”，要求检查失败；只加一个页面而不加消息类型还不够。

---

### 5. 中：计划第 11 批要改“挑战值表”，详细设计的表清单里没有这张表

**文件:行**：`docs/execution/plans/2026-11-11-apple-device-body-plan.md:57`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:221-227`、`:249`、`:524`

**问题**：计划第 11 批写“改表（挑战值表，第 4 批先做了就不用）”，但详细设计的设备表清单只列了 `paired_devices`、`device_policies`、`device_upload_grants`、`device_pairing_codes`、`device_request_nonces`。其中 `device_request_nonces` 明确写着“只为挡重放，过期即删”，不是一次性挑战值表。设计里又确实有 `POST approvals/challenge` 和“一个挑战值只能用一次”的要求，但没有说明挑战值存在哪里、由哪张表/哪份迁移负责。第 4 批也已经写了“确认密钥、一次性凭据”，与第 11 批的“确认密钥验签和一次性挑战值”范围重叠。

**建议**：在详细设计表清单里补上挑战值表（字段、过期、一次性消费、并发保护），或者明确复用 `device_request_nonces` 并说明它如何同时满足重放和挑战值语义；同时把第 4 批和第 11 批的确认密钥/挑战值职责写清楚，避免重复改表或漏建表。

---

### 6. 中低：原生“感知到的”页没有被任何客户端批次明确承接

**文件:行**：`docs/execution/specs/2026-11-11-apple-device-body-design.md:190`；`docs/execution/plans/2026-11-11-apple-device-body-plan.md:49`、`:57`、`:61`

**问题**：设计说“记忆、规则、设置、审批、提醒记录、文件、用量、‘感知到的’、设备管理、数据导出，全部做成原生页面”。但：

- 第 3 批写的是“服务器：……‘感知到的’页和用量页”，`在哪做` 是“云端”，不是客户端；
- 第 11 批的原生页面清单列了记忆、规则、设置、审批、提醒记录、文件、用量、设备管理、数据导出，没有“感知到的”；
- 第 61 行列出有界面要照原型的批次是 2、4、6、8、9、10、11，也不包含第 3 批。

结果是“感知到的”在文档里被要求做成原生页，但计划里没有明确哪一批做这个原生页面。

**建议**：把“感知到的”原生页加入第 11 批，或在计划中明确第 3 批只做网页版本、原生版本另列一批；同时更新第 61 行的客户端界面批次列表。

---

### 7. 低：引用的代码行号不准

**文件:行**：`docs/execution/specs/2026-11-11-apple-device-body-design.md:217`

**问题**：文档写“对话接口的权限检查要求有一条活着的网页会话（`apps/agent-service/src/production-http-composition.ts:431`）”。实际 431 行只是 scope 判断的闭括号；真正检查活会话的是 434-435 行的 `activeSession(...)` 和 `if (!session) return { allowed: false, reasonCode: "SESSION_INACTIVE" };`。

**证据**：

- `apps/agent-service/src/production-http-composition.ts:434-435`：
  `const session = await activeSession(this.#sessions, input.authentication, this.#ownerId);`
  `if (!session) return { allowed: false, reasonCode: "SESSION_INACTIVE" };`

**建议**：把行号改为 `:434-435`，或直接引用 `activeSession` 函数。

---

### 8. 低：`204800 字节（200 KB）` 的单位换算是错的

**文件:行**：`docs/execution/specs/2026-11-11-apple-device-body-design.md:611`

**问题**：`device.prefetch.cache.bytes` 默认值写“204800 字节（200 KB）”。204800 字节是 200 KiB（1024 进制），不是 200 KB（1000 进制）。配置键又强调“每个键只放一个整数”，单位歧义会让实现和验收对不上。

**建议**：写成“204800 字节（200 KiB）”或“200000 字节（200 KB）”，并在配置说明里统一 KB/KiB 的换算定义。

## 推测 / 未核实的内容

- **`POST gateway` 的资源耗尽风险（推测）**：设计只给了 `device.request.body_bytes` 等请求级上限；`POST gateway` 可以调用现有网页的“读”操作，但设计没有逐消息类型的查询上限。网页现有处理器是否已经有足够的分页/行数限制，本次未逐条核实。标记为未核实，不建议据此直接判定缺陷。
- **内部会话算不算近期身份验证（需实现保证）**：设计说不算，且计划了反向测试。但现有 `packages/platform-node/src/built-in-identity.ts:247-266` 的 `authenticate` 会为可认证的 `product_sessions` 自动附加 `recentAuthenticationEvidence`。实现时必须确保内部会话不建 `built_in_session_credentials`，也不走 `builtInIdentity.authenticate`；否则“内部会话不算近期身份验证”会被绕过。设计已有反向测试要求，算有意识，但实现时要盯住。
- **外部原型链接**：`https://claude.ai/artifact/LXSrxAKtr41z2Yz6eJ1Dme` 无法离线核实。
- **作者的检查通过声明**：`validate_docs.py --strict`、`check:adr-numbers`、`check:docs-links` 等我没有执行权限，未运行。仅做了静态核对：新加的 `#ui-baseline` 锚点存在，`../../ui-ux-design-guide.md` 存在，14 张 PNG 和 `source/` 文件存在；未发现新加的相对链接断链。

## 侧重检查

- **错误路径 / 不可信输入**：`POST gateway` 对未登记消息类型拒绝、正文摘要签名、挑战值一次性使用，设计都有文字和计划用例；但尚未实现。发现“收紧”档按消息类型无法区分暂停/恢复，这是本次最重要的安全设计缺口。
- **安全**：设备密钥与确认密钥的分工写清楚了；内部会话“不算近期身份验证”有反向测试计划；但“收紧”档可能被用来重新开启感知或修改与感知无关的设置，违反“只让感知变少”的约束。
- **资源耗尽**：硬上限表覆盖请求正文、上传文件、解压后大小、批量记录、轨迹点、抢跑缓存；`POST gateway` 的“读”操作没有单独的上限说明，未核实现有网页处理器是否足够。
- **不可撤销操作**：删记忆、导出、移除设备等被指定为“改”档，方向正确；但能力表尚未落地，无法确认 `mute`、`clear`、`revoke` 这类操作不会被误分到“收紧”。
- **规则 / 文档一致性**：发现 ADR 治理违规、`check:client-parity` 不存在、行号引用错误；计划与详细设计在挑战值表和“感知到的”原生页上各有一处不一致。
- **设计素材**：14 张截图与文档“十四张截图”一致；文件名覆盖 today、timeline、chat list、chat、memory、memory detail、search、settings、voice、face id、pairing、lock screen、watch、mac；`source/` 下 5 个 HTML 加 `canvas.json` 存在。未逐行复核 HTML。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本 PR 只有文档和设计素材，没有代码；没有改系统提示、工具定义、历史消息、遮盖实现或提示词目录。设计中的 `POST gateway` 只是把原生页面的查询/命令转给现有网页处理器，不新增模型工具，不改变每轮请求组装。发给模型的内容是否仍然只在末尾追加、每轮变化值是否都在最后一条消息里，本次没有改变；相关 `prompt-prefix` 规则未被触碰。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   本 PR 不会，因为没有运行时改动。新的“客户端能力表”和生成的 Swift 消息类型清单目前都不是模型输入；未来实现时顺序应固定，但这不是本次改动带来的模型请求字节变化。遮盖规则没有改动；本次也没有新增带时间的字段或无序集合进入模型请求。`check:client-parity` 的未来生成物属于代码生成问题，不是模型缓存问题。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   对这次“只改文档”的提交，对应的检查主要是文档校验（链接、表格、格式等）；作者声称通过，但我没有执行权限，未亲自验证。新增的 `check:client-parity` 和 `device-gateway.test.ts` 目前都不存在，相关反向用例只是设计里的计划，现在不会失败，因为还没有测试。更关键的是，设计 `:733` 列出的反向用例没有覆盖“设备密钥把 `capturePaused` 改回 false”这一类，所以即使按现设计实现，也无法守住“收紧只能让感知变少”这一条。

4. **每个新值的产生处和使用处两端都能接受吗？**
   - **`paired_devices` 表名**：已确认当前没有同名表；现有 `devices` 确实是网页登录设备表（`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:102`），`product_sessions.device_id` 指向它（`:116`）。设计/计划把新设备表改名为 `paired_devices` 是对的，没有占用旧名。
   - **内部会话（`devices` + `product_sessions`）**：现有表结构可以容纳设备确认时插入的行（`devices` 的 `id`、`owner_id`、`label`、`status`、`first_seen_at`、`last_seen_at`；`product_sessions` 的 `authentication_ref`、`recent_authenticated_at` 等）。但实现必须避免给内部会话建 `built_in_session_credentials`，否则会与“不算近期身份验证”冲突。
   - **配置键 `device.prefetch.cache.entries` / `.bytes`**：这是未来第 3 批的配置键，当前代码没有解析或使用，旧键 `device.prefetch.cache` 也没有遗留消费者；两端暂时没有可核对的现有实现。注意 `.bytes` 的 204800/200 KB 单位需要统一。
   - **能力表档位**：产生处是未来代码常量，使用处是 `POST gateway`、Swift 清单和 `check:client-parity`；当前三者都不存在或未实现。现有消息类型里已经存在“同一类型双向”的问题（`memory.settings.set`、`proactive.settings.set`），两端的档位校验按现设计不能接受这种输入。
   - **挑战值表**：计划说第 11 批要改，详细设计的表清单里没有；产生处和使用处（`approvals/challenge`、`approvals/respond`、`POST gateway` 的“改”档）在文档中已经出现，但存储和迁移归属没有定义。
   - **`ui-baseline` 锚点和原型素材**：锚点存在，计划链接到 `../specs/...#ui-baseline` 可解析；14 张截图和 `source/` 文件存在，文件名与文档描述一致。

**总体建议**：先解决第 1 条 ADR 治理问题和第 2 条“收紧”档的方向性问题，再处理 `check:client-parity` 与计划/设计不一致。第 2 条如果按当前“按消息类型分档”落地，会留下一个只凭设备密钥就能重新开启采集或改动设置的安全缺口。
