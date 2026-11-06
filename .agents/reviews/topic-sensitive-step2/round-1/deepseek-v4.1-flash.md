# 敏感信息识别第 2 步：独立方案

## 0. 结论摘要

- **secretlint 采用“移植”而不是运行时依赖**：只移植推荐集里能处理纯文本的规则，做成 `sensitive-capture` 内的同步实现；secretlint 只作为测试用 oracle（精确固定版本），不进运行时。
- **机器密钥新规则默认同时进入“遮盖”和“整段拦下”**，但每条规则带 `blocking` 开关，方便把误报大的规则单独降级，不改 30 个调用点。
- **密码关键词检测与现有 `PASSWORD_ASSIGNMENT` 并存**：现有规则先跑，detect-secrets 风格的关键词+赋值检测后跑；保留上游的模板、`$`、间接引用、UUID、ID 类过滤器，不保留三个被否掉的过滤器和文件类过滤器。
- **流式遮盖由规则元数据驱动**：每条规则声明固定前缀和“未完成后缀”正则，`machineSecretHoldStart` 自动覆盖新规则；用“任意切分点拼接后必须等于一次性遮盖结果”的属性测试兜底。
- **上线只让缓存失效一次**：行为变更合并到同一个发布；ADR 0176 给缓存规则第 4 条加一次性例外，并记录规则集版本、监控和回滚方式。
- **先落另一个线程的“排除规则”，再落本方案的行为变更**；本方案的基础重构可以并行开发，但合并顺序放在排除规则之后。

---

## 1. 方案依赖的前提

| # | 前提 | 来源与原话 | 性质 |
|---|---|---|---|
| P1 | 这个包不能依赖 Himawari 其他包，不能读写文件/数据库/网络，浏览器里也能用 | `docs/adr/0167-sensitive-capture-package.md:51-53`：“只放识别和遮盖本身，不依赖 Himawari 的其他包，不做文件、数据库或网络读写，浏览器里也能用。”；`packages/sensitive-capture/README.md:3` 同义 | 读代码证实 |
| P2 | 浏览器端确实直接引用这个包 | `apps/control-center/package.json:14` 依赖 `@himawari-agent/sensitive-capture`；`apps/control-center/src/memory-import.ts:2` `import { mentionsSensitiveMaterial } from "@himawari-agent/sensitive-capture";` | 读代码证实 |
| P3 | 现有扫描 API 是同步的，调用点很多 | `packages/sensitive-capture/src/machine-secrets.ts:47` `export function scanMachineSecrets(input: string): readonly MachineSecretFinding[]`；`:58` `containsToolOutputSecret`；`:86` `assertMachineSecretFree`。`grep` 到 30 多个调用点 | 读代码证实（数量为约数） |
| P4 | secretlint 的 `lintSource` 是异步的 | secretlint 源码 `@secretlint/core/src/index.ts`：`export const lintSource = ({ source, options }: SecretLintSourceOptions): Promise<SecretLintCoreResult> => {`。https://github.com/secretlint/secretlint/blob/master/packages/%40secretlint/core/src/index.ts | 一手源码证实 |
| P5 | secretlint 有规则依赖文件名或扩展名 | GCP 规则：`import path from "node:path";`，且 `if (source.ext === ".p12") ... else if (source.ext === ".json")`。https://github.com/secretlint/secretlint/blob/master/packages/%40secretlint/secretlint-rule-gcp/src/index.ts；npm 规则：`const isPackageFile = (filePath?: string): boolean => { if (!filePath) { return true; } ... }`，`isNpmrc` 同样在无路径时返回 `true`。https://github.com/secretlint/secretlint/blob/master/packages/%40secretlint/secretlint-rule-npm/src/index.ts | 一手源码证实 |
| P6 | secretlint 推荐集里的 `filter-comments` 可以用注释关闭检测 | 源码解析 `secretlint-disable`、`secretlint-enable`、`secretlint-disable-line` 等注释。https://github.com/secretlint/secretlint/blob/master/packages/%40secretlint/secretlint-rule-filter-comments/src/index.ts | 一手源码证实 |
| P7 | detect-secrets 的关键词检测有固定 DENYLIST，并且无文件类型时只使用“要求引号”的那组赋值正则 | `detect_secrets/plugins/keyword.py`：`DENYLIST = ('api_?key', ..., 'password', 'passwd', 'pwd', 'secret', ...)`；`if denylist_regex_to_group is None: attempts = [QUOTES_REQUIRED_DENYLIST_REGEX_TO_GROUP]`。https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/keyword.py | 一手源码证实 |
| P8 | detect-secrets 默认过滤器包括 sequential、UUID、ID、模板、`$`、间接引用、锁文件、swagger、非文本文件等 | `detect_secrets/settings.py` 的 `self.filters` 默认集合。https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/settings.py；实现见 `detect_secrets/filters/heuristic.py`。https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/filters/heuristic.py | 一手源码证实 |
| P9 | 现有机器密钥是 7 条，统一替换成 `[密钥]`；现有密码规则有中日韩英关键词和 `: = 是 为 は` 分隔符 | `packages/sensitive-capture/src/machine-secrets.ts:1-43`；`packages/sensitive-capture/src/redaction.ts:62-68` | 读代码证实 |
| P10 | 历史里存遮盖前原文，每次发送时对整段历史重新遮盖 | `.claude/rules/prompt-prefix.md:36`：“历史里存的是遮盖前的内容，每次发送时按确定的规则重新遮盖。”；`packages/application/src/services/model-egress.ts:190-210` 对每个文本字段调用 `redactForEgress` | 读代码证实 |
| P11 | 已经发给模型的内容只能在末尾追加，例外要写进 ADR | `.claude/rules/prompt-prefix.md:35`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。……例外只有三种……” | 读代码证实 |
| P12 | 遮盖必须确定，不能依赖后文 | `.claude/rules/prompt-prefix.md:51-53`：“同样的内容，每次都要序列化成同样的字节。”“遮盖敏感信息必须是确定的。一条消息遮成什么样，只能取决于它自己和它前面的内容，不能取决于它后面的内容。” | 读代码证实 |
| P13 | 直接依赖必须精确固定 | `.agents/instructions/pi-and-workspace.md:25`：“所有直接外部依赖的版本都保持精确；不得为直接依赖引入版本范围。” | 读代码证实 |
| P14 | 新 `ruleId` 会被持久化，且内存审计有专门的分类函数 | `packages/persistence-sqlite/src/migrations/0078_sensitive_interceptions.sql:18` `rule_id TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 128)`；`packages/persistence-sqlite/src/sqlite-sensitive-interception-operations.ts:52` `boundedText(item.ruleId, 128)`；`packages/application/src/services/sensitive-interception-recorder.ts:32-36` 只认 `MACHINE_SECRET_RULE_IDS` 和 `machine-secret/password/verification-code`；界面只显示 category：`apps/control-center/src/components/sensitive-interceptions.tsx:162` | 读代码证实 |
| P15 | I-73 的教训：产生值的地方和使用值的地方要逐个核对 | `docs/incidents-and-gates.md:112`：“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」” | 读代码证实 |
| P16 | 许可证要求保留版权和许可声明，并标明改动 | secretlint `LICENSE`：`Copyright (c) 2020 azu`，MIT。https://github.com/secretlint/secretlint/blob/master/LICENSE；detect-secrets `LICENSE`：`Copyright 2017-2018 Yelp Inc.`，Apache 2.0。https://github.com/Yelp/detect-secrets/blob/master/LICENSE；`keyword.py` 文件头还带有 Hewlett-Packard 的 MIT 声明。https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/keyword.py | 一手来源证实 |
| P17 | 版本和包体 | npm registry 中 `@secretlint/secretlint-rule-preset-recommend@13.1.0`：`"version":"13.1.0","license":"MIT","unpackedSize":638877`。https://registry.npmjs.org/@secretlint/secretlint-rule-preset-recommend/13.1.0；PyPI `detect-secrets 1.5.0`，Apache classifier。https://pypi.org/pypi/detect-secrets/1.5.0/json | 一手来源证实 |
| P18 | 现有测试和门槛 | `packages/sensitive-capture/test/redaction.unit.test.ts:4-71` 正反例；`:95-113` 确定性和前缀稳定；`:126-191` 稳定占位符；`.claude/rules/prompt-prefix.md:73` `check:prompt-prefix`；根 `package.json:43` | 读代码证实 |
| P19 | 另一个线程在加“排除规则” | 本次材料描述；当前检出里 `grep` 未找到对应实现 | **未核实** |

---

## 2. 方案本身

### 2.1 总体结构

在 `packages/sensitive-capture/src/` 下新增规则层，不改公开函数名：

```text
src/
  machine-secrets.ts        // 对外 API，改为驱动规则注册表
  redaction.ts              // 在现有密码规则之后接入关键词检测
  rules/
    types.ts                // SecretRule / Match / origin / blocking
    himawari.ts             // 现有 7 条，正则和行为原样
    secretlint.ts           // 从 13.1.0 移植的纯文本规则
    keyword.ts              // detect-secrets KeywordDetector 移植
    filters.ts              // 保留的 detect-secrets 过滤器
    streaming.ts            // 从规则元数据生成 hold 标记
  upstream/
    RULE_MANIFEST.json      // 上游版本、规则 id、排除项、改动说明
THIRD_PARTY_NOTICES.md
```

规则接口建议：

```ts
interface SecretRule {
  id: MachineSecretRuleId | PasswordRuleId;
  origin: "himawari" | "secretlint" | "detect-secrets";
  kind: "machine-secret" | "password";
  blocking: boolean;
  prefixes: readonly string[];       // 必备字面量，用于快速跳过
  find(input: string): Iterable<Match>;
  streaming?: {
    markers: readonly string[];
    active: RegExp;
    hold?: (pending: string) => number | null;
  };
}
```

关键约束：

- **现有 7 条规则顺序、正则、替换文本都不动**，新规则追加在后面。`MACHINE_SECRET_RULE_IDS` 只追加、不重排、不删除，避免已存 `ruleId` 的含义变化。
- 新规则 id 用命名空间，例如 `secretlint/anthropic`、`secretlint/github`、`detect-secrets/password-keyword`。长度都小于 128，满足 P14。
- 新规则只复用现有占位符 `[密钥]`、`[密码#tag]` 等，不引入新的占位符格式。
- 所有规则必须是纯函数：不读时间、随机数、文件路径、环境变量、网络；不使用 `toLocaleLowerCase`；正则不用共享 `lastIndex`（用 `matchAll` 或每次新建正则）。
- `redactMachineSecrets` 用全部机器规则；`scanMachineSecrets` 默认用 `blocking: true` 的规则，保留紧急降级能力。现有 7 条全部 `blocking: true`，所以现有行为不变。

### 2.2 Q1：secretlint 怎么接进来

**结论：移植成包内同步实现，secretlint 只作为测试 oracle。**

理由：

1. **同步 API**：`scanMachineSecrets` 是同步的，30 多个调用点直接 `.length` 判断；`lintSource` 返回 `Promise`（P4）。如果运行时依赖 secretlint，要么把 30 多个调用点改成异步，要么维护一条异步扫描路径，两条路径的行为很难保证一致。
2. **浏览器构建**：control-center 直接 import 这个包（P2）。secretlint 的 GCP 规则 `import node:path`（P5），npm 规则依赖文件路径语义；即使能打包，也会把 Node 专用代码和文件语义带进浏览器包。
3. **包契约**：ADR 0167 明确这个包不做文件读写、浏览器可用（P1）。运行时依赖 secretlint 会破坏这个契约。
4. **文件依赖规则在聊天里没有意义**：GCP 只在 `.p12`/`.json` 时运行；npm 在无 `filePath` 时反而把内容同时当 `package.json` 和 `.npmrc` 处理（P5）。直接调用 `lintSource` 而不传路径，行为和文档不一致；传假路径又会引入“同一段文字因文件名不同而遮出不同字节”的问题。
5. **filter-comments 是绕过口**：secretlint 的注释关闭检测（P6）和 detect-secrets 的 `# pragma: allowlist secret` 是同一类问题。聊天里任何人都能打一行注释关掉检测，必须排除。
6. **包体**：推荐集不小（P17），移植后只保留规则正则和少量过滤器，运行时更轻。

移植范围：

- 推荐集 27 条全部移植为纯文本规则；其中 GCP、npm 做“聊天化”适配：
  - GCP：不再看扩展名，改为“文本能解析成 JSON，且含 `private_key_id` 和 PEM `private_key`”时报告。`.p12` 是二进制，聊天文本里不作为目标。
  - npm：去掉文件路径门控，保留内容型子规则：`npm_...` token、`_authToken=...`、`https://user:x-oauth-basic@github.com/...`。三者拆成不同 id，便于分别设置 `blocking`。
- `filter-comments` 不移植。
- AWS 规则按上游默认选项移植：默认只报 `AWS_SECRET_ACCESS_KEY`，不启用 `enableIDScanRule`；现有 `aws-access-key` 继续覆盖 `AKIA/ASIA`。
- privatekey 按上游 13.1.0 的 Base64 校验移植；现有 `private-key-block` 保留，用来兜住短块、占位块。
- 所有 `allows` 选项不暴露给聊天；保留上游内置忽略（例如 AWS 示例 key、database 的 localhost/example.com/占位符）。聊天用户不能配置 allowlist。

许可和升级：

- `THIRD_PARTY_NOTICES.md` 收录 secretlint MIT、detect-secrets Apache 2.0、`keyword.py` 的 HP MIT 声明。
- 每个移植文件头写：来源仓库、版本 `13.1.0`、原始文件路径、改动摘要（TypeScript 化、去文件门控、CJK 关键词、聊天值边界等）。
- `RULE_MANIFEST.json` 记录上游版本、规则 id 映射、排除项和改动。
- 测试用 devDependency 精确固定 `@secretlint/core@13.1.0` 和 `@secretlint/secretlint-rule-preset-recommend@13.1.0`，只用于 oracle；`package-node-runtime.mjs` 只复制 `dependencies`，不复制 `devDependencies`（`scripts/package-node-runtime.mjs:48-53`），不会进运行时。
- 升级流程：改 manifest 版本 → 更新移植文件 → 跑 oracle 和负例 → 更新 NOTICE。用检查脚本禁止运行时 `src` 出现 `@secretlint` 或 `detect-secrets` 导入。

### 2.3 Q2：新规则用在哪里

**结论：机器密钥新规则默认同时进入“遮盖”和“整段拦下”；密码关键词只用于遮盖，永不进入机器密钥拦截。**

具体：

- `redactMachineSecrets` 使用全部机器规则；出口遮盖、trace 打码、日志打码、URL 打码都会自动用上新规则。
- `scanMachineSecrets` 默认使用 `blocking: true` 的机器规则；现有 30 多个“整段拦下”调用点不改代码，自动变严。
- 每条新规则带 `blocking` 字段，默认 `true`。如果某条规则在生产里误报明显，把它改成 `false` 即可降为“只遮盖”，不需要改 30 个调用点。
- `detect-secrets` 关键词规则只产生 `kind: "password"`，不进入 `scanMachineSecrets`，所以不会因为聊天里说“密码是……”而把整段文件读取/网页搜索拦下。
- `redactWebContentSecrets` 也应改为复用同一套机器规则，但保留它原有的 `[REDACTED_MACHINE_SECRET]` 输出标记，避免影响网页导入的既有消费者。

误报代价：

- **只遮盖的误报**：模型看到 `[密钥]` 而不是原文，可能少一点上下文，但请求不会失败，用户可以继续。
- **整段拦下的误报**：文件读取被拒绝、网页搜索结果被丢弃、记忆不保存、提醒/检查点失败，用户会看到失败或内容静默消失。代价明显更高。
- 因此默认让新规则进入 blocking，是因为 secretlint 规则大多是固定格式的高置信 token；`basicauth` 和 `database-connection-string` 是相对宽的两条，但上游已有 localhost/example.com/占位符等内置忽略。建议先按 `blocking: true` 上线，同时保留开关；如果 shadow 或生产日志显示误报，再单独降级这两条，而不是一开始就放弃拦截。

### 2.4 Q3：detect-secrets 关键词检测怎么改造成聊天文本

**结论：与现有 `PASSWORD_ASSIGNMENT` 并存，不替换。**

处理顺序：

1. 现有 `PASSWORD_ASSIGNMENT` 先跑，覆盖中日韩英关键词和 `: = 是 为 は` 分隔符。
2. 新增 detect-secrets 风格的关键词检测，跑在现有规则之后；它看到已经生成的 `[密码#...]` 会跳过，避免重复计数。
3. 之后继续现有的身份证、IBAN、银行卡、个人番号、验证码规则。

关键词：

- 英文沿用上游 DENYLIST：`api_key`、`auth_key`、`service_key`、`account_key`、`db_key`、`database_key`、`priv_key`、`private_key`、`client_key`、`db_pass`、`database_pass`、`key_pass`、`password`、`passwd`、`pwd`、`secret`、`contraseña`、`contrasena`。
- 中日韩沿用现有规则的关键词，并补上 `密钥/密鑰`：`密码/密碼`、`口令`、`PIN码/PIN碼`、`安全码/安全碼`、`授权码/授權碼`、`パスワード`、`暗証番号`、`비밀번호`、`암호`、`비번`、`密钥/密鑰`。
- **CJK 关键词后面不允许任意 CJK 词缀**。上游的 `\w*` 在 Python 里会把中文也算作词字符，若照搬到聊天，`密码规则：至少 8 位` 会被当成密码赋值。我们只允许英文关键词带 `[A-Za-z0-9_]*` 词缀，CJK 关键词必须紧跟分隔符。这是为了保持现有负例 `密码规则：至少 8 位` 不被误遮。

赋值写法：

- 聊天没有文件类型，detect-secrets 自己的回退是“要求引号”的那组（P7），但这样会漏掉 `password: hunter2` 这种最普通的聊天写法。
- 我们选择上游已有的 `CONFIG_DENYLIST_REGEX_TO_GROUP`（冒号、等号、`:=`、`==`、`!=`、引号+分号等），把聊天文本当作“配置文本”处理。这是**选择上游已有的一组正则**，不是新发明规则。
- 值边界采用现有 `PASSWORD_ASSIGNMENT` 的 `[^\s,，;；]+`，而不是上游按整行取值的 `SECRET`。原因：聊天里 `password: my dog is cute` 不应把整句都遮掉；按空白/中英文逗号/分号截断更符合聊天文本。这个改动会写进 `RULE_MANIFEST.json` 和 NOTICE。

保留的过滤器：

- `is_templated_secret`：`{secret}`、`<secret>`、`${secret}`、单字符。
- `is_prefixed_with_dollar_sign`：`$` 开头的值。
- `is_indirect_reference`：`getPassword()`、`request.headers['x']` 这类间接引用。
- `is_potential_uuid`：UUID。
- `is_likely_id_string`：赋值名以 `id`/`_id` 结尾的值。
- 额外加一条我们自己的幂等保护：值以 `[` 开头（已有占位符）时跳过。

不保留：

- `is_sequential_string`（否则 `123456` 会被放过）。
- `is_not_alphanumeric_string`。
- `is_line_allowlisted`（否则 `# pragma: allowlist secret` 能绕过）。
- 所有文件类过滤器：非文本文件、锁文件、swagger、无效文件等。
- secretlint 的 `filter-comments`。

保留过滤器中的已知代价：`is_prefixed_with_dollar_sign` 会放过 `password: $ecret`；这是上游行为，若要改需要 Andy 单独拍板。

### 2.5 Q4：流式遮盖怎么跟上新规则

现状：`StreamingMachineSecretRedactor` 依赖 `POTENTIAL_SECRET_MARKERS` 和 `ACTIVE_SECRET_SUFFIXES`（`machine-secrets.ts:91-152`），Pi 流式输出在 `packages/runtime-pi/src/pi-model-transport.ts:336` 使用；实时执行流在 `packages/application/src/services/execution-live-feed.ts:46` 使用 `machineSecretHoldStart`。

方案：

1. 把标记和后缀正则从规则元数据生成，不再手写第二份列表。每条规则声明：
   - `markers`：固定前缀，例如 `sk-ant-`、`glpat-`、`npm_`、`dckr_pat_`、`hvs.`、`ops_`、`xoxb-`、`SG.`、`shpat_`、`AKIA`、`ASIA`、`-----BEGIN`、`AWS_SECRET_ACCESS_KEY=`、`mongodb://`、`postgres://` 等。
   - `active`：匹配“从标记到当前末尾”的未完成 token 正则。
   - `hold`：少数需要自定义判断的规则，例如 basicauth 只在 `scheme://user:` 且尚未出现 `@`/空白时扣住；避免每个普通 URL 都被扣住。
2. 更新 private key 边界：现有 `PRIVATE_KEY_BOUNDARY` 和 `machineSecretHoldStart` 只覆盖 `RSA/EC/OPENSSH`（`machine-secrets.ts:56,131`）；secretlint privatekey 还覆盖 `DSA/PGP` 和 `PRIVATE KEY BLOCK`，两处都要同步扩展。
3. 对关键词规则，把新的中英文关键词加入 markers，并写 `active` 正则覆盖“关键词 + 分隔符 + 未完成值”。这会像现有 `password` 一样，在模型写到关键词时短暂扣住，直到出现空白/标点或 flush。
4. 属性测试：对每个正例，按每一个可能的切分点把文本切成多段，依次 `append`，最后 `flush`；结果必须逐字节等于 `redactMachineSecrets(完整文本)`。任何漏掉的 marker 都会在这个测试里以“前缀泄漏”失败。
5. `execution-live-feed` 不需要改代码，它调用同一个 `machineSecretHoldStart`；新规则的 hold 自动生效。

### 2.6 Q5：怎么证明没有漏遮、误遮可控

分四层：

**A. 上游 oracle 对照**

- secretlint：测试里用 devDependency 的 `lintSource` + 推荐集，对固定样本和随机样本跑上游，比较我们移植规则的命中范围和值。文件依赖规则（GCP/npm）单独用适配后的期望，不直接比较文件门控。
- detect-secrets：在云服务器/Hermes 上用 `python3 -m venv` 安装精确 `detect-secrets==1.5.0`，跑 `KeywordDetector` + 保留的过滤器，生成 JSON golden 提交到 `packages/sensitive-capture/test/fixtures/`；日常 `npm run check` 比较我们的输出和 golden。Python 不在普通 CI 里跑，避免环境依赖。
- 反向用例：删掉任意一条移植规则、把某个过滤器错误地加回来、或把值边界改回整行，oracle 必须失败。

**B. 每条规则的正反例**

- `rules.unit.test.ts`：27 条 secretlint 规则每条至少一个正例、一个近似负例；关键词规则覆盖中英日韩、全角/半角分隔符、带引号/不带引号。
- 负例必须包含：`123456` 作为密码（必须遮，证明没有 `is_sequential_string`）、`# pragma: allowlist secret`（必须不能关闭检测）、`password: ${DB_PASSWORD}`、`password: getPassword()`、`password: <your-password>`、UUID、`user_id: ...`、订单号、日期、版本号、坐标、电话、ISBN、普通 URL。
- 正例必须包含：`password: hunter2`、`密码：abc123`、`パスワード：secret99`、`비밀번호: hunter22`、`glpat-...`、`sk-ant-...`、`npm_...`、`dckr_pat_...`、`xoxb-...`、`AWS_SECRET_ACCESS_KEY=...`、`mongodb://user:pass@db.internal/prod`。

**C. 确定性和前缀稳定**

- 同一输入连续跑多次、在不同输入之后跑，输出必须相同；防止全局正则 `lastIndex` 泄漏。
- 同一值在不同消息里必须得到同一个占位符 tag；不同值不能碰撞。
- `redactForEgress` 必须幂等；`findSensitiveValues` 的值必须能被 `locateMaskedValues` 定位。
- 扩展 `redaction.unit.test.ts:95-113` 的前缀稳定测试，加入新规则样本。
- `check:prompt-prefix` 增加一条历史里带新规则密钥的多轮用例；反向用例仍要能报告断裂。

**D. 契约和性能**

- 新增 `contracts.unit.test.ts` + `test/integration/sensitive-interceptions.test.ts` 用例：每个 `MACHINE_SECRET_RULE_IDS` 都能被 `memoryCategory` 分类；每个新 `ruleId` 长度 1-128，能被 SQLite 存储和读回；界面 category 仍是现有 5 类。
- `scripts/check-egress-redaction.mjs` 增加新规则特征签名（`sk-ant-`、`glpat-`、`npm_`、`dckr_pat_`、`xvs.` 等），反向用例验证：把新规则写回产品代码会失败。
- 性能基准脚本 `scripts/bench-sensitive-capture.mjs`：1KB、100KB、1MB 文本，10k 行，以及大量近似 token 的对抗样本。先测基线，再定门槛；建议 100KB p95 < 10ms、1MB p95 < 100ms，作为观察指标，暂不设为硬阻断。用 `prefixes` 快速跳过规则，避免每条正则都扫全文。

### 2.7 Q6：上线时“已发内容变一次”怎么处理，ADR 写什么

**ADR 编号建议 0176**（当前最新是 0175）。ADR 内容至少写：

1. **背景**：历史存遮盖前原文，每次请求重新遮盖（P10）；规则升级会让命中新规则的历史消息字节变化一次。
2. **决定**：新增 ADR 0176，作为缓存规则第 4 条的一次性例外；同一规则集版本内仍只追加。
3. **范围**：只影响“历史里含新规则能识别的内容”的对话；不含新内容的对话字节不变。变化从最早命中的历史消息开始，该对话下一次请求缓存整段重算一次；之后恢复只追加。
4. **不做的事**：不迁移、不改写存储中的原文；不在系统提示/工具定义里放规则版本；不做运行时开关（避免同一对话中途切换导致反复失效）。
5. **规则集版本**：导出 `SENSITIVE_CAPTURE_RULE_SET_VERSION`，只用于日志和监控，不进请求。`cache.follow_up_low_hit` 日志带上这个版本，便于区分“规则升级导致的命中率下降”和“服务方/密钥轮换”。
6. **监控**：上线后对比后续轮次缓存命中率；预期一次下降后恢复。排查清单里加入“遮盖规则集升级”。
7. **回滚**：回滚规则集会让字节再变一次；这是可接受的，不是永久改写。
8. **许可**：记录 secretlint MIT、detect-secrets Apache 2.0、HP MIT 声明，以及移植改动。
9. **排除项**：记录不移植的三个 detect-secrets 过滤器、文件类过滤器、secretlint `filter-comments`。
10. **上线方式**：行为变更合并到同一个发布，确保“只变一次”。

同时改 `.claude/rules/prompt-prefix.md`：

- 第 4 条例外列表加：“按 ADR 0176 实施的一次性遮盖规则升级”。
- 第 78 行排查原因列表加：“遮盖规则集升级”。
- 不需要改第 5 条，因为它已经说历史存原文、每次重新遮盖。

### 2.8 Q7：分几个 PR、什么顺序，和另一个线程的排除规则谁先谁后

建议顺序：

1. **排除规则线程先落**（P19，未核实具体实现）。它和本方案改同一个 `redactForEgress` 管线；先落可以避免冲突，也让新关键词规则一开始就复用“Himawari 固定指令不检查”的排除层。
2. **PR1：规则注册表 + 版本常量 + oracle 骨架，行为不变**。
   - 把现有 7 条机器规则和现有密码/验证码等规则搬进注册表；输出逐字节不变。
   - 加 `RULE_MANIFEST.json`、`THIRD_PARTY_NOTICES.md` 骨架、`SENSITIVE_CAPTURE_RULE_SET_VERSION`。
   - 加 secretlint devDependency 和 oracle 测试骨架；加契约测试。
   - 如果排除规则还没落，PR1 先加一个 no-op 的 `exclusions` 钩子，等对方实现后接上。
3. **PR2：secretlint 机器密钥规则移植 + 接入遮盖/拦截**。
   - 新规则 id、`MACHINE_SECRET_RULE_IDS` 追加、recorder 分类更新、SQLite 契约测试。
   - 更新 `check:egress-redaction` 签名和反向用例。
   - 更新 web content 路径复用规则。
4. **PR3：detect-secrets 关键词检测 + 过滤器**。
   - 依赖排除规则已落；否则“0 到 1000”类用例会失败。
   - 与现有 `PASSWORD_ASSIGNMENT` 并存，补正反例。
5. **PR4：流式 hold 标记和属性测试**。
   - 可以和 PR2/PR3 同一个发布，但代码上单独 PR 便于审查。
6. **PR5：ADR 0176 + 缓存规则修改 + 监控/上线说明**。
   - 应在部署前合并；也可以提前单独合并，让 Andy 先拍板。
7. **PR6（可选）：把 `basicauth`/`database-connection-string` 从 shadow 转正式 blocking**，或反过来降级误报规则。

部署时 **PR2 + PR3 + PR4 必须同一个发布**，否则机器密钥和密码规则分两次上线，会让缓存失效两次。代码可以分 PR 审查，发布必须合并成一个版本。

---

## 3. 考虑过但不选的做法

| 做法 | 为什么不选 |
|---|---|
| 运行时依赖 `@secretlint/core` + preset | `lintSource` 异步（P4），30 多个同步调用点要改；GCP 依赖 `node:path`、npm 依赖文件路径（P5）；浏览器构建直接引用该包（P2）；包体大（P17）；`filter-comments` 会带来聊天绕过（P6） |
| 只把 secretlint 放在 Node 侧适配器，包内不移植 | 违反 ADR 0167“规则只写在这个包”（P1）；同步调用点仍要改；规则出现两套定义 |
| 直接照搬 `lintSource` 不传 `filePath` | npm 规则在无路径时把内容同时当 `package.json` 和 `.npmrc`（P5）；GCP 规则没有扩展名就完全不跑；行为不可预测 |
| 把 detect-secrets 的 `is_sequential_string`、`is_not_alphanumeric_string`、`is_line_allowlisted` 一起搬 | 会放过 `123456`、让注释关闭检测；Andy 已明确不搬 |
| 把 secretlint `filter-comments` 当推荐集的一部分搬进来 | 和 `# pragma: allowlist secret` 同类，聊天里任何人可绕过 |
| 用 detect-secrets 无文件类型时的“要求引号”回退 | 会漏掉 `password: hunter2` 这种聊天里最常见的写法；改用上游已有的 config 组，并记录适配 |
| 替换现有 `PASSWORD_ASSIGNMENT` | 会丢现有中日韩关键词和 `是/为/は` 分隔符，现有测试和线上行为都会变；并存更安全 |
| 每条规则用不同占位符 | 会破坏 `EGRESS_PLACEHOLDER_PATTERN`、`locateMaskedValues`、流式恢复和界面显示；统一复用现有标签 |
| 把规则版本写进系统提示 | 会让系统提示出现会变的值，违反缓存规则第 1-2 条（P11/P12） |
| 按对话冻结旧规则集 | 旧对话会继续漏遮新规则能识别的秘密；安全上不可接受 |
| 先上规则、后写 ADR | 缓存规则第 4 条要求有 ADR 依据；顺序反了会变成“先改已发内容再补理由” |

---

## 4. 风险和反例

### 已证实或可推断的风险

1. **误拦截增加**：新规则进入 30 多个 blocking 点后，文件读取、网页搜索、网页抓取、记忆保存、提醒、检查点都可能因新规则失败。反例：一段文档里出现 `https://alice:s3cr3t@internal.example.com` 或 `postgres://app:secret@db.internal/prod`，会被当成真实凭据拦下。缓解：每条规则可 `blocking=false`；先用负例语料和生产日志观察；`basicauth`/`database-connection-string` 是最可能需要降级的两条。
2. **CJK 词缀误报**：如果照搬上游 `\w*`，`密码规则：至少 8 位` 会被误遮。缓解：CJK 关键词不允许 CJK 词缀，保留现有负例。
3. **`$` 开头密码漏遮**：保留 `is_prefixed_with_dollar_sign` 会放过 `password: $ecret`。这是上游行为；如果业务上不能接受，需要 Andy 决定是否去掉该过滤器。
4. **ReDoS/性能**：detect-secrets 的 `SECRET` 正则和部分 secretlint 正则对大段文本可能慢。缓解：关键词检测按行处理并限制行长；每条规则用 `prefixes` 预筛；加对抗样本基准；不把未测过的阈值设为硬门槛。
5. **规则 id 契约**：新 id 必须同时被 `MACHINE_SECRET_RULE_IDS`、`memoryCategory`、SQLite `boundedText(...,128)` 接受。反例：只把新规则加进 `secretlint.ts`，忘了加进 `MACHINE_SECRET_RULE_IDS`，内存审计会静默丢掉这些发现；这正是 I-73 那类问题（P14/P15）。缓解：契约测试遍历所有 id。
6. **流式泄漏**：新规则如果没有对应 marker，流式输出可能先把密钥前缀发出去。反例：`glpat-` 分块到达，`machineSecretHoldStart` 不认识 `glpat-`，前半段直接输出。缓解：从规则元数据生成 marker + 任意切分点属性测试。
7. **web content 路径遗漏**：只改 `redactForEgress`，不改 `redactWebContentSecrets`，网页导入的内容仍可能带新规则能识别的密钥。缓解：让 `redactWebContentSecrets` 复用同一套规则，保留原输出标记。
8. **CI 脚本副本**：`scripts/ci/security-source.mjs`、`scripts/ci/redact-text.mjs`、`scripts/scan-machine-secrets.mjs` 还有独立规则副本（ADR 0167 的 open question）。新规则不会自动进入这些脚本，仓库扫描可能漏新类型。缓解：本步先记录为已知缺口；后续用共享 manifest 统一。
9. **gitleaks 例外清单**：新测试里的假 token 可能触发 `check:secrets`。缓解：像现有测试一样用字符串拼接构造假 token（例如 `["sk","ant","api03",...].join("-")`），不要直接写完整假密钥；必须新增例外时让 Andy 审核 `ci/security-exceptions.json`。
10. **许可合规**：Apache 2.0 要求保留 NOTICE、标明改动；MIT 要求保留版权。`keyword.py` 还带 HP 的 MIT 头（P16）。缓解：`THIRD_PARTY_NOTICES.md` + 每个文件头 + manifest。

### 推测/未核实

- 另一个线程“排除规则”的具体实现不在当前检出里，**未核实**。本方案假设它提供一个“跳过 Himawari 固定指令区间”的钩子；如果它改的是别的位置，PR1 的 `exclusions` 接口需要重新对接。
- 生产误报率、性能阈值、缓存命中率下降幅度都**未实测**；ADR 里应写成“上线后观察”，不要写成保证。
- 30 多个调用点没有逐一核对每个的容错行为；从代码看大多是 `.length > 0` 就拒绝/跳过，新增 blocking 规则会直接生效。上线前应至少抽查文件读取、网页搜索/抓取、自动记忆、提醒、检查点、`assertMachineSecretFree` 六类。

---

## 5. 需要 Andy 拍板的取舍

1. **移植 vs 运行时依赖**：建议移植，secretlint 只做测试 oracle。需要确认许可/NOTICE 方案。
2. **blocking 范围**：建议新机器密钥规则默认 `blocking: true`，保留逐条降级开关；是否同意先让 `basicauth`/`database-connection-string` 也直接 blocking，还是先 shadow 一版。
3. **关键词值边界**：建议用聊天的“空白/逗号/分号截断”，而不是上游整行取值；这会让 `password: my dog is cute` 只遮 `my`，不遮整句。是否接受这个偏离。
4. **`is_prefixed_with_dollar_sign`**：保留会漏 `password: $ecret`；是否接受上游行为。
5. **发布方式**：建议机器密钥和密码关键词变更合并成一个发布，确保缓存只失效一次；是否同意。
6. **ADR 0176 和缓存规则第 4 条措辞**：需要 Andy 确认“一次性遮盖规则升级”作为新例外。
7. **GCP/npm 的聊天化适配**：建议 GCP JSON 按内容识别、npm 去掉文件门控；是否同意。
8. **是否把新规则同步到 `redactWebContentSecrets`**：建议同步，但保留原输出标记；是否同意扩大本步范围。

---

## 6. 必答问题逐条回答

### 6.1 这个改动会不会改变模型已经见过的请求开头？

**会，但只对“历史里含有新规则能识别的内容”的对话，且是一次性的。**

- **系统提示、工具定义**：不变。没有新增每轮变化的值；规则集版本不会写进系统提示或工具定义。
- **历史消息**：会变。历史存的是遮盖前原文，每次请求重新遮盖（P10）；新规则上线后，之前没被遮的 `glpat-...`、`sk-ant-...`、`npm_...` 等会第一次被遮掉，那条消息及其后面的前缀字节变化。这就是 Andy 已同意、需要 ADR 0176 写进缓存规则第 4 条例外的“一次性遮盖规则升级”。
- **每轮会变的值**：仍然只在最后一条用户消息里。时间、本轮记忆、运行环境说明的机制不变；新规则本身是静态的，不引入每轮变化的值。
- **例外之外**：同一规则集版本内，后续请求仍然只追加；不会每轮都变。

依据：`.claude/rules/prompt-prefix.md:35`（只追加及例外）、`:36`（历史存原文、每次重新遮盖）、`:28`（每轮会变的值只放最后一条）；`packages/application/src/services/model-egress.ts:190-210`（每次对整段历史重新遮盖）。

### 6.2 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**在同一规则集版本、同一遮盖密钥下，不会；跨规则集升级时会变一次。**

保证方式：

- 规则是纯函数：固定顺序、固定正则、不读时间/随机/文件路径/网络；不用共享 `lastIndex`；不用 `toLocaleLowerCase`；不依赖对象/集合遍历顺序。
- 占位符 tag 只取决于 `kind + value` 的 HMAC（`model-egress.ts:186-206`），同一个值每次得到同一个 tag。
- `known`（`named-earlier`）只依赖它前面的消息，不向后看；这符合缓存规则第 11 条的例外（`.claude/rules/prompt-prefix.md:53`）。
- 文件依赖规则我们**不**按 `filePath` 分支；GCP/npm 改成纯内容判断。否则同一段文字换个文件名就会遮出不同字节，这是明确要避免的。
- 新规则不能使用 `Set`/`Map` 的遍历顺序来决定替换顺序；规则数组顺序固定，命中结果按位置排序。
- `filter-comments` 不移植；它不是“非确定”，但会让同一段文字因注释而行为不同，且可被聊天用户利用。

**会变的唯一情况**：规则集版本升级（ADR 0176）。这是全局一次性变化，不是同一版本内每轮变化。

### 6.3 改动有没有对应的自动检查，反向用例是否真的会失败？

有。计划中的检查：

| 检查 | 正向 | 反向（必须失败） |
|---|---|---|
| `packages/sensitive-capture/test/rules.unit.test.ts` | 每条新规则至少一个正例 | 删掉规则/改错正则时正例失败 |
| `secretlint-parity.unit.test.ts` | 我们的输出与 `lintSource@13.1.0` 一致 | 改错规则、漏掉过滤器、把 `filter-comments` 加回来时失败 |
| `detect-secrets-keyword.unit.test.ts` | 与 1.5.0 golden 一致 | 重新加回 `is_sequential_string` 时 `123456` 用例失败；加回 `is_line_allowlisted` 时 `# pragma: allowlist secret` 用例失败；漏 CJK 关键词时对应正例失败 |
| `redaction.unit.test.ts` 扩展 | 正例仍遮、负例仍不遮 | 去掉 `named-earlier`、改坏占位符、引入非确定性时失败 |
| `streaming.unit.test.ts` | 任意切分点拼接等于一次性遮盖 | 删掉某个 marker 时，某个切分点会泄漏前缀，测试失败 |
| `contracts.unit.test.ts` + sensitive-interceptions 集成 | 每个新 `ruleId` 能被 recorder 分类、能被 SQLite 存回 | 忘记更新 `memoryCategory` 或 id 超过 128 时失败（I-73 类） |
| `check:egress-redaction` | 新规则只在 `packages/sensitive-capture/src/` | 把 `glpat-` 等规则写回产品代码时失败；反向夹具验证检查器会报错 |
| `check:prompt-prefix` | 带新规则密钥的多轮对话仍只追加 | 改写历史/系统提示带变化值时仍失败（现有反向用例） |
| `scripts/bench-sensitive-capture.mjs` | 记录 1KB/100KB/1MB p95 | 性能回退超过预算时报告（先观察，后决定是否硬阻断） |

测试只在云服务器或 Hermes 上跑；不在 MacBook 上跑。

### 6.4 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐个核对如下：

| 产生的值 | 产生处 | 使用处 | 两端校验/结论 |
|---|---|---|---|
| 新 `MachineSecretRuleId`（如 `secretlint/anthropic`） | `machine-secrets.ts:1-9` 的 `MACHINE_SECRET_RULE_IDS` | `scanMachineSecrets`（`:47-54`）、`redactMachineSecrets` 回调（`:64`）、`EGRESS_REDACTION_RULE_IDS`（`redaction.ts:29-38`）、`memoryCategory`（`sensitive-interception-recorder.ts:32-36`）、`automatic-memory-service.ts:78`、`host-file-read-service.ts:158`、测试 | `ruleId` 在 SQLite 只要求长度 1-128（migration `0078:18`、ops `:52`）；界面只显示 category（`sensitive-interceptions.tsx:162`）。**必须把新 id 加进 `MACHINE_SECRET_RULE_IDS`**，否则 `memoryCategory` 返回 `undefined`，内存审计静默丢弃，重演 I-73。 |
| 新 `EgressRedactionRuleId`（如 `detect-secrets/password-keyword`） | `redaction.ts:29-40` | `ModelEgressSighting.ruleId`（`model-egress.ts:38`）、observer（`:197-205`）、`reportMasked`（`:493-500`）、recorder（`:75`）、持久化 `rule_id` | 类型是 union，新增成员编译期即可发现；持久化只做 1-128 长度检查，新 id 安全；UI 不按 ruleId 做枚举。 |
| `EgressRedactionKind` / category | `redaction.ts:3-9`、`ports/sensitive-interceptions.ts:27-33` | SQL `oneOf(SENSITIVE_INTERCEPTION_CATEGORIES)`（ops `:51`）、UI i18n（`zh-CN.ts:1179-1183`）、recorder `memoryCategory`（`:34-35`） | **不新增 category**。新机器规则全部映射到 `machine-secret`，关键词规则映射到 `password`。现有 5 类都能被 SQL、UI、recorder 接受。 |
| 占位符 `[密钥]`、`[密码#tag]` 等 | `redaction.ts:59-60,187-206` | `EGRESS_PLACEHOLDER_PATTERN`（`:55`）、`LOCATED_PLACEHOLDER`（`:329`）、`credentialFindings`（`:305-310`）、`restore`（`model-egress.ts:142-145`）、`StreamingPlaceholderRestorer`（`:78-103`） | 新规则必须复用现有 label，不能新增 `[secretlint:xxx]`。否则这些消费者不认识，恢复/定位/计数都会坏。 |
| `blocking` 元数据 | 新增于规则定义 | `scanMachineSecrets` 内部 | 只在包内使用，不持久化、不进请求。降级某条规则时，`redactMachineSecrets` 仍用全部规则，`scanMachineSecrets` 不再拦它；需要测试两种模式。 |
| `SENSITIVE_CAPTURE_RULE_SET_VERSION` | 新增常量 | `cache.follow_up_low_hit` 日志、启动日志 | **只进日志，不进系统提示/请求/持久化**。如果放进拦截记录，需要新字段和迁移，本步不做。 |
| `RULE_MANIFEST.json` 的上游版本/改动说明 | 新增文件 | 测试、NOTICE、升级流程 | 不进入运行时请求；只作为维护和许可证据。 |
| `redactWebContentSecrets` 的输出标记 | 现有 `[REDACTED_MACHINE_SECRET]` | `packages/integration-web/src/untrusted-content.ts:27` | 复用规则时保留这个标记，不改消费者；新增测试确认 `found` 和输出格式不变。 |
| CI 脚本的规则副本 | `scripts/ci/security-source.mjs`、`scripts/ci/redact-text.mjs`、`scripts/scan-machine-secrets.mjs` | `check:secrets` | 本步不会自动同步；这是已知缺口，记录在 ADR 的“没有处理的部分”。新测试里的假 token 用拼接构造，避免触发 gitleaks。 |

**结论**：只要做到“新 id 追加进 `MACHINE_SECRET_RULE_IDS`、category 不新增、占位符不新增、版本只进日志”，所有现有使用点都能接受。最危险的是 recorder 的 `memoryCategory` 和 SQLite 的 1-128 长度限制，必须用契约测试锁住。
