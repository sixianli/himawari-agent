## 侧重检查

我重点看的路径与结论：

- **错误路径（`system-instruction`）**：配置文件不存在、JSON 损坏、符号链接、非普通文件、权限含 group/other、硬链接、父目录可写、属主不符都有对应分支；损坏 JSON 只报 `PROD_READ_CONFIG_UNREADABLE`，不打印内容，错误路径基本合格。唯一没覆盖的是父目录属主分支的独立反向用例（见问题 3）。
- **不可信输入/资源**：`prod-read.sh` 的参数正则未变；`PROD_SERVICE_UID` 是常量。清单校验脚本会遍历并读取整个仓库的测试文件，忽略 `node_modules` 等大目录，但没有防止符号链接目录，也没有深度限制（低风险）。
- **不可撤销操作**：本次改动都是只读查询、文档和测试，没有写生产数据的操作。
- **规则/文档一致性**：`prompt-prefix` 规则和模型请求组装代码都没有被改；但清单里 M-4 的描述与 `owner-profile-service.ts` 的实际实现不一致（见问题 6，非本 PR 引入）。

---

## 读代码证实的问题

### 1. 中：清单校验会被自身测试文件“喂饱”，测试编号缺失时可能误判通过

**文件:行**：`scripts/check-agent-rulebook-inventory.mjs:65-78`、`test/tooling/agent-rulebook-inventory.test.mjs:19-22`、`:27-31`、`:42-44`

**问题**：校验脚本收集**所有**测试文件，包括自己的测试文件，然后用 `content.includes(id)` 做子串匹配。清单里引用 `PG-8` 和 `OM-1`，而校验脚本自己的测试文件里就写着 `PG-8`、`OM-1`，所以即使真实测试全部删掉，这两个编号仍然会“存在”。此外 `PG-1` 会被 `PG-17`、`PG-18`、`PG-10` 等满足。

**证据**：

```js
const testFiles = collectTestFiles(root);
const testTexts = testFiles.map((file) => readFileSync(path.join(root, file), "utf8"));
...
if (!testTexts.some((content) => content.includes(id))) problems.push(`TEST_ID_MISSING ${id}`);
```

```js
writeFileSync(
  join(root, "packages/demo/test/demo.unit.test.ts"),
  'it("[PG-8] keeps the list", () => {});\n',
);
...
"`demo.unit.test.ts` PG-8 I-7",
...
"`absent.unit.test.ts` PG-99 OM-1 I-999",
```

**建议**：校验时排除校验脚本自己的测试文件/夹具；从清单表格里解析“测试”列，只到该行点名的测试文件里找；用 `[ID]` 或精确词边界匹配，不要用 `includes`。补两个反向用例：清单写 `PG-1` 但测试只有 `PG-10`；清单写 `PG-8` 但只有校验脚本自己的夹具里出现。

### 2. 中：`refuses a configuration owned by another user` 没有真正测到“文件属主”检查

**文件:行**：`test/tooling/prod-read.test.mjs:298-308`、`scripts/operations/prod-read.sh:125-135`

**问题**：测试把 `serviceUid` 改成 `getuid()+1`，但文件所在临时目录的属主仍是当前用户。`owners = [0, 外来 uid]` 不包含当前用户，所以即使删掉 `!owners.includes(stat.uid)`（文件属主检查），父目录属主检查也会返回 `PROD_READ_CONFIG_UNSAFE`，测试仍然通过。这个用例实际测的是父目录属主，不是文件属主；而且 root 下整个用例被跳过。

**证据**：

```ts
const foreign = String(process.getuid() + 1);
expect(readConfig(result.input, file, foreign).stderr).toContain("PROD_READ_CONFIG_UNSAFE");
```

```js
!owners.includes(stat.uid) ||
...
(parent.mode & 0o022) !== 0 ||
!owners.includes(parent.uid)
```

**建议**：把属主校验拆成可注入 `stat`/`parentStat` 的纯函数分别测；或用 `fchown`（root 环境）造出“文件属主外来、父目录属主 999”的现场；再单独补父目录属主反例。

### 3. 中低：`PROD_SERVICE_UID` 从 shell 传到远端 node 的这一段没有被测试

**文件:行**：`scripts/operations/prod-read.sh:111`、`test/tooling/prod-read.test.mjs:25-30`、`:239-254`

**问题**：测试直接执行 `result.input`（即远端 JS 文本），并自己传入 `serviceUid`，只断言进程序列里包含 `--no-warnings - /etc/himawari/config.json`。如果 `prod-read.sh` 把末尾的 `$PROD_SERVICE_UID` 删掉，测试仍然通过，但生产上 `process.argv[3]` 是 `undefined`，`Number(undefined)` 为 `NaN`，uid 999 的配置会被误判为 `PROD_READ_CONFIG_UNSAFE`。

**证据**：

```bash
"cd /tmp && $PROD_NODE --no-warnings - $PROD_CONFIGURATION $PROD_SERVICE_UID"
```

```ts
function readConfig(input, file, serviceUid = String(process.getuid())) {
  return spawnSync(process.execPath, ["--no-warnings", "-", file, serviceUid], ...
```

```ts
expect(result.calls).toContain("--no-warnings - /etc/himawari/config.json");
```

**建议**：断言 `result.calls` 包含 `config.json 999`，或让假 `ssh` 真正执行构造出的命令行，端到端覆盖“shell 参数传给远端 node”这一步。

### 4. 低：测试列里的 `I-xx` 编号只当事故编号检查，不检查测试用例是否存在

**文件:行**：`scripts/check-agent-rulebook-inventory.mjs:9`、`:81-85`；`docs/agent-rulebook-inventory.md:127`、`:174`、`:176`

**问题**：`TEST_ID` 只匹配 `PG|OM|SI|PA|NAME|MEM|W`，不匹配 `I-`。清单 C-4、C-6、S-21 的“测试”列写的是 `I-29`、`I-39`、`I-12`，脚本只会到 `incidents-and-gates.md` 里找这些编号，不会确认测试文件里真的有 `[I-29]`、`[I-39]`、`[I-12]` 用例。这样清单可以声称有门槛用例而实际没有。

**证据**：

```js
const TEST_ID = /\b(?:PG|OM|SI|PA|NAME|MEM|W)-[A-Z0-9]+\b/g;
```

```js
for (const id of new Set(text.match(INCIDENT_ID) ?? [])) {
  if (!new RegExp(`\\b${id}\\b`).test(incidents)) problems.push(`INCIDENT_ID_MISSING ${id}`);
}
```

**建议**：区分“事故编号”和“测试用例编号”；测试列里的 `I-xx` 应到测试文件里按 `[I-xx]` 精确检查，或把 `I` 加入测试编号匹配并限定上下文。

### 5. 低：清单 M-4 与代码不一致，新测试也没有覆盖它声称的内容

**文件:行**：`docs/agent-rulebook-inventory.md:148`、`packages/application/src/services/owner-profile-service.ts:149-167`、`:186`、`packages/application/src/services/model-visibility.ts:10-18`

**问题**：M-4 写“分类为敏感的规则永远不会注入”，并引用 `PROFILE_CLASSIFICATIONS`，但代码里根本没有这个符号；规则块只按 `memory.attributes?.category === "rule"` 和分类上限筛选，`modelVisibleCeiling()` 是 `"sensitive"`，所以 `maxClassification: "sensitive"` 时敏感规则是可能注入的。新加的 `[PA-2]` 用例只测被取代/过期/非 active，不测敏感规则，不能支撑 M-4 的表述。

**证据**：

```ts
const valid = (...records).filter(
  (memory) =>
    memory.status === "active" &&
    CLASSIFICATION_RANK[memory.dataClassification] <= ceiling &&
    currentlyValid(memory, input.now),
);
...
const rules = await take(eligible.filter((memory) => memory.attributes?.category === "rule"));
```

**建议**：要么在代码里真的加“敏感规则不注入”的过滤并加用例，要么改清单措辞和引用的符号；同时补 `PROFILE_CLASSIFICATIONS` 的代码引用或删掉这个不存在的名字。

### 6. 低：校验脚本只认手写 `<a id>` 锚点，且会跟随符号链接目录

**文件:行**：`scripts/check-agent-rulebook-inventory.mjs:14-20`、`:36-38`、`:46-61`

**问题**：`anchorsOf` 只识别 `<a id="...">`，不支持 Markdown 标题自动锚点；`walk` 用 `statSync(full).isDirectory()` 会跟随符号链接目录，仓库里若有指向外部或成环的链接，可能读到仓库外或无限递归。当前清单都用手写锚点，暂时不触发。

**建议**：明确只支持 `<a id>` 并写进脚本说明；遍历时用 `lstatSync` 跳过符号链接，或记录已访问的 realpath。

---

## 推测/未核实

### 高（条件成立时）：父目录“组可写”检查可能误拒生产配置

**文件:行**：`scripts/operations/prod-read.sh:126-135`

**问题**：新检查无条件拒绝 group 可写的父目录。生产维护流程以 `himawari-prod`（uid 999）身份写 `/etc/himawari/config.json.next`：

```python
return ['/usr/sbin/runuser', '-u', 'himawari-prod', '--', ... 'maintenance/run-maintenance.mjs', action]
```

```js
const nextPath = `${configPath}.next`;
...
writeFileSync(nextPath, bytes, { flag: "wx", mode: 0o600 });
```

因此 `/etc/himawari` 必须对 uid 999 可写。如果它如材料所说属主是 root，常见做法就是 root:himawari-prod 且组可写（如 0770/0775），此时新检查会以 `PROD_READ_CONFIG_UNSAFE` 拒绝，`system-instruction` 查询在生产上不可用。如果目录实际属主是 999，或 root 属主但只靠 ACL 给 999 写权限，则不会误拒。

**证据**：`prod-read.sh:132-134` 的 `(parent.mode & 0o022) !== 0`；`run-step.py:24-25`；`run-maintenance.mjs:67-74`。

**建议**：现场核对 `stat -c '%u %g %a' /etc/himawari`。父目录检查应允许“受信服务组可写”而不是一律拒绝 group 写；或者只拒绝 other 可写，并单独校验父目录属主属于 root/服务账号。补一个模拟生产目录属主和权限的测试。

**未核实**：`/etc/himawari` 的真实属主和权限；I 节声称的命令实际退出码与输出（仓库内只能看到记录文本，不能重放生产）；本次改动后 `npm run check` 的实际运行结果。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动只涉及 `docs/`、`scripts/operations/prod-read.sh`、清单校验脚本和测试；没有改提示词目录、`production-run-policy.ts`、`owner-profile-service.ts` 的组装逻辑、工具定义、历史序列化或遮盖逻辑。C-1 记录的生产 `systemInstruction` 原文没有变，I 节只是文档。按 `.claude/rules/prompt-prefix.md` 第 2、4 条，发给模型的内容仍然只在末尾追加，每轮变化的值没有被搬到系统提示或工具定义里。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。没有新增依赖前后文的遮盖、时间字段或无序集合影响模型请求。`rule-memories` 查询虽带时间戳和 `ORDER BY recorded_at DESC, id`，但它是运维查询，不进入模型请求；I 节也是静态文档，不参与请求组装。

3. **有没有对应的自动检查？反向用例真的会失败吗？**
   部分有，部分不真失败：
   - **清单校验**：已接入 `npm run check`，并有缺失链接/锚点/测试文件/测试编号/事故编号的反向用例；但这些用例没有覆盖子串碰撞和“校验脚本自身夹具污染”，所以真实的 `PG-1`/`PG-8`/`OM-1` 缺失可能仍然通过（问题 1、4）。
   - **`prod-read`**：硬链接、权限位、父目录可写、符号链接、模式名变更都有能失败的反向用例；但“文件属主外来”用例实际被父目录属主分支挡住，删掉文件属主检查也不会失败（问题 2）；`PROD_SERVICE_UID` 的 shell→node 参数传递没有被测（问题 3）。
   - **`owner-profile-service` 新用例**：如果删掉 `attributes.supersededBy !== null`、过期判断或 `memory.status === "active"`，对应的变体会进入 `memoryIds`，`expect(...).not.toContain("memory-sister")` 会失败；控制组也证明未变形的 `base` 本来会进入，所以这个反向用例是有效的。

4. **改动产生或修改的每个值，所有使用它的地方都能接受吗？**
   - `rule-memories`：脚本的 `case`、远端 `mode === "rule-memories"`、usage、测试、文档调用一致；仓库里没有残留的用户入口 `prod-read.sh rules` 或 `--no-warnings - rules`。
   - `PROD_SERVICE_UID = 999`：与生产账号文档和 `run-step.py` 的 `(999, 988)` 校验一致；但测试没有断言它真的被传进远端命令，见问题 3。
   - 清单 `raw-output` 锚点：导航链接和 `<a id="raw-output">` 对得上；I 节字段顺序与 `rule-memories` 的 SELECT 列顺序一致，数值与 C 节表、C-1 原文一致（就仓库文本而言）。
   - 真实迁移建表：测试插入的列都能在 `0001`、`0052`、`0053`、`0054` 等迁移里找到；查询的列也都存在。
   - `package.json` 的 `check:agent-rulebook-inventory`：已定义，且 `check:steps` 和 `run-all-checks.mjs` 会实际执行它。
   - 测试编号/事故编号：大部分真实存在，但清单校验的判定方式不可靠（问题 1、4）。
