# PR 275 第 1 轮复核逐条判断

复核提交 a954eebd。中、高的“会出错”意见是 D1、D2、G1：精确值白名单没写进 ADR，三块新白名单没有用真实 Gitleaks 验证。已修改，要对修改做第 2 轮复核（只用 DeepSeek）。低的 G3 与 D1 同一处，一起改了。其余不成立或属于“可以更好”，不改，列给 Andy。

| 编号 | 模型原话 | 成立 | 类别 | 判断 |
|---|---|---|---|---|
| D1 | 精确值白名单违反 ADR 0157 与安全检查规范，没有同步改规则或取得新批准 | 是 | 会出错（中高） | PR 248 起的精确值白名单一直没写进 ADR。新增 ADR 0177 修订 0157，0157 加 `amended_by`，Spec 补写条件。批准：Andy 答“需要”，PR 248 批准过白名单方案；改用白名单写进 PR 说明，由 Andy 合并时决定。 |
| D2 | 新白名单没有用锁定版本的真实 Gitleaks 自动验证 | 是 | 会出错（中高） | `test/tooling/gitleaks-config.test.mjs` 加了真实 Gitleaks 样例：放行的文件不再报，同一个值在别的文件照报；换回旧 `gitleaks.toml` 时测试失败。 |
| D3 | `ci/toolchain-lock.json` 的新 sha256 未核实，`npm run check` 不覆盖 | 否 | 可以更好 | 已用 `shasum -a 256` 核对，摘要一致；CI 的 security 作业扫描前运行 `verifyRuleFiles`。把摘要核对放进 `npm run check` 列给 Andy。 |
| D4 | 新路径测试覆盖仍不完整，但风险有限 | 是 | 可以更好 | 正则锚定精确文件名，变体本来不匹配；补否定用例列给 Andy。 |
| G1 | 三个新白名单块没有真实 Gitleaks 层面的自动验证 | 是 | 会出错（中高） | 同 D2，已修。 |
| G2 | 检出树里没有 `.agents/reviews`，“当前文件命中”说法不成立 | 否 | 可以更好 | 那些复核记录是入库文件；复核环境的只读限制拒绝读 `.agents/reviews`，所以模型看不到。 |
| G3 | quality-gates design 第 240 行的白名单规格与代码不一致 | 是 | 会出错（低） | 与 D1 同一处，已随 ADR 0177 补写。 |

DeepSeek “必答问题”部分和 GLM 的核实结果不是意见，不列。
