# PR 266 第 2 轮：逐条判断

只跑 DeepSeek，结果 ok。有中、高严重度的“会出错”意见（D1、D2、D3），这一轮算没过，修改后再复核一轮。

| 编号 | 判断 | 严重度 | 依据或修法 |
|---|---|---|---|
| D1 | 会出错 | 中、高 | 已核实：`ReleaseWalkthroughTest` 的夹具只 `git init` 加空提交，没有 `package.json`。这个测试文件不在 `npm run check` 里，所以第 1 轮的完整检查没发现。修法：夹具写一个 `package.json`；新增用例，删掉它后 `--preflight` 和正式运行都以 3 退出并报 `SOURCE_TREE_EMPTY` |
| D2 | 会出错 | 中、高 | 只读 `const originals = {` 到 `};` 那一块；块里同名两次报 `PROBE_BOOTSTRAP_DUPLICATE_NAME`；找不到这一块报 `PROBE_BOOTSTRAP_DIGESTS_NOT_FOUND`。补用例：块外的同名指纹不算；同名两次；没有这一块 |
| D3 | 会出错 | 中、高 | 记录里的 `built` 必须符合上线包检查用的 `[a-z-]+\.js`，否则报 `PROBE_SOURCES_RECORD_INVALID`；bootstrap 里出现怪名字但记录没有它时，仍报 `PROBE_SOURCE_UNLISTED`。这样仓库检查接受的名字，上线包检查都能核对 |
| D4 | 会出错 | 低 | `bootstrap` 固定为探针的那个路径；`source` 必须在 `packages/runtime-sandbox/src/` 下、不含 `..`；读文件前用 `lstat` 要求是普通文件，软链接和目录都报 `*_UNREADABLE` |
| D5 | 会出错 | 低 | 同 D4 的修法；补用例：源码路径是目录时报 `PROBE_SOURCE_UNREADABLE` |
| D6 | 会出错 | 低 | 检查通过时也打印 `PROBE_SOURCES_NOTE`，提醒构建指纹只由 Hermes 上的上线包检查和真实构建比对；补用例 |
| D7 | 会出错 | 低 | I-79 门槛说明改成只查 `package.json`、其他文件被删查不出 |
