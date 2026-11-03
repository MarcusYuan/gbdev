> Historical design specification. Milestone labels describe design evolution; consult README.md and docs/reference.md for current behavior. Private execution records are not release certification.

# gbdev M1 实现规格（给 Codex）

> M9 网络策略注记：M9 起 `network` 默认 `true`，可显式 `false`；下文禁网/仅 false 的描述保留为历史规格，不代表 M9 当前行为。inspect 固定联网查资料，但仍禁止 tests/scripts/installs/hooks；其余当前边界见 README 的网络策略说明。

> 版本：M1-spec v1 · M2-R1 遗留修复 · R7 Cursor stream-json 与无输出看门狗修复（保留 R6 修复与 R2 终态契约）· 2026-10-25（PDT）
> 设计文档（完整背景）：https://cursor.com/canvas/store-d81ff4fb-5a93-4888-8aaa-386adeaab254/ceae036d-2608-40ce-b831-f49ea7635263
> 本文自包含：实现 M1 只需要读这一份。标注「待验证」的 CLI 参数，请先跑 `--help` 确认，不要凭记忆猜。

## 0. 你（Codex）在本次实现中的边界（必须遵守）

你是被 controller 用 `codex exec` 派来的 worker。你不能和用户或 controller 对话，只能通过最终消息交付结果。

可以：
- 在仓库 `/path/to/gbdev` 内创建、修改、删除文件。
- 运行本地命令：`node`、`npm test`、`npx tsc`、`git status`、`git diff`、`git add`、`git commit`。
- 在分支 `gbdev-m1` 上本地提交，提交信息用 Conventional Commits（如 `feat(cli): add start command`），一个逻辑改动一个提交。

不可以：
- `git push`、`git merge` 到 master、改写 master、`git config` 改全局配置。
- 全局安装：`npm i -g`、`npm link`、`brew install`、改 `~/.zshrc` 等。
- 读取或打印任何凭证：`~/.codex/`、`~/.cursor/`、`~/.ssh/`、钥匙串、环境变量里的 token。
- 访问网络（依赖已由 controller 预先安装；如果缺依赖，停下并在结果里报告 blocker，不要自己装）。
- 修改仓库以外的任何路径（测试用临时目录用 `fs.mkdtemp(os.tmpdir())`，测试结束删除）。
- 在真实环境里调用 `codex` 或 `cursor-agent` 跑测试；测试一律用 fake provider。

遇到需要决策的问题：不要猜。做完能做的部分，提交，然后在最终消息的 `open_questions` 里写清楚问题和可选项，退出。

结束时，最终消息的最后必须是一个 ```json 代码块，内容符合 `gbdev.worker-result.v1`（见 §4.4）。

> 当前实现已包含 M2-S1 角色注册表、M2-S2 契约库以及 M2-S3/S4 流水线（共享 worktree、gate、并发槽、reconcile、fix loop/resume 与全局预算）；M2-S5 代码与文档已完成（README 配方、命令 JSON、docs/smoke 请求及安全回归），真实冒烟 AC-S5.1 尚待调度者执行，不代表已验收。standalone schema 保持 M1 字节不变。历史 M1 范围与实施说明保留作参考。

## 1. 背景与 M1 范围

gbdev 是跑在用户 Mac 上的命令行工具。controller（调度者）通过 shell 调用它，每条命令都要用户批准。gbdev 负责：为一个 job 建 git worktree、启动一个本机 worker（`codex exec` 或 `cursor-agent -p`）、监控、收集结果、做机械检查。gbdev 不做任何判断（不拆任务、不评价质量、不合并到主分支）。

M1 = 单 worker、单 job：
- 命令：`gbdev doctor | start | status | wait | result | cancel | cleanup`
- 每个 job 一个 worktree 和分支 `gbdev/<job_id>`
- 两个 provider：`codex`、`cursor`；另加测试用的 `fake`
- JSON 契约：envelope + 6 个 schema（§4）
- job 目录布局（§5），最小配置（§6）
- 同一时刻最多 1 个运行中的 job（`concurrency = 1`）

## 2. 明确不做（M2/M3）

- 角色注册表、提示词模板库、`gbdev roles`（M2）
- 流水线、关口、`gbdev task`、`gbdev pipeline`（M2）
- 集成分支、合并、`gbdev integrate`（M3）
- 状态 `reviewed`、`integrated`、`discarded` 的转换（schema 里保留枚举值，M1 不产生）
- 并发 > 1、排队调度器、tmux 交互模式、MCP 服务、云端 agent
- YAML 配置（M1 只用 JSON，避免依赖）
- `codex exec resume` / `cursor-agent --resume` 续聊（M1 的追问用「新 job + parent_job_id」实现）

## 3. 技术栈与工程约束

- TypeScript（`strict: true`），Node 24（用户机器：v24.15.0，经 nvm）。
- 运行时依赖：**零**。只用 Node 内置模块（`node:fs`、`node:child_process`、`node:path`、`node:util` 的 `parseArgs`、`node:crypto`、`node:test`）。
- 开发依赖：`typescript`、`@types/node`（由 controller 预装）。不引入 vitest、commander、yaml、zod。理由：工具小、要跑在用户机器上、减少供应链面。
- 构建：`tsc` 输出到 `dist/`；入口 `dist/cli.js`，首行 `#!/usr/bin/env node`。
- `package.json`：`"type": "module"`，`"bin": { "gbdev": "dist/cli.js" }`，脚本 `build`、`test`（`tsc && node --test dist/test/`）、`typecheck`。
- 平台：macOS 优先；代码不要写死 macOS 专有路径。`caffeinate` 存在时才用。
- 所有子进程用 `spawn`/`execFile` 传 argv 数组，**不拼 shell 字符串**。
- 所有 git 分支名和 job_id 用正则 `^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$` 校验。

## 4. JSON 契约

### 4.1 Envelope（所有 `--json` 输出）

stdout 只输出一个 JSON 对象，末尾换行；stderr 为空（调试日志写到 job 目录或 `GBDEV_DEBUG=1` 时写 stderr）。

```json
{ "contract_version": "1", "ok": true, "command": "start",
  "result_schema": "gbdev.job-status.v1", "result": { } }
```
```json
{ "contract_version": "1", "ok": false, "command": "start",
  "error": { "schema": "gbdev.error.v1", "code": "provider_not_found", "message": "…",
             "retryable": false, "details": {}, "next_steps": ["…"] } }
```

退出码：`0` ok；`1` 运行失败（error.code 非 usage/config 类）；`2` 用法或配置错误（`usage_error`、`config_invalid`、`role_invalid`、`cursor_model_not_allowed`）。

### 4.2 gbdev.task-brief.v1（controller → gbdev，`start --brief <file|->`）

```json
{
  "schema": "gbdev.task-brief.v1",
  "brief_id": "b_20261025_1130_x1",
  "repo": "/Users/alice/workspace/some-repo",
  "base_ref": "HEAD",
  "role": "executor",
  "provider": "codex",
  "model": null,
  "sandbox": "workspace-write",
  "timeout_min": 30,
  "stall_timeout_s": 600,
  "network": false,
  "goal": "给 /health 接口加版本号字段",
  "context": "服务入口在 src/server.ts；版本号从 package.json 读",
  "constraints": ["不加新依赖", "不改 CI 配置"],
  "allowed_paths": ["src/**", "test/**"],
  "acceptance_criteria": [
    { "id": "AC1", "text": "GET /health 返回 version 字段", "check_cmd": "npm test" }
  ],
  "required_evidence": ["tests", "diff_summary"],
  "parent_job_id": null,
  "answers": []
}
```
校验规则：`schema` 必须匹配；`provider ∈ {codex, cursor, fake}`；`sandbox ∈ {read-only, workspace-write}`；`role` M2-S1 接受所有有效注册角色（code-reviewer → reviewer）；provider/sandbox 可省略并从角色补齐，显式值须符合角色 allowed_providers/sandbox，否则 config_invalid，details.code 为 role_provider_not_allowed/role_sandbox_mismatch；`allowed_paths` 非空；`timeout_min` 1–240；可选 `stall_timeout_s` 为非负安全整数秒数（0 关闭），timeout_min/stall_timeout_s 未提供则先取角色默认，再取 config 默认（完整角色均有默认值）；Codex model 省略时取角色 codex_model，Cursor 仍只接受 null/auto；start 将有效值固定在保存的 brief.json 中；`repo` 必须在配置白名单内；`network` M1 只能为 `false`。`acceptance_criteria[].check_cmd` 可省略，省略时只保留 id/text，不执行检查。`answers` 用于追问后的后续 job：`[{ "question_id": "Q1", "answer": "…" }]`。

### 4.3 gbdev.job-status.v1（`start`/`status`/`wait`/`cancel` 的 result）

```json
{
  "schema": "gbdev.job-status.v1",
  "job_id": "j_20261025_1131_a7f3",
  "state": "running",
  "provider": "codex", "role": "executor", "sandbox": "workspace-write",
  "repo": "/Users/alice/workspace/some-repo",
  "worktree": "/Users/alice/.gbdev/worktrees/some-repo/j_20261025_1131_a7f3",
  "branch": "gbdev/j_20261025_1131_a7f3",
  "base_sha": "9c1e4b2…",
  "pid": 48121,
  "session_id": null,
  "created_at": "2026-10-25T11:31:02-07:00",
  "updated_at": "2026-10-25T11:33:40-07:00",
  "deadline_at": "2026-10-25T12:01:02-07:00",
  "state_history": [
    { "state": "queued", "at": "…", "by": "gbdev" },
    { "state": "starting", "at": "…", "by": "gbdev" },
    { "state": "running", "at": "…", "by": "gbdev" }
  ],
  "last_event": { "seq": 41, "type": "worker_output", "at": "…" },
  "parent_job_id": null,
  "pipeline_id": null, "step_instance": null, "attempt": null,
  "failure_reason": null, "failure_reasons": []
}
```
`session_id` 是可选的 `string | null`：尚未捕获或 provider 不提供时为 null，旧 v1 缺失时读取补 null，不改写原文件。Cursor 取 stdout 单对象或多行 JSON 事件中最后一个顶层非空字符串 session_id；Codex 取原始事件 raw.jsonl 中 thread.started 的 thread_id。start/status/wait/cancel 的 --json 均包含该字段（含 status 列表），成功/失败均保留，M1 不 resume。

`pipeline_id: string | null`、`step_instance: string | null`、`attempt: 正整数 | null` 为关联字段：standalone 新 job 均写 null，旧 job 读取补 null，不改写原文件。M2-S3 step job 填入所属 run、实例和 attempt。`failure_reasons: string[]` 与 result 同步，规则见 §8.7。

异常恢复（reconcile 或 supervisor 失败收尾）时，若 status.session_id 为 null，则用同一套 provider 解析函数从已落盘输出补取，并随失败终态同时写入 job.json 和 result.json；已有 ID 不覆盖。优先 Cursor 的 raw.json / Codex 的 raw.jsonl，再尝试另一 raw 文件及 legacy events.jsonl；忽略缺失、不可读、损坏或不含可用 ID 的输出，仍未知则保持 null，不因元数据恢复失败抛错。正常的规范化 events.jsonl 不复制原始会话事件。

`state` 枚举：`queued | starting | running | needs_input | blocked | succeeded | failed | cancelled | timeout | reviewed | integrated | discarded`（后三个 M1 不产生）。时间一律带本地偏移的 ISO 8601。

### 4.4 gbdev.worker-result.v1（worker → gbdev，纯 JSON 或最后一个 json 围栏）

```json
{
  "schema": "gbdev.worker-result.v1",
  "status": "succeeded",
  "summary": "在 /health 返回体中加入 version，补了 2 个测试",
  "files_changed": ["src/server.ts", "test/health.test.ts"],
  "commits": ["3f2a9c1 feat(health): include version"],
  "tests": [ { "cmd": "npm test", "exit_code": 0, "passed": 12, "failed": 0 } ],
  "evidence": [ { "criterion_id": "AC1", "kind": "test", "ref": "test/health.test.ts", "note": "断言 version 存在" } ],
  "open_questions": [],
  "blockers": [],
  "policy_violations": []
}
```
M2-S2 新增可选 `handoff`、`review` 的结构校验与归一化，详见 SPEC-M2 §6.4；standalone Codex schema 保持 M1 字节不变，缺省不要求输出新增字段。

`status ∈ {succeeded, needs_input, blocked, failed}`。`open_questions[]`：`{ "id": "Q1", "question": "…", "options": ["A","B"], "default": "A", "blocking": true }`。`blockers[]`：`{ "kind": "missing_dependency|permission|env|other", "detail": "…" }`。

提取规则：先尝试整条消息为 JSON 对象（Codex `--output-schema` 的纯 JSON 输出）；否则只提取最后一个 json 围栏块。最后一块非法或未闭合时直接报错，不回退到更早的有效块。无报告为 `worker_result_missing`（只读交付例外见 §8.7），非法 JSON 或字段为 `worker_result_invalid: <字段错误>`。

运行时对已知变体做宽松归一化：commits 的 `{hash,message}` 转为短 hash + message 字符串；tests 的 command/check 转 cmd，status passed/failed 转 passed 布尔值，缺失 exit_code 时由 status 推导；evidence 的 type/command/output/detail 转为标准字段，缺失 criterion_id 使用 unspecified；缺失数组补 []，未知字段忽略。每次转换记录到 job-result 的 `worker_result_warnings: string[]`，规范输入不产生警告；非法字段仍拒绝，原始输出保留。

Codex 严格 output schema 在 job 目录生成，所有 object 都设置 `additionalProperties:false`，所有 properties 都列入 required。因此 Codex 的 `tests[].passed`、`tests[].failed` **必须是非负整数计数**（不是布尔值），prompt 的 Final response 也明确要求；没运行测试时用 `tests: []`。运行时校验器为兼容 Cursor 继续接受计数省略及 passed 布尔值（failed 若提供仍须为非负整数）。

为什么用最终消息而不是文件：只读 sandbox 下 worker 不能写文件；`codex exec --output-last-message` 由 CLI 本身写到 job 目录，worker 不需直接写文件。

### 4.5 `gbdev result` 的 result（gbdev 汇总，worker 自述与 gbdev 观察分开）

```json
{
  "schema": "gbdev.job-result.v1",
  "job_id": "j_…", "state": "succeeded", "session_id": null, "worker_exit_code": 0, "duration_s": 812,
  "worker_reported": { "...": "归一化后的 gbdev.worker-result.v1，解析失败时为 null" },
  "worker_result_warnings": [],
  "failure_reason": null,
  "failure_reasons": [],
  "gbdev_observed": {
    "head_before": "9c1e4b2", "head_after": "3f2a9c1",
    "commits": ["3f2a9c1 feat(health): include version"],
    "files_changed": ["src/server.ts", "test/health.test.ts"],
    "outside_allowed_paths": [],
    "worktree_dirty_at_exit": false,
    "snapshot_commit": null,
    "checks": [ { "id": "AC1", "cmd": "npm test", "exit_code": 0, "log": "checks/AC1.log" } ],
    "policy_violations": []
  },
  "paths": { "final_message": "…/final.md", "diff": "…/diff.patch", "events": "…/events.jsonl", "worker_log": "…/worker.log" }
}
```

`worker_reported` 是归一化后的报告，不是原始消息；原始 final.md/raw 输出保留。status 和 result 都暴露 `failure_reason`：新产生的 failed/blocked/timeout 为非空原因，succeeded/needs_input/cancelled 为 null；具体优先级见 §8.7。历史 v1 文件缺少新增字段时，仅在读取时补空 warnings，failed/blocked 的未知原因为 `legacy_failure_reason_missing`、timeout 为 `timeout`，不改写文件、不重判状态。`session_id` 为可选的 `string | null`，来源及语义同 §4.3；新结果始终包含该字段，未知为 null，旧 v1 缺失时仅在读取时补 null。成功、失败及异常恢复结果均保留已捕获的会话 ID，`gbdev result --json` 直接暴露。

### 4.6 gbdev.event.v1（`events.jsonl` 每行一个）

```json
{ "schema": "gbdev.event.v1", "job_id": "j_…", "seq": 41, "at": "…",
  "source": "gbdev|worker", "type": "state_change|worker_output|warning|heartbeat|check",
  "data": { } }
```
追加前若 events.jsonl 非空且最后一个字节不是换行，先补一个 `\n`，避免旧事件与新事件粘连（包括崩溃恢复）。provider 的原始 stdout 另存 `raw.jsonl`（codex `--json`）或 `raw.json`（cursor `--output-format stream-json`，内容为 JSONL，每行一个对象，文件名不变）。`events.jsonl` 只放规范化事件：状态变化、每 N 条原始事件一条 `worker_output` 摘要、警告、检查结果。

### 4.7 gbdev.error.v1 错误码

| code | retryable | 场景 |
|---|---|---|
| usage_error | false | 参数错误（退出码 2） |
| config_invalid | false | 配置或 brief 不合法（退出码 2） |
| repo_not_allowed | false | repo 不在白名单 |
| repo_no_commits | false | 目标仓库没有任何提交，无法建 worktree |
| busy | true | 已有运行中的 job（M1 并发 1），附 `details.running_job_id` |
| provider_not_found | false | 找不到 codex / cursor-agent |
| cursor_model_not_allowed | false | Cursor brief.model 非 null/auto；建 job 前拒绝，退出码 2 |
| provider_not_logged_in | false | 保留错误码；doctor 通过检查项报告登录状态/退出码，不因此返回错误 envelope |
| worktree_failed | false | git worktree add 失败 |
| job_not_found | false | |
| job_not_terminal | true | 对运行中的 job 调 result/cleanup |
| wait_timeout | true | `wait` 等待超时（job 仍在跑，不是失败） |
| worker_crashed | false | 进程异常退出 |
| worker_stalled | true | stdout/raw 与 stderr 在 stall_timeout_s 内均未增长；作业 failed，可重试 |
| result_missing / result_invalid | false | 最终消息缺失或无法提取/校验合法报告（纯 JSON 或最后一个 json 围栏） |
| cleanup_refused | false | worktree 有未提交改动（即使给 `--force-branch` 也拒绝）或 Git 拒绝删除 worktree；有作业提交且未合并到任何其他本地分支时默认保留且清理成功，不因此报错 |
| internal_error | false | 其他 |

cleanup 的 `branch_retained_reason`：`checked_out | unmerged_job_commits | delete_failed_retry_safe | null`；未保留时为 null。未合并作业提交默认保留时为 `unmerged_job_commits`；ref 删除失败仍返回原有 internal_error envelope，`details` 中带 `branch_retained:true` 和 `branch_retained_reason:"delete_failed_retry_safe"`（不转换为成功）。人类可读输出追加 `branch kept: <reason>`；unmerged_job_commits 附 `use --force-branch only with user approval`。旧 cleanup JSON 省略此字段仍有效。

cleanup 的分支策略（与 §7 的 dry-run 共用）：

- 决定是否删分支之前，所有路径（无作业提交、已合并、force，含 dry-run）统一执行一次 `git worktree list --porcelain -z`。只要主仓库或任何 worktree 仍检出该分支，就保留；仅排除本次即将移除的作业 worktree。返回 ok:true、branch_retained:true、branch_retained_reason:"checked_out"，本次移除作业 worktree 时 worktree_removed:true；dry-run 同样返回 would_delete_branch:false，不因检出而报错。

- 实际清理在移除作业 worktree 后、`update-ref -d` 前再次执行 `git worktree list --porcelain -z`，此时不排除任何 worktree；若该分支被检出则保留，返回 ok:true 与 `branch_retained_reason:"checked_out"`。旧 tip 校验继续保留。二次检查缩小但不能原子消除外部 Git 操作的竞态窗口。
- 分支 tip 等于 job.base_sha 表示没有作业提交；即使 base 已不被其他分支包含，也用 `git update-ref -d refs/heads/<branch> <base_sha>` 删除，并返回 branch_deleted:true。旧值校验失败不重试、不误删并发移动的分支。
- 有作业提交且 tip 被其他本地分支包含时，用 `git update-ref -d refs/heads/<branch> <tip>` 旧值校验删除；不依赖 `git branch -d` 的 HEAD/upstream 判定，也不修改仓库配置。
- 有作业提交且未合并到任何其他本地分支时，默认不执行分支删除，返回 ok:true、worktree_removed:true（本次确实移除时）、branch_retained:true；显式 `--force-branch` 时也用 `git update-ref -d refs/heads/<branch> <tip>` 旧值校验删除。
- 不再依赖 brief.base_ref 的当前值决定分支保留，job 目录始终保留。若 worktree 已删除而后续步骤失败，返回 internal_error，details 必须包含 worktree_removed:true；删除前失败则为 false。ref 锁或旧值不符等删除失败还包含 details.retry_safe:true（internal_error.retryable 仍为 false），分支保留，可重新检查后重试。cleanup_refused 仅用于脏树或 Git 拒绝删除 worktree 等真正的 worktree 清理拒绝。

## 5. 目录布局

```
~/.config/gbdev/config.json        # 最小配置（§6）
~/.gbdev/
  jobs/<job_id>/
    job.json        # 状态（唯一真相，原子写：写 tmp 再 rename）
    brief.json      # 校验后的 brief 副本
    provider.json   # 固定的可执行路径 bin 与 writable_roots（可写仅工作树，只读为 []，不授权 Git common dir，见 §9）
    prompt.md       # gbdev 渲染给 worker 的提示词
    raw.jsonl       # codex 原始事件（fake 测试也使用）
    raw.json        # cursor 原始输出，JSONL 内容（文件名保持不变）
    supervisor.log  # supervisor 的 stdout/stderr
    worker-result.schema.json # codex 严格 output schema
    events.jsonl    # gbdev.event.v1
    worker.log      # provider stderr
    final.md        # worker 最终消息
    diff.patch      # base_sha..HEAD 的 diff（含 snapshot 提交）
    checks/<id>.log # acceptance_criteria.check_cmd 的输出
    result.json     # gbdev.job-result.v1
  worktrees/<repo_name>/<job_id>/  # git worktree
  lock              # 全局锁（O_EXCL 创建，内容为 pid；陈旧锁按 pid 是否存活回收）
```
`GBDEV_HOME` 环境变量可覆盖 `~/.gbdev`（测试必须用它）。job_id 格式：`j_YYYYMMDD_HHMM_<4位hex>`。

## 6. 最小配置 `~/.config/gbdev/config.json`

```json
{
  "version": 1,
  "allowed_repos": ["/Users/alice/workspace/some-repo"],
  "providers": {
    "codex":  { "bin": "/opt/homebrew/bin/codex" },
    "cursor": { "bin": "~/.local/bin/cursor-agent" }
  },
  "default_timeout_min": 30,
  "default_stall_timeout_s": 600,
  "concurrency": 1
}
```
`default_stall_timeout_s` 为非负安全整数秒数，默认 600，0 关闭无输出看门狗；brief.stall_timeout_s 显式值（含 0）优先，保存后不受配置变化影响。旧 job 的 brief 若缺失此字段则使用 600。

缺省时：`bin` 从 PATH 查；`allowed_repos` 为空则拒绝所有 repo（安全默认）。`GBDEV_CONFIG` 可覆盖路径。可选 `providers.cursor.model` 只允许 `"auto"`（否则 cursor_model_not_allowed）；Cursor brief.model 只允许 null 或 `"auto"`，两者均传 `--model auto`。

## 7. 命令行为

所有命令支持 `--json`；不加时输出简短人类可读文本。

- `gbdev roles list --json`：返回 gbdev.role-list.v1（roles 摘要、invalid、aliases），无效文件不影响其他角色，仍退出 0；`gbdev roles show <name> --json` 返回合并的 gbdev.role.v1 + source + instructions_text。未知角色 role_not_found（1），无效角色 role_invalid（2），Cursor 非 auto 为 cursor_model_not_allowed（2）。加载 dirname(config.json)/roles，覆盖浅合并且失败不回退内置；完整规则见 SPEC-M2 §4。
- `gbdev doctor --json`：新增 roles 检查，列出无效文件及摘要；检查 node 版本、git 版本（≥ 2.38，用户机器 2.50.1）、codex 和 cursor-agent 的路径与 `--version`、tmux 是否存在（只报告）、配置是否合法、`GBDEV_HOME` 可写。登录状态：只运行 `codex login status`、`cursor-agent status`，以退出码判断 ok；detail 仅含 exit_code（及 signal），不包含登录命令 stdout/stderr 中的账号身份等输出；**不读取任何凭证文件**。result：`{ "checks": [{ "name", "ok", "detail" }] }`。每个子进程（Git、provider 版本/登录、tmux -V）均设置 10,000 ms 超时与 SIGKILL；超时检查为 ok:false、detail:{"timed_out":true}，doctor 整体仍返回 ok envelope，正常 detail 仍为字符串。
- `gbdev start --brief <file|-> --json`：读 brief（`-` 表示 stdin）→ 校验 → 取锁 → 检查 busy → 建 job 目录（`queued`）→ `git worktree add -b gbdev/<job_id> <wt> <base_ref>`（`starting`）→ 渲染 prompt.md → 以 detached 方式启动 supervisor（`process.execPath dist/cli.js __supervise <job_id>`，`detached: true`，stdio 到文件，`unref()`；有 `caffeinate` 时用 `caffeinate -i` 包裹）→ 立即返回 job-status（`starting` 或 `running`）。
- `__supervise <job_id>`（内部命令，不对外文档化）：启动 provider 进程（独立进程组）→ `running` → 写事件 → 超时则对进程组 SIGTERM，10 秒后 SIGKILL，`timeout` → 同时按 brief.stall_timeout_s 监测 stdout/raw 与 stderr（worker.log）增长，无输出超时则记 warning（code:worker_stalled、retryable:true），沿用取消的进程组 SIGTERM/10 秒后 SIGKILL 流程，终态 failed、failure_reason=worker_stalled；0 关闭，只在 worker 运行阶段监测，不覆盖验收检查 → 进程退出后执行 §8 的收尾 → 写 result.json 与终态。
- `gbdev status [<job_id>] --json`：无参数时列出所有 job 的 job-status 数组（按创建时间倒序，最多 50 个）。如果 job.json 显示 running 但 supervisor pid 已不存在，标记 `failed`（`worker_crashed`）。
- `gbdev wait <job_id> --timeout-ms <n> --json`：轮询 job.json（500ms），到终态返回 job-status；到超时返回 `wait_timeout` 错误（retryable）。
- `gbdev result <job_id> --json`：终态才可用，返回 job-result.v1。
- `gbdev cancel <job_id> --json`：对进程组发 SIGTERM（同上升级），状态 `cancelled`，by=`grok-bot`。对终态 job 无副作用，原样返回。
- `gbdev cleanup <job_id> [--force-branch] [--dry-run] --json`：要求终态。worktree 干净才 `git worktree remove`（不加 `--force`）；脏的保留并返回 `cleanup_refused`。分支策略见 §4.7：无作业提交时旧值校验删除；有作业提交且已被其他本地分支包含时安全删除，否则默认保留，`--force-branch` 才强制删（controller 只在用户同意后使用）。job 目录保留。`--dry-run` 执行同样的终态、脏工作区、分支策略检查，但不 reconcile、不删除、不改写 job/result；非终态或脏工作区仍报错，可与 `--force-branch` 组合。预演返回 `dry_run:true`、`would_remove_worktree`、`would_delete_branch`，实际 `worktree_removed/branch_deleted` 均为 false；`branch_retained = branchExists && !deleteBranch` 表示计划清理后是否保留分支，和真实清理一致（并发变化或 Git 锁等执行时错误仍可能使操作失败）。

Git 辅助函数接受可选 timeout（毫秒），默认 120,000 ms，worktree add 使用 300,000 ms；超时用 SIGKILL 并抛 internal_error，details.git_timeout:true；错误信息说明可能残留 index.lock/HEAD.lock，不自动删锁。

## 8. 收尾检查（gbdev 只做机械事实，不做判断）

worker 进程退出后按顺序：
1. 读 final.md，按 §4.4 提取纯 JSON 或最后一个 json 围栏并归一化校验为 worker-result.v1；失败则 `worker_reported = null`，记录具体解析原因。
2. `git status --porcelain`：若有未提交改动且 sandbox 为 `workspace-write`，由 gbdev 依次用 argv 执行 `git -c core.hooksPath=/dev/null add -A` 和 `git -c core.hooksPath=/dev/null commit --no-verify -m "gbdev: snapshot <job_id>"`（另设本次提交的作者与禁用签名），记录 `snapshot_commit`。这是 workspace-write executor 产出提交的正式路径；worker 不负责提交。gbdev 的所有 Git 调用统一走带 `-c core.hooksPath=/dev/null` 的辅助函数，覆盖 add/commit、worktree 与 ref 操作及隐式 index 刷新；`--no-verify` 不会屏蔽 post-commit，git add 也可能触发 post-index-change，因此必须统一覆盖 hooksPath。worker 若已有提交照常记录，剩余脏树仍 snapshot。
3. 计算 `head_after`、`base_sha..HEAD` 的提交列表和改动文件列表，写 diff.patch。
4. `outside_allowed_paths`：改动文件不匹配 `allowed_paths` 任一 glob 的列表（用 `path.matchesGlob`，若在 Node 24 下不可用则自写 `**`/`*` 匹配，二者都要有测试）。
5. sandbox 为 `read-only` 时：HEAD 变化或 worktree 变脏 → policy_violation `readonly_modified`（不做 snapshot 提交）。
6. 依次在 worktree 里运行 `acceptance_criteria[].check_cmd`（用 `/bin/sh -c`，因为这是 brief 作者给的命令；超时 10 分钟；输出写 checks/；省略 check_cmd 则跳过）。
7. 终态判定（§8.7，纯规则）：状态与 failure_reason 同时按下表从高到低取首个匹配项；所有检查结果仍如实记录在 `gbdev_observed.checks`。

| 优先级 | 条件 | 终态 | failure_reason |
| --- | --- | --- | --- |
| 1 | forced：timeout / cancelled / worker_stalled / supervisor 强制 failed | timeout / cancelled / failed / failed | timeout / null / worker_stalled / worker_crashed（异常恢复可附具体异常） |
| 2 | worker 自报 needs_input 或 blocked（即使非零退出、provider/检查失败或违规） | 原样透传 | needs_input 为 null；blocked 为 `worker_blocked: <阻塞详情或 no detail>` |
| 3a | provider 明确失败（§9，Cursor trust 错误或失败元数据） | failed | `provider_trust_required` 或 `provider_error: <非 success subtype 或 is_error>` |
| 3b | worker 已 spawn 且 close，退出码非 0（含 signal 导致 null；从未启动或尚未 close 不命中） | failed | `worker_exit_nonzero:<code>`（null 写为 null） |
| 3c | worker-result 缺失 / 非法（下述只读交付例外除外） | failed | `worker_result_missing` / `worker_result_invalid: <字段错误>` |
| 3d | gbdev 观察到违规（outside_allowed_paths / readonly_modified 等） | failed | `policy_violations: <观察到的违规列表>` |
| 3e | worker 自报 policy_violations 非空 | failed | `policy_violations: <worker 自报的违规列表>` |
| 3f | worker 自报 failed | failed | `worker_reported_failed` |
| 4 | 任一 check_cmd 退出码非 0（含 null） | failed | `check_failed:<id>`，按检查顺序取首个失败 |
| 5 | 否则 | succeeded | null |

**启动失败**：start 创建 job 后启动失败时，failure_reason 为 start_failed: 加错误摘要，failure_reasons 是同一主因的单元素数组，不虚构未启动 worker 的退出码。

**完整失败原因（M2-R1）**：新 job-status/job-result 均包含 `failure_reasons: string[]`。按上表 3a→3f→4 收集所有命中的原因，检查失败逐条按检查顺序列出；forced、needs_input、blocked 仍保有原优先级，不丢弃这些低优先级观察事实。succeeded 的数组恒为 []。failure_reason 保留原优先级（不是无条件等于数组首项），仅有以下只读特例：read-only、报告仅缺失（不是 invalid）、其他 3x 均不命中但检查失败时，主因改为首个 `check_failed:<id>`，warnings 加 `worker_result_missing`；数组仍为 `["worker_result_missing", "check_failed:<id>", ...]`。无效 JSON、非零退出、provider 失败、违规或 workspace-write 不适用此特例。旧 job/result 未含数组时，failed 补 `[failure_reason]`（必要时先补历史主因），其他状态补 []，不重判、不改写原文件。

**只读交付例外**：sandbox=read-only、worker_exit_code=0、final.md 非空（去除空白后）、worker-result 仅缺失而非非法、provider 未明确失败、无 policy_violations、无文件改动（HEAD 不变且工作树干净）、所有 checks 通过时，state=succeeded、failure_reason=null、worker_reported=null，worker_result_warnings 加入 "worker_result_missing"，保留原 result_missing warning 事件，final.md 即交付物。workspace-write 缺报告仍 failed/worker_result_missing；空交付、非法 JSON、非零退出、违规或检查失败均不放行。failure_reason 枚举除表中各项外含 worker_stalled（retryable:true，见 §4.7）；其 forced 优先级与 timeout 相同，后到的取消不覆盖已触发的 stall。

worker 的提问/阻塞信号优先上抛给调度者，由调度者决定下一步；它不抹去检查、退出码与违规的观察事实。缺少 provider 失败字段不构成 provider 失败，不能覆盖 worker-result 的具体解析原因。

## 9. Provider 适配器

接口（`src/providers/types.ts`）：
```ts
export interface ProviderAdapter {
  name: "codex" | "cursor" | "fake";
  buildInvocation(ctx: { bin: string; worktree: string; jobDir: string; prompt: string;
                         sandbox: "read-only" | "workspace-write"; model: string | null;
                         writableRoots?: string[] }):
    { cmd: string; args: string[]; cwd: string; finalMessageFile: string | null };
  extractFinalMessage(jobDir: string): string | null; // 从 final.md 或 raw 输出里取最终消息
}
```
- codex（调度者已确认参数）：`codex exec --cd <wt> --sandbox <sandbox> --json --output-last-message <jobDir>/final.md --output-schema <jobDir>/worker-result.schema.json [-m <model>] <prompt>`。通常从 final.md 读取纯 JSON，禁止 `--dangerously-bypass-approvals-and-sandbox`。
  - 不传任何 `--add-dir`，不探测或授权 Git common dir。真实 Codex 0.164 冒烟证实 workspace-write 即使额外授权 common dir 仍不能创建 `.git/worktrees/<id>/index.lock`，且授权整个 .git 会暴露 hooks/config/所有 refs/其他 worktree，故已撤销。
  - 参数构造为可单测的纯函数；所有 provider 的 `provider.json.writable_roots` 可写时仅含工作树，read-only 为 `[]`。workspace-write worker 在自己的工作树产出改动，不运行 git add/commit，由 gbdev 在收尾时负责 snapshot 提交（正式产出路径），合并仍由调度者负责。别的 provider 若已自行提交，gbdev 照常记录其提交，脏树仍 snapshot。
  - 原始 JSON 事件写 raw.jsonl；从 `thread.started` 的顶层非空字符串 `thread_id` 捕获 session_id，写 job-status 和 job-result。
- cursor（调度者已确认参数）：cwd=<wt>，`cursor-agent -p --output-format stream-json --sandbox enabled --trust --model auto`，可写加 `--force`，只读加 `--mode plan` 且不带 force，最后一个 argv 为 prompt。Cursor 只允许 auto：brief.model 为 null/auto 均固定传 `--model auto`，其他值在建 job 前报 `cursor_model_not_allowed`（退出码 2）。禁止 `--sandbox disabled`。
  - stdout 原样写 raw.json，内容为 JSONL：system/init、user、thinking/delta、thinking/completed、assistant、result。最终消息只取最后一个 `type === "result"` 对象的 `.result` 字符串；存在 result 事件但该字段缺失/非字符串时返回 null，不回退到较早结果。没有 result 事件（如被杀/中断）时，按事件和 content 顺序直接拼接所有 `type === "assistant"` 的 `message.content[]` 中 `type === "text"` 的 text 字符串；没有可用文本则 null。继续兼容旧的单个 JSON 对象（可格式化、无 type 字段、result 为字符串）。解析数百行 thinking delta 或尾部半行时不抛错，损坏/不完整行忽略。
  - session_id 取任意对象中最后一个顶层非空字符串 session_id（忽略空、非字符串与嵌套值）。成功/失败均写入 job.json 和 result.json 并通过 --json 暴露，M1 不 resume。
  - 成功/失败元数据只看最后一个 `type === "result"` 对象，或旧格式无 type 的单个顶层对象。该对象 `is_error === true`，或 subtype 是字符串且不等于 `"success"`，才判 provider 失败；原因优先用非 success 字符串 subtype，否则为 `provider_error: is_error`，绝不产生 `provider_error: success`。system/init、thinking/delta/completed 等非 result 事件不参与失败判定。没有 result 事件时 failure_reason 为 null（旧格式除外），交给退出码、看门狗、超时等收尾规则；字段缺失/非法或 raw.json 空/损坏也不构成 provider 失败。
  - 真实 Cursor 审查常需 15–25 分钟；旧 json 格式只在结束时一次性输出，会被默认 600 秒看门狗误杀。stream-json 的 thinking delta 等增量输出写入 raw.json，持续刷新 supervisor 的存活时间；看门狗依赖 raw.json/worker.log 增长，不依赖事件类型或最终结果。
  - 仅 Cursor 作业扫描 worker.log 的 `Workspace Trust Required`，匹配时原因优先为 `provider_trust_required`；Codex/fake 不受该字符串影响。终态仍服从 §8.7 的 forced 与 needs_input/blocked 更高优先级。raw.json、worker.log 原样保留。
- fake（测试用）：`node test/fixtures/fake-worker.js <scenario>`，按场景改文件、提交、睡眠、输出最终消息；场景：`ok`、`needs_input`、`blocked`、`crash`、`slow`、`no_json`、`outside_paths`、`readonly_violation`、`dirty_exit`。

prompt.md 由 gbdev 渲染，角色 instructions 与 instructions_file 的最终文本放在固定边界条款前的 Role 小节；其余包含：目标、上下文、约束、allowed_paths、验收标准、required_evidence、`answers`（如有）、固定的 worker 边界条款（同 §0 的精简版）、以及「最终消息末尾输出 worker-result.v1 json 块」的说明和示例；read-only 额外强调即使只是审查，最后一段也必须是该 json 块（有 output schema 时为纯 JSON）。所有 sandbox 均不得联网/安装；§3 的 argv 数组要求仅约束 gbdev 实现，不写入 worker prompt。workspace-write prompt 保留 “Do not modify files outside allowed_paths” 约束，并明确要求不要运行 git add/commit，把改动留在工作树由 gbdev 在结束后代为 snapshot 提交，不要因无法提交而报 blocker，commits 允许为空。read-only prompt 只要求不要修改任何文件（包括 allowed_paths 内的文件），不出现 “outside allowed_paths”，gbdev 不会代为提交，修改会导致作业失败（readonly_modified）。

## 10. 源码布局

```
package.json  tsconfig.json  README.md  SPEC.md(本文件副本)
src/
  cli.ts                 # 参数解析（node:util parseArgs）、分发、envelope 输出、退出码
  commands/{doctor,start,status,wait,result,cancel,cleanup,supervise}.ts
  contracts/{envelope,brief,jobStatus,workerResult,jobResult,event,error}.ts  # 类型 + 手写校验函数
  core/{paths,config,lock,jobStore,ids,time,git,glob,proc,finalize}.ts
  providers/{types,codex,cursor,fake}.ts
test/
  *.test.ts              # node:test
  fixtures/fake-worker.js
  helpers/tmpRepo.ts     # mkdtemp 建临时 git 仓库并做初始提交
```

## 11. 测试要求（`npm test` 全绿）

单元：brief 校验（合法/各类非法）、worker-result 提取（多个 json 块取最后一个、无块、坏 JSON）、glob 匹配、job_id/分支名校验、状态判定规则表（§8.7 每条一个用例）、envelope 与退出码映射。
集成（临时 git 仓库 + `GBDEV_HOME` 临时目录 + fake provider）：
1. `start` → `wait` → `succeeded`，`result` 含 commits、diff、checks。
2. `needs_input`：result 里 open_questions 原样透传，状态 `needs_input`。
3. `crash` → `failed`（worker_exit_nonzero）；`no_json` 在 workspace-write → `failed`（worker_result_missing），只读且满足 §8.7 例外时 succeeded + warning。
4. `slow` + `timeout_min` 极小（测试可用 `GBDEV_TIMEOUT_SCALE` 把分钟换成毫秒）→ `timeout`，进程组已被杀。
5. `cancel` 运行中的 job → `cancelled`。
6. 第二个 `start` 在已有运行 job 时 → `busy`。
7. `outside_paths` → policy_violation，`failed`。
8. `readonly_violation`（sandbox read-only）→ `readonly_modified`。
9. `dirty_exit` → 产生 snapshot 提交。
10. `cleanup`：干净 → 移除 worktree；脏或 Git 拒绝移除 worktree → `cleanup_refused`；tip == base_sha 时旧值校验删除（含 base 不被其他分支包含）；有作业提交且未合并时默认保留且成功，force 才删；dry-run 与实际策略一致，后续错误报告 worktree_removed，ref 删除失败带 retry_safe；所有删除路径含 dry-run 的检出保护，force 的旧值竞态校验。
11. repo 不在白名单 → `repo_not_allowed`；空仓库 → `repo_no_commits`。
12. 所有 `--json` 命令 stdout 可被 `JSON.parse`，stderr 为空。
13. 无输出看门狗：fake 先输出再 sleep → worker_stalled/failed，进程组已杀；持续 stdout 或 stderr 不误杀；brief/config 的默认与优先级、0 关闭和非法值校验。
14. events 无结尾换行时恢复后逐行 JSON.parse，legacy 会话元数据保留。
15. Cursor 真实 stream-json 裁剪 fixture：成功最终消息为 ok、session_id 正确、无 provider 错误；截断流（含半行）回退 assistant 文本，无 result 不判 provider_error；仅最后 result 的 subtype/is_error 决定失败；旧无 type 单对象仍兼容；数百行 thinking delta 稳定解析；argv 固定 stream-json/auto；假 provider 持续输出 thinking delta 且总时长超过 stall_timeout_s 时成功、不被误杀。

## 12. 验收标准（controller 会逐条核对）

- AC1 `npm run build` 与 `npm test` 在 Node 24 下通过，`tsc --noEmit` 无错误。
- AC2 `package.json` 无 `dependencies`（只有 devDependencies：typescript、@types/node）。
- AC3 §11 列出的 12 个集成场景都有对应测试且通过。
- AC4 `node dist/cli.js doctor --json` 在用户 Mac 上输出合法 envelope（由 controller 实测）。
- AC5 源码中不存在拼接 shell 字符串调用 git/provider（`check_cmd` 除外），不存在 `--dangerously-bypass-approvals-and-sandbox`、`--sandbox disabled`。
- AC6 源码不读取 `~/.codex`、`~/.cursor`、`~/.ssh` 下任何文件。
- AC7 README 写明安装方式（`npm run build` 后由用户自行决定是否 `npm link`）、每个命令的示例和 JSON 示例。
- AC8 所有提交在 `gbdev-m1` 分支，提交信息符合 Conventional Commits；没有 push。

## 13. 实施说明（给 controller 和 Codex）

- 仓库现状：`/path/to/gbdev`，空 git 仓库，分支 master，无提交。
- controller 在派 Codex 之前（各自单独审批）：创建初始提交（只含 `.gitignore`）、创建并切到分支 `gbdev-m1`、把本文件放到仓库根目录 `SPEC.md`、运行 `npm init -y` 与 `npm install --save-dev typescript @types/node`（需要联网，由 controller 执行，不由 Codex 执行）。
- 建议分 3 次 `codex exec` 派活，每次结束 controller 审查后再派下一次：
  1. 骨架：package.json 脚本、tsconfig、cli.ts、contracts/*、core/{paths,config,ids,time,lock,jobStore}、单元测试。
  2. 执行链路：git、worktree、start/__supervise/status/wait/cancel、fake provider、finalize、集成测试 1–9。
  3. 收尾：result/cleanup/doctor、codex 与 cursor 适配器（参数以 `--help` 为准）、集成测试 10–12、README。
- 派活命令（controller 侧，参数待按 codex 0.164.0 的 `--help` 确认）：
  `codex exec --cd /path/to/gbdev --sandbox workspace-write --json --output-last-message /tmp/gbdev-example/<n>/final.md "<本阶段任务说明，引用 SPEC.md 章节>"`
