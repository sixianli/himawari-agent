# 复核结论（PR 319：gitleaks 白名单放行复核记录中的假令牌）

## 按严重度排列的问题

### 1.【低】ci/rules/gitleaks.toml:138 — 路径正则比本仓库既有惯例宽（覆盖所有 PR、所有轮次、任意文件名），但被精确值绑定兜住

- **读代码证实**：新白名单 `paths = ['''(?:^|/)\.agents/reviews/pr-[0-9]+/round-[0-9]+/[A-Za-z0-9.-]+\.md$''']`，而既有同类条目都窄得多：pr-273 那条限定具体轮次和文件名（gitleaks.toml:82 `pr-273/round-[14]/deepseek-v4\.1-flash\.md$`），其余各条均限单个文件。
- **缓解（读代码证实）**：`targetRules = ["generic-api-key"]`（:137）+ `regexTarget = "secret"` + 值精确限定 `^abcdef123456$`（:140）。任何真密钥的值不可能等于这个假令牌，所以「用这条白名单藏真密钥」在值维度走不通；能借道放行的只有「恰好引用同一个假值」的文件——这正是 PR 声明的目标。
- **读代码证实（放宽会被抓住）**：test/tooling/gitleaks-config.test.mjs:265-268 的变异用例把路径放宽到 `.*\.md$`，此时 :60/:85 的夹具 `docs/review-copy/pr-316/round-2/glm-5.3-flash.md`（REVIEW_316_SIBLING，刻意放在 `.agents/reviews` 之外）的命中会被放行，findings 与 :84-99 的 EXPECTED 不再相等，断言 :288 失败。反向用例真实有效（推演核实，未实际运行 gitleaks）。
- **建议**：可接受。如果想更贴合「只放行已审阅的记录」，可收窄到本次实际命中的 `pr-312/round-3/` 与 `pr-316/round-1/`；但值已精确绑定，收窄收益有限。

### 2.【低】ci/rules/gitleaks.toml:135 — description 首次把假令牌原文写进配置文件，偏离本文件既有写法

- **读代码证实**：本文件其余含值的条目，description 都不写值原文（如 :127「网址查询串的假令牌」、:79），唯独新条目写了「假令牌 abcdef123456」。
- **推测**：generic-api-key 默认规则需要「关键字 + 分隔符（`=`、`:` 等）」的形状，中文散文里的裸值大概率不命中；且 check:gitleaks 会全仓扫描 gitleaks.toml 自身，若真命中会立刻显性变红，不会静默漏掉。风险很小，但没必要。

### 3.【低】ci/rules/gitleaks.toml:138 — 文件名字符类 `[A-Za-z0-9.-]+` 不含下划线等字符

- **读代码证实**：现有记录文件名（`glm-5.3-flash.md`、`deepseek-v4.1-flash.md`、`judgments.md`）都在字符类内；但未来记录文件名若含 `_` 或非 ASCII 字符，白名单不覆盖，main 会再次变红，与「以后复核记录再引用同一个假值不再变红」的目标不完全一致。
- **建议**：改为 `[^/]+\.md$` 之类（值仍精确绑定，安全性不变）。

### 4.【未核实】作者声称「blocking=15，新命中全在 pr-312/round-3/judgments.md 和 pr-316/round-1/」

- 本复核环境对 `.agents/reviews` 下任何内容都拒绝访问：`read`/`glob` 返回空，`git show`/`git log` 返回 `REVIEW_GIT_REFUSED records-path`。无法核实真实命中的 15 处是否全部匹配 `pr-<数字>/round-<数字>/<文件名>.md` 形状（例如是否有子目录或非 `.md` 文件——那种命中本白名单盖不住，main 仍红）。夹具测试（gitleaks-config.test.mjs）只证明配置在夹具上的行为，不证明真实仓库变绿。

### 5.【未核实，但有机制保证】ci/toolchain-lock.json:1202 的 sha256「已同步」

- **读代码证实机制**：`runGitleaksGate` 开头调用 `verifyRuleFiles`（scripts/ci/check-security.mjs:598），其中 `assert(sha256(readFileSync(path)) === file.sha256, '扫描规则摘要不匹配: …')`（scripts/ci/install-tools.mjs:321）。哈希若不同步，check:gitleaks 会显性失败而非静默通过。我无法在本地计算 sha256，故具体值未核实，但错误不可能被掩盖。

## 侧重检查

**走过的流程**（`npm run check:gitleaks` 入口到结束）：
1. scripts/check-gitleaks.mjs:76-82 `main()` → `ensureGitleaks`（按 toolchain-lock 版本下载并校验二进制，:25-41）；
2. `runGitleaksGate`（scripts/ci/check-security.mjs:596-…）：先 `verifyRuleFiles` 校验规则文件 sha256（:598，**本次改动命中此路径**），再以 `ci/rules/gitleaks.toml` 为配置扫描 current 与 history 两个 scope（:619、:733，**命中**）；
3. 输出 blocking 摘要（scripts/check-gitleaks.mjs:60-74，**命中**）。

**测试覆盖情况**：
- 覆盖了：白名单结构（gitleaks-allowlist.test.mjs:63-72 计数 13→14；:74-81 逐块验证路径不匹配别的文件；:83-113 值变异），夹具级双 scope 扫描（gitleaks-config.test.mjs:195-219，含 REVIEW_316_RECORD 被放行、REVIEW_316_SIBLING 仍被命中），路径放宽变异（:265-268）。
- 核实了新块追加在 toml 末尾没有打乱既有索引：`scoped[0]` 仍是 Web Push（allowlist.test.mjs:134）、`scoped[6]` 仍是 pr-273（:117）、新增样本对应最后一个 scoped 块（:108）。
- **未覆盖**：真实仓库的端到端验证（上述第 4 条）。
- **未核实**：`test/tooling/toolchain.test.mjs`、`check-gitleaks.test.mjs` 的具体内容（存在但未逐行读，与本次改动的核心判断无关）。
- 文档/规则一致性：作者说法中「该值已有一条只限那个测试文件的白名单」✓（gitleaks.toml:126-132）；「format:check 本来绿」与本改动无关，未核实。

## 必答问题逐条回答

1. **会不会改变模型已经见过的请求开头？** 不会。改动只涉及 `ci/rules/gitleaks.toml`、`ci/toolchain-lock.json` 和两个测试文件，没有任何系统提示、工具定义、历史消息或遮盖结果的改动。「只追加」规则对本 PR 不适用，无影响。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。没有模型可见文本、时间戳字段或集合序相关的改动；新增的白名单是静态确定性正则。
3. **有没有对应的自动检查，反向用例会不会真的失败？** 有，两层：gitleaks-config.test.mjs 用锁定的真实 gitleaks 对夹具仓库做 current+history 扫描，并有路径放宽变异用例——我逐步推演确认放宽到 `.*\.md$` 会让 `docs/review-copy` 夹具的命中消失、断言失败；gitleaks-allowlist.test.mjs 在正则层验证每块的 AND/targetRules/regexTarget/单路径单值及值变异。（推演核实；因无 shell 权限未实际运行。）
4. **每个产生/使用的值两端都核对了吗？** 产生方 = 一条 allowlist + lock 哈希。使用方：① gitleaks 本身（check-security.mjs:619/733 用同一份配置，本地与 CI 同源 ✓）；② 两个测试文件的结构断言（计数、样本列表已同步更新 ✓）；③ lock 哈希由 `runGitleaksGate → verifyRuleFiles` 强制校验，不同步会显性失败 ✓。没有其它消费该白名单的地方。唯一未能核对的是真实命中文件本身（第 4 条，环境限制）。
