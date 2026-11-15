## 本轮范围

核对 `5ccc248..aa14fca` 增量。其中 `9415310..aa14fca` 是 PR 538 自身改动；`5ccc248..9415310` 是合并 main 带入的 PR 454/537 内容，前几轮已复核，本轮只在其触及本次路径时跟查。重点读了 `device-api-routes.ts`、`http-gateway-server.ts`、`production-data-export.ts`、`production-http-composition.ts`、`browser-thread-files.ts`、`device-download.test.ts` 和设计文档。

## 上一轮意见核对

- 意见 2（文件 id 含冒号、标准 URL 编码被路由挡掉）**已修好**。`packages/platform-node/src/device-api-routes.ts:73` 新增 `FILE_ID_SEGMENT`，允许 `%3A`/`%3a`；`test/integration/device-download.test.ts:147-153` 增加了编码后文件编号的正向用例。旧正则下该用例必失败（`%` 不被接受），因此这个正向用例确实能守住修复。
- 意见 4（文档仍写“设备接口没有导出数据”、新值清单缺路由）**已修好**。`docs/execution/specs/2026-11-11-apple-device-body-design.md:231-232` 补了两条路由，`:234` 改为“没有发起导出”，`:715` 新值清单补了 `exportId`/`fileId` 及两端校验和测试位置。

## 发现的意见

### 1. 低：新增的 `%2F` 反向用例不能证明路径白名单真的拒绝编码斜杠

- 文件: `test/integration/device-download.test.ts:154-155`；`packages/platform-node/src/device-api-routes.ts:73,125`；`packages/platform-node/src/browser-thread-files.ts:185,135-136`
- 问题: 该用例只断言状态码 `>= 400`。即使白名单回归成允许 `%2F`，请求参数会被解码成 `a/b`，随后查不到该 artifact 也返回 404，用例仍然通过。
- 证据:

  ```ts
  const slash = await get(h, client, "/api/device/v1/files/content/a%2Fb");
  expect(slash.statusCode).toBeGreaterThanOrEqual(400);
  ```

  ```ts
  const FILE_ID_SEGMENT = "[A-Za-z0-9](?:[A-Za-z0-9._:-]|%3[Aa]){0,127}";
  ```

  `notFound()` 固定抛 `PORT_ERROR_CODES.NOT_FOUND`；白名单拒绝也走 `PairedDeviceError(..., 404)`。两者都是 404，现有断言区分不了。
- 建议: 断言具体 404，并额外 seed 一个 id 为 `a/b` 的 artifact 后请求 `a%2Fb`：白名单正确时必须 404，若白名单回归放行则会命中 artifact 返回 200，测试才会真正失败。
- 证实/推测: 以上是读代码证实的测试盲点；不是生产行为错误，生产代码当前确实拒绝 `%2F`。

## 侧重检查

- **认证与未授权路径**: `authenticate` 复用设备签名验证；测试覆盖未签名、重放、吊销设备。未见绕过。
- **越权范围**: 导出由 `deviceExportArchive` 检查 `authentication.ownerId !== options.ownerId`；文件由 `BrowserThreadFiles.#scope` 检查 owner/agent，再以精确 id 查库。未见跨主人读取路径。
- **畸形/不可信输入**: `exportId` 有 `DATA_EXPORT_ID_PATTERN`、恰好一个、拒绝多余参数；文件路由拒绝所有查询参数；路径白名单只允许字母数字、`._:-` 和 `%3A`，`%2F` 被挡。响应头 `content-disposition` 会替换控制字符和引号/反斜杠；`mediaType` 来自固定的分类表或固定值，未发现头注入。
- **资源耗尽**: 增量只增加有界字符串校验和一次文件/压缩包读取，没有新增循环、无界集合解析或递归；下载字节仍在内存中，与网页原有下载路径相同。
- **不可撤销操作**: 两条路由都是只读 GET，下载本身不修改导出任务或文件。
- **文档和代码一致性**: 本次触及的路由表、文件编号编码、查询参数限制、`no-store`/`attachment` 与代码一致；第 4 条上一轮意见已修。

## 必答问题

1. **不会改变模型已见过的请求开头。** PR 538 的 `9415310..aa14fca` 增量没有触碰系统提示、工具定义、历史、遮盖或 `prompt-catalog`，只是在 HTTP 路由层新增只读下载。发给模型的内容仍然只在末尾追加，每轮变化的值没有进入请求开头。`5ccc248..aa14fca` 里若看到提示词文件差异，那是合并 main 带入的 PR 454 内容，不是本 PR 538 产生；本轮未把它们当新改动重审。未运行 `check:prompt-prefix`。
2. **不会让同一段文字在不同请求里变成不同字节。** 下载路由不参与模型请求组装；新增值 `exportId`/`fileId` 只存在于 HTTP 查询和路径，且格式固定，没有带时间的字段、无序集合或依赖后文的遮盖。合并 main 中已有的感知提示词改动属于前几轮范围。
3. **有自动检查，且关键反向用例能失败。** `test/integration/device-download.test.ts` 覆盖正向、编码冒号、未签名、重放、未知/畸形导出编号、缺参数、多余参数、文件不存在、带查询参数、吊销设备、无端口安装。编码冒号正向用例在旧白名单下会失败。`%2F` 反向用例偏弱，见意见 1。未实际运行测试，因此执行结果未核实。
4. **增量产生/修改的值两端相容。** 逐个核对结果：
   - `exportId`: 产生于 `production-data-export.ts:231`，格式 `data-export:` 加 22 位 base64url；路由 `device-api-routes.ts:786` 用同一 `DATA_EXPORT_ID_PATTERN` 校验，`deviceExportArchive` 再交给 `jobs.view` 精确匹配。两端一致。
   - `fileId`: 生产端由 `production-thread-artifacts.ts:334` 以 `thread-artifact:<uuid>` 生成；路由白名单 `device-api-routes.ts:73/125` 放行原始冒号和 `%3A`；handler `:799` 取 Fastify 解码后的参数交给 `BrowserThreadFiles.content`，后者以精确 id 查库，能接受冒号。两端一致。
   - `exportArchive`/`readFile` 配置: 生产组合在 `production-http-composition.ts:1630` 注入导出端口，`http-gateway-server.ts:1329-1346` 注入文件端口；路由 `device-api-routes.ts:777-804` 消费。签名、返回结构和 `mediaType`/`fileName` 类型均匹配。
   - 文档新值清单 `:715` 与上述代码一致（`%3A`、查询参数限制、404/400 语义相符）。
