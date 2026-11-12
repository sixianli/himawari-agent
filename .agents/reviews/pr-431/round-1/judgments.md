# PR 431 第 1 轮逐条判断

## DeepSeek

1. 高：扫描结果减少，`ci/security-exceptions.json` 没同步，台账逐条比对会报 `PUBLIC_FIXTURE_FINDINGS_CHANGED`。成立，会出错，中高。实测复现：用改前、改后两版 `findBuildSecrets` 扫已安装的依赖文件，正好 5 条（pi-coding-agent 的 docs/custom-provider.md、docs/extensions.md、docs/mcp.md、两个 examples/extensions/*/index.ts）改前和台账一致、改后命中为 0。修法：删掉这 5 条，并在 `test/tooling/security-published.test.mjs` 加一条用真实台账和已安装文件逐条比对的测试；用改前的台账跑，该测试失败，改后通过。
2. 中：`$` 开头全大写的真实值会被放过。成立，会出错，中高。修法：正则收紧到和 gitleaks 默认配置的全局放行规则一样，名字只允许大写字母和下划线（`^\$(?:[A-Z_]+|\{[A-Z_]+\})$`），不允许数字；`$ABCDEFGHIJKL1234`、dotenv 里的同样值、拼接成 `$ABCDEFGHIJK1` 的源码都改为照报，加了用例。只由大写字母和下划线组成的值仍放行，这和 gitleaks 的取舍相同。
3. 低：用例没覆盖 dotenv、源码里的 `${NAME}`、source map、真实台账。成立，会出错，低（漏的是测试覆盖，不是行为）。已补 dotenv、源码 `${NAME}`、sourcesContent 三条正向用例和真实台账比对测试。
4. 低：第 53 行注释和实现不一致。成立，可以更好（只动注释）。按项目规则删掉了这个文件里的两处注释。

## GLM

1. 高：同 DeepSeek 1。成立，同上处理。
2. 低：同 DeepSeek 2。成立，按中高处理（取两个模型中较高的），同上处理。
3. 低：同 DeepSeek 3。成立，同上处理。
4. 信息：没找到 CI 扫 `docs/pi-development-guide.md` 的入口。不成立：这一条只说明它没找到调用入口，不指出错误；误报由协调者从 CI 日志转来，这次修复改的是共用的 `credential` 判断，修好后用新规则扫这一行结果为空（已运行）。
5. 信息：brief 在 diff 里显示成二进制。不成立：文件是 UTF-8 中文文本，`file` 命令识别为 UTF-8 text，git 的显示只与属性设置有关，不影响内容。
6. 冻结证据里的旧哈希。不成立：这些是历史资格验证记录，GLM 自己也没找到把它们和 HEAD 比较的门槛；本 PR 不涉及资格验证。
