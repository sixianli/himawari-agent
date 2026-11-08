# PR #302 第 2 轮复核：核实后的判断（提交 a2effa3c，本轮 0.195 美元，累计 REVIEW_SPENT_TOTAL 0.3217 美元）

经 Magpie，两模型，High。原文见同目录。第 1 轮的高（生效 512 MiB）已修好：两个模型都确认 cloud-seal.mjs:380 现为 1073741824，新测试会在清单回退时失败。没有再发现"高"。

## 会出错？
1.（DeepSeek"中"，我判低）最坏内存不是 3×1 GiB：每个 run 有 command 和 file_write 两个沙箱会话（production-sandbox-execution-v2.ts:135，Promise.all 同时预热），各自按 plan 上限观察。逻辑成立，但只有 bash 后台命令与 write/edit 同时都吃近 1 GiB 才会到 2 GiB，file_write 实际很小；SRT 本来就是"观察后停止"而非硬配额。建议：不改代码，只把 PR 说明里"最坏 3×1 GiB"改成"最坏约 6×1 GiB（每个 run 两个会话），实际远低于此"，并如实写进交付报告。
2.（低）加载部署快照时没有"绑定上限 ≥ 常量"的运行时校验：若升级时沿用旧签名产物，生效值静默取 min，仍是 512 MiB，无任何告警（两个模型都提）。这是"可以更好"，不是会出错——模板已有测试守住，且上线包本来就由 cloud-seal 重新生成；建议加启动时一条诊断日志，由 Andy 决定要不要。
3.（低，测试）sandbox-memory-manifest.test.mjs:24-29 的"is rejected"用例只测正则助手，措辞夸大；主用例（第 18-22 行）才是真正的门槛。建议改名；改动很小，可用 --accept-low 记账（若适用）。
4.（低，测试）service-main.ts:1342 和 production-worker-composition.ts:263 的接线仍无直接断言；min 逻辑已有单测。可选。
5.（低，推测）容器路线（非 SRT）已有 ready 环境从 512 MiB 扩到 1 GiB 会抛 EXECUTION_ENVELOPE_EXCEEDED，SRT 路线会按 policyDigest 轮换。生产 backendRef 是 srt，未核实其他部署。不改。
6.（低）hermes-*-seal.mjs（约 10 个）、test/qualification/sandbox-install-restart-model.mjs:433 仍写 512 MiB；它们不是生产打包路径，但若被用来做资格验证会显示旧上限。建议确认是否仍在用，不改或标注。

## 必问问题
- 请求开头：不变（两模型一致，prompt-catalog 无内存文字）。
- 同文字不同字节：不会。
- 反向用例：min 逻辑和清单一致性有；接线无。
- 其他使用点：容器路线读绑定值，已被新清单覆盖；其余 512 MiB 在非生产脚本。

## 总体
没有剩余中、高的"会出错"意见（第 1 条我判低，只需改说明文字）。建议：改 PR 说明/测试名后，由 Andy 定合并，或再复核一轮（第 3 轮）。
