# PR 633 复核材料

只改一行测试：apps/agent-service/test/tool-read-only-offer.unit.test.ts 的只读工具清单补上 PR 629 新增的只读工具 memory_open（main 上这条测试因此变红）。

作者说法：
1. memory_open 在 production-tool-actions.ts 里是 READ_DEFAULTS 的只读行，应出现在只读运行的工具清单里。
2. 这个改动不改任何发给模型的内容，不会改变模型已经见过的请求开头。
