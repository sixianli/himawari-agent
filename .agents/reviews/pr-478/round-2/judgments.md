# PR 478 第 2 轮复核的逐条判断

只用 DeepSeek，看 `3726dbdb1..4ddba2e49`。模型确认第 1 轮的修复都对，没有高。新报 1 条中、4 条低。

## 会出错、中（已改，第 3 轮复核）

- R2-ds1：网关的 `--control-root` 和这个人的 `binding.privateRoot` 是两处独立给的值，没有比较。两者不一致时不会越界（主服务的范围检查会拒绝），但错误要到主服务登记时才出现，原因也看不出来。改：Worker 经网关建完目录立刻核对目录等于 `privateRoot/<名字>`，不等就报 `SANDBOX_CONTROL_ROOT_MISMATCH`，不再往下走。新场景“gateway control-root-mismatch”：网关根换成另一个目录，Worker 只建目录、不准备 Job Host；去掉核对时失败（已验证）。

## 会出错、低（已改）

- R2-ds2：`--control-root` 是符号链接或不存在时，网关照常启动，之后所有控制操作报 `JOB_HOST_CONTROL_BINDING_INVALID`。改：网关主程序启动时要求 realpath 等于自身且是目录，否则写 `JOB_HOST_GATEWAY_CONTROL_ROOT_INVALID` 并以 1 退出、不建套接字。新用例覆盖符号链接和不存在两种；去掉检查时两条都失败（已验证）。
- R2-ds5：三处测试缺口。第 1 处：加假 Job Host 返回伪造签名的 inspect 回答，调用方必须拒绝；去掉调用方验签时失败（已验证）。第 2 处：网关套接字不存在时，错误是 `JOB_HOST_GATEWAY_UNAVAILABLE` 且不带 `code`，不会被当成“没有证据”。第 3 处（跨账号真跑控制帧）放进 PR③ 的测试机资格脚本：那时才有执行账号和 `--control-root` 的真实配置。

## 可以更好（不改，列给 Andy）

- R2-ds3：主服务登记时对同一目录查两次（先看是否规范，再取设备号和 inode）。这是改动前的顺序（先 realpath、后 lstat），保持不变；中间被换掉的目录会在抢“开始”时因设备号和 inode 对不上而失败。
- R2-ds4：同第 1 轮 R1-ds3，判断不变。
