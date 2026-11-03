# gbdev detailed reference / 详细参考手册

gbdev 是供 controller 通过本机 shell 调用的本地任务编排工具。M1 提供 standalone job，M2 提供受监督流水线，M3 run 提供有界并行 lane、经批准的 planner 任务图、集成分支与合并后检查。它建立 Git worktree，监督 worker 超时/取消并收集证据；判断通过 attention 交给 controller，目标分支只由显式批准的 land 更新，**从不 push**。基础契约与边界见 [SPEC.md](specs/SPEC.md)，角色注册表与受监督流水线见 [SPEC-M2.md](specs/SPEC-M2.md)；本文与 SPEC 的 R7 Cursor stream-json、R6 cleanup/事件追加/只读交付/无输出看门狗修复及 R2 终态契约一致。

运行时零第三方依赖，使用 TypeScript 和 Node 内置模块。M2 同一时刻只允许一个活动 standalone job 或 pipeline run，不排队；暂停 run 不占槽。M2 用法与冒烟资料见 [S1–S6 手册与请求](smoke/README.md)。本文保留按阶段组织的协议细节；阶段名称不是发布验证结论。

## 安装与验证

要求：Node.js **24 或更新版本**、Git **2.38 或更新版本**。实际运行对应 provider 时，还需用户自行安装并登录 `codex` 或 `cursor-agent`。`tmux` 不是必需项；系统有 `caffeinate` 时，后台 supervisor 使用它防止空闲睡眠；不能防止合盖睡眠，唤醒时超出 deadline 会失败。

构建依赖为 `typescript`、`@types/node`；先运行 `npm ci --registry=https://registry.npmjs.org`。默认测试使用 fake provider，不调用真实模型。

```sh
npm run build
npm test
npm run typecheck
node dist/cli.js --help
```

构建输出在 `dist/`，入口有 Node shebang。无需全局安装，可始终使用 `node /绝对路径/gbdev/dist/cli.js ...`。用户也可以在构建后**自行决定**是否执行 `npm link`，使 `gbdev` 出现在 PATH；本实现不会替用户执行该操作。下文以 `gbdev` 简写此入口。

## 配置

默认读取 `~/.config/gbdev/config.json`；可用 `GBDEV_CONFIG` 指向其他 JSON 文件。示例：

```json
{
  "version": 1,
  "allowed_repos": ["/absolute/path/to/repo"],
  "providers": {
    "codex": { "bin": "codex" },
    "cursor": { "bin": "cursor-agent", "model": "auto" }
  },
  "default_timeout_min": 30,
  "default_stall_timeout_s": 600,
  "concurrency": 1,
  "pipeline_defaults": { "max_rounds": 2, "timeout_min": 240, "max_total_jobs": 12 }
}
```

- repo 必须是已有目录，且规范化后的路径与白名单某项**完全相等**；不是目录前缀授权。
- 配置文件缺失时配置合法，但白名单默认为空，拒绝启动所有 repo。
- provider 的 `bin` 可用绝对路径或 PATH 命令名，支持 `~/` 展开；启动时解析并在 job 的 `provider.json` 中固定可执行路径。
- `GBDEV_HOME` 覆盖默认的 `~/.gbdev`，所有 job 与 worktree 都放在该目录。
- 可选 `stall_timeout_s` 是非负安全整数秒数；未提供先取角色默认，再取 config.default_stall_timeout_s（默认 600），0 关闭看门狗。brief 显式值含 0 优先，start 固定到保存的 brief.json，后续配置变化不影响该 job；旧 brief 缺此字段则用 600。worker 的 stdout/raw 与 stderr（worker.log）在该时间内均无增长时，沿用 cancel 的进程组终止流程，failed/worker_stalled，warning 记录 retryable:true；只监测 worker 阶段，不影响检查命令。
- brief 中 `timeout_min`（1–240）可省略，先取角色默认，再取 config.default_timeout_min。
- Cursor **只能使用 auto 模型**：brief.model 只能是 `null` 或 `"auto"`，两者都固定传 `--model auto`；其他值在创建 job 前返回 `cursor_model_not_allowed`（退出码 2）。可选配置 `providers.cursor.model` 也只接受 `"auto"`（非法模型返回 `cursor_model_not_allowed`）。
- `network` 为 boolean，缺省 `true`，可显式设 `false`；reviewer 强制 `sandbox: "read-only"`。

隔离运行示例（先由调用者准备配置文件）：

```sh
GBDEV_CONFIG=/absolute/path/config.json GBDEV_HOME=/absolute/path/job-data gbdev doctor --json
```

这些环境变量应在同一组 start/status/wait/result/cancel/cleanup 调用中保持一致。

## 每 bot GBDEV_HOME 与启动器（M6）

每个 bot 使用独立的 `GBDEV_HOME`（默认 `~/.gbdev-<规范化 bot 名>`；旧绑定 my-bot 继续用 `~/.gbdev` 且 `legacy_default=true`，零写入该 home）。Step 0 第一步是 `gbdev init --bot <label> --json`：幂等创建 home、`home.json`、home 内 `config/config.json`（从全局 config **去掉 notify** 后播种一次，之后各 home 独立，修改 `allowed_repos` 需对每个 home 分别处理），并写出共享启动器与每 bot 启动器。

- **启动器不是二进制**：`~/.gbdev-cli/bin/gbdev` 是 `/bin/sh` 小脚本，固定 Node ≥ 24 绝对路径与仓库 `dist/cli.js`；每 bot 启动器 `gbdev-<label>` 会 `unset GBDEV_CONFIG`、`export GBDEV_HOME=<home>` 后 exec 共享启动器。可用 `GBDEV_CLI_HOME` 覆盖安装根（测试隔离）。
- **不修改 shell rc**：init/install 只返回 `path_hint`（`export PATH="$HOME/.gbdev-cli/bin:$PATH"`），由用户 决定是否加入 rc；bot 只转述，不改 `~/.zshrc` 等。
- 之后一切命令用 init 返回的 `command`（bot 启动器绝对路径）；启动器不在 PATH 时用绝对路径。`home_conflict` / `launcher_conflict` 停下报告，不自动删除或改名。
- 安装：`gbdev install [--dry-run] [--json]`；doctor 追加非阻塞的 `launcher` / `home` 检查。

## 角色与提示词目录（M6）

内置专家角色与公共提示片段的唯一真相在仓库 `roles/`（见 `roles/README.md`）。`npm run build` 先跑 `scripts/gen-roles.mjs` 生成入库的 `src/roles/catalog.generated.ts`，再 `tsc`；运行时不读 `roles/` 目录。

- **修改流程**：改 `roles/<name>/prompt.md` 或 `_shared/` → `npm run build`（或 `npm run gen:roles`）→ 用 `node scripts/gen-roles.mjs --check` 确认一致。
- **快照规则**：`test/fixtures/m6-prompts.snapshot.json` 在重构前捕获；相关测试对 `builtinRoles()` / `roles list|show` / 渲染矩阵做逐字比较。有意变更需在 pull request 中说明，并审查对应快照差异；不要为隐藏失败而更新快照。
- Cursor 角色模型只能是 `"auto"`；不改 `roles list/show` 输出结构。M6 阶段曾约束“不新增角色”；M7 起内置第七角色 `inspector`（只读 Cursor auto，供 `gbdev inspect`），见下方 M7 与 `roles/README.md`。
- **工程角色可配置，controller 固定**：Codex/Cursor worker 角色经内置 `roles/`、`dirname(config)/roles/<name>.json`、`step_overrides` 三层配置；保留标识 `grokbot` / `grok-bot` / `dispatcher` / `decider` 不可配置或派发，返回 `role_fixed`。工作流示例（planner/fixer/resolver → Codex gpt-6-astra high；executor/reviewer/verifier/inspector → Cursor auto）是配置覆盖，不是把内置默认全局改成 gpt-6-astra。

## 命令

所有公开命令支持 `--json`；不加时输出简短人类可读文本。

| 命令 | 示例 | 行为 |
| --- | --- | --- |
| roles list | `gbdev roles list --json` | 列出有效角色、无效文件与别名 |
| roles show | `gbdev roles show reviewer --json` | 展示完整角色及最终指令文本 |
| doctor | `gbdev doctor --json` | 报告 Node、Git、provider 路径/版本、登录检查、tmux、配置、roles 和数据目录可写性 |
| start | `gbdev start --brief brief.json --json` | 校验 brief，建分支/worktree，后台启动，立即返回 starting/running |
| start（stdin） | `gbdev start --brief - --json < brief.json` | 从 stdin 读一个完整 brief JSON |
| inspect | `gbdev inspect <run_id\|job_id> --question "…" [--task <task_id>] [--paths <rel>]... [--diff] [--tests] [--json]` | 只读取材：对固定已提交 SHA 派发独立 inspector job；读 `status`/`wait`/`result.inspection` |
| run list | `gbdev run list --active --json` | 只读盘点 run，不 reconcile |
| pipeline list | `gbdev pipeline list --active --standalone --json` | 只读盘点独立 pipeline；省略 standalone 包含 run 子流水线 |
| list | `gbdev list --active --json` | 只读盘点 job，默认隐藏已被接管的旧终态 job |
| status | `gbdev status --json` | 创建时间倒序列出最多 50 个 job，并对每个 job reconcile；文本默认隐藏 superseded，JSON 保持完整数组 |
| status（单个） | `gbdev status j_20261025_1131_a7f3 --json` | 返回该 job 状态，发现 supervisor 消失则记录 worker_crashed 并标记 failed |
| wait | `gbdev wait j_20261025_1131_a7f3 --timeout-ms 30000 --json` | 每 500ms 轮询；只等待，不启动或重启 job |
| result | `gbdev result j_20261025_1131_a7f3 --json` | 仅终态可用，返回 worker 自述与 gbdev 观察分离的汇总 |
| cancel | `gbdev cancel j_20261025_1131_a7f3 --json` | 请求取消，终止进程组；终态调用无副作用 |
| cleanup | `gbdev cleanup j_20261025_1131_a7f3 --json` | 终态且 worktree 干净才移除；无作业提交的分支删除，有作业提交的未合并分支默认保留 |
| cleanup（预演） | `gbdev cleanup j_20261025_1131_a7f3 --force-branch --dry-run --json` | 不改 job、worktree 或分支；返回 dry_run、would_remove_worktree、would_delete_branch、branch_retained，实际 removed/deleted 均为 false |
| cleanup（强制删分支） | `gbdev cleanup j_20261025_1131_a7f3 --force-branch --json` | 用户批准后才使用；允许删除未合并分支，仍不允许丢弃脏 worktree |

### 状态与退出码

常规生命周期是 `queued → starting → running → succeeded/failed/needs_input/blocked/cancelled/timeout`。`needs_input` 和 `blocked` 在 M1 也是终态；追问通过新 brief 的 `parent_job_id` 和 `answers` 开新 job，不续聊。`reviewed/integrated/discarded` 仅保留枚举，M1 不产生。

- 退出码 `0`：命令成功执行；**不表示 job 成功或质量合格**。`wait` 等到 failed job 也返回成功 envelope。
- 退出码 `1`：运行错误，例如 `busy`、`wait_timeout`、`job_not_terminal`、`cleanup_refused`。
- 退出码 `2`：`usage_error`、`config_invalid`、`role_invalid` 或 `cursor_model_not_allowed`。
- `wait_timeout` 仅表示本次等待到期，job 仍运行，可以继续 wait；job 自身到 deadline 才进入 `timeout`。
- provider/检查的进程组先 SIGTERM，10 秒后仍存活则 SIGKILL。

doctor 的诊断正常完成时返回退出码 0，调用者应逐项检查 `checks[].ok/detail`；缺失工具、登录状态未知、可选 tmux 缺失等通过检查项表示，不据此直接判定所有 provider 不可用。配置错误也在 doctor 的检查项报告，start 则仍以配置错误退出。

### result 与 cleanup

worker 退出后，gbdev 同时接受**整条消息为 JSON 对象**和**最后一个 json 围栏块**，不回退到更早的有效块。工作区可写且有未提交修改时由 gbdev 自动生成 `gbdev: snapshot <job_id>` 提交，这是 executor 产出提交的正式路径；worker 不负责 git add/commit。gbdev 的所有 Git 调用统一走带 `-c core.hooksPath=/dev/null` 的辅助函数，包括 snapshot 的 `git add -A` 和 commit、worktree/ref 操作、隐式 index 刷新；commit 另带 `--no-verify`，禁用 pre/post-commit、post-index-change 等 hooks，不改仓库配置。worker 若已自行提交则照常记录，剩余脏树仍 snapshot；只读任务不会补提交，修改会导致 readonly_modified。随后收集提交、文件、diff、越界路径和只读违规，并顺序执行 brief 中的检查命令（单条最多 10 分钟）。

`check_cmd` 是 brief 作者提供的可信 shell 命令，唯一使用 `/bin/sh -c` 的执行路径；Git 和 provider 均直接传 argv 数组。检查输出写日志，不混入 CLI stdout/stderr。

R2 状态规则（从高到低，与 SPEC §8.7 一致）：

1. forced（timeout / cancelled / worker_stalled / supervisor 强制 failed）优先；worker_stalled 为 failed，failure_reason 同名，可重试，后到取消不覆盖。
2. worker 自报 needs_input/blocked 原样透传，即使 provider 失败、退出码非 0、违规或检查失败；观察事实和 checks 仍记录，让调度者决定下一步。
3. 其余按顺序取首个失败原因：provider 明确失败 → `worker_exit_nonzero:<code>`（含 null）→ worker-result 缺失/非法 → gbdev 观察违规 → worker 自报 policy_violations → worker 自报 failed。
4. 任一验收检查非零（含 null）则 failed，`failure_reason: "check_failed:<id>"`，取首个失败检查。
5. 否则 succeeded。

只读交付例外：sandbox=read-only、exit 0、final.md 非空（去除空白后）、缺失而非非法 worker-result、provider 未明确失败、无违规、无文件改动（HEAD 不变且工作树干净）、所有 checks 通过时为 succeeded，worker_reported=null、failure_reason=null，worker_result_warnings 加 "worker_result_missing"，保留 result_missing warning 事件。final.md 就是交付物；workspace-write 缺 JSON 仍 failed/worker_result_missing。只读 prompt 仍额外强调即使只是审查，最后一段必须是该 json 块（output schema 时纯 JSON）。

`result.worker_result_warnings: string[]` 记录所有容错转换：commits 的 `{hash,message}` 对象变成短 hash + message 字符串；tests 的 command/check 变成 cmd，status passed/failed 变成 passed 布尔值（缺失 exit_code 时由 status 推导）；evidence 的 type/command/output/detail 映射为标准字段，无 criterion_id 时标为 unspecified；缺失数组补 []，未知字段忽略。原始输出仍保留，worker_reported 是归一化后的报告。标准 tests.passed 的数字计数保持不变，也接受布尔值。

所有新产生的 failed/timeout/blocked 状态在 **status 和 result** 都有非空 `failure_reason`：`worker_result_missing`、`worker_result_invalid: <字段错误>`、`check_failed:AC1`、`provider_trust_required`、`provider_error: <subtype>`、`worker_exit_nonzero:<code>`、worker_reported_failed、policy_violations、worker_blocked、timeout、worker_stalled（可重试）或异常恢复原因。成功/取消/needs_input 时为 null；人类可读输出也显示失败原因。旧版 v1 文件缺少新增字段时，读取时补空 warnings，历史 failed/blocked 的未知原因标为 `legacy_failure_reason_missing`（timeout 仍为 timeout）；不重判历史状态、不改写原始文件。

`failure_reasons: string[]` 在新 status/result 中同步保存 §8.7 所有命中的 3x/4 原因（按表顺序，检查按执行顺序），即使 forced、needs_input、blocked 优先也保留观察事实；succeeded 时为 []。主因 `failure_reason` 保持原优先级，只有只读特例改变：缺报告但不是 invalid、其他 3x 均不命中且检查失败时，主因是首个 `check_failed:<id>`，warnings 加 `worker_result_missing`，完整数组仍包含 `["worker_result_missing", "check_failed:<id>"]`。旧 job/result 缺少数组时仅在读取补值：failed 为 `[failure_reason]`，其他状态为 []，不改写文件。

job-status/job.json 的 `pipeline_id`、`step_instance`（string|null）与 `attempt`（正整数|null）关联流水线 step。standalone 新 job 三者恒 null，旧文件读取补 null，不改写；M2-S3 已实现共享 worktree 的线性流水线。

cleanup 按 SPEC §4.7/§7 执行：脏 worktree 返回 `cleanup_refused`，即使 `--force-branch` 也不删除；干净 worktree 用不带 force 的 `git worktree remove`。分支策略不依赖 brief.base_ref 当前值：

- 决定 deleteBranch 前，所有路径（含 force 和 dry-run）统一运行 `git worktree list --porcelain -z`。主仓库或任何 worktree 仍检出该分支就保留，仅排除本次即将移除的作业 worktree：ok:true、branch_retained:true、branch_retained_reason:"checked_out"，本次已移除作业 worktree 时 worktree_removed:true；dry-run 同样 would_delete_branch:false。

- 移除作业 worktree 后、实际 update-ref 删除前，再次列出全部 worktree；此时任何检出均保留分支，返回 checked_out。旧值校验仍在；二次检查不是与外部 Git checkout 的原子事务，仍有很小的竞态窗口。
- tip 等于 job.base_sha（没有作业提交）：即使 base 已不被其他分支包含，也用 `git update-ref -d refs/heads/<branch> <base_sha>` 删除，带旧值校验，避免并发移动时误删。
- 有作业提交且已被其他本地分支包含：用 `git update-ref -d refs/heads/<branch> <tip>` 旧值校验删除，不受 `git branch -d` 的 HEAD/upstream 判定影响，不修改仓库配置。
- 有作业提交且未合并到任何其他本地分支：默认保留，返回 ok:true、branch_retained:true；显式 `--force-branch` 才用 `git update-ref -d refs/heads/<branch> <tip>` 旧值校验删除。

`branch_retained_reason` 为 `checked_out | unmerged_job_commits | delete_failed_retry_safe | null`；未保留为 null，未合并作业提交默认保留为 unmerged_job_commits。ref 删除失败仍是原来的 internal_error envelope，在 error.details 中补 branch_retained:true、branch_retained_reason:delete_failed_retry_safe。文本输出追加 `branch kept: <reason>`，未合并时另提示 `use --force-branch only with user approval`（dry-run 同样说明原因）；旧 JSON 示例省略字段仍有效。

`cleanup_refused` 只用于脏树或 Git 拒绝删除 worktree。若 worktree 已删除而后续分支步骤失败，错误为 `internal_error`，且 `details.worktree_removed:true` 明确部分进展；删除前失败为 false。ref 锁或旧值不符等删除失败时还带 details.retry_safe:true（internal_error.retryable 仍为 false），分支保留，可重新检查后重试。job 目录永久保留；移除 worktree 后仍可 result。重复 cleanup 安全返回已不存在的事实。`--dry-run` 使用同样的终态、脏工作区和分支策略检查，但不触发状态修复、不执行删除，支持与 `--force-branch` 组合；若脏或非终态仍报错。预演的 `would_delete_branch` 与实际策略一致（不保证执行时没有并发变化、Git 锁等错误）；`branch_retained = branchExists && !deleteBranch` 表示计划执行后是否保留分支，不受本次实际未删除的影响。

## 只读盘点与状态恢复

列出/盘点用 `gbdev run list`、`gbdev pipeline list`、`gbdev list`，需要未结束项加 `--active`（run/pipeline 包含待决策状态；job 的 needs_input 已是终态）。三者支持 `--state <s>`（重复或逗号分隔，按各类型合法状态校验）、`--limit <1..500>`（默认 20）及 `--json`；过滤先于 limit，按 created_at 的真实时刻倒序，相同时刻按 ID 倒序。非法 state/limit 返回 usage_error。

列表不加写锁、不建目录、不写状态/events、不触发 dashboard/notify；损坏或并发读取失败的记录计入 skipped。非终态的已记录进程消失只显示 stale，并提示对具体 ID 执行 status 来 reconcile。无效时间排序放末尾并按字符串稳定比较；ID 格式不变。列表是尽力读取的快照，不保证跨记录事务一致。

JSON 使用全局信封，result_schema 分别为 `gbdev.run-list.v1`、`gbdev.pipeline-runs.v1`、`gbdev.job-list.v1`，不与 templates 的 `gbdev.pipeline-list.v1` 混用。result 含 items（紧凑摘要）、total（有效快照数）、matched（过滤及隐藏后数）、shown、skipped、hidden_superseded（过滤范围内被隐藏数）、limit、warnings。摘要含 state_reason（最多 160 字符）、时间、关联 ID、attention_count/decision_count 和 stale；run 的 lanes/tasks 为计数，pipeline 的 current_step 为当前 instance，job 另含 superseded_by（字符串或 null）。run 的 decision_count 是 attention 中不同决策数；pipeline 为当前 decision 的 0/1；job 不存决策，计为 0，needs_input/blocked 的 attention_count 为 1。

job 的 needs_input/blocked/failed/timeout/cancelled 在同 pipeline、同 step instance 有更新 attempt，或父 pipeline/所属 run 已终态（即使 pipeline 仍非终态，只要所属 run 已终态也成立）时，派生为 superseded，绝不改写历史事实；成功类记录不隐藏。默认隐藏，`gbdev list --all` 显示并标注接管者（仍受 limit 约束）。`gbdev status --all` 仅用于无 ID 的文本列表，不能与 `--json` 同用，也不能带 ID；JSON 盘点请用 `gbdev list --all --json`。不带 `--all` 的 status JSON 数组和单 ID 行为不变。父记录缺失/损坏本身不作为终态证据；attempts 条目损坏只跳过后续 attempt 判定，仍可依据父终态判定。

既有 `gbdev run status`、`gbdev pipeline status`、`gbdev status`（有无 ID 均如此）会 reconcile，可能写状态；需要核实和恢复具体单元时使用。盘点仅当前 bot 的 home，不做跨 home 汇总。

## Handoff 与输出契约（M2-S2/S3）

- worker-result 可选 `handoff`：`decided/rejected/risks/remaining` 四个必填字符串数组；可选 `review`：`verdict` 与 `findings`。finding 必须含唯一且匹配 `^F[0-9]{1,3}$` 的 id、severity、file、line、message、suggestion；file/suggestion 可为 null，line 为正整数或 null，message 非空。
- verdict 大小写不敏感，`APPROVE/ITERATE/REJECT` → `approve/revise/reject`；severity 的 `high/low/medium/info` → `major/minor/minor/nit`；缺失 finding id 按位置补 `F1..`。每次转换记录 `worker_result_warnings`；其他非法值在收尾产生 `worker_result_invalid: ...`。M1 缺少这两个字段仍合法。
- `buildWorkerResultSchema({ pipelineStep, output })` 仅在显式 pipelineStep 时增加 handoff，verdict 再增加 review；所有对象 closed、全部字段 required。默认与所有 standalone 角色保持 M1 schema 字节不变。
- `generateHandoff(result, context)` 是纯函数，`writeHandoff(directory, handoff)` 原子写入 `NN-instance.json`（如 `03-review-2.json`）。文件/提交/HEAD/checks 只来自 gbdev_observed；summary 与交接数组按 300 字符/10 条截断，findings 按 50 条/message 500 字符截断并标记 truncated。verdict 角色 approve 带 critical/major 时仅在交接表示中转 revise，记录 normalized_from 与 verdict_inconsistent；不改写 job 结果、不执行 gate。
- `renderStepPrompt(brief, context)` 与 `renderPriorSteps(handoffs)` 是库函数，不读写 pipeline 状态。复用 M1 固定边界；只读任务去掉 check_cmd；前序 worker 文本和检查日志尾放入数据围栏并转义伪造标记。所有 handoff（包括最近一条）遵守下面的 12,000 字符硬预算；更早交接优先压缩为摘要或省略。
- **硬预算**：Prior steps 渲染长度始终 ≤ 12,000 字符，包含围栏、说明、转义与省略标记。最近一条全量仍超限时，改为有界摘要（instance、summary、各类计数、verdict），附 handoff 文件路径，不截断 JSON。路径提示最多 1,024 字符，完整路径仍在 pipeline.json 的 steps[].handoff 中。
- S3 截断修正：tests 最多 10 条、cmd 最多 300 字符；findings 先按 critical/major/minor/nit 稳定排序，再取 50 条，message/suggestion 最多 500 字符、file 最多 300 字符，超出标记 truncated。severity 先转小写再查别名，High/INFO/Major 均归一化并记录 warning。finding.message 必须 trim 后非空，pipeline schema 使用 pattern `\S`，standalone schema 字节不变。

## 受监督流水线（M2-S3/S4/S5）

一个 run 一棵 worktree/分支，各 step 顺序运行，review/report 只读。每步 base_sha 是该步开始时 HEAD；审查 prompt 的 diff 范围从 run.diff_base_sha 到 HEAD。沿用 M1 收尾与 snapshot，不自动合并或回滚。

```sh
gbdev pipeline templates --json
gbdev pipeline start --request request.json --dry-run --json
gbdev pipeline start --request request.json --json
gbdev pipeline list --active --json
gbdev pipeline status p_20261026_1011_9c2e --json
gbdev pipeline wait p_20261026_1011_9c2e --timeout-ms 540000 --with-result --json
gbdev pipeline result p_20261026_1011_9c2e --json
gbdev pipeline resume p_20261026_1011_9c2e --input resume.json --json
gbdev pipeline cancel p_20261026_1011_9c2e --json
gbdev pipeline cleanup p_20261026_1011_9c2e --dry-run --json
gbdev pipeline cleanup p_20261026_1011_9c2e --json
```

最小请求示例（repo 须在配置白名单）：

```json
{
  "schema": "gbdev.pipeline-request.v1",
  "request_id": "pr_example",
  "pipeline": "implement-review",
  "repo": "/absolute/path/to/repo",
  "base_ref": "HEAD",
  "diff_base_ref": null,
  "goal": "增加版本字段并独立审查",
  "context": "",
  "constraints": ["不添加依赖"],
  "allowed_paths": ["src/**", "test/**"],
  "acceptance_criteria": [{"id": "AC1", "text": "测试通过", "check_cmd": "npm test"}],
  "required_evidence": ["tests"],
  "step_overrides": { "review": { "provider": "cursor", "cursor_model": "auto", "timeout_min": 40 } },
  "max_rounds": 2,
  "timeout_min": 240,
  "max_total_jobs": 12,
  "network": true
}
```

### 模板文件 gbdev.pipeline.v1

下面可保存为 `dirname(GBDEV_CONFIG)/pipelines/implement-review.json`；同名模板**整体替换**，不会继承省略字段（与角色浅合并不同）。内联对象也用同一格式；模板中 step 只接受 id/role，provider 等路由值在请求的 step_overrides 中设置。

```json
{
  "schema": "gbdev.pipeline.v1",
  "name": "implement-review",
  "description": "实现、独立审查、按 findings 修复并复审",
  "steps": [
    { "id": "implement", "role": "executor" },
    { "id": "review", "role": "reviewer" }
  ],
  "fix_loop": { "after": "review", "fix_role": "fixer", "max_rounds": 2 },
  "timeout_min": 240
}
```

| 内置模板 | 顺序步骤（id: role） | 修复回路 |
|---|---|---|
| implement-review | implement: executor → review: reviewer | review 后 fixer，默认 2 轮 |
| plan-implement-review | plan: planner → implement: executor → review: reviewer | review 后 fixer，默认 2 轮 |
| review-only | review: reviewer | 无 |
| implement-verify | implement: executor → verify: verifier | verify 后 fixer，默认 2 轮 |

模板名匹配 `^[a-z][a-z0-9-]{1,31}$`；steps 为 1–6 个，id 唯一且匹配 `^[a-z][a-z0-9-]{0,23}$`；role 必须有效。第一个 change 之前不能放 verdict，纯只读流水线例外。fix_loop 可省略（不要写 null），after 必须指向 verdict step，fix_role 必须为 change，max_rounds 为 0–5；timeout_min 为 30–480。未知字段 fail closed；文件名必须等于 name.json；非法覆盖不会回退内置。模板 JSON 限 64 KiB，拒绝符号链接和非普通文件。

### 请求字段与运行规则

pipeline-request 的 pipeline 可为模板名或完整内联模板。repo 须在白名单，base_ref 为创建 worktree 的提交/分支；diff_base_ref 为审查范围基准，null 取 base_sha，review-only 必须给显式基准。请求必须明确 pipeline；不存在省略 pipeline 自动选模板的行为。

请求的 max_rounds（0–5）优先于模板 fix_loop.max_rounds，再取 config.pipeline_defaults.max_rounds（默认 2）；timeout_min（30–480）优先于模板，再取配置默认 240；max_total_jobs（1–20）优先于配置默认 12。各 step 的 timeout_min（1–240）/stall_timeout_s 是独立预算，可在 step_overrides 指定；fix 回路用键 fix。上下文/约束/证据和验收标准随请求传入；只读步骤只保留验收标准 id/text，不执行 check_cmd。

- 内置模板：implement-review、plan-implement-review、review-only、implement-verify。review-only 必须给 diff_base_ref，例如 main。用户模板放在 dirname(GBDEV_CONFIG)/pipelines/*.json，同名整体替换，不浅合并，无效项在 templates.invalid 中显示。
- 支持内联 gbdev.pipeline.v1。step_overrides 仅允许 provider/codex_model/cursor_model/timeout_min/stall_timeout_s，不允许覆盖 role/output/sandbox；Cursor 恒为 auto。启动时冻结 provider 路径、角色指令及 SHA-256，后续不读取角色配置。包括配置的 fix 角色在内，所有 provider 都在创建 run 前检查可执行性，没有 provider 回退。
- dry-run 校验、preflight、busy 检查后返回 queued、pipeline_id=p_dry_run、dry_run=true；不 reconcile、不取锁写盘、不建目录/worktree。正式启动遇到主仓库脏树记录 repo_dirty_changes_not_included，该改动不进入 run。
- 活动 run 与 standalone job 共用唯一槽位；busy.details 带 running_pipeline_id / running_job_id。needs_input、blocked、needs_decision 为稳定暂停态，不占槽。wait 超时返回 wait_timeout，details.pipeline 带进度；--with-result 在稳定时返回 gbdev.pipeline-result.v1。
- supervisor 每 30 秒心跳；status/wait/result/cancel 检测失活后清理 worker/check 进程组，再标 failed/pipeline_supervisor_crashed，不自动重试。取消保留证据，未开始 step 置 skipped。
- cleanup 仅接受 succeeded/failed/cancelled，暂停态须先 cancel。清理沿用 M1 脏树保护、二次检出检查、旧 tip 校验与未合并分支保留策略。对 step 使用普通 cleanup 返回 job_owned_by_pipeline。仅在用户明确同意丢弃分支时使用 --force-branch。
- **S4 修复与预算**：revise 或 change 检查失败自动插入 fix + 复审（检查失败合成 C1… findings，并附日志最后 80 行）；approve 带 critical/major 按 revise 处理。默认最多 2 轮，extra_round 每次加 1，绝对上限 5。相邻同 step 阻塞 findings 指纹相同 → findings_repeated；fix 无 HEAD 变化 → fix_no_changes。缺失/非法 verdict 自动重试一次，再缺失 → verdict_missing；reject → review_rejected。
- 每次创建 job 前执行 max_total_jobs（默认 12，上限 20），耗尽 → needs_decision/job_budget_exhausted，只能 accept 或 cancel。timeout_min（默认 240，30–480）从 run 创建时计时，暂停/resume 不重置；超时 → failed/pipeline_timeout，同时终止当前 worker/check 进程组。测试可用 GBDEV_TIMEOUT_SCALE 指定每分钟毫秒数，生产默认 60,000。
- 稳定态发布前先原子写 result.json 与 diff.patch；历史稳定 run 缺 result 时，result / wait --with-result 会在锁内重建。空目录或坏 pipeline.json 不阻断其他 run 的扫描。pipeline cleanup（含 dry-run）先 reconcile；dry-run 只报告将删除什么，不实际删除 worktree/分支（与 standalone cleanup 的不 reconcile 行为不同）。
- caffeinate 只防空闲睡眠，不能防合盖；唤醒时 deadline 已过会 pipeline_timeout；真实 provider 冒烟由调度者执行，本轮测试只使用 fake。

### fake provider 计划文件（仅测试）

保存为 plan.json：

```json
{
  "implement#1": "dirty_exit",
  "review#1": "review_revise",
  "fix#1": "fix_ok",
  "review#2": "review_approve"
}
```

准备 request-fake.json，将请求中 implement/review/fix 的 provider **都**覆盖为 fake；plan-implement-review 还要覆盖 plan，implement-verify 改为 verify。仅设计划文件不会把真实 provider 切换为 fake。

```sh
GBDEV_FAKE_PLAN=/absolute/path/plan.json gbdev pipeline start --request request-fake.json --json
gbdev pipeline wait <id> --timeout-ms 30000 --with-result --json
```

GBDEV_FAKE_PLAN 为场景名映射，按 step_instance（如 review#2）选择；无匹配回退 GBDEV_FAKE_SCENARIO，再回退 ok。GBDEV_STEP_INSTANCE 仅传给 fake worker。attempt 重试仍使用同一 instance/key；要模拟回答后成功，可更新计划文件，再以相同 GBDEV_FAKE_PLAN 环境调用 resume。启动/恢复 supervisor 会继承对应环境。计划文件不是冻结的角色快照。

| 场景 | 行为 |
|---|---|
| ok / dirty_exit | 写 src/ok.txt 并提交 / 写 src/dirty.txt 留给 snapshot |
| plan_ok | 只读计划，handoff.remaining 有步骤 |
| review_approve / review_reject | approve（空 findings）/ reject |
| review_revise / review_revise_same | 固定 F1 major，用于修复和重复停滞 |
| review_revise_changing | 按实例改变 findings，用于轮次耗尽 |
| review_approve_with_critical | approve + critical，触发规范化 revise |
| review_no_verdict / review_bad_verdict | 缺 verdict / 非法 verdict，测试自动重试 |
| fix_ok / fix_noop | 修改 src/fix.txt（并修复 check-fail 标记）/ 无改动 |
| check_fail_then_fix | 写 src/check-fail.txt，由 check_cmd 判失败 |
| needs_input / blocked / crash / slow | 提问 / 环境阻塞 / 退出 23 / 长运行及子进程 |
| no_json / outside_paths / readonly_violation | 无结构化报告 / 越界修改 / 只读违规 |

不要给只读步骤使用会写文件的 ok 回退；显式设置 plan_ok 或 review_*。未知场景、非法计划文件返回 config_invalid。GBDEV_TIMEOUT_SCALE 将每分钟换成指定毫秒（默认 60000），只用于测试；生产与真实冒烟不要设置这些测试开关。

### 暂停后继续（resume）

```json
{
  "schema": "gbdev.pipeline-resume.v1",
  "pipeline_id": "p_20261026_1011_9c2e",
  "action": "answer",
  "answers": [{"question_id": "Q1", "answer": "选择 B"}],
  "note": null
}
```

保存为 resume.json 后运行上面的 resume 命令，或用 `--input -` 从 stdin 读入。retry / extra_round / accept 的 answers 使用 `[]`，可附最多 2,000 字符 note。answer 必须覆盖所有 blocking 问题且不能回答未知 id，否则 config_invalid；pipeline_id 必须与命令参数一致。answer/retry 在同一实例追加新 job，parent_job_id 指向上次 attempt；最多 3 次（含首次与自动 verdict 重试），第 4 次返回 pipeline_state_conflict，details.reason=attempts_exhausted。

每次 `answer` 将 `{instance, attempt, question_id, question, answer, at}` 追加到 run 级 `decisions`（attempt 指提出问题的那次，question 取自 pending_questions），随恢复状态原子写入 pipeline.json，并逐条记录 `decider_decision` 事件；status/result JSON 暴露完整历史，旧文件缺字段时只在读取结果补 `[]`，不因读取改写文件。此后所有 step（含重试、fix/review 后续轮、verify/report）的 prompt 都包含“调度者已作出的决定”：审查以 controller 的权威回答为准，不能因本 step 的 brief.answers 为空认定未回答。决定数据复用转义的数据围栏，最多渲染最近 20 条、每条 question/answer 各截断至 500 字符，超限标 `truncated`；只限制 prompt，不截断持久化记录，独立于 Prior steps 的 12,000 字符预算。brief.answers 仍只包含本 attempt 的直接回答，M1 standalone brief、prompt 和 schema 不变。

| 暂停状态 / reason | resume action |
|---|---|
| needs_input | answer |
| blocked | retry |
| max_rounds_exceeded / findings_repeated / review_rejected | extra_round、accept |
| fix_no_changes | retry、accept |
| verdict_missing | 见 [M7 接受规则](#verdict_missing-接受规则)：先 retry 审查 → 再 `gbdev inspect` → 证据充分才 accept，必须带 `verdict_missing_reviewed: true` + 非空 note；`retry` ≠ `retry_task` |
| step_failed / step_cancelled | retry |
| job_budget_exhausted | accept |

所有暂停态均可 cancel。表中 extra_round 仅在模板已有 fix_loop 且 max_rounds < 5 时出现在 decision.allowed_actions；review-only 的非空 revise 会暂停为 max_rounds_exceeded，仅提供 accept。越权动作返回 pipeline_state_conflict；会启动 worker 的 resume 必须等待唯一执行槽空闲，否则 busy。accept 不启动 worker，直接 succeeded/accepted_by_decider，note 和 grok-bot 记入 state_history；最后审查的全部 open_findings 保留，必须如实告知用户，不等同于 reviewer approve。

S4 测试：s4-pipeline.test.ts 覆盖 AC-S4.1–S4.7 与恢复/预算边界；s4-gate.test.ts 覆盖纯规则与指纹；s3-pipeline.test.ts / s3-contracts.test.ts 保留 S3 回归并更新阶段边界断言；s2-supervise.test.ts 验证连续 12 个 job 的监听器数不增长。S5 已补齐格式、命令 JSON 示例、controller 配方及冒烟请求；真实 provider 冒烟结果仍由调度者补记。

`superviseJob(jobId, store?, signal?)` 位于 src/core/supervise.ts；pipeline 可传入总预算取消信号，standalone 调用仍走原 M1 流程。每步结束（包括失败/提前返回）移除本次 SIGTERM/SIGINT 监听器。

## 角色注册表（M2-S1）

S3 修正：角色 JSON 读取前用同一描述符的 fstat.size 拒绝超过 64 KiB 的文件（role_invalid），非普通文件与符号链接使用准确的诊断；非 null 的 codex_model 按 trim 后保存。

```sh
node dist/cli.js roles list --json
node dist/cli.js roles show reviewer --json
node dist/cli.js roles show code-reviewer
```

内置角色：planner（report/read-only，Codex，20 分钟/600 秒）、executor（change/workspace-write，Codex，45/600）、fixer（change/workspace-write，Codex，30/600）、reviewer（verdict/read-only，Cursor，40/900）、verifier（verdict/read-only，Codex，30/600）。以上五个角色均允许 codex/cursor/fake，Cursor 永远只用 auto。M3-S1 另加 resolver（change/workspace-write，Codex，30/600），只允许 codex/fake，不允许 Cursor。M7 另加 inspector（report/read-only，Cursor auto，10 分钟/120 秒 stall；`allowed_providers` 为 cursor/fake），仅供 `gbdev inspect`；用户覆盖只能改 description/instructions/timeouts，不能放宽为 write/change/verdict 或 Codex。

保留控制角色标识（不可配置、不可派发）：`grokbot`、`grok-bot`、`dispatcher`、`decider`；企图配置或 `roles show dispatcher` 返回 `role_fixed`（退出码 2）。`bot_label` 如 `example-dev` 不在此列。

用户角色位于 `dirname(GBDEV_CONFIG)/roles/*.json`（默认 `~/.config/gbdev/roles`），文件名必须为 `<name>.json`。同名内置角色按字段浅合并，数组整体替换；覆盖文件必须显式包含 `schema: "gbdev.role.v1"` 和 `name`；新角色必须提供完整字段。字段与限制见 SPEC-M2 §4.1。未知字段、不匹配的 output/sandbox、非法模型均拒绝；invalid 覆盖不会回退内置，其他角色仍可用。非 JSON 文件及子目录忽略。角色 JSON 以 `O_NOFOLLOW` 打开并在同一文件描述符上检查和读取，拒绝符号链接。`codex_model` 只能为非空（trim 后）字符串或 null；null 不传 `-m`。`code-reviewer` 是保留别名，不能定义同名用户角色文件；别名始终指向内置或有效覆盖后的 reviewer。工作流若把 planner/fixer/resolver 覆为 Codex gpt-6-astra，那是用户/请求覆盖，不是把内置默认全局迁移。

可选 `instructions_file` 为同目录小写 `.md` 文件名，禁止路径穿越、符号链接，要求 UTF-8 且至多 32 KiB；文件内容附加到 instructions 后。Role 小节在固定 Worker boundaries 之前，启动时生成的 prompt 固定指令，不随配置更改而变化。standalone worker-result schema 仍与 M1 逐字节一致；运行时已支持可选 handoff/review 的校验与归一化（见上方 M2-S2 契约库）。

`roles list` 的 result_schema 为 `gbdev.role-list.v1`，包含 `roles` 摘要、`invalid`（file/name/code/message）、`aliases`，有无效文件仍 ok:true、退出 0。`roles show <name>` 返回 `gbdev.role.v1` 完整合并结果及 source（builtin/builtin+user/user）、instructions_text。不存在返回 role_not_found（退出 1）；非法角色返回 role_invalid（退出 2），Cursor 非 auto 模型返回 cursor_model_not_allowed（退出 2）。doctor 的 roles 检查会列出无效文件与错误摘要。

### 角色文件 gbdev.role.v1

新角色完整示例，保存为 `roles/auditor.json`（目录相对配置文件，而非当前工作目录）：

```json
{
  "schema": "gbdev.role.v1",
  "name": "auditor",
  "description": "独立只读审查并报告结构化结论",
  "output": "verdict",
  "sandbox": "read-only",
  "provider": "cursor",
  "allowed_providers": ["cursor", "codex", "fake"],
  "codex_model": null,
  "cursor_model": "auto",
  "default_timeout_min": 40,
  "default_stall_timeout_s": 900,
  "instructions": ["Review independently. Report findings with severity and evidence. Do not modify files."],
  "instructions_file": null
}
```

覆盖内置 reviewer 只需下面的 reviewer.json；instructions 数组若出现会整组替换，省略则保留内置值：

```json
{
  "schema": "gbdev.role.v1",
  "name": "reviewer",
  "provider": "codex",
  "default_timeout_min": 45
}
```

角色名 `^[a-z][a-z0-9-]{1,31}$`；description 非空且 ≤200 字符；output=change 必须 workspace-write，verdict/report 必须 read-only；provider 必须在非空 allowed_providers 子集内。instructions ≤40 条、每条 ≤500 字符；timeout 1–240 分钟；stall 为非负安全整数秒（0 关闭）。完整新角色除 cursor_model（可省略视作 auto）外提供上述字段；instructions_file 可为 null 或同目录 `^[a-z0-9-]+\.md$` 文件名。运行期额外字段 source/instructions_text 是 roles show 的输出，不要写回角色配置。

### brief 的角色补齐规则

- `provider` / `sandbox` 可省略，取角色默认；显式 provider 必须在 allowed_providers 内，sandbox 必须等于角色 sandbox，否则 config_invalid（details.code 为 role_provider_not_allowed / role_sandbox_mismatch）。因此只读任务请用 reviewer、planner、verifier 或自定义只读角色，不能把 executor 改为 read-only。
- 省略 `model` 时，Codex 取角色 codex_model，其他 provider 取 null；显式 null 保留。Cursor brief 只接受 null/auto，角色 cursor_model 只接受 auto 或省略；不把 codex_model 传给 Cursor。所有来源（含 config）的 Cursor 非 auto 均在创建 job/worktree 前拒绝。
- 省略 timeout_min / stall_timeout_s 时先取角色默认，再取 config 默认（完整有效角色已包含两者）；显式值优先，包括 stall_timeout_s=0。有效值保存到 brief.json。
- M1 风格的显式 executor/workspace-write、reviewer/read-only 与 provider/model/timeout 值保留；别名解析为 canonical reviewer。job-status 的历史角色名不依赖当前角色目录，删除角色后仍能读取旧 job。

## M2 命令与完整 JSON 输出示例

下列链接均为**完整 envelope JSON**，从隔离临时仓库的本地 fake 运行采集（角色/模板列表为内置值），仅把临时根路径统一为 `/tmp/gbdev-example`。这些是文档样本，不是真实冒烟结果；id、SHA、PID、时间与耗时均是样例，调用时用本次返回值。所有成功输出 contract_version 为字符串 "1"；pipeline 的 command 包含子命令，例如 "pipeline result"，不是只写 "pipeline"；roles list/show 的 command 均为 "roles"，用 result_schema 区分。

| 命令示例 | 完整 JSON 输出 | result_schema / 说明 |
|---|---|---|
| `gbdev roles list --json` | [roles-list.json](examples/roles-list.json) | gbdev.role-list.v1，roles/invalid/aliases |
| `gbdev roles show reviewer --json` | [roles-show.json](examples/roles-show.json) | gbdev.role.v1，含 source/instructions_text |
| `gbdev pipeline templates --json` | [pipeline-templates.json](examples/pipeline-templates.json) | gbdev.pipeline-list.v1，pipelines/invalid |
| `gbdev pipeline start --request request.json --dry-run --json` | [pipeline-start-dry-run.json](examples/pipeline-start-dry-run.json) | gbdev.pipeline-run.v1，p_dry_run/queued/dry_run=true |
| `gbdev pipeline start --request request.json --json` | [pipeline-start.json](examples/pipeline-start.json) | gbdev.pipeline-run.v1，starting/running |
| `gbdev pipeline status <id> --json` | [pipeline-status.json](examples/pipeline-status.json) | gbdev.pipeline-run.v1 |
| `gbdev pipeline status --json` | [pipeline-status-list.json](examples/pipeline-status-list.json) | 同一 result_schema，但 result 是数组，最多 50 个 |
| `gbdev pipeline wait <id> --timeout-ms 540000 --json` | [pipeline-wait.json](examples/pipeline-wait.json) | gbdev.pipeline-run.v1，稳定时返回 |
| `gbdev pipeline wait <id> --timeout-ms 540000 --with-result --json` | [pipeline-wait-with-result.json](examples/pipeline-wait-with-result.json) | gbdev.pipeline-result.v1 |
| `gbdev pipeline result <id> --json` | [pipeline-result.json](examples/pipeline-result.json) | gbdev.pipeline-result.v1，暂停也可取 |
| `gbdev pipeline resume <id> --input resume.json --json` | [pipeline-resume.json](examples/pipeline-resume.json) | gbdev.pipeline-run.v1，此样例为 accept → accepted_by_decider；其余动作返回 running |
| `gbdev pipeline cancel <id> --json` | [pipeline-cancel.json](examples/pipeline-cancel.json) | gbdev.pipeline-run.v1，此样例取消暂停 run；活动取消最多等 15 秒，若返回仍活动继续 wait |
| `gbdev pipeline cleanup <id> --dry-run --json` | [pipeline-cleanup-dry-run.json](examples/pipeline-cleanup-dry-run.json) | gbdev.cleanup.v1，含 would_* |
| `gbdev pipeline cleanup <id> --json` | [pipeline-cleanup.json](examples/pipeline-cleanup.json) | gbdev.cleanup.v1，job_id=null、pipeline_id 非空 |

pipeline start/resume 的 stdin 用法分别为 `--request - < request.json` / `--input - < resume.json`。resume 输入格式见上面的“暂停后继续”。cleanup 的 --force-branch 仍仅在用户明确同意删除未合并分支后使用。

下面是 pipeline result 的完整样例（汇总来自各步骤；没有顶层 summary）：

```json
{
  "contract_version": "1",
  "ok": true,
  "command": "pipeline result",
  "result_schema": "gbdev.pipeline-result.v1",
  "result": {
    "schema": "gbdev.pipeline-result.v1",
    "pipeline_id": "p_20261026_0639_6bd6",
    "pipeline": "implement-review",
    "state": "succeeded",
    "state_reason": null,
    "outcome": "approved",
    "failure_reason": null,
    "decision": null,
    "pending_questions": [],
    "repo": "/tmp/gbdev-example/repo",
    "branch": "gbdev/p_20261026_0639_6bd6",
    "worktree": "/tmp/gbdev-example/gbdev/worktrees/repo/p_20261026_0639_6bd6",
    "base_sha": "95db38a39c866d3c35f6ac981124e94328e31850",
    "diff_base_sha": "95db38a39c866d3c35f6ac981124e94328e31850",
    "head_sha": "afb158f99608018452e80ee488ee9905fa924a22",
    "round": 0,
    "jobs_used": 2,
    "duration_s": 0.773,
    "commits": [
      "afb158f feat(fake): ok"
    ],
    "files_changed": [
      "src/ok.txt"
    ],
    "outside_allowed_paths": [],
    "final_checks": {
      "job_id": "j_20261026_0639_deeb",
      "checks": [
        {
          "id": "AC1",
          "cmd": "test -f src/ok.txt",
          "exit_code": 0,
          "log": "/tmp/gbdev-example/gbdev/jobs/j_20261026_0639_deeb/checks/AC1.log"
        }
      ]
    },
    "final_verdict": {
      "instance": "review#1",
      "verdict": "approve",
      "open_findings": []
    },
    "steps": [
      {
        "instance": "implement#1",
        "state": "succeeded",
        "job_ids": [
          "j_20261026_0639_deeb"
        ],
        "gate": "advance",
        "summary": "Fake scenario: ok"
      },
      {
        "instance": "review#1",
        "state": "succeeded",
        "job_ids": [
          "j_20261026_0639_ab7c"
        ],
        "gate": "advance",
        "verdict": "approve",
        "summary": "Fake scenario: review_approve"
      }
    ],
    "warnings": [],
    "paths": {
      "pipeline": "/tmp/gbdev-example/gbdev/pipelines/p_20261026_0639_6bd6/pipeline.json",
      "diff": "/tmp/gbdev-example/gbdev/pipelines/p_20261026_0639_6bd6/diff.patch",
      "handoffs": "/tmp/gbdev-example/gbdev/pipelines/p_20261026_0639_6bd6/handoffs",
      "events": "/tmp/gbdev-example/gbdev/pipelines/p_20261026_0639_6bd6/events.jsonl"
    }
  }
}
```

pipeline cleanup 与 M1 cleanup 共用结果 schema，但 run 级清理的 job_id 为 null：

```json
{
  "contract_version": "1",
  "ok": true,
  "command": "pipeline cleanup",
  "result_schema": "gbdev.cleanup.v1",
  "result": {
    "job_id": null,
    "worktree_removed": true,
    "branch_deleted": false,
    "branch_retained": true,
    "branch_retained_reason": "unmerged_job_commits",
    "pipeline_id": "p_20261026_0639_6bd6"
  }
}
```

M2 的 usage/config/role_invalid/pipeline_invalid/cursor_model_not_allowed 返回退出码 2；pipeline_state_conflict、pipeline_not_settled、pipeline_not_terminal、job_owned_by_pipeline 等运行错误返回 1。成功 envelope 与退出码 0 只代表命令成功，wait/result 可返回 failed 的 run。

## M1 JSON 契约示例

### Envelope

`--json` 的 stdout 只含一个 JSON 对象和末尾换行，stderr 为空；运行日志写入 job 目录。成功 envelope 的 `contract_version` 为字符串 `"1"`：

```json
{
  "contract_version": "1",
  "ok": true,
  "command": "cleanup",
  "result_schema": "gbdev.cleanup.v1",
  "result": {
    "job_id": "j_20261025_1131_a7f3",
    "worktree_removed": true,
    "branch_deleted": false,
    "branch_retained": true,
    "branch_retained_reason": "unmerged_job_commits"
  }
}
```

doctor 使用 `result_schema: "gbdev.doctor.v1"`，result 为 `{ "checks": [{ "name": "node", "ok": true, "detail": "v24.15.0" }] }` 形状。start/status/wait/cancel 使用 `gbdev.job-status.v1`（status 列表为数组），result 使用 `gbdev.job-result.v1`。完整状态字段见 SPEC §4.3。

```json
{
  "contract_version": "1",
  "ok": false,
  "command": "result",
  "error": {
    "schema": "gbdev.error.v1",
    "code": "job_not_terminal",
    "message": "Job is not terminal",
    "retryable": true,
    "details": { "job_id": "j_20261025_1131_a7f3" },
    "next_steps": []
  }
}
```

### task-brief（controller → gbdev）

下面是可保存为 `brief.json` 的完整示例，repo 应改为白名单中的真实绝对路径：

```json
{
  "schema": "gbdev.task-brief.v1",
  "brief_id": "b_20261025_1130_x1",
  "repo": "/absolute/path/to/repo",
  "base_ref": "HEAD",
  "role": "executor",
  "provider": "codex",
  "model": null,
  "sandbox": "workspace-write",
  "timeout_min": 30,
  "stall_timeout_s": 600,
  "network": true,
  "goal": "给 /health 接口加版本号字段",
  "context": "服务入口在 src/server.ts，版本号从 package.json 读取",
  "constraints": ["不添加依赖", "不修改 CI"],
  "allowed_paths": ["src/**", "test/**"],
  "acceptance_criteria": [
    { "id": "AC1", "text": "/health 返回 version 字段", "check_cmd": "npm test" }
  ],
  "required_evidence": ["tests", "diff_summary"],
  "parent_job_id": null,
  "answers": []
}
```

`acceptance_criteria[].check_cmd` 可省略（仅保留 id/text，不执行检查）。provider 可为 `codex/cursor/fake`；role 接受任何有效注册角色（`code-reviewer` 是 `reviewer` 的别名）；allowed_paths 不能为空，采用 glob 匹配（`**` 跨目录、`*` 单路径段），并在收尾时观察越界。`network` 缺省 true，允许联网查资料，以及在 sandbox 允许写入时仅在本工作树内安装依赖；显式 false 在 prompt 中禁止联网和安装。禁止全局安装、修改全局配置、读取凭据/密钥和工作树外其他仓库；allowed_paths 不是实时文件访问拦截器。

Codex 保持原 sandbox：仅 `network=true` 且 workspace-write 追加 `-c sandbox_workspace_write.network_access=true`（codex-cli 0.164.0 实测有效）；false 和 read-only 均不追加网络配置键，false 保留旧 argv。Cursor 的 true/false argv 完全相同（`--sandbox enabled`、`--model auto`）；cursor-agent 2026.10.22 没有网络 CLI 开关，调度方实测现有 workspace-write argv 下沙箱命令可访问 example.com / registry.npmjs.org。Cursor 的 network=false 只作为 prompt 约束，实际网络策略由用户全局 cli-config / sandbox.json 决定，gbdev 不修改这些配置，也不写 worktree `.cursor/sandbox.json`。gbdev 不额外建立网络隔离层。

### worker-result（worker 最终消息末尾）

最终消息可以先写说明，末尾可附下面形状的 json 围栏块；Codex 启用 output schema 时输出同形状的纯 JSON：

```json
{
  "schema": "gbdev.worker-result.v1",
  "status": "succeeded",
  "summary": "为 /health 增加版本字段并补充测试",
  "files_changed": ["src/server.ts", "test/health.test.ts"],
  "commits": ["3f2a9c1 feat(health): include version"],
  "tests": [{ "cmd": "npm test", "exit_code": 0, "passed": 12, "failed": 0 }],
  "evidence": [{ "criterion_id": "AC1", "kind": "test", "ref": "test/health.test.ts", "note": "断言 version 字段" }],
  "open_questions": [],
  "blockers": [],
  "policy_violations": []
}
```

status 可为 `succeeded/needs_input/blocked/failed`。问题项示例：`{ "id": "Q1", "question": "采用哪个接口？", "options": ["A", "B"], "default": "A", "blocking": true }`。阻塞项示例：`{ "kind": "missing_dependency", "detail": "缺少预装开发依赖" }`。

### job-result（gbdev 汇总）

以下为 result envelope 中的完整 result 示例。真实 `worker_reported` 是归一化后的上述 worker-result；示例是 **workspace-write** 场景，使用报告缺失时的 `null`（只读缺报告且检查失败时，主因应为 `check_failed:AC1`，warnings 含 `worker_result_missing`）：

```json
{
  "schema": "gbdev.job-result.v1",
  "job_id": "j_20261025_1131_a7f3",
  "state": "failed",
  "worker_exit_code": 0,
  "session_id": null,
  "duration_s": 12.5,
  "worker_reported": null,
  "worker_result_warnings": [],
  "failure_reason": "worker_result_missing",
  "failure_reasons": ["worker_result_missing", "check_failed:AC1"],
  "gbdev_observed": {
    "head_before": "9c1e4b2",
    "head_after": "9c1e4b2",
    "commits": [],
    "files_changed": [],
    "outside_allowed_paths": [],
    "worktree_dirty_at_exit": false,
    "snapshot_commit": null,
    "checks": [{ "id": "AC1", "cmd": "npm test", "exit_code": 1, "log": "checks/AC1.log" }],
    "policy_violations": []
  },
  "paths": {
    "final_message": "/job-data/jobs/j_20261025_1131_a7f3/final.md",
    "diff": "/job-data/jobs/j_20261025_1131_a7f3/diff.patch",
    "events": "/job-data/jobs/j_20261025_1131_a7f3/events.jsonl",
    "worker_log": "/job-data/jobs/j_20261025_1131_a7f3/worker.log"
  }
}
```

## Provider 适配与真实调用确认

2026-10-25 R7 使用调度者已确认的真实 stream-json 样本修复 Cursor 输出；仓库测试只调用本地桩，不启动真实模型或读取凭证。

| Provider | 调用参数（各项是独立 argv） | 最终消息来源 |
| --- | --- | --- |
| codex | `exec --cd <wt> --sandbox <sandbox> --json --output-last-message <jobDir>/final.md --output-schema <jobDir>/worker-result.schema.json [-m <model>] -c model_reasoning_effort=high <prompt>`，不传任何 --add-dir | CLI 写出的 final.md，通常为纯 JSON |
| cursor（可写） | `-p --output-format stream-json --sandbox enabled --trust --force --model auto <prompt>`，cwd 为 wt | raw.json（内容为 JSONL）中最后一个 result 事件的 result 字符串；无 result 事件时回退 assistant 文本 |
| cursor（只读） | `-p --output-format stream-json --sandbox enabled --trust --mode plan --model auto <prompt>`，cwd 为 wt，不带 force | 同上 |
| fake | 本地 Node fixture，按场景产生结果 | final.md |

Codex 的独立 job、pipeline step 与 run 内所有角色共用该 argv 构造器，固定追加两个独立参数 `-c`、`model_reasoning_effort=high`，位于 prompt 之前，无需新增配置。M4 冒烟使用 `model` / `codex_model: "gpt-6-astra"`，实际参数为 `-m gpt-6-astra -c model_reasoning_effort=high`；既有显式模型与 null（不传 `-m`）语义保持兼容。`provider.json.argv` 记录实际 spawn 的同一参数数组。

Codex 的 schema 在 job 目录生成，所有 object 均为 `additionalProperties:false`，且所有 properties 都列入 required。`tests[].passed` 和 `tests[].failed` 在严格输出中均为必填非负整数，不接受布尔值；无测试时数组为空。prompt 明确说明并给出完整示例。运行时校验仍宽松接受省略计数或 passed 布尔值以兼容 Cursor，failed 若提供仍须为非负整数。

Codex 不传任何 `--add-dir`，不探测或授权 Git common dir。真实 Codex 0.164 冒烟证实即使加 common-dir 授权也不能创建 `.git/worktrees/<id>/index.lock`，同时整个 .git 的授权会暴露 hooks、config、所有 refs 和其他 worktree，因此 R4 已撤销该授权。所有 provider 的 `provider.json.writable_roots` 在 workspace-write 时只含工作树，read-only 时为 `[]`。

worker prompt 不包含针对 gbdev 实现的 argv 数组要求；network=true（默认）允许联网查资料，安装仅限允许写入的工作树；network=false 明确禁止联网和安装。inspector 仍是只读调查角色，可以查资料，但不跑测试、脚本、安装或 hooks。workspace-write prompt 保留不得修改 allowed_paths 外文件的约束；worker 不要运行 git add/commit，把改动留在自己的工作树，gbdev 在结束后代为 snapshot 提交；不要因无法提交而报 blocker，commits 可为空。这是正式产出提交的路径，合并仍由调度者负责。别的 provider 若已自行提交则照常记录，脏树仍 snapshot。read-only prompt 只要求不要修改任何文件（包括 allowed_paths 内的文件），不出现 “outside allowed_paths”；gbdev 不会代为提交，修改会导致作业失败（readonly_modified）。

Cursor stdout 原样写入 **raw.json（文件名不变，内容为 JSONL，每行一个对象）**，包含 system/init、user、thinking/delta、thinking/completed、assistant 和最终 `{"type":"result","subtype":"success","is_error":false,"result":"最终消息全文（可含 json 围栏）","session_id":"…"}`。最终消息只取最后一个 `type === "result"` 对象的 `.result` 字符串；该字段缺失/非字符串时返回 null，不回退较早结果。没有 result 事件（被杀/中断）时，按事件和 content 顺序直接拼接所有 assistant 消息 `message.content[]` 中 `type === "text"` 的 text 字符串；没有可用文本则 null。旧的单对象 JSON（可格式化、无 type、有 result 字符串）继续兼容。数百行 thinking delta、损坏行和尾部半行均容错解析，不抛错。

Cursor 的成功/失败元数据**只看最后一个 result 事件**（或旧格式无 type 的单个顶层对象）；只有该对象 `is_error === true` 或 subtype 是字符串且不等于 success 才判 provider_error，原因优先用非 success subtype，否则用 `provider_error: is_error`，绝不写 `provider_error: success`。system/init、thinking/delta/completed 等非 result 事件绝不构成 provider_error。没有 result 事件时 failure_reason 为 null（旧格式除外），交给退出码/看门狗/超时判断；字段缺失或 raw.json 空/损坏也不构成 provider 失败。session_id 仍取任意对象里最后一个顶层非空字符串，忽略空值、非字符串及嵌套字段。仅 Cursor 作业扫描 worker.log 的 Workspace Trust Required，匹配时 provider 原因为 provider_trust_required；Codex 不受影响。终态仍遵守 forced 和 needs_input/blocked 的更高优先级。raw.json 和 worker.log 均保留。

**真实 Cursor 审查常需 15–25 分钟。**旧 `--output-format json` 只在结束时一次性输出，会触发默认 600 秒无输出看门狗。现使用 `stream-json`，thinking delta 等增量输出持续写入 raw.json；stall 看门狗依赖 **raw.json/worker.log 的增长**刷新存活时间，不依赖最终结果或事件类型。总时长仍受 brief.timeout_min 限制。

Cursor 的 session_id、Codex 原始事件 raw.jsonl 中 `thread.started` 的 thread_id 均作为可选字段 `session_id: string | null` 写入 job-status/job-result，成功与失败均保留。新产生的 start/status/wait/cancel/result --json 均包含它（status 列表亦然）；尚未捕获或 provider 不提供时为 null，历史 v1 缺少时读取补 null，不改写原文件。异常恢复时，若 status.session_id 为 null，则按 provider 用现有解析器优先读取 Cursor raw.json / Codex raw.jsonl，再尝试另一 raw 文件及 legacy events.jsonl，随失败终态补写 job.json 和 result.json；已有 ID 不覆盖，文件缺失、不可读或解析失败不抛错，仍未知则保留 null。规范化 events.jsonl 不复制原始 thread.started 事件。M1 不执行 resume。

只读 Cursor 使用 `--trust --mode plan`，可写模式保留 `--force` 并显式加 `--trust`；收尾仍检查 readonly_modified，不将 CLI 模式当作额外的操作系统隔离保证。

doctor 调用 `codex login status`：退出 0 则 codex_login.ok=true，非零则 ok=false；detail 仅含 `exit_code=0` 等退出码信息（及 signal），丢弃 stdout/stderr，不暴露账号身份。Cursor 登录调用 `cursor-agent status`，仅报告退出码并丢弃输出。doctor 自身不读取凭证文件。所有 doctor 子进程（Git、provider 版本/登录、tmux -V）统一使用 10 秒超时和 SIGKILL；超时该项 ok:false、detail 为 `{"timed_out":true}`，整体仍返回成功 envelope。Git 超时 SIGKILL 后可能残留 index.lock/HEAD.lock，需检查后重试，gbdev 不自动删除锁。Git 辅助函数默认 120 秒，worktree add 为 300 秒，支持调用方指定毫秒超时；超时抛 internal_error，details.git_timeout:true。

## controller 调用配方（流水线，SPEC-M2 §15）

只有 controller 与用户对话；worker 不直接接触用户。以下流程不授权自动合并或推送。

1. 每个开发会话先 `gbdev doctor --json`，检查 roles 和所用 provider；不健康先修或告知用户，不派活。
2. 把需求整理成 pipeline-request：小改动 implement-review，大改动 plan-implement-review，第二意见 review-only，按 AC 验证用 implement-verify。需求不清晰由 controller 先问用户，不靠 planner 猜。首次使用模板/角色组合先 dry-run；可在同次审批内先 dry-run 再 start（前者失败就停止）。`gbdev pipeline start --request - --json < request.json`，保存 result.pipeline_id 并告诉用户预计时间。
3. `gbdev pipeline wait <id> --timeout-ms 540000 --with-result --json`，单次 9 分钟。wait_timeout 时读 error.details.pipeline.current 与 round 汇报进度，再 wait；对话外在通知未启用/未验证时可每 10 分钟 routine 调一次（间隔下限 5–10 分钟）；通知已启用且 Step 0 验证完成时改用文末 webhook + 每小时兜底，不再建 10 分钟 routine。典型审批为 start 1 + wait 2–4 + cleanup 1；shell 上限更短时缩短等待。
4. 稳定后按下表处理，再进入等待或交付。result **没有顶层 summary**，汇报摘要应由 steps[].summary 汇总，并结合观察事实。
5. busy 时不要刷屏重试：查看 running_pipeline_id/running_job_id，说明当前任务在跑，等其稳定再派。

| state / decision.reason | controller 的处理 |
|---|---|
| succeeded | 汇报 steps[].summary、files_changed、final_checks、final_verdict.open_findings 和 branch；accepted_by_decider 必须明说仍有未解决审查意见。询问用户是否合并，取得明确同意后由 controller 手动合并。合并/放弃后 cleanup，未合并分支默认保留，只有用户同意丢弃才加 --force-branch |
| needs_input | 转述 pending_questions（含 options/default），取得回答，`pipeline resume <id> --input - --json`，action=answer，再 wait |
| blocked | 查看 decision.detail；环境问题须取得用户批准后修复，action=retry、note 说明变更，再 wait；不能解决则告知用户 |
| needs_decision: max_rounds_exceeded / findings_repeated | 只有 minor/nit 时通常 accept；critical/major 可修且 allowed_actions 包含 extra_round 时考虑加轮（绝对上限 5）；否则 cancel 并解释 |
| needs_decision: review_rejected | 先告知用户审查理由，再在 allowed_actions 内决定 extra_round/accept，或 cancel |
| needs_decision: step_failed / step_cancelled / fix_no_changes | 用 `gbdev result <job_id> --json` 看具体失败，决定是否 retry；attempt 上限 3 |
| needs_decision: verdict_missing | 按 [M7 接受规则](#verdict_missing-接受规则)：先 retry 审查 → 再 `gbdev inspect` 取证 → 证据充分才 accept，必须带 `verdict_missing_reviewed: true` + 非空 note；`retry` ≠ `retry_task`，attempt 上限仍为 3 |
| needs_decision: job_budget_exhausted | 只可 accept 或 cancel，不再派 worker |
| failed | 汇报 failure_reason，policy_violations 必须告知用户；保留 worktree 供检查，之后 cleanup |
| cancelled | 确认后 cleanup |

以服务返回的 decision.allowed_actions 为准；cancel 是独立命令，不出现在该列表。answer/retry/extra_round 会创建新 job，不是 provider 会话续聊。完整待执行冒烟请求见 [docs/smoke](smoke/README.md)。

### M1 standalone 调用配方（保留）

controller 是调度者，每条 shell 操作须按用户审批流程执行。建议顺序：

1. 准备配置与 brief；执行 doctor，检查计划使用的 provider、Git、Node 和目录。
2. `start --brief ... --json`，保存返回的 `result.job_id`。遇到 busy 时读取 `error.details.running_job_id`，不要重试创建并行任务。
3. 用 `wait ... --timeout-ms ... --json` 等待。只有 wait_timeout 时继续等待同一个 job；需要中止时 cancel。
4. 终态执行 result；先看 `gbdev_observed` 的 commits、违规和 checks，再看 worker 自述、证据、问题、阻塞。gbdev 的 succeeded 不是自动验收或合并许可。
5. needs_input 时，将用户答案放入新 brief 的 answers，并设置 parent_job_id；不修改原 job、不 resume。
6. 用户审阅后执行 cleanup。无作业提交的分支可直接删除；有作业提交且未合并的分支默认保留，只有用户明确同意删除该分支，才带 `--force-branch`。gbdev 不替 controller 合并或 push。

通过程序调用时使用 argv 数组，不拼接 shell 命令。下面代码读取已准备的 brief，经 stdin 启动并收集结果；不自动清理或合并：

```js
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const cli = '/absolute/path/gbdev/dist/cli.js';
const brief = JSON.parse(readFileSync('brief.json', 'utf8'));
function call(args, input) {
  const child = spawnSync(process.execPath, [cli, ...args, '--json'], {
    input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024
  });
  if (child.error) throw child.error;
  if (child.stderr) throw new Error(child.stderr);
  const envelope = JSON.parse(child.stdout);
  if (envelope.contract_version !== '1') throw new Error('Unsupported contract');
  return envelope;
}
const started = call(['start', '--brief', '-'], JSON.stringify(brief));
if (!started.ok) throw new Error(JSON.stringify(started.error));
const id = started.result.job_id;
for (;;) {
  const waited = call(['wait', id, '--timeout-ms', '30000']);
  if (waited.ok) break;
  if (waited.error.code !== 'wait_timeout') throw new Error(JSON.stringify(waited.error));
}
const result = call(['result', id]);
if (!result.ok) throw new Error(JSON.stringify(result.error));
console.log(JSON.stringify(result.result, null, 2));
```

## 文件与测试

`GBDEV_HOME/jobs/<job_id>/` 保留 job.json（唯一状态真相、原子替换）、brief.json、provider.json、prompt.md、worker-result.schema.json（Codex）、raw.jsonl（Codex/fake）或 raw.json（Cursor，JSONL 内容）、events.jsonl、worker.log、supervisor.log、final.md、diff.patch、checks/*.log、result.json，以及进程监督/取消元数据。standalone job 使用 `GBDEV_HOME/worktrees/<repo_name>/<job_id>` 和分支 `gbdev/<job_id>`。pipeline step job 共享 run 的 `GBDEV_HOME/worktrees/<repo_name>/<pipeline_id>` 与 `gbdev/<pipeline_id>`；run 目录 `GBDEV_HOME/pipelines/<pipeline_id>/` 保留 request.json、definition.json、roles.snapshot.json、pipeline.json、handoffs/、inputs/、events.jsonl、supervisor.log、diff.patch、result.json。

测试使用 `fs.mkdtemp(os.tmpdir())` 建临时 Git 仓库与隔离数据目录，隔离 HOME/Git 配置，结束后清理。集成测试 1–12 覆盖执行、追问/阻塞、崩溃/非法报告、超时/进程组终止、取消、busy、越界/只读违规、snapshot、清理保护、白名单/空仓库，以及全部公开命令的 JSON stdout/stderr。真实适配器及 doctor 的 provider 命令只用本地可执行桩验证。

M2-S2 的 `s2-*.test.ts` 覆盖 schema 字节快照、递归严格 schema、全部归一化表项/非法字段、handoff 事实来源与截断、prompt 围栏/预算、supervisor 复用，以及 C1–C4（含两种文件替换竞态）。

M2-S1 回归测试覆盖角色字段反例、内置列表、覆盖隔离、别名、浅合并、Cursor 模型拒绝、brief 缺省补齐、doctor 与 prompt。S1 遗留修复测试覆盖启动失败原因、未 spawn/close 的退出事实、README result 示例与省略检查的文档说明。

M2-R1 回归测试覆盖删除前二次检出（主仓库/其他 worktree、无提交/已合并/force）、旧 tip 竞态、三种分支保留原因的 JSON/文本输出、doctor 六类子进程的 10 秒 SIGKILL 超时、Git 可选超时、完整失败原因与只读缺报告/检查失败优先级、旧文件只读补字段、无 check_cmd 不运行检查，以及 standalone 预留字段。

R7 回归测试使用裁剪的真实 Cursor stream-json fixture，覆盖成功提取、无 result 截断流的 assistant 回退、仅最后 result 决定失败、旧 JSON 兼容、800 条 thinking delta 与尾部半行，以及 stream-json/auto argv。流式假 provider 每 50ms 输出 thinking delta，持续 3.5 秒超过 2 秒 stall 阈值，验证不误杀且成功；中断流保留 assistant 交付物并由非零退出码判失败。

R6 回归测试补充所有删除路径的检出保护（含 dry-run）、force 旧 tip 竞态、ref 错误 retry_safe、events 补换行后的逐行解析、只读/可写缺 JSON 判定及边界、stall 看门狗杀进程组/持续 stdout 或 stderr/0 关闭/配置优先级，以及 doctor 的 Git helper。events.jsonl 追加前会为非空且无结尾换行的文件补换行，保留 legacy 会话事件。

R5 回归测试另覆盖 post-index-change 等 hooks 禁用、只读 prompt 无 “outside allowed_paths”、从已落盘输出恢复 session_id（含损坏/不可读输入）、base 移动后的无作业提交分支删除、未合并 snapshot 保留/force 删除、dry-run 一致性、旧值竞态校验，以及清理部分完成时的错误详情。

测试专用开关：`GBDEV_FAKE_SCENARIO` 指定 fake 场景；`GBDEV_TIMEOUT_SCALE` 把每分钟替换成指定毫秒数以加速超时测试（默认 60000）。生产调用不应设置这些测试开关。

`test/index.ts` 已将原先未接入默认测试入口的 S4 两个测试文件与 S5 文件统一纳入 npm test。S5 的 `test/s5.test.ts` 覆盖 F1/F3、源码安全扫描及所有内置角色的 standalone/pipeline Cursor 实际 argv（本地桩，含 fix 回路）；`test/s4-pipeline.test.ts` 增强 F2 损坏 run 的占槽保护和 5 轮上限。`test/s5-docs.test.ts` 校验文档 JSON 契约及冒烟请求（仅映射到临时仓库/本地桩，不访问 smoke 仓库）；doctor 内置 roles 健康由 `test/roles.test.ts` 的 AC-S1.1 回归确认。

## M3-S1/S2：契约、Lane 与调度基础（历史阶段记录）

以下记录 S1/S2 的交付范围与当时的验证结果；当前实现与限制见文末「M3-S5 实施说明」。M1 job 与 M2 standalone pipeline 的顶层并发仍为 1；`version: 1`、`contract_version: "1"` 不变。

### Run 配置（可选）

以下字段可加入现有 config.json：

```json
{
  "version": 1,
  "parallel": {
    "max_workers": 3,
    "provider_limits": { "codex": 3, "cursor": 2 },
    "rate_limit_cooldown_s": 600
  },
  "run_defaults": {
    "lanes": 2, "max_tasks": 12, "max_total_jobs": 60, "timeout_min": 720,
    "max_integration_fixes": 1, "max_resolver_attempts": 2, "max_conflict_files": 20,
    "gate_timeout_min": 30, "final_review": "reviewer", "overlap_policy": "serialize",
    "default_task_pipeline": "implement-review"
  }
}
```

以上也是缺省值。未知键返回 `config_invalid`。`max_workers`、`lanes` 为 1–4（上限由 `MAX_WORKERS` / `MAX_LANES` 常量固定）；各 provider 上限 1–4 且不能超过 max_workers。降低 max_workers 时也需显式降低相应 provider_limits，不会自动裁剪默认值。测试 provider `fake` 可显式配置上限。

其余范围：max_tasks 1–16、max_total_jobs 1–120、timeout_min 60–1440、max_integration_fixes 0–3、max_resolver_attempts 0–2、max_conflict_files 1–50、gate_timeout_min 5–120。final_review 为 reviewer/verifier/none，overlap_policy 为 serialize/allow。default_task_pipeline 必须存在且至少有一个 change 步骤。rate_limit_cooldown_s 为 0–3600 的整数秒（默认 600；0 表示不延迟），上限为本轮确认的 3600 秒。

M3 使用显式的 `loadRunConfig` / `validateConfig(value, registry)` 入口；M1/M2 命令仍通过原有 `loadConfig` 路径，完全不读取这两个字段。doctor 分别报告它们的有效性。

### 角色、模板和 standalone 修复输入

新增 `resolver`：change、workspace-write、默认 Codex、只允许 codex/fake、默认 30 分钟（stall 600 秒）。指令要求保留冲突双方意图，只为消除冲突编辑，不修改测试期望来通过测试，按 network 策略联网查资料或在工作树内安装依赖，不操作 `.git`。本轮只提供角色与契约，不执行 resolver 工作流。

`pipeline templates` 新增 `integration-fix`、`final-fix`，均为 `fix(fixer) → review(reviewer)`，fix_loop.after=review、fix_role=fixer、max_rounds=1，列表包含 `internal: true`。它们仅供 run 内部解析，直接通过 `pipeline start` 使用会返回 `pipeline_invalid`。

standalone pipeline 可在**首步骤角色为 fixer**的自定义模板/内联模板中使用可选 `seed_findings`：

```json
{
  "source": "integration_gate",
  "findings": [{ "id": "C1", "severity": "major", "file": null, "line": null, "text": "修复给定检查失败" }],
  "logs": [{ "check_id": "test", "tail": "最近的失败日志" }]
}
```

source 为 integration_gate/final_review/conflict；每个 tail 最多 80 行；非 null 的 seed 仅渲染到首步骤的「待修复问题」数据围栏，并转义围栏标记。缺省等价于 null，旧请求的保存形状不变。`run_binding` 只供内部使用；命令行提供该字段（包括 null）或 workspace/per_lane 均返回 `pipeline_invalid`，不创建 worktree。

### 契约与诊断

新增校验器及 JSON Schema 位于 `src/contracts/`：`gbdev.run-request.v1`、`gbdev.task-graph.v1`、`gbdev.run.v1`、`gbdev.merge-record.v1`、`gbdev.run-result.v1`、`gbdev.run-resume.v1`。Schema 文件描述结构；引用检查、任务图无环、模板 change 步骤、白名单和当前 decision 匹配由校验器结合上下文完成。run 请求、图或 resume 中的 Cursor 非 auto 模型仍返回 `cursor_model_not_allowed`（退出码 2）。

pipeline-run 新增可选 per_lane 关联形状；worker schema 仅在显式 taskGraph/mergeResolution 选项下增加字段。未启用这些选项时，M1 standalone 与 M2 pipeline schema 保持逐字节一致。事件增加可选 run_id/task_id/lane 和 M3 事件名，本阶段不产生 run 事件。

doctor 新增 `git_merge_tree`（Git ≥2.38，且在 os.tmpdir() 下自建、自清的临时仓库中真实执行 merge-tree --write-tree）、`parallel_config`、`run_defaults`、`resolver_role`。S2 增加 `stale_integration_locks`：只读列出 PID 已不存活的锁及持有者信息；不删除锁。

新增错误码如下；除标明外退出码为 1、retryable=false：

| code | retryable | 退出码 |
|---|---|---|
| run_not_found | false | 1 |
| run_invalid | false | 2 |
| run_not_settled | true | 1 |
| run_not_terminal | true | 1 |
| run_state_conflict | false | 1 |
| integration_locked | true | 1 |
| user_approval_required | false | 2 |
| land_refused | false | 1 |
| guard_violation | false | 1 |
| pipeline_owned_by_run | false | 1 |
| job_owned_by_run | false | 1 |

`busy.details.running_run_id` 和 `wait_timeout.details.run` 已有类型支持；run 命令相关错误的运行时触发留给后续阶段。

### Git 安全与兼容

新增 Git 操作全部位于 core/git.ts，使用原 `git()` 的 argv 数组、hooksPath=/dev/null、超时 SIGKILL。M3 resetHard/cleanUntracked/mergeAbort/updateRefCas/switchDetach/switchCreate/mergeNoFf/mergeNoCommit 统一通过 gitGuarded，校验 run 命名空间、paths.worktrees 的真实路径、同一仓库所有权以及当前检出分支（CAS 则校验目标 ref）。只接受 run 下的 integration/lane-N worktree，拒绝主仓库；parked lane 必须显式提供并匹配 detached_sha。无任意 argv 逃生入口；SHA 只能是 40 或 64 位小写十六进制；run update-ref 一律 --no-deref。所有权失败为 guard_violation，实际 git 执行错误和超时保留原约定。

M1/M2 cleanup 原有 CAS 删除 job/pipeline 分支的逻辑保留，不套用只接受 run 分支的 M3 守卫。真实 provider 冒烟不在本阶段执行；fake 与临时 Git 测试不能替代 M3-R1–R8 冒烟。


### M3-S2 实施说明（内部 API，不是新 CLI）

- `src/run/lanes.ts`：`LaneManager.create/start/park/available` 管理 `preparing → idle ⇄ busy / broken`。新任务分支从调用时传入的 `verified_sha` 切出，`-rN` 重建保留旧分支；park 前先断言干净，再 detach/reset/clean，保留任务分支和 ignored 缓存。dirty、异常 HEAD/分支、worktree 丢失或 Git 失败会使 lane broken，不再分配。
- `src/run/integration.ts`：创建/只读打开 run 集成 worktree；已有 worktree 必须干净且 HEAD 等于 verified_sha，不擅自修复。每个新 worktree 的 setup 只运行一次，默认超时 15 分钟，日志位于 `runs/<run_id>/setup-<lane|integration>.log`；失败/超时保留现场。
- `src/run/integrationLock.ts`：O_EXCL 锁记录 pid/purpose/seq/at。获取及接管在短暂 M1 全局锁内完成；整个持有期不占全局锁。F8 已修正：能解析出活 pid 才拒绝接管；空内容、坏 JSON、不可读或死 pid 均视为陈旧，doctor 报不健康。release 不删除替换后的锁。
- `src/run/scheduler.ts`：无 I/O、显式传入时间。依赖全部 integrated 才就绪；resume/integration-fix 优先，其后按最长下游路径、声明顺序；lane 按依赖亲和、tasks_done、编号；保守 scope 重叠只阻塞该候选。槽位计数/释放、provider 上限、冷却检测均为纯函数。
- 现有 M2 实际入口为 `pipelineStart/supervisePipeline`，并无旧 `runPipeline`；S2 新增 `src/commands/pipeline.ts` 的内部 `runPipeline(store, request, hooks)`，复用同一初始化及监督流程。必须携带 run_binding，校验 lane 路径/任务分支，进程内 await 完成，不创建或 detach worktree，也不派生 pipeline supervisor。
- `acquireSlot(provider, signal)` 在创建 job **之前、全局锁之外**等待，回调必须响应取消信号；`releaseSlot` 在完成/异常路径成对调用。超过 30 分钟等待记录 slot_starved。`onRateLimit(provider)` 先记录冷却，再释放槽位；一次限流自动重试（仍受 M2 attempts/job/deadline 预算限制）。run 级 slots、预算和事件持久化由后续 S3 owner 接线，本阶段不实现 run supervisor。
- per_lane pipeline 的 cancel/resume/cleanup 与 job cleanup 拒绝直接操作，status/result/wait 保持可读。standalone 路径不使用上述回调。planner/resolver 的 Codex schema 递归无 anyOf/oneOf/allOf；standalone planner 不含 handoff，M1 与 M2 三种 schema 字节夹具不变。

S2 测试入口已加入 `test/index.ts`，证据位于 `test/m3-s2-{fixes,scheduler,lanes,lock,pipeline}.test.ts`。真实 Codex/Cursor 冒烟未执行；本轮不实现 S3+ 的 run 命令、调度循环、合并队列/关口/回滚、resolver、决策/resume、planner、cleanup/land。

验证记录（Node v24.15.0）：默认 `npm test` 共 **691** 个测试通过（此前 620 + 本轮新增 71），失败/跳过均为 0；`npm run build`、`npx --no-install tsc --noEmit`、`git diff --check` 通过。调度包含 37 个表驱动用例及 2 个组合用例；未运行真实 Codex/Cursor 冒烟。

### M3-S3 实施说明（provided run）

已实现 SPEC-M3 §17 的 S3 及 F8–F12 修复。以下说明覆盖上面历史阶段中的“尚未实现”描述。

```sh
gbdev run start --request request.json --dry-run --json
gbdev run start --request - --json < request.json
gbdev run status <run_id> --json
gbdev run status <run_id> --events --since 0 --json
gbdev run wait <run_id> --timeout-ms 540000 --until settled --with-result --json
gbdev run result <run_id> --json
gbdev run cancel <run_id> --json
```

- 本阶段仅支持 `decompose: "provided"`、`final_review: "none" | "reviewer"`。planner/verifier 在建 run 文件前返回 run_invalid。checks 命令只来自请求；任务只引用 check id。可选 `task_checks: string[]` 把选定可信检查前移到 change 步骤的 task check 阶段（与 acceptance criterion 共享 B2 去重）。请求省略该字段且 home `run_defaults.task_checks` 未提供时，按 `integration_checks` 顺序自动选择 `timeout_min ≤ 5` 的检查（check 超时缺省为 10，不纳入）；显式 `task_checks: []` 可 opt-out，显式列表优先于 home defaults。规范化列表写入 request.json，并记录 `task_checks_defaulted` warning；旧 request.json 中的 `[]` 保持不变。merge/baseline gate 仍独立再跑；change/reviewer 提示附带信息性 gate 清单，不强制 worker 执行。
- 输出为 M1 信封，contract_version 保持 "1"。start/status/cancel 和普通 wait 返回 gbdev.run.v1；result、稳定时的 wait --with-result 返回 gbdev.run-result.v1。status 无 id 列最近 20 个 run；wait 默认 until=attention，已有 attention 立即返回；超时的 wait_timeout.details.run 带当前状态。
- start 冻结请求、角色/provider、模板和并行设置；dry-run 仅校验与预检、不建目录/worktree。执行以 detached/unref（可用时 caffeinate）拉起一个 __run-supervise。任务流水线在同一进程中通过 runPipeline(run_binding) 并发执行。顶层仍互斥；内部步骤分别等待 worker/provider 槽位。
- starting：集成 worktree/setup → baseline gate → lane/setup。pending 依赖全部 integrated 才转为 ready；复用关键路径、lane 亲和与 file_scope 重叠规则。任务分支从当时 verified_sha 创建；成功后 park lane、冻结 head_sha、进入 FIFO 合并队列，同一任务不重复入队或派发。
- 集成锁覆盖 merge-tree 预检、按冻结 SHA 的 --no-ff 合并与 post-merge gate。关口按顺序去重运行 integration checks、本任务 AC、已集成任务 AC、run AC；失败重试一次（超时不重试），重试通过记 flaky_suspected。检查修改跟踪文件视为失败；清理非忽略未跟踪文件并警告，保留忽略缓存。
- 失败 reset 到 pre_merge_sha；有次数时先把当前 verified_sha 合进任务分支，再跑 integration-fix，带 integration_gate seed findings 与日志末 80 行。用尽时任务 needs_decision、写 attention；其他任务仍可推进。冲突只进入 merge_conflict_unresolved attention，**没有实现 resolver**。
- 全部任务 integrated 后 finalizing；none 直接成功，reviewer 在集成 worktree 只读审查全量 diff。revise/reject 或无结论重试后仍无结论进入 needs_decision；S3 不提供 resume。集成成果保留，不自动合入 main/master，不 push。
- run.json 原子写、supervisor 单写；CLI cancel 只投递 cancel.json。取消停止 worker/check/setup 进程组并恢复集成到 verified_sha；无 supervisor 时执行最小取消清理，不提供崩溃重启。I1–I7 在运行时检查；不变量异常写事件并进入 integration_corrupt attention（仅能 cancel）。事件携带 run/task/lane 归属；任务自己的事件仍在 pipeline/job 目录。
- F8–F12：无主集成锁可接管且 doctor 判不健康；失败 setup 保留未完成标记，下次 open 重跑；park 的 verified_sha 随 lane 持久化；pending 不重复派发；openIntegration 拒绝短 SHA/分支名。
- runs/<id>/ 保存 run/request/task-graph、角色与执行快照、settings.snapshot、protected-refs、events、baseline.gate、merges/<seq>.json 和 <seq>.gate、final-review/final-gate、result、diff.patch。完成的合并记录不覆写；失败合并 SHA 与日志保留。

**范围边界：** 未实现 S4+ 的冲突 resolver、完整决策/resume、run 预算决策、完整版崩溃恢复、planner/计划评审、cleanup/land。S3 的 attention 可读、可取消，但不能恢复执行。

测试证据：test/m3-s3-run.test.ts 覆盖 AC-S3.1–AC-S3.4（含两个 integration-fix 结局）、最终 reviewer、I1–I7 负例、CLI/detached 生命周期、取消、检查集合/重试/副作用/超时。test/m3-s2-{lock,lanes}.test.ts 补 F8–F10/F12；F11 与双 lane 场景一起验证。均为 fake provider 与临时 Git 仓库测试；**M3-R1–R8 真实冒烟未执行**。

规范差异采用既有契约：§12.1/§12.4 的 run-start/run-status 与嵌套 supervisor 字段没有对应 S1 schema，使用 §6.1/§11.1 的 gbdev.run.v1、supervisor_pid/heartbeat_at；取消使用 §11.1 的 cancel.json（不是 §12.1 另一处描述的 inbox）。§12.3 所需 integration_corrupt 原先不在 attention reason 枚举，本轮补入，并允许空 allowed_actions 表示仅 cancel；cancel 仍不列为 resume action。不新增既有状态机中没有的 cancelling 状态。

S3 最终验证（Node v24.15.0，2026-10-26）：`npm run build`、`npm test`、`npx tsc --noEmit`、`git diff --check` 全部通过。默认完整套件 **723/723**（此前 691 + 新增 32），失败/取消/跳过均为 0，完整测试用时约 552 秒。AC-S3.4 同时覆盖 post-merge gate 中取消和真正运行中的 Git merge 子进程取消；长 merge 使用 core/git.ts 的可取消异步重载，保留 hooks/命名空间守卫和 SIGKILL 超时策略。此记录不是实际 provider 冒烟结果。

### M3-S4 实施说明（冲突、决策、预算与恢复）

本节覆盖 S3 章节的历史限制。已接入 provided run 的 S4 流程及评审 F13–F20；**没有执行真实 Codex/Cursor 冒烟**。此段为 S4 历史范围；planner、计划评审、final-fix、cleanup、land 已在下文 S5 实施。

- 冲突：merge-tree 预检后创建冲突现场，resolver 最多两次（配置可降为零），冲突文件数受配置上限限制。resolver job 不执行普通 snapshot；逐文件检查遗留标记、未解决项及 allowed_paths，记录非冲突文件改动。gbdev 提交双父 merge，关口通过后由只读 verifier 审核；拒绝/无结论回滚并产生决策。lane refresh 的冲突同样使用 resolver/关口/verifier，单独保留 refresh 证据。
- 决策：支持 `answer/retry/extra_round/accept` 透传 M2；支持 `retry_task/rebuild_task/retry_resolve/extra_fix/drop_task/extend_budget/resume_run/accept_final`。旧分支有独有提交时保留并创建 `-r<k>`，没有独有提交时 CAS 更新复用；retry+rebuild 总计最多三次。drop 级联到下游并写入 result。决策 ID 唯一，过期或重复提交返回 `run_state_conflict`、`details.reason=stale_decision`。
- 活跃 run 的 resume 在全局锁内校验后投递 `inputs/<batch-id>.json`，由单一 supervisor 消费；其他任务继续执行。暂停 run 检查顶层互斥后重启 supervisor。批量输入先整体校验（包括 M2 状态约束），任一非法则全部拒绝、不改决策。
- 预算：创建 job 前预留预算和 provider 槽位，含 resolver/verifier/final reviewer；80% 发 `budget_warning`，耗尽后让已有 job 完成，不启动新 job，释放 lane 并进入 `run_budget_exhausted`。`extend_budget` 仅一次，增加 `min(30, 120-current)`。provider 限流记录冷却截止时间并自动重试一次，仍失败进入决策。
- 恢复：status/wait/resume/cancel 读前检查 supervisor PID 和命令行；心跳过期但身份仍匹配只给 warning。崩溃时停止 job/check 及 run 级 Git/gate/setup 的已记录进程组，失败化中断的 pipeline；abort/reset/clean 集成 worktree 到 verified_sha，未完成 merge 回队首；busy lane 保存 crash snapshot 后 park；生成 `supervisor_crashed` 和需要的 `task_failed` 决策，每步写 `recovery_step`。
- F 节：故障停机不再把任务误标 cancelled；cancel 等待超时返回 retryable `run_not_settled`（`cancel_pending`），不会把活跃 run 当成功；长 Git 路径采用可取消异步调用；SIGKILL 后等待进程组消失；verified_sha 持久化成功后才结束 integrated merge record；I6 仅快照已知目标（本阶段为可解析的本地 base_ref），不冻结无关分支；锁释放判空；CLI 的 events/since 文案与 S3 两种修复结局测试均修正。

示例（文件由调用方生成；所有字段沿用 `gbdev.run-resume.v1`）：

```sh
# 单项决策
node dist/cli.js run resume r_YYYYMMDD_HHMM_xxxx --input decision.json --json
# 批量：JSON 数组，每个元素都是完整 gbdev.run-resume.v1
node dist/cli.js run resume r_YYYYMMDD_HHMM_xxxx --answers-file decisions.json --json
# 识别崩溃并取得当前决策
node dist/cli.js run status r_YYYYMMDD_HHMM_xxxx --json
```

崩溃恢复通常在同一数组里提交 run 级 `resume_run` 和每个中断任务的 `retry_task`。只提交任务答案不会跳过仍未解决的 `supervisor_crashed` 决策。取消超时或 supervisor 正在收尾时应重试；无法读取进程身份时返回可重试错误，不把“无法确认”当作已崩溃。gbdev 不自动删除 Git 的 index.lock/HEAD.lock。

全局锁先完整写入 PID，再以排他硬链接原子发布，避免 SIGKILL 留下空 owner 的窗口；已有不可读锁仍拒绝自动接管。若记录中的集成写进程组在终止等待上限后仍存活，恢复拒绝继续 reset，不以删除 Git 锁绕过。

规范边界：§10.3 写“一次只解决一项”，但 §12.2、§17/AC-S4 明确要求批量；本轮遵循后者及本轮任务要求，以 v1 对象数组实现，不另造 schema。S1 attention schema 没有 `resolving` 状态，因此用 pending 输入文件防重复，消费成功才移除 attention。 `run resume` 返回既有 gbdev.run.v1，不添加 schema 中没有的顶层 dropped_tasks；级联列表在 decision_resolved 事件与 run-result.dropped_tasks 中提供。S4 当时推迟的 `approve_plan/replan/add_fix_task` 已在 S5 实现，deferred 路径已删除。原有 M1 schema、M2 三种 worker-result schema 与 contract_version 均保持不变。

测试入口：`test/m3-s4-run.test.ts`、`test/m3-s4-recovery.test.ts`、`test/m3-s4-fixes.test.ts`；F13/F20 同时加强 `test/m3-s3-run.test.ts`。所有测试使用 fake provider、临时 Git 仓库和隔离 GBDEV_HOME；SIGKILL 场景覆盖 running、MERGE_HEAD 冲突现场、finalizing。最终验证结果见 SPEC-M3 §17 S4 实施记录；这些测试不是 M3-R1–R8 真实冒烟。

S4 最终验证（Node v24.15.0，2026-10-26）：build、完整测试、源代码/测试代码 TypeScript noEmit 检查、`git diff --check` 均通过。完整套件 **750/750**（此前 723 + 新增 27），失败/取消/跳过为 0，约 639 秒。


### M3-S5 实施说明（Planner、最终修复、cleanup、land）

本节保留 Run 生命周期与协议语义；真实 provider 验证需自行在临时仓库执行。

- `decompose: "planner"`：只读 planner 输出 task-graph，校验含依赖环、检查引用、路径与模板。非法图自动重试一次，仍失败进入 needs_decision；有效图进入 plan_review，批准前不执行任务。
- `run resume` 支持 `approve_plan`（可附完整替换图，重新校验）、`replan`（planner 总尝试 ≤ 3，含首次和自动重试）；`add_fix_task` 创建最多 2 个 final-fix，正常执行流水线、合并、关口，再做最终评审。仍受 max_tasks 限制；不会覆盖用户已有的同名任务。最终 reviewer/verifier 都支持，reject/无结论自动重试一次；`accept_final` 保留未解决意见。
- `allowed_actions` 不再列出 deferred 或已耗尽次数的动作；verifier 启动事件为 `verifier_started`。
- worker 最终 JSON 围栏闭合后若紧跟文本，保留有效结果并记录 `worker_result_warnings`；真正未闭合、无有效结果仍报错。

新增命令（示意占位 ID，不是执行授权）：

```text
gbdev run cleanup <run_id> [--dry-run] [--force-branch]
gbdev run land <run_id> --target <branch> --confirm-user-approved [--dry-run] [--approval-note <text>]
```

Cleanup 仅接受终态：删除干净 lane 和集成 worktree；未合并任务分支/集成分支保留；分支删除使用 expected-tip CAS，dirty/checked-out 不因 force 被删除。运行证据不 purge；重复调用安全，pipeline 同步 cleanup 记录。只有用户明确同意丢弃提交后才能使用 `--force-branch`。

Land 仅接受 succeeded run，缺批准标志返回 `user_approval_required`（exit 2，refs 不变）。target 在 run 期间被外部推进时，先在集成 worktree 同步，跑完整检查并集，失败则复位；通过后 ff-only（检出的干净 target）或 CAS（未检出的 target）。dirty target 拒绝；记录批准时间、note、目标与落地 SHA；不 push。`--confirm-user-approved` 必须来自用户明确同意，不因 run 成功而自动添加。

已知差异：§10.3 的 resolving 与按 decision_id 命名输入文件仍未引入；沿用原子 pending 输入、decision_id 去重和批量数组（contract v1）。§13 所需 land / sync kind / pipeline cleanup 作为可选字段新增，旧 worker schema 不变。外部 target SHA 前进不是 gbdev 写目标分支，生产 I6 使用 Git 写守卫隔离，不再误判外部推进为 integration_corrupt。

测试：`test/m3-s5-run.test.ts`、`test/m3-s5-lifecycle.test.ts` 覆盖 AC-S5.1–AC-S5.4 与 F21/F23/F24；F22 的事件顺序断言在 `test/m3-s4-run.test.ts`。所有新测试使用 fake provider 与临时仓库，详见 SPEC-M3 §17 S5 实施记录。


## M3 并行 run：操作入口（S6）

M3 在 M2 流水线上增加 task graph、1–4 条 lane、专属集成分支、串行合并和每次合并后的关口。run 成功不改 main/master，也不会 push。Cursor 所有角色都只用 `--model auto`（请求覆盖字段 `cursor_model: "auto"`）。

```sh
gbdev run start --request request.json --dry-run --json
gbdev run start --request request.json --json
gbdev run status <run_id> --json
gbdev run wait <run_id> --until attention --timeout-ms 540000 --with-result --json
gbdev run resume <run_id> --input decision.json --json
gbdev run result <run_id> --json
gbdev run cancel <run_id> --json
```

状态概览：`queued → starting → planning → plan_review → running → finalizing → succeeded`；provided 图跳过 planning/plan_review。`running/finalizing ⇄ needs_decision` 通过当前 attention 的允许动作恢复。终态为 succeeded/failed/cancelled；单任务 attention 不一定暂停其他 lane。

等待决策不消耗前 24 小时的执行时长预算：pipeline 的 needs_input/blocked/needs_decision、run 的 plan_review/needs_decision 进入时记录 `paused_since`，恢复时累计 `paused_ms` 并顺延 deadline（每个 unit 累计最多顺延 24h；超出等待仍计入 paused_ms）。父 run 仍 running 时不继承子 pipeline 的暂停；取消/终态清除当前暂停且不补偿。旧记录没有暂停字段时不回溯猜测等待时长。status 仅在累计暂停大于零时显示 `paused <n>m`。

新 attention 带最多 300 字符的脱敏 `summary`，包含原因、worker 报告摘录、问题及建议动作；task 暂停保留 pipeline/step/job 与失败原因。环境/沙箱限制与 reviewer verdict 仅作说明，不改变 gate 或 allowed_actions。通知优先投影此摘要（最多 200 字符），旧记录无摘要时仍使用通用模板。

**land 必须先获得用户对目标分支的明确同意**，之后才能加 `--confirm-user-approved`（dry-run 也一样）。真实 land 同步必要的目标变化、重跑关口，然后 ff-only/CAS，不 push。

```sh
# 仅在用户明确批准该目标后；冒烟一律使用 scratch smoke-land
gbdev run land <run_id> --target smoke-land --confirm-user-approved --dry-run --json
gbdev run land <run_id> --target smoke-land --confirm-user-approved --approval-note "用户明确批准的原话" --json
gbdev run cleanup <run_id> --dry-run --json
gbdev run cleanup <run_id> --json
```

cleanup 仅用于终态：删除干净 lane 和集成 worktree；dirty、checked-out 和未合并提交按原因保留；已包含的任务分支可删，集成分支须已 land 或仍等于 base。证据目录保留，重复执行安全。`--force-branch` 只能在用户明确同意丢弃提交后使用。

- [controller run 操作配方](controller-recipe.md)：start/wait/resume/用户批准/land/cleanup。
- [M3-R1–R8 冒烟手册与请求](smoke-m3/README.md)：材料已就绪，**真实冒烟全部待调度者执行**，不是通过记录。
- `npm run check:smoke-argv -- <job目录或runs/id目录或gbdev-home> ...`：只读核对实际记录的 Cursor argv，逐条报告、违规/缺证据非零退出。新 job 的 `provider.json` 保存 cmd/argv/cwd，旧记录缺 argv 不算通过；argv 包含 prompt，按本地 job 证据管理，不自动上传。

S6 同时修复 F26 的 EPERM/定时器信号异常，F27 的 land 错误分类并锁定 dry-run dirty 判定，F28 将 dead-supervisor cancel 恢复改为异步 Git。编辑后批准图以 run 状态和 task-graph/plan 文件为准，原始 request.json 不改。§17 记录实现细节和验证证据；M1/M2 schema 与 contract_version "1" 不变。

S6 自动验证（Node v24.15.0）：完整 `npm test` **807/807**（原 780 + 新增 27），失败/取消/跳过均为 0；build、源码/测试 noEmit、diff-check 通过。真实 M3-R1–R8 与其 Cursor argv 验收仍待调度者执行。


## 实时观看（tmux）

**核心不变量：tmux 崩溃、pane 被关、dashboard 任意时刻打开/关闭/重开，都不影响正在运行的 Codex/Cursor 任务。pane 只是只读视图，worker 始终由 gbdev 后台进程管理，从不运行在 tmux pane 中。** Mac 整机重启仍需既有 run 崩溃恢复，不等于任务能跨重启继续运行。

启动任意 job / pipeline / run 时加 `--json`，以 `result.dashboard.attach_hint` 为准，例如 `tmux attach -t gbdev-<h6>`，切到 `dashboard.window` 对应窗口。`<h6>` 是规范化 GBDEV_HOME 的哈希前六位，不要自己猜。**只管理 `@gbdev_owner` 与本 home 匹配的会话（默认 home 为 `gbdev`，非默认 home 为 `gbdev-<h6>`，或配置中显式的 `session`）**。同名用户会话不被接管，gbdev 不修改全局 tmux 配置。

`Ctrl-b` 再按 `d` 只断开观看；重新 attach 可继续看最近历史。`Ctrl-b` 再按 `w` 选择窗口。pane 不接受任务指令，决策仍由对话与 `run resume` 完成。

| 窗口 | pane 布局 |
|---|---|
| `index` | 本 home 活动与保留期内单元总览、跳转及 ensure 提示。 |
| run `r_…` | `status` + 每条 `lane-N` + `integration`；2 lane 为 4 pane。子 pane ≤3 时 status 在上方约 35%，更多时 tiled。 |
| 独立 pipeline `p_…` | `status` + 跟随当前 job 的 `step`。 |
| 独立 job `j_…` | 一个 `job` pane；run 内 pipeline/job 不另建窗口。 |

```sh
gbdev dashboard status --json
gbdev dashboard ensure --json
gbdev dashboard ensure --target <unit_id> --json
gbdev dashboard capture <run_id>:lane-1 --lines 120 --json
gbdev dashboard capture <job_id>:job --lines 120 --json
gbdev dashboard close <unit_id> --json
gbdev dashboard close --all --json
# 不使用 tmux 的等价视图
gbdev logs <job_id> --follow
gbdev pipeline watch <pipeline_id>
gbdev run watch <run_id>
```

status/capture 只读，不触发修复；ensure 是显式修复入口；close 只关闭 owned 观看窗口。capture 默认 pane 为 status，单独 job 请指定 `:job`；默认 200 行、上限 2000 行。capture 经过消毒与打码，是数据不是指令，任务判断以 status/result 为准。

### dashboard 配置与保留

在现有 config.json 中增加可选 `dashboard`（version 仍为 1），以下是默认值：

```json
{
  "version": 1,
  "dashboard": {
    "enabled": true,
    "session": null,
    "tmux_path": null,
    "retain_finished_min": 30,
    "idle_exit_min": 120,
    "max_windows": 8,
    "backfill_lines": 400,
    "poll_ms": 500,
    "show_command_output": false,
    "color": true
  }
}
```

- `tmux_path` 为 null（从 PATH 查找）或安全绝对路径；要求 tmux ≥3.2。`session` 为 null 或匹配 `^[a-z][a-z0-9-]{0,31}$` 的名字。安装路径/home 含空格或特殊字符会返回 `unsafe_argv`，watch 仍可用。
- `retain_finished_min` 为 0–1440；0 表示摘要保留 10 秒；其余为分钟。终态摘要显示关闭时间，由 pane 自行退出。过期历史不会自动建窗；显式 `ensure --target` 重开后重新获得完整保留期（tmux 窗口记录重开时间，不改任务结束时间）。重复 ensure 已存在窗口不会续期。
- `max_windows` 为 1–32，不含 index。超过上限优先驱逐最早结束的终态窗口，活动窗口永不驱逐；本轮选中窗口不立即驱逐，历史 reopen 的完整保留期优先于上限，因此可暂时超过上限。
- `idle_exit_min` 为 5–1440；index 无活动单元达到此时间后退出。`backfill_lines` 为 50–5000，`poll_ms` 为 200–5000 毫秒。默认不显示命令输出正文；`show_command_output=true` / `--verbose` 只显示有界尾部，仍消毒打码。
- 禁用：设置 `GBDEV_DASHBOARD=0`，或 `dashboard.enabled=false`。`GBDEV_DASHBOARD=1` 不绕过配置、版本、所有权或安全检查；`GBDEV_TMUX_BIN` 是测试注入路径。`NO_COLOR` 非空禁用颜色；测试默认禁用真实 tmux。
- supervisor 仅在启动/恢复与指定拓扑事件触发，按顶层单元做 **5 秒前沿去抖**：第一条立即启动 ensure，窗口内后续事件丢弃；没有尾沿定时补跑，也没有周期修复。因此刚关闭的 pane 或去抖窗口末尾的变化可能要等下一次事件才恢复；可显式 ensure，避免定时把用户主动关闭的 pane 弹回。
- start 提示探测总预算 1 秒，ensure 总预算 10 秒、单次 tmux 调用至多 3 秒；失败不改变任务或 start 退出码。`enabled` 表示配置允许，只有 `reason=null` 且 attach_hint 非空才建议 attach。不可用时始终使用 start 返回的 watch_hint。
- 用户自定义 tmux hook 可能改变布局；gbdev 不对抗用户 hook。打码是纵深防御，不应主动输出真实密钥。

### reason 对照

| reason | 中文说明 |
|---|---|
| `null` | 无故障；面板可用或正在等待异步创建。 |
| `disabled_by_config` | 配置关闭了观看面板。 |
| `disabled_by_env` | 环境变量 GBDEV_DASHBOARD=0 关闭了观看面板。 |
| `disabled_in_tests` | 测试环境默认关闭观看面板。 |
| `tmux_not_found` | 没有找到可执行的 tmux。 |
| `tmux_too_old` | tmux 版本低于 3.2，或版本无法识别。 |
| `tmux_error` | tmux 调用失败，本次面板不可用。 |
| `tmux_timeout` | tmux 探测或操作超时，本次面板不可用。 |
| `unsafe_argv` | 安装路径、home 或参数含不支持的字符，面板保守禁用。 |
| `foreign_session` | 同名会话不属于本 home，gbdev 不会操作它。 |
| `lock_busy` | 其他进程正在更新面板，本次操作放弃。 |

controller 每次启动后必须使用 [提醒文案与规则](controller-recipe.md#m4-实时观看提醒spec-m4-15)。[M4D-R1–R10 冒烟手册与记录模板](smoke-m4-dashboard/README.md)：请在独立临时环境验证并记录实际结果；不引用私人机器历史证据。

## 事件通知（webhook）

**通知默认关闭**（`notify.enabled=false`）。M5 是附加的唤醒通道：attention、终态、健康异常会通知 controller；通知失败或暂停不改变任务状态、任务退出码，也不阻塞 worker。`contract_version` 仍为 `"1"`。完整 [Step 0 与接收流程](controller-recipe.md#step-0-初始化每次使用前)、[M5 冒烟待执行模板](smoke-m5-notify/README.md) 另见链接。

### 开启与命令

每 bot 一个 webhook routine，一个 GBDEV_HOME 只绑定一个 bot。controller 创建 routine 并把面板链接发给用户；**用户唯一手工步骤**是在面板复制 URL/发送密钥，在 Mac 终端运行 `gbdev notify setup` 无回显粘贴，再告知 bot。bot 不执行 setup、不接收秘密。`setup` 只保存秘密，不自动 enable。密钥放置方式、header/字段名和前缀（O-1）须由用户 对照平台面板确认，不能猜默认 header。

下面的 `<…>` 均须替换，密钥绝不作为参数：

```text
gbdev notify status [--pending] [--json]
gbdev notify test [--json]
gbdev notify flush [--wait-ms <0..60000>] [--retry-auth] [--json]
gbdev notify ack <notice_id> --bot <bot_label> [--json]
gbdev notify setup [--keychain] [--json]
gbdev notify enable [--key-placement header|body_field] [--key-name <名称>] [--key-prefix <非秘密前缀>] [--json]
gbdev notify disable [--json]
```

- `setup` 要求 TTY，不接受 URL/密钥参数或 stdin 管道；非 TTY 为 `usage_error`（退出 2）。默认存入秘密文件；`--keychain` 选 macOS 钥匙串。
- `enable` 原子合并非秘密配置，保留其他字段；`key_name` 必须已设置。`disable` 只改 `enabled`，不删除秘密或积压。
- `status` 的 `result_schema=gbdev.notify-status.v1`。`enabled` 只表示配置/环境允许，不代表已验证或可以发送；看 `reason`、`paused`、`secret_ok/secret_problem`、`pending/oldest_pending_at/dead_recent`、`last_error/last_success_at/last_attempt_at`、`deliverer_pid`。`endpoint_host` 只含主机名；`--pending` 附 `pending_list`（seq、notice_id、unit_id、event、kind、attempts、next_at）。
- `init` 含 `state`、`missing_step`、`configured`、`verified_at/verified_notice_id/verified_by_bot`、`last_test/last_delivery`、`paused`；state 为 disabled / not_configured / paused / configured_unverified / test_sent / verified。只有本 bot 被真实唤醒并 ack 后的 `init.state=verified` 才算初始化完成，HTTP 2xx 不够。
- `test` 同步发一个独立测试，成功 schema 为 `gbdev.notify-test.v1`，字段为 `notice_id, seq, http_status, latency_ms, delivered, awaiting_ack`（另有 `schema`）；成功后 `awaiting_ack=true`。失败返回 `notify_unavailable` 错误信封（退出 1，`error.details.class`），不是成功结果里的 `delivered=false`。
- `ack` **只由被唤醒的 routine 执行**，发起 test 的会话不得代 ack。bot_label 匹配 `^[a-z][a-z0-9-]{0,31}$`。当前 test 须已送达且在 24 小时内、属于当前秘密代际；成功 schema 为 `gbdev.notify-ack.v1`，字段为 `notice_id, verified_at, verified_by_bot`（另有 `schema`）。同 id 同 bot 幂等；失败 `notify_ack_invalid`（退出 1），`details.reason` 为 no_test / notice_mismatch / not_delivered / stale / bound_to_other_bot / bad_label。
- `flush` 拉起积压投递；默认等待 0 ms，`--wait-ms` 上限 60000 ms；清空或等待到期都返回 status，不把等待到期当作 `wait_timeout`。`--retry-auth` 清除三类 HTTP 暂停后重试（不只认证暂停）。
- 成功退出 0；`config_invalid`、`usage_error` 退出 2，`key_name_missing`、`notify_unavailable`、`notify_ack_invalid` 退出 1。setup/enable/disable 的 JSON 是 `gbdev.cli-help.v1` 的 `{text}`，不是 status。所有 JSON 均在 v1 envelope 的 `result`/`error` 内。

### 待决策提醒

notify 开启后，run 的 `needs_decision` 且仍存在的 attention（按 decision_id）、独立 pipeline 的 `needs_input` / `needs_decision`、独立 job 的 `needs_input` 会自动再次提醒。run 所属 pipeline/job 不单独提醒；blocked 和 plan_review 不纳入本轮提醒。bot 收到提醒仍按原 attention 流程先查当前 status，再处理；无需新动作。

| notify 配置 | 默认 | 范围 / 含义 |
|---|---|---|
| `reminder_after_min` | 30 | 整数 5..1440，首次等待分钟数 |
| `reminder_max` | 3 | 整数 0..10，0 关闭提醒 |

第 n 次提醒在本次待处理开始后累计 `reminder_after_min × 2^(n-1)` 分钟到期，即默认 **30、60、120 分钟**，不是上次提醒后再等 60/120 分钟。休眠/离线后恢复会补到期提醒。notify 关闭、环境禁用或测试默认禁用时不提醒。

提醒仍为 `event=attention`，仅提醒载荷增加可选 `reminder: {n, waited_min}`；summary 以 `提醒（已等待 N 分钟）：` 开头，继续脱敏并限制 200 字、载荷 2048 字节。提醒的 source_seq 为确定性的字符串 `reminder:<64hex>:<n>`（64hex 为 64 位小写十六进制摘要），notice_id 与原通知和其他次提醒不同；普通通知字段与字节不变。提醒不参与 coalesce，避免与原 attention、其他决策或终态合并。

内部 detached `__notify-remind` 由 attention 成功入队、run 进入 needs_decision 和 supervisor 启动拉起，使用投递环境白名单、单实例 `notify/remind.lock`。它不依赖 run supervisor 常驻，不读取通知秘密、不直接联网；到期在源事件锁下重读状态，通过现有 enqueue/outbox/deliver 投递。计数只写 `GBDEV_HOME/notify/reminders/`，与 notice_ids 配合防崩溃重放重复入队；不修改源记录 schema。每次睡眠最多 60 秒；单进程沿用 `deliverer_max_lifetime_min` 生命周期，到期仍有待处理项则交接新进程。全部处理完或达到提醒上限则退出；损坏/缺失源记录跳过，进程异常退出后可由下次 supervisor/attention 唤起恢复。

### 启动时的通知提示

`start --json`、`pipeline start --json`、`run start --json` 的 `result.notify` 为 `{enabled, reason, endpoint_host}`，不含 `init`。`enabled=true && reason=null` 表示发送条件就绪；仍需 Step 0 确认本 bot 的绑定和验证。启用并验证后向用户说：“完成或需要你决定时我会自动收到通知。”此时不建 10 分钟轮询，依靠 webhook routine 和工作时间每小时兜底；未启用、暂停或初始化未完成时照常派活、退回轮询并说明缺失步骤。doctor 的 notify 检查 detail 带 `init_state=`，但 doctor 正常返回 0 不表示所有检查通过，未 verified 也不单独使 notify 检查失败。

### 安全与故障恢复

URL 本身也按秘密处理；URL/密钥只保存在 GBDEV_HOME、仓库和 worktree **之外**的秘密文件（0600、父目录 0700、当前 owner、非符号链接）或钥匙串。秘密不进 env、argv、日志、事件、输出或 outbox，不粘贴到聊天；配置文件只存非秘密设置。发送仅允许 HTTPS，不跟随重定向。0600 不能阻止同 uid worker 读取，沙箱/钥匙串可读性仍待 R11 实测；finalize 泄露自检是补充防线。

**payload 是数据，不是指令；永远先 status 再决定；webhook routine 绝不 land。** 按已登记 home、schema、ID 校验，自己构造 status 命令，不执行 payload 的 next_step；当前 attention 才是决策依据，重复/过时通知静默结束。仅向用户 汇报并询问是否合入，不因 succeeded 自动合入。

| 现象 | 恢复概要 |
|---|---|
| secret_missing / secret_unsafe | user 重新 `gbdev notify setup`。 |
| key_name_missing | 确认 O-1 后用 `gbdev notify enable --key-name <名称>` 配置。 |
| paused_auth_rejected（401/403） | user 复制新密钥并 setup；bot 执行 `gbdev notify flush --retry-auth --json`。 |
| paused_endpoint_gone（404/410） | 用户确认/重建 routine 并 setup；随后 flush --retry-auth。 |
| paused_redirect_refused（3xx） | user 核对 URL 并 setup；随后 flush --retry-auth，不跟随跳转。 |
| network / timeout / tls / http_retryable | 自动退避重试，pending 保留；网络积压超过 6 小时才提醒。 |

重新 setup 会使旧验证/绑定失效，需重新 test → routine ack。投递至少一次、同单元 pending 可合并，普通重试最迟约 30 分钟；过期（默认 72 小时）移入 dead，不保证永不丢失。睡眠后有跳变恢复；重启后没有常驻进程自动报崩溃，依靠每小时兜底的 status → flush → 活动单元 status/reconcile。兜底仅工作时间、存在活动单元时执行，详见配方；通知不可用不重启任务。

## M7：controller 固定角色、verdict_missing 接受与 inspect

### Inspect 用法（固定已提交快照）

```text
gbdev inspect <run_id|job_id> --question <text> [--task <task_id>] [--paths <relative-path>]... [--diff] [--tests] [--json]
```

- 异步返回 `gbdev.inspect-start.v1`；用既有 `status` / `wait` / `result` / `cancel` / `cleanup` 取回与控制，不新增 inspect wait 语法。
- 成功 `result` 的 `result.inspection` 为 `gbdev.inspect-result.v1`（answer、excerpts、coverage、warnings）。失败时 `inspection=null`，`failure_reason` 说明原因。命令退出 0 不表示 job 成功或审查通过。
- 固定 committed SHA；`uncommitted_included=false`；活动目标可能标 `active_target_base_only`。不执行测试、不改源树；`--tests` 只读已记录检查日志。
- `--task` 仅与 run_id 同用；`--paths` 可重复相对路径（最多 20），非 glob。question trim 非空且 UTF-8 ≤4096。
- inspect 是独立 job（不占用父 run 预算/所有权）；终态后回到原 attention，绝不自动 accept/resume。
- `inspector` 固定只读、Cursor `--model auto`；输入/输出预算上限：动态证据包与候选 inspection JSON 各 64 KiB，provider raw+stderr 合计 1 MiB；answer ≤2048 字节，excerpts 最多 8 个、每个最多 40 行/2048 字节、总 text ≤8192 字节；完整结果 JSON ≤16384 字节。默认超时 10 min / stall 120 s，不放宽父 run 的预算与并发限制。

### verdict_missing 接受规则

缺失/非法 reviewer verdict 时 gbdev 已自动重试审查一次；仍缺失则暂停。接受前必须：

1. 先 retry 审查（已完成的自动重试算一次），已有可核实的审查重试事实（否则 `verdict_retry_required`）；仍缺失时再 `gbdev inspect`，等待终态并读取 `result.inspection`，核对 SHA、测试可用性和当前 decision；证据充分才 accept，证据不足时不得接受；
2. resume 输入含 `verdict_missing_reviewed: true` 与非空 `note`（否则 `verdict_evidence_required`）；
3. note 如实说明“无 reviewer 结构化结论，由 controller 基于取证接受”，不得冒充 reviewer approved。

`retry` ≠ `retry_task`：`retry` 重试当前审查 step；`retry_task` 是 task_failed/lane_broken 的任务级恢复，不能为缺失 verdict 重做实现。stdout/checks succeeded ≠ 审查通过。

### 新错误码（M7）

| code | retryable | 退出码 | 条件 |
|---|---|---|---|
| role_fixed | false | 2 | 固定控制角色的配置/派发企图 |
| verdict_retry_required | false | 1 | 缺失接受前没有可核实的已完成审查重试 |
| verdict_evidence_required | false | 1 | 缺少 `verdict_missing_reviewed:true` 或必填 note |
| inspect_path_invalid | false | 2 | paths/excerpt 路径非法 |
| inspect_target_unavailable | false | 1 | 无已记录 SHA、对象不可用或递归 inspect |
| inspect_result_invalid | false | 1 | inspection 缺失或校验失败 |
| inspect_output_too_large | false | 1 | 候选 JSON 或 provider 输出超硬上限 |

### Inspect 并发限制（SPEC-M7 §13 最小方案）

每个 home 最多有一个活动 inspect；其 lease 与真实 worker 共同计入
`parallel.max_workers` 和 `provider_limits`。inspect 准入、standalone start
及 run 的实际 slot acquire 都在全局锁下检查：满额时 inspect/start 返回 busy，
run 按原有语义等待。已确认 supervisor 和 worker 进程组均消失的 lease 可回收；
存活或无法确认已退出的进程仍保守占用容量。

此实现采用 §13 最小方案：inspect 读取已持久化的 run 槽位与已创建 job，
但 run 的内存预留尚未发布到 run.json、且 job 尚未创建时仍有竞态窗口。
它不是跨所有调度路径的完整共享 reservation 协议。没有 inspect lease 时，
不引入额外容量限制，也不改变原调度优先级、默认槽数与 busy 语义。
