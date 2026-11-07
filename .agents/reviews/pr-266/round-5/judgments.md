# PR 266 第 5 轮判定

只跑了 DeepSeek，费用 0.0387 美元，累计 0.2819 美元。

| 编号 | 模型说法 | 判定 | 处理 |
| --- | --- | --- | --- |
| D1 | 不再要求 `const originals` 块存在 | 成立，会出错，中；第 4 轮改法引入的倒退 | 找不到块时报 `PROBE_BOOTSTRAP_DIGESTS_NOT_FOUND`；补“多行条目但没有 originals 声明”的用例 |
| D2 | 没核对 `built` 和 `source` 的文件名对应 | 成立，会出错，低 | 要求 `source` 的文件名去掉 `.ts` 后等于 `built` 去掉 `.js`；补用例 |
| D3 | CRLF 换行时 JS 和 Python 的正则读法不同 | 成立，会出错，低 | bootstrap 含回车时报 `PROBE_BOOTSTRAP_LINE_ENDINGS`；补用例 |

有一条中级意见，改完再复核一轮。
