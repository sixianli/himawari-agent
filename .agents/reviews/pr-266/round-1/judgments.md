# PR 266 第 1 轮：逐条判断

两个模型都是 ok。有中、高严重度的“会出错”意见（D1、D2、G1），这一轮算没过，修改后用 `--previous` 再复核一轮。

| 编号 | 模型 | 判断 | 严重度 | 依据或修法 |
|---|---|---|---|---|
| D1 | deepseek-v4.1-flash | 会出错 | 中、高 | 只改记录里的源码指纹、不在 Hermes 上构建，检查也会通过。Mac 上不能构建，提交阶段没法核对构建指纹；修法是在刷新提示和 I-78 的“未覆盖”里写明这种做法会让检查失效，要等上线包检查才发现 |
| D2 | deepseek-v4.1-flash | 会出错 | 中、高 | 改用不限文件名、不要求尾逗号的写法从 bootstrap 里找所有 64 位指纹；一个都找不到时报 `PROBE_BOOTSTRAP_DIGESTS_NOT_FOUND`。补用例：名字是 `Sandbox_SDK2.js`、末尾没逗号的未记录条目要报 `PROBE_SOURCE_UNLISTED` |
| D3 | deepseek-v4.1-flash | 会出错 | 低（模型给中） | 多数情况是抛异常、退出码非零；空 `files` 只有 bootstrap 也解析不出摘要时才通过，D2 的修改已挡住。修法：先校验记录，JSON 坏、字段缺、`files` 为空都报 `PROBE_SOURCES_RECORD_INVALID`，补 4 个用例 |
| D4 | deepseek-v4.1-flash | 会出错 | 低 | 改用 `fileURLToPath(import.meta.url)` 和 `path.resolve(process.argv[1])` 比较，和 `scripts/run-all-checks.mjs:40` 一样 |
| D5 | deepseek-v4.1-flash | 会出错 | 低 | 记录里的路径必须落在仓库里，否则报 `PROBE_SOURCES_RECORD_INVALID`；整文件读入不改（三个文件都很小） |
| D6 | deepseek-v4.1-flash | 可以更好 | — | 损坏记录的用例是 D3 的回归测试，已提交；三个源码文件走同一个循环 |
| D7 | deepseek-v4.1-flash | 会出错 | 低 | I-78 门槛说明改成“这三个源码文件任一改动” |
| D8 | deepseek-v4.1-flash | 不成立 | — | `git merge-base --is-ancestor 43423b9e 12c8bfb7` 退出码 0，三个源码文件在 `43423b9e` 和 `12c8bfb7^` 之间没有差异 |
| G1 | glm-5.3-flash | 会出错 | 中、高 | 同 D2 |
| G2 | glm-5.3-flash | 会出错 | 低 | 同 D3 |
| G3 | glm-5.3-flash | 可以更好 | — | 补了命令行用例（坏记录时退出码 1、打印 `PROBE_SOURCES failed`），它在旧代码上会失败，算 D3 的回归测试 |
| G4 | glm-5.3-flash | 会出错 | 低 | 预检加一项：源码检出里必须有 `package.json`，否则报 `SOURCE_TREE_EMPTY`；在 Hermes 上跑过，预检通过 |
