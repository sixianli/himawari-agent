## 结论概述

这次增量确实按第 6 轮 D1/D2/D3 的方向改了：`bootstrap` 先归一化换行再按行匹配、要求 `originals` 块存在并区分块外条目、`source` 改为精确路径。核心逻辑与作者说明基本一致，未发现会直接放过 I-78 那类“源码改了、探针没改”的高危缺陷。下面按严重度列出发现；没有发现高/中危问题。

## 发现：读代码证实的

### 1. 低：按行解析仍不完全等价于上线包检查的 Python 读法

- 文件:行：`scripts/check-probe-sources.mjs:52-63`，对照 `scripts/delivery-mode/packet-template/inputs/check-packet-consistency.py:98`
- 问题：Python 的 `re.M` 里 `^\s+` 中的 `\s` 可以吃掉换行符，因此“空行之后、顶格写的条目”也能被 `findall` 找到；新脚本先 `split("\n")` 再对单行匹配，`^\s+` 不能跨行。两边对同一种排版会得到不同结果。
- 证据：

```js
52:   const lines = text.replace(/\r\n?/g, "\n").split("\n");
...
59:     const match = line.match(PACKET_CHECK_LINE);
```

```py
98: originals = dict(re.findall(r'^\s+"([a-z-]+\.js)": "([0-9a-f]{64})",$', bootstrap, re.M))
```

- 具体后果：`};` 之后若有空行、再来一行顶格的 `"evil.js": "hash",`，Python 会把它计入 `originals`，新脚本因该行没有前导空白而忽略它。此时如果记录里没有 `evil.js`，门禁会通过，而上线包检查会在构建产物里找不到它（或摘要不符）而失败。反过来，`originals` 块内出现这种顶格条目时新脚本会报 `PROBE_BOOTSTRAP_ENTRY_FORMAT`（失败关闭），不会放过。
- 建议：要么把匹配改成近似 Python 的跨空行语义（例如在归一化后的全文上用不含 `m`、但允许 `\s*` 跨空行的锚定正则，或把空行后的顶格条目也识别出来再判断内外），要么至少补一条反向用例固定这一差异；作者说“与上线包检查的读法一致”，严格说还不完全一致。

### 2. 低：摘要字段没有先校验字符串类型

- 文件:行：`scripts/check-probe-sources.mjs:40-41`
- 问题：`DIGEST.test(file.builtSha256)` / `DIGEST.test(file.sourceSha256)` 没有先做 `typeof === "string"`。`RegExp.test` 会把值转成字符串，所以 JSON 里的 `["<64位十六进制>"]` 也能通过这里的格式校验，和上下文中 `built`/`source` 的严格类型检查不一致。
- 证据：

```js
35:   const problems = record.files.flatMap((file, index) =>
36:     typeof file?.built === "string" &&
...
40:     DIGEST.test(file.builtSha256) &&
41:     DIGEST.test(file.sourceSha256)
```

- 影响：不会造成假通过——后续 `recorded.get(file.built) !== file.builtSha256` 或 `actual !== file.sourceSha256` 一定不等而报错；但记录校验本身比说明更松。
- 建议：加上 `typeof file.builtSha256 === "string"` 和 `typeof file.sourceSha256 === "string"`。

### 3. 低：部分错误分支和 U+2028/U+2029 没有自动用例；预检测试不在 `npm run check` 里

- 文件:行：`test/tooling/probe-sources.test.mjs:155-162`（CRLF 用例）、`scripts/delivery-mode/test_make_packet.py:783-790`、`package.json:27,37`
- 问题：
  - 作者说“也处理了 U+2028/U+2029”，代码通过“不用 `m` 标志”确实做到了，但没有专门用例固定它；将来有人加回 `m` 时现有测试未必会失败。
  - `PROBE_SOURCE_MISSING`、`PROBE_BOOTSTRAP_MISSING`、`PROBE_BOOTSTRAP_UNREADABLE`、`PROBE_SOURCES_RECORD_MISSING` 这些分支没有对应用例。
  - 新增的 `SOURCE_TREE_EMPTY` 用例在 `scripts/delivery-mode/test_make_packet.py`，而该文件不在 `check:steps` 中（作者已声明这是已知不做，文档 I-79 也写了）。
- 证据：

```js
155:   it("accepts Windows line endings because the packet check reads the file as text", () => {
...
159:       `const originals = {\r\n  "job-host-main.js": "${BUILT}",\r\n};\r\n`,
161:     expect(probeSourceProblems(root)).toEqual([]);
```

```text
package.json:27  "check:steps": ... npm run check:probe-sources ...
package.json:37  "check:probe-sources": "node scripts/check-probe-sources.mjs && vitest ..."
```

- 建议：补 U+2028/U+2029 和缺失文件的用例；如果要让 I-79 的 `package.json` 检查也有自动回归，按 #269 的计划把 `test_make_packet.py` 接进门槛。当前作为“已知缺口”可接受，但需要明确它没有自动运行。

## 发现：推测 / 未核实

- **未核实**：无法运行 `npm run check`，因此“31 个用例全过”“34 步全过”没有实测。仅核对了数量：`probe-sources.test.mjs` 按 `it`/`it.each` 展开正好 31 个；`check:steps` 正好 34 项；`check:probe-sources` 确实在第 31 位，并且被 `test/tooling/run-all-checks.test.mjs:54` 覆盖。
- **未核实**：无法计算 SHA-256，因此记录里的 `sourceSha256` 是否等于当前三个源码文件的实际字节没有验证。可支持的旁证是：三个源码文件最后一次改动是 `12c8bfb7`，早于新增记录的 `ea9f89ef`；记录里的 `builtSha256` 与当前 `bootstrap.mjs` 的三个值逐字相同。
- **未核实**：`.agents/reviews/pr-266/round-6/` 读不了。`git show ad1f2b20:.agents/reviews/pr-266/round-6/judgments.md` 返回 `REVIEW_GIT_REFUSED records-path ...`，所以第 6 轮判定原文未核对。
- **推测**：上面第 1 条的“门禁通过而上线包检查失败”需要特定排版（块外、空行后、顶格条目），实际发生的可能性很低；代码层面的读法差异是确定的。

## 侧重检查

- **记录输入（不可信输入）**：检查了 `recordProblems` 对 `bootstrap`、`files`、`built`、`source`、两个摘要的类型/格式判断；`built` 限制为 `[a-z-]+\.js`，`source` 必须精确等于 `packages/runtime-sandbox/src/<built 改名>.ts`，因此绝对路径、`..`、反斜杠、子目录、其他目录都会被拒（`test/.../probe-sources.test.mjs:177-198` 覆盖）。未发现路径逃逸。
- **文件读取与软链接**：`readPlainFile` 先 `lstatSync(...).isFile()`，最终组件是软链接时判为不可读；中间目录是软链接会跟随（作者已声明不处理，代码确实如此）。
- **Bootstrap 解析错误路径**：无块、空块、块内格式错、块外合法条目、重名、缺逗号、CRLF 都有处理；`outside` 条目同时仍计入 `entries`，与 Python 的全文 `findall` 一致。未发现会放过 I-78 的路径。
- **资源耗尽**：整文件读入 + 线性扫描，没有递归或按输入长度放大的循环；bootstrap/记录/三个源码文件都很小。无不可逆操作，检查只读。
- **文档/说明一致性**：I-78 对 `PROBE_SOURCE_CHANGED`、`PROBE_BUILT_DIGEST_MISMATCH`、`PROBE_SOURCE_UNLISTED` 的描述与代码一致；I-79 的 `SOURCE_TREE_EMPTY` 与 `run-release-walkthrough.sh:23` 一致；两条事故的门槛路径都真实存在（`check-incident-gates.mjs` 会校验并通过）。作者说的“`test_make_packet.py` 不在 `npm run check`”“`check-packet-consistency.py`、`read-driver.mjs` 不改”都与代码/清单一致。
- **错误路径与消息消费**：`SOURCE_TREE_EMPTY` 经 `make-packet.py:574-577` 的通用 `PACKET_HERMES_PREFLIGHT_FAILED` 包装，消费端不依赖具体错误名；`check:probe-sources` 被 `run-all-checks.mjs` 按普通 npm 脚本执行，`&&` 只在该步骤内部。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次 diff 只涉及 `scripts/delivery-mode/**`、`scripts/check-probe-sources.mjs`、`test/tooling/**`、`package.json`、`docs/incidents-and-gates.md` 和复核记录；没有系统提示、工具定义、历史消息、遮盖逻辑或请求组装代码。因此“发给模型的内容只在末尾追加、每轮会变的值在最后一条消息”这一约束没有被改动的代码触碰（依据 `.claude/rules/prompt-prefix.md` 第 4、5、10、11 条）。
2. **不会让同一段文字在不同请求里变成不同字节。** 改动不产生、不序列化任何发给模型的内容；`bootstrapDigests` 的 `\r\n`/`\r` 归一化只用于本地门禁解析，不会进入模型请求。门禁本身的输出顺序也是确定的（常量、线性数组、`Map` 插入顺序），不含时间或无序集合。记录里 `source` 的严格路径也只是门禁消费，不出现在请求里。
3. **核心改动有自动检查，反向用例基本成立；但有缺口。**
   - 有：`npm run check:probe-sources` 是 `npm run check` 的一步（`package.json:27,37`），测试 31 个；新增/改写的 4 个用例是“块外条目报告 `OUTSIDE`”“空 `originals` 块 + 块外条目”“CRLF 接受”“拒绝 `sub/` 源码路径”。
   - 反向用例确实会失败：对照 `b3c34fe` 的脚本，旧实现不会报 `OUTSIDE`（只报 `UNLISTED`）、对 CRLF 报 `PROBE_BOOTSTRAP_LINE_ENDINGS`、`insideSourceDirectory` 会接受 `sub/` 路径，因此这 4 个用例在旧脚本上都会失败——这是读旧脚本推出来的，未实际运行。
   - 缺口：缺 `PROBE_SOURCE_MISSING`、`PROBE_BOOTSTRAP_MISSING/UNREADABLE`、记录缺失的用例；U+2028/U+2029 没有专门用例；`SOURCE_TREE_EMPTY` 的用例所在文件不在 `npm run check` 里（作者已声明）。
4. **产生/修改的值与消费端核对，未发现不兼容。**
   - `probe-sources.json` 的 `bootstrap`/`files[].built`/`builtSha256`/`source`/`sourceSha256`：唯一消费方是 `scripts/check-probe-sources.mjs`；`built` 与 `bootstrap` 的 `originals` 键都用同一个 `[a-z-]+\.js` 约束，和上线包检查的 Python 正则一致；`source` 的精确映射与三个实际文件名一致。
   - `check:probe-sources` 这个 npm 脚本名：被 `run-all-checks.mjs` 的 `stepNames` 接受，并被 `test/tooling/run-all-checks.test.mjs:54` 断言存在；清单里 34 步都能找到定义。
   - `SOURCE_TREE_EMPTY`：由 `run-release-walkthrough.sh:23` 产生，经 `make-packet.py:574-577` 的通用非零退出包装，消费端不解析具体名字；测试也按退出码 3 + 文本匹配。
   - 唯一偏松的是第 2 条：两个摘要字段没有强制字符串类型，但后续比较会失败，不会造成假通过。
   - 未核实：记录里的实际 SHA-256 值和 Hermes 上的实跑结果。
