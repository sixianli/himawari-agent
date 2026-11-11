# PR 383 第 1 轮逐条判断

- **ds-1**（deepseek-v4.1-flash）「同一提议并发收到「同意」和「拒绝」时，两个结论都会落账」：成立。去掉新加的按提议排队后，新用例 records exactly one outcome（读取放慢 100ms 制造竞争）三次都失败；加上排队三次都通过。已修：production-mcp-read.ts #oneAtATime。
- **ds-2**（deepseek-v4.1-flash）「`legacyShim: false` 没有真正的反向用例，现有老版本测试去掉该设置也会通过」：可以更好。约束「不用旧的服务端主动请求」由老版本连接不注册写工具保证，这条有测试：删掉 context.era === "modern" 后 shows the write tool 用例失败（已实际运行）。legacyShim:false 是够不到的兜底，ADR 0225 已写明没有自动测试；补探针工具只加测试，不改行为。
- **ds-3**（deepseek-v4.1-flash）「已有 payload 只比较分类，不比较正文摘要」：不成立。contentRef 由 randomUUID 生成的提议编号决定，重发时 requestState 里的 argsHash 已核对正文和分类与首次一致（production-mcp-read.ts 的 state.argsHash !== argsHash 分支，有 reused for other content 用例），同一 contentRef 不可能对应不同正文；模型自己也写了「不是现成可利用漏洞」。
- **ds-4**（deepseek-v4.1-flash）「`requestState` 校验在 try 之外，被篡改/过期时不会走 `onFailure` 诊断」：可以更好。篡改或过期的状态照样被拒（tampered 用例断言 rejects.toThrow(/requestState/)），客户端行为不变；只是少一行服务日志。
- **ds-5**（deepseek-v4.1-flash）「不可见字符清洗没有覆盖全部格式字符，也没有处理行/段分隔符」：成立，按中高处理（触发后不是报错拒绝，而是把不该留的字符存下）。已改成 \p{Cc}\p{Cf}\u2028\u2029 并补用例；去掉新字符类后用例失败。
- **ds-6**（deepseek-v4.1-flash）「工具 schema 的 `maxLength` 作用在规范化之前，和实际校验口径不一致」：成立，低。已去掉 schema 的 maxLength，长度只按规范化后算；补用例：2000 个汉字加 50 个零宽字符可以提议，2001 个汉字回 INVALID；把 maxLength 加回去后用例失败。
- **ds-7**（deepseek-v4.1-flash）「配置了 `writeSecretRef` 但找不到对应密钥时，写工具会静默消失」：不成立。strict-configuration.ts:1466-1471 对 writeSecretRef 调 assertIdentitySecretReference，要求恰好一条 ref 相同且 purpose 为 mcp-write 的密钥，否则解析失败；service-main 用同样的 ref+purpose 查找，所以经过配置解析后找不到的情况没有可达输入。
- **ds-8**（deepseek-v4.1-flash）「文档与代码/其他 ADR 有漂移」：成立，低。已改 ADR 0225 的 bind 描述和前提 7 原话，在 ADR 0143 第 12 条、ADR 0186 第 6 条末尾追加 2026-11-11 的后续说明。
- **ds-9**（deepseek-v4.1-flash）「`daily-review.ts` 对同一模块重复 import」：可以更好。npm run check（含 biome lint）已通过（CHECK_ALL_PASSED 49 steps），合并两行 import 只动写法。
- **gl-1**（glm-5.3-flash）「规范化漏掉部分“零宽字符”，与 ADR 文字不完全一致」：部分成立：U+2060–2069 原来已经覆盖（字符类里是字面字符），U+00AD、U+2061 一类 Cf 字符确实漏了。和 ds-5 一起改。
- **gl-2**（glm-5.3-flash）「`keep()` 的 CONFLICT 重试分支没有确定性测试」：不再适用：加了按提议排队后，同一进程里同一提议的并发写不会再发生，CONFLICT 重试分支已删除（writer.keep 直接调用 applyProposal）。
- **gl-3**（glm-5.3-flash）「`MCP_WRITE_SECRET_REUSED` 检查无测试」：可以更好：配置层同一 ref 已有反向测试；两个不同 ref 解析出同一值只在构造函数兜底，补单测不改行为。
- **gl-4**（glm-5.3-flash）「`elicitationSupported` 把空对象视为支持 form，且该分支只测了“完全不支持”」：空对象算支持表单是规范的向后兼容写法（2025-11-25 版起 elicitation:{} 等同只支持 form）；补 url-only 用例只加测试，不改行为。
