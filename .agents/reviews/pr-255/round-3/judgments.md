# 第 3 轮复核：线程逐条判断

复核提交 `a253b15f`，增量从 `8e378395` 起。DeepSeek 0.0701 美元，GLM 0.0539 美元；这个 PR 的复核累计 0.3442 美元。

第 1、2、3 轮都有“会出错”的意见，按 `model-review.md` 第 4 步，这是连续三轮没过：第 3 轮的“会出错”意见先改了，**改完不再复核**，停下报告 Andy。

## 会出错（已改，未复核）

| 来源 | 意见 | 依据 | 改法 |
|---|---|---|---|
| DeepSeek | 代理地址前面带空格或不写协议头（`u:p@host`）时，带账号密码的检查漏掉 | 正则从第 0 个字符起要求 `协议://` | 去掉首尾空白后判断，协议头可有可无 |
| DeepSeek | 账本最后一行没有换行时，例外记录会接在上一行后面，把账本写坏 | `appendFileSync` 直接追加 | 末尾没有换行时先补一个 |
| DeepSeek | 规则文件写“只改了记录目录”，代码只认本 PR 的记录目录 | `changedOutside` 只排除 `pr-<编号>/` | 规则文件改成“本 PR 的记录目录” |
| DeepSeek、GLM | `nextRound` 仍把例外记录算成第 1 轮，和规则文件“例外记录不算进任何一轮”不一致 | `nextRound` 没过滤 | 过滤 `mode=override` |
| DeepSeek | 例外原话里的换行会在输出里伪造出固定格式的一行（例如 `REVIEW_CURRENT`） | 原话原样拼进输出行 | `--accept-unreviewed`、`--andy-quote` 含换行时拒绝 |
| DeepSeek | 账本记录缺 `head` 等字段时报错不清楚 | `parseUsage` 只校验 `cost`、`round` | 复核记录缺 `head`、`model`、`outcome` 时报 `USAGE_LEDGER_INVALID` |
| DeepSeek（推测） | 非 ASCII 文件名会被 git 加引号，认不出记录目录 | 拿不准按会出错；补的测试在不加 `-z` 时确实失败，推测成立 | `git diff -z` |
| GLM | 规则文件说“缺失、读不出时重装”，代码只在复用已有安装时重装；说“账号密码”，代码只要 `@` 前有内容就拒 | 对照 `installOpencode`、`proxyCredentialProblems` | 规则文件改准 |

每条代码修改都做了反向验证：撤掉修复时对应测试失败。

## 不成立

| 来源 | 意见 | 依据 |
|---|---|---|
| DeepSeek | 作者说法“核对已装的每个包的 sha512”不准确 | 是给模型的材料里的说法不准；规则文件第 1 轮已改准，没有新证据 |
| DeepSeek（推测） | Windows 的 `core.autocrlf` 会让 `--round` 误判提示词不同 | 这个脚本只在 Linux 和 Mac 上用（项目不在 Windows 上运行） |
| DeepSeek（推测） | `npm ci` 拿着完整环境运行安装脚本 | 装的包都由锁文件的 sha512 固定，防恶意依赖不在 Andy 2026-11-03 定的范围内；这段不在本 PR 改动的威胁面里 |
| GLM | 换了脚本版本后，旧轮次用 `--round` 重跑会因提示词不同被拒 | 提示词确实变了，拒绝是对的 |

## 可以更好

本轮没有。
