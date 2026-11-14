# PR 431 第 1 轮作者说明

问题：公开输出密钥扫描（`scripts/ci/security-source.mjs` 的 `findBuildSecrets`，CI 用它检查要公开的文件里有没有密钥，报 `PUBLIC_ARTIFACT_CONTAINS_SECRET`）把 `docs/pi-development-guide.md` 第 229 行的文档示例 `apiKey: "$ACME_API_KEY",` 当成了密钥字面量（credential-literal），main 和每个 PR 的 CI 都因此变红。

根因：`credential` 只看键名像不像密钥（`apiKey`）和值是否至少 12 个字符，没有区分“值本身就是一个环境变量引用”。`$ACME_API_KEY` 只是变量名，不是密钥内容，不该算。

改动：
- `scripts/ci/security-source.mjs`：新增 `environmentReference = /^\$(?:[A-Z][A-Z0-9_]*|\{[A-Z][A-Z0-9_]*\})$/`；整个值完全等于 `$NAME` 或 `${NAME}`（名字只含大写字母、数字、下划线，大写字母开头）时不报 credential-literal。其他规则（私钥、Bearer、JWT、sk-、gh*_、AKIA 等模式和 sentinel）不受影响。
- `test/tooling/security.test.mjs`：新用例。三种文件类型（.md 文档、.json、.ts 源码）里的环境变量引用不报；值里有小写、多余后缀，或模板字符串里混入其他内容时照样报。去掉修复后该用例失败（已验证）。

为什么不改写文档示例或加例外：改示例只绕过这一处，下次别的文档写 `${VAR}` 示例还会红；加例外要 Andy 批准，而且掩盖的是扫描规则本身的缺陷。业界的密钥扫描器（gitleaks 等）同样把明显的占位或变量引用当作非密钥处理。

约束：不花 GitHub 的钱；代码不写注释；放宽规则不能让真实密钥漏过。

请核对：
1. 这个改动会不会改变模型已经见过的请求开头？（本 PR 只改 CI 扫描脚本，不涉及 Himawari 发给模型的内容；请确认。）
2. 放宽条件有没有让真实密钥漏过：例如以 `$` 开头的真实密钥、全大写的真实密钥（如 `$ABCDEFGHIJKL1234` 这类其实是密钥的值）、`literalParts` 把多段拼接后正好凑成 `$NAME` 的情况、JSON/source map 的 `sourcesContent` 路径、非代码文件的 quoted 和 dotenv 正则路径。
3. 正则是否锚定正确（`^`、`$`），有没有换行、Unicode 等绕过方式。
4. 测试是否覆盖了正反两面，是否有遗漏的文件类型路径。
