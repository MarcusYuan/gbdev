# M3-R1–R8：可复现冒烟请求与执行手册

本文是未执行的公开验证模板，不包含私人机器上的结果或证据。请在临时仓库/home 内收集证据，自动测试不替代真实 provider 验证。

## 前置条件与可配置参数

由调度者在自己的执行环境确认，本文中的命令不代表已执行：

- repo 固定为 `/path/to/gbdev-smoke`；八份请求默认 `base_ref: main`。确认该仓库实际默认分支/已有提交，若不是 main，先改请求的 base_ref。每次请求从确认过的基线启动，不依赖其他 run 尚未 land 的成果。
- 确认 Node 24、Git ≥ 2.38、provider 安装与登录、repo 白名单；明确同一会话的 GBDEV_CONFIG/GBDEV_HOME。清除测试用 fake/timeout 环境变量；不要修改真实配置来迁就材料。
- `lanes=2` 已写在请求中；配置 `parallel.max_workers=2`，`provider_limits.codex=2`、`provider_limits.cursor=2`（必须都 ≤ max_workers），顶层 concurrency=1。不要并行启动八个 run。
- 检查真实仓库采用何种模块/测试布局；当前请求假定 ESM `.js`、`src/`、`test/`，`npm test` 会发现新增 `.test.js` 且可离线通过。若不同，调度者先改路径、目标与检查命令。无依赖安装，无 worktree_setup_cmd。不要臆造 npm build。
- R3/R4 需要下述已提交夹具；确认这些文件已在所选基线提交内。可在独立 scratch 夹具分支准备并把相应请求 base_ref 指向该分支，不能把 worktree 未提交文件当作基线，也不为此改写 main/master。
- 所有 Cursor 请求覆盖均为 `cursor_model: auto`，角色解析也必须为 auto。八个请求使用真实 provider，**本轮自动测试只做 schema/语义校验，不启动它们**。

```sh
gbdev doctor --json
gbdev roles list --json
gbdev pipeline templates --json
```

核对每项检查，不能仅凭 envelope.ok；tmux 可选项例外应记录。以下从 scheduler 仓库根运行。`<rN-id>` 替换为 start 返回的 `result.run_id`；所有相对 JSON 路径均为本目录的实际文件，不是执行结果。

## 共用等待、证据与决策规则

```sh
gbdev run status <run_id> --json
gbdev run wait <run_id> --until attention --timeout-ms 540000 --with-result --json
gbdev run result <run_id> --json
```

超时读取 `error.details.run` 后继续 wait，不等于失败。遇到 attention 按 [controller 配方](../controller-recipe.md) 的当前 allowed_actions 处理，只有终态才能 cleanup。保存 run.json、result.json、events.jsonl、task-graph/plans、merges/*.json 与 gate logs、各任务 pipeline/job 记录。记录用时、jobs 数、merge 次数、conflict 次数、approval 次数和逐项证据。**未触发预定路径时记“未覆盖＋原因”，不可按 succeeded 推断场景通过。**

### AC-S6.2：实际 Cursor argv 自动检查

```sh
# GBDEV_HOME 必须由调度者明确设置到本次真实冒烟使用的 home
npm run check:smoke-argv -- "${GBDEV_HOME:?请先设置本次冒烟 home}/runs/<r1-id>"
# 可一次提供八个 run 目录，或多个 jobs/<id> 目录；也支持 home/jobs
node scripts/check-smoke-argv.mjs "${GBDEV_HOME:?}/runs/<r1-id>" "${GBDEV_HOME:?}/runs/<r2-id>"
```

每个场景都要检查其实际 run 目录，汇总时传入全部八个目录。默认拒绝整个 home 根目录并非零退出，提示改传 `runs/<id>` 或 `jobs/<id>`；历史 Cursor job 不可用于本次冒烟验收。仅在明确审计历史记录时可用 `node scripts/check-smoke-argv.mjs --allow-home "${GBDEV_HOME:?}"` 保留旧的全 home 扫描行为；显式传入 `home/jobs` 同样包含历史 job，不能代替本次 run 的证据。run 目录必须位于原始 `home/runs/<id>` 布局，脚本只读同 home 的 jobs，并按 run_id/pipeline_id/集成分支关联（含 planner/resolver/verifier/final reviewer），不进入 worktree，不运行 provider。

新 job 的 `provider.json.argv` 是 supervisor 构造并交给 spawn 的 argv，保留原有 bin/schema_options 等字段。检查结果逐条 PASS/FAIL/SKIP，并给 SUMMARY；所有 Cursor argv 必须有独立的 `--model auto` 参数，不得有审批绕过/禁用 sandbox 参数。缺失或坏记录、旧记录无 argv、零 Cursor jobs 均非零退出，不能算通过。检查不会回填 argv；文件含 prompt，输出只显示检查摘要，不打印 prompt。启动失败/取消前尚未产生 argv 的 Cursor job 要如实记录为未验证，不凭请求推断实际 argv。

## R1：两个独立任务并行

请求：[r1-request.json](r1-request.json)。新增互不重叠的 double/triple 模块与测试。

```sh
gbdev run start --request docs/smoke-m3/r1-request.json --dry-run --json
gbdev run start --request docs/smoke-m3/r1-request.json --json
gbdev run wait <r1-id> --until attention --timeout-ms 540000 --with-result --json
gbdev run result <r1-id> --json
```

预期：两个任务的实际 job 运行区间重叠，两个 integrated merge record，关口全绿，succeeded。用 job state_history 的 running/终止时间证明重叠，不能只看 lanes=2。


## R2：依赖链

请求：[r2-request.json](r2-request.json)。t1 导出 double，t2 依赖 t1 并调用 double 实现 quadruple。

```sh
gbdev run start --request docs/smoke-m3/r2-request.json --dry-run --json
gbdev run start --request docs/smoke-m3/r2-request.json --json
gbdev run wait <r2-id> --until attention --timeout-ms 540000 --with-result --json
gbdev run result <r2-id> --json
# 用实际 SHA 替换占位：返回 0 才表示包含
git -C /path/to/gbdev-smoke merge-base --is-ancestor <t1-merged_sha> <t2-base_sha>
```

预期：t1 integrated 后才开始 t2，t2 base 包含 t1 合并提交，最终通过；保存 task base_sha、merged_sha 与合并记录。


## R3：同一函数冲突 → resolver → gate → verifier

请求：[r3-request.json](r3-request.json)，overlap_policy=allow。已提交的 `src/r3-label.js` 夹具：

```js
export function label(name) { return 'Hello ' + name; }
```

两个任务仍各改同一函数的返回表达式以自然冲突；统一语义是字符串先 trim，trim 后为空或 name 为 null/undefined 时用 guest，再返回 'Hello ' + 结果。t1 只测 trim 后非空的字符串，不断言纯空白输出；t2 只测 null/undefined/''→guest，双方不要为对方负责的输入写断言。

```sh
gbdev run start --request docs/smoke-m3/r3-request.json --dry-run --json
gbdev run start --request docs/smoke-m3/r3-request.json --json
gbdev run wait <r3-id> --until attention --timeout-ms 540000 --with-result --json
gbdev run result <r3-id> --json
```

预期：真实 merge conflict；事件按 resolver → gate → verifier → integrated，resolution 与 verifier 证据完整。若没有自然冲突，记录“未覆盖”，由调度者在独立 scratch 夹具基线上手工构造同一行冲突，调整请求后重跑；不篡改正在运行的 lane/ref，不用文字记录假装发生冲突。


## R4：合并后语义失败 → 回滚 → integration-fix

请求：[r4-request.json](r4-request.json)，overlap_policy=allow。调度者准备并提交以下 ESM 夹具，先确认基线 npm test 通过：

```js
// src/r4-health.js
export default [];
// src/r4-version.js
export default [];
// src/r4-expected.js
export const EXPECTED_ROUTES = 1;
// src/r4-routes.js
import health from './r4-health.js';
import version from './r4-version.js';
export const routes = ['/base', ...health, ...version];
// test/r4-count.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { routes } from '../src/r4-routes.js';
import { EXPECTED_ROUTES } from '../src/r4-expected.js';
test('route count', () => assert.equal(routes.length, EXPECTED_ROUTES));
```

两个任务分别新增 /health 与 /version，并把共享常量从 1 改为 2；模块不同、常量改动相同，旨在干净合并后暴露 3≠2。已有 count 测试不能删改或跳过。

```sh
gbdev run start --request docs/smoke-m3/r4-request.json --dry-run --json
gbdev run start --request docs/smoke-m3/r4-request.json --json
gbdev run wait <r4-id> --until attention --timeout-ms 540000 --with-result --json
gbdev run result <r4-id> --json
```

预期：第二次合并 gate_failed，reset 到 pre_merge_sha，任务走 integration-fix 把 EXPECTED_ROUTES 改为 3，再次合并通过。保存 rolled_back_gate_failed、rolled_back_to、integration_fixes 与 gate log。若任务未并发、提前避开失败、或仅发生文本冲突修复，标未覆盖并调整夹具后重跑。


## R5：planner + 编辑计划批准

请求：[r5-request.json](r5-request.json)，tasks=null。

```sh
gbdev run start --request docs/smoke-m3/r5-request.json --dry-run --json
gbdev run start --request docs/smoke-m3/r5-request.json --json
gbdev run wait <r5-id> --until attention --timeout-ms 540000 --json
gbdev run status <r5-id> --json
```

预期先进入 plan_review，批准前没有 task job。复制 plans 中合法草稿的 task_graph（以实际文件内容为准）为完整 graph，编辑一个任务的 goal 和 acceptance_criteria（例如 double 增加负数输入测试）；checks 只引用请求已有 test，不加入命令。将完整图放入 [配方](../controller-recipe.md) v1 resume 对象的 task_graph，填当前 decision_id/action=approve_plan/task_id=null，保存 `r5-approve.json`。

```sh
gbdev run resume <r5-id> --input r5-approve.json --json
gbdev run wait <r5-id> --until attention --timeout-ms 540000 --with-result --json
gbdev run result <r5-id> --json
```

预期按编辑图执行，保存批准输入、task-graph.json、任务 prompt/新增测试。request.json 仍为原始请求，不拿它判定编辑是否生效。


## R6：运行中 cancel，然后 cleanup

请求：[r6-request.json](r6-request.json)。必须在 job 确实 running 时取消，而非终态幂等 cancel。

```sh
gbdev run start --request docs/smoke-m3/r6-request.json --json
gbdev run status <r6-id> --json
# 确认任务正在执行后：
gbdev run cancel <r6-id> --json
gbdev run wait <r6-id> --until settled --timeout-ms 540000 --with-result --json
gbdev run cleanup <r6-id> --dry-run --json
gbdev run cleanup <r6-id> --json
git -C /path/to/gbdev-smoke worktree list --porcelain
```

预期 cancelled 且进程组收尾；干净 lane/integration worktree 删除，worktree list 无该 run 残留；未合并任务提交保留（unmerged_task_commits）。若取消太快没有新提交，不能声称覆盖“保留未合并提交”；调度者重试，让任务已有改动/取消快照后验证独有提交。dirty worktree 按保护规则保留须记录并处置，不强删、不用 --force-branch 掩盖。


## R7：仅 land 到 scratch smoke-land

请求：[r7-request.json](r7-request.json)。调度者先确认 scratch `smoke-land` 不存在，才从请求的实际基线创建；已存在则核对 tip，不 reset/覆盖：

```sh
# main 仅作读取的基线；若请求 base_ref 已调整，此处同步调整
git -C /path/to/gbdev-smoke branch smoke-land main
gbdev run start --request docs/smoke-m3/r7-request.json --json
gbdev run wait <r7-id> --until attention --timeout-ms 540000 --with-result --json
gbdev run result <r7-id> --json
# 预期 exit 2/user_approval_required，refs 不变
gbdev run land <r7-id> --target smoke-land --json
```

run succeeded 后向用户展示集成 SHA/检查并明确询问是否合入 **smoke-land**。只有用户明确同意后执行：

```sh
gbdev run land <r7-id> --target smoke-land --confirm-user-approved --dry-run --json
gbdev run land <r7-id> --target smoke-land --confirm-user-approved --approval-note "替换为用户明确同意的原话" --json
git -C /path/to/gbdev-smoke rev-parse refs/heads/smoke-land
```

预期 ff 成功，land 审批审计完整，tip 等于 landed_sha；**绝不 land 到 master/main，所有步骤均不 push**。没有用户同意时记“等待批准”，不可自动加标志。


## R8：运行中 kill supervisor → 恢复

请求：[r8-request.json](r8-request.json)。

```sh
gbdev run start --request docs/smoke-m3/r8-request.json --json
gbdev run status <r8-id> --json
# 从当前状态取 supervisor_pid，先核对 ps 中命令确为此 run 的 __run-supervise：
ps -p <supervisor_pid> -o pid=,command=
# 仅杀已核对的该 supervisor，不 kill 进程组、不杀其他任务：
kill -KILL <supervisor_pid>
gbdev run status <r8-id> --json
```

必须在运行中完成 kill；若已结束则记未覆盖并重跑。status 触发恢复：停止已记录 worker/check/Git 进程组，集成恢复到 verified_sha，出现 supervisor_crashed。将当前 run 级 resume_run 与每个中断 task 的 retry_task 写成完整 `gbdev.run-resume.v1` 对象数组 `r8-answers.json`，每项使用自己的 decision_id/task_id；不要复用 R5 的 ID。

```sh
gbdev run resume <r8-id> --answers-file r8-answers.json --json
gbdev run wait <r8-id> --until attention --timeout-ms 540000 --with-result --json
gbdev run result <r8-id> --json
```

预期 needs_decision/supervisor_crashed → resume_run → succeeded，保存 recovery_step、恢复前 verified_sha、retry attempts。


## 收尾与结果模板

取完证据后，按需执行（不会 push）：

```sh
gbdev run cleanup <run_id> --dry-run --json
gbdev run cleanup <run_id> --json
```

未 land 的集成分支保留是正常语义。每次验证单独记录，不要引用其他人的机器结果。

| 场景 | run_id / state | 用时 | jobs | 合并 / 冲突 | 审批次数 | argv 检查 | 证据与未覆盖原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | 待执行 | 待记录 | 待记录 | 待记录 | 待记录 | 待检查 | 待收集 |
| R2 | 待执行 | 待记录 | 待记录 | 待记录 | 待记录 | 待检查 | 待收集 |
| R3 | 待执行 | 待记录 | 待记录 | 待记录 | 待记录 | 待检查 | 待收集 |
| R4 | 待执行 | 待记录 | 待记录 | 待记录 | 待记录 | 待检查 | 待收集 |
| R5 | 待执行 | 待记录 | 待记录 | 待记录 | 待记录 | 待检查 | 待收集 |
| R6 | 待执行 | 待记录 | 待记录 | 待记录 | 待记录 | 待检查 | 待收集 |
| R7 | 待执行 | 待记录 | 待记录 | 待记录 | 待记录 | 待检查 | 待收集 |
| R8 | 待执行 | 待记录 | 待记录 | 待记录 | 待记录 | 待检查 | 待收集 |
