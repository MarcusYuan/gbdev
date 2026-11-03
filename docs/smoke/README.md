# M2 §14.2 真实冒烟手册（2026-10-26 已由调度者执行，S1–S6 全部通过）

这些文件是**待执行请求**，不是通过记录。Codex 本轮只做 fake/本地桩测试，没有访问或修改 `/path/to/gbdev-smoke`，没有运行真实 codex / cursor-agent。AC-S5.1 必须由调度者执行 S1–S6 后判定。

## 前置与记录

由调度者确认：smoke 仓库干净，`master` 已有提交，`npm test` 可离线通过，源码/测试分别位于 `src/`、`test/`（如布局不同，先修改请求的 allowed_paths）；配置的 allowed_repos 含该仓库绝对路径；provider 已安装登录。不要设置 `GBDEV_FAKE_PLAN`、`GBDEV_FAKE_SCENARIO`、`GBDEV_TIMEOUT_SCALE`。同一会话所有命令使用相同 GBDEV_CONFIG/GBDEV_HOME。

```sh
gbdev doctor --json
gbdev roles list --json
gbdev pipeline templates --json
```

检查 doctor 的 `checks[].ok`（含 roles，内置应为 `5 valid roles`），不是只看 envelope.ok。按 SPEC 要求检查全绿；tmux 在实现中为可选项，若缺失导致该项 false，明确记录该例外，不宣称全绿。角色/provider 不健康时不要派活。本手册不提供改写用户配置的自动脚本。

以下命令从 gbdev 仓库根执行；`<id>` 必须替换为 start 返回的 `result.pipeline_id`。首次使用组合先 dry-run，成功后再 start：

```sh
gbdev pipeline start --request docs/smoke/s1-normal.json --dry-run --json
gbdev pipeline start --request docs/smoke/s1-normal.json --json
gbdev pipeline wait <id> --timeout-ms 540000 --with-result --json
```

wait_timeout 不等于失败，读取 `error.details.pipeline.current` 后再次 wait。稳定包括暂停与终态。不要并行启动这些场景；暂停不占槽，但仍需按场景完成处置。

## S1 正常闭环

请求：[s1-normal.json](s1-normal.json)，`implement-review`，base_ref=`master`，新增 sum(a,b) 与测试，AC1 执行 npm test。

期望 succeeded/approved（允许经过一轮 fix）。记录 `jobs_used`、`round`、最终检查以及 branch，S2 要用该分支，**先不要 cleanup S1**。

核对 review job 的 `brief.json` / run 的 `roles.snapshot.json`：provider=cursor、model=auto、sandbox=read-only；`provider.json` 固定 bin/writable_roots/schema_options，**该轮 M2 冒烟执行时不保存 argv 字段，不能声称在历史记录中看到了 argv**（自 M3-S6 起新 job 保存实际调用 argv，可用 `scripts/check-smoke-argv.mjs` 检查；旧记录不回填）。由调度者在本机进程观察/执行日志核对实际 argv 含 `--model auto --mode plan`、不含 `--force`；raw.json 应为 stream-json（逐行 JSON）。自动测试也用本地桩捕获真实 spawn argv，但不替代这次真实运行证据。

## S2 只审查

请求：[s2-review-only.json](s2-review-only.json)。唯一特殊 base_ref 为 `REPLACE_WITH_S1_BRANCH`，由调度者替换为 S1 的 `result.branch`（例如 `gbdev/p_YYYYMMDD_HHMM_abcd`）；diff_base_ref 保持 `master`。该占位 ref 不存在时 start/dry-run 必然失败，不要原样执行。

```sh
gbdev pipeline start --request docs/smoke/s2-review-only.json --dry-run --json
gbdev pipeline start --request docs/smoke/s2-review-only.json --json
gbdev pipeline wait <id> --timeout-ms 540000 --with-result --json
```

期望 succeeded/approved 或 needs_decision；worktree 无改动。非空 revise → max_rounds_exceeded，只允许 accept（无 fix_loop，不能 extra_round），也可 cancel。如需接受，必须如实汇报 open_findings；清理前须先 accept 或 cancel，不能 cleanup 暂停态。

## S3 追问与 answer

请求：[s3-needs-input.json](s3-needs-input.json)，base_ref=`master`。

```sh
gbdev pipeline start --request docs/smoke/s3-needs-input.json --json
gbdev pipeline wait <id> --timeout-ms 540000 --with-result --json
```

期望 needs_input 且 pending_questions 非空。向用户转述实际问题（options/default），取得回答后将下面 JSON 的 id、question_id 与 answer 替换为实际值，保存为 answer.json：

```json
{
  "schema": "gbdev.pipeline-resume.v1",
  "pipeline_id": "p_20261026_1011_9c2e",
  "action": "answer",
  "answers": [{ "question_id": "Q1", "answer": "选择数字字符串格式" }],
  "note": null
}
```

```sh
gbdev pipeline resume <id> --input answer.json --json
gbdev pipeline wait <id> --timeout-ms 540000 --with-result --json
```

必须回答所有 blocking 问题，不添加未知 question_id。确认新 attempt/parent_job_id 与 answers 关联，继续到稳定；若需清理仍处于暂停的 run，先按允许动作处理或 cancel。

## S4 修复回路与轮次上限

请求：[s4-fix-loop.json](s4-fix-loop.json)，base_ref=`master`，implement-verify，verify.provider=codex，max_rounds=1。AC2 要求非数字参数抛 TypeError 并有测试，AC1 执行 npm test。

```sh
gbdev pipeline start --request docs/smoke/s4-fix-loop.json --dry-run --json
gbdev pipeline start --request docs/smoke/s4-fix-loop.json --json
gbdev pipeline wait <id> --timeout-ms 540000 --with-result --json
```

必须在 pipeline events.jsonl 看到 G11 或 G6 触发 fix，并核对 round、fix 实例、复审 job、最终 succeeded 或 needs_decision/max_rounds_exceeded。**模型可能首轮完全实现 AC2；若 round=0 直接 approved，只证明正常路径，不能记 S4 通过**。如未触发，调度者记录“未覆盖”，调整测试任务后重试，不能伪造遗漏/轮次结果。

## S5 运行中取消

请求：[s5-cancel.json](s5-cancel.json)，base_ref=`master`，内容同 S1。

```sh
gbdev pipeline start --request docs/smoke/s5-cancel.json --json
gbdev pipeline status <id> --json
# 确认 current.instance=implement#1 且 current.job_state=running 后：
gbdev pipeline cancel <id> --json
gbdev pipeline wait <id> --timeout-ms 540000 --with-result --json
```

期望 cancelled，后续未运行实例 skipped；由调度者依据当前 job 的进程元数据确认 worker 进程组已不存在。若执行太快，未在 implement 运行中取消，应记录未覆盖并重新启动 S5，不能用终态幂等 cancel 替代。

## S6 清理（复用 S1–S5，不需要启动新 run）

S6 是管理动作，**没有 cleanup-request schema**。对 S1–S5 的实际 id 逐个 dry-run，再执行 cleanup；暂停的 run 先按允许动作处置为终态（或 cancel），不要把未回答的 run 当作可清理。

```sh
gbdev pipeline cleanup <id> --dry-run --json
gbdev pipeline cleanup <id> --json
gbdev pipeline result <id> --json
```

若要独立重跑 S6，可用 [s6-cleanup-setup.json](s6-cleanup-setup.json) 作为准备 run 的 pipeline-request（base_ref=`master`、同 S1）；wait 到终态后执行以上命令。这不是 S6 额外的必跑任务。

核对预演 removed/deleted 均为 false、would_* 与实际策略一致；实际 worktree 移除，pipeline/jobs 证据保留。**有本 run 新提交、未被其他本地分支包含**时默认保留分支并报告 unmerged_job_commits；无本 run 新提交（常见于 S2/S5）、或提交已被其他本地分支包含的分支可安全删除，不能强求每个 run 都保留。顺序建议先 S2–S5 后 S1，避免 S2 的相同 tip 被当作包含 S1 提交的其他本地分支。若被别处检出则 checked_out；脏树应 cleanup_refused，不强删。不得为冒烟擅加 --force-branch。

## 结果记录（调度者填写）

| 场景 | pipeline_id | state / outcome / reason | round / jobs_used | 耗时 | 审批次数 | 证据与结论 |
|---|---|---|---|---|---|---|
| S1 | p_20261026_0721_bc13 | succeeded / approved | 0 / 2 | 约 13 分钟 | 0 | reviewer=cursor model auto 只读，实测 argv 含 `--mode plan --model auto`、无 `--force`；通过 |
| S2 | p_20261026_0734_c2b9 | succeeded / approved | 0 / 1 | 约 15 分钟 | 0 | base=S1 分支，head 前后同为 433334e，worktree 干净；通过 |
| S3 | p_20261026_0824_01bb | needs_input → succeeded / approved | 0 / 3 | 约 3 分钟 | 1 次 answer | 首跑 p_20261026_0750_e004 暴露 G1（review 重复追问），修复 aa04613 后重跑：仅答一次，decisions 记录 Q1，review 未再追问；通过 |
| S4 | p_20261026_0830_50e1 | succeeded / approved | 1 / 4 | 约 10 分钟 | 0 | 首跑 p_20261026_0828_605d 首轮即 approve（未覆盖）；重跑令 implement#1 跳过 AC2：verify#1 G11 revise → fix#1 → verify#2 G13 approve；通过 |
| S5 | p_20261026_0840_ee1e | cancelled | 0 / 1 | 约 30 秒 | 0 | implement#1 运行中取消，review#1 skipped，worker pid 34077 已不存在；通过 |
| S6 | 复用 S1–S5 | cleanup 全部成功 | — | — | 0 | 预演 removed/deleted 均 false；worktree 全部移除；S2/S5（无新提交）删分支，其余以 unmerged_job_commits 保留分支；pipeline/jobs 证据保留；未用 --force-branch；通过 |

全部符合预期后，调度者补记 SPEC-M2 §13/§14 的 AC-S5.1 结果，再更新设计文档 Page 里程碑。只通过 fake 测试不等于真实冒烟验收。
