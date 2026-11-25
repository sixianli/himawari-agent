## 本轮核对范围

- 本轮实际读了：`git diff 5875948..59c29967`、`git diff c912aa8..59c29967`、修复提交 `c73a70f7d` 全文，以及相关生产和消费代码。
- 本 PR（615）在这一段里只改了 `clients/apple` 的 5 个文件（`AttachSources.swift`、`ChatAttachments.swift`、`ImageDownsampling.swift` 和两个测试）加一个复核账本提交；`5875948..59c29967` 里其余改动是合并 `origin/main` 带来的 PR 620/624/626，不属于本 PR，不重新复核（只顺手核对了与 `prompt-prefix.md` 相关的 `[CLEAR-6]`/`[CLEAR-7]` 文档、检查器和测试一致）。
- 未跑测试（工具限制；作者说的 “Linux 401 个通过 / Mac 上 ImageIO 用例” **未核实**）；复核账本 `low-fix-refusals.jsonl` 被环境拒绝读取，内容 **未核实**。

## 侧重检查

查过并对照了这些路径：

- 不可信图片输入：相册 `loadTransferable(Data.self)` → `AttachReader.image(data:)` → `ImageDownsampling.jpeg`；文件导入先 `fileFits` ≤20 MB 再读 → 同样降采样。非图片数据返回 `nil`，界面报“读不了”。
- 资源耗尽：降采样已按最长边 4096 封顶，最坏约 4096×4096×4 ≈ 67 MB；但相册分支仍整份读原始文件、无大小上限（见意见 2）。
- 相机：系统 `UIImagePickerController` 已经把整张照片解码成 `UIImage`，本 PR 的降采样路径不经过相机分支（见意见 3）。
- 文件名/标签注入：`MessageAttachments.cleanName` 去掉 `" < > \r \n`；`bytes` 是十进制数字，不能闭合标签；服务端正则 `bytes="(\d+)"` 只接受非负整数。
- 不可撤销操作：本次改动只在内存里重新编码图片，不修改用户原始文件，没有新增删除/覆盖类操作。
- 规则文档一致性：`prompt-prefix.md` 的增量与 `tool-result-clearing.ts`、`namesRememberedValue`、`check-prompt-prefix.mjs` 的 `[CLEAR-6]`/`[CLEAR-7]` 一致（这一条属于合并进来的 PR 626，不是本 PR）。

## 意见

### 1. [中] 手机上传的 PDF 现在把“原 PDF 文件大小”写进 artifact 的 sizeBytes，Web 文件预览会按 2 MB 门槛误判“太大不给看”
文件：`clients/apple/Sources/HimawariChat/Attach/AttachSources.swift:42`、`clients/apple/Sources/HimawariCore/ChatAttachments.swift:135`、`apps/agent-service/src/production-uploaded-files.ts:115`、`apps/control-center/src/components/content-preview.tsx:84`（阈值在 `:17`）

问题：修复意见 3 后，手机上传 PDF 时 `<file bytes>` 从“抽取出的文字字节数”变成“原 PDF 文件大小”；服务端把这个值直接当成上传 artifact 的 `sizeBytes`。Web 文件库预览用 `sizeBytes > 2 MiB` 决定是否显示“太大”。手机上传的 PDF 抽取文字会被 `textCharacters` 截得很小，但原 PDF 常有 2–20 MB，于是这类文件在 Web 上会被误判为太大，文本预览失效。图片虽然也把 `sizeBytes` 改成原图大小，但图片预览分支不看这个值，暂不受影响。

证据（读代码证实的数据流）：

```swift
// AttachSources.swift:42
return ChatAttachment(name: name, content: .text(text, kind: .pdf), originalBytes: size)
// ChatAttachments.swift:135
bytes = attachment.originalBytes ?? Data(body.utf8).count
```

```ts
// production-uploaded-files.ts:46-47
if (EXTRACTED_TEXT_KINDS.has(file.kind))
  return { path: `${file.name}.txt`, kind: "document", mediaType: "text/plain" };
// production-uploaded-files.ts:115
sizeBytes: file.bytes,
```

```tsx
// content-preview.tsx:17,84
export const FILE_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
if (file.sizeBytes > FILE_TEXT_PREVIEW_BYTES) return { kind: "notice", id: "preview.tooLarge" };
```

说明：Web 自己上传附件时 `chat-composer.tsx:114` 也已经写 `bytes: file.size`，所以“原大小进 sizeBytes、预览按 2 MB 卡”是已存在的跨端问题；但本增量把手机上传也送进了同一套语义，手机 PDF 是这次新暴露的实际输入。浏览器点击效果未实测（推测会显示“太大”）。

建议：把“展示用原始大小”和“用于预览/限额的存储内容大小”分开。例如 `<file bytes>` 继续记原始大小，但 `ProductionUploadedFiles` 注册 artifact 时用实际保存内容的长度（读 `file.ref` 的 payload 后算字节数，text 用 UTF-8 长度），或者让 `content-preview` 不再拿 `sizeBytes` 当文本预览门槛。并补一条端到端用例：手机上传 >2 MB、抽取文字很小的 PDF，Web 仍能预览（用旧值会失败）。

### 2. [低] 相册选图仍把整份原始文件读进内存，降采样只限制了缩略图的解码尺寸
文件：`clients/apple/Sources/HimawariChat/Attach/AttachSheet.swift:99`、`clients/apple/Sources/HimawariChat/Attach/AttachSources.swift:24-26`

问题：上一轮意见 2 的“解码像素没有上限”已经修好：`ImageIO` 用 `kCGImageSourceThumbnailMaxPixelSize: 4096` 限制了解码尺寸。但相册分支先用 `item.loadTransferable(type: Data.self)` 把原文件整份读进内存，这里没有 `fileFits` 或大小上限；文件导入分支有 20 MB 检查（`AttachSources.swift:34`），相册分支没有。超大全景/RAW 照片仍可能在降采样之前造成内存峰值。

证据（读代码证实）：

```swift
// AttachSheet.swift:99
if let data = try? await item.loadTransferable(type: Data.self), let attachment = AttachReader.image(data: data, name: L.text("attach.photos")) {
```

```swift
// AttachSources.swift:24-26
static func image(data: Data, name: String) -> ChatAttachment? {
    guard let jpeg = ImageDownsampling.jpeg(data, quality: jpegQuality) else { return nil }
    return ChatAttachment(name: name, content: .image(data: jpeg, mimeType: "image/jpeg"), originalBytes: data.count)
}
```

这是残留问题，不是本次改动新引入的回归（改动本身让解码内存显著下降）。

建议：在取到 `Data` 后立即检查 `data.count`（或按 `PHAsset` 元数据在加载前拿大小），超过上限就 `failed(.tooLarge)`；把降采样移到主线程之外；如果可行，改用 ImageIO 的按需/文件源而不是整份 `Data`。

### 3. [低] 相机照片没有记录原始字节，`<file bytes>` 仍是重编码后的大小，和“图片记原始大小”的说法不完全一致
文件：`clients/apple/Sources/HimawariChat/Attach/AttachSources.swift:19-21`、`clients/apple/Sources/HimawariCore/ChatAttachments.swift:128`

问题：相机分支返回的 `ChatAttachment` 没有 `originalBytes`，`compose` 就退回 `data.count`，也就是 `UIImage.jpegData` 重新编码后的字节数，不是相机原图大小。因此“图片 `<file bytes>` 记原始大小”只对相册/文件图片成立，相机照片是例外。另外，本次把 fallback 从“上传后（可能已缩小）的 `payload.data.count`”改成“缩小前的 `data.count`”，相机照片在需要二次缩小时会报一个比实际上传内容更大的数字。

证据（读代码证实）：

```swift
// AttachSources.swift:19-21
static func image(_ image: UIImage, name: String) -> ChatAttachment? {
    guard let data = image.jpegData(compressionQuality: jpegQuality) else { return nil }
    return ChatAttachment(name: name, content: .image(data: data, mimeType: "image/jpeg"))
}
```

```swift
// ChatAttachments.swift:128
bytes = attachment.originalBytes ?? data.count
```

建议：如果要求所有图片都报原始大小，相机路径用 `PHAsset`（相册来源）或 `AVCapturePhoto` 的原始文件；否则在 PR 说明/文档里明确“相机照片报重编码后大小”，并考虑为相机也保留一个可解释的字节数。

### 4. [低] 新增自动检查没有覆盖生产接线，默认 4096 上限和 `AttachReader` 是否真的降采样/记录原始大小不会被现有测试拦住
文件：`clients/apple/Tests/HimawariCoreTests/ImageDownsamplingTests.swift:29`、`clients/apple/Tests/HimawariCoreTests/ChatAttachmentTests.swift:90-112`

问题：`ImageDownsamplingTests` 显式传 `maxPixels: 1000`，没有测试默认的 4096；`ChatAttachmentTests` 是手工构造 `originalBytes`，没有测试 `AttachReader.image(data:)` 是否真的调用降采样、是否真的把输入字节数写进 `originalBytes`。如果以后有人把 `AttachReader.image(data:)` 改回 `UIImage(data:)`，或把默认上限改坏，现有测试仍会通过。Mac 专用的 `ImageDownsamplingTests` 在 Linux 上整体跳过（`#if canImport(ImageIO) && canImport(CoreGraphics)`），本次 author 说的“Linux 401 个通过”覆盖不到它。

证据（读代码证实）：

```swift
// ImageDownsamplingTests.swift:29
let jpeg = try #require(ImageDownsampling.jpeg(try png(width: 8000, height: 2000), maxPixels: 1000, quality: 0.85))
```

```swift
// ChatAttachmentTests.swift:95
ChatAttachment(name: "照片", content: .image(data: Data(repeating: 1, count: 200), mimeType: "image/jpeg"), originalBytes: 4_800_000),
```

建议：在 Mac/iOS 测试里用一个大图走 `AttachReader.image(data:)`（或把它拆成可注入的纯函数），断言输出最长边 ≤ 默认 4096、且 `originalBytes == 输入 Data 的字节数`；再加一条不传 `maxPixels` 的用例把默认值钉住。反向用例可以是“把降采样换回 `UIImage(data:)` 时这个用例失败”。

## 上一轮意见核对

- 上一轮意见 2（解码像素无上限）：**针对相册/文件图片已改好**。`ImageDownsampling.swift` 用 `kCGImageSourceCreateThumbnailFromImageAlways` + `kCGImageSourceThumbnailMaxPixelSize: 4096`，不再 `UIImage` 全尺寸解码；但相册仍整份读原文件（意见 2）、相机仍走系统 `UIImage`（意见 3）。
- 上一轮意见 3（`<file bytes>` 不是原始大小）：**针对相册/文件图片和 PDF/文本已改好**。`AttachSources.swift:26/42/47` 分别写入 `data.count` 或 `fileSize`，`ChatAttachments.swift:128/135` 优先用 `originalBytes`；新增的 `theTagCarriesTheSizeOfTheOriginalFileNotTheReencodedOrShrunkOne` 在旧实现上会失败（旧值分别是 `payload.data.count` 和 `body` 的字节数）。带出的新问题是意见 1 的 Web 预览门槛；相机仍是例外（意见 3）。

## 作者说法逐条核对

- “停下只在有正在进行的回答（workingRun 非空）且输入框空着时出现”：**与代码一致**。`ChatView.swift:307` 用 `store.workingRun(in: threadId)` 决定 `stopAction`；`ChatInputBar.swift:23-45` 只在 `stop != nil && !canSend` 时显示停止，`canSend` 要求没有附件且文字非空。
- “被打断的回答后续流式文字不会再读；新回答（不再以上一条为前缀）重新开始读”：**与代码一致**。`HerReply.receive` 在 `interrupted` 为真时返回空，遇到 `!text.hasPrefix(source)` 时重置 `interrupted`；`ChatTalkSession.receive` 在主人说话时调用 `interrupt()`。
- “安静时段写入带读到的 version；版本冲突时重新读取并报错”：**与代码一致**。`QuietHours.swift:104-122` 传 `expectedVersion: hours.version`，`catch` 里先 `await load()` 再 `throw error`。
- “暂停记忆是 tighten（不弹确认），恢复是 change（要确认签名），由能力表决定”：**与代码一致**。`ClientCapabilities.swift:143` 为 `memory.settings.set` 配了 `tightenPayload: ["capturePaused": true]`，`ManageGateway.swift:64-73` 用 `requiredTier(payload:)` 决定是否带 `confirm`。
- “图片 `<file bytes>` 记原始大小”：**只对相册/文件图片成立，相机照片例外**（意见 3）。
- “选图不再全尺寸解码”：**对相册/文件图片成立，相机仍由系统整张解码**（意见 2、3）。

## 必答问题

1. **不改变模型已经见过的请求开头。** 本改动不碰系统提示、工具定义、历史消息或遮盖；模型能看到的变化只是“新追加的那条用户消息里的 `<file ...>` 行”，以及上传接口在发送前收到的图片内容。`bytes` 是在发送新消息时一次算定的，不是每轮变的值；消息按实际发出的内容存历史（规则 4、5），后续请求逐字节重放同一条消息，所以仍然只在末尾追加。规则依据：`.agents/instructions/prompt-prefix.md` 第 1、2、4、5 条。
2. **不会让同一段已存文字在不同请求里变成不同字节。** `originalBytes` 来自选中的文件字节数/文件大小，没有时间、随机数或无序集合；`<file bytes>` 是十进制数字。`ChatAttachment.id` 是随机的，但不进消息文本。图片的 JPEG 重编码只发生一次，之后存的是固定的标签文字；同一个已存消息重放时字节不变。
3. **有自动检查，但覆盖不完整。** 原始大小的反向用例是真的会失败：`ChatAttachmentTests` 的两条新用例在旧实现上会得到 `payload.data.count`/`body` 字节数而不是 `originalBytes`。降采样用例能抓住“忽略 `maxPixels`”的实现，但它没测默认 4096、也没测 `AttachReader` 的生产接线；且 Mac-only，Linux 的 401 个测试跑不到它（见意见 4）。
4. **逐个使用端核对：**
   - `originalBytes` 的产生处：`AttachSources.swift:26`（`data.count`）、`:42`/`:47`（`size`），都是非负整数。
   - 使用处 1：`ChatAttachments.swift:128/135` → `MessageAttachment.bytes` → `MessageAttachments.tag` 的 `bytes="..."`。
   - 使用处 2：服务端 `production-uploaded-files.ts:13` 正则 `bytes="(\d+)"`、`:28` `Number(...)`、`:115` `sizeBytes`；`sqlite-thread-artifact-operations.ts:106-107` 要求 `Number.isSafeInteger` 且 `>= 0`。只要是非负整数都接受；若未来有负数或非数字，正则不会匹配，服务端会静默不登记该上传附件（当前产生处不可能为负，但 `ChatAttachment.init` 本身没有校验）。
   - 使用处 3：Web `draft-attachments.ts:19` 的 `bytes="(\d+)"` 和 `data-export/chats.ts` 的 `[a-z]+="..."` 规则都能接受新值。
   - 使用处 4（本次发现的不适配）：`content-preview.tsx:84` 用 `sizeBytes > 2 MiB` 拦截文本预览；手机 PDF 的 `sizeBytes` 现在是原 PDF 大小，于是 2–20 MB 的手机 PDF 会被误拦（意见 1）。
   - 新增常量 `ChatAttachmentPlanner.maxImagePixels`：只被 `ImageDownsampling.jpeg` 的默认参数使用，没有别的使用端。
   - `ChatAttachment.init(originalBytes:)` 默认 `nil`，现有所有调用点都能编译并保持原行为。
