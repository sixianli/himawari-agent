# PR 356 第 1 轮复核判断

被复核的提交是 d76066f1，当时分支落后 main（main 已合入 PR 354）。模型拿 `origin/main..d76066f1` 看 diff，所以把 PR 354 的内容看成了“被本 PR 删除”。合入 main 后（合并提交 2c9c7b70），`git diff --stat origin/main..HEAD` 只剩 D4 自己的 8 个文件。

| 编号 | 意见 | 判断 | 处理 |
| --- | --- | --- | --- |
| r1-ds-1 / r1-glm-3 | ADR 0204 与 main 上已有的 0204 撞号，且分支落后 | 成立，会出错（中、高）：`ls docs/adr` 在 main 上已有 `0204-handle-pi-deviations-d2-d3-d5.md`，合并后 `check:adr-numbers` 会失败 | 合入 main，本 PR 的 ADR 改为 0205，三处链接同步改；`npm run check:adr-numbers` 通过 |
| r1-ds-2 | `resolve` 只靠“凭据库为空”区分密钥来源 | 成立，可以更好：不改变任何行为；仓库 `src` 里没有任何地方调用 `setRuntimeApiKey`（grep 无结果），`[D4]` 测试断言 `listCredentials()` 为空，ADR 0205 决定 4 已写明这个不变量 | 不改，列给 Andy |
| r1-ds-3 / r1-glm-4 | 三个变异验证只有手工记录，提交里的反向用例只改了 maxTokens | 成立，会出错（低）：触发=读 PR 说明；后果=误信已自动化。golden 全文比对本身会抓到 `maxTokensField` 变化（手工验证过） | golden 测试加上请求数恰好为 1 和 `"max_tokens":1024` 的断言；PR 说明改为“手工验证” |
| r1-ds-4 | 规范“接模型服务方”一行只写 `registerProvider` | 成立，会出错（低） | 一行里补上完整 `Provider` 的原生认证 |
| r1-ds-5 | golden 请求头过滤依赖运行环境 | 不成立：fixture 里只剩 accept、content-type、authorization 和三个会话头，都由仓库里精确固定版本的 Pi 与 OpenAI 客户端写出，不依赖本机 Node 版本；没有可达的反例 | 不改 |
| r1-glm-1 / r1-glm-2 / r1-glm-6 | 第一个提交夹带运行时行为改动、`runsInParallel` 语义变宽、删除 pr-354 记录 | 不成立：这些是分支落后造成的假象，提交 e934cd2f 只动了测试和 golden 文件，合入 main 后 diff 里没有这些文件 | 不改 |
| r1-glm-5 | 初始化失败被吞成笼统错误码，无测试 | 成立，可以更好：这个 `catch` 在改动前就存在，行为没变 | 不改，列给 Andy |
