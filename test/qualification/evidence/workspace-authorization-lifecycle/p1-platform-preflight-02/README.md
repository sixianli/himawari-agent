# 平台前置核验与探针安装入口修复

本批复核当前 Mac 原生 SRT 路径，未切换后端或部署。

原命令 `node packages/runtime-sandbox/scripts/probe-job-host-control.mjs` 在构建后仍失败，见 [原始日志](mac-control.log)：导入 `dist/node-build` 后沿 workspace exports 回到源码，Node 无法解析 `ports/index.js`，尚未启动沙箱。将两个入口改为 `dist/node-runtime` 的正式安装模块，避免依赖开发目录的模块解析偶然状态。

同一命令重跑的 [结果](mac-control-packaged.log)覆盖七个真实 Job Host 场景。未启动预约可核验释放；Stop 和 Worker 崩溃之后的脱离进程组后代在 300ms 观察窗口各继续写入 28 字节，均保持 `cleanup=unknown`，未出具释放证明。最长 4 秒的合成子进程和专属临时目录由原探针清理。完整安装资格仍为 false。构建命令和输出见 [build-node.log](build-node.log)，相关源码与产物摘要见 [result.json](result.json)。

这确认了现有停止能力的限制和保守保护，没有证明任意 Mac 后代可停止。现行 [SRT 设计](../../../../../docs/execution/specs/2026-09-07-srt-unified-execution-design.md)已明确接受首批 Mac 的尽力停止与未知隔离，因此不从本次结果自动推导必须启用 native helper/容器的授权。Linux 本次未重跑；原证据保留在 [前批](../p1-platform-01/README.md)，最终双平台资格仍待执行。

对实施顺序的影响：第2批平台判定为 **inconclusive（完整停止能力）/verified（已执行场景的保守拒绝）**。继续不依赖错误释放的页面资源事实、历史读取与恢复接入；不能把 unknown 改为 confirmed 来通过验收，也不能把后续开发通过写成 Mac 完整资格。
