## 本轮结论

本轮增量 `496fe71..b1bc32a` 只改了 5 个非记录文件：`clients/apple/README.md`、三份 `Localizable.strings`、`test/tooling/apple-entitlement-variants.test.ts`；行为代码（`queuesOffline`、`sharesStorageWithApp`、`notSent`）来自上一轮已包含的 `cf734c0`，本次按其使用端跟到了 `Handover.swift`、`SharedVault.swift`、`ExtensionSupport.swift`、`HandoverSheet.swift`、`SafariBridge.swift`、`project.pbxproj`、entitlements、`Info.plist`、`EntryViews.swift`、`AppModel.swift`。没有发现新的高严重度运行时错误，但增量里还有 1 处文档与代码相反、1 处测试覆盖回退、1 处残余 UX 风险。

### 1、中、README 把 Safari“已用过”记录的写入方写反了
文件: `clients/apple/README.md:41`
问题: 新增句子说“App 里‘开或关’的开关和 Safari 的‘已用过’记录也只写进 App 自己的存储，扩展看不到”。前半句对，后半句方向反了：`safariUsedAt` 只在扩展真正交付时由 `HandoverDesk.hand` 写入扩展自己的 store；免费签名没有 App Group 时，这个 store 是扩展自己的 `Application Support`，不是 App 的。App 读自己的 store，所以引导页不前进——结果对，原因写反。
证据:
- `clients/apple/Sources/HimawariCore/Handover.swift:542-544`：`if handover.entry == .safari, settings.safariUsedAt == nil { settings.safariUsedAt = now(); try? settings.save(to: store) }`
- `clients/apple/Sources/HimawariShare/ExtensionSupport.swift:101,104`：扩展用 `vault.handoverStore()` 的 store 建 desk。
- `clients/apple/Sources/HimawariCore/SharedVault.swift:58-63`：无可用 App Group 时回退到 `FileLocalStore.applicationSupport(...)`。
- `clients/apple/Sources/HimawariShare/EntryViews.swift:52`：App 侧用 `.main` 的 store 读状态。
建议: 改为“App 里的开关写进 App 自己的存储，扩展看不到；Safari 的‘已用过’记录由扩展写进扩展自己的存储，App 看不到。因此扩展按默认开着，App 关掉分享/Safari 不会让扩展停下，App 的 Safari 引导页也不会因为扩展用过而前进。”

### 2、低、权限变体测试删掉数量断言后，漏掉整个目标或配置也能通过
文件: `test/tooling/apple-entitlement-variants.test.ts:16-21,36-41`
问题: 上一轮意见 3 说的是“逐配置、逐目标校验”。这次改成逐行检查是进步，但把 `paths.length` 的精确断言换成了 `lines.length > 0`，把 `defaults.length` 换成了 `defaults.length > 0`。如果某个目标的两条 `CODE_SIGN_ENTITLEMENTS` 被删掉，或新增目标没配 entitlements，`lines` 仍非空，测试仍通过；如果某个工程级配置少了默认值，`defaults` 仍非空，测试也通过。前者会让该目标在免费签名下不带钥匙串分组，运行时读不到配对凭据，却不会报错。
证据:
```ts
expect(lines.length).toBeGreaterThan(0);
for (const line of lines) { expect(line).toContain("$(HIMAWARI_ENTITLEMENTS_SUFFIX)"); }
...
expect(defaults.length).toBeGreaterThan(0);
expect(new Set(defaults)).toEqual(new Set(['""']));
```
建议: 不要写死 `3`，而是从 `PBXNativeTarget` 和 `XCConfigurationList` 推导“所有签名目标 × Debug/Release”，逐个要求存在带后缀的 `CODE_SIGN_ENTITLEMENTS` 并检查两种文件都存在；或至少断言模板集合和工程级配置集合完整，而不是只判断非空。

### 3、低、未共享存储的失败文案仍只叫用户重分享，重复投递提醒只在 README
文件: `clients/apple/Sources/HimawariShare/Resources/zh-Hans.lproj/Localizable.strings:26`（en/ja 同处）；`clients/apple/README.md:41`；`clients/apple/Sources/HimawariCore/Handover.swift:549`
问题: `.queued` 包含“服务器可能已处理但没收到回复”的情况。新文案已从“没传上”改成“没能确认传上”，但紧接着仍是“稍后再分享一次”；“可能已经传上、可能收到两份”的提醒只写在 README，终端用户看不到。用户照 UI 重分享会再次上传，可能重复交付或留下孤立附件。
证据:
- 三份文案：`"outcome.notSent" = "没能确认传上，稍后再分享一次";`
- `Handover.swift:549`：`guard queuesOffline else { return .failed(.notSent) }`
- `README.md:41`：“（可能已经传上，只是没收到回复），要重新分享一次，同一内容可能因此收到两份”
建议: 在 UI 文案或结果区加一句“可能已收到，重复可忽略”，或把重新分享做成二次确认。是否真的重复取决于服务端是否已处理，属推测。

## 上一轮意见核对

- 意见 1（免费签名开关不通扩展，README/PR 与代码相反）：文档已明确写“App 的开关不通扩展”，代码确实是 App/扩展各用各的本地 store，主体已改好；但同一句把 Safari `safariUsedAt` 的写入位置说反了，见意见 1。
- 意见 2（`notSent` 把结果未知说成没传上）：UI 文案已改为“没能确认传上”，README 也加了“可能已经传上/可能两份”，主体已改好；残余的用户可见重复提醒问题见意见 3。
- 意见 3（权限变体测试可能跑不起来、没有逐配置逐目标校验）：`__dirname` 已换成 `import.meta.url`，在 `type: module` 的 tooling 项目里能正常运行；逐行检查已补。但删除数量断言导致漏目标/漏配置不报错，只算部分改好，见意见 2。

## 侧重检查

- 错误路径：`.queued → .failed(.notSent)` 只在 `queuesOffline == false` 时发生，且不写队列；`queue.add` 失败仍返回 `.rejected`，未受影响。未发现新的错误吞掉路径。
- 不可信输入：增量没有新增外部输入解析；`HandoverProblem.notSent` 只在本地通过 `rawValue` 映射到本地化 key，不经服务端解析。
- 安全/权限：三份 `.keychain-only.entitlements` 只去掉 App Group，保留与全量文件一致的 `keychain-access-groups`；`Info.plist` 的 keychain group 带 `$(AppIdentifierPrefix)`，与 entitlements 一致；未提交团队号，未改配对凭据。未核实：免费 Apple ID 是否允许 `keychain-access-groups` 能力（需要真机/账号验证，代码层面只能保证权限文件正确）。
- 资源耗尽/不可撤销：免费签名禁用排队会减少本地队列增长；但重分享可能重复上传、产生服务端孤立附件，见意见 3。
- 规则/文档一致性：README 与代码有一处方向写反（意见 1）；其余“默认付费构建不变、免费只用钥匙串、不共用存储”与代码一致。
- Mac 编译：未核实（作者也承认未编译）。静态检查未发现明显破坏 Mac 编译的点：新增 `HandoverDesk` 参数有默认值，`HandoverProblem` 没有其他穷尽 switch，`ExtensionSupport` 本身受 `canImport(UIKit)` 保护。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本增量只改 Apple 客户端 README、UI 文案和 tooling 测试；对比基准里也没有模型提示、工具定义、历史消息或遮盖相关文件。发给模型的请求路径没有变化，因此“只在末尾追加、每轮变化值在最后一条消息”的规则不涉及。`prompt-prefix.md` 在当前检出中未找到，按题目给的规则路径引用；但 diff 的文件列表足以确认无模型侧改动。
2. **不会。** 没有新增服务端或模型输入字段；`.notSent` 是客户端本地枚举，新增的只是 UI 文案。`safariUsedAt` 的 `now()` 是旧代码，本增量未改其序列化方式，也未引入无序集合到请求字节。
3. **有自动检查，但覆盖不完整。**
   - `HandoverTests.swift:257-265`：`queuesOffline: false` 时 503 应返回 `.failed(.notSent)`、不写队列。反向用例在旧的“总是排队”实现下会失败，有效。
   - `safari-panel.test.ts:87-93` + `safari-panel-review.mjs:60-64`：验证“未共享存储”结果在面板上显示 `outcome.notSent`、不显示完成标记。它只验证渲染，不验证 `SafariBridge` 真的走到 `.failed(.notSent)`。
   - `apple-entitlement-variants.test.ts`：能发现缺 `.keychain-only` 文件、硬编码路径、默认值被改成 `.keychain-only`；但删掉某个目标/配置的设置不会失败，见意见 2。
   - 测试未实际执行（无运行权限），以上是从代码推断。
4. **逐个值核对：**
   - `HandoverProblem.notSent`：产生于 `Handover.swift:549`；使用于 `HandoverSheet.swift:147` 的 `outcome.\(rawValue)`，三份 `Localizable.strings:26` 都有 `outcome.notSent`；测试也使用。两端接受。
   - `queuesOffline`：默认 `true`，现有调用方省略后保持付费账号行为；扩展在 `ExtensionSupport.swift:104` 传 `vault.sharesStorageWithApp`；`Handover.swift:549` 只按 Bool 判断。接受。
   - `sharesStorageWithApp`：产生于 `SharedVault.swift:53-56`；唯一使用端是 `ExtensionSupport.swift:104`，接受 Bool。注意它只证明“扩展自己能访问某个 group”，不证明 App 能读同一 group；当前 group 来自工程级同一构建设置，正常配置一致。
   - `HIMAWARI_ENTITLEMENTS_SUFFIX`：产生于 `project.pbxproj:459,476` 两个工程级配置；使用于 6 条 `CODE_SIGN_ENTITLEMENTS`（App/Share/Safari 各 Debug/Release）。空值展开为原全量路径，`.keychain-only` 展开为三份新文件，文件均存在。
   - 三份 `.keychain-only.entitlements` 路径：由后缀间接产生，Xcode 按路径读取，不要求 PBXFileReference；测试用 `existsSync` 加内容检查兜底。
   - `outcome.notSent` 本地化 key：产生于三份 strings；使用于 `HandoverSheet` 的 rawValue 映射和 Safari 面板测试/场景。三语齐全。
   - Safari 场景 id `22-gaps-2j-safari-not-sent`：产生于 `safari-panel-review.mjs:60-64`；使用于 `safari-panel.test.ts:88`，名称一致。
   - README 中 `safariUsedAt` 存储位置的说明：使用端是读文档的人，和代码不一致，见意见 1。

## 查过范围

本轮只处理 `496fe71..b1bc32a` 的增量，并沿增量证据追到相关旧代码；未重读无关旧代码。未运行测试，未编译 Mac，未核实免费账号的 keychain 能力，也未核实 PR 描述是否已同步更新。
