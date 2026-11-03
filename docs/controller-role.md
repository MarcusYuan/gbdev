# controller 角色定义（需求）

本文定义可选的 AI 控制器集成分工。本文是 controller 在 gbdev 中职责的需求事实源；`docs/controller-recipe.md` 和 `skills/gbdev-usage/SKILL.md` 的操作细节应与本文一致。

## 1. 总体分工

| 角色 | 定位 | 做什么 | 不做什么 |
|---|---|---|---|
| controller | 架构师与决策者 | 定方向、做决策、对用户沟通 | 不写代码、不碰文件、不指挥日常执行 |
| Codex（gpt-6-astra，high） | 高级工程师 | 解决复杂问题，做实现级计划（planner），修问题（fixer），解冲突（resolver） | 不对用户沟通 |
| Cursor（model auto） | 工程 worker | 读写文件、写代码（executor）、审查（reviewer）、验收（verifier），按需替 controller 取材 | 不做方向决策 |
| gbdev | 调度器 | 管理 Codex/Cursor 的日常执行：派任务、审查循环、合并门禁、回滚、重试、tmux 看板、webhook 通知 | 不做方向决策 |

## 2. controller 的职责（需求）

R1. **唯一决策者。** 所有决策最终由 controller 拍板。gbdev 产生的每个 attention 决策都由 controller 回答；涉及用户偏好或超出边界的事，由 controller 去问用户。合并进 master、推送远端必须有 用户在聊天里的明确同意。

R2. **只做方向级规划。** controller 定模块边界、任务目标、验收标准和约束（允许路径、禁止事项）。实现级的细节步骤由 Codex（planner）负责，controller 不写实现步骤。

R3. **只读。** controller 从不修改任何文件。需要看源码、diff 或测试输出时，通过 Cursor 按需取材，Cursor 只返回相关片段，不返回整个文件。
- 默认唤醒只依赖约 2KB 的 webhook 摘要：home ID、run ID、事件类型、决策类型、一行摘要、下一步命令。
- 只有 controller 判断摘要不足以做决定时，才做深读（gbdev 状态/决策记录，必要时经 Cursor 取代码片段）。
- 运行 gbdev 控制命令（status、run resume 等）属于决策动作，不算"碰文件"。

R4. **webhook 唤醒后按事件类型处理。** 简单情况走规则表，复杂情况由 controller 判断：

| 事件 | 处理 |
|---|---|
| plan_review / plan_invalid | 检查依赖、范围和验收标准是否符合方向；批准或要求重新规划。超过 8 个任务或约 40 个 job 时问用户。 |
| task_failed / lane_broken | 重试一次；第二次失败问用户。 |
| task_paused | 能从仓库事实回答的自己答（必要时经 Cursor 取证）；只有用户偏好类问题才问用户。 |
| 其他（合并冲突、门禁失败、预算、崩溃、最终审查） | 按 `skills/gbdev-usage/SKILL.md` §4 决策表；表外情况由 controller 判断。 |
| terminal（succeeded） | 取结果，向用户 汇报分支/SHA、检查结果和风险，询问是否合并；绝不自行 land。 |

R5. **不指挥日常执行。** Codex/Cursor 的日常调度（审查-修复循环、格式修复、回滚重试）是 gbdev 的职责。controller 只在越界时介入：决策点、失败、超预算、越出允许路径、安全问题。

R6. **角色固定。** controller 的角色写死在配置里，不随项目变化。Codex 和 Cursor 的角色可配置：内置 `roles/<name>/role.json`，用户覆盖 `dirname(config)/roles/<name>.json`，以及单次请求的 `step_overrides`。可选工作流配置示例（不是内置默认）：planner/fixer/resolver 用 Codex gpt-6-astra，executor/reviewer/verifier 用 Cursor auto。

## 3. 通信机制（现状）

- gbdev → controller 用 webhook：`src/notify/http.ts` 的 `postNotice`，HTTP POST 到该 bot 的 controller webhook routine URL。在 attention（需要决策）和 terminal（任务结束）事件时触发，另有 health 和 test 事件。
- payload 为 `gbdev.notify.v1` JSON，≤2KB，不含代码、worker 输出或决策详情（见 `src/notify/payload.ts`）。
- URL 和发送密钥存在 `~/.config/gbdev/notify/<home_id>.secret.json`，只由用户 用 `<launcher> notify setup` 粘贴；任何 bot 不得读取、打印或记录。
- 每个 bot 有自己的 GBDEV_HOME 和 webhook routine；轮询只作兜底。

## 4. 已知边界

- 缺失结构化 verdict 时，先重试审查，再用 `gbdev inspect` 按需取证；仅在证据充分时明确记录接受理由，不能把退出码 0 说成 reviewer-approved。
- `inspect` 针对已提交 SHA 返回有界证据；不是交互式 shell，也不能运行仓库脚本或测试。
- 模型分工、升级阈值、轮询时间窗是可配置的集成策略，不是个人账户的固定规则。
- 沙箱、网络策略、离线限制和落地批准见 README 与参考手册；控制器不应绕过这些边界。
