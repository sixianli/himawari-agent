# PR #294 第 1 轮判断（云端线程，经 Magpie）
会出错、已改：d1/g1（run 正则只认 UUID，生产是 run:+32 位十六进制，核对 thread-command-service.ts:49-56,223；改正则并加正向用例，旧脚本跑新测试 2 个失败）；d7（第 19 行补「只在 fast 模式、是上面 root 禁令的例外」，runbook 加指向）；g3（补 run、columns、journal 默认行数正向用例）；d3、d8（PR 描述改正：check 不跑该测试，64 用法错误、65 参数不合规则）；d6（低，回显改用 printf %q，加测试）。
可以更好、不改，等 Andy：d2 加真正执行远端 JS 的测试；d4 加 PRAGMA query_only；d5 heredoc 加引号；另有把测试接进 check:steps、runs-open 加 LIMIT。
未核实：生产 /opt/himawari/node/bin/node 是否存在及 node:sqlite 的 readOnly 可用，需 Mac 线程首次实跑确认。
