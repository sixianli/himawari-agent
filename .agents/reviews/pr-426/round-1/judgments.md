# PR 426 第 1 轮逐条判断

- ds-1（deepseek-v4.1-flash）「代码越过了现有 ADR 0229 和设计文档的明确决定」：不成立。依据：ADR 0247（PR 405，分支 claude/project-thread-ppm8gq，front matter amends: docs/adr/0229-native-apple-clients-and-device-api.md）已修订 ADR 0229 决定第 3、4 条，改为全原生加能力表；本 PR 照 ADR 0247 实现
- ds-2（deepseek-v4.1-flash）「`proactive.pause` 定为“收紧”后，只拿设备密钥就能在主人不在场时静默关闭全部主动提醒」：不成立。依据：设计文档 docs/execution/specs/2026-11-11-apple-device-body-design.md 第 281 行（PR 405 提交 2fa19776）明确写“暂停系统主动提醒另加一个只有方向、不带别的字段的消息类型，登记成收紧”，设计线程 11-12 确认；收紧每次写审计，往回打开要面容。这是已批准的产品取舍，不是实现错误
- ds-3（deepseek-v4.1-flash）「审计是可选项，且“先执行、后写审计”」：成立，中、高，已改。
- ds-4（deepseek-v4.1-flash）「`memory.page.viewed` 是写命令，却登记为“读”档」：成立，低，已改。
- ds-5（deepseek-v4.1-flash）「测试覆盖缺口：文本上传的拒绝路径、v1 转发、审计失败路径没有反向用例」：成立，低，已改。
- ds-6（deepseek-v4.1-flash）「新的线上值（占位值 `"device"`、网关请求体字段）没有进入生成的客户端清单」：成立，低，已改。
- ds-7（deepseek-v4.1-flash）「进程内随机挑战密钥和多进程/多副本部署不兼容」：不成立。依据：设备接口只由 agent-service 里一个 buildHttpGatewayServer 实例提供（apps/agent-service/src/production-http-composition.ts 的 routeOptions 只装一次），生产只有一台机器；设计文档第 285 行写明“服务重启后没用掉的挑战值作废，手机重取一次”
- ds-8（deepseek-v4.1-flash）「作者“收紧……正文必须恰好是规定的值”的说法不覆盖所有 `tighten` 类型」：成立，低，已改。
- ds-9（deepseek-v4.1-flash）「手机通过网关提交 `thread.message.submit` 时可以自带 `occurredAt`」：成立，中、高，已改。
- glm-1（glm-5.3-flash）「能力表登记了 v1 网关的 8 种类型，生产装配里没有 v1，手机的这些请求一律 503」：成立，中、高，已改。
- glm-2（glm-5.3-flash）「「改/收紧」的完成审计写在命令生效之后，审计写入失败会让客户端看到 500 但改动已发生」：成立，中、高，已改。
- glm-3（glm-5.3-flash）「`proactive.pause` 是读-改-写，无事务，并发会丢更新」：成立，低，已改。
- glm-4（glm-5.3-flash）「挑战值在命令执行前就被消耗，命令随后失败时要重新面容」：不成立。依据：一次性是设计要求（设计文档第 285 行“一个挑战值只能用一次”）；先记防重放再执行才能挡住并发重放，测试“同一个挑战值并发用两次，只有一次成功”依赖这一点
- glm-5（glm-5.3-flash）「几条路径没有任何测试覆盖」：成立，低，已改。
- glm-6（glm-5.3-flash）「实际这两个键也**可以完全不填**」：不成立。依据：不填时由网关合约决定：thread.delete_permanently 等要求这两项的类型 schema.parse 会以 400 拒绝（thread-contracts-v3.ts:244-245 是 machineString），不需要它们的类型本来就没有这两个键；行为正确，只是描述措辞
