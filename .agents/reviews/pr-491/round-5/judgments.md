# 第 5 轮判断

复核模型：DeepSeek v4.1 flash。六条意见全部成立：三条中、三条低，没有高。

## 1. 拉取失败时静默用旧的 origin/main

- 判断：成立，会出错，严重度 中、高
- 处理：已修：拉取失败以 `FETCH_FAILED` 退出，除非显式传 `--base`；加用例（用坏的 http.proxy 让拉取失败）

## 2. 打包只核对摘要，不核对迁移名

- 判断：成立，会出错，严重度 中、高
- 处理：已修：S0 多出 `migrationNames`，打包缺失或带冒号时拒绝（`PACKET_S0_MIGRATION_NAMES_INVALID`），`--applied` 用 `编号:摘要:名字`，名字对不上报 `APPLIED_MIGRATION_RENAMED`；已核对 95 个旧迁移的名字都等于文件名后缀

## 3. 快照只按个数校验

- 判断：成立，会出错，严重度 中、高
- 处理：已修：快照带 `schemaFingerprint`，创建时从快照库和源库各算一遍，核对时和当前库、快照库都比；加“指纹对不上被拒、对上才放行”的用例；一处手写快照的测试夹具补了字段

## 4. 缺摘要时跳过核对

- 判断：成立，低
- 处理：已修：`APPLIED_MIGRATION_DIGEST_MISSING`，加用例

## 5. ADR 说写日志但代码没写

- 判断：成立，低
- 处理：已修：ADR 改成“账本 sequence 记下实际顺序，目前不另写日志”

## 6. 规则文件还提 SUPPORTED_SCHEMA_MAX

- 判断：成立，低
- 处理：已修：改为现行的三个审计常量
