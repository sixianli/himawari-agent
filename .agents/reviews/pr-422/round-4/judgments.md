# PR 422 第 4 轮逐条判断

没有“会出错”的意见。这一轮只看再次合入 main（含 PR 431）时 `ci/security-exceptions.json` 的冲突解决：main 删掉的 5 条没有回来，main 其余条目和 reviewEvidence 文字没有丢，本 PR 重登和新增的条目命中的都是 bearer-token、jwt-token，不受 main 新的环境变量引用规则影响。模型说它没能运行测试；线程自己跑过 test/tooling/security-published.test.mjs（用真实台账和已安装依赖逐条核对 fileSha256 和命中）、security.test.mjs、security-review.test.mjs 共 142 个用例，以及 npm run check 50 步，都通过。

- r4-ds-1（低，可以更好）：`sourceProofSha256` 只校验格式，没有和真实 tarball 的 SHA-256 核对。属实，是原有的缺口，不是这次引入的；本 PR 的两个新值由脚本从 npm tarball 算出，tarball 的 sha512 等于锁文件 integrity。不在本 PR 改校验逻辑（那是 CI 线程的范围），列给 Andy。
- r4-ds-2（低，可以更好）：四条新的 mcp-* 条目里 `expiresAt` 排在 `path` 前面，和其余条目的字段顺序不同。属实，只是字段顺序，JSON 含义和所有读取方不受影响。不改：改了要再花一轮复核，列给 Andy。
