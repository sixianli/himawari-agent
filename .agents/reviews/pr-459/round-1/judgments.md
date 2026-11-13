# PR 459 第 1 轮逐条判断

1. `linux-arm64` 过不了证据 schema（模型：高）。成立，低：后果是报错拒绝，不会放过检查。已改成明确拒绝：新增 `artifactPlatformKey`，`run`、`build`、`browser`、`test` 用它，`local` 在 build、coverage 和不带参数时先拒绝，报 `CI_ARTIFACT_PLATFORM_UNSUPPORTED: linux-arm64`。
2. ARM 上 `local` 的 build 测试用假执行函数掩盖了真实行为（模型：中）。成立，中：测试给出了和真机相反的结论。已改：那条用例只跑 policy、static、security，并断言另外三种情况被拒绝、一次命令都不执行。
3. actionlint 和 gitleaks 的 linux-arm64 条目写反查不出来（模型：中）。成立，低：要人为写反，结果是检查失败。已改成按工具和版本给出确切文件名，三个平台都查。
4. 文件名规则只管 linux-arm64（模型：中低）。成立，低。已改：三个平台都有规则，没有规则的平台直接失败。
5. 只校验了 Semgrep wheel 的版本（模型：低）。成立，低。已改：文件名由 `version` 字段拼出，对不上就失败。
6. `run.mjs` 给读入的产物贴主机平台（模型：低）。不成立：`run.mjs` 要求 `producer.matrixKey` 等于主机平台，否则拒绝，两者总是相同。

第 2 条是中，所以对修改再复核一轮。
