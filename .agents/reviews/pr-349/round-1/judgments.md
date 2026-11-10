# PR 349 第 1 轮复核判断

## 成立，已改

- r1-ds-1 / r1-glm-1（中，线程判中、高）：新测试只在 `npm test` 里跑，快速模式的必过检查 `npm run check` 不含它，事故行自己写的根因就是这一点。已改：把核对逻辑写成 `scripts/ci/check-policy.mjs` 的 `validateInstallScriptReviews`，由 `main` 调用，属于 `npm run check:ci-policy`（`npm run check` 的一步）。依据：`node scripts/ci/check-policy.mjs` 在真实锁文件上通过，在 `origin/main` 的旧 `ci/toolchain-lock.json` 上报 `Install-script review for a package missing from package-lock`。
- r1-ds-3（低）：没有夹具反向用例。已改：测试改用夹具，版本不符、过期记录、多余记录、缺记录四种都必须失败，并保留一条对真实锁文件的通过用例。
- r1-ds-4（低）：事故行措辞改为“与 `package-lock.json` 里的 `integrity` 一致”（我实际核对的就是这个：`npm pack` 得到的 tarball 的 sha512 与 `package-lock.json` 的 `integrity` 逐字相同）。

## 不成立

- r1-ds-2 / r1-glm-2：测试不比较 `scripts`、`reviewedFiles`、`implicitBuild`。这个检查只声称“两份锁文件对得上”，脚本内容与发布包是否一致由 `npm ci` 后的 `auditInstalledDependencies` 核对（`scripts/ci/install-dependencies.mjs:201-212`），事故行已写明这一点。模型担心的“只有 `binding.gyp` 的包会被误判”：`package-lock.json` 里 npm 对这类包同样写 `hasInstallScript: true`，当前 5 个标记包和 5 条记录一一对应；没有可达输入造成误报或漏报。
- r1-ds-5：fsevents 的 `scripts: {}` 是对的。我下载了 fsevents@2.3.3 的发布包：`scripts` 里只有 clean、build、test、prepublishOnly，没有 preinstall、install、postinstall，也没有 `binding.gyp`；`auditInstalledDependencies` 比较的是这三个生命周期，所以记录与实际一致。`hasInstallScript: true` 是 npm 锁文件已有的标记，与本 PR 无关。
- r1-glm-3：模型无法上网所以“未核实”，不是发现的错误。我已下载 `@google/genai@2.21.0` 发布包核对：安装阶段脚本只有 `preinstall: echo 'preinstall: no-op'`，没有 install、postinstall、`binding.gyp`。
