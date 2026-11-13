# PR 462 作者说明（第 1 轮）

## 问题和目标

Himawari 要从“一台机器只服务 Andy 一个人”变成“同一个程序里每人一份独立的数据和配置”（ADR 0234）。本 PR 是这件事的任务 B，只加部件，不接进运行中的服务：

1. 一份独立的名册数据库 `roster.sqlite`，记录有哪些人、各自的编号、邮箱、登录身份摘要、状态、每月上限设置、审计记录和一个修订号。
2. 从一份共用的基础配置，为每个人合成他自己的配置（换编号、换状态目录及其下路径），合成结果必须原样通过现有的严格配置解析器，不能新增任何配置键。
3. 密钥按用途分成“每人一份”和“共用”两类：默认每人一份，只有明确列出的才共用；出现没归类的用途就拒绝。
4. 管理命令（admin-cli）能用 `--tenant <编号> --shared-root <共用目录>` 指定对哪个人执行，代替 `--config <路径>`。

## 约束

- 单人运行路径不能有任何行为变化；不改 product 数据库的表；名册用自己的迁移序列。
- 生成的编号必须同时通过：配置解析器、`createOwnerId` 等、网关合约的 `machineString`、真实数据库迁移加 `initializeProductIdentity`。
- 代码和样例里不能有写死的额度数字。
- 状态目录不能是别人目录、包含别人目录或在别人目录里面。

## 作者的说法（请核对）

- `synthesizeTenantConfiguration` 只改值不改键；替换编号时按“前后不是字母、数字、点、下划线、连字符”的边界匹配，所以不会误改包含同样文字的长名字；共用密钥那几项原样保留。
- 名册的修订号由触发器在 tenants、limits 增删改时加一，usage_monthly 写入不加。
- `resolveTenantArguments` 把 `--tenant x --shared-root y` 原地换成 `--config <那人目录>/configuration.json`，所以按位置解析参数的命令（例如 `sandbox list --config …`）也能用；执行前核对存着的配置里的三个编号和状态目录与名册一致。
- 只为 `payload-encryption`、`identity-csrf` 生成随机密钥；文件用 `wx` 打开，不会覆盖。
- 测试：`apps/admin-cli/test/tenant-roster-cli.unit.test.ts`、`packages/persistence-sqlite/test/roster-store.contract.test.ts`、`test/tooling/tenant-secret-purposes.test.ts`。
