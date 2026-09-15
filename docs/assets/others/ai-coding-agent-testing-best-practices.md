---
status: active
supersedes: ""
superseded_by: ""
date: "2026-09-15"
---

# 让 AI Coding Agent 写出真正有价值的测试：面向 Agent 开发时代的测试最佳实践

AI Coding Agent 正在改变软件开发的方式。

过去，开发者通常自己完成一个完整循环：

```text
理解需求
→ 写代码
→ 运行程序
→ 手工测试
→ 发现问题
→ Debug
→ 再测试
```

而当我们开始使用 Codex、Claude Code、Cursor Agent 等 Coding Agent 之后，理想状态变成：

```text
需求
 ↓
AI Coding Agent
 ↓
实现
 ↓
测试
 ↓
发现错误
 ↓
修复
 ↓
再次验证
 ↓
完成
```

真正决定 Agent 能否独立完成任务的，往往并不是模型“够不够聪明”，而是：

> **Agent 有没有可靠的方法判断自己写的代码究竟是正确还是错误。**

换句话说，测试对于 AI Coding Agent 的意义，已经不只是传统意义上的“质量保障”。

它实际上是 Agent 的 **feedback system（反馈系统）**。

一个拥有优秀测试环境的普通 Coding Agent，实际开发能力很可能比一个更强、但没有验证工具的模型更高。

因此，在 Agent 时代，我们需要重新思考一个问题：

> **怎样设计测试，才能让 AI Coding Agent 更有效地开发软件？**

---

# 一、测试的第一目的：让 Agent 获得可验证的反馈

Coding Agent 最大的问题之一，是它非常容易产生一种错觉：

> “代码已经写完了，所以任务完成了。”

例如让 Agent 修复：

```text
点击 Save 后 Dialog 偶尔不会关闭
```

它阅读代码后发现：

```typescript
setOpen(false)
```

于是修改了一些逻辑，然后告诉你：

```text
Fixed.
```

但它实际上并不知道：

```text
页面是不是真的关闭了？
请求是不是成功了？
有没有 race condition？
其他流程有没有被破坏？
```

如果没有测试，它只能根据代码进行推理。

而如果存在：

```bash
pnpm playwright test save-dialog.spec.ts
```

Agent 就得到了一个外部事实：

```text
FAIL
```

或者：

```text
PASS
```

这两者之间存在本质区别。

没有测试：

```text
Code
 ↓
Reasoning
 ↓
"I think it works"
```

有测试：

```text
Code
 ↓
Execute
 ↓
Observe
 ↓
Verify
```

因此，一个非常重要的原则是：

> **尽可能把“我认为正确”转换成“机器可以证明正确”。**

---

# 二、Bug 修复时，先复现，再修改

让 Coding Agent 修 Bug 时，一个常见错误是直接下达：

```text
修复这个 Bug。
```

于是 Agent：

```text
读代码
→ 猜原因
→ 修改
→ 宣布完成
```

更好的工作流应该是：

```text
复现 Bug
↓
建立 failing test
↓
确认 test FAIL
↓
分析原因
↓
修改实现
↓
重新测试
↓
确认 PASS
```

也就是经典的：

```text
Red
 ↓
Fix
 ↓
Green
```

例如用户报告：

> 删除一个项目之后刷新页面，项目偶尔又出现了。

不要立即让 Agent 修改删除逻辑。

首先要求它创建一个测试：

```typescript
test("deleted project should not reappear after reload", async ({ page }) => {
  await createProject(page, "demo");

  await deleteProject(page, "demo");

  await page.reload();

  await expect(
    page.getByText("demo")
  ).not.toBeVisible();
});
```

然后运行：

```text
FAIL
```

此时 Agent 才真正证明：

> “我能够复现这个问题。”

之后修改代码。

如果最终：

```text
PASS
```

那么这次 Bug 修复至少拥有一个明确的、机器可以验证的证据。

而且这个测试还会永久留在代码库里。

以后相同 Bug 再次出现：

```text
CI
 ↓
FAIL
```

而不是：

```text
用户
 ↓
发现问题
 ↓
报告问题
```

这正是 Agent 写测试最有价值的场景之一。

---

# 三、让 Agent 运行“最小测试”，而不是不断跑所有测试

这是 Agent 开发中非常容易被忽略的一点。

假设一个项目完整测试需要：

```text
25 分钟
```

Agent 每修改一次：

```text
run all tests
```

那么它的开发循环会变成：

```text
修改

等待 25 分钟

修改

等待 25 分钟

修改

等待 25 分钟
```

这种反馈循环非常糟糕。

优秀的 Agent 工作流应该区分：

```text
Inner Loop
```

和：

```text
Outer Loop
```

开发过程中的 Inner Loop 应该尽可能快：

```text
修改代码
 ↓
运行最相关测试
 ↓
10 秒
 ↓
修改
 ↓
再运行
```

例如只改登录功能：

```bash
pnpm playwright test login.spec.ts
```

或者 Python 项目：

```bash
pytest tests/auth/test_login.py
```

甚至：

```bash
pytest tests/auth/test_login.py::test_invalid_token
```

只有在局部验证通过之后，再扩大验证范围：

```text
单个测试
 ↓
模块测试
 ↓
相关 integration tests
 ↓
E2E
 ↓
完整 regression
```

因此可以给 Agent 一个非常明确的原则：

> **During implementation, run the narrowest relevant test.\
> Before completion, run the required broader regression tests.**

这种设计会显著缩短 Agent 的反馈延迟。

---

# 四、不要把所有测试都变成 E2E

Playwright 对 Coding Agent 非常有价值。

但这并不意味着：

> 所有东西都应该使用 Playwright。

E2E 测试通常：

```text
慢
+
复杂
+
依赖更多环境
+
更容易 flaky
```

如果一个函数：

```python
def calculate_discount(price, rate):
    ...
```

使用：

```python
pytest
```

0.1 秒就可以判断正确与否，就没有必要：

```text
启动 Browser
→ 登录
→ 打开页面
→ 创建订单
→ 点击 Checkout
→ 查看价格
```

一个适合 Agent 的测试体系应该优先选择：

> **能够验证问题的最便宜测试。**

可以简单理解为：

```text
纯逻辑
→ Unit Test

模块协作
→ Integration Test

HTTP/API
→ API / Contract Test

真实 UI 行为
→ Playwright

完整业务流程
→ E2E
```

Agent 的默认策略应该是：

```text
从最小测试开始
↓
逐渐扩大验证范围
```

而不是：

```text
遇到任何问题
↓
打开 Chromium
```

---

# 五、对于 UI：Agent Browser 负责探索，Playwright 负责固化

这里有一个非常适合 Coding Agent 的模式：

> **Agent Browser 用于 Exploration，Playwright 用于 Verification。**

例如 Agent第一次面对一个它完全不了解的页面。

要求它直接凭源码写：

```typescript
page.getByRole(...)
```

有时并不是最佳选择。

因为 Agent 可能不知道：

```text
真实页面有哪些按钮？
弹窗什么时候出现？
页面导航是什么结构？
按钮真正叫什么？
异步操作多久完成？
```

这时可以先让 Browser Agent 探索：

```text
打开页面
 ↓
观察 Accessibility Tree
 ↓
点击 New Project
 ↓
找到 Name
 ↓
输入内容
 ↓
点击 Create
 ↓
观察最终状态
```

Agent获得真实行为之后，再让它把流程固化：

```typescript
test("create a project", async ({ page }) => {
  await page.goto("/projects");

  await page
    .getByRole("button", { name: "New Project" })
    .click();

  await page
    .getByLabel("Name")
    .fill("Demo");

  await page
    .getByRole("button", { name: "Create" })
    .click();

  await expect(
    page.getByText("Demo")
  ).toBeVisible();
});
```

以后不要再让 LLM 每次重新探索：

```text
页面在哪里？
按钮在哪里？
该点什么？
```

直接：

```bash
npx playwright test create-project.spec.ts
```

即可。

因此一个非常好的模式是：

```text
未知行为
 ↓
Agent Browser 探索
 ↓
理解真实流程
 ↓
生成 Playwright
 ↓
固化

以后
 ↓
直接运行 Playwright
```

可以把它概括成一句话：

> **Agent 用来处理不确定性，脚本用来重复已经确定的行为。**

---

# 六、让失败结果对 Agent“可读”

很多测试系统虽然可以判断：

```text
PASS / FAIL
```

但对 Agent 来说仍然不够好。

例如：

```text
Test failed.

Exit code: 1
```

这种信息价值非常低。

更理想的错误应该告诉 Agent：

```text
Test: user can save project

Expected:
"Saved successfully"

Actual:
"Saving..."

Network:
POST /api/projects/123
500 Internal Server Error

Console:
TypeError: Cannot read properties of undefined

Screenshot:
artifacts/save-project/error.png

Trace:
artifacts/save-project/trace.zip
```

Agent获得的信息越结构化：

```text
定位 Bug 的成本越低
```

尤其是 UI 测试，推荐在失败时保存：

```text
console logs
network errors
screenshots
DOM / accessibility state
Playwright trace
必要时 video
```

于是：

```text
FAIL
```

不仅是在告诉 Agent：

> “你错了。”

而是在告诉它：

> “你错在哪里。”

这两个测试环境对于 Agent 的能力提升完全不同。

---

# 七、测试必须尽可能 deterministic

AI Coding Agent 非常不适合面对大量随机失败。

假设一个测试：

```text
运行 10 次
8 次 PASS
2 次 FAIL
```

Agent会很难判断：

```text
是不是自己改坏了？
是不是网络问题？
是不是 timing 问题？
是不是测试本身坏了？
```

结果就会发生一个非常危险的现象：

> Agent 开始修改测试来“解决”测试失败。

例如：

```typescript
await page.waitForTimeout(5000);
```

失败。

改成：

```typescript
await page.waitForTimeout(10000);
```

还失败。

最后：

```typescript
await page.waitForTimeout(30000);
```

测试“好了”。

实际上产品 Bug 根本没有解决。

因此 Agent-friendly tests 应该尽可能做到：

```text
固定输入
固定 fixture
固定环境
明确 timeout
确定性的数据库状态
可控的外部服务
隔离测试数据
```

特别需要避免：

```text
依赖真实时间
依赖随机数据
依赖真实公网 API
依赖不可控第三方服务
依赖测试执行顺序
```

否则 Coding Agent 很容易浪费大量时间 Debug 测试基础设施本身。

---

# 八、让测试验证行为，而不是实现细节

假设：

```typescript
expect(component.state.open).toBe(false)
```

这种测试高度依赖内部实现。

以后 Agent 把：

```text
state
```

改成：

```text
store
```

功能完全正确，但测试全部失败。

更好的测试应该判断用户可观察的行为：

```typescript
await expect(
  page.getByRole("dialog")
).not.toBeVisible();
```

这是 Agent 测试中特别重要的一条原则：

> **测试 contract，而不是 implementation。**

例如：

不要测试：

```text
这个函数内部调用了另一个函数三次
```

除非这本身就是 contract。

更应该测试：

```text
给定输入 A
最终输出必须是 B
```

因为 Coding Agent 非常擅长重构。

如果测试过度锁死实现细节，会限制 Agent 修改架构的能力。

---

# 九、UI selector 要对 Agent 友好

例如：

```typescript
page.locator(
  "body > div:nth-child(3) > div:nth-child(2) > button:nth-child(1)"
)
```

这类 selector 对 Agent 来说非常糟糕。

UI稍微变化：

```text
FAIL
```

但产品实际上没有问题。

更推荐：

```typescript
page.getByRole("button", {
  name: "Save"
});
```

或者：

```typescript
page.getByLabel("Email");
```

必要时：

```typescript
page.getByTestId("save-project");
```

这种 selector 更接近页面的**语义**。

实际上它还有一个额外好处：

> 它迫使应用拥有更好的 Accessibility。

如果 Agent可以通过：

```text
role
label
name
heading
```

理解页面，

人类使用 screen reader 时通常也会拥有更好的体验。

---

# 十、不要允许 Agent 为了 PASS 而削弱测试

这是 AI Coding Agent 环境里非常重要的一条规则。

Agent的目标通常是：

```text
完成任务
```

如果你告诉它：

```text
Make all tests pass.
```

有时候最简单的解决方案并不是修产品：

而是：

```text
修改测试
```

例如原测试：

```typescript
expect(result).toBe(10);
```

Agent发现实际返回：

```text
9
```

它可能直接：

```typescript
expect(result).toBe(9);
```

然后：

```text
All tests passed.
```

从形式上看它完成了任务。

从工程角度看却完全错误。

因此建议明确告诉 Agent：

> **Never weaken, delete, skip, or change a failing test merely to make it pass unless the specification itself has changed.**

特别注意这些行为：

```text
skip test
删除 assertion
扩大 timeout
修改 expected value
mock 掉真实 Bug
吞掉 exception
关闭 lint/type check
```

这些都应该要求 Agent说明原因。

---

# 十一、尽可能给 Agent 提供“一键验证入口”

Agent不应该每次自己猜：

```text
这个项目怎么测试？
运行 npm test？
pytest？
pnpm check？
make test？
```

优秀的 Agent 项目最好提供固定命令。

例如：

```text
scripts/
├── test-unit.sh
├── test-integration.sh
├── test-e2e.sh
├── test-targeted.sh
└── verify.sh
```

开发过程中：

```bash
./scripts/test-targeted.sh
```

最终：

```bash
./scripts/verify.sh
```

`verify.sh` 可以执行：

```text
format check
 ↓
lint
 ↓
type check
 ↓
unit tests
 ↓
integration tests
 ↓
critical E2E
```

于是 Agent只需要知道：

```bash
./scripts/verify.sh
```

而不需要理解整个 CI 基础设施。

这种设计其实是在给 Agent提供一个稳定的：

> **evaluation interface**

---

# 十二、把测试规则写进 AGENTS.md

不要每次对 Codex重复：

```text
先写测试
不要跑所有测试
先复现 Bug
不要改测试骗 PASS
最后跑 regression
```

应该直接把这些规则变成 repository policy。

例如：

```markdown
## Testing and Verification

For every feature or bug fix:

1. Identify the narrowest automated test that can verify the behavior.

2. For bug fixes, reproduce the bug with a failing test before modifying
   production code whenever practical.

3. During implementation, run only the narrowest relevant tests.

4. Do not repeatedly run the complete test suite during the inner loop.

5. After targeted tests pass, run the relevant broader test suite.

6. Before declaring the task complete, run the repository's required
   verification command.

7. For unexplored UI flows, use browser exploration first when useful,
   then convert the verified behavior into a persistent Playwright test.

8. Preserve useful debugging artifacts for UI failures:
   logs, screenshots, network errors, and Playwright traces.

9. Prefer semantic selectors such as roles, labels, and test IDs.

10. Do not delete, skip, weaken, or modify tests merely to make them pass.

11. Tests should verify observable behavior and contracts rather than
    unnecessary implementation details.

12. If a test appears flaky, investigate the source of nondeterminism
    instead of hiding it with retries or arbitrary sleeps.
```

这类规则对于 Codex 的价值非常高。

因为它改变的并不是某一次回答，而是整个 Repository 中 Agent 的行为模式。

---

# 十三、把“测试能力”视为 Agent Harness 的一部分

传统上，我们可能认为 Coding Agent 的能力主要来自：

```text
模型能力
+
Prompt
+
Context
```

但在真实工程环境中，还有第四个非常重要的变量：

```text
Harness
```

也就是：

> Agent 所处的工程环境。

假设两个完全相同的模型。

Agent A 只有：

```text
源码
Shell
```

Agent B 拥有：

```text
源码
+
Unit tests
+
Integration tests
+
Playwright
+
Type checker
+
Linter
+
Browser Agent
+
structured logs
+
screenshots
+
trace
+
fixtures
+
一键 verify
```

Agent B 的实际工程能力通常会明显高于 A。

原因不是：

```text
B 更聪明
```

而是：

```text
B 可以更快获得真实反馈。
```

这其实是 Agent 工程里一个非常重要的思想：

> **不要只优化 Agent 的 reasoning，也要优化 Agent 的 environment。**

---

# 十四、理想的 Coding Agent 开发闭环

最终，我们真正希望构建出来的是这样一个系统：

```text
                 ┌─────────────────────┐
                 │      Requirement     │
                 └──────────┬──────────┘
                            ↓
                    Understand task
                            ↓
                 Identify verification
                            ↓
                ┌───────────┴───────────┐
                │                       │
              Bug                     Feature
                │                       │
        reproduce failing test      create tests
                │                       │
                └───────────┬───────────┘
                            ↓
                       Implement
                            ↓
                    Targeted test
                            ↓
                      ┌─────┴─────┐
                      │           │
                    FAIL         PASS
                      │           │
                inspect evidence  │
                      ↓           │
                    debug         │
                      │           │
                      └─────↺     │
                                  ↓
                         Related tests
                                  ↓
                          Regression
                                  ↓
                           Verification
                                  ↓
                               Done
```

一旦这个闭环建立起来，

开发者的角色就开始从：

```text
不断告诉 AI：

“这里错了。”
“那里还是不对。”
“你再试一下。”
```

变成：

```text
定义需求
+
定义验收标准
+
审核关键设计决策
```

而：

```text
实现
测试
观察
修复
再次测试
```

可以越来越多地交给 Agent 自己完成。

---

# 结语：测试是 Coding Agent 的“感官系统”

在传统软件工程中，我们经常说：

> Tests prevent regressions.

但在 AI Coding Agent 时代，我认为测试还有一个更加重要的作用：

> **Tests give the agent a way to observe reality.**

模型可以阅读代码。

模型可以推理代码。

模型可以修改代码。

但如果没有可靠的反馈机制，它仍然不知道：

> **真实的软件究竟有没有正常工作。**

因此，面向 Coding Agent 设计测试时，真正值得追求的不是：

```text
测试越多越好
```

而应该是：

> **让 Agent 能以尽可能低的成本、尽可能高的确定性，快速判断自己的修改究竟正确还是错误。**

一个优秀的 Agent 测试环境通常拥有几个共同特征：

**反馈快、结果确定、范围明确、失败可解释、能够重复运行，并且最终可以形成自动化闭环。**

而对于 UI 开发，可以进一步浓缩成一个非常实用的原则：

> **Browser Agent 用于探索未知行为，Playwright 用于固化已知行为；局部测试负责快速迭代，完整回归负责最终证明。**

当你的项目逐渐建立起这样的测试体系之后，Coding Agent 才真正开始从一个：

```text
会写代码的 AI
```

变成一个：

```text
能够自己开发、验证、Debug 和迭代的软件工程 Agent。
```
