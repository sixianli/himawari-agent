# PR 381 作者说明：记忆向量改在本机算（P3-1，ADR 0224）

## 问题
记忆检索的向量原先只能经外网嵌入服务（Vercel AI Gateway 上的 Qwen3-Embedding-8B）计算，主人的问题和记忆正文都要发给第三方。断网时检索的向量一路不可用。

## 目标
- 新增本机嵌入（provider `local-onnx`，onnxruntime-node 跑 jina-embeddings-v5-text-nano int8，1024 维），外网服务保留为可选。
- 每个嵌入模型一份档案（provider+model 定唯一），档案带聊天和主动检查两个相似度门槛；切换模型只改配置里的嵌入描述。
- 本机模型文件放在 `<stateRoot>/models/<model>/<artifactSha256>/`，载入时按 manifest 校验摘要；上线包检查和上线前检查确认文件已装好。
- 重建索引同时清掉每日摘要的旧向量。
- 修 P3-2 遗留：嵌入期间本轮被取消时，不再记“检索降级”决策记录。
- 写 ADR 0224 和威胁模型文档；加自动检查证明恢复点备份和数据导出不含索引。

## 约束
- 嵌入请求照旧经统一出口（egress wrapFetch），本机也走同一层，用量按 0 费用记。
- 不改检索结构（三路融合不变）。
- 不加代码注释。发给模型的请求开头不得因本改动在已有对话里变化。

## 作者的说法（请核对）
1. 本机嵌入不改变聊天模型请求的任何字节；嵌入只影响选中哪些记忆，选中的记忆本来就放在最后一条用户消息里。
2. strict-configuration 只对已知 provider（local-onnx、vercel-ai-gateway）校验档案和维度，其他 provider（测试用假实现）不受影响；artifactSha256 只允许 local-onnx。
3. 上线包的 `__PKT_TARGET_EMBEDDING_JSON__` 被 make-packet 校验为不含 `'` 和 `\`，所以嵌进 Python `json.loads('…')` 和 JS 字面量都安全。
4. 取消检测：`scope.getStore()?.signal?.aborted` 为真时 onVectorFailure 不触发；真实失败仍触发。
5. 备份加密整库（含索引），导出不读索引表；两条集成测试有正向对照。
