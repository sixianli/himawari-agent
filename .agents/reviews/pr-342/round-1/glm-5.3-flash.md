改动只有一处测试数据替换。我来读相关文件核实。
实现核对完毕。再查文档一致性(ADR 0111、I-19、I-73)。
# 复核报告

## 读代码证实的

**改动范围**：`git diff` 显示本次只有一个提交 407827fa,唯一改动是 `packages/sensitive-capture/test/secret-like.unit.test.ts:28` 把测试数据 `"gpt-4o"` 换成 `"wi-fi6"`,没有其他文件变动。

## 按严重度排列的发现

**【低】packages/sensitive-capture/test/secret-like.unit.test.ts:28 — 测试数据的挑选缺一点防回归说明**
- 问题:`wi-fi6` 能过检查，但仓库里没有机制防止以后有人在测试数据里再写贵模型名；这次是靠人肉把数据换掉，同样的误拦可能重演。
- 证据:`scripts/check-expensive-models.mjs:44-48` 的 `OWN_TEST` 只豁免了它自己的测试文件 `test/tooling/expensive-models.test.mjs`,对其他测试文件(包括本文件)照扫不误；报错文案(`check-expensive-models.mjs:102`)只说“改用集中配置里的低价模型”，没提示测试数据也会被拦。
- 建议(也是我认为更好的做法)：维持本次做法(换数据)，因为作者约束是“不放宽检查”，加豁免清单会削弱规则；但建议在 ADR 0111 的门槛一节或脚本报错文案里加一句“测试数据、示例文字也要避免贵模型名(包括 `gpt-4o` 这类短型号)”，把这次的教训沉淀下来。这是文档建议，不是代码缺陷。

没有发现中、高严重度问题。

## 作者说法逐条核对

| 说法 | 结论 |
|---|---|
| 全仓库只有这一处 gpt-4o | 当前工作树 `grep gpt-4o` 零命中，证实**改后**状态；本检出是稀疏检出(79% 文件)，另外 21% **未核实** |
| `node scripts/check-expensive-models.mjs` 改后通过 | 无法运行命令，**未核实**；但静态核对:`EXPENSIVE_MODEL_PATTERNS`(check-expensive-models.mjs:46-47)匹配 `gpt-\d` 等，`wi-fi6` 不命中任何模式，该文件在扫描范围内(packages/ 下 .ts)且无豁免，所以改后确实无命中，与“通过”一致 |
| 10 条测试 | 数出 secret-like.unit.test.ts 6 个 `it` + expensive-models.test.mjs 4 个 `it` = 10,与说法吻合；是否真通过**未核实**(不能运行测试) |
| `looksLikeSecretToken("wi-fi6")` 返回 false | 证实:`secret-like.ts:9-15`,NFKC 后 `wi-fi6` 过 TOKEN、非 6 位以上纯数字、长度 6 < 24、长度 6 < 8 → false。原值 `gpt-4o` 同理也是 false(长度 6),所以替换没有改变该用例的断言语义，正负例覆盖等价(都是“字母+数字+连字符的 6 字符普通词”) |

## 侧重检查

走过的流程:`npm run check` → `check-expensive-models.mjs` 扫描 `packages/sensitive-capture/test/secret-like.unit.test.ts` → 正则不命中 → CI 通过。全链路无未覆盖的新路径，因为改动不触及任何运行时代码，只触及测试数据；该测试文件本身有 6 条用例盯着 `looksLikeSecretToken` 的行为，数据替换不会留下无人看守的分支。

文档一致性:`docs/incidents-and-gates.md:58`(I-19)写明门槛是“出现 `anthropic/`、`openai/` 或 Claude、GPT 型号名就失败”，`docs/adr/0111-no-expensive-models-anywhere.md` 存在且互相引用；本次改动与文档描述一致，没有改规则本身。

## 必答问题

1. **不改变。**改动只在测试文件里，不触及系统提示、工具定义、历史消息或遮盖代码;`git diff` 确认无运行时文件变动，发给模型的内容完全不变，自然满足“只在末尾追加”。
2. **不会。**没有引入任何序列化、遮盖或带时间/无序集合的逻辑；被改的字符串只作为单元测试入参存在，不进入任何发给模型的字节。
3. **有，且反向用例会失败。**两层自动检查：① `expensive-models.test.mjs:23-43、45-63` 用临时 fixture 断言 `findExpensiveModels` 对 Sonnet/GPT 名字返回 findings,若有人把模型名放回代码会同时被脚本(退出码 1)和这两条用例拦住；② `secret-like.unit.test.ts:28-31` 断言 `looksLikeSecretToken("wi-fi6") === false`,若遮盖实现变化误判该词，此用例失败。反向用例真实存在，不是空转。
4. **可以接受。**“产生”处仅 `secret-like.unit.test.ts:28` 一处，“使用”处仅同文件第 31 行的断言，校验两端(正则模式 `EXPENSIVE_MODEL_PATTERNS` 不命中、`looksLikeSecretToken` 返回 false)都亲自核对过；不涉及跨模块的标识、配置键或清单，无 I-73 式“两端校验对不上”的风险。

**推测(未核实，已说明)**：全量检出下无其他 gpt-4o、两条测试套件实际运行通过——本环境不能执行命令、且检出不全，只能确认静态一致性。
