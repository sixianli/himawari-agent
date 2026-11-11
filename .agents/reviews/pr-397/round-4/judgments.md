# 第 4 轮复核判断（DeepSeek）

本轮没有中、高的“会出错”意见，五条都判为低，用 `--accept-low 4` 记账。

- ds-1（中，成立，判低）：现在的参数解析是对的，缺的是从命令行入口走的用例。补了 `gate-lifecycle.test.mjs` 用例：`--artifacts omit` 成功且没有归档、`drop` 退出 1、quality 模式带 `--artifacts ""` 退出 1 且不产生输出。
- ds-2（低，成立）：quality 模式改成 `!== undefined` 判断。反向验证：改回真值判断后上面的用例失败。
- ds-3（低，成立）：ADR 第 4 条改成“只对 `ci.yml` 生效的硬规则；`main.yml`、`quality.yml` 另有自己的检查”。
- ds-4（低，成立）：ADR 写明发布出的 `result.json` 的 `artifacts` 仍列出归档、文件不随报告上传；仓库里没有读它的地方。
- ds-5（低，成立）：重装用例断言预置的运行目录 `43003101968-1` 仍在；回滚用例的期望表补上这一项（应为不存在）。fake `install` 不校验属主，属主由真机 INSTALL_OK 验证过（2026-11-11 Andy 在 CI VPS 上安装成功）。
