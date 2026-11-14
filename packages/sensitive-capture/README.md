# @himawari-agent/sensitive-capture

识别并遮盖文本里的敏感信息：机器密钥、密码、验证码、银行卡号、证件号。只做识别和遮盖，不读写文件、数据库或网络，也不依赖 Himawari 的其他包，Node 和浏览器里都能用。

决定和背景见 [ADR 0167](../../docs/adr/0167-sensitive-capture-package.md)。

## 内容

| 文件 | 作用 |
|---|---|
| `src/machine-secrets.ts` | 机器密钥规则：扫描（`scanMachineSecrets`）、遮盖（`redactMachineSecrets`）、断言（`assertMachineSecretFree`），以及流式输出时的遮盖（`StreamingMachineSecretRedactor`） |
| `src/redaction.ts` | 发给模型前的遮盖（`redactForEgress`）：机器密钥、密码、验证码、银行卡、证件号，生成稳定的占位符 |
| `src/identifiers.ts` | 存储时判断受限信息（`containsRestrictedIdentifier`）和凭据（`containsCredential`）、导入时的敏感提示（`mentionsSensitiveMaterial`）、诊断日志打码时的敏感字段名和网址参数名（`isSensitiveFieldName`、`isSensitiveQueryParameter`）、追踪记录打码时的敏感字段名（`isSensitiveTraceKey`） |
| `src/web-content.ts` | 网页抓取内容里的密钥遮盖（`redactWebContentSecrets`） |

## 约定

- 识别规则只写在这个包里。`npm run check:egress-redaction` 会拒绝其他产品代码里出现识别规则的特征写法。
- 同一段文字，每次遮出来的字节必须相同（见 `.agents/instructions/prompt-prefix.md` 第 11 条）。
