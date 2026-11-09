## 复核结论

### 发现的问题（按严重度从高到低）

**1. 中 · `.agents/instructions/document-governance.md:28`、`docs/lessons.md:733` — 文档/规则与代码不一致（本次侧重项）**
- 证据：`docs/lessons.md:733` 写的是“检查 `docs/adr/` 下每个 `.md` 文件的名字……并且没有两份 ADR 共用一个编号；有就报 `ADR_NUMBER_DUPLICATE` 并以 1 退出”；`document-governance.md:28` 同样只描述文件名和重复编号两项。而 `scripts/check-adr-numbers.mjs:116` 现在还叠加 `findAdrTitleProblems` 和 `findAdrLinkProblems`，新增了 `ADR_NUMBER_TITLE`、`ADR_LINK_MISSING`、`ADR_LINK_ANCHOR_MISSING` 三个错误码（脚本 76、93、97 行）。
- 影响：这两个文件是指令/规则体系的一部分（`document-governance.md` 在 `.agents/instructions/`，被 `check:instruction-links` 覆盖的指令根之一，见 `scripts/check-instruction-links.mjs:7-12`）。按仓库自己的标准（规则要和代码一致），本次只改代码不改说明，属于漏改。建议：同步更新这两处的检查范围描述，并补上新错误码。

**2. 低 · `scripts/check-adr-numbers.mjs:113-114` — 标题错误输出顺序不确定**
- 证据：113 行 `const names = readdirSync(directory).filter(...)` 没有排序（`findAdrNumberProblems` 内部在 13 行自己 `[...names].sort()`，但 `findAdrTitleProblems` 按未排序的 `titles` 迭代）；而链接检查的 `markdownFiles`（57 行）有 `.sort()`。`readdirSync` 顺序依操作系统而定，同一次改动在不同平台上错误行的先后可能不同。
- 影响：只是报错顺序不稳定，不影响正确性；本仓库其他检查脚本普遍刻意排序（如 13 行）。建议：`names.sort()` 一行补上。

**3. 低 · `scripts/check-adr-numbers.mjs:33,34,89` — 若干写法的 ADR 断链会被静默跳过，门禁覆盖面比声称的窄**
- 证据：`MARKDOWN_LINK = /\]\(([^)\s]+)\)/` 匹配不到目标含空格的链接；`ADR_LINK_TARGET` 要求短名全小写 `[a-z0-9][a-z0-9-]*`，写成 `adr/0031-Isolated.md` 这类大写变体直接跳过；引用式链接 `[x][ref]` 完全不匹配。这些情形存在断链时检查通过。
- 影响：与姊妹脚本 `check-instruction-links.mjs:13` 的同款正则一致，是沿用的既有局限，不是回归；但作者说法“只要目标路径形如 …/adr/NNNN-短名.md 就检查”对上述写法不成立（这些写法根本不被认成 ADR 链接）。建议：在 lessons/说明里写明这个边界即可，或加宽正则。

**4. 信息 · `test/tooling/adr-numbers.test.mjs:56-67` — 新错误码没走 CLI 出口路径的反向用例**
- 证据：CLI 级测试（spawnSync）只覆盖 `ADR_NUMBER_DUPLICATE`（62 行）；`ADR_NUMBER_TITLE`、`ADR_LINK_MISSING` 只在进程内 `checkAdrNumbers` 上断言（84-88、100-105 行）。“新错误出现时命令行以 1 退出”这一段没有直接用例（逻辑共享，风险很低）。

### 「侧重检查」：走了一条普通流程

流程：改名/改号一份 ADR → 本地 `npm run check:adr-numbers` → CI。
- 入口接线（读代码证实）：`package.json:27` `check:steps` 含 `check:adr-numbers`；`package.json:34` 该步 = `node scripts/check-adr-numbers.mjs && vitest run … adr-numbers.test.mjs`，即脚本与 9 条测试都在门槛里。
- 脚本路径：`checkAdrNumbers`（103 行）→ 编号检查 → 标题检查（读全部 ADR）→ 链接检查（扫 `docs/` 除 `docs/archive`，57-64 行）→ CLI 打印并以 `exitCode=1` 结束（136 行）。
- 未见测试覆盖的路径：① 上面第 2、3、4 条（未排序标题输出、特殊写法跳过、CLI 出口）；② `docs/` 目录不存在时链接检查静默返回（84 行，实际不可能发生，因 105 行已要求 `docs/adr` 存在）。
- 附带核实：被改的 spec 文档在 `test/qualification/evidence/.../frozen-inputs.json` 里有历史 SHA 记录，但 `scripts/` 下 grep 不到任何消费 `frozen-inputs` 去重算当前文件摘要的脚本——改这份文档不会碰坏资格证据门禁（读代码证实）。

### 读代码证实的 / 推测与未核实的分开

**读代码证实：**
- 改动只有 3 个文件：一份 docs spec 的两处 `../adr/`→`../../adr/`、脚本加 72 行、测试加反向用例；`git status` 干净。
- 两处断链修复正确：spec 位于 `docs/execution/specs/`，`../../adr` 解析到 `docs/adr`；目标 `docs/adr/0004-deterministic-authorization.md`、`0053-workspace-auto-approval-like-codex.md` 都存在（glob 证实），链接无锚点所以不涉及锚点检查。
- 锚点规则与 `check-instruction-links.mjs:34-47` 逐字符相同（`headingSlug`、`EXPLICIT_ANCHOR`、`HEADING`），说法属实。
- 测试文件确为 9 个 `it()`，反向用例（标题号错、无编号标题、旧文件名、锚点不存在、`../adr/` 错层、archive 不检查）都在，且断言用 `toEqual` 精确匹配。
- 不涉及任何发给模型的内容：diff 无产品代码；被改的 spec 文档在 `apps/`、`packages/` 下无引用（grep 只命中 docs/ 和测试证据），不是提示词来源。

**推测/未核实（我没有可用的运行手段，只做了静态核对）：**
- “193 份 ADR 标题号全部等于文件名号”“除 docs/archive 外只有两处断链”“变异检查”“9 条测试通过”——均无法运行验证。抽查了约 100 份 ADR 的首个一级标题，全部形如 `# ADR NNNN`；ADR 内部锚点用显式 `<a id>` 且常见锚（`decision`、`hosts`）大量存在；测试里还有一条 `passes on this repository`（108-110 行）全库兜底。作者说法与静态证据一致，最终以 CI 跑 `check:steps` 为准。

### 必答问题逐条回答

1. **不会。** diff 只含 docs spec、检查脚本、测试三处；无任何系统提示、工具定义、历史消息或遮盖逻辑的改动。被改的 spec 文档不被产品代码引用，不进入提示词目录。发给模型的内容完全不变。
2. **不会。** 本次不产生任何发给模型的字节。脚本本身确定性：目录遍历都 `.sort()`（唯一例外是问题 2 中标题错误的输出顺序，属于给人看的报错顺序，不影响判定）。
3. **有，且是硬门槛。** `check:adr-numbers` 在 `check:steps` 里且自带 vitest 反向用例（标题号错、旧文件名链接、锚点缺失、archive 排除），断言精确；反向用例按代码逻辑必然命中对应错误码（读代码证实），实际执行未核实。
4. **能接受，有一处文档缺口。** 新值只有三个错误码；消费方是测试断言和 CI 退出码，无后端/清单校验参与。两处链接修复两端都核对过（路径解析正确、目标文件存在）。唯一两端不一致的是问题 1：`lessons.md` 和 `document-governance.md` 这两个“说明端”仍只描述旧的两项检查，需同步更新。

总体判断：改动本身正确、低风险，测试与接线到位；主要缺陷是文档/规则没跟上（问题 1）和两个小的健壮性瑕疵（问题 2、3），不阻塞。
