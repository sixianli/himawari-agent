# PR 312 第 4 轮复核的逐条判断

这一轮复核的是第 2 轮之后的全部改动，重点是两处：第 3 轮修掉的那行指令（`.agents/instructions/model-review.md:140`），以及我为了让复核能跑起来而修的复核脚本自检误判（`026bfdff` + `1f16c11b`）。

四条意见全部成立。其中第一条我判「中」，照改并重新复核；另外三条是对我自己判断记录的纠正和一条加门槛的建议。

## R4-1（模型：中 → 我也判中，已改）修复只排除了缩进行，`git log -1 --oneline` 的提交标题仍在列 0

成立，而且这是我第二次没把根因找完。自检的 allowed 探针里有 `git log -1 --oneline`（`opencode-review.mjs:1741`），它的输出是「短哈希 + 提交标题」，标题紧跟哈希在同一行，整行从列 0 开始。我在 `1f16c11b` 的提交说明里写「`git show`、`git log` 打印的提交说明每行缩进四格」——对 `git show` 和默认的 `git log` 成立，对自检真正用的 `--oneline` 不成立。所以只要提交标题里出现那三段字样中的任何一段，一条正常执行完的命令仍会被判成被拒。

改法按模型的建议，不再靠缩进判断，改成按每段字样真正被打印出来的形状做行首精确匹配：

- git 替身写的是 `REVIEW_GIT_REFUSED <问题码>`（`opencode-review.mjs:638`），匹配 `^REVIEW_GIT_REFUSED \S`。
- `bash -r` 写的是 `<shell 路径>: [line N: ]<词>: restricted: …`，匹配 `^\S+: (line \d+: )?[^\n]*: restricted`。
- opencode 自己的拒绝话术写在自己一行的开头，匹配 `^The user has specified a rule which prevents you`。

`--oneline` 的那一行永远以短哈希加一个空格开头，所以这三条模式都不会命中它；缩进四格的提交说明同样不会命中。`026bfdff` 加的 `REFUSAL_PATTERNS` 这次成了唯一的判断依据，`REFUSAL_TEXTS` 和 `refusalCandidateLines` 删掉。

反向验证：那条用例现在有六个断言。正向三条（替身的行、`bash -r` 的报错、opencode 的话术，都在列 0）仍然为 `true`；反向三条把三段字样分别放进 `git log -1 --oneline` 形状的提交标题里（列 0，但前面有短哈希），期望 `false`，另有一条把三段都放进缩进的提交说明里。把 `probeRefused` 还原成只按缩进过滤的版本跑，这条用例以 `expected true to be false` 失败；改回来之后 `test/tooling/opencode-review.test.mjs` 164 条全过。

为什么判「中」而不是「低」：后果本身是 fail-closed 的，只会让复核起不来，不会放过真正被拒的情形，也不影响产品。但它让我宣布的「根因」第二次落空，而这恰好是 Andy 的规则明确要求的事——修 bug 先查根因，意味着把同类的全部路径核对一遍，不是只核对复现出来的那一条。按「会出错、中」处理：改完重新复核。

## R4-2（模型：中 → 我判低，记录在此纠正）R3-1 的降级理由里「后手已经覆盖」这句不成立

成立。第 3 轮我把 R3-1 从「中」降为「低」时给了两条理由，模型指出其中一条站不住：

- 站得住的那条：这行不一致不是本 PR 造成的，是 main 上原有的，被合并原样带进来。
- 站不住的那条：我说原句后半「以后若加了，任务说明里的『有就先运行』一句已经覆盖」算一道后手。模型的反驳对：`check:gitleaks` 在 main `1a3a1efe` 上早就存在、而且就在 `check:steps` 里，所以原句开头那句「目前 `package.json` 里没有 `check:gitleaks` 这个脚本，云端线程不用跑它」不是「以后才要跑」，而是直接与事实相反、并主动告诉云端线程不用跑。只读到那半句就停下的线程会跳过这道门槛，这正是 I-90、I-86 那类风险。

我按第 3 轮当时的样子保留 `round-3/judgments.md` 和 `round-3/verdicts.jsonl`，不回头改写——账本只在末尾追加，改写旧记录会让「当时我是怎么判的」这件事失真。纠正写在这里：**R3-1 的降级只能靠「不是本 PR 造成的」这一条理由，「后手已经覆盖」那条作废。** 改后的新指令本身模型也认为是正确的，不需要再动。

判低而不是中：被纠正的是我这份判断记录的论证，不是代码，也不是改后的指令；而且结论（照改）没有变。

## R4-3（模型：低，记录在此纠正）我对两个脚本「是否校验列数」的描述不精确

成立，两点都对，我读得不够细：

1. `scripts/check-incident-gates.mjs:27-28` 其实**校验了表头的列**：表头逐列不等于 `编号|日期|现象|根因|次数|门槛（文件或命令）|状态` 就报 `INCIDENT_TABLE_COLUMNS_CHANGED`。它不校验的是**数据行的列数**——`:32` 直接解构前 7 个值，多出来的第 8 列被静默丢掉。我在第 3 轮写成「不校验列数」，范围说大了，准确的说法是「表头列固定、数据行多出来的列不查」。
2. `scripts/check-markdown-tables.mjs:8` 的 `SCANNED_DIRECTORIES = ["docs"]`，只扫 `docs/`。所以 `files=403 errors=0` 这个输出对 `docs/incidents-and-gates.md` 的 I-84、I-90 两行有证据力，对 `.agents/instructions/**` 和 `.agents/reviews/**` 下的表格没有任何证据力。我第 3 轮拿它当「列数是对的」的证据时没有限定范围。

两处都只是我的描述不准，不影响结论：I-84、I-90 两行在 `docs/` 下，确实被 `check:markdown-tables` 逐行比过列数。

## R4-4（模型：低，判为「可以更好」，不采纳并说明理由）那行指令的事实陈述没有自动检查

事实部分成立：`scripts/check-instruction-links.mjs` 只校验 markdown 链接、锚点和反引号里的仓库路径；`check:gitleaks` 不是路径，不会被它检查。`test/tooling/run-all-checks.test.mjs` 断言 `check:steps` 里每个名字都是真实的 npm 脚本，但它不读 `model-review.md`。所以「这句话说 `check:gitleaks` 存在、属于 `npm run check`」确实没有机器检查兜着。

它建议的门槛（解析指令里提到的 `npm run <脚本>`，断言 `package.json` 里有这个脚本）我不采纳，两个理由：

1. **它拦不住这次的漂移。**这次出错的句子是「目前 `package.json` 里没有 `check:gitleaks` 这个脚本」——它提到了 `check:gitleaks`，而这个脚本确实存在，所以「提到的脚本必须存在」这条规则会直接放行。真正要拦的是「声称某个脚本不存在」而它存在，那是一条针对否定句式的文本规则，脆弱且容易被换一种说法绕过。
2. **它会立刻需要一份会漂移的例外清单。**我实际扫过一遍：`.agents/instructions/`、`.claude/rules/` 和 `AGENTS.md` 里一共提到 13 个 `npm run <脚本>`，其中 `check:docs` 在 `document-governance.md:28` 里是被当作「已删除」来提的（原话：「`npm run check:docs` 及其脚本已删除」）。所以这道门槛第一天就要带一条例外，而每次有脚本被删掉都要再加一条——和我在第 3 轮拒绝「给 `check-incident-gates` 加已知编号清单」是同一个理由。

列给 Andy，他要的话我再做。

## 模型自标「未核实」的部分

- `.agents/reviews/**` 被它的工具以 `REVIEW_GIT_REFUSED records-path` 拒绝，所以 `round-3/judgments.md` 和 `verdicts.jsonl` 的原文它读不到，R4-2、R4-3 对照的是材料里的转述。转述与原文一致（原文在同一个仓库里，Andy 可以直接看）。
- R3-2 的「三条命中不在 `.agents/reviews/pr-312/**`」和 I-84 行 md5 的比对它跑不了，标为未核实。它能确认的是 `ci/rules/gitleaks.toml` 不在 `1a3a1efe..head` 的改动列表里，与「本 PR 不改这个文件」一致。
- opencode 真实拒绝输出的缩进它只有测试夹具可参照。这一轮改成行首精确匹配之后，这个不确定性仍在：如果真实输出把那句话缩进了，allowed 探针且 `status === "completed"` 时可能漏判。它自己也写了兜底：git 替身和 `bash -r` 都以非零退出，`call.status !== "completed"` 这一条会先拦下。

## 必答问题

四条回答与我自己的核对一致。特别是第一条：这一轮改的是复核脚本自己的自检解析和一行 delegate 段的指令，都不在产品组装发给模型的内容里；复核提示词只抽取 `model-review.md` 里 `<a id="checklist"></a>` 之后的必答问题段（`opencode-review.mjs:220-231`），被改的那行在别的段落，所以连复核模型自己的提示词前缀都没变。
