# 角色与提示词目录（M6）

本目录是内置专家角色与公共提示片段的**唯一真相**。构建时由 `scripts/gen-roles.mjs` 生成提交入库的 `src/roles/catalog.generated.ts`，再经 `tsc` 打进 `dist/`。运行时**不**读取本目录。

## 布局

```
roles/
  <name>/role.json     # gbdev.role-source.v1
  <name>/prompt.md     # 角色 instructions，一行一条
  _shared/fragments.json
  _shared/<fragment>.md
```

当前内置角色 7 个：`planner`、`executor`、`fixer`、`reviewer`、`verifier`、`resolver`、`inspector`。别名（如 `code-reviewer` → `reviewer`）写在对应 `role.json` 的 `aliases` 中。

### inspector 与保留标识（M7）

- `inspector`：Cursor `--model auto`、只读、`report` 输出；默认超时 10 min / stall 120 s；`used_by` 为 `gbdev inspect`。用户覆盖只能改 description / instructions / timeouts，不能放宽为 write/change/verdict 或 Codex。
- inspect 输入/输出预算上限：动态证据包与候选 inspection JSON 各 64 KiB，provider raw+stderr 合计 1 MiB；answer ≤2048 字节，excerpts 最多 8 个、每个最多 40 行/2048 字节、总 text ≤8192 字节；完整结果 JSON ≤16384 字节。独立 inspect 不计入父 run 任务预算，但每 home 最多一个活动 inspect，并计入 `parallel.max_workers` / `provider_limits` 并发上限。
- 保留标识（不可配置、不可派发为 worker）：`grokbot`、`grok-bot`、`dispatcher`、`decider`（trim + lowercase 比较）。尝试配置或 `roles show dispatcher` 返回 `role_fixed`。`bot_label` 如 `example-dev` 与自然语言中的 `decider` 不在此列。controller 决策角色固定；Codex/Cursor **工程**角色仍可经三层配置：内置本目录、`dirname(config)/roles/<name>.json`、请求 `step_overrides`。工作流把 planner/fixer/resolver 覆为 Codex gpt-6-astra high、把 executor/reviewer/verifier/inspector 覆为 Cursor auto，不等于改写本目录内置默认。

## 如何修改

1. 改 `roles/<name>/prompt.md` 或 `_shared/<fragment>.md`（或 `role.json` 字段）。
2. 运行 `npm run gen:roles`（或 `npm run build`，会先跑生成器）。
3. 相关快照测试会失败：M6 期间**不允许**为改字而更新 `test/fixtures/m6-prompts.snapshot.json`；只有行为有意变更且经规格批准后才可更新快照。
4. 用 `node scripts/gen-roles.mjs --check` 确认生成物与目录一致。

## `role.json` 要点

- `schema` 必须为 `gbdev.role-source.v1`；`name` 等于目录名；`prompt` 只能是 `prompt.md`。
- `mode` 必须与 `output` 一致：`change` ⇒ `workspace-write`，其他 ⇒ `read-only`。
- `cursor_model` 必须为 `"auto"`；`resolver` 的 `allowed_providers` 不得含 `cursor`。
- `purpose` / `used_by` / `aliases` 仅文档与别名表，不进入运行时 `Role` 对象；`roles list/show` 输出结构不变。

## `prompt.md` 要点

- 内容 = `instructions` 数组逐行以 `\n` 连接，文件末尾恰好一个 `\n`。
- 禁止空行与 `\r`。

## 文件结尾约定

- `roles/` 下所有文本文件必须以**恰好一个**换行结尾：无行尾空白、无 EOF 多余空行（`git diff --check` 与生成器均会拒绝）。
- 片段正文若在渲染结果中需要末尾额外换行，不要在 `.md` 里留空行；在 `fragments.json` 对应条目上设 `"trailing_newlines": <n>`（默认 `0`）。生成器先去掉文件结尾的唯一 `\n`，再按该元数据补回 `\n`。

## 公共片段

- `fragments.json`（`gbdev.prompt-fragments.v1`）列出 `id`、`file`、`placeholders`、`used_by`，可选 `trailing_newlines`。
- 片段正文中的 `{{name}}` 必须与声明的 `placeholders` 一致（不多不少）。
- 只搬静态文字；动态拼接仍在 TypeScript 中，通过简单占位符替换取片段。

## 快照规则

- 快照文件：`test/fixtures/m6-prompts.snapshot.json`，由 `scripts/m6-prompt-snapshot.mjs` 在**重构前**的代码上捕获。
- 测试对 `builtinRoles()`、`roles list/show`、渲染矩阵做 `deepStrictEqual`。
- 手改快照视为失败；有意变更提示词需同一提交中显式更新并说明原因。

## 搬迁清单（静态提示 → `_shared/`）

| 片段 id | 原出处 | 现消费方 |
|---|---|---|
| `worker-boundaries` / `-write` / `-readonly` | `core/prompt.ts` `renderWorkerBoundaries` | 同左 |
| `final-response` / `-readonly-note` / `-verdict` | `renderFinalResponse` | 同左 |
| `verdict-retry-notice` | `VERDICT_RETRY_NOTICE` | `finalReview` / snapshot |
| `orchestrator-notes` | `renderOrchestratorNotes` | runJob / finalReview / pipeline |
| `untrusted-data-notice` | `DATA_NOTICE` | `renderUntrustedData` |
| `decisions-header` / `decisions-untrusted-notice` | `renderDecisions` | 同左 |
| `step-review-complete` / `step-review-increment` | `renderStepPrompt` | 同左 |
| `seed-findings-header` / `pending-findings` / `handoff-include` | `renderStepPrompt` | 同左 |
| `planner-requirements` / `resolver-requirements` / `run-job-evidence-header` | `run/jobs.ts` | `assembleRunJobPrompt` |
| `final-review-untrusted-header` | `run/finalReview.ts` | `assembleFinalReviewPrompt` |
| `resolver-goal` / `verifier-goal` | `run/jobs.ts` | `runJob` brief.goal |
| `task-rebuild-context` / `task-retry-context` | `run/supervisor.ts` rebuild/retry 上下文 | `rebuildOrRetryLine` |
| `integration-fix-context` | `run/supervisor.ts` integration-fix 上下文 | `integrationFixContextLine` |

## 刻意保留在代码中的静态英文（不进 `_shared`）

| 文字 | 位置 | 理由 |
|---|---|---|
| `# gbdev worker task`、`## Role`、`## Task`、`## Pipeline context`、`## Prior steps` | `core/prompt.ts` / `pipeline/prompt.ts` | 提示脚手架结构标题，非可审角色散文 |
| `Describe an actual finding` | `core/prompt.ts` verdict 示例 finding | JSON schema 示例字段，非 worker 指令正文 |
| `Describe the task decomposition` / `Describe the change` / `Describe acceptance` / `Task title` / `Describe how both sides intent is preserved` | `run/jobs.ts` extraFields 示例 | task_graph / resolution 的 schema 样例对象，与生产 brief 字段绑定 |
| `Previous attempt summary:` | `pipeline/supervisor.ts` | 动态重试摘要前缀，依赖 runtime 摘要拼接 |
| `Fix final review findings` / `Resolve final review findings` | `run/decisions.ts` | GraphTask 元数据（title / AC），不是发给 worker 的固定提示段 |

## Compatibility identifiers

`grokbot` and `grok-bot` are legacy reserved control-plane aliases, not the product name. They remain blocked as worker names to protect existing configurations. The persisted actor identifier `grok-bot` is also retained in job/pipeline/run state history and decision records; existing recovery logic counts those records. It identifies the external decider, not a required provider or personal bot.
