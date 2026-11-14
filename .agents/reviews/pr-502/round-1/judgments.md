# PR 502 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1. 中 — `git diff` 列文件失败时静默当作“已不在 head”，会放行未核对的旧代码说法。plan-claims.mjs 旧版 quoteInChangedFiles 失败返回 false；已改为返回 incomplete，报 commit-quote-check-incomplete，测试 scan limit 用例；触发：换提交到当前提交之间改动超过 400 个文件，或 git diff 失败，且被挪走的代码在被截掉的文件里；后果：新增的挪文件检查静默失效，旧提交引用被放行（不比改动前更松）；判低理由：需要 400 个以上改动文件或 git 自身失败才触发，且只是新检查没起作用，不是新放行路径
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 中 — 扫描所有新增/改动/改名文件，会把 ADR 或文档里的引文当成“代码还在 head”。扫描不分文档；已跳过 docs/adr/，测试 quoted inside an ADR 用例（别的文档里的挪动副本仍拒绝）；触发：ADR 正文引用同一段旧代码，同时对它写 文件:行@旧提交；后果：正确的旧代码说法被误拒，只能改引文绕过；判低理由：只会多拒绝，不丢数据也不放行
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. 低 — 每个旧提交引用都会重跑 diff 并最多读取 400 个完整 blob，没有大小和缓存上限。每个 claim 重跑 diff 与读 blob；已按 (repo,commit,head) 缓存文件列表、按 (repo,head,path) 缓存 blob 文本
- 4（deepseek-v4.1-flash）成立，可以更好：### 4. 低 — 测试覆盖了主路径和两个反向用例，但漏了作者点名的组合和若干边界。已补 cached=true,gateway=null 用例和超过 400 文件用例、ADR 引用用例；二进制/重命名/selfCheck 集成属边界，沿用现有代码路径（blob 含 NUL 跳过，R 被 AMR 包含）
