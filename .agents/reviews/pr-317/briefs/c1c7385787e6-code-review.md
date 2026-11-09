# PR 317 第 3 轮材料：复核第 2 轮中高意见的修改

第 2 轮（提交 03c4476fd840）的中高意见：安装改成先装到临时目录再改名后，如果正式缓存目录已存在但里面没有可执行文件（旧版安装被中途杀掉留下的非空残留），改名会一直因目标非空而失败，缓存修不好；旧实现开头先删目录，不会这样。

本轮修改（请对照 `scripts/model-review/opencode-review.mjs` 的 `installBesideThenRename`）：
- 改名失败且目标没有可执行文件时，先删掉旧残留的缓存目录，再把临时目录改名过去；目标已有可执行文件时仍然复用，不删。
- 新增 `test/tooling/opencode-review.test.mjs` 里“旧残留目录被替换成新装”的用例；撤掉上面的修改后，该用例在 Hermes 上以 `ENOTEMPTY` 失败，加上修改后相关测试文件 925 个全过。
- 低危修改：`docs/incidents-and-gates.md` 里 I-77 一行的用例位置写法。
- 本分支还合并了最新 main（`git diff` 里有 main 带来的无关改动，不需要复核），并给 gitleaks 加了一条只限 `test/tooling/opencode-review-merge-gate.test.mjs` 历史版本里假私钥开头标记的窄白名单（`ci/rules/gitleaks.toml`、`ci/toolchain-lock.json`、`test/tooling/gitleaks-allowlist.test.mjs`），那是上一轮 gitleaks 对本 PR 自己拆分提交的误报。
- 第 2 轮其余意见的判断见 `.agents/reviews/pr-317/round-2/judgments.md`（重装路径先删共享目录是改动前就有的路径，判低、不改；清理被杀进程遗留的临时目录、补重装并发用例判“可以更好”，不改）。

请只看第 2 轮提交之后本 PR 自己的改动，重点查：旧残留自愈是否正确，会不会误删已经装好、有可执行文件的目录；改名失败再重试时有没有留下半成品；完整性检查有没有被绕过；白名单是否只放行那一种形式。
作者说法：Hermes 上相关测试和格式检查通过。
这个改动不会改变模型已经见过的请求开头（只改复核脚本的安装步骤、测试、gitleaks 规则和文档文字）。
