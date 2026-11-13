# PR 440 第 1 轮代码复核：逐条判断

| 编号 | 模型 | 意见 | 判断 | 处理 |
| --- | --- | --- | --- | --- |
| ds-1、glm-1 | DeepSeek、GLM | 清单没有“固定主机名”一类，和 ADR 0253 不一致 | 成立，会出错，中 | 加 `fixed-hostname` 类：和 `hostname()`、`gethostname()` 比较的字符串字面值；模板占位符 `__PKT_` 开头的不算 |
| ds-2、glm-2 | DeepSeek、GLM | 没扫 `.github` | 成立，会出错，中（GLM 判低） | 扫描目录加 `.github`；仓库里没有 Dockerfile 和 Makefile，无扩展名文件不扫 |
| ds-3 | DeepSeek | `arch: "x64"`、`amd64`、引号里的 `lib64`、大写 `X86_64` 认不出 | 成立，会出错，中 | 四种写法都加进模式，补用例 |
| ds-4 | DeepSeek | ADR 写的是“白名单 + 取真实路径”，实现是按文件计数 | 成立，会出错，低 | 改 ADR 0253 的说法，写明按次数比、同文件删一处加一处发现不了；重跑 plan-claims |
| ds-5、glm-3 | DeepSeek、GLM | 入口退出码和 `--write` 没有测试 | 成立，会出错，低 | 导出 `runPlatformAssumptionsCheck`，补退出码、清单缺失或非法、`--write` 字节稳定三个用例 |
| ds-6 | DeepSeek | `--write` 不打印改了什么 | 成立，可以更好 | 已改：逐条打印 `PLATFORM_ASSUMPTIONS_CHANGED` |
| glm-4 | GLM | 方案讨论记录内容没核到 | 不成立 | 记录在提交里，复核副本按设计不含记录目录 |
