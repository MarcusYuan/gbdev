> Historical design specification. Milestone labels describe design evolution; consult README.md and docs/reference.md for current behavior. Private execution records are not release certification.

# gbdev M3 实现规格：并行 lane + 集成分支 + 合并后关口（给 Codex）

> M9 网络策略注记：M9 起 `network` 默认 `true`，可显式 `false`；下文禁网/仅 false 的描述保留为历史规格，不代表 M9 当前行为。inspect 固定联网查资料，但仍禁止 tests/scripts/installs/hooks；其余当前边界见 README 的网络策略说明。

> 版本：M3-spec v1 · 2026-10-26（PDT）
> 依赖：`SPEC-M1-final.md`、`SPEC-M2.md`（M2 已完成：master `2ad610b`，542 个测试全绿，真实冒烟 S1–S6 通过）。本文只写增量；凡本文未提及的行为一律沿用 M1/M2。
> 设计文档 Page：https://cursor.com/canvas/store-d81ff4fb-5a93-4888-8aaa-386adeaab254/ceae036d-2608-40ce-b831-f49ea7635263（第 13 节为本文摘要）
> OMC 参考版本：oh-my-claudecode `726fa45e081a65f8e971ef291dbf0d9cecf24897`（2026-10-26 06:52 PDT）。下文 `omc:` 前缀路径均相对该仓库根目录。
> 本文没有留给实现者的「可选项」。实现中如果发现本文与 M1/M2 代码事实冲突，按 M1 §0 的规则：做完能做的部分，在 `open_questions` 里报告，不要猜。

---

## 0. 实现边界（沿用 M1/M2 §0，增量如下）

- 分支：M3 各阶段在 `gbdev-m3`（从 master `2ad610b` 切出；切分支、合并、推送由 controller 在用户同意后做，Codex 不做）。
- 仍然零运行时依赖、Node 24、`node:test`、`tsc` 到 `dist/`、argv 数组调用子进程、不拼 shell 字符串（`check_cmd` 与 `worktree_setup_cmd` 除外，二者只来自 controller 写的请求，见 §5.1）。
- 所有 git 调用继续走 `core/git.ts` 的 `git()`（`-c core.hooksPath=/dev/null`、超时 SIGKILL）。M3 新增的 git 操作（merge-tree、merge、reset、update-ref）全部加进 `core/git.ts`，不在别处直接 spawn git。
- 测试一律用 fake provider；真实 `codex` / `cursor-agent` 冒烟由 controller 在用户 Mac 上执行（§18.3）。
- **硬规则（不变）**：
  - Cursor 只能用 `--model auto`；任何来源（角色、模板、run 请求、task graph、resume 输入）给 Cursor 指定非 auto 模型 ⇒ `cursor_model_not_allowed`，退出码 2，在创建任何文件/worktree 之前拒绝。
  - 源码中不得出现 `--dangerously-bypass-approvals-and-sandbox`、Cursor `--sandbox disabled`（测试 `test/safety-argv.test.ts` 扫描 `src/` 与 `dist/`）。
  - worker 只在自己的 worktree 里工作：不读仓库外、不联网（`network` 只能 false）、不安装依赖、不 push、不碰 `.git`。
  - **gbdev 永远不写 main/master，也永远不 push**。唯一能改目标分支的命令 `gbdev run land` 必须带 `--confirm-user-approved`，而 controller 只有在用户明确说「是」之后才能带这个参数（§13.3）。
  - `contract_version` 仍为 `"1"`；M1/M2 的 schema 只加可选字段，不改语义（§20）。

## 1. M3 范围

M3 = 在 M2「一条流水线一个共享 worktree」之上增加**有界并行**：

1. **run（并行运行）**：一个 run = 一张任务图（task graph）+ N 条执行 lane + 一条集成分支。新命令族 `gbdev run start|status|wait|result|resume|cancel|cleanup|land`。
2. **lane**：worktree 属于 lane，不属于 task。默认 2 条 lane，可配 1–4。每条 lane 一个长期 worktree，串行执行任务；每个任务就是一条 M2 流水线（`workspace.mode = "per_lane"`）。
3. **集成分支**：gbdev 只在任务边界、关口通过后，确定性地把任务合并进 run 专属的集成分支 `gbdev/<run_id>/integration`（永远不是 main/master）。merge-tree 预检 → 加锁串行 `--no-ff` 合并 → **合并后关口**（在集成 worktree 上跑检查）→ 失败则回滚该合并并把任务退回修复。
4. **冲突**：自动派一个 Codex 冲突解决 job（在专用集成 worktree 里），失败或超限 ⇒ `needs_decision` 交 controller。
5. **任务分解**：planner 产出 `gbdev.task-graph.v1`（`depends_on` + `file_scope`），controller 在 `plan_review` 关口批准或修改。
6. **无常驻 leader**：gbdev 的 run supervisor 只做机械推进；controller 被事件或 routine（约每 10 分钟）唤醒，在暂停点做决定。
7. **补 OMC 的三个缺口**：合并后测试关口、清理前检查未合并提交、集成 worktree 必定清理。
8. **交付**：run 成功 = 集成分支就绪且全绿；合入目标分支只能由 `gbdev run land --confirm-user-approved` 完成（fast-forward，见 §13.2），push 仍由 controller 在用户同意后手动做。

### 1.1 明确不做（留给 M4+）

- 跨 run 并行（同一时刻仍最多 1 个顶层执行单元，§8.4）；跨机器 / 云端 lane（只留接口，§16）。
- worker 运行中 rebase 或在运行中把别人的改动推给它（OMC 的 auto-rebase fan-out）。M3 只在任务之间刷新 lane。
- 自动 push、自动开 PR、合并到远端。
- tmux 交互 worker、`codex exec resume` / `cursor-agent --resume` 续聊、MCP、YAML（同 M2）。
- 基于测试名的「只看新增失败」关口（基线不绿 ⇒ run 直接失败，§9.6）。

## 2. 关键设计决策（每条附理由；均已定，不再讨论）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 新增顶层对象 **run**（id `r_YYYYMMDD_HHMM_xxxx`），命令族 `gbdev run …`；每个任务的执行仍是一条 M2 pipeline（`p_…`，带 `run_id`/`task_id`） | 复用 M2 已真实冒烟过的关口、修复回路、handoff、resume；M3 只加调度与集成层，不重写流水线 |
| D2 | **worktree 属于 lane**：`~/.gbdev/worktrees/<repo>/<run_id>/lane-<n>`；lane 串行执行任务；每个任务在 lane worktree 里有自己的任务分支 `gbdev/<run_id>/t/<task_id>`，lane 当前分支 = 当前任务分支 | lane worktree 长期复用（构建缓存、`worktree_setup_cmd` 只跑一次）；任务分支让「合并源」「未合并证据」「暂停任务让出 lane」都变得精确且便宜（`git switch` 即可） |
| D3 | lane 刷新**只发生在任务开始前**：新任务分支从集成分支的 `verified_sha` 创建；运行中的 worker 永远不被 rebase | 任务结束即已合并，lane 上没有未合并工作，所以「刷新」就是从最新已验证的集成提交切新分支，不存在 rebase 冲突；避免 OMC 运行中 rebase 导致 worker 半途看到代码变化 |
| D4 | 合并只在**任务边界**、且任务流水线已 `succeeded`（检查通过 + 审查 approve 或 controller accept）之后；目标永远是 run 专属集成分支 | 用户批准的方向；集成分支是 gbdev 私有分支，可以确定性地 reset 回滚 |
| D5 | 合并流程：`merge-tree --write-tree` 预检 → 持 run 级 `integration.lock` 串行 → 在集成 worktree `git merge --no-ff <task_head_sha>`（按 sha 合并，冻结来源） | 预检不碰工作区；串行保证每次合并都基于上一次已验证的集成提交；按 sha 防止合并期间任务分支被移动 |
| D6 | **合并后关口**：每次合并后在集成 worktree 跑「run 级集成检查 ∪ 本任务 AC 检查 ∪ 已集成任务 AC 检查」；失败 ⇒ `git reset --hard <pre_merge_sha>` 回滚，任务退回修复（`integration-fix` 流水线，最多 `max_integration_fixes` 次，默认 1，上限 3），超出 ⇒ needs_decision | 修 OMC 缺口 1（OMC 合并成功即推进，不跑测试）；集成分支私有，用 reset 而不是 revert，历史干净且「verified_sha 之后不存在未验证提交」成为不变式 |
| D7 | 冲突：自动派 **resolver** job（新内置角色，Codex，workspace-write）在集成 worktree 的冲突现场解决；gbdev 校验无冲突标记后由 gbdev 提交合并；之后照常跑合并后关口，再加一次只读 verifier 核对两边意图。每次合并最多 2 次 resolver 尝试、冲突文件 ≤ 20 个，超限或失败 ⇒ needs_decision `merge_conflict_unresolved` | 用户批准的方向；Codex 在 sandbox 里不能写 `.git`，所以 `git add`/`commit` 仍由 gbdev 做（与 M1 snapshot 同一原则）；verifier 防止「编译通过但丢了一边逻辑」 |
| D8 | **无常驻 leader**：run supervisor 是 gbdev 的确定性后台进程；判断一律变成 `attention[]` 里的决策项，controller 用 `run wait --until attention` 或 routine（约 10 分钟）唤醒后 `run resume` | 与 M2 一致：controller 是唯一的大脑和唯一和用户说话的一方；决策项带 `decision_id`，过期回答被拒绝 |
| D9 | 决策**按任务暂停，不按 run 暂停**：一个任务等决定时，其他 lane 继续；run 只有在「没有运行中的任务、没有可调度任务、且有待决策项」时才进入 `needs_decision` | 等用户回答可能要几小时，不应让整个 run 停下 |
| D10 | 暂停的任务**让出 lane**（任务分支保留，lane 切走）；恢复时由任意空闲 lane `git switch` 回该任务分支 | 与 M2「暂停不占槽」一致；任务分支让 park/unpark 无损 |
| D11 | 任务图由 planner（只读）产出 `gbdev.task-graph.v1`，**必须**经 controller `approve_plan`（可附修改后的图）才执行；controller 直接给 `tasks` 时跳过 planner 和该关口 | 分解质量决定冲突率；最后一道判断交给 controller；controller 自己写的图无需再审 |
| D12 | task graph 里的检查只能引用 run 请求里 `checks[]` 的 id，**不能写命令** | `check_cmd` 在 Mac 上不受 sandbox 约束执行；LLM 产出的图不能引入新命令 |
| D13 | 调度：依赖就绪队列（依赖全部 `integrated` 才就绪）→ 按关键路径长度、再按声明顺序排序 → 分配给空闲 lane（优先上一个依赖任务所在 lane，其次编号最小）；`file_scope` 重叠的任务默认不并行 | 依赖任务必须看到前置代码；关键路径优先缩短总时长；重叠串行是降低冲突率最便宜的手段 |
| D14 | `file_scope` 是**软约束**：越界只记 `scope_exceeded` 警告；硬边界仍是 run 的 `allowed_paths` | planner 低估范围很常见；硬限制会把正常任务判失败 |
| D15 | 并发：顶层仍互斥（run / pipeline / standalone job 同时只有一个活动）；run 内并发受 `parallel.max_workers`（默认 3，上限 4）和每 provider 上限（codex 3、cursor 2）约束；provider 报限流 ⇒ 冷却 10 分钟 | 一台 Mac 的 CPU、Codex/Cursor 账号配额都有限；顶层互斥保证 M1/M2 行为和测试不变 |
| D16 | run 级预算：`max_tasks` ≤ 16（默认 12）、`max_total_jobs` ≤ 120（默认 60）、`timeout_min` ≤ 1440（默认 720）；用完 ⇒ needs_decision `run_budget_exhausted`（可 `extend_budget` 一次，或 cancel） | 保证能停下来 |
| D17 | 收尾：全部任务 `integrated`/`dropped` 后跑 **final review**（默认 reviewer/cursor 只读，看 `base..integration` 全量 diff 对照 run 的验收标准）；approve ⇒ `succeeded`；revise/reject ⇒ needs_decision（`add_fix_task` 或 `accept_final`） | 单任务审查看不到跨任务的整体问题 |
| D18 | 合入目标分支：`run land --target <branch> --confirm-user-approved`，只做 **fast-forward**（先在集成 worktree 把最新目标分支合进来并重跑关口），不 push | 「是否进 master」是用户的决定；ff 保证 master 上出现的就是验证过的那个提交 |
| D19 | 清理：任务分支仅当 tip 已被集成分支（或目标分支）包含才删；集成分支仅当已被目标分支包含才删；所有 worktree（含集成 worktree）在干净时删除，脏的保留不强删 | 修 OMC 缺口 2、3 |
| D20 | supervisor 崩溃**不直接判 run 失败**：恢复程序确定性地把集成 worktree 复位到 `verified_sha`，运行中的任务流水线判 failed，run → needs_decision `supervisor_crashed`，controller 可 `resume_run` | run 可能跑好几个小时；已集成的成果是验证过的，不应因为进程崩溃丢掉 |

## 3. 目录、文件与配置

```
~/.gbdev/
  runs/<run_id>/
    run.json                 # gbdev.run.v1，唯一真相源（原子写：tmp + rename）
    request.json             # 原始 run-request（规范化后）
    roles.snapshot.json      # 本 run 用到的全部角色快照（同 M2 §5.4，含 resolver、planner）
    task-graph.json          # 已批准的任务图（gbdev.task-graph.v1）；planning 阶段的草稿在 plans/
    plans/plan-<n>.json      # 每次 planner 产出的草稿与校验结果
    merges/<seq>.json        # gbdev.merge-record.v1，每次合并尝试一个
    merges/<seq>.gate/<check_id>.log
    decisions.jsonl          # 每个决策项的创建与解决（append-only）
    inputs/<decision_id>.json# run resume 写入、supervisor 消费
    events.jsonl             # gbdev.event.v1（带 run_id）
    supervisor.log
    integration.lock         # run 级集成锁（O_EXCL，内容为 pid + 用途）
    cancel.json
    result.json              # gbdev.run-result.v1（稳定后写）
    diff.patch               # base_sha..integration verified_sha
  pipelines/<pipeline_id>/   # 每个任务尝试一条 M2 pipeline，run_id/task_id 写在 run 里
  jobs/<job_id>/             # 不变；resolver/verifier/planner job 也在这里，带 run_id
  worktrees/<repo>/<run_id>/
    lane-1/ lane-2/ …        # lane worktree（长期）
    integration/             # 集成 worktree（检出 gbdev/<run_id>/integration）
```

分支命名（均通过 M1 `validateBranchName`）：
- 集成分支：`gbdev/<run_id>/integration`
- 任务分支：`gbdev/<run_id>/t/<task_id>`；同一任务被 `rebuild_task` 重建时用 `gbdev/<run_id>/t/<task_id>-r<k>`（k 从 2 起），旧分支保留为证据。
- 不存在名为 `gbdev/<run_id>` 的分支（否则与上面的层级冲突）。

### 3.1 config.json 新增可选字段（version 仍为 1）

```json
{
  "parallel": { "max_workers": 3, "provider_limits": { "codex": 3, "cursor": 2 }, "rate_limit_cooldown_s": 600 },
  "run_defaults": {
    "lanes": 2, "max_tasks": 12, "max_total_jobs": 60, "timeout_min": 720,
    "max_integration_fixes": 1, "max_resolver_attempts": 2, "max_conflict_files": 20,
    "gate_timeout_min": 30, "final_review": "reviewer", "overlap_policy": "serialize",
    "default_task_pipeline": "implement-review"
  }
}
```

- 校验（未知键拒绝，`config_invalid`，与 M2 `pipeline_defaults` 同规则）：`max_workers` 1–4；`rate_limit_cooldown_s` 0–3600 整数秒（默认 600，0 不延迟）；`provider_limits.*` 1–4 且 ≤ `max_workers`；`lanes` 1–4；`max_tasks` 1–16；`max_total_jobs` 1–120；`timeout_min` 60–1440；`max_integration_fixes` 0–3；`max_resolver_attempts` 0–2；`max_conflict_files` 1–50；`gate_timeout_min` 5–120；`final_review ∈ {reviewer, verifier, none}`；`overlap_policy ∈ {serialize, allow}`；`default_task_pipeline` 必须是存在的模板且含 change 步骤。
- 顶层 `concurrency` 字段**保留且仍必须为 1**（它的含义改述为「顶层执行单元数」，§8.4），M1 的校验与错误信息不变。
- 缺省 `parallel`/`run_defaults` 时取上面的默认值；M1/M2 命令完全不读这两个字段。

## 4. 概念模型

```
run r_…  ──────────────────────────────────────────────────────────────
  task graph:  A ─┐
               B ─┼─→ D        C（独立）
                  │
  lane-1:  [A: p_…1 implement→review]──merge──[D: p_…4 …]──merge
  lane-2:  [B: p_…2 …]──merge──[C: p_…3 …]──merge
  integration (gbdev/r_…/integration):
      base ─ M(A) ─ M(B) ─ M(C) ─ M(D)     每个 M 之后跑关口；verified_sha 只在关口通过后前移
  final review → succeeded → （用户同意）run land --confirm-user-approved → master ff
```

- **task**：任务图里的一个节点。每次执行尝试是一条 M2 pipeline（`attempts[]` 记录 pipeline_id）。
- **lane**：一个 worktree + 当前检出的任务分支。lane 状态：`preparing | idle | busy | broken`（见 §7.3）。
- **integration**：集成 worktree + 集成分支；`verified_sha` = 最近一次关口通过的集成提交（初始 = base_sha，基线关口通过后）。
- **merge record**：一次把某任务头合入集成分支的尝试（含预检、冲突解决、关口、回滚）。
- **decision**：需要 controller 判断的事项，带 `decision_id`、范围（run / task / merge）、允许动作。

## 5. 请求与任务图

### 5.1 gbdev.run-request.v1（controller → gbdev，`run start --request <file|->`）

```json
{
  "schema": "gbdev.run-request.v1",
  "request_id": "rr_20261027_0910_a1",
  "repo": "/path/to/gbdev-smoke",
  "base_ref": "master",
  "goal": "给 smoke 服务加 /health、/version 两个接口，并把 sum 工具函数拆到 lib/",
  "context": "入口 src/server.ts；测试用 node:test",
  "constraints": ["不加新依赖"],
  "allowed_paths": ["src/**", "test/**", "lib/**"],
  "checks": [
    { "id": "test",  "cmd": "npm test",       "timeout_min": 10 },
    { "id": "build", "cmd": "npm run build",  "timeout_min": 10 }
  ],
  "integration_checks": ["build", "test"],
  "acceptance_criteria": [
    { "id": "RAC1", "text": "全部接口都有测试", "check": "test" }
  ],
  "decompose": "planner",
  "tasks": null,
  "lanes": 2,
  "overlap_policy": "serialize",
  "default_task_pipeline": "implement-review",
  "task_pipeline_overrides": { "review": { "provider": "cursor" } },
  "final_review": "reviewer",
  "worktree_setup_cmd": null,
  "max_tasks": 12,
  "max_total_jobs": 60,
  "max_integration_fixes": 1,
  "timeout_min": 720,
  "network": false
}
```

规则：
- `repo` 白名单、`network` 只能 false、`allowed_paths` 非空：同 M1 brief。
- `checks`：1–10 项；`id` 匹配 `^[a-z][a-z0-9-]{0,23}$` 且唯一；`cmd` 非空、≤ 500 字符；`timeout_min` 1–60（缺省 10）。这是本 run **唯一**的命令来源。
- `integration_checks`：非空，元素必须是 `checks[].id`。它们构成基线关口与每次合并后关口的固定部分。
- `acceptance_criteria`：run 级；`check` 可为 null 或 `checks[].id`（**不接受 `check_cmd`**，给了 ⇒ `run_invalid`，details 指出改用 `check`）。
- `decompose ∈ {planner, provided}`：`planner` 时 `tasks` 必须为 null；`provided` 时 `tasks` 必须是合法的 task 数组（同 §5.2 的 `tasks`），直接作为已批准图。
- `lanes`：1–4，缺省 `run_defaults.lanes`；实际并行还受 §8.4 槽位限制。
- `default_task_pipeline`：任务未指定 `pipeline` 时使用；`task_pipeline_overrides` 语义同 M2 `step_overrides`（键为 step id 或 `"fix"`，对每个任务流水线生效），同样禁止覆盖 sandbox/role/output，Cursor 只能 auto。
- `final_review ∈ {reviewer, verifier, none}`。
- `worktree_setup_cmd`：null 或 ≤ 500 字符字符串，由 gbdev 在每个新建 worktree（lane、集成）里以 `/bin/sh -c` 执行一次（超时 15 分钟，日志在 `runs/<id>/setup-<lane>.log`），失败 ⇒ run failed `worktree_setup_failed`。它与 `check_cmd` 同等信任级别（controller 写、用户可见）；worker 仍然不能安装任何东西。
- 预算字段范围见 §3.1。
- 任何字段非法 ⇒ `run_invalid`（退出码 2），此时不创建任何文件/worktree。

### 5.2 gbdev.task-graph.v1（planner 产出 / controller 提供或修改）

```json
{
  "schema": "gbdev.task-graph.v1",
  "summary": "拆成 3 个任务；health 与 version 可并行，lib 拆分最后做",
  "tasks": [
    {
      "id": "health",
      "title": "新增 /health 接口",
      "goal": "GET /health 返回 {ok:true}",
      "context": "在 src/server.ts 注册路由；测试放 test/health.test.ts",
      "depends_on": [],
      "file_scope": ["src/routes/health.ts", "test/health.test.ts", "src/server.ts"],
      "acceptance_criteria": [ { "id": "AC1", "text": "有测试且通过", "check": "test" } ],
      "pipeline": "implement-review",
      "size": "S",
      "notes": null
    },
    {
      "id": "version",
      "title": "新增 /version 接口",
      "goal": "GET /version 返回 package.json 的 version",
      "context": "",
      "depends_on": [],
      "file_scope": ["src/routes/version.ts", "test/version.test.ts", "src/server.ts"],
      "acceptance_criteria": [ { "id": "AC1", "text": "有测试且通过", "check": "test" } ],
      "pipeline": "implement-verify",
      "size": "S",
      "notes": "与 health 都改 src/server.ts 的路由表"
    },
    {
      "id": "lib-sum",
      "title": "把 sum 拆到 lib/",
      "goal": "sum 移到 lib/sum.ts，原导出保持兼容",
      "context": "",
      "depends_on": ["health", "version"],
      "file_scope": ["lib/**", "src/util.ts", "test/sum.test.ts"],
      "acceptance_criteria": [ { "id": "AC1", "text": "原有 sum 测试不改也能过", "check": "test" } ],
      "pipeline": null,
      "size": "M",
      "notes": null
    }
  ]
}
```

校验（`src/run/taskGraph.ts`，纯函数；任何一条失败 ⇒ 图非法，错误逐条列出）：
1. `tasks` 1..`max_tasks` 个；`id` 匹配 `^[a-z][a-z0-9-]{0,23}$`、唯一；`title` ≤ 120 字符；`goal` 非空 ≤ 2000；`context` ≤ 4000；`notes` ≤ 1000 或 null。
2. `depends_on` 中的 id 必须存在、不得自依赖；整图无环（Kahn 拓扑排序，有环时报出环上的 id）。
3. `file_scope`：1–30 个 glob，每个都必须被 run 的 `allowed_paths` 覆盖（用 M1 `core/glob.ts` 的匹配；判断方式：glob 的静态前缀必须匹配某个 allowed_paths 模式，见 §8.3）；不能为空——不知道就写 run 的 allowed_paths（这会让该任务与所有任务串行）。
4. `acceptance_criteria` 1–10 个；`check` 为 null 或 run `checks[].id`；出现 `check_cmd`/`cmd` 字段 ⇒ 非法。
5. `pipeline`：null（用 run 的 `default_task_pipeline`）或模板名；模板必须含至少一个 change 步骤（`review-only` 不允许）。不接受内联模板。
6. `size ∈ {S, M, L}`，只用于报告和 controller 判断，不影响调度。
7. 未知字段拒绝（与所有 gbdev schema 一致）。

### 5.3 planner 的产出方式

- planning 阶段 gbdev 创建一个 **standalone 形态但归属 run 的** job：角色 `planner`（M2 内置，read-only，provider 按快照），cwd = 集成 worktree（此时等于 base_sha，干净），brief 的 goal/context/constraints/allowed_paths 来自 run 请求，并附上 `checks[]` 的 id 与文本（不含命令行以外信息）。
- worker-result schema 选项新增 `taskGraph: true`：在 M2 的 report 输出基础上增加必填字段 `task_graph`（结构同 §5.2，按 Codex `--output-schema` 的严格规则全部 required、`additionalProperties:false`，可空字段用 `["string","null"]`）。Cursor planner 无 schema 强制时同样从最终消息里解析 JSON（M2 已有逻辑）。
- 产出后 gbdev 校验：合法 ⇒ 写 `plans/plan-<n>.json`，run → `plan_review`（决策项 `plan_review`）；非法 ⇒ 自动重试 1 次（prompt 附上错误列表，数据围栏），仍非法 ⇒ 决策项 `plan_invalid`（允许 `replan`、`approve_plan` 且必须附 controller 写的 `task_graph`）。
- planner job 的 worktree 必须保持干净（只读）；被改动 ⇒ run failed `planner_modified_worktree`（同 M2 G5 原则，不回滚，保留证据）。

## 6. 运行时契约

### 6.1 gbdev.run.v1（`run start/status/wait/resume/cancel` 的 result）

```json
{
  "schema": "gbdev.run.v1",
  "run_id": "r_20261027_0911_5be0",
  "state": "running",
  "state_reason": null,
  "outcome": null,
  "failure_reason": null,
  "repo": "/path/to/gbdev-smoke",
  "base_ref": "master",
  "base_sha": "433334e…",
  "executor_host": "local",
  "lanes": [
    { "lane": "lane-1", "host": "local", "state": "busy", "worktree": "/Users/alice/.gbdev/worktrees/gbdev-smoke/r_20261027_0911_5be0/lane-1",
      "task_id": "health", "branch": "gbdev/r_20261027_0911_5be0/t/health", "pipeline_id": "p_20261027_0915_11aa", "tasks_done": 0 },
    { "lane": "lane-2", "host": "local", "state": "idle", "worktree": "…/lane-2", "task_id": null, "branch": null, "pipeline_id": null, "tasks_done": 1 }
  ],
  "integration": {
    "branch": "gbdev/r_20261027_0911_5be0/integration",
    "worktree": "/Users/alice/.gbdev/worktrees/gbdev-smoke/r_20261027_0911_5be0/integration",
    "verified_sha": "8a1f0c2…",
    "head_sha": "8a1f0c2…",
    "merging": null,
    "merges": 1,
    "rollbacks": 0,
    "target_branch": null,
    "landed_sha": null,
    "approved_by_user_at": null
  },
  "tasks": [
    { "task_id": "version", "state": "integrated", "lane": null, "branch": "gbdev/r_20261027_0911_5be0/t/version",
      "depends_on": [], "attempts": [ { "pipeline_id": "p_20261027_0914_77c1", "kind": "initial", "state": "succeeded", "outcome": "approved" } ],
      "head_sha": "c41d…", "base_sha": "433334e…", "merge_seq": [1], "merged_sha": "8a1f0c2…",
      "integration_fixes": 0, "scope_exceeded": [], "decision_id": null },
    { "task_id": "health", "state": "running", "lane": "lane-1", "branch": "gbdev/r_20261027_0911_5be0/t/health",
      "depends_on": [], "attempts": [ { "pipeline_id": "p_20261027_0915_11aa", "kind": "initial", "state": "running", "outcome": null } ],
      "head_sha": null, "base_sha": "433334e…", "merge_seq": [], "merged_sha": null,
      "integration_fixes": 0, "scope_exceeded": [], "decision_id": null },
    { "task_id": "lib-sum", "state": "pending", "lane": null, "branch": null, "depends_on": ["health","version"],
      "attempts": [], "head_sha": null, "base_sha": null, "merge_seq": [], "merged_sha": null,
      "integration_fixes": 0, "scope_exceeded": [], "decision_id": null }
  ],
  "progress": { "total": 3, "pending": 1, "ready": 0, "running": 1, "paused": 0, "merge_queued": 0, "merging": 0, "integrated": 1, "needs_decision": 0, "dropped": 0, "failed": 0 },
  "merge_queue": [],
  "attention": [],
  "slots": { "max_workers": 3, "in_use": 1, "by_provider": { "codex": 1, "cursor": 0 }, "cooldown_until": {} },
  "budget": { "jobs_used": 3, "max_total_jobs": 60, "max_tasks": 12, "extended": false },
  "plan": { "source": "planner", "approved_at": "2026-10-27T09:14:02-07:00", "approved_by": "grok-bot", "plan_attempts": 1 },
  "supervisor_pid": 61220,
  "heartbeat_at": "2026-10-27T09:20:31-07:00",
  "created_at": "2026-10-27T09:11:04-07:00",
  "updated_at": "2026-10-27T09:20:31-07:00",
  "deadline_at": "2026-10-27T21:11:04-07:00",
  "state_history": [
    { "state": "queued", "at": "2026-10-27T09:11:04-07:00", "by": "gbdev", "reason": null },
    { "state": "starting", "at": "2026-10-27T09:11:04-07:00", "by": "gbdev", "reason": null },
    { "state": "planning", "at": "2026-10-27T09:11:40-07:00", "by": "gbdev", "reason": null },
    { "state": "plan_review", "at": "2026-10-27T09:13:10-07:00", "by": "gbdev", "reason": "plan_ready" },
    { "state": "running", "at": "2026-10-27T09:14:02-07:00", "by": "grok-bot", "reason": "approve_plan" }
  ],
  "warnings": []
}
```

字段说明：
- `attention[]`：未解决的决策项（§10.1）。**run 为 `running` 时也可能非空**（D9）。
- `integration.merging`：合并进行中时为 `{ "seq": 2, "task_id": "health", "phase": "precheck|merging|resolving|gating|verifying|rolling_back", "started_at": "…" }`，否则 null。
- `integration.head_sha` 与 `verified_sha` 只在 `merging` 非空时可能不同；稳定状态下二者必须相等（不变式 I1，§12.3）。
- `tasks[].attempts[].kind ∈ {initial, retry, integration_fix, rebuild, final_fix}`。
- `executor_host` 与 `lanes[].host`：M3 恒为 `"local"`（§16）。
- `outcome`（仅 succeeded）：`integrated`（全部任务 integrated 且 final review approve 或 `final_review = none`）/ `integrated_partial`（有 dropped 任务）/ `accepted_by_decider`（controller `accept_final`）。

### 6.2 gbdev.merge-record.v1（`runs/<id>/merges/<seq>.json`）

```json
{
  "schema": "gbdev.merge-record.v1",
  "run_id": "r_20261027_0911_5be0",
  "seq": 2,
  "task_id": "health",
  "task_head_sha": "f00d…",
  "pre_merge_sha": "8a1f0c2…",
  "precheck": { "clean": false, "conflict_files": ["src/server.ts"], "tree": null },
  "resolution": { "attempts": [ { "job_id": "j_20261027_0950_ab12", "state": "succeeded", "markers_left": [], "touched_non_conflict": [] } ], "verifier_job_id": "j_20261027_0958_cd34", "verifier_verdict": "approve" },
  "merge_sha": "9b77…",
  "gate": { "checks": [ { "id": "build", "exit_code": 0, "duration_s": 12 }, { "id": "test", "exit_code": 0, "duration_s": 41 } ], "passed": true, "log_dir": "merges/2.gate" },
  "result": "integrated",
  "rolled_back_to": null,
  "started_at": "…",
  "finished_at": "…"
}
```
- `result ∈ {integrated, rolled_back_gate_failed, aborted_conflict_unresolved, aborted_verifier_rejected, aborted_cancelled, aborted_crash}`。
- 合并记录只追加，不改写已结束的记录。

### 6.3 gbdev.run-result.v1（`run result`，以及 `run wait --with-result` 稳定时）

```json
{
  "schema": "gbdev.run-result.v1",
  "run_id": "r_…",
  "state": "succeeded",
  "outcome": "integrated",
  "repo": "…",
  "base_sha": "433334e…",
  "integration_branch": "gbdev/r_…/integration",
  "integration_sha": "e1e1…",
  "diff_stat": { "files": 9, "insertions": 210, "deletions": 34 },
  "commits": [ { "sha": "e1e1…", "subject": "gbdev: merge lib-sum (r_…)" } ],
  "tasks": [ { "task_id": "health", "state": "integrated", "merged_sha": "9b77…", "pipelines": ["p_…"], "review": { "verdict": "approve", "unresolved_findings": [] }, "scope_exceeded": [], "summary": "…" } ],
  "dropped_tasks": [],
  "merges": [ { "seq": 1, "task_id": "version", "result": "integrated", "conflict": false, "gate_passed": true } ],
  "final_gate": { "sha": "e1e1…", "passed": true },
  "final_review": { "job_id": "j_…", "verdict": "approve", "findings": [] },
  "acceptance_criteria": [ { "id": "RAC1", "check": "test", "passed": true } ],
  "decisions": [ { "decision_id": "d1", "reason": "plan_review", "action": "approve_plan", "by": "grok-bot", "at": "…" } ],
  "landing": { "eligible": true, "target_hint": "master", "landed_sha": null },
  "artifacts": { "diff": "~/.gbdev/runs/r_…/diff.patch", "events": "…/events.jsonl", "merges_dir": "…/merges" },
  "warnings": []
}
```
- `run result` 对活动 run ⇒ `run_not_settled`（retryable）。暂停态（`plan_review`、`needs_decision`）可以取到部分结果（`state` 如实反映）。
- worker 自报的文本（summary、findings）一律原样放在字段里；controller 转述给用户时视为不可信数据（M2 同规则）。

### 6.4 gbdev.pipeline-run.v1 的增量（向后兼容）

- `workspace.mode ∈ {"shared_run_worktree", "per_lane"}`。`per_lane` 时 `workspace` 增加 `run_id`、`task_id`、`lane`；`worktree` 为当前 lane 的路径（任务暂停后在别的 lane 恢复时由 run supervisor 在锁内改写，并在 pipeline `state_history` 记一条 `reason: "lane_moved:<from>-><to>"`，state 不变）。
- `integration`：standalone pipeline 仍为 null；`per_lane` 时为 `{ "run_id", "task_id", "integration_branch", "merge_state": "pending|merged|rolled_back|dropped", "merged_sha": null, "target_branch": null, "approved_by_user_at": null }`（字段集合是 M2 §12 预留集合的超集）。
- `validatePipelineRun` 放宽：接受上述两种 mode 与两种 integration 形状；其余校验不变。
- `per_lane` pipeline 的 `pipeline cancel/resume/cleanup` 直接调用 ⇒ `pipeline_owned_by_run`（退出码 1），`pipeline status/result/wait` 仍可用（只读）。

### 6.5 gbdev.pipeline-request.v1 的增量

- 新增可选 `seed_findings`：`null` 或 `{ "source": "integration_gate|final_review|conflict", "findings": [ {"id","severity","file","line","text"} ], "logs": [ {"check_id","tail"} ] }`（`tail` ≤ 80 行，同 M2 `fixInput`）。只有当流水线第一个步骤是 `fix` 角色时允许非 null；渲染为 prompt 里的「待修复问题」数据围栏。standalone `pipeline start` 也可使用（向后兼容：缺省 null）。
- 新增可选 `run_binding`：仅 run supervisor 内部生成（`pipeline start` 命令行给了 ⇒ `pipeline_invalid`）：`{ "run_id", "task_id", "lane", "worktree", "branch" }`；有它时 pipeline 不创建自己的 worktree，直接用该 lane worktree 并断言当前检出分支 = `branch`。

### 6.6 gbdev.worker-result.v1 的增量

- schema 选项 `taskGraph`（仅 planner run 用）：增加必填 `task_graph`。
- schema 选项 `mergeResolution`（仅 resolver 用）：增加必填 `resolution`：`{ "files": [ { "path", "strategy": "both|ours|theirs|rewrite", "note" } ], "unresolved": ["path"] }`。`unresolved` 非空 ⇒ 该次尝试失败。
- M1/M2 单 job 与 pipeline step 在不带这两个选项时生成的 schema 必须与 M2 **逐字节一致**（测试断言）。

### 6.7 新内置角色与模板

| 角色 | output | sandbox | 默认 provider | allowed | timeout_min | 说明 |
|---|---|---|---|---|---|---|
| `resolver` | change | workspace-write | codex | codex, fake | 30 | 只解决冲突；指令要求保留双方意图、不得顺手改别的、不得运行安装命令 |

- `resolver` 不允许 cursor：冲突现场需要可预期的 `--output-schema` 结构化输出；Cursor 的 `--force` 写模式在冲突解决上没有冒烟数据。
- 新内置模板 `integration-fix`：`fix(fixer) → review(reviewer)`，`fix_loop: { after: "review", max_rounds: 1 }`。只供 run 内部使用（`pipeline templates` 列出时 `internal: true`）。
- 新内置模板 `final-fix`：同 `integration-fix`，用于 `add_fix_task`。

### 6.8 事件（events.jsonl，gbdev.event.v1，新增可选字段 `run_id`、`task_id`、`lane`）

新增 type：`run_state_change`、`plan_ready`、`plan_invalid`、`task_state_change`、`lane_assigned`、`lane_released`、`lane_setup`、`merge_queued`、`merge_precheck`（data: clean、conflict_files）、`merge_committed`、`gate_started`、`gate_finished`（data: passed、failed_checks）、`merge_rolled_back`、`resolver_started`、`resolver_finished`、`verifier_started`、`verifier_finished`、`decision_required`、`decision_resolved`、`provider_cooldown`、`budget_warning`（用到 80%）、`landed`。
任务流水线自己的 events 仍写在 `pipelines/<id>/events.jsonl`，run 事件流只记引用（pipeline_id）。

## 7. 状态机

### 7.1 run 状态

```
queued → starting → planning → plan_review ─approve_plan→ running ⇄ needs_decision
                 └───────(decompose=provided)───────────→ running
running → finalizing → succeeded
finalizing → needs_decision（final review revise/reject）→ running（add_fix_task）| succeeded（accept_final）
任意非终态 → cancelled（run cancel）
任意非终态 → failed（run_timeout、baseline_checks_failed、worktree_setup_failed、planner_modified_worktree、integration_corrupt、internal_error）
plan_review → planning（replan）
```

- 活动态（占顶层槽位）：`queued | starting | planning | running | finalizing`。暂停态：`plan_review | needs_decision`。终态：`succeeded | failed | cancelled`。
- `ALLOWED_RUN_TRANSITIONS`（新表，独立于 pipeline 的表）：

| from | to |
|---|---|
| queued | starting, cancelled, failed |
| starting | planning, running, cancelled, failed |
| planning | plan_review, needs_decision, cancelled, failed |
| plan_review | planning, running, cancelled |
| running | needs_decision, finalizing, cancelled, failed |
| needs_decision | running, planning, finalizing, succeeded, cancelled, failed |
| finalizing | succeeded, needs_decision, running, cancelled, failed |

- `starting` 内做：建集成 worktree（从 base_sha，`git worktree add -b <integration_branch>`）→ `worktree_setup_cmd` → **基线关口**（§9.6）→ 建 lane worktree（detached 在 base_sha，`git worktree add --detach`）→ 各自 setup。任何一步失败 ⇒ failed，已建的 worktree 保留到 cleanup。
- run 进入 `needs_decision` 的条件（每次调度循环末尾判断）：没有 `running`/`merging` 任务、merge_queue 为空、没有可调度任务、且 `attention` 非空。否则保持 `running`。
- `running → finalizing`：所有任务处于 `integrated | dropped` 且 merge_queue 空、无合并进行中。

### 7.2 task 状态

```
pending → ready → running → merge_queued → merging → integrated
            ↑        │  ↘ paused（流水线 needs_input/blocked/needs_decision，让出 lane）
            │        │        └─resume→ running（任意空闲 lane）
            │        ↘ needs_decision（流水线 failed、冲突未解决、关口失败超限）
            │                 ├─retry_task / rebuild_task / extra_fix → ready 或 running
            │                 └─drop_task → dropped
            └── merging 失败（关口失败且仍有 integration_fix 次数）→ running（integration-fix 流水线）
任意非终态 → cancelled（run cancel）
```

| 状态 | 含义 | 占 lane | 占槽位 |
|---|---|---|---|
| pending | 依赖未全部 integrated | 否 | 否 |
| ready | 可调度，等 lane / 槽位 / 不重叠 | 否 | 否 |
| running | 有活动的任务流水线 | 是 | 流水线当前 step job 计 1 |
| paused | 流水线暂停（needs_input / blocked / pipeline needs_decision） | 否（已 park） | 否 |
| merge_queued | 流水线 succeeded，等集成锁 | 否（lane 已释放） | 否 |
| merging | 正在预检/合并/解决冲突/关口 | 否 | resolver/verifier job 计 1 |
| integrated | 关口通过，`verified_sha` 已前移 | 否 | 否 |
| needs_decision | 等 controller | 否 | 否 |
| dropped / cancelled / failed | 终态 | 否 | 否 |

- `paused` 与 `needs_decision` 都在 `attention[]` 产生决策项；区别是 paused 的决策由**任务流水线**的 resume 动作解决（answer/retry/extra_round/accept，透传给 M2 逻辑），needs_decision 的决策由 run 级动作解决。
- 依赖了 `dropped` 任务的任务：在 drop 时一并 dropped（`state_reason: "dependency_dropped:<id>"`），这一点在 `drop_task` 的返回里列出，controller 必须转告用户。
- `failed` 只在 run 被判 failed 时用于收尾标记；正常流程中任务失败都走 `needs_decision`。

### 7.3 lane 状态

`preparing`（创建 / setup 中）→ `idle` ⇄ `busy`；`broken`（lane worktree 意外变脏或 git 操作失败）。
- 任务完成（流水线 succeeded）或暂停时：gbdev 断言 lane worktree 干净（M2 的 snapshot 提交保证这一点），然后 `git switch --detach <verified_sha>`，lane → idle。
- 不干净 ⇒ lane → `broken`，任务 → needs_decision `lane_broken`（允许 `retry_task`、`drop_task`）；broken lane 不再接任务，保留到 cleanup；若全部 lane broken ⇒ run failed `all_lanes_broken`。
- 分配任务时（lane 已 idle）：
  - 新任务：`git switch -c <task_branch> <verified_sha>`（「刷新」就是这一步，D3）。
  - 恢复暂停任务：`git switch <task_branch>`，断言 HEAD = 该任务记录的 `head_sha`。
  - integration-fix：先 `git switch <task_branch>`，再把当前 `verified_sha` 合进任务分支：`git merge --no-ff -m "gbdev: refresh <task_id> onto integration <short>" <verified_sha>`（预检用 merge-tree；冲突 ⇒ 走 §9.4 的冲突流程但现场在 lane worktree，resolver 写 lane worktree）。这样修复者看到的是「本任务 + 当时集成分支」的组合代码，正是关口失败的那个组合。

### 7.4 合并（merge record）阶段

`precheck → merging → (resolving → verifying)? → gating → integrated | rolling_back → rolled_back_* | aborted_*`。每个阶段写入 `integration.merging.phase` 与 merge record，便于崩溃恢复（§12.2）。

## 8. 调度（`src/run/scheduler.ts`，纯函数 + 小量副作用包装）

### 8.1 调度循环

run supervisor 每个 tick（1 s，或收到子任务完成的进程内事件时立即）执行，顺序固定：
1. 读 `cancel.json`、deadline、`inputs/` 里的新决策输入（§10）。
2. 收割：结束的任务流水线 → 更新任务状态（§8.5）；结束的 resolver/verifier/planner job → 交给集成或规划模块。
3. 集成：集成锁空闲且 `merge_queue` 非空 ⇒ 取队首启动一次合并（异步，§9）。
4. 依赖推进：`pending` 且依赖全部 `integrated` ⇒ `ready`。
5. 分配：对每个 idle lane，按 §8.2 选一个可启动的任务（新任务、恢复的暂停任务、integration-fix 任务统一排队），检查槽位（§8.4）与重叠（§8.3），通过则启动。
6. 判断 run 级转移（§7.1）；写 `run.json`、心跳（每 30 s）。

除第 3、5 步里启动的长操作（流水线、合并、关口）是异步的外，循环里的状态修改全部在 M1 全局锁（`locked()`）内完成，单次持锁 < 1 s。**长操作绝不持全局锁**。

### 8.2 就绪队列的排序

候选集 = `ready` 任务 ∪ 已收到 resume 输入、等待 lane 的 `paused` 任务 ∪ 待开始 integration-fix 的任务。排序键（升序比较，前者优先）：
1. 类别：恢复的暂停任务 / integration-fix（已有投入、且阻塞下游）优先于新任务。
2. 关键路径长度（该任务到任一叶子的最长依赖链节点数）降序。
3. 任务图中的声明顺序。

lane 选择（对一个候选任务）：空闲 lane 中优先「该任务某个依赖最后执行所在的 lane」（亲和，代码缓存热），否则 `tasks_done` 最少的 lane，再按编号最小。由于每条 lane 同时只跑一个任务，这等价于 least-loaded + round-robin。

### 8.3 文件范围重叠

- 两个 glob 「可能重叠」的判定（保守、确定性）：取各自静态前缀（第一个含 `*?[{` 的路径段之前的部分）；若一方前缀是另一方前缀的路径前缀（按 `/` 分段比较），或两者都无通配且相等 ⇒ 重叠。例：`src/**` 与 `src/server.ts` 重叠；`src/routes/health.ts` 与 `src/routes/version.ts` 不重叠。
- `overlap_policy = serialize`（默认）：候选任务的 `file_scope` 与任一 `running`/`merging` 任务的 `file_scope` 重叠 ⇒ 本 tick 跳过它，试下一个候选（不阻塞队列）。
- `overlap_policy = allow`：不检查，冲突交给 §9.4。
- 重叠导致的等待记入任务 `warnings`（`waiting_overlap:<other_task>`），出现在 `run status` 里，便于 controller 判断是否该改图。
- 实际越界：任务流水线 succeeded 后，gbdev 计算该任务分支相对其 base 的改动文件，不被 `file_scope` 覆盖的路径写入 `scope_exceeded`，并产生 `warnings`（不阻塞合并）。

### 8.4 并发、槽位与配额

- **顶层互斥（不变的 M1/M2 语义）**：顶层占用者 = 非终态 standalone job ∪ 活动态 pipeline（standalone）∪ 活动态 run。`start`、`pipeline start`、`pipeline resume`、`run start`、`run resume` 在全局锁内检查，有占用者 ⇒ `busy`（retryable，`details` 增加 `running_run_id`）。暂停态 run 不占（D9 与 M2 一致），run 恢复时若被占用 ⇒ `busy`。配置 `concurrency` 仍必须为 1。
- **run 内槽位**：worker job（任务流水线的 step job、planner、resolver、verifier、final reviewer）每个占 1 个槽。约束：`in_use ≤ parallel.max_workers`，且每个 provider `≤ provider_limits[provider]`。检查/关口命令、`worktree_setup_cmd` 不占 worker 槽，但同一 run 同时最多 1 个关口在跑（由集成锁保证），lane 内 check 由 M2 步骤收尾执行。
- 有效并行度 = min(lanes, max_workers, provider 上限对应的可用数)。默认 2 lanes、3 workers：两条 lane 各跑一个 step job，另一个槽给 resolver/verifier/final review，不会因冲突解决饿死 lane。
- 步骤启动时没有槽 ⇒ 流水线在「创建 step job 之前」等待（M2 supervisor 增加 `acquireSlot(provider)` 钩子，standalone pipeline 时该钩子恒立即返回）。等待超过 30 分钟写 warning `slot_starved`。
- **限流冷却**：worker job 失败且其 failure_reason 或 worker 日志末 80 行匹配 `/\b(429|rate.?limit|quota|usage limit|too many requests)\b/i` ⇒ 该 provider 进入冷却 `rate_limit_cooldown_s`（默认 600 s），期间不启动该 provider 的新 job；该步骤自动重试一次（M2 attempt +1，不需要 controller），仍失败则按 M2 原规则暂停。冷却写 `slots.cooldown_until` 与 `provider_cooldown` 事件。
- 预算：每创建一个 worker job，`budget.jobs_used += 1`（含任务流水线内的 job，M2 自身的 `max_total_jobs` 继续对单条流水线生效）。达到 `max_total_jobs` ⇒ 不再启动新 job，已在跑的跑完，产生 run 级决策 `run_budget_exhausted`。

### 8.5 任务流水线结束后的去向

| 流水线终态 / 暂停 | 任务去向 |
|---|---|
| succeeded（approved / completed / accepted_by_decider） | 记录 `head_sha`、`scope_exceeded`；lane 释放；任务 → `merge_queued`（入队尾） |
| needs_input / blocked / needs_decision（M2 原因） | lane 释放（park）；任务 → `paused`；决策项 `task_paused`，`allowed_actions` = M2 的允许动作 ∪ {`drop_task`} |
| failed（含越界、超时、supervisor 内部错误） | lane 释放（若 worktree 脏 ⇒ lane broken）；任务 → `needs_decision`，reason `task_failed`，允许 `retry_task`、`rebuild_task`、`drop_task` |
| cancelled（仅 run cancel 引起） | 任务 → cancelled |

任务流水线的 M2 预算（`max_rounds`、`max_total_jobs`、`timeout_min`）照常生效，请求里由 `task_pipeline_overrides` 与 run 默认值生成：`max_rounds` 2、`timeout_min` 240、`max_total_jobs` 12。

## 9. 集成（`src/run/integrate.ts`）

### 9.1 集成锁

- 文件：`runs/<run_id>/integration.lock`，O_EXCL 创建，内容 `{pid, purpose: "merge|land|cleanup|recover", seq, at}`；与 M1 `~/.gbdev/lock` 完全独立。
- 持有者：run supervisor（一次合并的全过程，含关口，可能几十分钟）、`run land`、`run cleanup`、崩溃恢复。
- 锁文件 pid 不存活 ⇒ 视为陈旧，由下一个持有者在 M1 全局锁内删除并接管，写 warning `stale_integration_lock`。
- `run land`/`run cleanup` 拿不到锁 ⇒ `integration_locked`（retryable）。

### 9.2 一次合并（干净路径）

在集成锁内，`I` = 集成 worktree，`T` = 任务 head sha（入队时记录），`V` = `verified_sha`：
1. 断言：`I` 干净、`HEAD == V`、无 `MERGE_HEAD`；不满足 ⇒ 先执行 §12.2 的复位，再继续；复位失败 ⇒ run failed `integration_corrupt`。
2. 预检：`git merge-tree --write-tree --name-only --no-messages V T`。退出码 0 ⇒ 干净（记录 tree oid）；1 ⇒ 冲突（输出第一行后为冲突文件列表）；其他 ⇒ 重试一次，仍失败 ⇒ internal_error。
3. 干净 ⇒ `git -C I merge --no-ff --no-edit -m "gbdev: merge <task_id> (<run_id>)" T`，使用 gbdev 身份（`-c user.name=gbdev -c user.email=gbdev@localhost -c commit.gpgsign=false`，hooks 关闭）。合并失败（理论上不应发生）⇒ `git merge --abort`，按冲突路径处理。
4. **合并后关口**（§9.3）。通过 ⇒ `verified_sha = merge_sha`，任务 → `integrated`，`merged_sha` 记入任务与 pipeline 的 `integration`；释放锁。
5. 不通过 ⇒ §9.5。

### 9.3 合并后关口

- 检查集合（按此顺序、去重 by check id）：`integration_checks` → 本任务 AC 引用的 check → 所有已 integrated 任务 AC 引用的 check → run 级 `acceptance_criteria` 引用的 check。
- 执行：`/bin/sh -c <cmd>`，cwd = 集成 worktree，环境同 M1 check（继承 gbdev 的环境、去掉 `GBDEV_*` 内部变量），每个 check 用自己的 `timeout_min`，整个关口受 `gate_timeout_min`；日志 `merges/<seq>.gate/<check_id>.log`。
- 任一非 0 或超时 ⇒ 该 check 自动重跑一次（同一 cwd）；两次都失败才判关口失败；第二次通过则记 warning `flaky_suspected`（写入 merge record 和 run-result）。超时不重跑。关口结束后断言集成 worktree 干净（检查命令改了跟踪文件 ⇒ 关口失败，原因 `gate_modified_worktree`，由回滚清掉）。检查命令产生的未跟踪、未被忽略的文件：gbdev 执行 `git clean -fd`（不带 `-x`，被忽略的构建缓存保留）并记 warning `gate_left_untracked`。
- 检查命令本身不在 sandbox 里（同 M1），所以它们只能来自 controller 写的 `checks[]`（D12）。

### 9.4 冲突路径

1. 冲突文件数 > `max_conflict_files` 或 `max_resolver_attempts = 0` ⇒ 直接 `aborted_conflict_unresolved`，任务 → needs_decision `merge_conflict_unresolved`。
2. 否则在集成 worktree 制造冲突现场：`git merge --no-ff --no-commit T`（预期退出码 1）。记录 `git diff --name-only --diff-filter=U` 为冲突集合 C。
3. 启动 resolver job（槽位按 §8.4 申请；角色 `resolver`，cwd = 集成 worktree，`writable_roots = [集成 worktree]`，`allowed_paths` = run 的 allowed_paths，`network: false`）。prompt 内容（全部用数据围栏包裹 worker 来源的文本）：冲突文件列表；双方任务的 goal/AC/handoff 摘要（「ours = 集成分支上已有的任务们，theirs = <task_id>」）；硬指令：只编辑以消除冲突为目的、保留双方意图、不要运行安装或网络命令、不要动 `.git`、完成后在 `resolution` 里逐文件说明。
4. resolver job 的收尾**不走 M1 snapshot 提交**（job 带 `kind: "merge_resolution"`，`finalize.ts` 分支处理）：
   - 对 C 中每个文件检查冲突标记（行首 `<<<<<<< `、`=======`（整行）、`>>>>>>> `）；有残留 ⇒ 本次尝试失败（`markers_left`）。
   - 计算相对「自动合并结果」的改动文件：不在 C 中的写入 `touched_non_conflict`（警告，交给 verifier 重点看）；越出 allowed_paths ⇒ M1 policy violation，尝试失败。
   - `worker-result.resolution.unresolved` 非空 ⇒ 尝试失败。
   - 通过 ⇒ gbdev `git add -A` 并 `git commit --no-edit -m "gbdev: merge <task_id> (<run_id>) [resolved by <job_id>]"`（得到 merge commit，两个父提交）。
5. 尝试失败 ⇒ `git merge --abort`（若已无 MERGE_HEAD 则 `reset --hard V`），还有次数就回到第 2 步（prompt 附上次失败原因）；没有次数 ⇒ `aborted_conflict_unresolved`。
6. 解决成功 ⇒ 先跑关口（§9.3）；通过后再跑一次 **verifier**（M2 内置 verifier 角色，codex，read-only，cwd = 集成 worktree），输入是 merge commit 相对两个父提交的 diff 与双方 AC，要求 verdict。approve ⇒ integrated；revise/reject/无结论 ⇒ 回滚到 V，`aborted_verifier_rejected`，任务 → needs_decision `merge_conflict_unresolved`（detail 附 verifier findings）。
7. 冲突决策的允许动作：`retry_resolve`（再给 1 次 resolver 尝试，可带 note；每次合并最多额外 1 次）、`rebuild_task`（§10.2）、`drop_task`。

### 9.5 关口失败与回滚

1. `git -C I reset --hard <pre_merge_sha>`（集成分支是 gbdev 私有分支，未被任何人共享，reset 是确定且安全的；`pre_merge_sha == V`）。随后断言 `HEAD == V` 且干净。merge record `result = rolled_back_gate_failed`，失败的 merge sha 写入记录（对象在 git gc 前仍可查看，失败日志永久保存在 run 目录）。
2. 任务 `integration_fixes < max_integration_fixes` ⇒ `integration_fixes += 1`，任务 → `ready`（类别 integration-fix），分到 lane 后按 §7.3 先把 V 合进任务分支，再启动 `integration-fix` 流水线，`seed_findings.source = "integration_gate"`，findings 由失败检查合成（同 M2 `fixInput`：C<n>、major、日志末 80 行），context 写明「本任务在 lane 中检查通过，但与集成分支合并后失败；已集成的任务：…」。修复流水线 succeeded ⇒ 重新入合并队列。
3. 次数用完 ⇒ 任务 → needs_decision `integration_gate_failed`，允许 `extra_fix`（`max_integration_fixes` 对该任务 +1，绝对上限 3）、`rebuild_task`、`drop_task`。**没有「忽略关口」动作**：不让未通过关口的代码进入集成分支（D6）。

### 9.6 基线关口

`starting` 阶段在集成 worktree（= base_sha）跑一次 `integration_checks`。失败 ⇒ run failed `baseline_checks_failed`（result 里带日志路径）。理由：关口只能判断「合并后是否全绿」，基线不绿时无法区分是谁引入的失败；controller 应先让用户修好基线或调整 checks。

### 9.7 收尾（finalizing）

1. 断言 `HEAD == verified_sha`。若最近一次关口之后 `verified_sha` 没变，跳过重跑；否则（理论上不会）重跑一次完整关口。
2. `final_review = reviewer|verifier`：在集成 worktree 起一个只读 job，diff 基准 = base_sha，输入 run 的 goal、run 级 AC、各任务摘要与未解决意见。approve ⇒ succeeded；revise ⇒ 决策 `final_review_revise`；reject（自动重试 1 次后）⇒ 决策 `final_review_rejected`；缺少有效 verdict（自动重试 1 次后）⇒ 决策 `final_review_revise`，detail 明确记录 `final review verdict missing (verdict_missing)`，result 的 verdict 保持 null，不视为拒绝。
3. 允许动作：`add_fix_task`（gbdev 新建任务 `final-fix-<k>`，`depends_on` 为空，`file_scope` = run allowed_paths，模板 `final-fix`，`seed_findings.source = "final_review"`；任务走正常的 lane → 合并 → 关口流程，之后再进 finalizing；`final-fix` 最多 2 个）、`accept_final`（succeeded，outcome `accepted_by_decider`，未解决意见原样进 result）。
4. `final_review = none` ⇒ 直接 succeeded。
5. succeeded 时写 `result.json`、`diff.patch`（base_sha..verified_sha）。

## 10. 决策与 resume

### 10.1 决策项（`attention[]` 元素）

```json
{
  "decision_id": "d4",
  "scope": "task",
  "task_id": "health",
  "reason": "merge_conflict_unresolved",
  "allowed_actions": ["retry_resolve", "rebuild_task", "drop_task"],
  "detail": "src/server.ts 冲突；resolver 两次尝试均留有冲突标记",
  "pipeline_id": null,
  "merge_seq": 2,
  "pending_questions": [],
  "created_at": "2026-10-27T10:02:11-07:00"
}
```

| reason | scope | allowed_actions |
|---|---|---|
| plan_review | run | approve_plan（可附 task_graph）、replan |
| plan_invalid | run | replan、approve_plan（必须附 task_graph） |
| task_paused | task | 透传 M2：answer / retry / extra_round / accept（按该流水线当前 `decision.allowed_actions`）＋ drop_task |
| task_failed | task | retry_task、rebuild_task、drop_task |
| lane_broken | task | retry_task、drop_task |
| merge_conflict_unresolved | task | retry_resolve、rebuild_task、drop_task |
| integration_gate_failed | task | extra_fix、rebuild_task、drop_task |
| final_review_revise / final_review_rejected | run | add_fix_task、accept_final |
| run_budget_exhausted | run | extend_budget（只允许一次：`max_total_jobs` += min(30, 120 − 当前)）、accept_final（仅当所有未 dropped 任务已 integrated） |
| supervisor_crashed | run | resume_run |

`run cancel` 永远可用，不列在 allowed_actions 里。决策项解决后从 `attention` 移除，写入 `decisions.jsonl` 与 run-result 的 `decisions`。

### 10.2 run 级动作语义

- `approve_plan`：可带 `task_graph`（完整替换，重新按 §5.2 校验；非法 ⇒ `run_invalid`，决策项保持）。批准后写 `task-graph.json`，run → running。
- `replan`：可带 `note`；planner 尝试次数 ≤ 3（含第一次），超过 ⇒ `run_state_conflict`（details.reason `plan_attempts_exhausted`）。
- `retry_task`：旧任务分支原样保留作证据；从 `verified_sha` 切出新分支 `…/t/<task_id>-r<k>`，启动新流水线（kind `retry`，模板同任务），prompt 附上次尝试的 handoff 与失败原因（数据围栏）。若旧分支 tip 是 `verified_sha` 的祖先（即没有独有提交），则用 `update-ref` CAS 把旧分支快进到 `verified_sha` 后复用，不新建。
- `rebuild_task`：分支规则同 `retry_task`；区别是 prompt 明确要求「在当前集成分支的基础上重做本任务」，并附上旧分支相对其 base 的 diff 摘要（数据围栏）供参考；kind `rebuild`。用于冲突太大或任务基于过时代码的情况。每任务 retry+rebuild 合计 ≤ 3 次。
- `retry_resolve`：见 §9.4 第 7 步。
- `extra_fix`：见 §9.5 第 3 步。
- `drop_task`：任务 → dropped，依赖它的任务级联 dropped；返回 `dropped_tasks` 列表。已 integrated 的任务不能 drop（`run_state_conflict`）。
- `add_fix_task` / `accept_final`：见 §9.7。
- `extend_budget`：见上表。
- `resume_run`：见 §12.2。
- 任务流水线的透传动作（answer/retry/extra_round/accept）：gbdev 构造 `gbdev.pipeline-resume.v1` 调用 M2 的 resume 校验与状态变更逻辑（**不**拉起 pipeline supervisor），任务变为「等待 lane」候选（§8.2），由 run supervisor 在 lane 上继续该流水线。

### 10.3 gbdev.run-resume.v1

```json
{
  "schema": "gbdev.run-resume.v1",
  "run_id": "r_20261027_0911_5be0",
  "decision_id": "d4",
  "action": "retry_resolve",
  "task_id": "health",
  "answers": null,
  "task_graph": null,
  "note": "冲突在路由表顺序，按字母序合并即可"
}
```
- `decision_id` 必须是当前 `attention` 里的项；已解决或不存在 ⇒ `run_state_conflict`（details.reason `stale_decision`）——防止 controller 用过期视图回答。
- `action` 必须在该项 `allowed_actions` 里；`task_id` 必须与该项一致（run 级项必须为 null）。
- `note` ≤ 2000 字符，作为 `Note from the orchestrator:` 追加到下一次相关 prompt（同 M2）。
- 写入方式：`run resume` 在全局锁内校验 → 写 `inputs/<decision_id>.json` → 标记决策项 `resolving`；若 run supervisor 存活（run 为 running）则由它在下一个 tick 消费；若 run 处于暂停态且 supervisor 已退出，`run resume` 检查顶层槽位（busy 规则 §8.4）后拉起新的 supervisor。返回 `gbdev.run.v1`。
- 一次 resume 只解决一个决策项。多个决策项需要多次调用（Mac 上每次一个审批；controller 可在一次唤醒中连续处理）。

## 11. 命令

### 11.1 run 命令族（全部支持 `--json`，输出 M1 信封，contract_version "1"）

| 命令 | 作用 |
|---|---|
| `gbdev run start --request <file\|-> [--dry-run]` | 校验 → 角色快照 → provider 预检 → 建 run 目录 → 拉起 `__run-supervise`（detached、`caffeinate -i`、unref）→ 立即返回 `gbdev.run.v1`（state `queued`/`starting`）。dry-run 只做校验和预检（含 git 版本 ≥ 2.38、base_ref 可解析、task graph 校验），不写任何东西 |
| `gbdev run status [<run_id>] [--json]` | 无 id 时列出最近 20 个 run 的摘要；有 id 时返回 `gbdev.run.v1`。读前执行 reconcile（§12.2） |
| `gbdev run wait <run_id> --timeout-ms N [--until attention\|settled] [--with-result]` | 阻塞到：`attention`（默认）= 出现**新的**决策项、或 run 稳定；`settled` = run 进入暂停态或终态。N ≤ 540000。超时 ⇒ `wait_timeout`（retryable）并附当前 `gbdev.run.v1`。`--with-result` 在稳定时附 run-result |
| `gbdev run result <run_id>` | `gbdev.run-result.v1`；活动态 ⇒ `run_not_settled` |
| `gbdev run resume <run_id> --input <file\|->` | §10.3 |
| `gbdev run cancel <run_id>` | 写 cancel.json；supervisor 终止所有运行中的 job（SIGTERM，15 s 后 SIGKILL，同 M2）、中止进行中的合并并复位集成 worktree 到 `verified_sha`；任务 → cancelled；run → cancelled。supervisor 不在时由命令自己在集成锁内完成复位。幂等 |
| `gbdev run cleanup <run_id> [--dry-run] [--force-branch]` | §13.1；只能用于终态 |
| `gbdev run land <run_id> --target <branch> --confirm-user-approved [--dry-run]` | §13.2 |
| `gbdev __run-supervise <run_id>` | 内部命令 |

`run wait` 的「新的」决策项：以调用时 `attention` 中已有的 decision_id 集合为基准；若调用时已有未处理项，立即返回（避免 controller 漏看）。

### 11.2 既有命令的增量

- `gbdev status`（无参数）列表与 `gbdev pipeline status`（无参数）列表：属于 run 的 job/pipeline 标注 `run_id`。
- `gbdev cleanup <job_id>` 对 run 内 job ⇒ `job_owned_by_run`；`pipeline cancel|resume|cleanup` 对 run 内 pipeline ⇒ `pipeline_owned_by_run`。
- `gbdev doctor`：新增检查 `git_merge_tree`（git ≥ 2.38 且 `git merge-tree --write-tree` 在临时仓库里可用）、`parallel_config`、`run_defaults`、`resolver_role`；列出 `stale_integration_locks`。
- `gbdev roles list` 多出 `resolver`；`pipeline templates` 多出 `integration-fix`、`final-fix`（`internal: true`）。

### 11.3 新增错误码（gbdev.error.v1）

| code | retryable | 退出码 | 场景 |
|---|---|---|---|
| run_not_found | false | 1 | run_id 不存在 |
| run_invalid | false | 2 | run 请求 / task graph / resume 输入非法 |
| run_not_settled | true | 1 | 对活动 run 调 result |
| run_not_terminal | true | 1 | 对非终态 run 调 cleanup |
| run_state_conflict | false | 1 | 动作不被允许、过期决策、次数耗尽、drop 已集成任务 |
| integration_locked | true | 1 | 集成锁被占用（land / cleanup） |
| user_approval_required | false | 2 | `run land` 缺 `--confirm-user-approved` |
| land_refused | false | 1 | land 前置条件不满足（details.reason：`run_not_succeeded`、`target_is_checked_out_dirty`、`target_moved`、`gate_failed_on_sync`、`sync_conflict`、`ff_failed`） |
| guard_violation | false | 1 | 内部错误：破坏性 git 操作的目标不在本 run 的命名空间内（§14 S-1），视为 bug |
| pipeline_owned_by_run | false | 1 | 直接操作 run 内 pipeline |
| job_owned_by_run | false | 1 | 直接 cleanup run 内 job |

既有错误码增量：`busy.details.running_run_id`；`wait_timeout` 用于 run wait 时带 `details.run`；`cursor_model_not_allowed` 也由 run 请求与 task graph 触发。


## 12. Supervisor、崩溃恢复与可观测性

### 12.1 `__run-supervise`

- `gbdev run start` 完成校验、建目录、写 `run.json`（state `queued`）后，以 detached 方式启动 `gbdev __run-supervise <run_id>`（与 M2 `__pipeline-supervise` 相同的 spawn 方式：`detached: true`，stdio 重定向到 `runs/<run_id>/supervisor.log`，`unref()`），把 pid 写入 `run.json.supervisor.pid`，然后立即返回 `gbdev.run-start.v1`。
- 一个 run 只有一个 supervisor 进程。run 内的所有任务流水线都在这个进程里**以库调用方式**并发运行（复用 M2 的 `runPipeline()`，传入 `run_binding`），不再为每个任务 fork `__pipeline-supervise`。理由：槽位、集成锁、预算和调度状态都在一个事件循环里，避免跨进程协调。
- 每条任务流水线仍然各自写自己的 `pipelines/<pipeline_id>/pipeline.json`，因此 `gbdev pipeline status <id>` 对 run 内流水线也可用（只读；对 run 内流水线执行 `pipeline resume|cancel|cleanup` 返回 `pipeline_owned_by_run`，退出码 1，见 §6.4）。
- 主循环（伪代码）：

```ts
while (!terminal(run)) {
  reconcileJobs();             // M1 reconcile：完成/超时/进程消失
  advancePipelines();          // 驱动每条任务流水线一步（异步，不阻塞循环）
  drainMergeQueue();           // 一次最多推进一个合并（集成锁内）
  scheduleReadyTasks();        // §8：空闲 lane + 空闲槽位 → 启动任务
  checkBudgets();              // §8.5
  updateAttention();           // §10：决策项、卡住检测
  heartbeat();                 // 每 30 s 写 supervisor.heartbeat_at
  await sleep(POLL_MS);        // POLL_MS = 2000
}
```

- 所有对 `run.json` 的写入走 `writeJsonAtomic`（tmp + rename），由 supervisor 单写者；CLI 侧的 `run resume|cancel` 通过写 `runs/<run_id>/inbox/<ts>-<rand>.json` 投递请求，supervisor 在下一轮循环里消费并删除（处理结果写事件）。这样 CLI 永远不与 supervisor 争写 `run.json`。
  - 例外：supervisor 已死时，`run cancel` 与 `run resume --action resume_run` 由 CLI 在全局锁下直接改写（先做 §12.2 的恢复）。
- `cancel` 语义：supervisor 收到后进入 `cancelling`：停止调度；对运行中的 worker job 走 M1 cancel（SIGTERM 进程组，10 s 后 SIGKILL）；若有合并进行中，`merge --abort` 或 `reset --hard pre_merge_sha`；把集成 worktree 恢复到 `verified_sha`；所有非终态任务 → `cancelled`；run → `cancelled`。已集成的提交保留在集成分支上。

### 12.2 崩溃识别与恢复

识别：任何 `gbdev run status|wait|resume|cancel` 调用（以及 supervisor 自身启动时）都执行 `reconcileRun()`：

- run 处于活跃态（`planning | plan_review | running | merging | finalizing | cancelling`），且 `supervisor.pid` 进程不存在，或进程存在但 cmdline 不含 `__run-supervise <run_id>`（pid 复用），即判定崩溃。
- 心跳超过 180 s 未更新，但进程仍在：不判崩溃，只在 status 里给出 `warnings: ["supervisor_heartbeat_stale"]`（可能是 Mac 睡眠）。

恢复步骤（在全局锁与集成锁内，顺序执行；每一步写事件 `recovery_step`）：

1. 对 run 下所有非终态 job（任务流水线、planner、resolver、verifier、final_review）执行 M1 reconcile；若 worker 进程组仍活着，SIGTERM → 10 s → SIGKILL；job 记为 `failed`，`failure_reason = supervisor_crashed`。
2. 任务流水线：非终态的 → `failed`，`failure_reason = pipeline_supervisor_crashed`（复用 M2 原因码）。
3. 集成 worktree：
   - 若存在 `MERGE_HEAD`：`git merge --abort`；
   - 若 `HEAD != verified_sha`：`git reset --hard <verified_sha>`（受 §14 守卫：只允许作用于本 run 的集成分支）；
   - 执行 `git clean -fd`（不带 `-x`，忽略文件作为缓存保留）；
   - 进行中的 merge record → `result = aborted_crash`；对应任务回到 `merge_queued` 队首。
4. Lane：
   - 对每个 `busy` lane：若 worktree 有改动，由 gbdev 在任务分支上做一次证据提交 `gbdev: crash snapshot <task_id> (<run_id>)`（同 M1 snapshot 提交：`--no-verify`，作者为 gbdev），然后 `git switch --detach <verified_sha>`，lane → `idle`；
   - 证据提交失败 → lane → `broken`（保留现场，不再分配）。
   - 对应任务 → `needs_decision`，并生成决策 `task_failed`（`detail = supervisor_crashed`）。
5. run → `needs_decision`，生成 run 级决策 `supervisor_crashed`，`allowed_actions = ["resume_run"]`（`cancel` 永远可用）。
6. 任一步失败（例如 reset 失败）→ run → `failed`，`failure_reason = integration_corrupt`，保留全部现场。

`resume_run`：
- 校验 I1（§12.3）；
- 重新启动 `__run-supervise`，run 回到崩溃前所处阶段（`running`；若崩溃时在 `planning` 则重新规划，计入 replan 次数；若在 `finalizing` 则重做最终评审）；
- 崩溃时被中断的任务仍需各自的 `task_failed` 决策（通常 `retry_task`）。controller 可以在同一次 `run resume` 里批量提交（`--answers-file`，§10.3）。

### 12.3 不变量

每轮主循环末尾和每次恢复后都断言以下不变量；违反时写 `invariant_violation` 事件，run → `needs_decision` `integration_corrupt`（只允许 `cancel`）：

| 编号 | 不变量 |
|---|---|
| I1 | 稳定时（没有进行中的合并）：集成 worktree `HEAD == verified_sha`；无 `MERGE_HEAD`；`status --porcelain` 为空 |
| I2 | 集成分支 first-parent 链上 `base_sha` 之后的每个提交，要么是 merge record `integrated` 的 `merged_sha`，要么是 land 同步合并（§13.2） |
| I3 | 任务 state 为 `integrated` ⇔ 其 `merged_sha` 是 `verified_sha` 的祖先 |
| I4 | lane `busy` ⇔ 恰好一个 `running` 任务引用它 |
| I5 | `slots.in_use` == 当前活着的 worker job 数；任一 provider 的使用数不超过其上限 |
| I6 | gbdev 在 run 期间从不写 `refs/heads/<target>`；只有 `run land` 写 |
| I7 | 任何 worker job 的 cwd 都是某个 lane worktree 或集成 worktree，从不是主仓库 |

测试中提供 `assertRunInvariants(runDir)`，所有 fake 场景结束时调用。

### 12.4 可观测性

- `gbdev run status <run_id>`（人读）示例：

```
run r_20261027_0930_ab12  state=running  2h13m  jobs 23/60  tasks 4/7 integrated
integration gbdev/r_20261027_0930_ab12/integration @ 3f2a9c1 (verified)  merges 4  conflicts 1 (resolved)
lane-1 busy  t3 impl#2 (codex) 6m12s
lane-2 busy  t5 review (cursor) 11m40s
lane-3 idle
queue: t6 (waits t3), t7 (waits t5,t6)
attention: none
```

- `--json` 输出 `gbdev.run-status.v1`：`run.json` 的投影，加 `progress`（tasks 按 state 计数）、`lanes[]`（当前任务、步骤、provider、已用时）、`attention[]`、`warnings[]`、`budget`（used/limit）。
- `runs/<run_id>/events.jsonl` 追加事件（§6.8）；`gbdev run status --events [--since <seq>]` 读取。
- `supervisor.log` 只给人排障，不是契约。
- controller 汇报只依据 `run status --json` 与 `run result`，不解析日志。

## 13. Cleanup、Land 与用户批准

### 13.1 `gbdev run cleanup <run_id> [--dry-run] [--force-branch]`

前提：run 处于终态（`succeeded | failed | cancelled`），否则 `run_not_terminal`（退出码 1）。在全局锁和集成锁内执行。

Worktree（OMC 的 merger worktree 从不删除，这里补上）：

1. 每个 lane worktree：
   - `status --porcelain` 非空 → 保留，`retained_reason = worktree_dirty`；
   - 否则 `git worktree remove <path>`（不带 `--force`）。
2. 集成 worktree：同样规则。正常终态下它是干净的（I1）。
3. `git worktree prune`。
4. run 内各流水线的 `pipeline.json.cleanup` 字段同步写入结果。

分支（OMC `removeWorkerWorktree` 对分支直接 `branch -D`，不检查未合并提交；git-worktree.ts:636）：

1. 任务分支（含 `-r<k>` 重建分支）：tip 是集成分支 tip 的祖先（`merge-base --is-ancestor`），或已 land 且是 target tip 的祖先 → 删除；否则保留，`retained_reason = unmerged_task_commits`。
2. 集成分支：
   - 已 land 且 tip 是 target tip 的祖先 → 删除；
   - tip == `base_sha`（一次合并都没有）→ 删除；
   - 否则保留，`retained_reason = unmerged_integration_commits`。
3. 删除一律用 `git update-ref -d refs/heads/<b> <expected_tip>`（CAS），并沿用 M1 R1 的「分支被某 worktree 检出则不删」检查。
4. `--force-branch`：删除 `unmerged_*` 保留的分支（仍不删被检出的、不删 dirty worktree）。controller 只有在用户明确同意丢弃这些提交后才能加此参数。

证据（`runs/`、`pipelines/`、`jobs/` 目录）一律保留，M3 不提供 purge。

输出 `gbdev.run-cleanup.v1`：

```json
{
  "contract_version": "1", "schema": "gbdev.run-cleanup.v1", "run_id": "…", "dry_run": false,
  "worktrees": [{ "path": "…/lane-1", "kind": "lane", "removed": true }],
  "branches": [{ "branch": "gbdev/…/t/t3", "deleted": false, "retained_reason": "unmerged_task_commits", "tip": "…" }]
}
```

### 13.2 `gbdev run land <run_id> --target <branch> --confirm-user-approved [--dry-run] [--approval-note <text>]`

`--confirm-user-approved` 是声明式开关：gbdev 无法验证用户是否同意，它的作用是让「未经确认就合入」在调用层面不可能是无意的。controller 只在用户本轮明确说「是/合入」之后才带上它（§19）。

前提检查（任一失败都不做任何改动）：

- 缺少 `--confirm-user-approved` → `user_approval_required`（退出码 2）；
- run 不是 `succeeded` → `land_refused`，`details.reason = run_not_succeeded`；
- `--target` 不合法（`validateBranchName`）、不存在、或以 `gbdev/` 开头 → `run_invalid`（退出码 2，`details.reason = invalid_target`）；
- 已 land 过：若 target 已包含 `landed_sha` → 退出码 0，返回原记录（幂等）；否则 `land_refused`，`details.reason = target_moved`。

步骤（全局锁 + 集成锁内）：

1. 记 `T0 = rev-parse refs/heads/<target>`，`V = verified_sha`。
2. 同步：若 `T0` 不是 `V` 的祖先（目标分支在 run 期间前进了）：
   - `merge-tree --write-tree --name-only V T0`，有冲突 → `land_refused`，`details.reason = sync_conflict`（建议：以新 base 开新 run，或由用户手工处理）；
   - 无冲突 → 在集成 worktree `git merge --no-ff -m "gbdev: sync <target> into integration (<run_id>)" T0`，跑完整关口（§9.3 的并集）；
   - 失败 → `reset --hard V`，`land_refused`，`details.reason = gate_failed_on_sync`（附失败输出摘要）；
   - 通过 → `V = 新 HEAD`，更新 `verified_sha`，写 merge record（`kind = sync`）。
3. 快进 target 到 `V`：
   - `git worktree list --porcelain` 找出检出 target 的 worktree `W`（可能是用户主仓库）；
   - 若 `W` 存在：`status --porcelain --untracked-files=no` 非空 → `land_refused`，`details.reason = target_is_checked_out_dirty`；否则 `git -C W merge --ff-only V`（git 会拒绝覆盖未跟踪文件；失败 → `land_refused`，`details.reason = ff_failed`）；
   - 若无人检出：`git update-ref refs/heads/<target> V T0`（CAS；失败 → `land_refused`，`details.reason = target_moved`，可重试）。
4. 写 `run.json.land = { target, from_sha: T0, landed_sha: V, approved_by_user_at: <now ISO>, approval_note }`，事件 `landed`。
5. **从不 push**。push 由 controller 在用户另外明确同意后，在用户自己的会话里执行（与 M1/M2 规则一致）。

`--dry-run`：只做 1–2 的检查（同步只跑 merge-tree，不合并、不跑关口），输出计划。

`master/main` 并不特殊对待：任何 target 都需要 `--confirm-user-approved`。

### 13.3 批准流程（controller 侧）

| 动作 | 需要用户明确同意？ |
|---|---|
| `run start`（含 planner） | 否（用户发起任务即可） |
| `approve_plan` / `replan` | 否，controller 自行判断；但计划 > 8 个任务或预计 > 40 jobs 时先问用户 |
| 冲突/门禁相关决策（`retry_*`、`rebuild_task`、`add_fix_task`、`accept_final`） | 否，controller 依据 §19 规则 |
| `drop_task` | 是（会丢弃用户要求的工作） |
| `extend_budget`（gbdev 只允许一次，最多 +30 jobs） | 否；但第二次预算耗尽时问用户是 `accept_final` 还是 cancel |
| `run land` 到任何分支 | 是 |
| push | 是（不由 gbdev 执行） |
| `cleanup --force-branch` | 是 |

## 14. 安全规则（继承 + 新增）

继承自 M1/M2，不变：

- Cursor 只用 `--model auto`；只读步骤 `--mode plan`，写步骤 `--force`。
- 永不使用 `--dangerously-bypass-approvals-and-sandbox`，永不 `--sandbox disabled`；Codex 一律 `exec -s workspace-write`（只读角色 `-s read-only`）。
- worker 不读仓库外文件、无网络、不安装依赖、不 push；prompt 中的这些约束与 M2 文案一致。
- 外部文本（diff、日志、findings、handoff、冲突片段）一律放进数据围栏。
- `check_cmd` 与 `worktree_setup_cmd` 只来自 controller 写的 run 请求（`checks[]` / `worktree_setup_cmd`，用户可见）；planner 只能按 id 引用 check，不能写命令（§5.3）。

M3 新增：

- **S-1 破坏性 git 守卫**：`resetHard`、`clean -fd`、`merge --abort`、`update-ref`、`switch --detach` 统一走 `gitGuarded()`，参数里的目标分支必须匹配 `^gbdev/<run_id>/(integration|t/[a-z0-9_-]+(-r[0-9]+)?)$`，worktree 路径必须在 `~/.gbdev/worktrees/<repo>/<run_id>/` 下；否则抛 `guard_violation`（测试覆盖）。唯一例外是 `run land` 的第 3 步，它单独实现，只做 ff-only 或 CAS。
- **S-2 主仓库不动**：run 期间 gbdev 从不在主仓库工作区执行任何写操作（只读 `rev-parse`、`worktree list`、`for-each-ref`）。
- **S-3 resolver 约束**：resolver 只在集成 worktree 运行，prompt 要求只为消除冲突而改动、不改测试期望来「让测试通过」；改了冲突集合以外的文件记 `touched_non_conflict` 警告并交给 verifier 重点审查（§9.4；不直接拒绝，避免误杀合理修改），越出 allowed_paths 则直接判失败。
- **S-4 不覆写门禁**：没有任何决策能跳过 post-merge gate。`accept_final` 只接受最终评审的残留 finding，不接受关口失败。
- **S-5 并发上限硬编码**：`max_workers ≤ 4`、`max_lanes ≤ 4` 是代码常量，配置更大值 → `config_invalid`。
- **S-6 环境隔离**：所有 worker 继承 M2 的环境白名单；新增 `GBDEV_RUN_ID`、`GBDEV_LANE`（只做信息用途）。

## 15. 与 OMC 的对比（参考 HEAD 726fa45）

| 项目 | OMC 做法（出处） | gbdev M3 | 理由 |
|---|---|---|---|
| 合并前预检 | `merge-tree --write-tree`，失败回退到重叠启发（merge-coordinator.ts:97-132） | 采纳；去掉启发式回退，要求 git ≥ 2.38（doctor 检查） | 启发式会误报，统一用真实三方合并结果 |
| 合并方式 | `--no-ff`，失败一律 abort（merge-coordinator.ts:7-8, 165-211） | 采纳；按 sha 合并，提交信息带 run/task id | 保留每个任务的合并边界，可回滚、可审计 |
| 串行化 | 进程内 mutex（merge-orchestrator.ts:8, 406, 522） | 采纳并持久化：`integration.lock` 文件锁 | supervisor 可能崩溃，CLI 也要安全读写 |
| 专用合并 worktree | `.omc/team/<team>/merger`，`worktree add --force`（:148, :305-317） | 采纳；不用 `--force`，放在 `~/.gbdev/worktrees/` | 不污染仓库目录；不覆盖已有 worktree |
| 拒绝 main/master | 不允许 leader 是 main/master（:18, :185-188） | 加强：run 期间从不写任何用户分支，只写自己的集成分支；land 需显式批准 | 合入用户分支是用户的决定 |
| worktree 粒度 | 每个 worker 一个 worktree/分支 `omc-team/<team>/<worker>`（git-worktree.ts:93-94） | 改：worktree 归 lane，每个任务一条新分支 | 任务边界清晰；lane 可复用依赖与缓存 |
| 合并时机 | 每 1 s 轮询 worker 提交，有提交就合（:140） | 改：只在任务通过全部关口后合并 | 半成品不进集成分支 |
| 刷新 worker | 合并后向其他 worker 扇出 auto-rebase（:424-515） | 改：从不在运行中 rebase；下个任务从 `verified_sha` 切新分支 | 运行中改基线会打断 worker、产生难懂冲突 |
| 冲突处理 | 写入 leader/worker 收件箱，由 LLM leader 处理（conflict-mailbox.ts:54-137） | 改：Codex resolver job → 关口 → verifier；失败转 `needs_decision` | 没有常驻 leader；结果可验证 |
| 分配策略 | 统一池轮询 + least-loaded（allocation-policy.ts:43-60, :95） | 采纳 least-loaded；加 lane 亲和与 file_scope 重叠串行 | 降低冲突概率 |
| 协调者 | 常驻 leader 会话 | 改：无常驻 leader；controller 每 ~10 分钟或事件唤醒 | 省成本；状态全在磁盘 |
| AGENTS.md/.claude merge=ours（merge-coordinator.ts:36-51） | — | 不需要 | gbdev 不向 worktree 注入覆盖文件 |
| 合并后测试 | 无：合并成功后直接扇出 rebase（merge-orchestrator.ts:586 之后） | 补缺口：每次合并后跑 post-merge gate，失败回滚并交 integration-fix | 两个各自通过的改动合在一起可能出错 |
| 清理时的未合并检查 | 只检查 dirty（git-worktree.ts:571-575, 689-714）；删分支用 `branch -D`（:636） | 补缺口：删分支前检查是否已包含在集成分支/target，否则保留 | 防止静默丢提交 |
| 清理合并 worktree | merger worktree 只创建、从不删除（:305-317；`drainAndStop` :792 只返回未合并列表） | 补缺口：cleanup 同样删除干净的集成 worktree | 不遗留 worktree |
| autoMerge 与 worktree 模式绑定 | autoMerge 强制命名 worktree 模式（runtime-v2.ts:4025-4028） | 一致：`per_lane` 是 run 内唯一模式 | 与 M2 预留的 `workspace.mode` 对齐 |

## 16. 为「以后上云」预留的钩子（M3 不实现）

- `run.json.executor_host = "local"`、`lanes[].host = "local"`：只写，不读；以后用来表示 lane 在远端执行器上。
- Lane 操作集中在 `LaneBackend` 接口：`prepare()`、`startTask(branch, base)`、`isClean()`、`park()`、`remove()`。M3 只有 `LocalWorktreeLane` 实现。
- 集成 worktree 永远在本地（合并、关口、land 都是本地操作），远端 lane 以后只需要把任务分支 fetch 回本地即可接入合并队列。
- job 启动只通过 provider adapter；run 目录读写只通过 `RunStore`。
- 不引入任何网络调用；不新增需要网络的依赖。

## 17. 分阶段实施计划

S6 真实冒烟缺陷修复 D1–D3：run final review、merge verifier 与 pipeline reviewer 共用 review 示例与字段要求；final review 与 pipeline 共用缺 verdict 重试文案，final review 第二次尝试在第一次无有效 verdict 时附加重试说明。planner 提示词补 task_graph 完整形状示例，resolver 补 resolution.files/unresolved 示例及要求。integration-fix/final-fix 仍走 M2 renderStepPrompt，无单独的 run 通用提示词。缺 verdict 使用已有 final_review_revise，不增加枚举，contract_version 保持 "1"，M1 与 M2 三种 worker schema 不变。此修复仅用 fake provider 验证，不代表真实冒烟通过。

在分支 `gbdev-m3`（从 master `2ad610b` 切出）上实施。每个阶段单独提交，阶段结束时 `npm test` 全绿，M2 的 542 个测试保持通过。

### M3-S1 契约与基础件

实施状态（本轮）：S1 契约与基础件已实现；Node v24.15.0 下 `npm run build`、`npm test`、`npx --no-install tsc --noEmit`、测试工程 noEmit 检查均退出 0，620 个测试全部通过（原有 542 + 新增 78，失败/跳过均为 0）；没有执行真实 provider 冒烟，不代表 S2–S6 完成。新增测试：`test/m3-s1-contracts.test.ts`、`test/m3-s1-git.test.ts`、`test/m3-s1-pipeline.test.ts`、`test/safety-argv.test.ts`。M1 既有 schema 夹具不变；M2 三种 pipeline 输出的字节基线新增为 `test/fixtures/worker-result.m2.*.schema.json`。

S1 实施说明与尚需确认的规格边界：
- M3 配置通过显式 `loadRunConfig` / `validateConfig(value, registry)` 校验；legacy `loadConfig` 不读取 parallel/run_defaults，满足 §3.1 的隔离要求。doctor 独立检查两个字段。
- S2 已确认并实现 rate_limit_cooldown_s 范围为 0–3600 整数秒（默认 600）。
- §6.5 的“fix 角色”在 M2 注册表中实际名为 `fixer`（`fix` 是步骤 id），本轮按首步骤 role=fixer 校验，未新增名为 fix 的角色。
- S-1 的统一守卫应用于所有新增 M3 破坏性辅助函数；M1/M2 cleanup 现有 `update-ref -d` 操作 job/pipeline 命名空间，按 §20 保留原行为。S2 已确认：保留 M1/M2 cleanup 的 job/pipeline ref 操作，不纳入 run 守卫。
- §6.3 findings 保留 M2 review finding 的 message/suggestion 形状；§6.5 seed_findings 使用明确给出的 text 形状，不改写 worker 的 review 原文。
- §5.2 的图校验器按本轮明确要求位于 `src/contracts/taskGraph.ts`，不创建调度层 `src/run/`。
- S1 当时未实现 stale_integration_locks/lane/调度；S2 已补集成锁诊断和 lane/调度基础，run supervisor/合并流程/planner/run 命令族仍未实现。

- `config.json`：`parallel`、`run_defaults` 及校验（§3.1）。
- 契约：run-request、task-graph、run.v1、merge-record、run-result、run-resume 的校验器与 JSON Schema 文件；pipeline-run / pipeline-request / worker-result 的增量字段（§6.4–6.6）。
- 新错误码（§11.3）。
- Git 辅助函数：`mergeTreeCheck`、`mergeNoFf`、`mergeNoCommit`、`mergeAbort`、`isAncestor`、`worktreeListPorcelain`、`updateRefCas`、`switchDetach`、`switchCreate`、`gitGuarded`（S-1）。
- ID：`createRunId()`；resolver 角色与内部模板（§6.7）；doctor 增加 git 版本检查（≥ 2.38）。

验收：
- AC-S1.1：每个新校验器至少 3 个负例；M2 的 schema 文件内容不变。
- AC-S1.2：`gitGuarded` 拒绝非 `gbdev/<run_id>/…` 分支和越界路径（单测）。
- AC-S1.3：`mergeTreeCheck` 在临时仓库中正确区分干净/冲突，冲突文件列表准确。
- AC-S1.4：M2 全部测试通过；单独流水线（不带 `run_binding`）行为不变。

### M3-S2 Lane、集成 worktree 与调度纯函数

实施状态：S2 + S1 评审 F1–F7 已实现；范围仅限下列基础件和 M2 接线，不表示 S3–S6 完成。Node v24.15.0 下 `npm run build`、`npm test`、`npx --no-install tsc --noEmit`、`git diff --check` 通过；691 个测试全绿（此前 620 + 新增 71），失败/跳过均为 0。没有运行真实 provider 冒烟。

实施说明：
- Lane 生命周期及 setup 位于 `src/run/lanes.ts`、`workspace.ts`；setup 默认超时 15 分钟，失败/超时保留现场，lane broken。任务开始与 park 均走 run Git 守卫；dirty lane 不做 reset/clean，不丢证据。
- 集成 worktree 创建/打开位于 `src/run/integration.ts`；仅验证已存在 worktree，不实现基线关口或修复。`integrationLock.ts` 实现 O_EXCL、持有者信息、死 PID 识别、全局锁内接管和防替换释放；doctor 只读报告 stale_integration_locks。
- `scheduler.ts` 提供确定性队列、亲和/负载 lane 选择、scope overlap、槽位/provider 上限、冷却纯函数，无 I/O。37 个表驱动场景及组合测试覆盖 AC-S2.1。
- 代码事实修正：M2 原入口名为 pipelineStart/supervisePipeline，没有旧 runPipeline。S2 新增内部 runPipeline 复用原初始化/监督逻辑，带 run_binding 时不创建 worktree、不派生 supervisor；每个 step 在全局锁外 acquireSlot，所有退出路径 releaseSlot。onRateLimit 由调用者持久化冷却并发事件，自动重试一次；run 级预算/事件/调度循环留到 S3。
- F1/F2：Codex taskGraph 采用 type 联合可空字段，不含组合 schema；standalone planner 不附 handoff；M1/M2 输出字节基线不改。F3–F7：merge/switch 加 run 守卫、run update-ref 加 --no-deref、区分所有权与执行错误、SHA 仅 40/64 位、paths.worktrees/目标路径均 canonicalize，根目录不存在 fail-closed。
- S2 只提供新任务分支与 park 生命周期；暂停恢复、integration-fix 的分支复用/合并接线属于后续 supervisor/集成阶段，不在本轮实现。
- 验收证据：`test/m3-s2-fixes.test.ts`、`m3-s2-scheduler.test.ts`、`m3-s2-lanes.test.ts`、`m3-s2-lock.test.ts`、`m3-s2-pipeline.test.ts`，已加入默认 test/index.ts。AC-S2.2 使用 3 lane × 2 任务的真实临时 Git 仓库；AC-S2.3 保留 dirty 证据且不分配新任务。

- `LaneManager`：创建 lane worktree、`worktree_setup_cmd`、任务开始时切新分支、park/释放、`broken` 判定。
- 集成 worktree 管理与 `integration.lock`。
- 调度纯函数（§8）：ready 队列排序、lane 选择（亲和 → least-loaded → 序号）、file_scope 重叠判定、槽位与 provider 上限、限流冷却。
- M2 `runPipeline()` 接入 `run_binding`：槽位申请/释放回调、在指定 lane 运行、不再自行 detach。

验收：
- AC-S2.1：调度函数表驱动测试 ≥ 20 例（依赖、重叠、亲和、provider 上限、冷却）。
- AC-S2.2：真实 git 临时仓库测试：3 个 lane 依次跑 2 个任务，每个任务分支都从当时的 `verified_sha` 切出。
- AC-S2.3：dirty lane 不会被分配新任务。

### M3-S3 Run supervisor、干净合并、合并后门禁、回滚

**实施状态（2026-10-26）：S3 已实现，附带 F8–F12 评审修复；真实冒烟未执行。**

实现位于 `src/commands/run.ts`、`src/run/{store,supervisor,gate,finalReview,invariants,result,requests}.ts`，复用 S2 LaneManager/scheduler/integrationLock 和内部 runPipeline。支持 provided start（含只读 dry-run）、status/events、wait、result、cancel；单 detached supervisor 内并发流水线；baseline、FIFO 干净合并、检查集合/重试、回滚与 integration-fix、none/reviewer finalizing、I1–I7 和取消复位。角色/provider/模板/并行配置在 start 冻结。

最小暂停点产生 attention；没有实现 resolver、完整 resume/预算/崩溃恢复、planner/计划评审、cleanup/land。无 supervisor 的 cancel 仅停止遗留 worker/check 并复位，不实现 resume_run。

契约差异：遵循 §6.1/§11.1 与 S1 schema，返回 gbdev.run.v1，使用扁平 supervisor_pid/heartbeat_at、cancel.json；不另建 §12.1/§12.4 中的 run-start/run-status schema，不新增 cancelling 状态。§12.3 所需 integration_corrupt 已补 attention reason，空 allowed_actions 表示仅 cancel。I6 检查启动时目标分支快照，不主动修复外部移动的目标分支。

测试证据：`test/m3-s3-run.test.ts`（下列 AC、final reviewer、I1–I7、CLI/分离进程收尾、关口/取消），`test/m3-s2-{lock,lanes}.test.ts`（F8–F10/F12）；F11 在 AC-S3.1 验证 pending→ready 和派发仅一次。全部使用 fake provider，不能视为 §18.3 真实冒烟已通过。详细使用与限制见 README 的 M3-S3 实施说明。

- `run start`（只支持 `decompose = provided`）、`status`、`wait`、`result`、`cancel`；`__run-supervise`。
- baseline gate；合并队列；post-merge gate；回滚；integration-fix 流水线。
- finalizing：`final_review = none | reviewer`。
- 不变量断言 I1–I7。

验收：
- AC-S3.1：fake 场景：两个独立任务在两个 lane 上时间重叠运行，按序合并，最终 `succeeded`。
- AC-S3.2：依赖任务的分支 base 包含其依赖的合并提交。
- AC-S3.3：合并后关口失败 → 集成分支回到 `pre_merge_sha` → integration-fix → 通过后集成；fix 用尽 → `needs_decision`。
- AC-S3.4：在合并进行中 cancel → 集成 worktree 回到 `verified_sha`，I1 成立。

### M3-S4 冲突、决策、预算与崩溃恢复

**实施状态（2026-10-26）：S4 实现已落地，包含 S3 评审 F13–F20；真实 provider 冒烟未执行。**

实现：`src/run/{conflicts,jobs,decisions,reconcile}.ts`、run supervisor/命令接线，M2 resume 提取为共享的预校验/应用逻辑；core Git 增加异步守卫、预检、worktree/快照操作；run 进程登记覆盖 Git/gate/setup，SIGKILL 后确认组退出。恢复顺序为 stop jobs → fail pipelines → restore integration/merge journal → snapshot+park lanes → assert invariants → decisions。merge 草稿使用 `<seq>.pending.json`，结束后才写最终记录；verified_sha 发布失败不得产生 integrated 记录。

崩溃边界补充：全局锁完整写好 PID 后排他原子发布，覆盖发布后立即 SIGKILL 的恢复测试；存量不可读锁仍不自动接管。若记录的集成写进程组未退出，不继续 reset，也不删除 Git 锁文件。

决策支持 S4 的任务透传、重试/重建、冲突额外尝试、额外修复、级联丢弃、预算扩展、崩溃恢复及已有最终评审的 accept_final。planner/计划评审、add_fix_task/final-fix、cleanup、land 均保留给 S5。§10.3 单项描述与 §12.2/本阶段批量要求不一致：按本轮明确要求支持 `--answers-file`（v1 对象数组、整体校验）；S1 attention 无 resolving 字段，采用 pending 输入防重，未新增契约状态。 §10.2 要求 drop 返回列表，但既有 run.v1 无该字段；本轮维持 resume 返回 run.v1，列表由 decision_resolved/run-result 提供。deadline 沿用 §7 的 failed/run_timeout，不将其解释为可无限续期预算。

测试证据：`test/m3-s4-run.test.ts`（AC-S4.1/2/3/5、决策透传/级联、预算、限流、verifier 与限额）；`test/m3-s4-recovery.test.ts`（AC-S4.4：真正 SIGKILL running、MERGE_HEAD 冲突现场、finalizing，status reconcile 后批量 resume）；`test/m3-s4-fixes.test.ts`（F14/F16–F20）；`test/m3-s3-run.test.ts`（F13、F20 双结局原意及 S3 回归）。全部加入默认测试入口。

最终验证（Node v24.15.0，2026-10-26）：`npm run build`、`npm test`、`npx --no-install tsc --noEmit`、`git diff --check` 全部通过；测试项目额外通过 `npx --no-install tsc -p tsconfig.test.json --noEmit`。默认套件 **750/750**（此前 723 + 新增 27），失败/取消/跳过均为 0，耗时 638.657 秒。新增测试还覆盖全局锁发布后立即 SIGKILL、集成写进程组未退出时拒绝 reset。此记录仅为 fake-provider 自动测试，不是 M3-R1–R8 真实冒烟。


- resolver 流程（§9.4）、遗留冲突标记检查、verifier、尝试次数与文件数上限。
- attention/决策/`run resume` 全部动作（§10），`decision_id` 过期检查，`--answers-file` 批量。
- `drop_task` 级联；预算与 `extend_budget`；限流冷却与自动重试一次。
- 崩溃识别与恢复（§12.2）、`resume_run`。

验收：
- AC-S4.1：强制冲突场景：resolver 成功 → 关口 → verifier approve → 集成。
- AC-S4.2：resolver 留下冲突标记 → 第二次尝试 → 仍失败 → `needs_decision`（`retry_resolve | rebuild_task | drop_task`）。
- AC-S4.3：过期 `decision_id` 被拒（`run_state_conflict`，`details.reason = stale_decision`）。
- AC-S4.4：kill supervisor → `status` 识别崩溃 → 恢复步骤完成 → `resume_run` 后 run `succeeded`。
- AC-S4.5：预算耗尽 → `needs_decision run_budget_exhausted`；`extend_budget` 后继续；第二次 `extend_budget` 被拒。

### M3-S5 Planner、计划评审、最终评审、cleanup、land

**实施状态（2026-10-26）：S5 代码与 fake-provider 验收已实现，同时修复 S4 评审 F21–F24；F25 记录如下。S6 与 M3-R1–R8 真实冒烟未执行。**

实现文件：`src/run/{planner,decisions,finalReview,cleanup,land}.ts`、`src/commands/run.ts` / CLI、core Git 守卫与 worker-result 解析；既有 scheduler、lane、pipeline、merge/gate 路径复用。

- Planner：run-owned read-only job 启用 `taskGraph` schema；草稿与逐次校验错误写 `plans/plan-<n>.json`。非法图自动重试一次，总 planner 尝试不超过 3；批准前没有任务执行。`approve_plan` 的替换图重新校验并冻结执行快照；`replan` 保留 note。planner 修改 worktree 时失败且保留现场。
- F21：移除 `action_deferred_to_s5` 路径；`approve_plan/replan/add_fix_task` 均有执行语义。final-fix 使用正常 lane → pipeline → merge → gate，再做全量最终评审；最多 2 个，且仍受 max_tasks 预算约束。耗尽重规划、任务重试、resolver、integration-fix、final-fix 次数的动作不再出现在新 attention 的 allowed_actions。若用户任务 ID 已占用下一 `final-fix-<k>`，不覆盖该任务、不提供 add_fix_task；接受最终评审或取消仍可用。
- F22：§6.8 新增 `verifier_started`，替代 verifier 启动时误发的 `gate_started`；测试断言 gate → verifier_started → verifier_finished 的事件顺序。
- F23：live supervisor 的回滚/取消收尾使用异步 `headAsync` 与 `parkAsync`，不在 publish/global lock 内同步读取 HEAD。
- F24：从最后一个完整且可校验的 worker-result JSON 围栏取结果；闭合围栏同一行或之后的额外文本写入 `worker_result_warnings`，不再误判未闭合。确实未闭合或没有任何有效结果仍失败。worker prompt 强调结果块必须是最终消息最后内容。旧“完整但无效的后续块禁止回退”测试按本轮新语义更新。
- Cleanup：只接受终态；干净 lane/integration worktree 删除，dirty 保留；含独有提交的任务分支（包括重建分支）保留；集成分支未 land 时保留。分支删除带 namespace、checkout 与 expected-tip CAS 守卫；force 不绕过 dirty/checkout。重复执行安全，pipeline 增加可选 cleanup 记录，证据目录保留。
- Land：显式批准缺失为 `user_approval_required` / exit 2；target 校验、dirty 拒绝、sync 预检/完整关口/失败复位、ff-only 或 CAS；审计写入可选 `run.land` 和已有 integration 字段。merge-record 增加可选 `kind: sync`。cleanup 后仍可从保留的集成分支重新挂载 worktree 进行同步。测试仅操作临时仓库。
- I6 的实施澄清：外部用户推进 target 不等于 gbdev 写 target。生产 supervisor/reconcile 不再将“target SHA 未变化”当作 I6；写操作仍由命名空间守卫隔离，唯一目标写入口是有批准检查的 land。可传 expected refs 的不变量测试辅助函数保留。

**F25 已知差异（contract v1 保持）：** attention 没有 `resolving` 字段；仍使用 `inputs/<timestamp>-<uuid>.json` 原子提交（支持整批输入）、pending decision_id 去重、消费后移除。未实现 §10.3 字面的 `inputs/<decision_id>.json` / resolving，不新增该状态。

契约补充：S1 的 run/merge-record 类型尚未包含 §13.2 所述 land/kind，M2 pipeline 类型也没有 §13.1 所述 cleanup；本阶段仅增加可选字段并同步 M3 JSON schema。`contract_version` 保持 "1"；M1 standalone 与 M2 change/report/verdict worker schema 逐字节兼容。

测试入口：`test/m3-s5-run.test.ts`、`test/m3-s5-lifecycle.test.ts` 已加入 `test/index.ts`；F22 加强 `test/m3-s4-run.test.ts`，F23 同时保留 F14 取消回归。AC-S5.1–AC-S5.4、S5 动作、上限、保留提交、dirty、sync 冲突/关口失败、CAS 竞争、幂等与解析容错均由 fake provider / 自建临时 Git 仓库验证。最终验证（Node v24.15.0，2026-10-26）：`npm run build`、`npm test`、`npx tsc --noEmit`、`git diff --check` 全部通过。默认入口 **780/780**（此前 750 + 新增 30），失败/取消/跳过均为 0，耗时 822.086 秒。全量测试在允许 `ps` 身份校验的环境中用 `caffeinate -i` 保持唤醒；此前受限沙箱/运行停顿的失败没有通过放宽安全检查或超时来绕过。既有 S3 planner 阶段拒绝断言改为支持 dry-run，reject 评审次数改为 2；S4 finalizing 恢复 fixture 现在配置并断言递增的 final_review#2；解析器后续完整无效块的行为按 F24 新语义更新。不以自动测试替代真实冒烟。


- planner 角色输出 task-graph（§5.3），`plan_invalid` 自动重试一次；`plan_review` 门（`approve_plan` 含编辑后的图、`replan` ≤ 3）。
- 最终评审与 final-fix 任务（≤ 2）。
- `run cleanup`（§13.1），`run land`（§13.2）。

验收：
- AC-S5.1：planner 输出带环的图 → `plan_invalid` → 重试 → 仍失败 → `needs_decision`。
- AC-S5.2：cleanup 保留含未合并提交的任务分支，删除已合并的；集成 worktree 被删除。
- AC-S5.3：land 缺 `--confirm-user-approved` → `user_approval_required`，exit 2，refs 不变。
- AC-S5.4：target 在 run 期间前进 → 同步合并 + 关口 → ff；target 被检出且 dirty → `land_refused`。

### M3-S6 文档、controller 用法、真实冒烟

**实施状态（2026-10-26）：S6 代码、文档与冒烟材料已就绪；真实 M3-R1–R8 待调度者执行。AC-S6.1 未验收，AC-S6.2 检查工具已有自动测试，真实 argv 检查未执行。本轮不启动真实 provider，不伪造任何冒烟结果。**

- F26：signalGroup 对 ESRCH/EPERM 尽力而为；groupAlive 在 EPERM 时用进程组全体成员状态排除已退出/zombie-only 组，仍有活跃后代或无法确认则保守保留。Git/setup 定时器信号发送 try/catch，异步终止 Promise 立即挂 rejection handler、由原调用者 await，防止提前未处理拒绝。回归覆盖负 pid EPERM、僵尸/退出/活跃后代及定时器异常。
- F27：dirty checked-out target 检查本来就在 dry-run 返回前，本轮追加一致性回归。同步真正的文本冲突才用 land_refused/sync_conflict；门禁失败仍为 land_refused/gate_failed_on_sync；保留原有 GbdevError，其他同步异常沿用 internal_error。§11.3 没有“集成树损坏/非关口同步运行时错误”专用 code，因此集成树不干净/HEAD 不匹配用 internal_error（details.reason=integration_corrupt），不伪报冲突。失败后仍回滚集成、保留目标。
- F28：approve_plan 编辑后的图以 run 状态、task-graph.json/plan 文件为准，request.json 保持原始规范化请求；测试锁定此行为。dead-supervisor cancel 的 restoreIntegration 改为异步 Git（含 headAsync、dirtyAsync、reset/clean），调用方 await。
- 文档：README 的 M3 操作入口；新建此前不存在的 docs/controller-recipe.md；docs/smoke-m3/r1-request.json–r8-request.json 和待执行手册。默认 base_ref=main，可由调度者按真实默认分支/夹具基线配置；R7 仅 smoke-land，不 push；Cursor 覆盖固定 auto。
- AC-S6.2：新增 scripts/check-smoke-argv.mjs / npm run check:smoke-argv，支持多个 job/run 目录；home 根目录须显式 --allow-home，仅读取 job/provider 记录，去重、逐条输出与汇总。现有 provider.json 原先没有 argv，因此 supervisor 在调用前保存实际 cmd/argv/cwd（保留旧字段）；不改变 M1/M2 schema。旧记录无 argv、零 Cursor 证据、格式错误/违规均非零退出，不倒推或回填证据。
- F29–F33 收尾：terminateGroup 首次信号异常显式转为 rejected promise，stop 回调立即处理拒绝、原调用者 await；land 非关口同步失败记录为现有枚举 aborted_crash（错误码仍 internal_error），关口失败仍为 rolled_back_gate_failed；§19 与配方统一 --request；argv 检查默认拒绝 bare home，显式 --allow-home 才扫描历史记录；restoreIntegration 注释明确仅供 CLI dead-supervisor cancel，live 走 restoreRunIntegration。contract_version 与 M1/M2 schema 不变。
- 自动测试入口：test/m3-s6.test.ts（请求纯 schema + 临时路径语义校验、F26–F33、临时 job 记录 argv 检查、Cursor 本地桩记录与实际 argv 对比）；test/m3-s5-run.test.ts 与 test/m3-s5-lifecycle.test.ts 加强编辑图/dirty dry-run 断言。所有测试只用 fake provider 或本地桩，临时目录自建自清。

open_questions / 规范澄清：§19、CLI 与配方统一使用 --request；§13.2 dry-run 文字只写步骤 1–2，但按 F27 同样检查 dirty target。docs/controller-recipe.md 原本不存在，本轮新建。调度者须确认真实仓库默认分支、ESM/测试布局与 npm test、R3/R4 已提交夹具、parallel/provider limits、R7 scratch tip 与明确用户批准。只通过自动测试不能宣称 AC-S6.1/真实 AC-S6.2 通过。


最终自动验证（Node v24.15.0，2026-10-26）：`npm run build`、`npm test`（以 `caffeinate -i` 保持唤醒）、`npx --no-install tsc --noEmit`、测试工程 noEmit 检查、`git diff --check` 均退出 0。完整默认套件 **807/807**（此前 780 + 新增 27），失败/取消/跳过均为 0，耗时 **876.852 秒**。全量在允许 `ps` 身份核验的环境运行；最初受限运行的失败不作通过证据。四个既有 provider 生命周期测试现严格比对新增调用记录与本地桩收到的实际 argv，未放宽安全检查。F26 对应的 provider cooldown、SIGKILL 恢复、dirty target dry-run、M1/M2 schema 字节兼容及 safety-argv 均通过。只读检查未发现本轮测试 run supervisor/fake worker 残留。以上仅为自动测试，不是任何真实冒烟结果。

F29–F33 收尾验证（Node v24.15.0，2026-10-27）：完整 `npm test` **814/814**（原有 807 + 新增 7），失败/取消/跳过均为 0，耗时 **813.032 秒**；`npm run build`、`npx --no-install tsc --noEmit`、测试工程 noEmit 与 `git diff --check` 通过。首次长时运行出现多项超时失败，且包含随后修正的 F32 测试夹具；以上为修正后完整复跑结果，未放宽既有断言或超时。新增 EIO 定时器、文档参数一致性、home 拒绝/显式 opt-in 回归，并加强 land 记录与 CLI cancel 断言。仅 fake provider/本地桩，真实冒烟仍待执行。

- README 增加 M3 章节；`docs/controller-recipe.md` 增加 run 用法（§19）。
- `docs/smoke-m3/`：R1–R8 的请求文件与结果记录。
- 在 `~/src/gbdev-smoke` 上执行真实冒烟（§18.3），把结果写入 `docs/smoke-m3/README.md`。

验收：
- AC-S6.1：R1–R8 全部执行；任何未覆盖项写明原因。
- AC-S6.2：所有冒烟中的 Cursor argv 都含 `--model auto`，都不含禁用标志（从 job 记录中自动检查）。

合入 master：S6 完成后由 controller 汇报，等用户明确同意再合并、再推送。

## 18. 测试

### 18.1 Fake provider 扩展

- `GBDEV_FAKE_PLAN` 的键扩展为 `<task_id>/<step>#<n>`，以及 `run:planner#<n>`、`run:resolver#<merge_seq>.<n>`、`run:verifier#<merge_seq>`、`run:final_review#<n>`。没有命中时用默认行为（成功）。
- 新动作：
  - `write_file {path, content}`、`append_line {path, line}`：制造可控改动（用于构造冲突和语义冲突）；
  - `emit_task_graph {graph}`：planner 输出；`emit_task_graph_cycle`；
  - `resolve_conflicts {strategy: "ours_then_theirs"}`：去掉标记并拼接两侧；`leave_markers`；
  - `rate_limit`：日志中写 `429 rate limit` 后失败；
  - `sleep_ms {ms}`：配合 `GBDEV_FAKE_DELAY_MS` 制造并发重叠。
- fake job 在 job 记录里写 `started_at`/`ended_at`，测试据此断言并发重叠或串行。

### 18.2 单元与集成测试清单（节选，S1–S5 中逐个实现）

1. 调度：依赖未集成不就绪；重叠 file_scope 串行；`overlap_policy = allow` 并行；亲和优先；provider 上限；冷却中不调度。
2. 合并：干净合并；merge-tree 报冲突 → resolver；合并后关口失败回滚；`pre_merge_sha` 正确。
3. 集成修复：先把 `verified_sha` 合入任务分支再修；修复次数上限。
4. 决策：每种 reason 的允许动作；过期 id；批量回答部分非法 → 全部拒绝（原子性）。
5. drop 级联：下游任务一并 dropped（`state_reason = dependency_dropped:<id>`），`dropped_tasks` 列表正确；已 integrated 的任务不能 drop。
6. 崩溃恢复：在 `running`、`merging`（MERGE_HEAD 存在）、`finalizing` 各杀一次 supervisor。
7. cleanup：dirty lane 保留；未合并分支保留；`--force-branch`；被检出分支不删。
8. land：缺标志；target 前进需同步；同步冲突；同步关口失败；CAS 失败；已 land 幂等。
9. 安全：`gitGuarded` 负例；Cursor argv；planner 引用不存在的 check id → `plan_invalid`。
10. 兼容：M2 单独流水线、M1 job 命令输出不变（快照对比）。

### 18.3 真实冒烟（`~/src/gbdev-smoke`，lanes = 2，max_workers = 2）

| 编号 | 场景 | 通过标准 |
|---|---|---|
| M3-R1 | 两个独立任务（provided） | 两个任务时间重叠；2 次合并；关口通过；`succeeded` |
| M3-R2 | 依赖链：t2 depends_on t1 | t2 分支 base 包含 t1 的合并提交 |
| M3-R3 | 强制冲突：两个任务改同一函数，`overlap_policy = allow` | resolver → 关口 → verifier → 集成；若没有自然产生冲突，记录为未覆盖并手工构造 |
| M3-R4 | 合并后语义失败：两个任务各自新增路由并各自把 `EXPECTED_ROUTES` 改成 2 | 第二次合并后关口失败 → 回滚 → integration-fix 改成 3 → 集成 |
| M3-R5 | planner 分解 + plan_review 编辑一个任务后 approve | 按编辑后的图执行 |
| M3-R6 | 运行中 cancel，然后 cleanup | 集成 worktree 被删；未合并任务分支保留；`git worktree list` 无残留 |
| M3-R7 | land 到 scratch 分支 `smoke-land`（不是 master） | 无标志 → `user_approval_required`；带标志 → ff 成功；不 push |
| M3-R8 | 运行中 kill supervisor | `needs_decision supervisor_crashed` → `resume_run` → `succeeded` |

每个冒烟记录：用时、job 数、合并次数、冲突次数、Cursor argv 检查结果。

## 19. controller 用法

1. `gbdev doctor --json`；失败则先汇报。
2. 组装 run-request：
   - 用户已列出 ≤ 3 个明确子任务 → `decompose = provided`；
   - 否则 `decompose = planner`；
   - `checks[]` 来自仓库已有命令（`npm test` 等），不臆造。
3. `gbdev run start --request … --json`，记下 `run_id`，告诉用户已开始（包括 lanes 数和预算）。
4. 跟进：
   - 对话中：`gbdev run wait <run_id> --until attention --timeout-ms 540000`；
   - 不在对话中：建一个每 10 分钟的 routine，每次执行 `run wait --until attention --timeout-ms 60000`，有决策或终态时唤醒 controller 处理；run 终态后删除 routine。
5. 处理决策（默认规则）：
   - `plan_review`：检查任务数、依赖、file_scope 是否合理；合理则 `approve_plan`，否则 `replan` 并写明原因；超过 §13.3 阈值先问用户。
   - `task_paused`：按 M2 规则处理（能从仓库回答的问题直接 `answer`；需要用户偏好的才问用户）。
   - `merge_conflict_unresolved`：先 `retry_resolve` 一次，再 `rebuild_task`；仍失败才问用户是否 `drop_task`。
   - `integration_gate_failed`：看失败摘要，`extra_fix` 一次，再 `rebuild_task`；仍失败问用户。
   - `task_failed` / `lane_broken`：`retry_task` 一次；第二次问用户。
   - `final_review_revise` / `final_review_rejected`：有 critical/major finding → `add_fix_task`；只剩 minor/nit → `accept_final` 并在汇报中列出。
   - `run_budget_exhausted`：第一次自行 `extend_budget`；之后问用户。
   - `supervisor_crashed`：`resume_run`，并在同一个 `--answers-file` 里对被中断的任务 `retry_task`。
6. 终态 `succeeded`：`gbdev run result <run_id> --json`，向用户汇报（任务、合并数、冲突与解决方式、残留 finding、被 drop 的任务、集成分支名与 sha），然后问：「是否把集成分支合入 master？」
7. 用户明确同意后：`gbdev run land <run_id> --target master --confirm-user-approved --approval-note "<用户原话>"`。push 需要用户另外同意。
8. `gbdev run cleanup <run_id>`；若有 `unmerged_*` 保留项，向用户说明，只有用户同意才 `--force-branch`。

审批次数估计（Mac 本地命令需要用户批准）：start 1 + 计划评审 1 + 每次唤醒 1（约 run 时长 / 10 分钟）+ land 1 + cleanup 1。

## 20. 向后兼容

- `contract_version` 仍为 `"1"`；所有新字段都是可选新增；新 schema 名使用新的 `gbdev.run-*.v1`。
- M1 `job *` 与 M2 `pipeline *` 命令、输出、退出码不变；顶层 `concurrency` 仍必须为 1（run 之间、run 与单独流水线之间互斥）。
- M2 预留的 `workspace.mode = "per_lane"` 与 `integration` 对象在 M3 中启用，但只能由 run 内部写入；用户经 `pipeline start` 提交 `run_binding` 或 `per_lane` 仍返回 `pipeline_invalid`（§6.5）。
- 不支持降级：回到 M2 二进制后，单独流水线与 job 照常可用，但 run 内流水线（含新字段）不保证能被 M2 读取；M2 也不认识 `runs/`。
- `~/.gbdev/` 目录布局只新增 `runs/` 与 `worktrees/<repo>/<run_id>/`，不迁移旧数据。

## 21. 风险与未决问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| Mac 睡眠 / 合盖 | supervisor 暂停，worker 超时被误判 | 心跳过期只告警不判崩溃；job 超时按单调时钟计算；controller 汇报时提示用户保持唤醒（`caffeinate` 由用户决定） |
| 配额与并行未知 | 3 个 Codex 并发可能触发限流 | provider 上限（codex 3 / cursor 2）+ 600 s 冷却 + 自动重试一次；冒烟中观测后调整默认值 |
| resolver 语义错误 | 冲突「解决」了但逻辑错 | 合并后关口 + verifier 只读审查 + scope 检查；仍可能漏掉测试未覆盖的问题 |
| lane 依赖与 `worktree_setup_cmd` | `node_modules` 等未安装导致关口失败；setup 命令本身是信任边界（不在 sandbox 内、可能联网） | 只来自 controller 写的请求、每个 worktree 只跑一次；controller 只用仓库已有的安装命令并在开始时告诉用户；worker 仍不允许安装 |
| file_scope 估计质量 | 估错导致不必要的串行或意外冲突 | 只是软约束；冲突有 resolver 兜底；scope_exceeded 记警告用于改进 planner |
| 关口耗时长 | 每次合并都跑全量测试，合并队列成瓶颈 | `integration_checks` 可配置；合并串行但 lane 继续跑；以后可考虑批量合并（M3 不做） |
| 测试不稳定（flaky） | 误回滚、浪费 fix 次数 | 失败的 check 自动重跑一次，两次都失败才算失败；记录 `flaky_suspected`（§9.3）；仍可能掩盖真实的间歇性 bug |
| 集成分支 reset 的安全性 | 误 reset 会丢已集成工作 | `gitGuarded` 只允许作用于本 run 的集成分支；只 reset 到记录过的 sha；每个 merge record 记 `pre_merge_sha` |
| 磁盘占用 | 每个 lane 一份 worktree + 依赖 | lane 数 ≤ 4；cleanup 删除干净 worktree；doctor 报告可用磁盘 < 5 GB 时告警 |
| Cursor 评审耗时（约 15 分钟/次） | 评审成为吞吐瓶颈 | cursor 上限 2 并发；评审与其他 lane 的实现重叠；verifier 默认用 Codex 只读 |
| 无常驻 leader 的响应延迟 | 决策最多等 10 分钟 | 决策只暂停相关任务，其他 lane 继续；在对话中使用长 `wait` |
| `--confirm-user-approved` 只是声明 | gbdev 无法验证真实同意 | 规则写在 controller 用法里；land 记录 `approval_note` 便于审计；从不 push |
