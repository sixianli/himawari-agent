### 1. 中 — 确认签名失败时把所有异常都吞成“用户取消”，真实故障会静默消失

- 文件:行：`clients/apple/Sources/HimawariCore/MenuBarFeed.swift:133-140`，`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:132-135`
- 问题：实现是 `catch let error as DeviceKeyError { throw error } catch { throw OwnerPresenceError.declined }`，也就是除 `DeviceKeyError` 外**所有**错误都变成 `declined`。作者说的是“取消、认证失败”，但 `CancellationError`、CryptoKit/LocalAuthentication 的其他错误、甚至将来新加的签名错误也会被当作“用户取消”，UI 直接 `return`，不记录、不报错、不刷新，排查时看不出真正原因。
- 证据：

  ```swift
  do {
      return try await key.sign(message, reason: reason ?? self.reason)
  } catch let error as DeviceKeyError {
      throw error
  } catch {
      throw OwnerPresenceError.declined
  }
  ```

  ```swift
  } catch OwnerPresenceError.declined {
      actionRequestIds[key] = nil
      acting = nil
      return
  }
  ```

- 建议：只把明确的用户取消/认证失败（例如 `LAError` 的取消、认证失败、回退，以及 `CancellationError`）映射成 `.declined`；其他错误原样抛出或新增 `.signingFailed`，由 `MenuBarModel` 记录/显示。补一条“签名器抛未知错误时不得当作 declined”的反向用例。

### 2. 低 — “取消后不标红、不刷新”只有代码，没有自动检查

- 文件:行：`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:132-135`，`clients/apple/Tests/HimawariCoreTests/HomeActPresenceTests.swift:62-130`
- 问题：新测试覆盖了“declined 时不发 `home/act`”，但没有覆盖 `MenuBarModel` 收到 `declined` 后应有的 UI 状态：`failedItem` 保持为空、`acting` 复位、**不调用 `refresh()`**。`HimawariMacUITests` 目前也没有这部分用例。以后调整 catch 顺序或把它并进通用失败分支时，现有测试不会变红。
- 证据：`MenuBarModel` 的 `declined` 分支确实先 `acting = nil` 再 `return`，行为本身符合要求；但测试文件只到 Core 层：

  ```swift
  } catch OwnerPresenceError.declined {
      actionRequestIds[key] = nil
      acting = nil
      return
  }
  ```

- 建议：把“declined 时不标失败、不刷新”抽成可测的纯逻辑，或在 macOS 侧加测试，断言 `failedItem == nil`、`acting == nil` 且没有触发刷新；至少保留一条反向用例。

### 3. 低 — 挑战值从弹窗前开始计时，慢确认或服务重启后会变成红色失败

- 文件:行：`packages/platform-node/src/paired-device-service.ts:290-303`，`clients/apple/Sources/HimawariCore/MenuBarFeed.swift:103-111`，`clients/apple/Sources/HimawariMacUI/MenuBarModel.swift:136-138`
- 问题：挑战值的有效期是 `signatureToleranceSeconds`，默认 60 秒（`packages/application/src/ports/device-limits.ts:126`），但客户端是**先取挑战、再弹触控 ID/密码**。用户如果停留较久，或服务在取挑战后重启（挑战密钥是进程内随机生成的，`paired-device-service.ts:122`），`home/act` 会得到 `DEVICE_CHALLENGE_INVALID`，落进通用的 4xx 分支，显示红字“没办成，再点一次”，而不是按“确认失败”静默处理。
- 证据：

  ```ts
  const expiresAtSeconds =
    Math.floor(now.getTime() / 1000) + this.#options.configuration().signatureToleranceSeconds;
  ```

  ```swift
  let challenge = try await confirmChallenge()
  _ = try await http.send(DeviceRequest(
      method: "POST",
      path: "home/act",
      body: body,
      nonce: challenge,
      ...
  ```

  ```swift
  } catch let DeviceAPIError.server(status, _, _) where (400 ..< 500).contains(status) {
      actionRequestIds[key] = nil
      failedItem = item.key
  }
  ```

- 建议：对 `DEVICE_CHALLENGE_INVALID` 做一次“重新取挑战再提交”的有限重试（注意会再次弹认证），或在 UI 明确显示“确认超时，请再试一次”；同时补测试。挑战有效期是否应延长属于设计取舍，需要产品确认。

### 4. 低 — 文档仍说挑战值用于 `approvals/respond`，代码实际用于 `home/act`

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:737`（另见 `:222`），`packages/platform-node/src/device-api-routes.ts:50-66`、`:716-719`、`:771-833`，`clients/apple/Sources/HimawariCore/MenuBarFeed.swift:84-111`
- 问题：设计文档“新值清单”把“审批挑战值”的使用处写成 `approvals/respond`，但当前路由清单里根本没有 `approvals/respond`；挑战值实际由 `approvals/challenge` 签发，并在 `home/act` 上通过 confirm 签名消费。这个客户端改动正好走的是后者，文档和代码不一致，容易误导下一端的实现或复核。
- 证据：文档写的是 `approvals/respond`；实际路由只有：

  ```ts
  { method: "POST", path: "approvals/challenge", signed: true },
  ...
  { method: "POST", path: "home/act", signed: true },
  ```

- 建议：把设计文档的使用处改成 `home/act`，并补充“确认签名覆盖请求正文和挑战值、服务端在 `authenticate` 中校验”的说明；如果未来确实要加 `approvals/respond`，再明确两条路径的合约。

## 侧重检查

- **错误路径**：取消/认证失败会静默结束；`DeviceKeyError` 会保持原样，最终由 `MenuBarModel` 标红；挑战过期、服务重启、挑战请求失败会走通用错误并标红。第 1、3 条意见就是这些路径的问题。
- **不合规范或不可信输入**：挑战值来自服务器，客户端只把它放进 `Signature-Input`。真实服务端挑战是 `4 + 12 + 18 = 34` 字节的 base64url，约 46 个字符；服务端要求 `^[A-Za-z0-9_-]{16,64}$`，实际能通过（`device-request-signature.ts:70-71`、`paired-device-service.ts:106-108`）。客户端没有自己校验格式，但最终由服务端验签；目前没有看到会造成越权或绕过确认的路径。
- **安全**：确认签名使用 `.confirm` 密钥，服务端用配对时保存的 `confirmPublicKey` 验证，并要求 confirm 与 device 的 nonce 相同、挑战值有 HMAC、限时且用过即记入 nonce 表（`device-request-signature.ts:291-296`、`paired-device-service.ts:345-361`）。失败是 fail-closed，未发现把“没有确认”误判成“已确认”的路径。
- **资源耗尽**：取挑战不存服务器状态，只有请求 nonce 会入表；每次确认多一次挑战请求，`MenuBarModel` 用 `acting` 阻止并发点击，没有发现新的无界增长点。
- **不可撤销操作**：只有 `action.ownerPresence == true` 才要求确认；非本人动作直接提交，符合要求。确认失败不会先提交 `home/act`，因为签名发生在发送之前。
- **规则/文档一致**：本次没有改动任何发给模型的内容，不触发 `prompt-prefix` 规则；事故 I-73 要求的新值两端校验已核对，但设计文档的挑战值使用处与代码不一致，见第 4 条。
- **未核实**：作者说“照 iPhone 那边的确认方式”，仓库内没有找到 iPhone 端对 `ownerPresence` 首页动作的提交实现，无法核实两端是否完全一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个 diff 只改 Apple 客户端的设备 HTTP 请求和 Mac 菜单栏 UI，没有改系统提示、工具定义、历史消息、资料块或遮盖代码。发给模型的内容仍然只在末尾追加；新增的挑战值只进入 HTTP `Signature-Input`/签名头，不进入模型请求。每轮变化的挑战值和 `created` 不在模型消息里。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   对模型可见的文字不会。`panel.presenceReason` 是静态本地化字符串；同一动作的请求正文仍由原有字段组成。HTTP 签名会因挑战值和签名时间变化而不同，这是服务端确认机制的要求，不是模型文本，也没有新增依赖前后文的遮盖或无序集合。现有 `JSONEncoder` 的正文编码方式没有被本 PR 改变。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有：`HomeActPresenceTests` 的 5 条用例覆盖了取挑战并带 confirm 签名、无 ownerPresence 直接提交、取消时不发 `home/act`、无 signer 时不发请求、`DeviceKeyError` 不被吞成 declined。按代码推断，去掉对应实现这些用例会失败；服务端原有 `test/integration/device-home.test.ts:361-389` 也用真实挑战值验证了“无确认 403、有确认 200”。缺口是第 2 条：`MenuBarModel` 的不标失败、不刷新没有自动检查；另外挑战过期/服务重启后的重试路径也没有测试。受工具限制，本次没有运行测试，结论是按代码推断。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   逐个核对结果：
   - `confirmChallenge()` 返回的 `challenge`：作为 `DeviceRequest.nonce`，再进入 `Signature-Input`。真实格式 46 字符 base64url，满足服务端 `NONCE_PATTERN`；服务端验证 HMAC、有效期、一次性。通过。
   - `confirm` 签名标签和确认公钥：客户端使用 `DeviceSignature.confirmLabel`，服务端用配对时保存的 `confirmPublicKey` 验证，标签和 nonce 相等要求一致。通过。
   - `OwnerPresenceSigner.reason`：只用于系统认证弹窗，不发给服务器；`panel.presenceReason` 在 en/ja/zh-Hans 三个资源里都存在。通过。
   - `OwnerPresenceError`：内部错误类型，不跨网络；`declined` 被 `MenuBarModel` 捕获，`unavailable` 目前只有直接调用 `act` 而不传 signer 时才会出现。通过，但 `unavailable` 没有专门的 UI 文案。
   - `HomeAction.ownerPresence`：客户端解码为 `Bool`，服务端合约要求布尔值，生产首页的动作构造也总是写入该字段；两端一致。通过。
   - 新请求正文 `{}`：`home/act` 只接受固定字段，挑战接口不解析正文；客户端发 `{}` 与现有服务端集成测试一致。通过。
   - 文档中的“挑战值使用处”：与代码不一致，见第 4 条意见。
