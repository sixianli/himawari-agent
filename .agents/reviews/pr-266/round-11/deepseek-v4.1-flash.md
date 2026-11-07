# 复核结论（4d212584..51f8d142，基准 bc380a6e）

**未发现需要修改的高、中严重度问题。作者关于本轮增量的三条说法，经代码核对全部成立。**

## 按严重度排列的问题

### 低（信息，可不改）
- **文件:行**：`test/tooling/run-all-checks.test.mjs:55-57` 与 `package.json:37`
- **问题**：`check:probe-sources` 的完整命令原文在两处逐字重复。
- **证据**：
  - 测试：`expect(manifest.scripts["check:probe-sources"]).toBe("node scripts/check-probe-sources.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/probe-sources.test.mjs")`
  - 清单：`"check:probe-sources": "node scripts/check-probe-sources.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/probe-sources.test.mjs"`
- **建议**：保持现状。这正是第 10 轮 D1 要的效果，也与 main 对 5 个上线测试的写法一致；改成只断言前缀会重新引入“改成 `true` 也不失败”的漏洞，不建议。

### 低（信息，未核实项）
- **文件:行**：`test/tooling/probe-sources.test.mjs:57-59`
- **问题**：`passes on the repository as committed` 依赖 `probe-sources.json` 里的源码哈希与当前三个 `.ts` 文件一致；本次受限环境无法重算 SHA-256。
- **证据**：`expect(probeSourceProblems(repository)).toEqual([])`；`git log -- packages/runtime-sandbox/src/job-host-main.ts ...` 最后一次变更是 `12c8bfb7`，而记录由 `ea9f89ef` 引入、在其之后；`bootstrap.mjs:11-13` 与 `probe-sources.json:5-19` 的三个 build 摘要逐字相同。
- **建议**：无需改；仅标明“源码哈希当前性”未在本次复核中实际执行验证。

## 读代码证实的

1. `894cb9cb` 只改 `.agents/reviews/pr-266/usage.jsonl`（`git show --stat`：1 file changed）。
2. `269d4436` 是合并提交，父提交为 `894cb9cb` 与 `bc380a6e`，与作者说法一致。
3. **合并未丢步骤**：`package.json:27` 的 `check:steps` 恰为 main 的 39 步插入 `check:probe-sources`（位于 `check:srt-version` 之后、`check:settings-scope` 之前），共 40 步、名称无重复；逐项与 `bc380a6e:package.json` 对比，main 的 4 个交付测试步骤（`delivery-deploy/rollback/cleanup/untested-claims`）全在。
4. **合并未丢断言**：最终测试文件包含 main 原有的 5 个 Python 测试循环（`test/tooling/run-all-checks.test.mjs:58-67`，与 `bc380a6e` 版本逐行一致），并新增 `check:probe-sources` 的 `toContain` 与 `toBe`（`:54-57`）。相对 `bc380a6e` 的 diff 仅新增这 4 行，无删除。
5. **命令原文逐字一致**：测试第 56 行与 `package.json:37` 完全相同。
6. **反向用例有效**：把 `check:probe-sources` 改成 `true` 时 `toBe` 必失败；从 `check:steps` 删掉时 `toContain` 必失败。`stepNames`（`scripts/run-all-checks.mjs:8-10`）的正则 `^npm run (\S+)$` 能接受 `check:probe-sources`。
7. **新标识符的消费端都接受**：`check:probe-sources` 键仅被 `check:steps`、`run-all-checks.test.mjs` 使用（grep 全仓确认），均存在且校验通过；`probe-sources.json` 字段仅被 `check-probe-sources.mjs` 消费，两端口径一致。
8. **记录路径安全**：`check-probe-sources.mjs:40` 要求 `source` 等于 `packages/runtime-sandbox/src/` 加 `built` 去掉 `.js` 加 `.ts`，且 `built` 受 `:9` 的 `^[a-z-]+\.js$` 约束，杜绝 `..`/绝对路径/子目录；`:25` 用 `lstat` 拒绝目录与符号链接。
9. **错误路径齐全**：缺记录/不可读/JSON 错/缺 bootstrap/缺源码/目录/格式错/重复/块外条目/CRLF 均有分支与用例（`check-probe-sources.mjs:32-52,54-75,77-127`；`probe-sources.test.mjs` 大量反向用例）。
10. **文档与代码一致**：`docs/incidents-and-gates.md:117-118` 的 I-79/I-80 与 `check-probe-sources.mjs`、`run-release-walkthrough.sh:22-23`、`test_make_packet.py:787-793` 相符；新增行能通过 `check-incident-gates.mjs:48-70` 的 id/日期/次数/状态/路径存在性校验（引用的仓库路径均存在，状态“已落门槛”且有路径）。

## 推测 / 未核实

- **未核实**：Hermes 上 `npm run check` 40 步全过、5 个用例全过、Biome 通过——受工具限制不能运行，仅能从断言逻辑判断。
- **未核实**：三个 `.ts` 文件当前哈希与记录逐字相等——无法在本环境哈希；仅由 git 历史与 bootstrap/record 摘要一致推断风险很低。
- **推测**：`269d4436` 的冲突确只在 `package.json` 与 `run-all-checks.test.mjs`——合并 diff 还带入 `test/tooling/artifact.test.mjs`、`scripts/delivery-mode/test_rollback.py` 等，但它们是 main 侧新增而非冲突；已读的最终文件无冲突标记。

## 侧重检查

- **错误路径**：逐条走查 `check-probe-sources.mjs` 的 missing/unreadable/invalid/格式错/重复/块外/缺源码分支，全部有确定返回且测试覆盖；未发现崩溃路径（`null`/数组/非对象记录均被 `record?.` 与类型判断挡住）。
- **不合规范或不可信输入**：记录为仓库内受控文件，仍对 `built`、`source`、bootstrap 路径做了白名单式约束，未发现越界读写。
- **安全**：`lstat` 拒绝符号链接/目录；路径由常量前缀拼接，无注入面；CLI 的 `argv[2]` 根目录仅用于测试。
- **资源耗尽**：只读少量小文件，正则线性，无循环放大；`mkdtemp` 仅在测试中并用 `afterEach` 清理。
- **不可撤销操作**：无。
- **规则/文档/代码一致性**：I-79/I-80 与实现、测试一致；仓库内未找到 `.claude/rules/prompt-prefix.md`（glob 无结果），其原文**未核实**，但本改动不触及模型输入，见必答 1。

## 必答问题

1. **是否改变模型已见过的请求开头？** 否。本次增量只涉及 `package.json` 的检查接线、`scripts/check-probe-sources.mjs`、`test/tooling/probe-sources.test.mjs`、`test/tooling/run-all-checks.test.mjs`、`scripts/delivery-mode/probe-sources.json`、`test_make_packet.py`、`run-release-walkthrough.sh`、`docs/incidents-and-gates.md` 及复核账本；未改系统提示、工具定义、历史消息或遮盖逻辑。发给模型的内容仍是只追加，本轮新增的值（SHA-256、清单键）不进入任何请求；每轮会变的值不在请求里。依据的规则文件在仓库内不存在，标**未核实**，但从改动面看结论不依赖该文件。
2. **同一段文字是否会在不同请求里变成不同字节？** 否。新增值均为文件字节的 SHA-256 十六进制与固定顺序的清单；无时间字段、无无序集合参与输出；错误信息由输入确定。测试中的 `mkdtemp` 随机目录只用于夹具，不进入任何模型请求。
3. **是否有对应自动检查，反向用例真会失败？** 有。`run-all-checks.test.mjs:55-57` 的 `toBe` 对完整命令，改成 `true` 必失败；`:54` 的 `toContain` 对缺失步骤必失败。`probe-sources.test.mjs` 对每一类损坏记录都有反向断言。执行层面的“全过”**未核实**（不能运行）。
4. **每个产生/修改的值，所有使用处都能接受吗？** 是。逐个核对：`check:probe-sources` 键→`run-all-checks.mjs:8-10` 的正则与 `manifest.scripts[name]` 查询均接受；`check:steps` 新 token→同上；记录字段→唯一的 `check-probe-sources.mjs` 校验与生产格式一致；文档 I-79/I-80→`check-incident-gates.mjs` 的 id/日期/次数/状态/路径校验均通过。未发现“清单项过不了后端校验”式的断链。
