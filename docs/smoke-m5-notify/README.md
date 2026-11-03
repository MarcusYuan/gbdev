# M5N-R1–R13：通知冒烟请求与记录模板

**状态：全部待执行。** 本轮只交付仓库材料，不在 Mac 跑真实冒烟；自动测试不能替代 AC-30。下方空白记录不是通过结果。真实 URL、密钥、完整 payload 原文、prompt、环境值和原始 provider argv 不得入库；证据仅保存脱敏摘要。用例里的路径是未来 Mac 场景说明，本轮不会访问。

## 准备（调度者之后在 Mac 执行）

- 遵循 SPEC-M5 §15：隔离 GBDEV_HOME 为 `/tmp/gbdev-smoke`，仓库为 `~/src/gbdev-smoke`，与正式 home/config 分离；所有命令保持同一 GBDEV_HOME/GBDEV_CONFIG。请求与 brief 的 `repo` 使用 `<REPO_PATH>` 占位符，执行前由调度者替换为该未来仓库的绝对路径并核对，不由测试访问。
- 用户确认冒烟 routine（建议与正式 routine 分开）、O-1 的 key_placement/key_name/key_prefix、允许的工作时间窗。bot 按 [配方](../controller-recipe.md) 创建 routine 并发面板链接；用户在终端 `gbdev notify setup` 录入 URL/密钥；bot enable、test；真实唤醒 routine ack 后 `init.state=verified` 才算接通。R1/R13 先做，R2/R5 核实平台语义。
- 所有真实 Codex worker 模型配置为 gpt-6-astra，实际 argv 要有 `-m gpt-6-astra` 与 `-c model_reasoning_effort=high`；Cursor 要有 `--model auto`；保留沙箱，不新增绕过参数。内部 resolver/fixer 若被用到，冒烟隔离配置也须冻结相同模型。先 dry-run 校验角色与请求，绝不因此调用真实 worker。
- run 只到集成分支成功并询问是否合入；本套冒烟不 land、不 push。不要以 run 成功替代通知延迟/去重/恢复判据。

## 可复用请求与任务

| 文件 | 用法 / 场景操作 |
|---|---|
| r3-request.json / r3-task.md | 1-lane Codex 实现 + Cursor 审查；Q1 用户偏好必产生 needs_input/task_paused，user 回答后 resume，观察终态再次唤醒。 |
| r4-request.json / r4-task.md | 初始实现不得生成 recovered 标记；仅 integration gate 要求它，故失败；bot extra_fix 创建标记后通过。task AC 只引用 test，不能提前在 worker 检查触发同一 gate。 |
| r6-request.json / r6-task.md | integration recovery check 缺标记时等 25 分钟再失败（检查超时 30 分钟，run 120 分钟）；在 gate 开始时合盖 ≥20 分钟，再开盖观察（普通失败会自动再跑一次，gate 总超时还可能先触发，需记录实际失败原因/时间）。调度者按实际睡眠/定时器行为确认 attention 时间；未能在睡眠区间制造通知须记未覆盖并复测，不能伪造时间。 |
| r7-request.json / r7-task.md | Q1、Q2 两次独立偏好；关闭 Wi-Fi 后本机跟进并回答，制造 2 attention + terminal；保持离线 15 分钟后恢复。若无法离线 resume，记录实际覆盖而非声称达到全场景。 |
| r9-request.json / r9-task.md | 运行中记录 supervisor/投递 PID，核验属于本次隔离 home 后才模拟进程全灭；不提供通配 kill 命令。随后手动触发兜底 routine，观察 reconcile 与恢复。 |
| r11-codex-brief.json / r11-fake-brief.json / r11-task.md | 受控只读可读性实验，只有布尔结论，探测范围必须另获 用户确认；fake 专用探针须由调度者准备，默认 fake ok 不是可读性验证。 |
| r10-missing-payload.json / r10-mismatch-payload.json | 完全合成模板（全零 home_id 不是登记值）。user 本地替换已登记 home、有效不存在 run / 当前 running run、唯一 notice_id 和带时区偏移的时间；unit_id 与 next_step 内的 ID 必须同步替换以保持契约合法（routine 仍不得执行 next_step 原文），再通过平台确认的认证方式发送；模板不得直接当有效通知。 |

通用启动顺序（`<…>` 替换为本次文件/实际 ID）：

```text
gbdev doctor --json
gbdev notify status --json
gbdev run start --request <rN-request.json> --dry-run --json
gbdev run start --request <rN-request.json> --json
gbdev run status <run_id> --json
gbdev run result <run_id> --json
npm run check:smoke-argv -- --ac30 <GBDEV_HOME/runs/run_id>
# standalone R11：
npm run check:smoke-argv -- --ac30 <GBDEV_HOME/jobs/job_id>
```

`--ac30` 是既有 M4 命名，但执行相同的 M5 AC-31 双 provider 规则，不需要新模式。检查器接收实际 job/run/jobs 证据目录，不扫描本目录的请求当作真实 argv；整个隔离 home 仅显式 `--allow-home` 时可扫。缺 argv、全 fake 或本目录尚无执行证据应报 UNVERIFIED/非零，不能算通过。测试以 os.tmpdir() 下的 M5 合成证据目录验证覆盖与只读性，不读取真实 smoke home。

R1/R2/R8/R12/R13 不需要 worker 请求；R5 复用 R3 单元，R10 复用 R3/R9 running 单元。R5 优先按平台可行方式调整 timeout_ms 为 1000 并制造慢响应；若用 stub 代理，必须由调度者另行设计不记录/转发泄露秘密的受控方案，不能降低 HTTPS/重定向安全规则；不可实现则明确未覆盖。R10 不将正确密钥写进 curl argv 或 env：user 可用本地 0600 curl 配置文件或私有 stdin 输入，认证字段以 O-1 为准，bot 不代发、不收集命令原文。R12 由用户 在本地安全扫描，不能把密钥放入 grep argv/env/终端历史；只回填命中数与结论。

## 场景总表（SPEC-M5 §15）

| 编号 | 场景 | 需要用户 | 通过标准 |
|---|---|---|---|
| M5N-R1 | 设置 + `gbdev notify test`；同时确认密钥 header/字段名（O-1），先按平台文档/面板说明配置，若不明确则依次试验候选并只保留被接受的一个 | 是：建 routine、复制 URL/密钥、`notify setup` | HTTP 2xx；webhook routine 被唤醒，`<webhook_event>` 中可见 `schema=gbdev.notify.v1`、`event=test`；记录平台实际状态码、延迟、payload 原样到达情况 |
| M5N-R2 | 错密钥：`notify setup` 粘贴一个改了 1 个字符的密钥，再 `notify test` | 是：执行 setup | 平台返回 401/403（记录实际码）；`notify status` 为 `paused_auth_rejected`；routine **未**被唤醒；恢复正确密钥 + `flush --retry-auth` 后补发成功 |
| M5N-R3 | 端到端：真实 1-lane run（Codex 实现 + Cursor 审查），故意设计一个 `task_paused`（需要用户偏好的问题） | 否（结束时需回答问题） | attention 出现后 ≤ 30 s routine 被唤醒；controller 拉 status、识别需要用户、在对话里提问；user 回答后 `run resume`，run `succeeded` 后再次被唤醒并汇报、询问是否合入（不 land） |
| M5N-R4 | 可自动处理的决策：构造 `integration_gate_failed` | 否 | 被唤醒后 controller 按配方 `extra_fix`，**不**打扰 user；最终汇报中列出 |
| M5N-R5 | 重复送达：用 stub 代理（或临时把 timeout_ms 调到 1000 并让平台慢响应，取可行者）制造一条被发送两次的通知 | 否 | routine 被唤醒两次，第二次识别同 `notice_id` 静默结束；run 不受影响 |
| M5N-R6 | Mac 睡眠：run 运行中合盖 ≥ 20 分钟，期间安排一个 attention 在合盖后触发（长检查命令后失败） | 是：合盖/开盖 | 开盖后 ≤ 2 分钟送达（合并后 1 条）；`notify.log` 可见墙钟跳变处理；任务无额外 warning |
| M5N-R7 | 断网：关闭 Wi-Fi 15 分钟，期间 run 产生 2 个 attention + 终态 | 是：开关 Wi-Fi | 恢复网络后按退避表内补发；同一 run 合并；routine 被唤醒次数 ≤ 2 |
| M5N-R8 | 端点不可用：把秘密文件 URL 改为一个返回 404 的同主机路径（或删除冒烟 routine） | 是：改 routine | `paused_endpoint_gone`；任务照常；兜底轮询发现并按 §11.5 提示 |
| M5N-R9 | Mac 重启 / 进程全灭：run 运行中 `kill -9` supervisor 与投递进程（模拟重启） | 否 | 无自动通知（预期）；下一次兜底轮询（可手动触发该 routine）执行 status ⇒ `supervisor_crashed` 入队并送达 ⇒ webhook routine 处理 `resume_run` + `retry_task` |
| M5N-R10 | 伪造：user 用 curl 带正确密钥向 routine 发送一条指向不存在 run 的通知，以及一条 `kind=succeeded` 但 run 实际 running 的通知 | 是：执行 curl（密钥只在他手里） | controller 两次都去 status 核实后不采取任何动作，不 land、不 resume；记录可疑通知 |
| M5N-R11 | worker 可读性（O-5）：fake provider 与真实 Codex（read-only 沙箱）各一个 job，任务是「尝试读取 `~/.config/gbdev/notify/` 下的文件并报告是否成功」，以及 env 中是否有任何 notify 相关键 | 否 | 记录事实结论；env 中无任何 URL/密钥（必须通过）；若文件可读，在 §10 S-N8 写明并评估钥匙串默认 |
| M5N-R12 | 泄露扫描：冒烟结束后在 `/tmp/gbdev-smoke`、仓库、worktree、所有 controller 可见的命令输出中 grep 密钥 | 是：用户自己 grep（密钥只在他手里） | 零命中 |
| M5N-R13 | Step 0 端到端：在冒烟 home 上从零开始（无秘密、本 bot 无 routine）让 bot 执行 Step 0；随后第二次使用 gbdev 再执行一次 Step 0；再用另一个 `bot_label` 尝试 ack | 是：在面板复制 URL/密钥并 `notify setup` | 第一次：bot 建 routine 并发面板链接，user setup 后 bot `notify test`，被唤醒的 routine 执行 `notify ack`，发起方在 2 分钟内看到 `init.state=verified`；第二次：静默通过、零消息；他 bot ack ⇒ `bound_to_other_bot` |

## 逐项记录

每次记录需保留本次代码 HEAD、隔离 home_label、配置摘要（无秘密）、开始/结束时间和脱敏证据引用。notify.log 只截与本项相关的时间/notice_id/seq/HTTP 状态/分类；不复制任何 URL、密钥、响应正文或 prompt。只有 用户的泄露扫描确认后再回填仓库；未覆盖项写明原因。

### M5N-R1 记录

| 字段 | 待填内容 |
|---|---|
| 场景 | 设置 + `gbdev notify test`；同时确认密钥 header/字段名（O-1），先按平台文档/面板说明配置，若不明确则依次试验候选并只保留被接受的一个 |
| 需要用户 与否 | 是：建 routine、复制 URL/密钥、`notify setup` |
| 通过标准 | HTTP 2xx；webhook routine 被唤醒，`<webhook_event>` 中可见 `schema=gbdev.notify.v1`、`event=test`；记录平台实际状态码、延迟、payload 原样到达情况 |
| 用时（开始/结束/持续） | 待执行 |
| 单元 id（不适用写明原因） | 待执行 |
| `notify status --json` 快照 | 待执行；脱敏后填入或引用本项证据文件 |
| `notify.log` 片段 | 待执行；仅分类与时间等公开元数据 |
| routine 唤醒时间（含时区） | 待执行；未唤醒亦需记录观察窗口 |
| argv 检查结果 | 待执行；无 worker 时注明不适用，不能写通过 |
| 结论 | 待执行 |
| 未覆盖原因 / 异常 / 证据引用 | 待执行 |

### M5N-R2 记录

| 字段 | 待填内容 |
|---|---|
| 场景 | 错密钥：`notify setup` 粘贴一个改了 1 个字符的密钥，再 `notify test` |
| 需要用户 与否 | 是：执行 setup |
| 通过标准 | 平台返回 401/403（记录实际码）；`notify status` 为 `paused_auth_rejected`；routine **未**被唤醒；恢复正确密钥 + `flush --retry-auth` 后补发成功 |
| 用时（开始/结束/持续） | 待执行 |
| 单元 id（不适用写明原因） | 待执行 |
| `notify status --json` 快照 | 待执行；脱敏后填入或引用本项证据文件 |
| `notify.log` 片段 | 待执行；仅分类与时间等公开元数据 |
| routine 唤醒时间（含时区） | 待执行；未唤醒亦需记录观察窗口 |
| argv 检查结果 | 待执行；无 worker 时注明不适用，不能写通过 |
| 结论 | 待执行 |
| 未覆盖原因 / 异常 / 证据引用 | 待执行 |

### M5N-R3 记录

| 字段 | 待填内容 |
|---|---|
| 场景 | 端到端：真实 1-lane run（Codex 实现 + Cursor 审查），故意设计一个 `task_paused`（需要用户偏好的问题） |
| 需要用户 与否 | 否（结束时需回答问题） |
| 通过标准 | attention 出现后 ≤ 30 s routine 被唤醒；controller 拉 status、识别需要用户、在对话里提问；user 回答后 `run resume`，run `succeeded` 后再次被唤醒并汇报、询问是否合入（不 land） |
| 用时（开始/结束/持续） | 待执行 |
| 单元 id（不适用写明原因） | 待执行 |
| `notify status --json` 快照 | 待执行；脱敏后填入或引用本项证据文件 |
| `notify.log` 片段 | 待执行；仅分类与时间等公开元数据 |
| routine 唤醒时间（含时区） | 待执行；未唤醒亦需记录观察窗口 |
| argv 检查结果 | 待执行；无 worker 时注明不适用，不能写通过 |
| 结论 | 待执行 |
| 未覆盖原因 / 异常 / 证据引用 | 待执行 |

### M5N-R4 记录

| 字段 | 待填内容 |
|---|---|
| 场景 | 可自动处理的决策：构造 `integration_gate_failed` |
| 需要用户 与否 | 否 |
| 通过标准 | 被唤醒后 controller 按配方 `extra_fix`，**不**打扰 user；最终汇报中列出 |
| 用时（开始/结束/持续） | 待执行 |
| 单元 id（不适用写明原因） | 待执行 |
| `notify status --json` 快照 | 待执行；脱敏后填入或引用本项证据文件 |
| `notify.log` 片段 | 待执行；仅分类与时间等公开元数据 |
| routine 唤醒时间（含时区） | 待执行；未唤醒亦需记录观察窗口 |
| argv 检查结果 | 待执行；无 worker 时注明不适用，不能写通过 |
| 结论 | 待执行 |
| 未覆盖原因 / 异常 / 证据引用 | 待执行 |

### M5N-R5 记录

| 字段 | 待填内容 |
|---|---|
| 场景 | 重复送达：用 stub 代理（或临时把 timeout_ms 调到 1000 并让平台慢响应，取可行者）制造一条被发送两次的通知 |
| 需要用户 与否 | 否 |
| 通过标准 | routine 被唤醒两次，第二次识别同 `notice_id` 静默结束；run 不受影响 |
| 用时（开始/结束/持续） | 待执行 |
| 单元 id（不适用写明原因） | 待执行 |
| `notify status --json` 快照 | 待执行；脱敏后填入或引用本项证据文件 |
| `notify.log` 片段 | 待执行；仅分类与时间等公开元数据 |
| routine 唤醒时间（含时区） | 待执行；未唤醒亦需记录观察窗口 |
| argv 检查结果 | 待执行；无 worker 时注明不适用，不能写通过 |
| 结论 | 待执行 |
| 未覆盖原因 / 异常 / 证据引用 | 待执行 |

### M5N-R6 记录

| 字段 | 待填内容 |
|---|---|
| 场景 | Mac 睡眠：run 运行中合盖 ≥ 20 分钟，期间安排一个 attention 在合盖后触发（长检查命令后失败） |
| 需要用户 与否 | 是：合盖/开盖 |
| 通过标准 | 开盖后 ≤ 2 分钟送达（合并后 1 条）；`notify.log` 可见墙钟跳变处理；任务无额外 warning |
| 用时（开始/结束/持续） | 待执行 |
| 单元 id（不适用写明原因） | 待执行 |
| `notify status --json` 快照 | 待执行；脱敏后填入或引用本项证据文件 |
| `notify.log` 片段 | 待执行；仅分类与时间等公开元数据 |
| routine 唤醒时间（含时区） | 待执行；未唤醒亦需记录观察窗口 |
| argv 检查结果 | 待执行；无 worker 时注明不适用，不能写通过 |
| 结论 | 待执行 |
| 未覆盖原因 / 异常 / 证据引用 | 待执行 |

### M5N-R7 记录

| 字段 | 待填内容 |
|---|---|
| 场景 | 断网：关闭 Wi-Fi 15 分钟，期间 run 产生 2 个 attention + 终态 |
| 需要用户 与否 | 是：开关 Wi-Fi |
| 通过标准 | 恢复网络后按退避表内补发；同一 run 合并；routine 被唤醒次数 ≤ 2 |
| 用时（开始/结束/持续） | 待执行 |
| 单元 id（不适用写明原因） | 待执行 |
| `notify status --json` 快照 | 待执行；脱敏后填入或引用本项证据文件 |
| `notify.log` 片段 | 待执行；仅分类与时间等公开元数据 |
| routine 唤醒时间（含时区） | 待执行；未唤醒亦需记录观察窗口 |
| argv 检查结果 | 待执行；无 worker 时注明不适用，不能写通过 |
| 结论 | 待执行 |
| 未覆盖原因 / 异常 / 证据引用 | 待执行 |

### M5N-R8 记录

| 字段 | 待填内容 |
|---|---|
| 场景 | 端点不可用：把秘密文件 URL 改为一个返回 404 的同主机路径（或删除冒烟 routine） |
| 需要用户 与否 | 是：改 routine |
| 通过标准 | `paused_endpoint_gone`；任务照常；兜底轮询发现并按 §11.5 提示 |
| 用时（开始/结束/持续） | 待执行 |
| 单元 id（不适用写明原因） | 待执行 |
| `notify status --json` 快照 | 待执行；脱敏后填入或引用本项证据文件 |
| `notify.log` 片段 | 待执行；仅分类与时间等公开元数据 |
| routine 唤醒时间（含时区） | 待执行；未唤醒亦需记录观察窗口 |
| argv 检查结果 | 待执行；无 worker 时注明不适用，不能写通过 |
| 结论 | 待执行 |
| 未覆盖原因 / 异常 / 证据引用 | 待执行 |

### M5N-R9 记录

| 字段 | 待填内容 |
|---|---|
| 场景 | Mac 重启 / 进程全灭：run 运行中 `kill -9` supervisor 与投递进程（模拟重启） |
| 需要用户 与否 | 否 |
| 通过标准 | 无自动通知（预期）；下一次兜底轮询（可手动触发该 routine）执行 status ⇒ `supervisor_crashed` 入队并送达 ⇒ webhook routine 处理 `resume_run` + `retry_task` |
| 用时（开始/结束/持续） | 待执行 |
| 单元 id（不适用写明原因） | 待执行 |
| `notify status --json` 快照 | 待执行；脱敏后填入或引用本项证据文件 |
| `notify.log` 片段 | 待执行；仅分类与时间等公开元数据 |
| routine 唤醒时间（含时区） | 待执行；未唤醒亦需记录观察窗口 |
| argv 检查结果 | 待执行；无 worker 时注明不适用，不能写通过 |
| 结论 | 待执行 |
| 未覆盖原因 / 异常 / 证据引用 | 待执行 |

### M5N-R10 记录

| 字段 | 待填内容 |
|---|---|
| 场景 | 伪造：user 用 curl 带正确密钥向 routine 发送一条指向不存在 run 的通知，以及一条 `kind=succeeded` 但 run 实际 running 的通知 |
| 需要用户 与否 | 是：执行 curl（密钥只在他手里） |
| 通过标准 | controller 两次都去 status 核实后不采取任何动作，不 land、不 resume；记录可疑通知 |
| 用时（开始/结束/持续） | 待执行 |
| 单元 id（不适用写明原因） | 待执行 |
| `notify status --json` 快照 | 待执行；脱敏后填入或引用本项证据文件 |
| `notify.log` 片段 | 待执行；仅分类与时间等公开元数据 |
| routine 唤醒时间（含时区） | 待执行；未唤醒亦需记录观察窗口 |
| argv 检查结果 | 待执行；无 worker 时注明不适用，不能写通过 |
| 结论 | 待执行 |
| 未覆盖原因 / 异常 / 证据引用 | 待执行 |

### M5N-R11 记录

| 字段 | 待填内容 |
|---|---|
| 场景 | worker 可读性（O-5）：fake provider 与真实 Codex（read-only 沙箱）各一个 job，任务是「尝试读取 `~/.config/gbdev/notify/` 下的文件并报告是否成功」，以及 env 中是否有任何 notify 相关键 |
| 需要用户 与否 | 否 |
| 通过标准 | 记录事实结论；env 中无任何 URL/密钥（必须通过）；若文件可读，在 §10 S-N8 写明并评估钥匙串默认 |
| 用时（开始/结束/持续） | 待执行 |
| 单元 id（不适用写明原因） | 待执行 |
| `notify status --json` 快照 | 待执行；脱敏后填入或引用本项证据文件 |
| `notify.log` 片段 | 待执行；仅分类与时间等公开元数据 |
| routine 唤醒时间（含时区） | 待执行；未唤醒亦需记录观察窗口 |
| argv 检查结果 | 待执行；无 worker 时注明不适用，不能写通过 |
| 结论 | 待执行 |
| 未覆盖原因 / 异常 / 证据引用 | 待执行 |

### M5N-R12 记录

| 字段 | 待填内容 |
|---|---|
| 场景 | 泄露扫描：冒烟结束后在 `/tmp/gbdev-smoke`、仓库、worktree、所有 controller 可见的命令输出中 grep 密钥 |
| 需要用户 与否 | 是：用户自己 grep（密钥只在他手里） |
| 通过标准 | 零命中 |
| 用时（开始/结束/持续） | 待执行 |
| 单元 id（不适用写明原因） | 待执行 |
| `notify status --json` 快照 | 待执行；脱敏后填入或引用本项证据文件 |
| `notify.log` 片段 | 待执行；仅分类与时间等公开元数据 |
| routine 唤醒时间（含时区） | 待执行；未唤醒亦需记录观察窗口 |
| argv 检查结果 | 待执行；无 worker 时注明不适用，不能写通过 |
| 结论 | 待执行 |
| 未覆盖原因 / 异常 / 证据引用 | 待执行 |

### M5N-R13 记录

| 字段 | 待填内容 |
|---|---|
| 场景 | Step 0 端到端：在冒烟 home 上从零开始（无秘密、本 bot 无 routine）让 bot 执行 Step 0；随后第二次使用 gbdev 再执行一次 Step 0；再用另一个 `bot_label` 尝试 ack |
| 需要用户 与否 | 是：在面板复制 URL/密钥并 `notify setup` |
| 通过标准 | 第一次：bot 建 routine 并发面板链接，user setup 后 bot `notify test`，被唤醒的 routine 执行 `notify ack`，发起方在 2 分钟内看到 `init.state=verified`；第二次：静默通过、零消息；他 bot ack ⇒ `bound_to_other_bot` |
| 用时（开始/结束/持续） | 待执行 |
| 单元 id（不适用写明原因） | 待执行 |
| `notify status --json` 快照 | 待执行；脱敏后填入或引用本项证据文件 |
| `notify.log` 片段 | 待执行；仅分类与时间等公开元数据 |
| routine 唤醒时间（含时区） | 待执行；未唤醒亦需记录观察窗口 |
| argv 检查结果 | 待执行；无 worker 时注明不适用，不能写通过 |
| 结论 | 待执行 |
| 未覆盖原因 / 异常 / 证据引用 | 待执行 |

## 回填与未决项

- R1 回填 O-1 实际 header/字段名及前缀、HTTP 状态码、延迟、payload 是否原样保留、URL 是否含 token；不记录实际 URL/key。将 O-1 结论写回 SPEC-M5 后再锁定用法文档默认说明。
- R3/R4 记录 routine 本地调用是否要求逐次审批（O-4）；R5 记录去重与并发 decision 冲突；R6/R7 记录实际唤醒次数和积压合并。
- R11 回填可读性事实，若同 uid worker 可读则更新 §10 S-N8 风险评估；钥匙串不是未经实测的安全保证。
- R13 首次真实 test/ack 完成时限 2 分钟；第二次静默零消息；另一 bot ack 必须 bound_to_other_bot。R12 扫描必须零泄露；失败不能因任务成功而忽略。
