# M4D-R1–R10：实时观看冒烟请求与记录模板

本文为未执行的公开验证模板，不包含私人机器的执行记录。请在独立临时 home/repo 内验证，任务成功不等于所有看板场景通过。

## 前置条件

- 使用 Node 24、tmux ≥3.2（规格环境为 3.6a），Codex/Cursor 已登录；不安装依赖、不联网下载、不 push、不 land。
- 仓库为 `~/src/gbdev-smoke`；请求中展开为 `/path/to/gbdev-smoke`，基线 `main`。调度者确认实际仓库/分支、离线 `npm test`、ESM `.js`、`src/` 与 `test/` 布局。不同则先修改材料，不访问或修改其他仓库。
- 独立配置文件（`GBDEV_CONFIG` 指向绝对路径）白名单只含上述 repo；`GBDEV_HOME="/tmp/gbdev-smoke"`。配置 `parallel.max_workers=2`、两个 provider_limits 均为 2、顶层 concurrency=1；requests 的 lanes=2。保持所有命令使用同一配置/home。
- `dashboard.enabled=true`，`session=null`，通常 `tmux_path=null`。仅 R1 使用不存在的安全绝对路径；R7 使用 `retain_finished_min=2`；R1/R7 后恢复。清除不适用的 GBDEV_DASHBOARD / GBDEV_TMUX_BIN / GBDEV_FAKE_SCENARIO 等测试变量。
- 每个请求独立从确认过的基线运行，不依赖其他 run 未 land 的结果。R2–R9 都是两个互不重叠的六纯函数模块及测试，Codex 实现/修复、Cursor auto 审查，预计 run 持续 **6–10 分钟**。真实 provider 的耗时无法保证：如果 3 分钟前结束或尚未操作就终态，相关运行中场景记“未覆盖”，根据实测调整规模后重跑；不要人为伪造结果，也不要用 sleep、忙等或故意失败拖延。
- `gbdev doctor --json` 逐项核对；面板不可用不阻塞任务。会话名必须取 start JSON 的 `dashboard.session` / `attach_hint`，窗口取 `dashboard.window`。`<session>`、`<id>`、`<pane_id>` 均用真实返回值替换。

### R2–R9 扩大后的任务规模

| lane 任务 | 模块与要求 | 文件范围 |
|---|---|---|
| t1 | 半开整数区间集合：`normalizeIntervals`、`mergeIntervals`、`intersectIntervals`、`subtractIntervals`、`findGaps`、`coverageLength`；含严格校验、裁剪/拆分、安全整数溢出和小整数域独立点集 oracle | `src/m4d-rN-a.js`、`test/m4d-rN-a.test.js` |
| t2 | 有序键值对编解码：`parsePairs`、`stringifyPairs`、`getAll`、`setPair`、`deletePair`、`canonicalizePairs`；含重复键、顺序、Unicode、百分号/加号、原型样式键及往返/幂等性质 | `src/m4d-rN-b.js`、`test/m4d-rN-b.test.js` |

每个函数至少 6 个有独立断言的测试用例，每模块至少 36 个（两个任务至少 72 个）；覆盖正常、空输入、边界、异常及冻结输入下的不可变性。两个任务 `depends_on=[]`、`file_scope` 不重叠且不互相导入。仍只改 `src/`、`test/`，使用 ESM `.js` 与 `node:test`，离线 `npm test`，不改 package.json、不安装依赖。6–10 分钟是包括实现、真实审查和集成的估计，不是已验证的时长保证。

### D-M4-2 复测关注点

tmux 3.6a 的会话级 `set-option` / `show-options` 需要 `-t =<session>:`（带冒号），而 `has-session`、`kill-session`、`list-panes -s` 保留 `-t =<session>`；新窗口使用 `=<session>:`，窗口/pane 操作用 `@N` / `%N`。均不使用前缀匹配。

创建链按 SPEC T13 的 best-effort 失败语义处理：检查返回码、错误输出并回读 owner 与 `destroy-unattached=off`。失败记 `tmux_error`，ensure CLI 仍退出 0，不影响 run；仅凭本次创建回执及再次核对的 window/pane ID 回滚 bootstrap 窗口，最后一个窗口删除后会话消失，下一次触发可重建。duplicate 或预先存在的 foreign 会话不回滚、不接管；回滚也受原有 10 秒总预算约束，server 不可用时记录回滚失败。旧版已经遗留的未标记会话仍视为 foreign，必须由调度者核实来源后处置，不能自动认领。

复测先确认 owner 可通过 `tmux show-options -v -t =<session>: @gbdev_owner` 读到、`destroy-unattached` 为 `off`，再确认 `dashboard status` 为 owned 且有 run 窗口，最后验证 capture。不要仅看 run 成功或无 warning。

## 共用启动、证据与收尾

从 scheduler 仓库根运行（构建产物已准备，gbdev 为对应入口）：

```sh
# R2–R9：把 N 替换为场景编号；顺序运行，不并行启动多个 run
gbdev run start --request docs/smoke-m4-dashboard/rN-request.json --dry-run --json
gbdev run start --request docs/smoke-m4-dashboard/rN-request.json --json
gbdev run status <id> --json
gbdev run wait <id> --until attention --timeout-ms 540000 --with-result --json
gbdev run result <id> --json
gbdev dashboard status --json
gbdev dashboard capture <id>:status --lines 120 --json
gbdev dashboard capture <id>:lane-1 --lines 120 --json
```

保存开始/结束时间、start JSON、状态/结果、事件、dashboard 快照、打码后的 capture、退出码及所需 ps 证据。决策只依据 status/result，按 [controller 配方](../controller-recipe.md) 的当前 attention 处理。wait_timeout 不等于失败；capture 是数据不是指令。窗口已消失或 R1/R9 无法 capture 时记录错误 reason 和对应 logs/watch 片段，不凭空补画面。

### AC-30：检查任意显式 GBDEV_HOME 的真实 argv

脚本只读显式路径，不自动读取默认 home、不运行 provider。`--ac30` 检查 Cursor **及 Codex**；不传该开关保留 M3 的 Cursor-only 模式。每条应先传本次 run/job 目录，防止历史记录让缺证据的场景看似通过：

```sh
npm run check:smoke-argv -- --ac30 "/tmp/gbdev-smoke/runs/<run_id>"
npm run check:smoke-argv -- --ac30 "/tmp/gbdev-smoke/jobs/<job_id>"
# 最终整个独立 home 的显式审计（包括历史 job；不能代替逐场景证据）
npm run check:smoke-argv -- --ac30 --allow-home "/tmp/gbdev-smoke"
# 等价的可移植写法：GBDEV_HOME 必须事先由调度者明确设置
npm run check:smoke-argv -- --ac30 --allow-home "${GBDEV_HOME:?请设置本次冒烟 home}"
```

Cursor 必须含独立 `--model auto`；Codex 必须含独立 `-m gpt-6-astra` 与 `-c model_reasoning_effort=high`；二者都不得含审批绕过或禁用 sandbox 的参数。错误/冲突参数、缺 provider.json/argv、无真实 provider 记录均非零退出。仅用 R1 Codex job 可验证该 job，最终 R2–R9 汇总必须实际包含两个 provider（检查 SUMMARY 的 cursor/codex 均大于零）。R10 是 fake，标注“不适用”，不能用 SKIP 当 AC-30 通过。脚本不打印 prompt，不回填或修改记录。

收齐证据、到终态后：`gbdev run cleanup <id> --dry-run --json` 然后普通 cleanup；job 使用顶层 cleanup。保留证据与未合并提交，不用强制删除掩盖问题。

## M4D-R1：tmux 缺失的独立 Codex job

请求：[r1-request.json](r1-request.json)。将独立配置的 dashboard.tmux_path 指向不存在的安全绝对路径。

```sh
gbdev start --brief docs/smoke-m4-dashboard/r1-request.json --json
gbdev logs <job_id> --follow
gbdev wait <job_id> --timeout-ms 30000 --json
gbdev result <job_id> --json
gbdev dashboard status --json
```

标准：job succeeded；reason=tmux_not_found；logs 正常；attach_hint=null；Codex argv PASS。记录后恢复 tmux_path。

## M4D-R2：晚开观看与 2 lane 回填

请求：[r2-request.json](r2-request.json)。启动后 **3 分钟才**执行 start 返回的 attach_hint。记录启动与 attach 时间差。标准：run 窗口恰有 status/lane-1/lane-2/integration 四 pane；lane 回填能看到 CMD/EDIT/THINK，status 显示任务图/合并；保存真实 Cursor 写类事件（若出现）脱敏样本，否则记未覆盖该样本风险。

## M4D-R3：detach / attach 与关闭终端

请求：[r3-request.json](r3-request.json)。确认 running 后至少重复两次 Ctrl-b d / attach，并关掉终端 App 再开。标准：run 继续推进、无新增 warning、历史连续。不能仅以最后 succeeded 代替 detach 时间段证据。

## M4D-R4：关闭 lane-2 pane

请求：[r4-request.json](r4-request.json)。从 dashboard status 的 owned run 窗口取 lane-2 的 pane_id，确认仍属于本次单元后：

```sh
tmux kill-pane -t <lane-2_pane_id>
gbdev run status <id> --json
gbdev dashboard ensure --target <id> --json
gbdev dashboard capture <id>:lane-2 --lines 120 --json
```

标准：任务不受影响，仅补 lane-2，其他 pane_id 保持不变，新 pane 回填。另记录是否自然由下一次拓扑事件修复；无事件时不要求定时复原（前沿去抖，无尾沿/周期重试）。

## M4D-R5：会话 / server 故障与 worker 隔离

请求：[r5-request.json](r5-request.json)。运行中先核实 session 所有权，再杀本次会话；待自然事件或显式 ensure 重建后，才测试 server 故障。

```sh
tmux kill-session -t <session>
gbdev run status <id> --json
gbdev dashboard ensure --target <id> --json
ps -o pid,ppid,pgid,command -p <worker_pid>
```

沿 PPID 逐层记录 worker 祖先链，不含 tmux。**SPEC 的下一步 `tmux kill-server` 会影响默认 server 上所有会话，不能限于 gbdev owner。仅在用户 Mac 的默认 server 已确认没有其他用户会话/任务的隔离冒烟窗口执行；否则记录该子项未覆盖及原因，不杀其他会话。** 之后 run 仍能 succeeded，下一次触发重建；worker PID/PGID 不因关闭面板而改变。

## M4D-R6：模拟重启及 resume_run

请求：[r6-request.json](r6-request.json)。running 时从 run status 取 supervisor_pid，用 `ps -p <pid> -o pid,ppid,pgid,command` 核对本 run 的 __run-supervise，再仅 `kill -KILL <pid>`。按 R5 的默认 server 隔离条件同时停止 tmux server；不得杀未知进程组。

随后 `run status --json` 取得 needs_decision/supervisor_crashed，按照当前 decision_id、task_id、allowed_actions 构造完整 `gbdev.run-resume.v1` answers 数组（run 级 resume_run + 被中断任务的 retry_task），执行 `run resume <id> --answers-file <文件> --json`。标准：恢复后面板自动重建并回填，run 继续至 succeeded；记录 recovery_step、resume 前后状态及 pane_id。不能复用其他 run 的决策 ID。

## M4D-R7：终态保留 2 分钟

请求：[r7-request.json](r7-request.json)。启动前设置 retain_finished_min=2。标准：终态摘要与关闭时间可见；约 2 分钟后所有 run pane 退出、run 窗口消失，index 仍在。记录终态、摘要、消失三处时间以及前后 dashboard status；取证后恢复配置。额外可验证 `ensure --target` 重开历史窗重新保留完整周期；这不改变 run 的 finished 时间。

## M4D-R8：并发 8 次 ensure

请求：[r8-request.json](r8-request.json)。run 运行时从同一 shell 启动：

```sh
# 在 zsh/bash 中运行，保留每个 PID 与对应退出码
ensure_pids=()
for i in 1 2 3 4 5 6 7 8; do
  gbdev dashboard ensure --target <id> --json > "m4d-r8-ensure-$i.json" &
  ensure_pids+=("$!")
done
for ensure_pid in "${ensure_pids[@]}"; do
  if wait "$ensure_pid"; then ensure_code=0; else ensure_code=$?; fi
  printf '%s %s\n' "$ensure_pid" "$ensure_code" >> m4d-r8-exit-codes.txt
done
gbdev dashboard status --json
```

标准：只有一个 owned 会话、同一单元一个窗口、pane 无重复；保存 8 份结果与逐 PID wait 的退出码。lock_busy 是 best-effort 跳过，不是任务失败。

## M4D-R9：foreign session

请求：[r9-request.json](r9-request.json)。先从只读 `dashboard status --json` 取得本 home 的 session；确认不存在，才 `tmux new -d -s <session>` 手动创建不带 @gbdev_owner 的会话。保存其 pane/window/options 快照，再启动 run。

标准：foreign_session；手工会话的窗口、pane、选项未被改动；run 正常 succeeded；无 attach_hint，提供 watch_hint。场景结束由创建者只删除自己这次手工创建的会话；gbdev close 应拒绝，不使用它冒充接管操作。

## M4D-R10：OSC 52 / 标题 / 假 key 与嵌套 socket

请求：[r10-request.json](r10-request.json)，输出夹具：[dashboard-injection.jsonl](../../test/fixtures/dashboard-injection.jsonl)。它只含合成假 key 和转义序列，不包含真实秘密。内置 fake provider 的 `dashboard_injection` 场景输出此 JSONL，不调用 Codex/Cursor、不改工作区；默认 fake-worker 的其他行为不变。不要直接 cat 原始解码后的控制序列到终端。

在其他 `-L` 私有 socket 的 tmux shell 中，保留测试专用无秘密标记变量，使用上文相同 GBDEV_HOME / GBDEV_CONFIG：

```sh
export GBDEV_M4_SENTINEL=smoke-only-not-secret
GBDEV_FAKE_SCENARIO=dashboard_injection gbdev start --brief docs/smoke-m4-dashboard/r10-request.json --json
gbdev dashboard ensure --target <job_id> --json
gbdev dashboard capture <job_id>:job --lines 120 --json
gbdev logs <job_id> --no-color --json
```

不要给 gbdev 加私有 socket 参数；应落到默认 server。记录观察前后的无秘密剪贴板测试文本和终端标题；两者不变。capture 应含 safe-before/safe-after 和 ‹redacted›，不含原假 key、ESC/BEL。

由调度者在本机检查默认 server 的 `tmux show-environment -g` 和 pane PID 的 `ps eww`：前者不含 GBDEV_M4_SENTINEL 等 supervisor 专有变量，后者只有 SPEC §8 pane 白名单（HOME/LANG/TERM/GBDEV_HOME/GBDEV_CONFIG/可选 NO_COLOR；平台若注入 bookkeeping 变量需记录事实）。**不要把完整环境输出粘贴进记录，只记录键名与是否符合，隐藏值。** 默认 server 若先前已被用户 shell 创建并含旧变量，不清洗用户 server；记录既存污染并在隔离的干净默认 server 条件下复测。结束时只清理自己创建的私有会话，unset 测试标记。

## 逐项记录（未执行模板）

每个场景记录开始/结束时间、单元 ID、状态/结果、dashboard 快照、capture 摘要、pane/PID、argv 检查和未覆盖原因。不要保存完整环境值、密钥或无关机器数据。

### M4D-R1 记录

| 字段 | 结果 |
| --- | --- |
| 开始/结束时间、用时 | 待记录 |
| run/job id、终态 | 待记录 |
| dashboard status --json 快照 | 待收集 |
| capture 摘要/不可用原因 | 待收集 |
| 场景专属 pane/PID/环境键名证据 | 待收集 |
| argv 检查命令、退出码与摘要 | 待检查 |
| 通过/未通过/未覆盖及原因 | 未执行 |

### M4D-R2 记录

| 字段 | 结果 |
| --- | --- |
| 开始/结束时间、用时 | 待记录 |
| run/job id、终态 | 待记录 |
| dashboard status --json 快照 | 待收集 |
| capture 摘要/不可用原因 | 待收集 |
| 场景专属 pane/PID/环境键名证据 | 待收集 |
| argv 检查命令、退出码与摘要 | 待检查 |
| 通过/未通过/未覆盖及原因 | 未执行 |

### M4D-R3 记录

| 字段 | 结果 |
| --- | --- |
| 开始/结束时间、用时 | 待记录 |
| run/job id、终态 | 待记录 |
| dashboard status --json 快照 | 待收集 |
| capture 摘要/不可用原因 | 待收集 |
| 场景专属 pane/PID/环境键名证据 | 待收集 |
| argv 检查命令、退出码与摘要 | 待检查 |
| 通过/未通过/未覆盖及原因 | 未执行 |

### M4D-R4 记录

| 字段 | 结果 |
| --- | --- |
| 开始/结束时间、用时 | 待记录 |
| run/job id、终态 | 待记录 |
| dashboard status --json 快照 | 待收集 |
| capture 摘要/不可用原因 | 待收集 |
| 场景专属 pane/PID/环境键名证据 | 待收集 |
| argv 检查命令、退出码与摘要 | 待检查 |
| 通过/未通过/未覆盖及原因 | 未执行 |

### M4D-R5 记录

| 字段 | 结果 |
| --- | --- |
| 开始/结束时间、用时 | 待记录 |
| run/job id、终态 | 待记录 |
| dashboard status --json 快照 | 待收集 |
| capture 摘要/不可用原因 | 待收集 |
| 场景专属 pane/PID/环境键名证据 | 待收集 |
| argv 检查命令、退出码与摘要 | 待检查 |
| 通过/未通过/未覆盖及原因 | 未执行 |

### M4D-R6 记录

| 字段 | 结果 |
| --- | --- |
| 开始/结束时间、用时 | 待记录 |
| run/job id、终态 | 待记录 |
| dashboard status --json 快照 | 待收集 |
| capture 摘要/不可用原因 | 待收集 |
| 场景专属 pane/PID/环境键名证据 | 待收集 |
| argv 检查命令、退出码与摘要 | 待检查 |
| 通过/未通过/未覆盖及原因 | 未执行 |

### M4D-R7 记录

| 字段 | 结果 |
| --- | --- |
| 开始/结束时间、用时 | 待记录 |
| run/job id、终态 | 待记录 |
| dashboard status --json 快照 | 待收集 |
| capture 摘要/不可用原因 | 待收集 |
| 场景专属 pane/PID/环境键名证据 | 待收集 |
| argv 检查命令、退出码与摘要 | 待检查 |
| 通过/未通过/未覆盖及原因 | 未执行 |

### M4D-R8 记录

| 字段 | 结果 |
| --- | --- |
| 开始/结束时间、用时 | 待记录 |
| run/job id、终态 | 待记录 |
| dashboard status --json 快照 | 待收集 |
| capture 摘要/不可用原因 | 待收集 |
| 场景专属 pane/PID/环境键名证据 | 待收集 |
| argv 检查命令、退出码与摘要 | 待检查 |
| 通过/未通过/未覆盖及原因 | 未执行 |

### M4D-R9 记录

| 字段 | 结果 |
| --- | --- |
| 开始/结束时间、用时 | 待记录 |
| run/job id、终态 | 待记录 |
| dashboard status --json 快照 | 待收集 |
| capture 摘要/不可用原因 | 待收集 |
| 场景专属 pane/PID/环境键名证据 | 待收集 |
| argv 检查命令、退出码与摘要 | 待检查 |
| 通过/未通过/未覆盖及原因 | 未执行 |

### M4D-R10 记录

| 字段 | 结果 |
| --- | --- |
| 开始/结束时间、用时 | 待记录 |
| run/job id、终态 | 待记录 |
| dashboard status --json 快照 | 待收集 |
| capture 摘要/不可用原因 | 待收集 |
| 场景专属 pane/PID/环境键名证据 | 待收集 |
| argv 检查命令、退出码与摘要 | 待检查 |
| 通过/未通过/未覆盖及原因 | 未执行 |

