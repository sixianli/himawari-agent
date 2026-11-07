# 第 3 轮复核：线程逐条判断

复核提交 `4baa6ba3`，增量从 `67684cdb` 起，只跑 DeepSeek（0.0222 美元），账本累计 0.4545 美元。四条都是低严重度的“会出错”，照常修改、补测试，用 `--accept-low 3` 记账，不再复核。

## 会出错（已改）

| 严重度 | 意见 | 改法 |
|---|---|---|
| 低 | 改名检查要求 `import`/`export` 后面有空白，`import{名字 as 别名}` 认不出 | `import`/`export` 后面的空白改成可有可无；补用例 |
| 低 | 子目录里有悬空软链时 `statSync` 抛 ENOENT，整个 `packages` 或 `apps` 被静默跳过 | 只在顶层目录不存在时跳过（先 `existsSync`），扫描中的任何错误照常抛出；补用例：`apps` 是文件时抛错 |
| 低 | “文件路径为空时报错”“非 ENOENT 照常抛出”没有用例 | 补进同一条新用例 |
| 低 | `npm run check` 只跑脚本，不跑这份测试，反向用例不在快速模式门槛里 | `check:egress-redaction` 在脚本之后接着跑这份测试 |

花括号里带注释的改名（`import { /* } */ 名字 as 别名 }`）不处理：项目禁止代码注释，格式化后也不会出现这种写法。

反向验证：换回 `4baa6ba3` 的脚本，新用例“catches renamed imports without spaces, rows without a file, and unreadable trees”失败（22 条里 1 条失败）；换回新脚本 22 条全过。
