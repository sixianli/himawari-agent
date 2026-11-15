# PR 567 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1（中）第 6 条“省掉 integration-1 等 runner 的 9 到 15 分钟”与同一份证据里的 ARM 占用时间矛盾。核对 ci-runs-2026-11-15.md 的时间属实。已改写计划：收益要先量，改提 integration 分三份、第三份放 ARM。；触发：照文档估收益；后果：把 9 到 15 分钟当成计划收益，实际按这两次数据最多约 4 分钟
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2（中低）第 3 条把 `ci/quality-policy.json` 的定时开关当成覆盖率夜间任务的证据。quality-policy.json 管的是 Quality 工作流。已改为引用 ADR 0267 第 83 行和“没有量覆盖率的定时工作流”。；触发：核对覆盖率是否有定时任务；后果：引用了不相干的证据；判低理由：文档里引用或描述不准，不影响任何程序，读者打开引用就能发现
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3（中低）takeaway 第 7 条说“这里靠定时检查发现”runner 不领活，但仓库里没有这个定时检查。看护是 claude.ai 项目的定时任务，不在仓库。已写明。；触发：找仓库里的看护检查；后果：以为仓库里有；判低理由：文档里引用或描述不准，不影响任何程序，读者打开引用就能发现
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4（低）上一轮第 6 条仍漏了 `main/confirmation`。main.yml confirm 作业 runs-on ci-vps。已补。；触发：容量计算；后果：漏 main/confirmation
- 5（deepseek-v4.1-flash）成立，会出错，低：### 5（低）第 4 条把 17/25/16 分钟写成可由 `ci-runs` 核对，但该文件只有作业起止时间。已在 ci-runs 补上按作业日志时间戳算的每步用时（16.6/25.4/15.8 分钟）和作业号。；触发：核对 17/25/16；后果：在证据文件里找不到
- 6（deepseek-v4.1-flash）成立，会出错，低：### 6（低）“让 ARM 自己出产物”还缺一个前提：当前平台清单不接受 linux-arm64 产物。platforms.mjs:15 产物平台清单只有 macos-arm64、linux-x64。已补。；触发：把 ARM 自己出产物当成简单替代；后果：低估工作量
- 7（deepseek-v4.1-flash）成立，会出错，低：### 7（低）takeaway 第 1 条“每一项优化都先从 GitHub 接口读作业起止和 runner 名”不成立。已改写。；触发：照要点只看 API；后果：忽略日志和本地计时
- 8（deepseek-v4.1-flash）成立，会出错，低：### 8（低）作者说“只新增 ci-speedup-lessons.md”，实际本轮还新增了 ci-runs 和复核记录。已在第 3 轮材料里更正。；触发：按材料确定复核范围；后果：漏看 ci-runs
