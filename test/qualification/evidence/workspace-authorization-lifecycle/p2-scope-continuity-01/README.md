# P2：单次批准与范围授权

本批修复安全只读长期 Grant 对后续新请求漏查动作类别/风险的问题，复用既有 ActionPolicy、Approval/Grant、SQLite 预约和 Handle 消费，不新增权限类别。

- 失败前：`himawari-scope-red-confirmed.log` 中合法低风险请求已经成功授权并消费一次，随后 HIGH READ 仍错误得到 ALLOW；另一矩阵的 CREATE_OR_UPDATE 也错误得到 ALLOW。具体写入内容单次批准的正向路径同次通过。
- 测试问题：`himawari-scope-red.log`、`himawari-scope-red2.log` 保留错误的接口名/字段和重复 Payload 身份问题；这些不计产品缺陷，不能据此判断权限安全。
- 修复后：生产 Coding → FileReadServices → ActionPolicy/Approval/Grant → SQLite 预约/Handle/consume 联测，独立读回消费及 Handle 数量。精确内容批准不覆盖新内容，同调用身份改内容被拒绝；范围内安全 READ 可以复用，风险、动作、资源、版本、接收方或预算越界不能复用。真实搜索策略入口派生独立单次 Grant，保留先前拒绝。
- 定向及消费者：5 文件、70 项通过，包含新联合测试、搜索策略、内存治理、SQLite 额度与派发复核。类型、范围 Biome、依赖边界、v0.2 覆盖/不变量、秘密扫描及 CI policy 通过。
- [标准构建](standard-build-result.json)通过（177,668 ms）；[完整测试](standard-test-result.json)通过（757,912 ms）：252 文件、4,056 项，零失败/跳过。[本地总报告](standard-local-summary.json)为 local_passed，托管 CI 未执行。
- [1,090 个冻结输入](frozen-inputs.json)全部读回一致，构建产物记录与当前源树摘要一致。testedSha 是 `3dee934` 加本批未提交改动，不能解释为只测试原提交。
- [41 份原日志归档](raw-logs.tar.gz)共 3,438,185 字节；逐文件字节及 SHA-256、拒绝重复覆盖、源码一致性见[验证元数据](verification.json)。四份 Runbook 静态合同及严格文档检查通过。

真实边界为 SQLite、正式 Run/审批、授权服务、受保护 Payload 和调用消费；能力库存、模型、checkpoint 的内存索引与最终 Worker 是受控边界。本批不提供文件效果、浏览器、真实模型或跨平台停止资格证明。全库 format/lint 实际执行但仍被原有两份未跟踪原型脚本阻塞，本批范围检查通过。

复现入口：

```sh
npx vitest run --config vitest.workspace.ts --project integration test/integration/authorization-scope-continuity.test.ts test/integration/public-search-authorization.test.ts
node scripts/ci/local.mjs --check test --output .ci-output/p2-scope-continuity-01
```

重跑使用新输出目录，不覆盖旧证据。日志归档复用现有 `scripts/ci/artifact-archive.py`，交付时核对归档字节及重复覆盖拒绝。
