---
status: active
supersedes: ""
superseded_by: ""
date: "2026-09-07"
---

# Anthropic Sandbox Runtime：个人 AI Agent 接入与安全实践指南

> **目标读者：**开发个人 AI Agent 的工程师，以及负责实施的 AI coding agent。  
> **适用范围：**本机 macOS 与 Linux；限制不可信命令、文件访问和网络访问。  
> **研究日期：**2026 年 9 月 7 日，日本时间。  
> **源码基线：**`@anthropic-ai/sandbox-runtime`，GitHub 标签 **`v0.0.75`**。  
> **阅读顺序：**先读「一、结论」和「二、架构」，实施时对照「七、SDK 接入」与「十三、验收」，最后把「十五、coding agent 任务书」交给开发代理。

## 研究口径与验证限制

本报告依据 Anthropic 官方仓库、固定版本源码、官方安全公告，以及必要的 Node.js、npm、pip 官方文档。核心实现链接固定到 `v0.0.75`，避免把未来 `main` 分支行为误认为当前已发布版本的行为。

截至研究时，检索到的最新 GitHub Release 是 **`v0.0.75`（GitHub 页面标注发布日期为 2026 年 9 月 1 日）**，标签指向的提交短标识为 `40804af`。项目仍标注为 **Beta Research Preview**。这不是一个可以不加验证、永久依赖默认行为的稳定安全接口。[S01][S02]

**本次完成的是文档与源码审查，不是安全审计，也没有完成真实 macOS/Linux 双平台的 SRT 集成测试。** 当前工作环境无法安装并运行完整 SRT 后端，因此下文的负向测试是实施要求，不是已经通过的测试结果。示例中的生命周期监督接口需要由你的项目实现；不能把 API 示例当作完整、经过验证的安全执行器。

文档层面已检查 3 段 JSON 的解析、3 段 JavaScript 的语法（`node --check`）、3 段 shell 示例的语法（`bash -n`），并检查 Markdown 代码围栏与引用定义完整性。**这些检查不等于安装包类型检查、SRT schema 的运行时验证或沙箱行为测试。**

本报告中的内容分为三类：

- **已核实行为：**可由对应版本的官方源码或文档直接支持。
- **工程建议：**针对个人 Agent 的设计取舍，不冒充 Anthropic 官方要求。
- **待实测边界：**源码或文档提示风险，但具体效果必须在目标系统、版本和工具链上验证。

---

## 一、结论：应该怎样把 SRT 接进你的 Agent

**推荐方案不是“给某个 shell 工具加上 `srt` 前缀就结束”，而是：**

```text
可信的 Agent 主进程
    │  保留模型 API 凭证、审批逻辑和任务状态
    ▼
统一工具执行入口（你实现）
    │  校验任务，选择权限配置，创建临时工作副本
    ▼
独立的可信 worker 进程（每个任务一个，第一版串行）
    │  干净环境、固定版本 SRT、不可变权限、代理与生命周期管理
    ▼
SRT 创建的受限进程树
       Shell / Python / Node / Git / 构建脚本 / 测试程序
```

这里的 **worker 本身在沙箱之外**：它负责加载 SRT、持有代理和启动受限命令。真正不可信的仓库代码、模型生成的代码和命令，只能在最下面执行。SRT 的 `SandboxManager` 本身也是宿主侧管理组件。[S06]

### 你的第一版应当做到什么

建议先实现一个能力明确的 **`offline-workspace` 配置**：不向沙箱传递真实凭证；阻断通过 SRT 代理访问网络；只开放独立任务目录的必要写入；显式保护用户目录和控制目录；拒绝缺少隔离能力的运行环境。这里的“offline”是你定义的策略名，**不是 SRT 内置 profile，也不代表已经证明所有平台上的 DNS 等通信渠道都被完全隔绝**。

等离线版本通过双平台负向测试，再加入按目标域名与端口开放的网络配置。涉及真实 API 凭证、网页抓取、云操作或代码发布时，优先提供窄接口的可信工具，而不是把通用联网能力与凭证一起交给任意代码。

### 第一版应明确排除的能力

不自动绕过沙箱重试；不运行需要 root 的 Agent 任务；不开放 Docker socket、SSH agent 或任意宿主 IPC；不启用 Apple Events；不为了兼容性自动降低网络或嵌套隔离；不让模型修改 SRT 设置；不一开始就启用 TLS 解密和复杂凭证遮蔽。

**安全目标应该写成可以验证的效果，而不是“已经调用了 SRT”：**

> 一个被恶意提示或恶意仓库影响的工具调用，不能读取预先指定的假密钥，不能修改工作区外的保护文件，不能访问未授权的测试端点；隔离初始化失败时，该工具调用不执行。

---

## 二、先明确 SRT 能保护什么，不能代替什么

### 2.1 它提供的是进程级边界，不是独立虚拟机

在本文关注的平台上，SRT 使用 macOS 的 Seatbelt / `sandbox-exec`，以及 Linux 的 bubblewrap、命名空间和相关 seccomp 辅助组件。它结合宿主侧 HTTP/SOCKS 代理限制网络，不要求你先构建一套 Linux 虚拟机环境。[S02][S09][S10]

这使它适合复用本机工具链，但也意味着你不能把它等同于“独立内核的恶意代码分析环境”。它也不是危险命令语义分类器：一个命令是否叫 `rm`，不如它最终能写哪些路径重要。

**工程上应另外解决：**执行时间、进程数量、CPU/内存/磁盘占用、输出体积、审批状态、任务回滚、日志保存和多用户隔离。不要期待一份 SRT 文件系统与网络配置自动包办这些能力。

### 2.2 需要保护的不只是 shell

先盘点你的 Agent 中所有可能产生副作用的入口：

| 入口 | 建议的接入方式 | 仅给 shell 加沙箱为什么不够 |
|---|---|---|
| Shell、命令执行、代码解释器 | 统一进入 SRT 子进程 | 主进程里的 `exec`、`eval` 或解释器仍能直接访问宿主 |
| 文件读取、编辑、搜索 | 在沙箱内执行，或经过独立的可信路径校验器 | 主进程直接 `readFile` 不会自动受子进程规则约束 |
| HTTP 请求、网页下载 | 受限子进程，或窄接口的可信网络工具 | 宿主 HTTP 客户端不在该子进程的限制范围内 |
| 浏览器自动化 | 独立设计浏览器执行边界与宿主连接权限 | 连接现成的宿主浏览器可能继承登录状态和宿主能力 |
| 本地 MCP 服务 | 服务进程也受限，或单独审核其能力 | 在沙箱外运行的 MCP 服务可以替请求者执行操作 |
| 远程 MCP / 云端工具 | 服务端权限与审批控制 | 本地 SRT 不能限制远程服务本身的权限 |

表格是本报告的架构建议。Claude Code 官方文档也区分 Bash 沙箱与其他工具的控制；**不要把 Claude Code 的整套权限体系误认为独立 SRT 自动附送的功能。**[S23]

### 2.3 “禁网”不等于“秘密不会外传”

假设沙箱能读取真实 `.env`，然后把内容打印到标准输出。你的 Agent 主进程把输出交给模型 API，这些内容仍然离开了电脑，尽管沙箱内的命令没有成功建立外网连接。

因此，设计优先级应当是：**让不可信代码接触不到秘密，再限制它能访问的外部服务，最后对输出做必要的最小化与脱敏。** 输出脱敏是补充，不是让所有密钥可读的理由。

同样，允许写工作区，就意味着里面的代码和文件可能被删除或破坏。建议使用一次性副本，并在任务结束后审核差异再合并。使用 Git worktree 时要注意共享的 Git 元数据；不要为了让 Git 命令通过而授权整个原仓库父目录或整个原仓库 `.git`。

---

## 三、安装、版本固定与启动自检

### 3.1 固定运行时，和待处理仓库分开安装

建议在可信运行时目录安装 SRT，而不是装在 Agent 可以随意修改的目标仓库中：

```bash
# 在独立、可信的集成目录执行；这是安装步骤，不是每次工具调用都执行。
npm install --save-exact @anthropic-ai/sandbox-runtime@0.0.75

# 核实实际依赖树，并提交 package.json / package-lock.json。
npm ls @anthropic-ai/sandbox-runtime --depth=0

# 后续部署依据经过审核的锁文件安装。
npm ci
```

发布包声明的 Node.js 最低要求是 `>=20.11.0`。实际部署应选择仍受维护、满足该要求的 Node.js 版本；最低引擎要求不等于建议长期停留在该最低版本。[S03]

本次没有独立核实 npm registry 的实时 dist-tag 或安装包字节。实施时应核对目标版本的 registry 元数据、锁文件和 integrity，并保存实际安装版本。**不要在每次执行命令时运行 `npx ...@latest` 下载代码。**

还有一个版本识别细节：该标签的 CLI 版本字符串取自 `npm_package_version`，缺失时回退到 `1.0.0`。因此，不能只把 `srt --version` 当作已经部署 `0.0.75` 的证据。[S04]

### 3.2 平台准备

| 平台 | 需要核对的能力 | 推荐处理 |
|---|---|---|
| macOS | `sandbox-exec`、Node、相关工具与 `rg` 可用 | 使用实际 SRT 依赖检查和行为探针，不只判断系统名称 |
| Linux | bubblewrap、`socat`、`rg`，用户/网络等命名空间，兼容的 seccomp 辅助文件 | 普通用户执行；核对内核、发行版和用户命名空间限制 |
| Linux 容器 / CI | 外层容器是否允许必要命名空间与系统调用 | 单独验证；不能把“在 Linux 上”当作一定可运行的证明 |

Linux 发布包包含相应架构的 seccomp 辅助产物。重新打包时，不要只带走 JavaScript 文件而漏掉 `vendor` 下所需组件；Java 代理辅助文件同样需要保留。[S02][S22]

Ubuntu 等环境可能因用户命名空间相关安全配置而启动失败。应由管理员进行有边界的配置或选择合适执行环境；**不要让 coding agent 自动关闭全局 AppArmor 限制、使用 `--privileged`，或者以 root 启动来“修复”沙箱。**[S02]

### 3.3 自检必须检查警告，而不只是错误

该版本在依赖缺少 seccomp 能力时，可能产生“Unix socket 访问未受限制”的警告；初始化逻辑只会因 `errors` 非空而直接拒绝，不会把所有 `warnings` 自动当作失败。[S06][S09]

建议第一版采用更保守的应用策略：

```text
平台不支持 → 拒绝执行
依赖检查有 error → 拒绝执行
依赖检查有 warning → 默认拒绝，人工审核后才允许针对性例外
隔离行为探针未通过 → 拒绝执行
配置缺失、校验失败、后端初始化失败 → 拒绝执行
```

“警告默认失败”是你的应用策略，不是 SRT 的默认保证。后续可以区分安全能力缺失与纯诊断缺失，但应有显式的例外登记，不能简单忽略全部警告。

---

## 四、接入方式：优先使用什么接口

### 4.1 CLI 适合语言无关的第一步

对 Python、Java、Go 或其他语言的 Agent，最容易起步的是受监督地启动固定位置的 SRT CLI。

**参数数组模式：**

```bash
/path/to/trusted-runtime/node_modules/.bin/srt \
  --settings /path/to/trusted-control/job.policy.json \
  -- /usr/bin/printf '%s\n' 'hello from sandbox'
```

**确实需要管道、重定向等 shell 语义时：**

```bash
/path/to/trusted-runtime/node_modules/.bin/srt \
  --settings /path/to/trusted-control/job.policy.json \
  -c 'printf "%s\n" "hello" > result.txt'
```

程序调用时，应把上述各参数作为数组传给 `subprocess`、`ProcessBuilder` 或 `spawn`，外层使用 `shell=false`。需要 shell 语义的文本，只能作为 `-c` 后的那个参数进入 SRT，不能先在宿主 shell 中插值执行。

该版本的 CLI 会对位置参数进行 shell quoting，而 `-c` 接收原始命令文本。因此，不要把完整的 `"python script.py --flag"` 当成一个普通位置参数；也不要自己用不转义的空格拼接来替代参数数组。[S04]

必须显式指定可信的 `--settings`。当前 CLI 对显式配置加载失败会拒绝执行；没有显式配置时，则可能使用默认配置。不能依赖工作区内 `.srt-settings.json` 或用户默认文件隐式决定权限。[S04]

### 4.2 SDK 适合细化自检、日志与生命周期

原生 JS/TS SDK 的价值是可以直接调用依赖检查、初始化、包装命令和诊断接口。**其他语言也可以保留自己的主进程，只增加一个很小的 Node worker，而不必重写整个 Agent。**

建议按现有项目栈选择，不要为了 SRT 重构整套业务：

| 项目情况 | 推荐 |
|---|---|
| 现有 Agent 已有可靠子进程监督器 | 先封装 CLI，但补上严格依赖检查与行为探针 |
| 主体是 Node.js / TypeScript | 独立 worker 中使用 SDK |
| 主体是 Python / Java，需要更完整的 SRT 自检与诊断 | 主进程通过内部协议调用独立 Node worker |

CLI 和 SDK 最终依赖同一套边界。SDK 不是自动更安全；收益来自你能更明确地实现验证、生命周期和策略隔离。

### 4.3 不要混用 Claude Code 配置

`SandboxRuntimeConfigSchema` 才是独立 SRT 的配置依据。不要把 Claude Code 的 `sandbox.enabled`、自动审批或非沙箱重试等产品配置复制过来，假设它们能控制独立 SRT。[S05][S23]

也不要根据 issue 中的功能提议编造已经存在的字段。例如，HTTP 路径控制不能凭空写成 `allowedDomainPaths`。需要程序回调的功能，也不能在 JSON 文件里放一段字符串函数就期待 CLI 执行它。

---

## 五、文件系统策略：最容易接错的部分

### 5.1 读取与写入不是对称的

| 配置 | 实际含义 | 常见误解 |
|---|---|---|
| `filesystem.denyRead` | 默认可读，再禁止指定区域，仍受宿主本身权限约束 | 空数组意味着什么都不能读 |
| `filesystem.allowRead` | 在被禁止的区域内重新开放指定路径；更具体规则仍有影响 | 一填它，其他所有路径就自动不可读 |
| `filesystem.allowWrite` | 指定允许写入的区域，另有运行时的默认可写路径 | 数组里没有的任何路径都绝对不能写 |
| `filesystem.denyWrite` | 在允许写入区域中进一步保护指定路径 | 一旦父目录允许写，子路径的禁止就无效 |

读取规则采用“先拒绝、再局部开放”的模型，不是独立的全局读取白名单；不要简单总结为 allow 永远覆盖 deny。[S07]

**推荐思路：**先保护实际用户目录与敏感数据区域，再只开放任务目录和确实需要的只读工具链。单独填写 `allowRead: [workspace]` 不够。

例如，保护 `/Users`、`/home` 和实际用户 home，再开放任务目录，可以隔离常见个人文件。但这仍不等于整台机器只剩下工作区可见：其他挂载点、`/Volumes`、`/mnt`、`/opt`、系统配置目录和自定义数据路径仍需盘点。也不要未经验证就把 `denyRead: ["/"]` 当成万能模板，它很容易连程序、动态库和必要系统资源一起挡住。

### 5.2 内置可写路径必须单独处理

`v0.0.75` 的默认可写集合包含必要设备路径，以及以下磁盘目录：

```text
/tmp/claude
/private/tmp/claude
<worker 的 home>/.npm/_logs
<worker 的 home>/.claude/debug
```

因此，**`allowWrite: []` 不应被你宣传成“任何磁盘路径都不允许写入”**。想把跨任务的共享临时目录关闭，应显式加入相应 `denyWrite`，使用每任务独立的临时目录，并在目标平台测试最终行为。[S08]

同一个源码文件还表明：子进程的 `TMPDIR` 会优先取 `CLAUDE_CODE_TMPDIR`，其次取旧名称 `CLAUDE_TMPDIR`，否则使用 `/tmp/claude`。只设置普通 `TMPDIR`，不足以决定 SRT 最终的临时目录。[S08]

### 5.3 跨平台优先使用绝对路径，不使用安全关键 glob

Linux 写规则不支持一般 glob，某些含 glob 的规则会被跳过；读取 glob 则会在包装命令时展开成当时存在的路径。macOS 的规则实现不同。[S06][S09][S10]

工程建议：

- 安全关键路径使用规范化的绝对目录或文件，不依赖 `**/.env` 一类模式作为唯一保护。
- 对任务启动后新出现的敏感文件、符号链接、路径别名与大小写分别测试。
- 不要用字符串 `startsWith(workspace)` 判断文件属于工作区，`/work/project-evil` 也会匹配 `/work/project`；使用真正的路径包含关系，并处理符号链接和竞态。
- 对导入、导出文件同样做路径检查。沙箱内生成的 symlink 或压缩包不能让宿主导出流程越界。

Linux 拒绝读取有时表现为被遮蔽后的空文件/目录，而不一定是统一的 `EPERM`。**验收应检查假密钥内容是否不可获取，而不是只检查命令是否以非零码退出。**[S09]

### 5.4 内置保护不等于完整的仓库安全扫描

SRT 会保护部分容易被后续宿主程序执行的配置、钩子等路径。但 Linux 的相关搜索有深度与范围限制，默认搜索深度为 3；它不是对整个仓库的安全审计。[S05][S09]

你的运行时、策略目录、审批数据库、模型凭证、主进程插件和主进程将要加载的 `node_modules`，都应该独立于可写工作区。尤其在“Agent 开发自己”的场景中，不能让它改完可信 supervisor 的源码后，由宿主自动重载执行。

---

## 六、一个可实施的离线配置与环境布局

### 6.1 推荐目录布局

```text
trusted-runtime/             固定版本的 SRT、worker、依赖；工作任务不可写
trusted-control/             策略、任务登记、审批、审计；工作任务不可读写
jobs/<随机任务 ID>/
    work/                    不可信仓库的一次性工作副本
    home/                    人工创建的任务 HOME，不是实际用户 home
    tmp/                     任务临时文件
    cache/                   任务独享缓存
```

以上是逻辑布局，不要求这些目录具有相同父目录。可信控制目录必须位于所有允许写入范围之外。目录由可信主进程创建，使用收紧的权限；不接受模型指定任意路径作为这些根目录。

个人版本优先每任务独立缓存。共享可写缓存会增加任务间污染，也可能把恶意依赖或脚本带入未来任务；有共享需求时采用经过验证的只读基础缓存与任务私有写层。

### 6.2 JSON 模板：必须由可信代码替换路径

**下面是模板，不是可直接运行的配置。** `<...>` 占位符不是 SRT 支持的变量语法。可信配置编译器必须替换成实际绝对路径、删除当前系统不适用的条目，并拒绝未替换占位符。

```json
{
  "network": {
    "allowedDomains": [],
    "deniedDomains": ["*"],
    "strictAllowlist": true,
    "allowUnixSockets": [],
    "allowAllUnixSockets": false,
    "allowLocalBinding": false,
    "allowMachLookup": []
  },
  "filesystem": {
    "denyRead": [
      "<USER_HOME_PARENT>",
      "<REAL_USER_HOME>",
      "<TRUSTED_CONTROL_ROOT>",
      "<WORKSPACE>/.env",
      "<WORKSPACE>/secrets"
    ],
    "allowRead": [
      "<WORKSPACE>",
      "<JOB_HOME>",
      "<JOB_TMP>",
      "<JOB_CACHE>",
      "<TRUSTED_RUNTIME_ROOT>",
      "<APPROVED_READONLY_TOOLCHAIN_ROOT>"
    ],
    "allowWrite": [
      "<WORKSPACE>",
      "<JOB_HOME>",
      "<JOB_TMP>",
      "<JOB_CACHE>"
    ],
    "denyWrite": [
      "<TRUSTED_RUNTIME_ROOT>",
      "<TRUSTED_CONTROL_ROOT>",
      "<WORKSPACE>/.git",
      "<WORKSPACE>/.env",
      "<WORKSPACE>/secrets",
      "/tmp/claude",
      "/private/tmp/claude",
      "<JOB_HOME>/.npm/_logs",
      "<JOB_HOME>/.claude/debug"
    ]
  },
  "enableWeakerNestedSandbox": false,
  "enableWeakerNetworkIsolation": false,
  "allowAppleEvents": false,
  "allowPty": false
}
```

这些字段来自该标签的 schema；策略选择是本报告的保守示例，而不是官方提供的通用 profile。[S05]

模板使用说明：

**`<USER_HOME_PARENT>`** 通常对应 macOS 的 `/Users` 或 Linux 的 `/home`，但不能通过操作系统名字猜测实际 home。还需盘点其他用户数据根目录；实际用户 home 在别处时，以实际路径为准。

**只读工具链路径**必须是真正批准的安装位置。例如 Node、Python、uv、虚拟环境或解释器可能位于用户目录中，过于宽泛地拒绝 home 会让它们无法启动。应只重新开放必要路径，不能为修复一个 Node 路径问题开放整个实际 home。模板也只读开放可信运行时目录，供必要辅助文件使用；该目录不得存放凭证，实际可读性仍需验证。

**工作区下的 `.env` 与 `secrets`**只是示范敏感路径；更好的起点是不要把真实秘密复制进工作副本。嵌套目录中的其他敏感文件需要额外清单或源头排除，不能认为顶层两条已经覆盖所有情况。

**`.git` 的写保护**适合第一版的读代码、编辑代码与运行测试。需要 commit、修改分支或其他 Git 写操作时，应另设策略并使用独立副本；不要悄悄删除保护来兼容命令。

**新增工作目录与默认临时路径的关系**必须检查：不要把 `JOB_TMP` 放到已被本模板禁止的 `/tmp/claude` 或 `/private/tmp/claude` 内。读/写规则的父子关系、真实路径和默认路径，需要在编译阶段做冲突检查。

### 6.3 配置编译器应具备的防错能力

建议你的应用只暴露少数自定义 profile，并编译成 SRT 配置。模型只能提出 `policyId` 申请，不能直接提交整份原始配置。

编译器应当拒绝未知字段、相对路径、未替换占位符、越界目录、非法域名模式，以及第一版不支持的弱化选项；尤其不能接受 `filesystem.disabled: true` 来关闭文件系统保护。然后再调用 `SandboxRuntimeConfigSchema.parse()` 做 SRT 层校验。**不能假设上游 schema 会把所有拼错或未知的键都作为硬错误；你应对自己的配置层实施严格校验。**[S05]

输出包含规范化配置与 `policyHash`，例如对确定性序列化后的配置做 SHA-256。这个 hash 用于审批绑定和审计，不是权限执行器，也不能代替目录保护。

### 6.4 环境变量：应在启动 worker 之前清理

可信主进程启动 worker 时构造环境白名单，而不是把完整 `process.env` 复制过去再删几个熟悉的密钥。下面是你自己的代码示意，不是 SRT API：

```javascript
export function makeWorkerEnv({
  trustedPath,
  jobHome,
  jobTmp,
  jobCache,
  locale = "C"
}) {
  return {
    PATH: trustedPath,
    HOME: jobHome,
    TMPDIR: jobTmp,
    CLAUDE_CODE_TMPDIR: jobTmp,
    XDG_CACHE_HOME: jobCache,
    XDG_CONFIG_HOME: `${jobHome}/.config`,
    XDG_DATA_HOME: `${jobHome}/.local/share`,
    LANG: locale,
    LC_ALL: locale
  };
}
```

`trustedPath` 应由可信安装清单生成，不能带 `.` 或仓库中的可写目录。对 UTF-8 有要求时，选择目标系统实际提供的 locale；不要假设所有 Linux 镜像都有同一 locale。

不要默认继承模型 API Key、云凭证、`SSH_AUTH_SOCK`、`BASH_ENV`、`ENV`、`NODE_OPTIONS`、`PYTHONPATH`、动态库注入变量或用户自定义的 `JAVA_TOOL_OPTIONS`。它们有些不仅传数据，还能影响可信解释器在进入沙箱之前加载什么代码。

同理，不默认继承代理环境变量；SRT 在宿主侧会解析上游代理设置，污染的 `HTTP_PROXY` 等变量可能改变网络路径。需要公司代理时，在可信配置中显式审核。[S18]

更换 `HOME` 后，**真实用户 home 仍需要按原始绝对路径保护**。只写 `~/.ssh` 可能指向新的任务 home，而不是你真正想保护的 SSH 密钥目录。任务环境还会继承 SRT 为执行工具生成的代理设置；不要在包装后把这些必要设置盲目删除。[S08]

---
## 七、SDK 接入：进程隔离比 API 调用顺序更重要

### 7.1 不要把 SandboxManager 当成可随意创建的多租户实例

该版本的 `SandboxManager` 使用模块级共享状态，包含配置、代理和初始化状态。重复调用 `initialize()` 不等于创建一套新的独立沙箱服务。[S06]

据此，本报告建议：**一个可信 worker 对应一个不可变策略；第一版一个 worker 只执行一个任务。** 不同权限的任务使用不同 worker；同一工作区第一版串行执行。若将来需要并发，也优先使用独立工作副本。

尤其不要这样设计：

```text
任务 A：需要联网 → 更新共享 manager 的网络配置
任务 B：本应离线 → 同时复用相同 manager
任务 A：结束后再改回配置
```

网络代理的判断与共享配置有关，不能把 `customConfig.network` 当作每次调用都有完全独立网络策略的承诺。批准一个任务的权限，不应该短暂扩大其他正在运行任务的权限。[S06]

### 7.2 worker 的 cwd 必须在初始化前确定

建议可信父进程启动 worker 时就设置 `cwd=workspace`。worker 启动后校验当前目录，不再并发切换目录。

`wrapWithSandboxArgv()` 的 `cwd` 参数在 macOS/Linux 路径上当前并不承担你可能期待的全部目录处理；源码明确标注该参数在这两个平台未使用。其他规则生成、搜索等又可能依赖 manager 的 `process.cwd()`。[S06]

因此，不要只在最后 `spawn(..., { cwd })` 时换目录，却让策略包装发生在另一个目录。**可信 worker 的当前目录、规则中的工作区，以及实际子进程的当前目录应一致。**

### 7.3 SDK 控制流程示例

下面展示当前 API 的正确组合方式。它是**集成骨架，不是完整进程监督器**：

- `prepared` 必须由可信主进程生成，已经完成严格配置、目录与请求授权校验。
- 父进程已用上一节的干净环境启动 worker，并固定其 cwd。
- `superviseProcess` 是你实现的函数，不是 SRT 提供的函数。它负责实际启动、输出上限、取消、超时以及完整进程生命周期。
- 父进程还必须监督 worker 的初始化总时限和异常退出；不能只给子命令设置超时。

```javascript
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  SandboxManager,
  SandboxRuntimeConfigSchema
} from "@anthropic-ai/sandbox-runtime";

let hasAcceptedJob = false;

/**
 * 在独立、可信、已清理环境变量的 worker 中调用一次。
 *
 * superviseProcess 的契约：
 * 1. 按传入 argv 直接启动，外层 shell:false，不重新拼接 shell 字符串。
 * 2. 限制 stdout/stderr 总字节量；处理超时、取消及启动失败。
 * 3. 必须等到本任务进程树被终止/回收后才 resolve 或 reject。
 * 4. 无法确认清理完成时，向父监督器报告隔离失败，不得标记任务成功。
 */
export async function runPreparedSrtJob(
  prepared,
  superviseProcess,
  preparationSignal
) {
  if (hasAcceptedJob) {
    throw new Error("This worker accepts exactly one job");
  }
  hasAcceptedJob = true;

  if (typeof superviseProcess !== "function") {
    throw new TypeError("A process supervisor is required");
  }
  if (!SandboxManager.isSupportedPlatform()) {
    throw new Error("Unsupported sandbox platform");
  }
  if (await realpath(process.cwd()) !== prepared.workspace) {
    throw new Error("Worker cwd does not match approved workspace");
  }

  // prepared.policy 先经过应用自己的严格字段与权限校验。
  const policy = SandboxRuntimeConfigSchema.parse(prepared.policy);
  const commandId = randomUUID();

  try {
    // 不注册自动扩大网络权限的 ask callback；打开诊断监控。
    await SandboxManager.initialize(policy, undefined, true);

    // 在执行任何不可信命令之前，应用自己的保守就绪策略。
    const deps = await SandboxManager.checkDependenciesAsync(policy.ripgrep);
    if (deps.errors.length || deps.warnings.length) {
      throw new Error("Sandbox dependency readiness check failed");
    }
    if (SandboxManager.getLinuxGlobPatternWarnings().length) {
      throw new Error("Unsupported Linux filesystem glob rules");
    }

    const plan = await SandboxManager.wrapWithSandboxArgv(
      prepared.command,
      prepared.shellPath,
      undefined, // 不用 per-call customConfig 改变网络权限
      preparationSignal,
      prepared.workspace,
      { commandId, commandText: prepared.displayCommand }
    );

    const result = await superviseProcess({
      argv: plan.argv,
      env: plan.env,
      cwd: prepared.workspace,
      shell: false,
      timeoutMs: prepared.timeoutMs,
      maxOutputBytes: prepared.maxOutputBytes
    });

    return {
      ...result,
      commandId,
      policyHash: prepared.policyHash,
      sandboxViolations: SandboxManager.getSandboxViolationStore()
        .getViolationsForCommand(commandId)
    };
  } finally {
    // 仅当监督器满足“进程已停止”的契约后，才能结束这一任务的设施。
    try {
      SandboxManager.cleanupAfterCommand();
    } finally {
      await SandboxManager.reset();
    }
  }
}
```

API 名称与参数以固定版本的公开导出和 manager 接口为依据。[S06][S11] 实施时仍需针对实际安装包进行类型检查与双平台运行验证。

### 7.4 这个骨架不能被误读为哪些保证

**`wrapWithSandboxArgv` 不是“里面完全没有 shell”。** 在 macOS/Linux 上，它返回的启动描述仍包含 shell 和经过 SRT 包装的命令；好处是你可以不用另加一次不安全的宿主 shell 拼接。命令文本有 shell 语义，是这个接口的实际设计。[S06]

如果你的工具接受 `executable + args[]`，优先走 CLI 的参数数组形式，或者使用经过测试的 shell quoting 库把每个参数正确编码。不要写 `args.join(" ")`。

**`plan.env` 不是自动洗净的宿主环境。** macOS/Linux 的该返回值基于 worker 环境，所以环境清理必须发生在启动 worker 之前。[S06]

**`preparationSignal` 不等于整个执行任务可取消。** 它不是对所有后续子进程的自动终止承诺。实际运行取消与 deadline 必须传到你自己的监督器；父进程也应管理整个任务期限。

**`reset()` 不是“杀掉所有恶意子进程”的 API。** 必须先完成任务生命周期管理，再清理该 worker 的代理与其他状态。不要在仍有其他任务使用同一 manager 时调用它。

### 7.5 执行接口设计：权限不接受模型直传

你的 Agent 对外工具可以很小：

```text
execute_command(
    task_id,
    command,
    requested_profile,
    timeout_request
)
```

可信层负责把它转换成内部 `PreparedJob`：绑定真正的工作区、已授权 profile、限制后的时长、环境、固定解释器和策略 hash。模型不能设置 `bwrapPath`、`socatPath`、shell 路径、任意 cwd、任意 env、原始 SRT 配置或运行时参数。

即使模型能选择 `requested_profile`，也必须经过服务端授权；不要把“参数枚举里有 `network-enabled`”当成已经获得联网许可。

---

## 八、网络策略：域名白名单到底保证了什么

### 8.1 先把普通出网规则写清楚

离线配置建议同时使用：

```json
{
  "allowedDomains": [],
  "deniedDomains": ["*"],
  "strictAllowlist": true
}
```

这是 `network` 对象的片段。`deniedDomains` 先判断，`*` 在拒绝规则中表示全部拒绝；`strictAllowlist` 让未命中的目标直接拒绝，而不询问 ask callback。[S05][S07]

需要联网时创建**新的**窄权限 profile，例如下面这个说明性片段：

```json
{
  "allowedDomains": ["registry.npmjs.org:443"],
  "deniedDomains": [],
  "strictAllowlist": true,
  "allowUnixSockets": [],
  "allowAllUnixSockets": false,
  "allowLocalBinding": false,
  "allowMachLookup": []
}
```

**不能保留离线配置的 `deniedDomains: ["*"]` 再期待 allowlist 生效。** 实际项目依赖可能需要其他下载目标；只有在观察并审核真实需求后再添加，不应从一次失败直接升级到宽泛通配符。

模式要点：带 `:443` 才限定相应目标端口；没有端口就不是“默认只准 HTTPS”。`*.example.com` 不代表同时允许 `example.com` 本身。配置里的域名模式不是 URL、HTTP 路径或任意 CIDR。[S12]

### 8.2 删除代理变量不应解除网络限制

代理环境变量主要帮助工具找到受控出口；基础限制来自操作系统边界，不应只依赖程序“自愿遵守代理”。因此，要把“清空代理变量后直接连接”“子进程另开 TCP 连接”等加入验收。[S02][S09][S10]

同时，`NO_PROXY` 是客户端的代理选择设置，不是网络防火墙。不能看到其中有私网地址，就推断某个地址一定被 SRT 的代理拒绝。[S08]

### 8.3 白名单不是完整的数据外传防护

允许访问一个代码托管或包服务域名，不等于只准下载公共代码。一个允许的目标可能同时接收用户上传、API 写请求或带任意查询参数的请求。

因此，工程上要分开三个问题：**能连接谁、能调用什么操作、能带走什么数据。** 域名规则主要回答第一个问题。秘密不可读、凭证最小权限、窄接口 API 工具和审批，分别补充后两个问题。

### 8.4 别擅自假设具备 SSRF 防护

SRT 的目标匹配与代理连接逻辑不能被你概括为“自动阻断所有解析到内网或云元数据地址的域名”。特别是接受任意用户 URL 时，应单独处理 DNS、重定向和目标 IP 范围；不要用宽泛的攻击者可控域名来代替精确目标清单。[S12][S18]

本报告建议：对网页抓取、URL 导入、下载指定文件这类操作，优先做可信的专用 fetch 工具，明确协议、目标、重定向、响应大小和超时。在需要 SSRF 防护时，解析后的地址检查必须和实际连接目标绑定，并对重定向重新校验；这些不是往 SRT JSON 加几个未定义字段可以解决的。

### 8.5 macOS 的“完全离线”需要额外验证

该版本 README 在说明系统 DNS 解析边界时，明确提到其描述与 macOS 行为相似。因此，**本报告不把空域名白名单解释为 macOS 上所有系统解析渠道都已被封死**。[S02]

这里属于必须实测的边界：只使用自有测试域名和假数据验证，不要拿真实秘密测试 DNS 外传。如果你的威胁模型要求“包括系统解析在内的绝对零外联”，而目标平台实测无法满足，那么该能力在该平台不能标为可用；应增加外层网络控制或改用更适合的隔离执行环境。

---

## 九、高级网络与凭证功能：不要在第一版默认启用

### 9.1 HTTP 请求过滤有用途，但不是所有传输的总开关

当前 SDK 的 `network.filterRequest` 接收解析后的 `Request`，异步返回允许或拒绝；回调异常按拒绝处理。HTTPS 内容过滤需要相应 TLS 终止配置；证书固定、mTLS 等特殊客户端需要单独处理。[S13][S05]

一个说明性的回调可以写成：

```javascript
async function filterRequest(request) {
  const url = new URL(request.url);
  const allowed =
    url.protocol === "https:" &&
    url.hostname === "api.example.com" &&
    (url.port === "" || url.port === "443") &&
    request.method === "GET" &&
    url.pathname === "/v1/status" &&
    url.search === "";

  return allowed
    ? { action: "allow" }
    : { action: "deny", reason: "Only the approved status request is allowed" };
}
```

这个例子是应用层判断逻辑，**不能独立构成严格的“只读 API 沙箱”**。源码中的 SOCKS 路径进行目标主机/端口判断后转发 TCP 字节，不经过同样的已解析 HTTP `Request` 过滤。[S14]

据此作出的安全推论是：对能自行选择客户端和传输方式的不可信代码，**不能只审查 `filterRequest` 回调就声称所有联网路径都受到 HTTP 方法与路径限制。** 这是源码审查得出的设计边界，不是本报告已完成利用验证的新漏洞结论。

如果“只能调用这一个只读 API”是硬要求，应使用没有通用转发功能的可信 API 工具，或者经过完整验证、覆盖全部出口路径的外部网关，而不是只把 SOCKS 代理环境变量删掉。

### 9.2 区分两种代理配置

`httpProxyPort` / `socksProxyPort` 指向外部代理时，SRT 会用它们代替相应内部代理；外部代理需要承担域名过滤责任。不要以为填写端口后，SRT 自己仍在那个出口完整执行原来的域名判断。[S05]

`parentProxy` 是另一类上游代理配置，不能与上述“替换内部代理”的字段混为一谈。[S18]

所有这些设置都属于可信管理员配置，不应对模型开放。启用 HTTPS 终止时，CA 私钥也属于可信侧秘密，不应放在工作区；禁止通过 `curl -k`、关闭 TLS 校验等方式使测试“通过”。

### 9.3 凭证遮蔽不是“安装后自动保护所有密钥”

SRT 只处理显式声明的凭证来源。文件和环境变量的 deny/mask 配置不会自动发现你机器上的全部秘密。文件遮蔽在 Linux 与 macOS 的实现不同：Linux 可以提供替代内容，而 macOS 相应场景降级为禁止读取，而不是读取到同样的假文件。[S07][S16]

若以后确实需要代理注入凭证，应显式收窄每份凭证的 `injectHosts`；不配置它，可能回落到整个已允许的目标集合。允许注入某个服务，不代表该服务的所有操作都安全，真实凭证本身仍需最小权限。[S15][S17]

### 9.4 非常重要：某些遮蔽失败会保留真实值

`v0.0.75` 的环境变量遮蔽源码明确记录了以下行为：[S15]

| 配置或失败条件 | 可能发生的行为 | 本报告建议 |
|---|---|---|
| `extract` 正则没有匹配，使用默认 `onExtractNoMatch` | 仅警告，真实环境值仍可能保留 | 明确设为 `error` 或 `deny`；优先整个值遮蔽 |
| 使用 JWT 解码模式，但值无法按该模式验证 | 警告后保留真实值 | 第一版不要使用；先做独立输入验证与负向测试 |
| `maskClaims` 找不到符合条件的字段 | 可能同样保留真实值 | 不得把“配置存在”当作已经遮蔽成功 |

`onExtractNoMatch` 不能被想当然地视为所有 JWT 分支失败的统一保护开关。不能仅搜索日志里有没有 warning 来判断安全，也不能在密钥已经出现在沙箱后再补救。

**对你的个人 Agent，最稳妥的基础设计仍然是：真实模型密钥只在主进程；不可信执行 worker 根本不继承密钥。** 第一版使用干净环境与独立可信 API 工具，减少对复杂遮蔽正确性的依赖。

---

## 十、超时、取消、回收与输出：由你的 Agent 补齐

### 10.1 至少区分三个期限

| 阶段 | 控制目标 |
|---|---|
| 准备期限 | 防止依赖探针、代理初始化、规则生成或扫描无限等待 |
| 执行期限 | 命令最长运行时间、用户取消、工作量限制 |
| 清理期限 | 终止剩余进程、关闭管道、回收代理与临时状态 |

这些期限由可信主进程制定，模型的请求值只能被缩小或限制在上限以内。`Promise.race()` 只让等待者返回，不会自动停止背后的进程；`child.kill()` 也不能被概括成跨平台的完整进程树回收。[S24]

Linux 的 bubblewrap 会使用自身的会话和进程相关机制，因此“杀外层 shell 的进程组”是否覆盖所有实际子进程，需要按真实启动拓扑验证。macOS 同样需要测试后台进程、孙进程和脱离会话的进程；不要把未经验证的通用 `kill(-pid)` 写成完整安全保证。[S09]

**最低验收要求：**任务超时、用户取消、worker 异常退出后，测试进程不再持续写文件、不再持有任务监听端口、不再占用任务资源。无法证明回收完成时，应把任务标记为隔离设施故障，并停止在该执行槽继续调度。

### 10.2 输出要有硬上限

分别限制 stdout、stderr 和合计字节；达到上限时停止收集并按预定策略终止任务，避免把任意大输出累积到内存。流式输出也要做背压处理。

任务结果建议包含：

```text
jobId / commandId / policyHash / runtimeVersion
状态：completed | rejected | timed_out | cancelled | infrastructure_error
exitCode / signal
stdout / stderr / 是否截断
执行时长
可信侧诊断摘要
```

这些是你的应用状态，不是 SRT 保证提供的完整业务协议。状态与身份字段由可信层生成，不接受子命令输出覆盖。普通程序失败、策略拒绝、初始化失败和用户取消应可区分，便于 coding agent 正确决定下一步。

### 10.3 并发与清理要绑定任务边界

第一版使用一个任务一个 worker，并且同一工作副本只允许一个任务修改。每次执行完成后进行命令相关清理，再结束 worker 的 SRT 状态。[S06]

Linux 的挂载点保护可能涉及在宿主创建占位文件；正常清理和强制中止后的行为需测试。崩溃后应依据任务清单回收你自己创建的目录，不能通过“把工作区可疑点文件全删掉”来修复残留。[S09]

需要长期运行的服务时，另设显式生命周期与权限，不应把它伪装成一个已经结束的普通命令。也不要让下一任务复用尚未确认干净的 worker。

---
## 十一、平台差异与高风险开关

### 11.1 macOS：不要因为工具报错就开放宿主服务

| 选项或能力 | 需要理解的边界 | 第一版建议 |
|---|---|---|
| `allowAppleEvents` | 可让受限程序通过应用启动等路径触发不受原沙箱约束的应用执行 | 保持 `false`；桌面自动化另设可信、可审批的工具 |
| `network.allowLocalBinding` | 当前生成规则不只是“允许监听一个端口”，还涉及广泛的绑定、入站与 localhost 出站权限 | 保持 `false`；开发服务器单独评估 |
| `network.allowMachLookup` | 增加对指定 Mach/XPC 服务的访问，是额外宿主能力 | 不默认添加，不由模型修改 |
| `enableWeakerNetworkIsolation` | 为兼容部分证书验证场景扩大 trustd 访问，官方注明潜在外传渠道 | 保持 `false`；先排查工具和证书配置 |
| `network.allowUnixSockets` | 指定 Unix socket 可能通向宿主高权限服务 | 默认空；不能笼统放行整个目录 |

对应风险可由该版本配置说明与 macOS 规则生成代码确认。[S05][S10]

特别强调 **`allowLocalBinding`**：当前代码中的规则允许对 `localhost:*` 的出站访问，并有广泛的绑定/入站规则。因此，不能把它解释为“只让测试程序安全地监听 `127.0.0.1:3000`”。它可能使宿主数据库、浏览器调试端口、开发代理等成为可接触目标。[S10]

需要本地服务时，应用自身还要明确监听地址、认证方式和可达范围，并用不同策略/worker 隔离。无法接受扩大后的宿主访问范围，就不要使用这个开关来解决问题。

### 11.2 Linux：不要把 socket 限制理解成逐路径白名单

`network.allowUnixSockets` 的路径列表是 macOS 特定能力，在 Linux 上被忽略；Linux 相关 seccomp 约束不能据此实现同样的逐路径授权。`allowAllUnixSockets` 则会显著改变相关限制。[S05][S09]

另外，阻止创建某类 socket，并不意味着已经消除了所有经继承描述符获得的通信能力。因此，启动不可信命令时不要额外继承宿主 socket、数据库连接、SSH agent、打开的敏感文件或通用控制 fd。

Node 场景默认只保留必要的标准输入/输出/错误管道；不要为了方便把主进程 IPC 通道直接传给不可信命令。需要内部工作协议时，协议必须限定能力，而不是提供“请求宿主任意读文件/执行命令”的后门。

另外，不能把 `allowLocalBinding: false` 理解为 Linux 沙箱自身网络命名空间内的所有监听行为都被禁止；它与 macOS 的相关规则不是同一份端口能力契约。

`enableWeakerNestedSandbox` 不是一个无害的兼容参数；它会改变嵌套环境下的隔离设置。应优先修复环境或更换执行位置，而不是在自动重试里把它打开。[S09]

### 11.3 Java、依赖安装和真实工具链

该标签含有 JVM 代理辅助逻辑，用来解决 Java 工具不按普通代理环境变量完成认证和连接的问题。打包或瘦身时漏掉相关 JAR，可能使 Maven、Gradle 等工具联网失败；应检查实际辅助文件和环境，而不是直接开放裸网络。[S22]

安装依赖也是不可信执行的一部分。npm 的生命周期脚本，以及 Python 包构建后端，都可能执行代码。因此，不能把“安装依赖”作为沙箱外的普通准备动作。[S25][S26]

建议将依赖处理与运行任务分阶段：先在明确网络策略下获取/构建依赖，再以更小权限运行测试。`npm ci --ignore-scripts` 可以降低某些安装阶段执行脚本的范围，但它不是整个包执行安全的证明；后续测试与导入依赖仍必须受限。[S25]

---

## 十二、审批、诊断与日常运行

### 12.1 审批应批准明确的权限变化

不要把“这个命令被拒绝了”自动翻译为“用户批准后不加沙箱重跑”。更合理的流程是：

```text
命令被拒绝
  → 可信层确认真正缺少的能力
  → 生成最小权限差异与执行范围
  → 用户批准或拒绝
  → 生成新的不可变 policy 和新的 worker
  → 在新限制下重试
```

审批记录建议绑定：任务、命令内容或摘要、工作区标识、权限差异、目标域名/端口、有效期、重试次数与 `policyHash`。工作区状态或命令发生实质变化时，应重新评估；不能让一次“安装依赖”批准永久变成全部命令联网。

上游 `updateConfig()` 的存在，不应诱导你把共享 manager 当作动态权限开关。已经运行的文件系统规则、现有连接，以及在初始化时捕获的部分网络组件，不应被当成可以通过一次更新全部同步撤回的状态。[S06]

**需要撤权时，优先停止该任务，并在新 worker 中应用新策略。** 不应声称“把域名从配置里删掉”已经强制切断所有既有通信。

### 12.2 诊断是线索，不是权限判断依据

SDK 可以启用日志监控，按独立 `commandId` 查询相关事件。建议使用 UUID，而不是长命令文本作为关联键；长文本前缀和重复命令不适合作为唯一执行身份。[S06]

`SandboxViolationStore` 是有限容量的近期事件存储，而不是持久审计数据库；当前默认保留最近 100 条事件。需要审计时，由可信层及时收集并保存脱敏后的摘要。[S19]

Linux 监控源码明确指出，其中部分观察信息来自不可信进程相关的、存在竞态的状态，仅用于诊断，不能据此作授权决定。没有日志不代表没有拒绝或没有风险，日志里出现“允许”也不能当成可信授权。[S20]

`ignoreViolations` 影响诊断输出，不是一个正确的权限放行机制。不要通过隐藏警告让验收显得成功。[S19]

### 12.3 哪些内容不应直接记到日志

不要记录真实凭证、完整环境变量、CA 私钥，或未经审查的完整包装命令。包装命令和代理环境可能包含内部代理认证信息；调试日志也应当受到访问与保留期限限制。[S06][S08]

命令自身可能包含用户数据或秘密，因此 `displayCommand` 应按产品需要脱敏。标准输出、标准错误、诊断文本和工具描述都是不可信输入，不能通过其中一段“已获批准”的文字触发权限提升。

### 12.4 升级策略

固定版本不等于永不升级。每次升级至少复查：配置 schema、默认写目录、文件读取例外规则、网络代理与凭证路径、平台依赖警告、弱化开关以及发布包辅助文件。

官方曾公布空网络允许列表未按预期隔离的历史问题，影响 `<0.0.16`，在 `0.0.16` 修复。这个公告不是 `0.0.75` 仍存在该漏洞的证据，但说明**空白名单阻断测试应该永久留在你的回归套件里**，而不是相信默认配置永远不变。[S21]

升级流程建议为：固定候选版本 → 阅读变更与安全公告 → 在真实 macOS/Linux 运行回归 → 检查依赖与包内容 → 再更新锁文件和部署版本。回滚也要考虑旧版本已知安全问题，而不是只按功能是否正常决定。

---

## 十三、验收测试：证明“不该成功的操作确实失败”

### 13.1 测试前提与判定方式

所有测试使用临时目录、随机生成的假凭证、自有测试服务和受控测试域名。不要使用真实 SSH 密钥、真实云凭证、生产数据库或第三方系统做破坏性验证。

测试至少覆盖实际使用的 macOS 与 Linux 环境。macOS 机器上的 Linux 容器测试不能替代 macOS 后端测试；如果只完成一个平台，就只声明该平台已验证。

建议每个测试记录：OS/版本/架构、SRT 与 Node 版本、实际策略 hash、命令、受控目标、预期效果、实际效果与结果证据。**以下列表是应实现的测试计划，不是本报告已执行并通过的结果。**

### 13.2 P0：所有基础版本必须通过

| ID | 场景 | 验收标准 |
|---|---|---|
| P0-01 | 工作区内正常读取、编辑、运行简单程序 | 合法任务能够完成，输出与文件结果正确 |
| P0-02 | 读取真实用户目录下的假密钥 | 内容不可获得；不只看退出码 |
| P0-03 | 读取另一任务的假密钥和控制目录 | 两者均不可获得 |
| P0-04 | 在允许读取的工作区内读取明确禁止的 `secrets` 子目录 | 更具体禁止生效 |
| P0-05 | 工作区外创建、覆盖、删除保护文件 | 文件存在性与内容保持预期，无越界副作用 |
| P0-06 | 修改工作区内受保护 `.git`、`.env`、控制配置 | 被拒绝；配置未被篡改 |
| P0-07 | 符号链接指向工作区外；路径中含 `..`；前缀相似目录 | 不获得额外读取/写入权限 |
| P0-08 | 尝试使用共享 `/tmp/claude` 等默认磁盘路径 | 按本项目策略阻断；任务私有 tmp 正常可用 |
| P0-09 | 任务启动后出现新的受保护文件 | 不依赖启动时 glob 快照造成保护遗漏 |
| P0-10 | 子命令打印所有环境变量 | 不含宿主真实凭证、危险注入变量或 SSH agent 路径 |
| P0-11 | 离线 profile 用普通 HTTP 客户端请求受控外部目标 | 目标没有收到请求 |
| P0-12 | 删除代理变量后直接连接；用子进程发起连接 | 未授权目标仍未被连接 |
| P0-13 | 非授权 SOCKS 目标、直接 TCP、其他工具客户端 | 不因换客户端而绕过目标限制 |
| P0-14 | 指定不存在、不可读、非法 JSON 的策略文件 | 原始命令不执行，不自动使用默认配置 |
| P0-15 | 策略字段拼错、未知键、残留占位符、相对路径 | 应用配置编译器直接拒绝 |
| P0-16 | 缺少 bwrap/socat/rg 或必须的辅助文件 | 不可信命令不执行；状态为设施不可用 |
| P0-17 | Linux seccomp 能力缺失或关键警告 | 不退化为未限制 socket 的成功任务 |
| P0-18 | 初始化抛异常、规则生成失败、代理启动失败 | 不执行原命令；清理任务资源 |
| P0-19 | 超时、取消、worker 崩溃，含子进程与后台进程 | 无持续任务写入、遗留监听或持续资源占用 |
| P0-20 | 无限 stdout/stderr、二进制输出、输出后保持管道打开 | 内存与输出受限，任务可终止 |
| P0-21 | 同时提交离线任务与联网任务 | 离线任务不借用另一任务权限；第一版可直接串行拒绝/排队 |
| P0-22 | 修改工作区里的“策略”文件、提示主进程自动放宽 | 权限来源不变；需要真正可信审批 |
| P0-23 | 通过文件工具、HTTP 工具、MCP 或解释器绕过统一执行入口 | 每条路径均有边界；未覆盖入口不对 Agent 开放 |
| P0-24 | 导出含恶意 symlink/越界路径的生成产物 | 宿主导出与合并步骤不越界 |
| P0-25 | shell 参数含空格、引号、分号、美元替换和换行 | 宿主外层不意外执行内容；仅在批准的沙箱语义中处理 |

P0-09 不应设计成“证明全部新文件自动安全”，而应针对本项目明确保护的目录与新文件位置验证。未纳入权限范围的敏感路径必须在威胁模型中显式列为未覆盖，不能用测试没写到来隐瞒。

### 13.3 P1：启用网络或平台特有能力后必须通过

| ID | 场景 | 验收标准 |
|---|---|---|
| P1-01 | 允许的精确域名与端口；相同域名不同端口 | 只放行明确批准的组合 |
| P1-02 | 同时匹配拒绝与允许；通配子域与根域 | 优先级与模式边界符合预期 |
| P1-03 | 允许目标重定向到未允许目标 | 不自动扩大目标范围 |
| P1-04 | 请求内网、云元数据地址或解析到这些地址的受控域名 | 根据本项目明确的 SSRF 防护要求判定；不能预设 SRT 已提供 |
| P1-05 | macOS 系统解析与受控 DNS 观察 | 记录真实行为；要求全离线却存在外联时，该能力不通过 |
| P1-06 | macOS localhost、浏览器调试端口、受控 Unix socket | 默认策略不可访问未经批准的宿主服务 |
| P1-07 | macOS Apple Events/应用启动路径 | 不得通过应用启动获得不受约束执行；测试只使用受控程序 |
| P1-08 | Linux 继承描述符、宿主 IPC、socket 创建 | 不出现未批准的宿主通道 |
| P1-09 | Node、Python、Git、curl、Java 等真实工具 | 各自网络路径都符合策略，而不只是 curl 正常 |
| P1-10 | 生效中的连接遇到撤权与任务终止 | 明确验证连接和任务停止，不以配置变更代替验证 |

### 13.4 P2：只有启用高级功能才需要，但不能省略

| ID | 场景 | 验收标准 |
|---|---|---|
| P2-01 | HTTP 过滤：方法、路径、查询、异常、超时 | 符合明确规则；异常不放行；回调不会无限占用 |
| P2-02 | HTTPS、TLS 排除域、证书固定、SOCKS 路径 | 列出过滤实际覆盖范围；未覆盖路径不能声称受相同 L7 限制 |
| P2-03 | mask 整值、正则不匹配、JWT 无效、字段缺失 | 沙箱中不得出现测试真实值；失败处理满足项目要求 |
| P2-04 | 同一凭证发送到允许但非 `injectHosts` 的目标 | 不注入真实凭证 |
| P2-05 | 文件 mask 在 macOS/Linux 上的差异 | 业务接受实际差异；不把 deny 误判成同样的假文件体验 |
| P2-06 | 外部代理替换、父代理、CA 文件和辅助包缺失 | 无未过滤出口、无真实凭证泄露、失败可诊断 |

这三组测试体现的是你的产品承诺。无法通过的能力，应禁用、收缩承诺或增加外层控制；不应通过关闭沙箱、忽略警告或删测试来“修复”。

---

## 十四、故障排查：先找最小原因，不自动扩大权限

| 现象 | 优先检查 | 不应该做的修复 |
|---|---|---|
| Node/Python 命令找不到或无法加载库 | 固定 PATH、解释器真实位置、只读工具链放行、动态库依赖 | 直接允许读取和写入整个 home |
| 临时文件创建失败 | `CLAUDE_CODE_TMPDIR`、任务 tmp 是否存在、是否被父路径拒绝 | 开放整个 `/tmp`，或使用其他任务共享目录 |
| Java/Maven/Gradle 网络失败 | JVM 代理辅助 JAR、实际环境、代理认证、证书配置 | 关闭网络隔离或盲目继承用户 JVM 启动变量 |
| Git 提示权限、配置或 hooks 问题 | 独立副本、Git 元数据位置、具体命令是否真的需要写配置 | 开放真实仓库整个 `.git` 或 SSH agent |
| Linux bwrap 无法创建命名空间 | 用户命名空间、发行版安全配置、容器限制 | 自动 sudo、`--privileged`、关闭全局安全机制 |
| 只有某些 glob 拒绝规则没效果 | 当前平台的 glob 语义与实际展开结果 | 根据 macOS 的成功推断 Linux 一定一致 |
| 本地开发服务器或浏览器自动化失败 | 宿主连接、Mach/XPC、监听范围是否属于本次授权 | 自动打开 local binding、所有 socket 或 Apple Events |
| TLS 校验失败 | 信任链、工具对 CA 的支持、是否确实需要 TLS 终止 | `-k`、关闭证书验证、自动启用 weaker isolation |
| 任务退出后仍有进程或文件变化 | 监督器真实进程拓扑、后台进程、清理步骤 | 仅调用 `reset()` 就宣告任务结束 |
| 读取被保护文件却返回成功退出码 | 文件是否被遮蔽为空、脚本是否吞掉错误 | 仅根据退出码认定沙箱失效或有效 |

上表是排障流程建议；涉及的具体平台行为见前文对应源码引用。对于尚未确认原因的问题，应返回可诊断的失败，而不是扩权后重试。

---

## 十五、可直接交给 AI coding agent 的实施任务书

下面这段可以作为项目实施指令。将本报告一并提供，让 coding agent 按固定源码基线查证，不要只给它一句“接入 SRT”。

````text
任务：把 Anthropic Sandbox Runtime 接入这个个人 AI Agent，目标平台为 macOS 与 Linux。

先阅读随附《Anthropic Sandbox Runtime：个人 AI Agent 接入与安全实践指南》。
源码研究基线是 v0.0.75。实施时核对实际安装版本、发布包内容和最新安全公告；
未经兼容性与安全回归验证，不自动升级到 latest，也不因本报告版本号而永久忽略安全更新。

【先理解现有项目，不假定技术栈】
搜索所有执行与副作用入口：shell、exec、spawn、subprocess、ProcessBuilder、eval、
代码解释器、文件读写、HTTP、浏览器、MCP、构建脚本、插件加载和依赖安装。
输出调用链、可信/不可信边界，以及可能绕过统一执行入口的位置。
不要为了接入 SRT 重写整个 Agent；优先复用已有工具接口与可靠的进程监督能力。

【架构要求】
保留可信主进程负责模型通信、审批、任务状态和策略编译。
不可信代码全部进入受限执行路径。
优先一个任务一个独立 Node worker；如果现有监督器适合 CLI，也可通过固定 SRT CLI 接入，
但严格依赖检查、语义探针、生命周期与错误分类不能省略。
每个 worker 使用不可变配置，第一版同一工作区串行；不在主进程并发 chdir。
不把共享 SandboxManager 的动态配置当成每个调用的独立网络权限。

【策略与目录】
实现本项目自己的严格 profile schema，再编译成 SandboxRuntimeConfig。
模型只能申请 profile，不能直接提交 SRT 原始配置、任意路径或环境变量。
第一版只开放 offline-workspace：精确控制工作副本、任务 HOME、tmp 和缓存。
先盘点真实 home、其他用户数据根目录和敏感挂载点，再明确 denyRead / allowRead。
不要认为 allowRead 是全局白名单；处理内置默认磁盘写路径。
安全关键文件规则使用绝对路径，拒绝未知字段、占位符与不支持的 glob。
运行时、策略、审批与控制文件不在任务可写范围内；不允许编辑后自动重载可信主程序。
固定 shell、Node、SRT 与后端辅助文件路径，不从仓库中的可写目录解析这些可信程序。

【环境与凭证】
在启动 worker 前构建环境变量白名单；不复制完整宿主环境。
模型密钥、云凭证、SSH_AUTH_SOCK 和危险解释器/动态库注入变量不得进入不可信执行。
HOME 使用任务私有目录；真实 home 的保护使用实际绝对路径。
同时正确设置任务 TMPDIR 与 CLAUDE_CODE_TMPDIR。
第一版不启用 TLS 终止、复杂 credential mask、Apple Events、所有 Unix socket、
local binding 或 weaker isolation。
需要真实外部 API 操作时，优先增加窄接口可信工具，并单独授权。

【执行与失败处理】
所有外层进程启动使用参数数组，不在宿主 shell 中拼接模型文本。
明确哪些工具参数是 argv，哪些是只在沙箱内解释的 shell command。
初始化或依赖检查失败，不执行原命令，不回退到不加沙箱的执行器。
关键依赖警告视为失败；未经审核不自动启用兼容性弱化开关。
实现准备、运行和清理期限、输出字节上限、取消、进程树回收和崩溃恢复。
不要把 Promise.race、child.kill 或 SandboxManager.reset 当成完整回收证明。
进程没有确认回收完成时，不复用执行槽，也不报告成功。

【审批与网络】
后续联网 profile 使用精确域名与端口，strictAllowlist=true。
从离线策略切换到联网策略时，正确处理 deniedDomains 中的通配拒绝。
拒绝后只申请最小权限差异；批准结果绑定任务、命令、工作区、策略 hash 和有效期。
用新 worker 应用新策略，不临时扩大所有并发任务的共享权限。
域名白名单不等于 HTTP 只读、不等于完整防泄漏或 SSRF 防护。
不得把 filterRequest 当成自动覆盖 SOCKS 等所有网络路径。

【测试与证据】
实现随附报告的 P0 测试；联网能力还要实现相应 P1，高级功能再实现 P2。
所有测试只使用临时文件、假密钥与受控网络目标。
在真实 macOS 和 Linux 上分别验证；记录系统、架构、Node/SRT 版本、策略与结果。
重点检查“禁止操作未产生效果”，而不是仅检查退出码或日志中出现 sandbox 字样。
如果只能测试一个平台，明确列出另一平台未验证，不声称双平台通过。
macOS DNS 等边界不满足本项目承诺时，禁用对应能力或增加外层隔离。

【交付物】
1. 现有执行入口审计与推荐接入点。
2. profile schema、严格验证器、策略编译器与环境白名单。
3. 执行适配器、独立 worker、监督器或现有监督器的必要增强。
4. offline-workspace 示例及后续最小联网 profile 的受控扩展位置。
5. 单元测试、双平台集成测试、负向安全测试与真实执行结果。
6. 安装、诊断、审批、版本升级、恢复清理和已知边界文档。

实施顺序：先关闭绕过路径并完成离线安全闭环，再开放网络，再考虑并发与高级凭证。
不为让测试通过而扩大权限。遇到无法满足的能力，给出具体失败证据和替代边界，
不能把部分兼容包装成完整安全保证。
````

### 推荐分阶段验收

**阶段 A：离线闭环。** 完成执行入口盘点、不可变策略、环境清理、独立工作副本、失败拒绝和 P0 测试。这一阶段就可以为个人 Agent 提供实用能力。

**阶段 B：最小联网。** 按实际任务开放少数目标与端口，补齐审批、受控网络工具、工具链验证和 P1。网络权限以用途为单位，不以“Agent 现在很聪明”作为授权依据。

**阶段 C：按需扩展。** 确有收益时再加入并发、共享只读缓存、特殊 IPC 或高级凭证功能；每项扩展分别记录新权限、威胁与测试。不是必须把所有 SRT 特性都启用，才算完成集成。

---

## 十六、最值得记住的设计判断

**对你的项目，SRT 最合适的位置是“统一工具执行层下面的操作系统限制器”，不是审批系统、不是完整 Agent 安全框架，也不是不可信代码的万能容器。**

优先把真实秘密留在可信主进程，把危险执行放进独立 worker 启动的受限进程，把权限写成可信的不可变配置，把每项安全承诺写成负向测试。相比继续增加配置项，这些边界更决定你的接入是否可靠。

最容易造成“看似接上了，实际没有守住边界”的错误，是：文件读取默认放行却未保护 home；环境中仍带密钥；其他工具绕过执行器；共享 manager 动态扩权；忽略依赖警告；以及超时后留下继续运行的进程。

**先交付权限小、覆盖完整、失败可拒绝的版本，再逐步增加能力。**

---

## 十七、来源索引

核心实现引用固定到 `v0.0.75`。以下链接是公开英文主源；示例代码与实施方案为本报告自行整理，不是从官方复制的完整生产实现。

| 编号 | 来源与用途 |
|---|---|
| [S01] | GitHub `v0.0.75` Release：日期、版本与发布基线 |
| [S02] | 固定标签 README：定位、平台、依赖、网络架构、DNS 等说明 |
| [S03] | `package.json`：包名、版本、引擎与分发结构 |
| [S04] | CLI 源码：配置加载、参数模式、版本字符串和命令启动 |
| [S05] | 配置 schema：有效字段、实验性能力和风险说明 |
| [S06] | manager 源码：生命周期、共享状态、包装接口和环境行为 |
| [S07] | 内部约束 schema：读写模型、网络规则与凭证平台差异 |
| [S08] | sandbox utilities：默认写目录、TMPDIR、代理与信任环境 |
| [S09] | Linux 后端：命名空间、seccomp、路径、占位与清理 |
| [S10] | macOS 后端：Seatbelt、local binding、Mach/XPC 与路径规则 |
| [S11] | 公开导出：SDK 可用接口 |
| [S12] | 域名模式实现：主机、通配符与端口匹配 |
| [S13] | 请求过滤实现：HTTP Request 回调与失败处理 |
| [S14] | SOCKS 代理实现：目标判断与 TCP 转发路径 |
| [S15] | 环境凭证遮蔽：extract/JWT 失败处理与注入目标 |
| [S16] | 文件凭证遮蔽：替代文件与平台限制 |
| [S17] | 凭证 sentinel：目标约束和替换映射 |
| [S18] | 上游代理实现：宿主目标连接与代理环境处理 |
| [S19] | 违规事件存储：容量、查询与诊断过滤 |
| [S20] | Linux 观察器：诊断信息的非授权用途 |
| [S21] | 官方安全公告：历史空允许列表问题及修复范围 |
| [S22] | Java 代理辅助：JVM 工具兼容与打包要求 |
| [S23] | Claude Code 官方沙箱说明：产品控制与独立运行时的区别 |
| [S24] | Node.js 子进程文档：shell、输出与进程事件/信号语义 |
| [S25] | npm ci 官方文档：锁文件安装与 ignore-scripts |
| [S26] | pip 构建系统官方文档：构建后端与执行阶段 |

[S01]: https://github.com/anthropics/sandbox-runtime/releases/tag/v0.0.75
[S02]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/README.md
[S03]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/package.json
[S04]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/cli.ts
[S05]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/sandbox-config.ts
[S06]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/sandbox-manager.ts
[S07]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/sandbox-schemas.ts
[S08]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/sandbox-utils.ts
[S09]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/linux-sandbox-utils.ts
[S10]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/macos-sandbox-utils.ts
[S11]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/index.ts
[S12]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/domain-pattern.ts
[S13]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/request-filter.ts
[S14]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/socks-proxy.ts
[S15]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/credential-mask-env.ts
[S16]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/credential-mask-files.ts
[S17]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/credential-sentinel.ts
[S18]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/parent-proxy.ts
[S19]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/sandbox-violation-store.ts
[S20]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/linux-violation-monitor.ts
[S21]: https://github.com/anthropics/sandbox-runtime/security/advisories/GHSA-9gqj-5w7c-vx47
[S22]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/src/sandbox/java-proxy-agent.ts
[S23]: https://code.claude.com/docs/en/sandboxing
[S24]: https://nodejs.org/api/child_process.html
[S25]: https://docs.npmjs.com/cli/v11/commands/npm-ci/
[S26]: https://pip.pypa.io/en/stable/reference/build-system/
