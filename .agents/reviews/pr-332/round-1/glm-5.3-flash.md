## 复核结论

### 发现（按严重度从高到低）

**1. 低｜scripts/check-agent-rulebook-inventory.mjs:80-82｜测试编号用子串匹配，会产生漏报**
- 证据（读代码证实）：`if (!testTexts.some((content) => content.includes(id))) problems.push(\`TEST_ID_MISSING ${id}\`)`。`includes` 是子串匹配：清单写了 OM-1，测试里只要有 OM-14、OM-15 的文本（都包含子串 "OM-1"）就算通过。当前清单引用的 OM-1 恰好真实存在（test/integration/proactive-mail-check.test.ts:1976 `[OM-1]`），所以现在没有实际误放，但机制上"编号写错一位"拦不住（PG-8 被 PG-88 满足同理）。
- 建议：改成正则边界匹配（如 `\bOM-1\b` + 下一个字符不是数字），即 `new RegExp(\`\\b${id}(?!\\d)\\b\`)`。

**2. 低｜scripts/check-agent-rulebook-inventory.mjs:85-89｜事故编号只在 incidents-and-gates.md 里找，且只验证"出现过"**
- 证据（读代码证实）：`const incidents = existsSync(incidentsPath) ? readFileSync(...) : ""; ... if (!new RegExp(\`\\b${id}\\b\`).test(incidents)) problems.push(...)`。作者的说法与代码一致（确实只找这一个文件）；风险是双向的：某事故若只记载在 ADR 而没进事故清单，会误报失败；反过来只要编号在清单里任何位置出现过就通过，不核对是否是定义行。当前清单引用的 I-12、I-16、I-29、I-39 我逐一核对都在（docs/incidents-and-gates.md:51、55、67、77）。
- 建议：维持单一来源可以，但建议在文档或脚本注释里写明"事故必须先进 incidents-and-gates.md"，避免以后有人只在 ADR 里记事故号。

**3. 低｜scripts/operations/prod-read.sh:9、111、125｜服务账号 uid 是脚本内硬编码常量，作者说法与之不符；若生产 uid 不是 999 会误拒**
- 证据（读代码证实）：`PROD_SERVICE_UID="999"` 写死在脚本第 9 行，不是调用方传入；第 111 行由 shell 把它作为命令行参数传给远端 node，第 125 行 `owners = [0, Number(process.argv[3])]`。作者说"号码从外面传给远端脚本"——如果指"shell 传给远端 JS"是对的，如果指"调用者从外面传入"则与代码不符。另外 `Number(process.argv[3])` 传空时得 NaN，owners 只剩 root。
- 佐证（读代码证实）：docs/lessons.md:75「生产上属主是 999（服务账号）」、docs/backlog/BL-20261027-006:38「worker-token.json 属主 999、权限 0600」，与 999 是服务账号一致。
- 未核实：生产机 `/etc/himawari/config.json` 的实际属主、模式、nlink，`/etc/himawari` 目录的属主和模式。按作者给的值（uid 999、模式 600、目录属主 root）推演：文件 uid 999 ∈ owners、模式 600 无 group/other 位、nlink 1、目录 uid 0 ∈ owners、目录若无 group/other 写位则全部通过，**不会误拒**。目录若实际是 group 可写（如 0770）会被拒，这是有意收紧还是误拒无法在仓库内判断。

**4. 低｜test/tooling/prod-read.test.mjs:298-308｜"外来属主"反向用例删不掉单项检查**
- 证据（读代码证实）：该用例只把 `serviceUid` 设成 `getuid()+1`，文件属主是当前用户、父目录属主也是当前用户。如果只删掉 `!owners.includes(stat.uid)` 这一项而保留父目录检查，父目录 uid 仍不在 owners 里，用例照样报 UNSAFE——即这个用例只能证明"整个 owners 检查存在"，证明不了"文件属主检查"单独存在。删除文件属主检查后它不会变红。
- 建议：另建一个父目录属主为 root（uid 0 天然在 owners 里）的用例来单独钉住文件属主检查。

**5. 极低｜packages/application/test/owner-profile-service.unit.test.ts:223｜新测试 ID [PA-2] 与已有 [PA-2] 重号**
- 证据（读代码证实）：proactive-mail-check.test.ts:1777 已有 `[PA-2]`（tentative 提示词），清单 S-10（inventory.md:109）指前者，H-13（inventory.md:81）指新加的后者。两个套件共享一个编号空间，check 脚本只要任一处出现 PA-2 就通过。
- 建议：给规则清单类编号留一个不冲突的前缀，或在清单里写明 PA-2 有两处。

**6. 极低｜scripts/check-agent-rulebook-inventory.mjs:9、29-42｜链接正则对带标题或引用式链接静默跳过；CLI 入口无测试**
- 证据（读代码证实）：`/\]\(([^)\s]+)\)/g` 遇到 `](url "title")` 不匹配即放过；`main()`/argv 守卫没被 vitest 覆盖（测试只 import `checkInventory`）。

### 作者六条说法核对
1. 属主校验（root 或 uid 999、无 group/other 位、nlink=1、父目录不可他人写）：**属实**，均在 prod-read.sh:127-136；"号码从外面传"表述与代码不符（见发现 3）。
2. 测试建表用真实迁移：**属实**（prod-read.test.mjs:211-214 遍历 packages/persistence-sqlite/src/migrations；我核对了 memory_records 列与 INSERT 列一致，0001:393-408 + 0052/0053/0054/0057 迁移）。
3. rules → rule-memories：**属实**，全仓无残留旧名（.agents/instructions/test-and-production-hosts.md:19 已同步）。
4. 新检查脚本进 npm run check：**属实**（package.json check:steps 含 check:agent-rulebook-inventory）。
5. 清单加 I 节：**属实**（锚点 raw-output 与导航链接一致）。
6. 反向用例：**属实**且删判断会失败（owner-profile-service.ts:100-101、162-167 是被测判断；对照用例证明 base 会注入，各变体分别对应 supersededBy、validTo<now、三个非 active 状态）。

### 侧重检查（测试覆盖、文档一致性、一条普通流程）

- 流程 A：运维跑 `bash scripts/operations/prod-read.sh rule-memories`——入口 case（prod-read.sh:203-205）→ database_query → ssh 固定命令 → 只读 JS 查询。测试覆盖（prod-read.test.mjs:199-237，含真实迁移、500 条截断、content_ref 不出、m1 出现/m2 不出现）。无未覆盖缺口。
- 流程 B：`system-instruction`——远端校验链每个失败分支都有反向用例（0666、0644、硬链接、目录 0777、软链、外来属主、缺字段、坏 JSON 且不回显 token）。未覆盖：父目录本身是符号链接（lstat→isDirectory=false→拒，推测正确但无用例）、uid 参数缺失（NaN）、生产实况（未核实）。
- 流程 C：改清单文档 → `npm run check`——脚本+vitest 都跑；缺口是发现 1、2 的匹配强度和发现 6 的 CLI 未测。
- 文档一致性：usage 文本、.agents/instructions、清单 I 节互相一致；清单引用的测试文件我抽查的（proactive-mail-check、tentative-memory-capture、automatic-memory-golden、production-memory-evidence、owner-settings-sync、startup-configuration、prompt-rendering-golden、owner-profile-service）全部存在，抽查的编号（PA-1/PA-2/PA-6/MEM-PIN/W-09/SI-3/OM-1/OM-14/OM-15/PG-4/PG-8/PG-18/NAME-1）全部真实存在。
- 未核实：真实持久层 `listActive` 的 SQL 是否也按状态过滤（新反向测试用的是假 `listActive`，只覆盖 service 层）。

### 必答问题

1. **不会改变请求开头。** 本次改动不含任何发给模型的内容：改的是运维脚本、docs、npm 检查步骤和测试；`owner-profile-service.ts` 源码零改动，只加了测试。发给模型的内容仍只在末尾追加，每轮变的值（记忆选择等）逻辑未动。
2. **不会。** 没有改任何序列化、遮盖或带时间字段的代码；清单 I 节记录的是静态文本，不进模型请求。
3. **有自动检查，反向用例基本真实会失败。** 新 check 进了 check:steps 并有 vitest 反向用例；prod-read 每条新校验有反向用例；owner-profile 反向用例删判断会红。例外：发现 4（文件属主检查删不掉单项）、发现 1（编号子串匹配会漏报）。
4. **逐个值核对过，两端一致**：`rule-memories`（script 定义 ↔ usage/测试/.agents 指令/清单 I 节，无残留）；`PROD_SERVICE_UID`（定义 ↔ 第 111/125 行使用，999 有 lessons.md 佐证但生产实况未核实）；`check:agent-rulebook-inventory`（package.json 定义 ↔ check:steps 引用）；锚点 `raw-output`（定义 ↔ 导航链接）；`PA-2` 重号（发现 5）。唯一遗留风险是 uid 999 与生产配置属主属实与否（未核实）。
