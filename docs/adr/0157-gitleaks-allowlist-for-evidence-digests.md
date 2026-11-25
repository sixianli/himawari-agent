---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amended_by: "docs/adr/0177-gitleaks-exact-value-allowlist.md"
date: "2026-11-04"
covers: "ci/rules/gitleaks.toml, ci/security-exceptions.json, ci/toolchain-lock.json, test/tooling/gitleaks-config.test.mjs"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0157：资格证据里的文件摘要用限定范围的 Gitleaks 白名单放行

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

CI（每次推送后 GitHub Actions 自动跑的检查）的安全检查用 Gitleaks（开源的密钥扫描工具，版本锁定为 8.30.0）扫描当前文件和全部 Git 历史，规则写在 `ci/rules/gitleaks.toml`，原先只启用 Gitleaks 自带的默认规则。

2026-11-04 在 Hermes（家里的 Linux 测试服务器）上按 CI 的方式实际扫描，发现约 500 条命中挡住合并。其中当前文件和历史各有 240 条来自 `test/qualification/evidence/workspace-authorization-lifecycle/`（资格验证留下的证据文件，共 1942 个）。这些行把一个源码路径对应到那个文件的 SHA-256 摘要（一种 64 位十六进制的文件指纹），例如：

```json
"packages/application/src/ports/recent-authentication.ts": "d47160a6…",
```

默认规则 `generic-api-key`（按“附近有 auth、token、key 之类的词，后面跟一串高随机度的字符”来猜密钥的通用规则）看到路径里的 `authentication`，就把后面的摘要当成密钥。摘要不是密钥，泄露它不会给任何人访问权限。

现行规范 [GitHub CI 与质量门禁设计](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md#security-and-exceptions)规定例外只限“经过审阅的合成测试样例”，每条例外要精确到路径、规则、摘要和次数，最长 30 天到期；还规定“不得降低规则、加大范围排除”。给 480 条摘要逐条登记例外，每 30 天还要整批重新审阅，做不下去；而这批命中本身是规则误判，不是需要豁免的测试密钥。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-04，在“改规则”和“逐条登记例外”之间选择时：“我选这一个 改规则： 在 gitleaks.toml 里加白名单，让它不再把证据文件里的摘要当密钥。改动小，但属于改安全规则。”
- 2026-11-04，看过整合后的方案、知道它和规范原文冲突之后：“同意，补 ADR”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 文件摘要这类“规则把非密钥误认成密钥、而且形状固定”的误报，用 `ci/rules/gitleaks.toml` 里的白名单处理；个别具体的值（合成 token、示例密码等）仍按规范走逐条例外。
2. 白名单必须同时满足四个限定，缺一个都不行：
   - `targetRules = ["generic-api-key"]`：只对这一条规则生效。不写这一项的白名单是全局的，Gitleaks 扫当前文件时只要路径对上就跳过整个文件，`condition = "AND"` 不起作用（Gitleaks 8.30.0 源码 `sources/common.go` 的 shouldSkipPath）。
   - `condition = "AND"`：路径和内容两个条件都满足才放行。
   - `paths` 只写出问题的那一个目录，并用 `(?:^|/)` 开头，同时兼容扫当前文件时的绝对路径和扫历史时的仓库相对路径。
   - `regexTarget = "line"`，正则锚定整行，只认 `"带目录和扩展名的路径": "64 位小写十六进制"` 这一种形状。不写 `regexTarget` 时正则只和被认定为密钥的那串值比，永远对不上整行形状。
3. 白名单的效果由 `test/tooling/gitleaks-config.test.mjs` 用锁定版本的真实 Gitleaks 检查：摘要行不报、同目录的真实格式 token 和 `"apiKey": "<64位>"` 照报、同一行混着别的值照报、别的目录的摘要行照报，当前文件和历史两种扫描都检查；另有 4 条用例把白名单分别改成 `OR`、去掉 `targetRules`、去掉 `regexTarget`、路径放宽成 `.*`，每一种都必须让结果变化。
4. 以后别的证据目录出现同类误报，在同一条白名单里加一行路径，并在测试里加对应用例；不得改成按整个目录或整个规则放行。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

| 方案 | 好处 | 代价 | 结论 |
| --- | --- | --- | --- |
| 限定规则、目录、整行形状的白名单（本决定） | 改动小，可审阅，有真实工具测试守着 | 有一处残余风险（见[后果](#consequences)），没有到期日 | 采用 |
| 逐条登记 `ci/security-exceptions.json` | 完全符合规范原文 | 480 条，每 30 天整批续期；语义也不对，例外是给合成测试样例的 | 不采用 |
| 安全检查里逐条核对“这个值等于对应源码文件的 SHA-256” | 几乎没有漏网 | 要在安全检查里新增不少代码；有些证据文件没记录对应的源码提交，核对不了 | 不采用，需要零残余风险时再做 |
| 按目录放行或关掉 `generic-api-key` | 最简单 | 整个目录或整条规则不再检测，真密钥也会漏 | 不采用 |
| 改写证据文件 | 不动规则 | 证据是冻结的历史记录；历史提交里的命中仍在 | 不采用 |

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 当前文件和历史的命中各从约 270–280 条降到 34、43 条，减少的 239 条逐条核对过，全在该目录、全是摘要行，没有新增命中。
- 残余风险：有人把一个真密钥写成“带目录和扩展名的路径: 64 位十六进制”的形状放进这个证据目录，`generic-api-key` 不会再拦它。`scan-machine-secrets.mjs`（项目自带的第二道密钥扫描）对这个目录没有豁免，但它对没有任何前缀的裸 64 位十六进制也不一定能认出。
- 证据目录里还有 1 条摘要的键是不带目录的文件名（`p4-completion-01/archive-readback.json:68`），不符合白名单形状，和其他零星命中一起走逐条例外。这样做是为了不把 `"credentials.json": "<64位>"` 这种写法一起放过。
- 规则文件的摘要锁在 `ci/toolchain-lock.json`，改白名单必须同步更新；证据文件里记录的旧规则摘要是历史快照，不回改。
- 规范的“安全与例外政策”一节同步写明这一类误报的处理方式。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md#security-and-exceptions]
- Gitleaks 8.30.0 官方说明：[README](https://github.com/gitleaks/gitleaks/blob/v8.30.0/README.md)（“The "AND" condition can be used to make sure all criteria match”；`targetRules`：“This will only run on the specified rules, not globally”）
- Gitleaks 8.30.0 源码：[config/config.go](https://github.com/gitleaks/gitleaks/blob/v8.30.0/config/config.go)（带 `targetRules` 的白名单不进全局列表）、[sources/common.go](https://github.com/gitleaks/gitleaks/blob/v8.30.0/sources/common.go)（全局白名单按路径跳过文件）、[detect/detect.go](https://github.com/gitleaks/gitleaks/blob/v8.30.0/detect/detect.go)（`regexTarget` 和 AND 条件的判断）
