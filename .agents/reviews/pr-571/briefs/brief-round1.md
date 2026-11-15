# PR 571 复核材料

问题：第二十九次上线（main 08f181e5）在停服前的 S6_ACCEPTANCE 失败。报错原文是 `RESOURCE_SAMPLING_FAILED_SCENE_RETAINED_NO_AUTOMATIC_DELETION`，同时 resources 阶段报了 `[Errno 2] No such file or directory: '/tmp/hy5ct/r8-use-RByZBv/3/private/node-compile-cache/v22.22.3-x64-9de703df-999/e283c256.ktzuYx'`。scripts/delivery-mode/packet-template/acceptance/cloud/run-stage-03.py 的 Resources 采样器每 5 秒用 directory_bytes（os.walk 加 lstat）统计验收临时目录的大小。Node 的编译缓存临时文件被列出之后、lstat 之前被删掉了，采样器把这个 FileNotFoundError 记进 errors，结果整次验收判为失败。

做法：新增 file_bytes。遇到 FileNotFoundError 按 0 字节计，其他异常照旧抛出。directory_bytes 改为调用它。test_make_packet.py 新增 AcceptanceScratchSamplingTest：用 ast 取出真实的两个函数，模拟“列出后被删”和“权限错误”两种情况。同时更新 INTENDED_CHANGES，并在事故清单加 I-107。

请特别查：
- 忽略 FileNotFoundError 会不会掩盖真正的问题，例如临时目录整个被删、或者统计偏小导致越过磁盘门槛。
- self.scratch.exists() 和 os.walk 的其他竞态。os.walk 默认忽略目录列出错误。
- 包里有没有其他副本或摘要清单（例如 OWNED-SHA256SUMS、cloud-inputs 的摘要、basis-04 下的副本）需要同步更新，以及出包检查 verify-packet-consistency 会不会因为摘要变化而拒绝。
