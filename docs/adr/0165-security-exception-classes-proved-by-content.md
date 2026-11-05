---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-04"
---

# ADR 0165：安全扫描逐条例外按“能证明不是密钥”的方式分类

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

CI（每次推送后自动跑的检查）的安全检查用 Gitleaks（开源的密钥扫描工具，版本锁定为 8.30.0）扫描当前文件和全部 Git 历史。扫到的每一处命中，要么由 `ci/security-exceptions.json` 里的例外放行，要么由仓库所有者在 PR 评论里批准的清单 `.github/security-review-manifest.json` 放行。放行前，`scripts/ci/check-security.mjs` 会回到源码里核对这一行，证明命中的值是假的；原来只有 5 种核对方式，所有者批准的条目还一律按“启动令牌”（行里有 `tokenValue`、值是 16 位十六进制重复两次）核对。

2026-11-04 在 Hermes（家里的 Linux 测试服务器）上按 CI 的方式扫描 main 加上 [ADR 0157](0157-gitleaks-allowlist-for-evidence-digests.md) 的白名单，仍有 23 条命中现有核对方式放不了，main 和所有 PR 的安全检查因此一直失败。逐条算过命中值的 SHA-256 摘要（一种 64 位十六进制的内容指纹）后，它们分成这几类：

| 命中值实际是什么 | 条数 | 例子 |
| --- | --- | --- |
| RFC 8291（Web 推送加密标准）里公开的示例认证密钥 | 8 | Web 推送测试照抄标准里的示例值核对加密结果 |
| 评测数据里编造的 GitHub 令牌 | 3 | 和机器扫描基线里已批准的一条摘要完全相同 |
| 测试里编造的 Bearer 值 `R2T14…` | 2 | 机器扫描基线已批准，理由里写着这个值 |
| 证据文件里“路径: git 文件编号” | 3 | 文件已删除，值是仓库里真实存在的 git 文件对象 |
| 证据文件里“日志文件名: 摘要” | 2 | 能从同目录的 `raw-logs.tar.gz` 重新算出 |
| 启动参数 `tmpfs-size=1048576` | 2 | 一个数字 |
| 会话编号 `thread:<UUID>` | 1 | 文件已删除 |
| 已删除的 Bark（一个 iPhone 推送服务）提醒测试里的设备密钥 | 2 | 形状上证明不了是假的 |

现行规范 [GitHub CI 与质量门禁设计](../execution/specs/2026-09-03-github-ci-quality-gates-design.md#security-and-exceptions)规定“例外仅限经过审阅的合成测试样例，真实凭据泄漏不可豁免”。

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-04，剩下 23 条怎么处理时选择：“扩展放行机制”。
- 2026-11-04：“我同意你花钱去审放行机制方案。”（OpenCode 上两个模型两轮审方案，共花 0.26 美元。）
- 2026-11-04，问 Bark 那两条是否是真在用的设备密钥时：“确认不是真密钥”。
- 2026-11-04，问改动放在哪个 PR 时：“单开新 PR”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 所有者批准清单的每个 `secret` 条目可以带 `classification` 字段，放行时按它核对；不写时仍按原来的“启动令牌”核对，所以已批准的旧清单不受影响。同一个值（同路径、同规则、同摘要）的所有条目必须写同一个分类。
2. 新增 6 种核对方式，每种都要求命中值的 SHA-256 等于条目摘要、并且在该行里只出现一种这样的值：

   | 分类 | 核对什么 |
   | --- | --- |
   | `public-test-vector` | 摘要登记在 `ci/public-test-vectors.json`（每行写摘要、适用规则、出处 URL 和行号、说明），且规则在登记的规则里。表从被批准的提交里读，改表要随清单一起被批准 |
   | `machine-baseline-fixture`（扩展） | 机器扫描基线 `scripts/machine-secret-scan-baseline.json` 里有同文件、对应规则（`jwt`↔`jwt-token`、`github-pat`↔`github-token`、`curl-auth-header`↔`authorization-bearer`）、次数为 1 的已批准条目，且摘要相同或理由里写着这个值 |
   | `git-object-id` | 行是 `"带目录的路径": "40 位十六进制"`，且 `git cat-file -t` 证明这个值是仓库里的文件对象 |
   | `archived-file-digest` | 行是 `"文件名": "64 位十六进制"`，且同目录 `raw-logs.tar.gz` 里同名文件的 SHA-256 正好等于它 |
   | `numeric-option` | 值是“小写名字=纯数字” |
   | `thread-id` | 值是紧跟在 `thread:` 后面的 UUID；单独的 UUID 不放 |

3. 新增 `owner-confirmed-revoked`：只给形状证明不了、但所有者确认不是真密钥或已作废的值。限制是只许 `generic-api-key` 规则、只许历史、文件在被批准的提交里已经删除；本次只用于 Bark 那两条。
4. 只登记历史：上面 7 种分类的值，如果文件在被批准的提交里已经删除（`git ls-tree` 找不到该路径），可以只有历史条目、没有当前条目；文件还在时仍然必须有当前条目。原有 5 种分类不允许只登记历史。
5. 同一文件里当前有多处相同的值时，清单可以写多条当前条目，合并成一条放行，行号逐个核对。
6. 放行路径原来只许测试目录；只对 `git-object-id` 和 `thread-id` 两类另外放开 `.agents/tasks/` 和 `scripts/operations/`。
7. 其余规则不变：批准评论最长 30 天、清单字节摘要、所有者身份、次数不得扩大、历史行号不得变化。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

| 方案 | 好处 | 代价 | 结论 |
| --- | --- | --- | --- |
| 按内容证明的分类，加一个最窄的所有者确认（本决定） | 23 条中 21 条有机器能核对的证明 | 代码多了约 170 行；Bark 两条只能靠所有者的话 | 采用 |
| 按 GitHub 令牌末 6 位校验码判断评测数据里的令牌是假的 | 不用登记 | GitHub 官方没写校验码覆盖令牌哪一段，算错会把真令牌放过 | 不采用（OpenCode 两个模型也都反对） |
| 一个通用的“所有者说了算”分类，覆盖全部 23 条 | 代码最少 | 违反规范“真实凭据不可豁免”，什么都能放 | 不采用 |
| 用 Gitleaks 的 `.gitleaksignore` 按指纹忽略 | 官方功能 | 官方标为实验功能；仓库有意关闭了这条路（`check-security.mjs` 传 `--gitleaks-ignore-path` 指向不存在的文件），忽略文件不经过所有者批准 | 不采用 |
| 保持失败，等改写 Git 历史 | 不放任何值 | 改写已推送的历史在本项目禁止；main 一直红 | 不采用 |

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- main 上 23 条原先放不了的命中都有了对应分类；全部放行的效果由 Hermes 上用真实 Gitleaks 跑的完整安全检查验证（证据写在提交说明里）。
- 每种分类都有放行和拒绝两种测试，在 `test/tooling/security-exception-classes.test.mjs`：例如表里没有的值、规则对不上的基线值、不是仓库对象的 40 位十六进制、压缩包里算不出的摘要、带字母的“数字”、不带 `thread:` 的 UUID、文件还在时只登记历史、`owner-confirmed-revoked` 用在别的规则或当前文件上，都必须被拒绝。清单解析的合并规则在 `test/tooling/security-review.test.mjs`。
- `owner-confirmed-revoked` 是对规范“真实凭据不可豁免”的明确例外：它依据所有者的确认，不是机器证明。范围限死在“已删除文件的历史、通用规则、逐条精确匹配、30 天到期”。规范第 7 节同步写明。
- `public-test-vector` 的表可能被人塞进真密钥的摘要；表只存摘要不存值，每行要有出处 URL 和行号，改表的提交要随清单一起被所有者批准。
- 机器扫描基线的理由文字从此也是证明的一部分：改理由文字等于改放行范围。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md#security-and-exceptions]
- [SOURCE: docs/adr/0157-gitleaks-allowlist-for-evidence-digests.md]
- RFC 8291：<https://www.rfc-editor.org/rfc/rfc8291.txt>（第 422、648 行是示例认证密钥）
- GitHub 令牌格式：<https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/>（“A 32 bit checksum in the last 6 digits of each token”，未写校验范围）
- GitHub 密钥扫描告警的关闭理由：<https://docs.github.com/en/rest/secret-scanning/secret-scanning>（`resolution` 可选 `false_positive`、`wont_fix`、`revoked`、`used_in_tests`）
- Gitleaks 8.30.0 README：<https://github.com/gitleaks/gitleaks/blob/v8.30.0/README.md>（`.gitleaksignore` 按指纹忽略）

[↑ 返回阅读导航](#contents)
