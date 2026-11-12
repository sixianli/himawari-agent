## 一、读代码证实的问题

### 1.【高】安全例外清单仍绑定旧版本，CI `security` 与 `check:security-review` 会失败

- 文件:行：`scripts/ci/security-exceptions.mjs:54-62`、`scripts/ci/security-exceptions.mjs:229-230`、`scripts/ci/check-security.mjs:560-564`、`test/tooling/security-review.test.mjs:342-394`
- 问题：改动删掉了 `@octokit/*`、`universal-github-app-jwt`，升级了 `node-forge` 和两处嵌套 `zod`，但没有同步 `ci/security-exceptions.json` 和 `.github/security-review-manifest.json`。校验器要求例外条目的 `packageLockPath + package + version` 必须与当前 `package-lock.json` 完全一致。
- 证据：
  - `scripts/ci/security-exceptions.mjs:54-62`：
    ```js
    dependencies.some(
      (dependency) =>
        dependency.path === entry.packageLockPath &&
        dependency.name === entry.package &&
        dependency.version === entry.version,
    ),
    "SECURITY_EXCEPTION_DEPENDENCY_UNKNOWN",
    ```
  - `scripts/ci/security-exceptions.mjs:229-230` 用工作区候选文件（未改动的 `ci/security-exceptions.json`）和当前锁文件直接校验：
    ```js
    const candidate = readFileSync(join(root, exceptionPath), "utf8");
    validateSecurityExceptions(JSON.parse(candidate), { now, ruleIds, dependencies });
    ```
  - 旧条目仍在：
    - `ci/security-exceptions.json:349-356`：`node_modules/@modelcontextprotocol/client/node_modules/zod`，版本 `4.4.3`；新锁文件 `package-lock.json:1640` 已是 `4.6.7`。
    - `ci/security-exceptions.json:374-381`：`node_modules/@modelcontextprotocol/core/node_modules/zod`，版本 `4.4.3`；新锁 `package-lock.json:1661` 已是 `4.6.7`。
    - `ci/security-exceptions.json:399-404` 等 6 条 `@octokit/*` 条目；本次 diff 已把 `node_modules/@octokit/*` 全部从锁文件删除。
    - `ci/security-exceptions.json:819-824`、`:849-854`：`universal-github-app-jwt@2.2.2`；本次 diff 已从锁文件删除该包。
  - `.github/security-review-manifest.json:225-227` 仍绑定 `node-forge@1.4.0`，而 `package-lock.json:6235-6237` 已是 `1.4.3`。该条目会被 `scripts/ci/security-owner-review.mjs:301-317` 转为 `published-synthetic-fixture`，再在 `scripts/ci/security-exceptions.mjs:242-247` 的合并校验中因版本不符失败。
- 建议：删除已不存在依赖的例外条目；对 `zod@4.6.7` 和 `node-forge@1.4.3` 重新生成绑定新 integrity、成员摘要和命中摘要的条目。`node-forge` 属于 Owner 审批清单，按“依赖身份或命中集合变化须重新审阅”的规则需要重新走 Owner 审批；不能只改版本号绕过审批。

### 2.【高】覆盖率工具版本仍锁在 4.1.9，覆盖率 CI 会失败

- 文件:行：`ci/coverage-policy.json:3-6`、`scripts/ci/check-coverage.mjs:102-115`、`scripts/ci/run.mjs:421-437`
- 问题：`vitest` 和 `@vitest/coverage-v8` 已升到 `4.1.12`，但覆盖率策略和校验脚本仍硬编码 `4.1.9`。
- 证据：
  - `ci/coverage-policy.json:4-6`：
    ```json
    "package": "@vitest/coverage-v8",
    "version": "4.1.9",
    ```
  - `scripts/ci/check-coverage.mjs:104`：
    ```js
    policy.provider.version === "4.1.9" && policy.provider.mapping === mappingIdentity,
    "unsupported or incomparable coverage mapping/tool version",
    ```
  - `scripts/ci/check-coverage.mjs:108-115`：
    ```js
    const expected = {
      vitest: "4.1.9",
      "@vitest/coverage-v8": "4.1.9",
      "ast-v8-to-istanbul": "1.0.5",
    };
    ...
    assert(lock.packages?.[relative]?.version === version, `locked coverage tool differs: ${name}`);
    ```
  - `scripts/ci/run.mjs:421-437` 会在 coverage job 中执行该检查。
- 建议：要么保留 4.1.9（如果安全公告不强制升级），要么同时更新 `ci/coverage-policy.json` 和 `scripts/ci/check-coverage.mjs` 的版本常量，并按覆盖率基线规则重新测量/登记基线。只改依赖和锁文件必然让 coverage job 失败。

### 3.【中】依赖证据清单与代码、新锁文件不一致

- 文件:行：`test/integration/qualification/evidence/s1-task2-dependency-matrix.json:54-163`
- 问题：该证据文件仍把 `fastify@5.12.1`、`@fastify/helmet`、`@fastify/rate-limit`、`@fastify/csrf-protection`、`@fastify/static`、`@octokit/app@16.1.4` 记录为 runtime 依赖，并声称 CSP、限流、静态文件和 GitHub App 能力已通过平台验证；本次改动却删除了这些依赖。
- 证据：
  - `:55` `"version": "5.12.1"`
  - `:83-86` `"name": "@fastify/helmet", "version": "13.1.1", "target": ["packages/platform-node"]`
  - `:111-114` `@fastify/rate-limit`
  - `:124-127` `@fastify/csrf-protection`
  - `:137-140` `@fastify/static`
  - `:150-153` `@octokit/app@16.1.4`
- 同时，代码侧确实没有导入这些包：
  - `packages/platform-node/src/built-in-identity-routes.ts:1` 只导入 `@fastify/cookie`。
  - `packages/platform-node/src/http-gateway-server.ts:855-872` 用自定义钩子设置安全响应头；`:1523-1579` 用自定义逻辑提供静态文件。
  - `packages/integration-github/src/app-credentials.ts:1` 只导入 `@himawari-agent/application`；`src/index.ts:1-9` 也没有 Octokit 导入。
- 建议：删除该证据清单中已移除的依赖项，或明确标注为历史 spike 记录并说明当前代码已改为自定义实现，避免后续审计把“声明存在”误读为“仍在运行”。

### 4.【低】文档仍写 Vitest 4.1.9

- 文件:行：`README.md:24`、`docs/architecture-v0.1.md:158`、`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:215`
- 问题：这些文档仍把 Vitest 固定版本写成 `4.1.9`，与 `package.json:110,116` 的 `4.1.12` 不一致。
- 建议：与覆盖率策略一起更新；如果暂不升级覆盖率工具，则文档保持 4.1.9 才正确。

### 5.【低】锁文件还有作者未列出的可解释变化

- 文件:行：`package-lock.json`（本次 diff）
- 问题：作者只提到 `fast-uri`、`node-forge`、`source-map-js`，实际还有：
  - `nanoid` `3.3.18 -> 3.3.20`
  - `postcss` `8.5.26 -> 8.5.32`
  - `ajv/node_modules/fast-uri` `3.1.6 -> 3.1.9`
  - 删除 `@earendil-works/pi-coding-agent/node_modules/undici`（根 `undici` 升到同一版本后去重）
  - 删除 `@opentelemetry/api`（vitest 升级后的可选 peer 变化）
  - 新增 `vite` 下的嵌套 `rolldown@1.2.19`、`@rolldown/binding-wasm32-wasi`、`@emnapi/*`、`@napi-rs/wasm-runtime`
- 这些变化基本都能由 `vite 8.3.8` 和 `vitest 4.1.12` 解释，不一定是错误；但“锁文件里只有这三个包升级”的说法不完整，审计时应逐项确认。

## 二、推测 / 未核实

- **未核实**：`fast-uri@4.2.3`、`fast-uri@3.1.9`、`node-forge@1.4.3`、`source-map-js@1.2.2` 是否确实修复了对应安全公告。仓库内没有可离线核对的公告数据，不能执行 `npm audit`。
- **未核实**：`fastify 5.12.1 -> 5.12.7`、`undici 8.10.2 -> 8.12.3`、MCP SDK `2.0.0 -> 2.3.1`、`zod 4.4.3 -> 4.6.7` 的行为变化。工作区没有 `node_modules`，不能读已安装源码，也不能运行测试或联网查 changelog。按代码用法看：
  - fastify 只用了路由、钩子、`trustProxy: false` 等基础能力；
  - undici 用了 `fetch`、`Agent`、`ProxyAgent`、`buildConnector`；
  - MCP 用了 `McpServer`、`createMcpHandler`、`createRequestStateCodec`、`fromJsonSchema`、`inputRequired`、`Client`、`StdioClientTransport`、`StreamableHTTPClientTransport`。
  这些 API 是否在升级后行为改变，未能核实。
- **未核实**：作者说“npm run check 50 步通过”。按代码路径，`check:security-review` 会读取真实 `.github/security-review-manifest.json` 和真实锁文件进行校验，应该因上述旧版本条目失败；这与我读到的逻辑不一致。由于本环境是稀疏检出且不允许运行命令，未实际复现。
- **未核实**：锁文件是否确实由 npm 11.8.0 生成。`package.json:6` 声明了 `npm@11.8.0`，但无法从锁文件证明生成工具。
- **未核实**：稀疏检出只包含 69% 文件，无法完全排除未检出文件中的字符串动态引用；但在当前可读的 `packages/platform-node/src` 和 `packages/integration-github/src` 中，没有发现被删包的动态 import、`createRequire` 或字符串引用。证据清单是唯一仍引用它们的非源码文件。

## 三、侧重检查

- **错误路径/不可信输入**：本次没有源码改动。依赖安装全部使用精确版本和 registry integrity；新增的 `@emnapi/*` 是 beta 版本，但它们是 `@rolldown/binding-wasm32-wasi` 的可选依赖，不参与常规平台运行。安全例外校验是本次最直接的“不可信输入/清单校验”路径，见问题 1。
- **安全**：被删的 `@fastify/helmet`、`@fastify/rate-limit`、`@fastify/csrf-protection` 在源码中没有被导入；CSRF、限流、安全响应头由 `http-gateway-server.ts` 和 `built-in-identity-routes.ts` 自定义实现，因此删除声明本身不改变运行时安全行为。`@octokit/app` 也没有被 `integration-github` 导入。真正的问题是安全例外清单仍绑定旧版本，导致安全门禁失败，而不是运行时代码被削弱。
- **资源耗尽**：`vite 8.3.8` 新增了一套嵌套 `rolldown@1.2.19` 及可选 wasm/native bindings，会增加安装体积；不影响运行时请求资源。`undici` 升级对连接池、超时的影响无法核实。
- **不可撤销操作**：本次只改依赖声明和锁文件，没有发现数据库、文件删除或外部写操作。
- **规则/文档与代码一致性**：`ci/coverage-policy.json`、`scripts/ci/check-coverage.mjs`、`ci/security-exceptions.json`、`.github/security-review-manifest.json`、依赖矩阵和 README 都与新依赖版本不一致，见问题 1–4。

## 四、逐条回答必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会发现直接改动。本次没有修改任何源码，系统提示、工具定义、历史消息、遮盖逻辑都没有被触碰。被升级的包中，MCP server/client 主要用于外部 MCP 客户端和能力运行，不参与 Pi 的提示组装；fastify/undici/zod 也不在提示前缀组装路径上。因此“仍然只在末尾追加、每轮变化值仍在最后一条消息”这一性质没有被本改动破坏。但升级包的行为变化未核实，不能 100% 排除库层序列化变化。

2. **同一段文字会不会在不同请求里变成不同字节？**
   未发现。没有源码改动，锁文件顺序变化不影响运行时字节；遮盖包和提示目录都没有改。MCP SDK/zod 升级是否改变 JSON schema 序列化未核实，但当前代码中工具 schema 是通过显式 `fromJsonSchema({...})` 构造的，不依赖对象遍历或随机顺序。

3. **有没有对应的自动检查？反向用例会失败吗？**
   这次依赖升级/删除没有新增专门的自动检查。“删掉的依赖是否真的没用到”目前只靠人工搜索，没有被 `npm run check` 强制。反向用例方面：
   - `test/tooling/security-review.test.mjs:342-394` 的现有用例会因安全例外版本不匹配而失败；
   - coverage job 会因 `scripts/ci/check-coverage.mjs:102-115` 的硬编码版本而失败。
   这两个是真实失败，不是为本次改动设计的反向用例。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   不能全部接受，逐个核对如下：
   - `vitest` / `@vitest/coverage-v8` `4.1.12`：`ci/coverage-policy.json:4-6` 和 `scripts/ci/check-coverage.mjs:102-115` 仍只接受 `4.1.9` → **失败**。
   - `node-forge@1.4.3`：`.github/security-review-manifest.json:225-227` 仍绑定 `1.4.0` → **失败**。
   - 删除 `@octokit/*`：`ci/security-exceptions.json:399-404` 等条目仍引用这些路径 → **失败**。
   - 删除 `universal-github-app-jwt@2.2.2`：`ci/security-exceptions.json:819-824`、`:849-854` 仍引用 → **失败**。
   - 嵌套 `zod` `4.6.7`：`ci/security-exceptions.json:349-356`、`:374-381` 仍绑定 `4.4.3` → **失败**。
   - `fastify 5.12.7`、`undici 8.12.3`、`vite 8.3.8`、MCP `2.3.1`：没有发现代码里的版本硬编码校验，但依赖矩阵证据文件仍写旧版本，文档审计会不一致；实际行为变化未核实。
   - 锁定文件新增的 `@rolldown/binding-wasm32-wasi@1.2.19`、`@emnapi/*@2.0.0-beta.2` 等：`enumerateLockDependencies` 的正则接受这种版本格式，且没有 install script 审查项，未发现会被现有校验拒绝。
