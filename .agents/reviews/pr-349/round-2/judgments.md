# PR 349 第 2 轮复核判断

## 成立，已改

- r2-ds-1（中，线程判中、高）：`main` 调用新函数这一行没有测试。已改：`test/tooling/policy.test.mjs` 新增 `[I-91]` 用例，走 `policyMain(["--root", 临时仓库])`，把审阅记录版本改成 0.0.1，要求报 `Install-script review version differs`。反向验证：临时注释掉 `check-policy.mjs` 里的调用行，该用例失败；还原后通过。
- r2-ds-2（低）：事故行证据改成旧锁文件实际首错 `Install-script review for a package missing from package-lock`（首条过期嵌套记录）。依据：对 `origin/main` 的旧 `ci/toolchain-lock.json` 运行新函数，输出就是这句。
- r2-ds-3（低）：新函数补核对 `review.name` 等于路径里最后一段 `node_modules/` 之后的包名，并加夹具反向用例。真实锁文件 5 条记录全部通过。

## 不成立

- r2-ds-4：新函数对全部平台的带安装脚本标记的包都要求审阅，比 `auditInstalledDependencies` 严。这是有意的：现有 fsevents 两条记录就是未安装平台的可选包也要先审阅；此刻没有任何输入会误伤合法锁文件（真实锁文件的正向用例通过），出现新的可选安装脚本包时报错并要求补审阅，是想要的行为，不是错误结果。
