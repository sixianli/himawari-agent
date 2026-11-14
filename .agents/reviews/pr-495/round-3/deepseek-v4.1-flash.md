## 复核范围

本轮读了 `d35f8c4..d4dd818` 的全部增量（`.claude/rules/incident-gates.md` 文字、`package.json`、`test/tooling/incident-gates.test.mjs`），并跟到它直接影响的调用端和使用端：`scripts/check-incident-gates.mjs`、`test/tooling/incident-gates.test.mjs`、`docs/incidents-and-gates.md`、`AGENTS.md`、`.agents/instructions/prompt-prefix.md`、`docs/` 与 `.agents/handoffs` 里的旧路径引用，以及 `check:incident-gates` 的消费端 `scripts/run-all-checks.mjs`、`test/tooling/run-all-checks.test.mjs`、`check-instruction-links`、`check-glossary`。第 1 轮引入的 `--open` 脚本和第 1 轮之前的文件移动也按“它产生/修改的值有哪些使用端”重新核了一遍。

## 意见

### 1. 中 — 改按需读事故清单，但没有新 ADR 取代 ADR 0107，ADR 与新规则互相矛盾

文件：`docs/adr/0107-every-incident-gets-an-automatic-gate.md:45`、`docs/incidents-and-gates.md:18`、`.agents/instructions/document-governance.md:18`、`.agents/instructions/document-governance.md:55`

问题：本 PR 把事故清单的开工动作从“读整份清单”改成“运行 `--open`，未涉及就不通读”，但 ADR 0107 的决定 3 仍写着“每个线程开工时读，收尾时更新”；仓库存档要求“决定改变时用新 ADR 取代旧 ADR，绝不改写先前 ADR 的决定内容”，本 PR 没有新增取代 0107 的 ADR。于是同一件事在两处规则里相反，后来的人读 ADR 会照样去通读 184KB 清单，正好抵消本 PR 的目的。

读代码证实的证据：

- `docs/adr/0107-every-incident-gets-an-automatic-gate.md:45`：“……每个线程开工时读，收尾时更新。”
- `docs/incidents-and-gates.md:18`：“每个线程开工时运行 `node scripts/check-incident-gates.mjs --open` 看未结条目……不通读整份清单”
- `.agents/instructions/document-governance.md:18`：“决定改变时，就地取代先前那份 ADR……绝不改写先前 ADR 的决定内容。”
- `.agents/instructions/document-governance.md:55`：“ADR 的后续处理（用新 ADR 取代旧 ADR，而不是改写旧 ADR）”

推测：这份 ADR 不是开局自动载入的文件，所以不会立刻把所有线程带偏；但只要有人按交接或案例库顺着读到它，就会得到与新规则相反的要求，因此我按“规则文档矛盾”报为中。

建议：新增一份 ADR 明确取代或修订 ADR 0107 决定 3（记录“开工跑 `--open`、按需读单行、重复发生时按关键词搜”），在 `docs/incidents-and-gates.md` 和 `.claude/rules/incident-gates.md` 里链到它；不要直接改写 0107 的原决定文字。

### 2. 低 — 清单文件存在但读不出（目录、权限、I/O 错误）时不会打印 `INCIDENT_OPEN unavailable`，规则里唯一的回退条件失效

文件：`scripts/check-incident-gates.mjs:44`、`scripts/check-incident-gates.mjs:98`、`.claude/rules/incident-gates.md:9`

问题：`checkIncidentGates` 只用 `existsSync` 判断“在不在”，随后直接 `readFileSync`，没有捕获读取异常。若该路径是目录、权限被拒或读盘失败，脚本会抛异常退出，既不会返回 `INCIDENT_LIST_MISSING`，也不会走到 `--open` 的 `unavailable` 分支。新规则把“只有命令打印 `INCIDENT_OPEN unavailable` 时”作为唯一触发回退的条件，这条错误路径不会触发它；新测试也只覆盖“文件不存在”和“没有表格”，没有覆盖“存在但读不出”。这是既有脚本的边缘路径，不是本轮增量引入，但本轮把规则的回退唯一绑定在这个标记上，值得一起补。

读代码证实的证据：

- `scripts/check-incident-gates.mjs:44-46`：
  ```js
  if (!existsSync(file))
    return { incidents: [], errors: [`INCIDENT_LIST_MISSING ${INCIDENT_LIST}`] };
  const { incidents, errors } = readIncidents(readFileSync(file, "utf8"));
  ```
- `scripts/check-incident-gates.mjs:98-99`：只有 `checkIncidentGates()` 正常返回且 `errors.length > 0` 时才写 `INCIDENT_OPEN unavailable errors=...`。
- `.claude/rules/incident-gates.md:9`：“只有命令打印 `INCIDENT_OPEN unavailable` 时，才直接打开清单查看，并先修好清单”。

推测：正常 checkout 不会出现目录或权限问题；触发后也是显式报错退出，不会静默给出错误结果，所以我判低。

建议：在 `checkIncidentGates` 里用 `try/catch` 包住 `readFileSync`，把读取失败转成一条错误（例如 `INCIDENT_LIST_UNREADABLE`），这样 `--open` 仍会打印 `INCIDENT_OPEN unavailable`；测试补一个“清单路径是目录或不可读”的用例。或者把规则改成“命令非零退出且没有打印条目”也算不可用。

### 3. 低（可以更好）— 把 incident-gates 测试接进本地检查的这条接线没有自动断言，未来可能被静默改掉

文件：`package.json:30`、`test/tooling/run-all-checks.test.mjs:50`

问题：d4dd818 的目的是让本地 `npm run check` 也跑 `test/tooling/incident-gates.test.mjs`，但 `run-all-checks.test.mjs` 只对 `check:probe-sources` 做了逐字断言，对 `check:incident-gates` 只检查“是字符串”。如果以后有人删掉 `package.json` 里的 `&& vitest ...`，CI 的 tooling 项目仍会跑这个测试，本地检查却会悄悄失去这层保护，而现有测试不会失败。

读代码证实的证据：

- `package.json:30`：`"check:incident-gates": "node scripts/check-incident-gates.mjs && vitest run ... test/tooling/incident-gates.test.mjs"`
- `test/tooling/run-all-checks.test.mjs:55-57`：对 `check:probe-sources` 做了完整的字符串断言；`:74` 对 `check:incident-gates` 只要求 `toBeTypeOf("string")`。

推测：这是“以后可能回归”的风险，不改当前行为，所以归为可以更好。

建议：照 `check:probe-sources` 的写法，在 `run-all-checks.test.mjs` 里对 `check:incident-gates` 的值做一次逐字断言（或至少断言包含 `vitest` 和测试文件路径）。

## 侧重检查

- **错误路径**：核对了 `--open` 的“清单缺失”“没有表格”“能读出但校验失败”“无法解析”等分支；前三种有测试，第四种见意见 2。正常错误分支会先写 stderr，再写 `INCIDENT_OPEN unavailable`，再写 `INCIDENT_GATES failed`，退出码 1，和作者描述一致。
- **不合规范或不可信输入**：`readIncidents` 只接受固定表头和四种状态，状态非法、字段为空、编号/日期不合法、次数非法、表格外事故行都会进入 `errors`，此时 `--open` 不列条目；清单内容不会被执行，只作为纯文本写出。症状文字可能含管道符或控制字符，但清单是仓库内受审内容；我没有把它当成越权输入，只作为推测记为低风险。
- **安全**：检查脚本只读仓库内 `docs/incidents-and-gates.md`，不联网、不读环境变量、不写文件；测试只写 `mkdtemp` 临时目录并在 `afterEach` 删除。`prompt-prefix.md` 的移动没有引入新的运行时读取点，`packages/` 和 `apps/` 中没有任何代码引用 `.claude/rules/prompt-prefix.md` 或 `.agents/instructions/prompt-prefix.md`。
- **资源耗尽**：`--open` 每条症状先按第一句、再截到 80 个 Unicode 码点，清单最多 96 条，输出有界；没有递归、无界集合遍历或外部命令执行。新增的 vitest 运行是一次有界测试。
- **不可撤销操作**：没有。脚本和测试都不写仓库内文件，不调用部署、删除或生产命令。
- **规则、说明文档和代码一致**：规则与脚本的 `OPEN_STATES`、输出顺序、`unavailable` 条件一致；旧路径引用已全部清掉，`../../` 链接在 `.agents/instructions` 下仍解析到仓库根，`check:instruction-links` 和 `check:docs-links` 的规则能覆盖。发现 ADR 0107 与新规则矛盾（意见 1）。另外 `.agents/instructions/document-governance.md:28` 仍把 `check:incident-gates` 描述成只查格式，实际现在还跑定向测试；这句话不算错，只是不完整，未单列意见。

## 作者说法核对

1. **基本属实**：`--open` 对非 `已落门槛` 的状态（缺门槛、等 Andy、仓库外）逐条输出 `编号 | 状态 | 日期 | 第一句`，随后 `INCIDENT_OPEN count=N total=M`，再输出原有 `INCIDENT_GATES` 行；`errors.length > 0` 时只输出 `INCIDENT_OPEN unavailable errors=K`，随后仍输出 failed 行，错误在 stderr，直接运行脚本的退出码和以前一致。补充：`npm run check:incident-gates` 现在还会跑 vitest，所以这个 npm 脚本可能因测试失败而返回 1，和直接运行 `--open` 不是同一个退出条件。
2. **属实**：`prompt-prefix.md` 从 `.claude/rules/` 移到 `.agents/instructions/`，两者都在仓库下两层，文件内的 `../../docs/...` 仍正确；全仓库已搜不到 `.claude/rules/prompt-prefix` 的引用；`.agents/handoffs` 两份 11-05 文件的链接确实在 d35f8c4 中改到新路径；`.agents/reviews` 没有需要改的旧引用。
3. **属实**：删掉的 CI 长期授权、复核分级和轮次、`accept-low`、`accept-unreviewed`、Mac 线程交接、Pi 现有偏离不得照抄，分别能在 `delivery-mode.md:27`、`model-review.md:51-74`、`model-review.md:85-91`、`model-review.md:163-178`、`pi-development-guide.md:29` 找到。
4. **核心部分属实，措辞不准确**：没有发现改动影响 Himawari 运行时的请求组装或序列化；但改动范围不止“指令文档和一个开发用检查脚本”，还改了 `package.json`（本地检查接线）、`test/tooling/incident-gates.test.mjs`（测试），并移动了规则文件。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 对 Himawari 运行时模型：不会。本 PR 没有改任何运行时代码、系统提示、工具定义、历史消息或遮盖逻辑，也没有代码从这些文档路径读取内容来组装请求。对开发用的编码代理：把 `prompt-prefix.md` 移出 `.claude/rules/` 会让**新开的**编码代理线程少载入一份规则，这是本 PR 的目的；它没有修改任何已经发出的历史或已冻结的请求开头，也没有违反“只追加”。发给模型的内容仍然应当只在末尾追加，每轮会变的值仍应只在最后一条消息里；本 PR 没有改变这条约束，只是把规则文件改成按需读取。
2. **同一段文字会不会在不同请求里变成不同字节？** 对 Himawari 运行时：不会。文件移动是 0 内容变化的改名；`--open` 只读仓库文件，不依赖时间、随机数或无序遍历（`OPEN_STATES` 只做 membership，不迭代），同一提交下输出确定。唯一变化来源是清单内容本身或门槛文件是否存在，这不是“同一段文字被遮成不同字节”的问题，也不是运行时会话内容。
3. **有没有对应的自动检查，反向用例会不会真的失败？** 有。`incident-gates.test.mjs` 覆盖了状态筛选、`仓库外`、80 字边界、emoji 不切开、CLI 输出顺序、退出码、清单缺失、无表格、能读出但校验失败等；b39f245 的新用例在“脚本只在读不出条目时才 unavailable”的反向改法下会因输出 `I-02` 和 `count=` 而失败，推断成立。d4dd818 又把这个测试接进了本地 `check:incident-gates`。缺口是：这条“接线”本身没有自动断言（意见 3）；“目录/不可读”错误路径没有测试（意见 2）；规则与 ADR 0107 的矛盾没有检查（意见 1）。
4. **每个产生/修改的值，使用端都能接受吗？**
   - `OPEN_STATES` 从唯一的 `INCIDENT_STATES` 派生，状态在 `checkIncidentGates` 里用 `INCIDENT_STATES.includes` 校验，只有校验全过才输出；规则文字和测试都按“缺门槛、等 Andy、仓库外”接受，匹配。
   - `编号 | 状态 | 日期 | 第一句` 被规则和测试当作纯文本消费；日期、状态、编号在输出前已通过校验，症状非空也已校验。没有机器协议依赖这个格式。
   - `INCIDENT_OPEN unavailable errors=K` 被规则按字符串识别，测试按字符串断言；具体错误同时写 stderr，匹配。
   - `INCIDENT_OPEN count=N total=M` 只被测试解析，规则不依赖；匹配。
   - `package.json` 的 `check:incident-gates` 值只被 npm、`check:steps` 的 runner（只取步骤名）和 `run-all-checks.test.mjs` 使用；新的 vitest 测试文件存在，项目为 `tooling`，能接受。没有其他脚本按旧值做字节比较。
   - 新路径 `.agents/instructions/prompt-prefix.md` 的所有引用都能解析到真实文件，`check:instruction-links` 和 `check:docs-links` 能覆盖。
   - **不能接受的一处**：`docs/adr/0107` 仍把“每个线程开工时读”当作现行决定，和新规则冲突（意见 1）。
