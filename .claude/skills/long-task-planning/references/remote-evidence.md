# 在别的机器上跑测试并记录证据

返回 [SKILL.md](../SKILL.md#recording-evidence)。写简报时，把[可直接贴进简报的步骤](#可直接贴进简报的步骤)整段复制过去，再把尖括号里的占位换成实际值。

- [什么时候需要](#什么时候需要)
- [占位说明](#占位说明)
- [可直接贴进简报的步骤](#可直接贴进简报的步骤)
- [记录后检查](#记录后检查)
- [命令检查和环境检查](#命令检查和环境检查)

## 什么时候需要

测试不在记录证据的这台机器上跑，例如项目规定测试只在某台测试服务器上跑。`longtask.py` 要证明“测的正是这份代码”，靠的是代码指纹：参与计算的全部文件内容合起来算出的一个哈希值（任何一个文件内容变了，它就跟着变）。所以指纹必须在测试机上算，时间点是同步代码之后、开始跑测试之前。

下文的“本机”指有任务目录 `.agents/tasks/<任务名>/`、负责记录证据的那台机器；“测试机”指实际跑测试的机器。

## 占位说明

| 占位 | 含义 | 例子 |
| --- | --- | --- |
| `<主机名>` | 完成条件里 `host` 写的名字，不是机器的真实主机名 | `cloud` |
| `<脚本副本>` | 测试机上 `longtask.py` 的副本，放在任务自己的目录里 | `/srv/test/round2/tools/longtask.py` |
| `<检出目录>` | 测试机上的代码目录 | `/srv/test/round2/repo` |
| `<证据目录>` | 检出目录之外，放指纹文件和测试报告的目录 | `/srv/test/round2/evidence/run-1` |
| `<测试命令>` | 跑测试的命令原文，要能输出 JSON 或 JUnit XML 报告（JUnit XML 是多数测试工具都能输出的通用报告格式） | `npx vitest run --reporter=json --outputFile=<证据目录>/unit.json` |
| `<执行人>` | 跑测试的那个 agent 的名字，记进证据的 `by` 字段 | `helper-agent` |
| `<本机脚本>` | 本机的 `longtask.py`：本 skill 目录（`SKILL.md` 所在的目录，agent 加载 skill 时会告诉它）下的 `scripts/longtask.py`，写绝对路径 | `<skill 目录>/scripts/longtask.py` |

## 可直接贴进简报的步骤

```markdown
### 在测试机上跑测试并记录证据

1. 第一次用时，把本机的 longtask.py 复制到测试机的 `<脚本副本>`。它只需要 Python 3.10 以上，不依赖第三方库。本机的脚本更新后要重新复制。
2. 每次同步代码后、跑测试前，在测试机上算代码指纹：
   `LONGTASK_HOST=<主机名> python3 <脚本副本> --repo <检出目录> fingerprint --json > <证据目录>/fp.json`
   - 指纹文件和测试报告都写在检出目录之外，或写进 git 忽略的目录：检出目录里多出来的新文件会被算进指纹。
   - 检出目录里有任务目录 `.agents/tasks/<任务名>/` 时，脚本自己读 items.json 里的 `fingerprint.include`（只让这些路径参与指纹计算）和 `fingerprint.exclude`（不参与指纹计算的路径），不用加参数。没有任务目录时，`fingerprint.include` 里的每一项都要加一个 `--include <路径前缀>`，`fingerprint.exclude` 里的每一项都要加一个 `--exclude <路径前缀>`，放在 `fingerprint` 后面。`fingerprint.test_exclude` 不影响指纹，不用加。
   - 检出目录里有多个进行中的任务时，加 `--task <任务名>`。
3. 跑测试，把 JSON（Vitest 这个 JavaScript 测试框架用 `--reporter=json`）或 JUnit XML 报告写到 `<证据目录>`：`<测试命令>`。
   - 让测试命令自己跑完再停，不要中途终止：记录证据需要完整报告。
   - 有失败也保留报告，照实记录，不重跑、不挑结果。
4. 把 `<证据目录>` 里的 fp.json 和报告带回本机，逐份记录（JUnit 报告把 `--vitest` 换成 `--junit`）：
   `python3 <本机脚本> record --vitest <报告> --fingerprint-file <fp.json> --by <执行人> --ran "<测试命令>"`
5. 在停止文件里列出每条记录的证据编号，即 `record` 输出里的 `E…`。不要改任务目录里的 goal.md、items.json、plan.md。
```

## 记录后检查

运行 `status`。测试机的指纹和本机不同时，这些记录显示“旧版本验证过”，意思是测试机测的不是本机这份代码。找出不同的文件：在两台机器上分别运行 `python3 <脚本> --repo <目录> fingerprint --list > <文件>`，带回同一台机器后用 `diff` 比较。常见原因：

- 同步时漏了文件，或测试机上多了未提交的新文件；
- 测试机没有任务目录，又漏加了 `--include` 或 `--exclude`，两边算指纹的路径不一样。这时 `status` 会直接写“记录时的指纹范围（…）和现在的设置（…）不同”；
- 在测试机上改过代码。代码只在本机改，再同步过去。

## 命令检查和环境检查

在测试机上跑的命令检查（完成条件里 `"type": "command"` 并写了 `host`）也用同一个指纹文件记录：

`python3 <本机脚本> record --command "<命令原文>" --exit-code <退出码> --fingerprint-file <fp.json> --by <执行人>`

带 `"scope": "environment"` 的环境检查只看主机和记录时间，和代码版本无关，但记录时同样要给指纹文件，因为主机名从指纹文件里读。
