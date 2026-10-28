---
status: "active"
document_type: "backlog"
record_id: "BL-20261028-008"
record_state: "open"
date: "2026-10-28"
updated: "2026-10-28"
priority: "normal"
item_type: "enhancement"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 找记忆的向量化改在生产机本机计算

## Summary

向量化请求经 Vercel 网关从东京绕到悉尼再到美国，占找记忆一步 88%；改在本机用 Qwen3-Embedding-0.6B 计算，一次约 0.09 秒。

## Origin

- 2026-10-28 线程“查清记忆搜索为何耗时 1.4 秒”。Andy 2026-10-28 21:30（日本时间）看完方案后说：“这个以后做吧，记下来”。
- 背景和根因见[工程案例库案例 42](../engineering-casebook.md#case-memory-embedding-route)。

## Notes

- **现状数据**（生产最近 40 轮，2026-10-28）：找记忆中位数 1580 ms，其中向量化（把一句话变成 4096 个数字，用来比对意思相近的记忆）网络请求 1392 ms；响应头 `x-vercel-id` 为 `hnd1::syd1`，即 Vercel AI Gateway 把东京的请求转到悉尼处理，再发给美国的 DeepInfra。PR #82 改用 base64 返回格式后，生产机同时段探测约 1048 ms → 769 ms；剩下的主要是跨洋绕路，网关路由我们控制不了。
- **方案**：服务进程启动时加载 Qwen3-Embedding-0.6B 的 int8 量化版（ONNX 格式，约 600 MB），每次找记忆和写记忆都在本机 CPU 上算向量，不再联网，对话内容也不再发给第三方（符合产品愿景“自有优先、数据自持”）。不另开进程或端口，不需要显卡。
- **云端实测**（4 核，`@huggingface/transformers` 3.7.5，`onnx-community/Qwen3-Embedding-0.6B-ONNX` 的 q8）：加载约 20 秒，一次查询 84–105 ms，进程约 1.4 GB 内存；输出 1024 维。
- **代价**：生产机常驻多占约 1.4 GB 内存（当时可用 6.6 GB）；上线包约大 600 MB；新增一个运行模型的依赖（版本写死）；向量维度从 4096 变为 1024，配置 `memory.dimensions` 和现有记忆、对话片段的向量都要重建；新模型文件下载要先经 Andy 同意。
- **准确度**：模型卡上 MTEB 多语言平均分 0.6B 为 64.33，8B 为 70.58。开工前先用记忆评测集对比两种模型找记忆的结果，差距明显就不换，把对比交给 Andy。
- **开工条件**：Andy 说开始；动手时写 ADR（换向量模型和供应商属于架构决定）。
