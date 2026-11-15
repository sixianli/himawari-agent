# PR 471 第 3 轮复核：逐条判断

- D1 成立，会出错，中高。`scripts/.dep-tmp.mjs`、`scripts/.dep2-tmp.mjs` 是我复现“WebKit encountered an internal error”时的调试脚本，被 `git add -A` 带进提交，已删除。
- D2 成立，会出错，中高。另跑 WebKit 40 次“卸载前已发出的请求再 reload”，0 次报错（加上之前 10 次共 0/50），但为了不让真浏览器用例去锁定浏览器的偶发行为，这个场景改为 `webkitReports: null`：只核对过滤结果，不断言 WebKit 报不报；I-97 改写为“本机 WebKit 50 次 0 次报错”。
- D3 成立，会出错，低。I-97 写明三处例外及理由（收集函数本身、只做证据记录的 `scripts/ci/browser-observation.mjs`、对比原始与过滤结果的真浏览器用例）。
- D4 成立，会出错，低。扫描逻辑抽成 `findDirectPageErrorListeners(root, allowed)`，新增临时目录夹具：放入两个违规文件必须报出、允许名单和非脚本文件不报；断网判定抽成 `expectedOfflineTransportError`，补正确主机加路径（含查询串）通过、错误端口、错误主机、错误路径、路径前缀相同但更长、非该格式、带前缀共 7 种拒绝。
- 推测里的格式风险随 D1 一起消失。

验证：单测 12 条通过；qualify-control-center-browser webkit、chromium 各跑一次通过。
