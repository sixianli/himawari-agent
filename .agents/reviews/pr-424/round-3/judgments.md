# PR 424 第 3 轮复核判断

只用 DeepSeek。四条中高全部修改；按规则三轮后仍有中高，先报 Andy 再决定是否跑第 4 轮。

| # | 意见 | 判断 | 处理 |
| --- | --- | --- | --- |
| 1 | DEBUG 示例数据在另一个文件里写 ChatStore 的 `private(set)` 属性，macOS 上 HimawariChat 编不过 | 会出错·中高 | 七个属性改成 internal(set)，示例代码在同一模块里可写；Linux 上界面目标编不了，Mac 上第一次截图前的编译就是这道检查 |
| 2 | `executionRecords` 把“没有投影记录但还有下一页”当成错误，会拒绝合法的服务端分页 | 会出错·中高 | 只要求 nextSequence 前进，空页继续翻；测试 executionRecordsKeepPagingPastAPageWhoseEventsWereAllFilteredOut |
| 3 | `ui-review.sh` 没有 iOS runtime 时会静默退出，不会打印设计好的错误信息 | 会出错·中高 | 取运行时改成 if ! 判断并打印 UI_REVIEW_FAILED；开头检查 xcodebuild -version |
| 4 | 快照阈值会让真实回归蒙混过关；动效场景在 `--check` 中完全不比对 | 会出错·中高 | 阈值改为每通道 3/255、像素比例 0.05%，README 写明拦不住的范围；动效录屏不自动比对，写明交设计线程人工看 |
| 5 | `--approve` 的破坏性和不完整性，以及录屏输出没有被忽略 | 会出错·低 | --approve 和 --check 都要求每个静态场景浅色、深色两张图齐全；.gitignore 加 latest/ 和 *.mp4 |
| 6 | README 说示例时钟固定，但 `answering()` 使用 `Date()` | 会出错·低 | 改用固定的 now |
| 7 | `deviceName` 的“去控制字符”只去掉 C0 和 DEL，未去 C1/双向控制符 | 会出错·低 | 再去掉 C1、零宽和方向控制符、BOM；测试改名并加用例 |
| 8 | `becameActive` 的“回到前台再试”漏掉一种状态 | 会出错·低 | 读不到的状态单独成 keysUnreadable，回到前台无条件 restore |
| 9 | keysUnavailable 的界面文案不是“钥匙读不到”，且 storage 失败也复用了这个状态 | 会出错·低 | 新增 keysUnreadable：标题“暂时读不到这台 iPhone 的密钥”，说明配对和对话都还在，按钮是重试；本机存储失败沿用旧状态，改动前就如此 |
| 10 | status 类型的 waiting 在没有工具步骤时会显示成“思考中” | 会出错·低 | 没有工具步骤时用这条记录本身组成等待项，文字为空时显示“等你点头”；测试 aRunSuspendedBeforeAnyStepStillWaits |

推测部分：review 记录排在 suspended 之后会隐藏等你点头，服务器 runtime.suspended 会挂起整轮运行，之后要等批准才有新记录，暂不改；boundedString 的口径已在 PR 404 validation.ts 第 89 行核对。
