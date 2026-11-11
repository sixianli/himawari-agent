# 第 1 轮复核判断（PR 387）

- 中、高（已改）：D1 评测生成的 JSON 和 biome 格式不一致，biome.json 不再检查 evals 下的 JSON；D2/G1 Windows 上起不来 biome，改用 node 跑 biome 入口脚本；D3/G5 默认占位值改回 proxy-injected。
- 低（已改）：D5 补测试；D6 “21 步”改为“全部步骤”。D4 检查工作区而不是提交，和已有边界检查一致，不改。
- 不成立：G2 lessons.md 里的 SHA 是历史上本机钩子的记录。
- 可以更好（不改）：G3、G4。
