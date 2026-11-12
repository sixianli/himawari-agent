# PR 431 第 2 轮作者说明

第 1 轮两个模型都指出两处问题，判断和修法见 `.agents/reviews/pr-431/round-1/judgments.md`：
- 台账 `ci/security-exceptions.json` 里有 5 条 published-synthetic-fixture 只登记了环境变量引用，规则改后命中为 0，会报 `PUBLIC_FIXTURE_FINDINGS_CHANGED`。已删掉这 5 条，并在 `proposal.reviewEvidence` 末尾记录原因。
- 正则允许数字会放过 `$ABCDEFGHIJKL1234`。已收紧为 `^\$(?:[A-Z_]+|\{[A-Z_]+\})$`，和 gitleaks 默认配置全局放行规则 `^\$(?:[A-Z_]+|[a-z_]+)$`、`^\${(?:[A-Z_]+|[a-z_]+)}$` 的大写部分一致（https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml）。
- 新增 `test/tooling/security-published.test.mjs` 的“真实台账和当前扫描规则一致”：用真实台账和已安装的依赖文件逐条核对文件摘要和命中。补了 dotenv、源码 `${NAME}`、sourcesContent 的正向用例和三条反向用例。删掉了 `security-source.mjs` 里的两处注释（项目规则不写注释）。

已知限制：台账在 CI 里从 base 分支读取（`loadReviewedExceptions` 用 `git show baseSha`）。所以这个 PR 自己的 CI 仍按 main 的旧台账核对，那 5 条会报 `PUBLIC_FIXTURE_FINDINGS_CHANGED`；合并后 main 上一致。这和加例外时的情况一样，是台账从 base 读取的设计决定的。

请核对：
1. 这个改动会不会改变模型已经见过的请求开头？
2. 删掉的 5 条是否正好是改后命中为 0 的那些，有没有误删或漏删；JSON 其他内容是否没变。
3. 新正则还有没有放过真实密钥的情况；收紧后会不会让台账里其他条目或仓库里其他文件出现新的命中，导致 CI 变红。
4. 真实台账比对测试在 CI 的 Linux 机器上能不能稳定运行（文件路径映射 `runtime/` 前缀去掉、可选依赖、平台相关的二进制）；它失败时是否能指出是哪一条。
5. 上面的已知限制有没有更好的办法，而不削弱“例外只能来自 base”这条安全约束。
