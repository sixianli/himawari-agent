# PR 391 第 2 轮作者说明

第 1 轮意见和处理见上一轮；这一轮只看 de952d31..39b5c0d8 的改动：
1. 新函数 `validateCallerGrantsCalledPermissions(mainSource, ciSource)`（scripts/ci/main-workflow.mjs）：取 main.yml `jobs.full.permissions`，没有则取工作流级 `permissions`；ci.yml 顶层和每个作业申请的每项权限都不得高于它，否则抛 `MAIN_WORKFLOW:full-grants-<scope>-<level>`。未知级别按最高算（一定失败）。
2. check-policy.mjs 的 main() 调用它，所以属于 `npm run check:ci-policy`，进入本地必过门槛。
3. `full-permissions` 改为排序后比较键值对。
4. 设计规范第 129、274 行写明 main.yml full 的权限例外。
5. 新增 6 条测试。

请核对：新函数是否有漏判（例如 `permissions: write-all` / `read-all` 这种字符串写法、ci.yml 作业级 `permissions: {}`），以及测试的反向用例是否真会失败。
