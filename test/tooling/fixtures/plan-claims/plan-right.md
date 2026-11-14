# 方案片段：对外遮盖的占位编号

- `packages/sensitive-capture/src/redaction.ts` 里的 `maskSensitiveTexts` 一次处理一批文本，对外遮盖时同一个值在整批里得到同一个标签。
- `maskSensitiveTexts` 输出前把占位编号去掉，所以同一段文字放在不同位置遮成相同的字节。
- 同一文件导出了 `maskSensitiveText`，它只处理单条文本。
