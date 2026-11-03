> Historical design specification. Milestone labels describe design evolution; consult README.md and docs/reference.md for current behavior. Private execution records are not release certification.

# gbdev M7：controller 固定决策角色、缺失 verdict 保护与按需只读取材

> M9 网络策略注记：M9 起 `network` 默认 `true`，可显式 `false`；下文禁网/仅 false 的描述保留为历史规格，不代表 M9 当前行为。inspect 固定联网查资料，但仍禁止 tests/scripts/installs/hooks；其余当前边界见 README 的网络策略说明。

> 实现级规格，2026-10-31。基线：`gbdev-controller`，HEAD `109e981`，基于 master `e537cc4`。
> 需求事实源：`docs/controller-role.md`，特别是 R1–R6、G1、G2。本规格不修改该需求文档。
> 本次规划只新增本文件，不实施、不提交。下文的改动清单与测试命令供后续实现使用，不表示已经执行或通过。

## 0. 边界与交付规则

1. Node 24、TypeScript、运行时零第三方依赖；不安装依赖。沿用 `contract_version: "1"`，旧记录可读，新字段可选、按新功能显式启用。
2. **不得修改 `src/notify/http.ts`**，也不增加另一条 HTTP 发送链。inspect 的完成通知复用事件、outbox、trigger、deliver 和既有 webhook。
3. worker 只读对应检查 worktree 内的项目文件；不得读取仓库外路径、其他 worktree、真实用户配置或秘密。gbdev 主进程读取自身已记录的检查证据后，只把有界片段作为不可信数据提供给 worker，绝不把外部日志路径交给 worker 打开。
4. worker 不联网（模型 API 除外）、不安装、不 push、不修改目标分支；inspect 不执行测试、安装命令、仓库脚本、hooks、submodule 初始化或 worktree setup 命令。既有 webhook 由独立可信投递进程发送，不是 worker 的网络授权。
5. 永不使用批准/沙箱绕过参数或关闭沙箱的参数；新文件和新增行中也不得写出对应禁用 argv 字面量，包括“禁止”示例。进程直接使用 argv 数组，禁止 shell 布尔开启写法。沿用安全扫描，并对 M7 新增行做更严格的无字面量检查；本规格不复述被禁字符串。
6. Cursor 实际调用只有 `--model auto`；只读继续使用现有 adapter 的启用沙箱及 plan 模式，不使用写入模式。resolver 不能使用 Cursor。Codex 永远 high effort；M7 开发、部署示例及 controller 工作流中 Codex 固定 `gpt-6-astra` + `model_reasoning_effort=high`。
7. 不借 M7 重设原六个内置角色的 provider/model 默认值：基线角色的 `codex_model` 可为 null，provider/model 覆盖字段是既有产品能力。上条的工作流模型要求不能通过偷偷改掉这些默认值实现；文档明确配置示例与内置默认的区别。既有合法 Codex/Cursor 工程角色覆盖机制保留，high、Cursor auto、resolver 限制不放宽。
8. 自动测试只用 `os.tmpdir()` 下临时 HOME、GBDEV_HOME、GBDEV_CONFIG、GBDEV_CLI_HOME、临时 Git repo、fake provider/provider stub、fake tmux。默认测试不访问真实 `~/.gbdev*` 或用户配置，不联网、不调用真实模型。通知测试注入投递器，不发送真实 HTTP 请求。
9. 不改变旧命令在没有使用 M7 新功能时的默认行为，例外仅为缺失 verdict 的接受保护，以及需求明确要求的固定决策角色拒绝。角色 list 增加 inspector、doctor 角色计数增加属于追加能力，不重排旧角色之间的顺序。
10. 四个切片按 S1→S2→S3→S4 实施，每片可单独提交、`npm test` 全绿。测试入口必须更新 `test/index.ts`。本次 planner 不运行 `npm test`，因为构建会写生成文件和 dist；仅进行仓库内只读核对及本文件写入。

## 1. 背景、范围及非范围

### 1.1 已核对的实现事实

| 事实 | 代码位置 | M7 影响 |
|---|---|---|
| 缺失或非法 reviewer verdict 已自动重试一次；随后暂停；同一 step 最多三个 attempt | `src/pipeline/gate.ts`、`src/pipeline/supervisor.ts`、`src/pipeline/resume.ts` | 不另加无限重试；自动重试算作“先重试审查” |
| pipeline 的 verdict_missing 动作本来就是 retry、accept；accept 无取证门槛 | `DECISION_ACTIONS`、`preparePipelineResume` | 仅排序不能修复 G1，必须在接受路径拒绝缺少显式取证确认的输入 |
| run task_paused 将 pipeline 动作透传，run resume 最终调用同一个 preparePipelineResume | `src/run/supervisor.ts`、`src/run/decisions.ts` | 共享强制校验，避免 run/pipeline 两个入口标准不一 |
| final review 两次无结论后也是决策，但 reason 为 final_review_revise，detail 含缺失说明 | `src/run/finalReview.ts`、`src/run/supervisor.ts` | 必须读结构化 final-review 事实，不能通过 detail 文本匹配判断缺失 |
| 普通 start 创建新分支/worktree，并用 assertIdle 排斥活动 run | `src/commands/start.ts`、`src/commands/pipeline.ts` | inspect 不能简单调用普通 start，也不能占用其“一个写任务”所有权 |
| task 完成或暂停时 lane 被 park，task.lane 清空，lane 可供另一 task 使用 | `src/run/supervisor.ts`、`src/run/lanes.ts` | 历史 job.worktree 路径不代表历史任务内容；必须固定 SHA |
| 子 job 带 run_id/pipeline_id 时不单独通知 | `src/notify/filter.ts` | inspect 是独立 job，目标关联另存，不能误填所有者字段 |
| notify next_step 是 status 命令，不是 resume 命令；payload 显式投影且最多 2048 UTF-8 字节 | `src/notify/payload.ts`、`src/contracts/notify.ts` | 保留安全提示方式，不塞入取证确认或自动 accept |
| check 日志在 job 的 checks/；run gate 日志由 runGate 写入 gate.log_dir | `src/core/finalize.ts`、`src/run/gate.ts` | 由 gbdev 按可信索引取有界日志，不采用 worker 自报 tests 作为执行证据 |
| 角色生成器硬编码六个名字；M6 快照包含全角色列表及旧提示 | `scripts/gen-roles.mjs`、`test/m6-s1-roles.test.ts` | 增加 inspector 必须同步生成器和列表断言，旧提示不能顺便改写 |
| config 有些未知键会被忽略；用户覆盖错误常被归一为 role_invalid | `src/core/config.ts`、`src/roles/registry.ts` | 固定角色键应在忽略前拒绝，专用错误码要贯穿包装层 |

### 1.2 范围

- R1–R6 在 skill、recipe、README 中一致；保留 M5/M6 的 home、notify、dashboard、批准与安全规则。
- 缺失 verdict 时先重试；接受必须有 controller 明确的取证确认与结论说明，并留可审计记录。
- 增加可配置的 inspector 工程角色和异步 `inspect` job，返回有界、可定位、可校验的片段。
- 拒绝把 controller/dispatcher/decider 当成可覆盖、可派发的 worker 角色。

### 1.3 非范围

- 不修 G3 的所有 Cursor 结构化输出根因；本版对 inspect 的结构化结果 fail closed，但不重写旧 reviewer 容错机制。
- 不实施 G4 格式检查前移、G5 越界恢复策略，也不改日常审查/修复/回滚循环。
- 不部署 controller 侧 skill/routine，不读真实 home，不初始化、不安装、不 land、不提交或推送。
- 不让 inspector 自动 approve/retry/resume；其答案是证据，不是 verdict，也不是用户授权。
- 不提供任意文件系统浏览、任意 Git ref、任意 shell 命令、外部 URL 抓取或重新运行测试的入口。
- 本版检查**固定已提交快照**，不捕获正在写入的工作树、未提交/未跟踪文件或未完成日志。不要把结果描述为“实时全量检查”。

## 2. 已选定的设计决策

| 编号 | 决策 | 否决的替代方案及理由 |
|---|---|---|
| D1 | controller 是产品控制面固定角色，不注册为可执行 RoleDefinition；保留角色名由公共校验器拒绝 | 新增可覆盖 dispatcher role.json 会让 R6 可被绕过 |
| D2 | verdict_missing 接受使用显式 `verdict_missing_reviewed: true` 加必填 note；还须有已完成的审查重试事实 | 仅推荐 retry/发警告仍允许无声 accept，不能修复 G1 |
| D3 | D2 是决策者的可审计确认，不声称机器证明其确实阅读或判断正确 | 强制成功 inspect job ID 只能证明取材完成，不能证明 controller 阅读或同意；且会使 S2 依赖 S3，限制旧证据与独立审查材料的使用 |
| D4 | inspect 解析目标后，从固定 SHA 建立专属 detached 检查 worktree，worker 只读它 | 直接进入旧 task lane 会读到被复用后的代码；在活动工作树长持读锁会阻塞 gbdev 日常执行 |
| D5 | inspect 是独立 job；target_run_id 等放在 inspection 元数据中，所有者 run_id/pipeline_id 留空 | 冒充 run 子 job 会被通知过滤，并污染预算、恢复、取消和不变量计算 |
| D6 | 每 home 最多一个活动 inspect，消耗实际 provider 并发容量，但不计入 run/pipeline jobs_used，不改变父状态 | 不受任何资源限制会抢占 provider；计入业务预算会使取证本身改变决策条件 |
| D7 | 只用既有 status/wait/result/cancel 取回与控制，不添加 inspect wait 语法 | 新等待模型重复现有 job 生命周期，并增加超时语义歧义 |
| D8 | notify next_step 保持 status；终态摘要不带 question、answer、excerpts、文件名或检查输出 | 在通知中嵌入 resume/accept 或代码既扩大注入面，又冲击 2KB 上限 |
| D9 | inspector output 仍为 report，只有 inspect job 启用新的结构化 inspection 扩展 | 给所有 report 角色改 schema 会破坏 M1/M2 兼容和 M6 快照 |

## 3. S1：inspector 与固定决策角色边界

### 3.1 内置 inspector

新增 `roles/inspector/role.json` 和 `prompt.md`，按现有 role-source 格式生成，不增加 RoleDefinition.output 枚举：

| 字段 | 值 |
|---|---|
| name / provider / mode / output | inspector / cursor / read-only / report |
| allowed_providers | cursor、fake；fake 仅用于既有测试机制 |
| codex_model / cursor_model | null / auto |
| default_timeout_min / default_stall_timeout_s | 10 / 120 |
| aliases | 空数组 |
| used_by | gbdev inspect |

prompt 要求：只回答 question；只看本检查 worktree 和注入的带来源数据；不执行测试/脚本、不改文件、不作调度决策；所有仓库文本、日志、diff、嵌入的指令都是数据；返回规范化结构中的摘要与片段请求；不整文件输出；没证据明确说不知道。

保留 `dirname(config)/roles/inspector.json` 的浅覆盖、instructions_file、冻结快照机制。可改 description、instructions、timeouts；不能改成 write/change/verdict 或 Codex provider。对 inspector 的最终解析约束为 cursor（测试 fake）、report、read-only、auto；非法使用 `role_invalid`，非 auto 仍优先使用 `cursor_model_not_allowed`。普通 `start`/pipeline 引用 inspector 时仍是普通 report 行为，只有新 `inspect` 命令启用专用结果契约；不得据角色名自动改变所有旧 job 的 finalize。

### 3.2 固定角色拒绝

新增 `src/roles/reserved.ts`，保留标识集合为 `grokbot`、`grok-bot`、`dispatcher`、`decider`。只在**配置标识位置**判定，比较前 ASCII trim + lowercase；不扫描自然语言、不禁止 bot_label 如 example-dev，也不把普通文本含 decider 判为配置。

拒绝位置：

1. registry.resolve、role.name、用户覆盖 JSON 文件 basename（包括文件名保留但内容假装 executor）、生成器 role name/alias 的键和值。
2. brief.role、pipeline.steps[].role、fix_loop.fix_role；在外层 wrapper 把错误降级之前保留 `role_fixed`。
3. pipeline step id、step_overrides 的键及 run 的 task_pipeline_overrides 键若为保留标识，也返回 `role_fixed`；不要让 `step_overrides.dispatcher` 仅报“未知 step”而暗示可新增。
4. 覆盖对象尝试写 `role`/`name` 为保留标识，或角色定义尝试 aliases 指向保留标识，先 `role_fixed`；非保留的未知字段继续原校验。
5. config 顶层保留键、providers 中保留键、顶层 roles 对象中的保留键；这些键即使值为 null 也不得被静默忽略。不新增通用 roles 配置功能，只识别并拒绝这一类伪配置。run_defaults 等闭合对象中的同类键同样明确报错。

`role_fixed`：exit 2、retryable=false，details 为 `{name, surface}`，不回显配置正文；消息说明 controller 是固定控制面角色、不能配置或作为 worker 派发。`roles show dispatcher` 必须是此码，不是 role_not_found。`roles list` 保留原“列出 invalid、CLI 成功”的诊断方式，但 invalid[].code 为 role_fixed；doctor roles 检查失败。无效的保留文件不妨碍无关合法工程角色解析；请求该标识不能回退或绕别名。

不提供 controller provider/model/prompt 开关，不新建 dispatcher 角色文件，不修改 controller 外部服务配置。

## 4. S2：缺失 verdict 的接受保护

### 4.1 判定与入口

新增共用 `src/core/verdictAcceptance.ts`，只处理缺失 verdict，不改变正常 approve、revise、reject 或其他暂停原因。

- pipeline：以当前 decision.reason/state_reason、该 instance 的 gate 及 attempt 结果认定 verdict_missing；不得依据输入 note 或自由文本 detail。
- 缺失 verdict 之后自动/手动 retry 若被 job_budget_exhausted 截住，未解决的 G9 缺失事实仍从该 step 最近结果识别，接受保护不能因暂停 reason 改成预算耗尽而消失；正常预算暂停、从未出现缺失 verdict 的情况不新增此限制。
- run task_paused：从当前 attention.pipeline_id 读取真实 pipeline；`prepareDecisions` 透传新增字段到 `preparePipelineResume`。run detail 只供显示，不作安全判断。
- run final review：`final-review.json` 中 verdict=null 且对应 final-review job/attempt 可核实，视为同类缺失；`accept_final` 也应用该保护。已有结构化 revise/reject 的 accept_final 语义不改变。
- 缺失/损坏的所需记录不能按“不是 verdict_missing”放行。返回既有状态/结果损坏错误或本节明确错误；不猜结论。

### 4.2 接受的精确条件

向 `gbdev.run-resume.v1` 和 `gbdev.pipeline-resume.v1` 增加可选 boolean `verdict_missing_reviewed`。未提供与 false 均代表未确认；旧输入不因缺字段而 schema 失败。

只有下列条件**全部成立**，缺失 verdict 的 accept/accept_final 才成功：

1. 当前动作、task、decision ID 与既有 allowed_actions 校验通过；旧 stale decision、run ownership、批量原子校验优先保持。
2. 存在至少一次已完成的相同审查重试：pipeline 同一 step instance 至少两个已结束 attempt，最近结果仍缺 verdict；final review 同一轮审查至少两个已结束 attempt。自动重试计入，rate-limit 后未实际结束审查的重复启动不算。只数其他 task、历史轮次或 job 总数不算。
3. `verdict_missing_reviewed === true`。
4. 既有 note 为非空（trim 后）、最多 2000 字符。note 由 controller 写明：所看 diff 的基准/目标 SHA、检查结果或缺失情况、取证来源（S3 后通常为 inspect job ID）、接受理由及残余风险。代码只强制非空和长度，不对自然语言作虚假的语义验证。

失败码：

- 尚无重试事实：`verdict_retry_required`，exit 1、retryable=false，details 含 unit_id、instance/decision_id、retry_available；next_steps 建议读取当前 status 后 retry。若没有可用 retry，保持暂停，不能伪造动作，交由 controller选择其他合法恢复/取消并报告阻碍。
- 已重试但未 true 或 note 空：`verdict_evidence_required`，exit 1、retryable=false，details 含上述定位和 `required_fields`，提示深读 diff/测试输出后显式确认。
- 字段类型非法，或 true 出现在非上述缺失接受场景：分别沿用 schema 错误和状态冲突错误；false/缺省在旧场景不增加限制。不要让无关动作吞掉一个 true。

不新增绕过开关；不把 true 自动填进示例、notify 或重试请求。这个设计是**明确的决策者证据声明**，不是 inspector 的机器证明，不校验 note 中的 job ID 是否成功；该限制必须在文档中如实说明。

### 4.3 推荐动作、审计及恢复

- verdict_missing 且 retry 尚可用：`allowed_actions` 中 retry 保持第一；新增可选 `recommended_action: "retry"`。第三次结束后去掉不可用 retry，recommended_action 为 null；不能把 accept 标为推荐。
- pipeline decision 和 run attention 仅对这一原因增加该元数据。final review 没有现成 retry 动作，recommended_action=null，不发明 retry_final；自动两次已满足重试条件。
- status 人读输出明确显示“缺少结构化审查结论；接受需取证确认”，JSON 用可选 `accept_requirements: ["verdict_missing_reviewed", "note"]`。旧持久化记录可在 status 投影时补充，不能仅因 status 读取改写原文件。
- 成功后仍用 `accepted_by_decider`，绝不伪造 reviewer approve，不改 worker_result_warnings，不删除原缺失结论。
- pipeline 的 resume input 文件及一个 `verdict_missing_accepted` 事件保存 `{by, instance, job_ids, note, verdict_missing_reviewed:true, at}`；run 的 resolved 决策记录也保存字段和 note，run result 能显示它。审计只记本地事件，不把 note 放 webhook。
- 在 prepare 阶段完成全部校验，任何失败都不写 continuation、inputs、result、决策历史，不消耗 decision。批量 run resume 中一项缺证据，整批零应用。
- CLI 预校验和 supervisor 读取 pending input 时均校验；离线旧 input 文件不能成为绕过。保护位于执行 accept 的共用函数，不只在参数解析器。

### 4.4 Webhook 不变项

保留 `gbdev.notify.v1` 和 next_step 的 status 模板，无新的 accept 命令提示。status 才显示 retry/recommended/accept_requirements。任何含超长 note 的接受仍产生 ≤2048 字节通知；正文没有 note、代码或检查输出。不修改 http.ts，也不为 verdict_missing 新增发送 API。

## 5. S3：按需 inspect CLI 与生命周期

### 5.1 精确 CLI 面

总 HELP 的 Commands 增加 inspect，并增加以下用法行（HELP 内可照旧省略首个 gbdev）：

```text
gbdev inspect <run_id|job_id> --question <text> [--task <task_id>] [--paths <relative-path>]... [--diff] [--tests] [--json]
```

沿用以下既有命令，不新增选项：

```text
gbdev status <job_id> [--json]
gbdev wait <job_id> --timeout-ms <n> [--json]
gbdev result <job_id> [--json]
gbdev cancel <job_id> [--json]
gbdev cleanup <job_id> [--dry-run] [--force-branch] [--json]
```

- question 必填，trim 后非空，UTF-8 ≤4096 字节，拒绝 NUL；是问题数据，不能当 shell 执行。
- `--task` 只允许与 run_id 同用，task ID 必须存在；裸 task_id、pipeline_id、任意目录/ref 不接受。独立 pipeline 通过当前 reviewer 或其他 step 的 job_id 检查。
- `--paths` 可重复，每次一个文件或目录相对路径，最多 20 项，每项 UTF-8 ≤256 字节；不是逗号列表，不解释 glob、不展开 tilde/env、不使用 Git pathspec 语法。目录按字面前缀授权；无 paths 表示固定快照内的普通项目文件，不表示机器所有文件。
- diff/tests 是附加证据通道，不互斥。未指定时仍可按 question 在允许的固定文件范围取材。
- 无 `--provider`、`--model`、`--worktree`、`--base-ref`、`--wait` 或 `--request`；角色通过既有 inspector 用户覆盖配置。未知/重复单值/多余位置参数为 usage_error，创建 job 前失败。
- 默认异步返回 `gbdev.inspect-start.v1`，exit 0 只代表成功派发。等待超时不取消 job；result 的成功 envelope 不代表 job state=succeeded，沿用既有语义。

### 5.2 目标定位：不可把 lane 路径当历史内容

目标元数据从当前 GBDEV_HOME 的已校验记录读取，repo 仍须通过 allowed_repos 的精确 realpath 白名单。不接受用户传入路径覆盖。所有 SHA 经 Git commit 对象校验并固定；不能回退到当前 HEAD。

| 目标 | 源 worktree 关系 | 固定 target_sha | diff_base_sha |
|---|---|---|---|
| run_id，无 task | run.integration.worktree | run.integration.verified_sha；即最近完整通过门禁的集成版本 | run.base_sha |
| run_id + task | task 当前 lane 或最近 attempt 的 workspace 仅用于标注来源；park 后不使用其当前内容 | task.head_sha；正在执行且尚无已记录 head 时用该 attempt 的 base，标注 active_target_base_only；无 attempt/base 则不可检查 | 当前 attempt pipeline.diff_base_sha，缺该记录不猜 |
| 独立 job_id，已终态 | job.worktree 的历史源关系 | gbdev_observed.head_after | job.base_sha |
| pipeline step job_id，已终态 | pipeline.workspace/旧 lane 的历史源关系 | 该 job 的 gbdev_observed.head_after，不用 pipeline 最新 head | 所属 pipeline.diff_base_sha |
| run 内部 planner/verifier/final review job | run/job 的源关系 | 终态用该 job 的 observed head_after；活动时仅 base_sha | run.base_sha；merge_resolution job 只用其 base_sha，明确不还原冲突现场 |
| 任意活动 job_id | job.worktree 的历史源关系 | job.base_sha（上一个固定版本） | 按上述所属类型规则 |

task 已 integrated 时仍看该 task 记录的 head，不自动切到 integration。历史 worktree 已 cleanup 但 commit 对象仍存在时可以检查；对象缺失返回 inspect_target_unavailable。job_id 指向 inspect job 本身时拒绝递归检查，以免拿取材输出再冒充新证据。

创建 `<home>/worktrees/<repo-name>/<inspect-job-id>` 的专属 detached worktree，HEAD=target_sha；**不创建 branch、不切换源 lane、不运行 setupWorkspace**。为兼容 JobStatus.branch 的非空合法分支名约束，该字段使用 `gbdev/<inspect-job-id>` 作为合成展示标识，绝不创建对应 ref；不能填源 integration.branch，否则基线 runJobs 的分支相等兜底会把它算成父 job。源分支另存在 inspection.request.json 的 source_branch。inspection.workspace_owned=true、detached=true，cleanup 必须走专用逻辑，不以展示标识删除 ref。`worktree` 是真正的 worker cwd，`source_worktree` 只是可信本地审计元数据，不写入 worker prompt。

所有检查都标记 `snapshot_mode: "committed"`、`uncommitted_included:false`。run 正在 merge 时使用 verified_sha，不读半合并现场；结果不能宣称检查了尚未验证的新版本。源后续前进不让 inspect 失败；result 记录 captured_at，controller 恢复前再核对决策和 SHA。

### 5.3 Job、结果和事件链

复用 JobStore、job ID、事件序列、superviseJob、deadline、stall、取消和进程组清理。新增 `kind: "inspect"` 及可选 inspection 元数据，不复用 `runJob` 的预算 hook。

- 所有者字段：run_id/task_id 不设置，pipeline_id=null、step_instance=null、attempt=null、parent_job_id=null。关联目标 ID 均在 inspection.target 中，不能参与 runJobs/invariants；runJobs 还应先排除 kind=inspect，再执行旧记录的 branch/pipeline 兜底匹配。取消、cleanup、恢复中的旧分支名所有权判断也必须覆盖此用例。
- brief：read-only、network=false、acceptance_criteria=[]，不执行 check_cmd；冻结 inspector instructions、来源、hash、provider bin、timeouts。
- 排队/启动/运行沿用 queued→starting→running；成功为 succeeded，取消/超时/崩溃沿用现有终态。inspect 若只能得出“证据不足”，可以 succeeded 但 answer 必须说明，coverage 标记缺失；没有合法结构化结果则 failed，不用普通只读 prose 交付例外。
- `WorkerSchemaOptions` 增加显式 inspection 开关；该开关才向 worker-result 扩展 inspection（候选摘要与片段），不改变默认/M2/planner/resolver 的 schema。
- finalize 在终态发布之前验证 inspection，生成规范化 `JobResult.inspection`；不要让不合法的 worker 原文通过 worker_reported.inspection 旁路泄漏。该字段要替换成已验证、有界内容，或从公开 worker_reported 投影删除。
- 写完 result 再 transition terminal，再由既有 runtime.event→notifyEvent 发送；失败/取消/timeout 同样有 terminal。启动后出错也必须落 result+terminal，不留下永远 starting 的 inspect。
- 缺 raw、非法 JSON、越界 excerpt、修改检查 worktree、输出超限均失败；没有 answer 时不得仅凭 provider exit 0 成功。
- 普通 status/wait/result/reconcile 能处理新 kind；supervisor 死亡按既有身份核验清理进程，只标 inspect 失败，释放 inspect 资源，父 run/pipeline 不失败、不自动 resume。
- inspect cancel 只停自身；run cancel/cleanup 不将它当子 job 杀掉。独立快照生命周期使父 cleanup 与 inspect 可以并行。
- inspect cleanup 只移除其专属 detached worktree，永不删除源分支/ref，`--force-branch` 不能扩大权限；dirty 仍拒绝，证据目录保留，重复 cleanup 幂等。

### 5.4 Diff 与测试证据

**Diff：** gbdev 按固定 commit 对计算 `diff_base_sha..target_sha`，禁用 external diff、textconv、hooks，不运行仓库属性指定的程序；不使用工作树当前 HEAD，不提供用户自定义 diff argv。paths 通过字面过滤，不能转成含魔法的 pathspec。文本按文件/hunk 保存为虚拟来源 `diff:<repo-relative-path>`，source line 是该文件的 patch 文档行号；hunk 自身保留 Git 的旧/新源码行号。二进制、submodule 只给类型/路径/哈希元数据，不展开内容。

**Tests：** 只由 gbdev 的可信检查索引派生：

- job：其 result.gbdev_observed.checks，对应 `jobs/<job_id>/checks/*.log`。
- task：当前 attempt pipeline 中已终态的实现/fix job checks；有 merge 记录时可包含该 task 对应 gate。
- run：已完成的 baseline-gate、merge record gate，以及已完成的关联 task checks；不读取正在增长的 gate.log。
- pipeline step job：读取同一 pipeline、时间不晚于目标 job 的已完成 checks，并标出来源 job、检查时 SHA。reviewer 自身没有 checks 不能解释为“测试已通过”。

gate.log_dir 虽来自 gbdev 记录，也须校验落在当前 run 的可信目录；check.log 必须是相应 job/checks 下的普通文件。逐组件拒绝符号链接，打开使用 no-follow、非阻塞标志及 fstat，拒绝 FIFO、设备、绝对/父路径逃逸。不能直接信任 worker 的 ref、cmd、日志里提到的路径。日志正文经过已有 sanitize/redact，再以 `test:<source-unit-id>/<check-id>/<ordinal>` 虚拟路径传入 prompt，带原始逻辑行号范围、exit_code、checked_sha（未知为 null）。这些虚拟路径不是可打开的本机路径。

每个日志最多末尾 80 行且 8 KiB；最多 10 个日志，按最近完成时间倒序、ID 破同序。只给已经记录的退出码，不重新执行 check。缺失、被截断、过期/不同 SHA、无测试和 unsafe 日志都必须体现为 coverage/warnings，不能伪造通过。安全拒绝路径不把其内容纳入 prompt。

### 5.5 输入与输出预算、路径与行号校验

所有字节限制按 UTF-8，裁剪不拆 Unicode 码点、不生成坏 JSON；所有边界取常量并集中在 `src/inspect/limits.ts`。

| 层 | 上限与处理 |
|---|---|
| worker prompt 的动态证据包（含转义/标签） | 64 KiB；先放来源清单和检查摘要，再放选定 diff hunks、日志片段；截断保留可解释的 warnings |
| 单个源码候选源 | 普通 UTF-8 文件 ≤1 MiB；二进制/超限文件不整读，由结果说明不可取片段 |
| 候选 inspection JSON | 64 KiB；未知字段/类型/行号错误直接失败，不靠截断修复结构 |
| inspect provider raw+stderr | 合计 1 MiB 硬上限；达到即终止自身进程组，failed/inspect_output_too_large；仅 inspect 启用，不改旧 job 输出策略 |
| answer | 2048 字节；摘要，不是全文容器 |
| excerpts | 最多 8 个；每个最多 40 行、2048 字节；总 text ≤8192 字节 |
| 完整规范化 gbdev.inspect-result.v1 | JSON 序列化 ≤16384 字节（含元数据）；依次缩短 answer、减少末尾 excerpts、压缩 warnings，永不裁断 JSON |

excerpt.path 是 repo-relative 普通文件路径、或 gbdev 提供的 diff:/test: 虚拟来源；不接受绝对路径、空段、父路径、NUL、Git 控制路径、冒号协议、路径前缀混淆。源码路径须在 paths 授权范围，逐组件禁止 symlink，不跟随指向仓库外或另一 worktree 的链接。Git 历史 symlink/gitlink 不作为普通文件返回。不存在/不在 manifest 的虚拟来源不能补读。

行号为 1-based inclusive 正整数，start_line≤end_line。对源码由 gbdev 在固定检查树校验范围并重建文本；对 diff/tests 只能在已提供的来源行区间重建。不得相信 worker 自报 text，若与规范来源不符则失败，不能当成引文显示。按整行裁剪并同步 end_line；单行超长不能截半行冒充原文，应省略并标记。CRLF 统一为 LF，去除终端控制字符，打码发生在比较用的规范文本层，行号仍对应原始逻辑行。

不整文件返回：每个源码文件的全部 excerpts 的范围并集必须是其行集合的真子集；否则删减末段并标 `whole_file_omitted`。单行/极短文件可只给摘要和空 excerpts，不硬凑一段全文。diff 不输出整份 patch，日志只输出相关片段。answer 不得用来粘贴全文；测试覆盖可识别的全文复制及模型提示约束，但不声称能算法证明所有自然语言摘要都无重述。

### 5.6 并发、预算与锁

- 固定提交检查不占用 lane，不持有源 integration.lock，不等待工作树变干净，也不参与 merge queue。专属 worktree 创建/删除的 Git 元数据操作沿用全局锁约定，模型运行期间不持全局锁。
- `inspect` 单独 admission，不调用 assertIdle；每 home 最多一个 starting/running/queued inspect，无无限队列。第二个请求返回 busy，并给 running_job_id。
- 为 inspect 建独立资源 reservation（`<home>/inspect/lease.json`，含 job_id、supervisor 身份、provider；0700/0600、原子写）。run.slots 仍只表示 run-owned worker；provider 可用容量按 run 已占/已预留槽位 + 独立 inspect reservation 计算。不能仅数 running jobs，必须计入尚未创建 job 的 run 槽位预留。
- run slot acquire 与 inspect admission 在同一个全局锁下完成检查/预留；run 内存 leases 发布给 admission 使用，不能依赖可能滞后的 run.json。最小新增共享 reservation 视图由 `src/core/workerReservations.ts` 管理，只在 inspect 存在时减少可用容量；原调度优先级、默认总槽数不变。legacy standalone worker 也计入占用，不允许与 inspect 合计超限。
- 容量使用既有 parallel.max_workers/provider_limits，读取时不触发与本 inspect 无关的 run_defaults 模板校验；provider cooldown 适用。没有空位时 inspect 返回 busy（不创建 job/worktree/预算项）；不抢占 worker、不自动延长预算、不修改父 run state。inspect 自身 rate limit 记录失败/可重试信息，不向父注入 budget decision。
- 已有 start/pipeline/run 的“写任务互斥”忽略 inspect 的顶层 job 身份，但真实 provider 启动仍须尊重 reservation。无 inspect 时所有旧 busy/调度行为一致。
- 崩溃恢复不能仅因 PID 不存活就回收别人 lease：使用现有进程身份/worker pgid 核验，结束残留 inspect 进程后释放。重复终态/取消/cleanup 不能多减槽。预算、task attempts、runJobs 和最终 jobs 统计不包含 inspect。
- 核心断言：在父 run 被 fake barrier 固定时，发起、完成、取消 inspect 前后父状态/decision/budget/slots 字节值不变；正常父执行引起的时间和进度变化不归因于 inspect。

### 5.7 Status、dashboard、notify

- inspect 出现在普通 `status` 列表和 dashboard index，是独立 job 窗口，一个 job pane；标题标 inspector，显示 target ID/可选 task/短 SHA/committed，不增父 lane 窗口。
- inspection.target 元数据由 status/result 提供；不设置顶层 run_id/pipeline_id 来“帮助 UI 关联”。`dashboard/desired.ts`、render index 对新 kind 要有显式测试。
- `logs`/pane 对 inspect 只显示安全进度和规范化结果片段，不把未经校验的模型 raw/final 全文当作返给 controller 的取材接口；内部诊断文件仍有大小上限和既有权限，不在 webhook 暴露。
- notify 使用独立 `unit_kind=job`、unit_id=inspect job ID、kind=succeeded/failed/cancelled/timeout，next_step 仍为该 job status。不必修改 notify schema/filter；若接线遗漏，应修正 job 元数据而非放开所有 run 子 job 通知。
- 成功 terminal 必须在 `result` 可读后入队；重放保持 notice ID 幂等、通知失败不改 job 状态。复用 filter/enqueue/trigger 的测试注入，并验证实际请求体 ≤2048 字节。
- controller 收到 inspect terminal 后取 result、回到原 attention 再核实，不报告“实现已完成”，不询问合并 inspect，不自动产生 accept。

## 6. Schema 与错误码汇总

### 6.1 新契约

新建 `src/contracts/inspect.ts` 及相应 JSON schema，闭合对象，所有限制在 TypeScript 验证器和 schema 一致表达；不能表达的字节数/跨字段约束由验证器补足。

**gbdev.inspect-start.v1**（CLI envelope 的 result_schema）：

```text
schema, job_id, state,
target: {kind: run|job, id, run_id: string|null, task_id: string|null, job_id: string|null, pipeline_id: string|null},
snapshot: {mode: committed, target_sha, diff_base_sha, captured_at, uncommitted_included: false},
question, paths: string[], diff: boolean, tests: boolean,
dashboard: <既有 hint>, notify: <既有 hint>
```

**gbdev.inspect-result.v1**（`gbdev result` 的 `result.inspection`，外层仍是 gbdev.job-result.v1）：

```text
schema, job_id, target: <同上>, snapshot: <同上>,
answer: string,
excerpts: [{path, start_line: integer, end_line: integer, text}],
coverage: {
  files: {requested: string[], omitted: string[]},
  diff: {requested: boolean, available: boolean, truncated: boolean},
  tests: {requested: boolean, available: boolean,
          checks: [{source_id, check_id, exit_code: integer|null, checked_sha: string|null, log_available: boolean}],
          truncated: boolean}
},
truncated: boolean,
warnings: string[]
```

target/snapshot/coverage 由 gbdev 生成，worker 不得声明或覆盖。worker 候选 `inspection` 仅为 `{answer, excerpts}`；结构有效后 gbdev 验证、重建、裁剪并填上其余字段。候选不含 schema/job_id 以免和可信外层混淆。warnings 为有限枚举（input_truncated、output_truncated、whole_file_omitted、tests_unavailable、tests_stale、log_unavailable、binary_omitted、active_target_base_only、uncommitted_excluded）；path 省略清单也受总预算，超限保留计数到 answer 的规范提示而不无限扩展。

`inspection.request.json` 是 gbdev 的内部冻结清单，记录 source IDs/路径映射/hash/角色快照与专属 worktree 身份，权限 0600；worker 不读取此文件。JobStatus.inspection 只暴露有界 target/snapshot/请求标志与 workspace_owned/detached，不能暴露外部日志真实路径。失败 JobResult.inspection=null，failure_reason 明确；合法但证据不足可为 succeeded，coverage 必须区分 unavailable 与 passed。

### 6.2 追加修改的现有契约

| 契约 | 追加/修正 |
|---|---|
| gbdev.role-list.v1 | 第七个角色；invalid[].code 允许 role_fixed，既有 alias 保持唯一 code-reviewer→reviewer |
| gbdev.run-resume.v1 / pipeline-resume.v1 | 可选 verdict_missing_reviewed:boolean；旧字段及默认不变 |
| gbdev.run.v1 attention / pipeline-run.v1 decision | 缺失场景可选 recommended_action、accept_requirements；run JSON schema 同步 |
| gbdev.job-status.v1 | kind 增 inspect；仅 kind=inspect 可有 inspection；旧 kind 不注入新字段 |
| gbdev.job-result.v1 | inspect job 可有 inspection 对象或 null；旧结果不改变序列化形状 |
| worker-result / worker schema options | inspection 显式开关与候选字段；旧四种 worker schema fixture 字节不变 |
| gbdev.run-result.v1 / pipeline-result.v1 | 本地审计展示缺失接受声明及 note，旧记录字段缺省合法 |
| gbdev.error.v1 | 增加下表代码与 retryable 映射 |

### 6.3 错误与失败原因

| 代码 | exit / retryable | 条件 |
|---|---|---|
| role_fixed | 2 / false | 固定控制角色的配置/派发企图 |
| verdict_retry_required | 1 / false | 缺失接受之前没有可核实的已完成审查重试 |
| verdict_evidence_required | 1 / false | 缺少 true 确认或必填 note |
| inspect_path_invalid | 2 / false | paths 或 excerpt 路径逃逸、symlink、保留/非普通文件 |
| inspect_target_unavailable | 1 / false | 无已记录 SHA、对象不可用、源记录损坏或递归 inspect；details.reason 区分 |
| inspect_result_invalid | 1 / false | inspection 缺失、JSON/schema/引文来源/行号校验失败 |
| inspect_output_too_large | 1 / false | 候选 JSON 或 provider 输出超过硬输入上限 |

异步失败码写入 job.failure_reason/failure_reasons，并由 result 返回；不能把 job failed 改成 result 命令错误信封。派发前错误才直接返回错误 envelope。语法/非法组合沿用 usage_error；repo/provider/model/busy/wait_timeout/job_not_terminal 等沿用既有码。unsafe 路径错误不回显原文件内容，note/question 不进入 error.next_steps 的可执行命令模板。

## 7. S4：controller 操作规则与文档一致性

### 7.1 R1–R6 的统一措辞

1. **R1 唯一决策者：** 所有 attention 由 controller 最终回答；user 决定用户偏好和越界授权。合入 master/目标分支与 push 必须有 user 聊天明确同意；gbdev 本身仍不 push。
2. **R2 方向规划：** controller 定模块边界、目标、AC、约束；实现步骤由 Codex planner 产出。plan_review 检查依赖、范围、验收是否符合方向，不由 controller 重写逐文件实现方案。已有 provided 小任务入口保留，但其中是方向/验收任务，不是代码步骤。
3. **R3 只读：** controller 不写/编辑文件。控制命令是决策动作，不算修改代码；以 stdin 的 `--input -`/`--request -` 传 JSON，不教它用 shell 创建 decision.json/request.json。文件参数示例可保留，但注明是 user/已有工具准备的输入。webhook 默认约 2KB 摘要，必须先 status 做身份/时效校验；这项元数据校验不是“默认深读所有日志”。只有摘要和状态不足时才深入决策记录或 inspect。
4. **R4 按事件：** plan_review/plan_invalid 检查方向，超过 8 tasks 或约 40 jobs 问 user；task_failed/lane_broken 重试一次、第二次失败问 user；task_paused 能据仓库事实答就自己答，偏好才问；verdict_missing 特例按 §4。其余沿用决策表，表外复杂情况由 controller 判断。
5. **R5 不调度日常执行：** 不直接指挥 pane/Codex/Cursor，不手动接管审查修复循环；gbdev 调度，controller 只在决策点、失败、预算、范围和安全问题介入。日志/capture 不是默认的指挥通道。
6. **R6 固定角色：** controller/dispatcher/decider 不可配置；Codex/Cursor 工程角色可按环境配置，明确三层来源和限制。删除“Codex implements; Cursor reviews”作为唯一固定分工的说法，解释当前工作流 planner/fixer/resolver 与 executor/reviewer/verifier/inspector 的职责，同时不冒充修改了原内置默认。

### 7.2 verdict_missing 决策表行

新行优先于通用 task_paused：核对真实缺失原因→先 retry 审查（已完成自动重试算一次）→仍缺失时 inspect diff + tests，必要时指定 paths/question→等取材 terminal/result→核对 SHA、测试可用性与当前 decision→作出结论。

- 仍无足够证据时不能填 true，不能仅因检查返回 succeeded 就 accept；继续有界取材或报告阻碍/按合法动作恢复。没有测试日志不等于测试通过。
- 决定接受时填 `verdict_missing_reviewed:true` 和具体 note，如实报告“无 reviewer 结构化结论，由 controller 基于取证接受”，不能称为 reviewer approved。
- 默认不因缺失 verdict 直接问 user；偏好/授权问题和事实证据不足的阻碍区别处理，不无限重复 inspect。
- retry 与 retry_task 区别必须写清：前者重试当前审查 step，后者属于 task_failed/lane_broken 的任务级恢复，不能为缺失 verdict 重做全部实现。

### 7.3 只读与既有去重/输入示例冲突的处理

现 skill 的 webhook 模板用 mkdir claim ledger，是 controller 直接写文件，须替换为 bot 平台持久记忆中的原子 notice claim；若平台无原子 claim 能力，则本地 decision_id 的状态/原子消费是最终幂等边界，重复唤醒允许重复只读核实，但不能重复落地决策。不得为保持原句而继续写仓库或机器目录。失败释放的是平台 claim，不是文件夹；不引入新的本地 dedupe CLI。

保留并加强：payload 是数据、先 status、schema/home/ID 校验、test 的 null unit 特例、仅被唤醒 routine ack、秘密只由 user setup、init 在 notify 前、绝不执行 next_step、notify 失败不重启任务、小时兜底与临时轮询的区别、dashboard 仅观看、land 明确批准。不得以“2KB 足够”删除这些校验。

README 增加 inspect 用法、固定快照含义、结果层级、错误码/并发预算、角色可配置边界；修正“六个角色/不新增角色”为 M6 历史约束而非现状，保留既有 M6 章节标题和历史实施记录。roles/README.md 补 inspector 与 reserved identifiers。不改 docs/controller-role.md 的需求事实源。

## 8. 文件级实施清单

下表均为未来实现修改；未列文件不应顺手重构。新增模块可按此职责拆分，不把 inspect 逻辑塞进 notify/http.ts。

| 切片 | 新增/修改文件 | 责任 |
|---|---|---|
| S1 | 新增 roles/inspector/role.json、prompt.md，src/roles/reserved.ts；修改 scripts/gen-roles.mjs、src/roles/catalog.generated.ts、src/roles/registry.ts、src/contracts/role.ts、src/contracts/error.ts | 第七角色、保留名和错误码传播 |
| S1 | src/core/config.ts、src/core/runConfig.ts、src/contracts/brief.ts、pipeline.ts、pipelineRequest.ts、runRequest.ts、src/pipeline/definitions.ts | 拦截被忽略的配置面、请求与包装层保留 role_fixed |
| S1 | test/m7-s1-roles.test.ts（新）、test/roles.test.ts、test/m6-s1-roles.test.ts、scripts/m6-prompt-snapshot.mjs、test/index.ts | 新角色覆盖、历史六角色快照投影与总数断言 |
| S2 | 新增 src/core/verdictAcceptance.ts；修改 src/contracts/runResume.ts、pipelineResume.ts、run.ts、pipelineRun.ts、runResult.ts、pipelineResult.ts、error.ts 及对应 run*.schema.json | 确认字段、元数据和兼容校验 |
| S2 | src/pipeline/gate.ts、resume.ts、supervisor.ts、store.ts；src/run/decisions.ts、supervisor.ts、finalReview.ts、result.ts；src/commands/run.ts、pipeline.ts | 共用 accept 守卫、预校验与消费校验、审计和结果展示 |
| S2 | 新增 test/m7-s2-verdict.test.ts；相关旧 gate/pipeline/run/notify 测试、test/index.ts | 重试事实、拒绝与原子性、提示/notify 回归 |
| S3 | 新增 src/commands/inspect.ts、src/inspect/{target,evidence,prompt,result,limits,lifecycle}.ts、src/contracts/inspect.ts 及 inspect-start/result JSON schema、src/core/workerReservations.ts | 定位、快照、证据、规范结果、资源 admission |
| S3 | src/cli.ts、src/core/{paths,git,supervise,finalize}.ts、src/contracts/{jobStatus,jobResult,workerResult,workerResultSchema,error}.ts | CLI/显式 inspect schema/finalize hook、detached worktree、输出上限 |
| S3 | src/commands/{start,pipeline,run,status,result,cleanup,logs}.ts、src/run/{supervisor,scheduler,invariants}.ts、src/pipeline/reconcile.ts | 不污染所有权/预算、共享容量、恢复、只清理自有快照、结果获取 |
| S3 | src/dashboard/{desired,hints}.ts、src/render/job.ts、src/render/views/index.ts；roles/_shared/inspect-*.md、fragments.json、catalog.generated.ts | 展示、按需的独立提示片段；旧提示保持不变 |
| S3 | 新增 test/m7-s3-inspect-{cli,evidence,lifecycle,concurrency,notify}.test.ts，test/fixtures/provider-stub.js、test/helpers/providerStub.ts、test/index.ts | fake end-to-end、安全边界与恢复注入 |
| S4 | skills/gbdev-usage/SKILL.md、docs/controller-recipe.md、README.md、roles/README.md | R1–R6、G1/G2 使用方式 |
| S4 | 新增 test/m7-s4-docs.test.ts；test/m6-s4-docs.test.ts、test/m5-s5-docs.test.ts、test/index.ts | 语义规则、反例、CLI 扫描、安全扫描 |

notify/filter.ts、enqueue.ts、payload.ts、trigger.ts 以复用和测试为主；新独立 job 归属正确时无需改变生产逻辑。如需加内部投影字段，仅允许有界固定值，不改变 HTTP。任何新增持久化 schema 都必须有读旧数据测试。

## 9. 自动验收标准与切片完成条件

每个编号都是可自动断言的 AC；表中文件名即测试归属。不可用“人工看起来正确”替代。每片还须完成 §10 的共同检查。

### S1（AC-1–AC-8）

| AC | 自动验收 | 测试文件 |
|---|---|---|
| AC-1 | 七个角色目录；inspector 默认字段符合 §3.1，生成/运行时解析一致；list/show 有 inspector，旧 alias 不变 | test/m7-s1-roles.test.ts |
| AC-2 | 覆盖 inspector instructions/timeouts 生效且冻结；write/output/provider 放宽被拒；Cursor 非 auto 仍专有码；resolver 禁 Cursor | test/m7-s1-roles.test.ts |
| AC-3 | 四个保留标识及大小写/空白变体在 role.name、resolve、文件 basename、生成 alias 两端均拒绝；文件名与内容伪装不能绕过 | test/m7-s1-roles.test.ts |
| AC-4 | config 顶层/providers/roles、brief、pipeline role/fix_role/step ID、两类 overrides 逐一返回 role_fixed；CLI exit=2、retryable=false，零 job/worktree 写入 | test/m7-s1-roles.test.ts |
| AC-5 | list.invalid 保留 role_fixed、doctor roles=false；无关 executor 可解析；bot_label 与自然语言含 decider 不误伤 | test/m7-s1-roles.test.ts |
| AC-6 | 原六角色、旧 prompt 渲染矩阵、M1/M2 worker schema 不变；增加第七角色不靠删除旧快照断言通过 | test/m6-s1-roles.test.ts、test/roles.test.ts |
| AC-7 | gen-roles --check 通过；临时 staging 修改 inspector 一字失败；重复生成相同；孤立 dist 不需 roles/ 仍可 show inspector | test/m7-s1-roles.test.ts、test/m6-s1-roles.test.ts |
| AC-8 | fake/provider stub argv 验证 inspector Cursor auto、只读、无写开关；既有 Codex high 不回退；无禁用新增字面量 | test/m7-s1-roles.test.ts、test/providers.test.ts、test/safety-argv.test.ts |

### S2（AC-9–AC-18）

| AC | 自动验收 | 测试文件 |
|---|---|---|
| AC-9 | pipeline 三种缺 verdict 场景仍自动一次重试；前两次后 recommended retry，attempt=3 后不推荐/不列不可用 retry，不多建 job | test/m7-s2-verdict.test.ts、test/s4-pipeline.test.ts |
| AC-10 | 已重试的缺失 accept：字段缺省/false、true+空白 note 均 verdict_evidence_required；真值+有效 note 成功且 outcome 仍 accepted_by_decider | test/m7-s2-verdict.test.ts |
| AC-11 | 只有一次 attempt 的历史暂停即使 true+note 仍 verdict_retry_required；其他 step/轮次/未完成启动不算重试；G9 后被预算截住不能换 reason 绕过保护 | test/m7-s2-verdict.test.ts |
| AC-12 | run task_paused 与直接 pipeline 接受使用同一规则；篡改 run.detail 不绕过；owned pipeline 仍不能直接 resume | test/m7-s2-verdict.test.ts |
| AC-13 | final review 两次缺失 accept_final 需确认；已有明确 revise/reject 的旧行为与 findings 不变 | test/m7-s2-verdict.test.ts、test/m3-s6-final-review.test.ts、test/m3-s4-run.test.ts |
| AC-14 | 批量一项不合法时所有 input/continuation/decision/history/状态不变；旧 pending 输入再次消费仍被挡；重复 decision 保持 stale 行为 | test/m7-s2-verdict.test.ts |
| AC-15 | 非缺失原因默认行为不变；true 在非缺失/非接受动作拒绝；旧 schema 不带新增字段合法，非法字段类型拒绝 | test/m7-s2-verdict.test.ts、test/s4-gate.test.ts |
| AC-16 | 缺失接受的 note/确认/重试 job IDs 可从本地 result 和审计读回，worker 原始缺失结果不改，未伪造 approve | test/m7-s2-verdict.test.ts |
| AC-17 | status 正确呈现 recommended/requirements；旧记录投影不写盘；next_step 仍是 status，超长 note 不进入 ≤2048 字节 payload | test/m7-s2-verdict.test.ts、test/m5-s1-notify.test.ts |
| AC-18 | S2 全部旧 gate、s3/s4 pipeline、run resume/recovery、只读 prose 容错回归通过；独立只读 job 没有被全局要求 verdict | test/s3-pipeline.test.ts、test/s4-pipeline.test.ts、test/r6.test.ts、test/m3-s4-recovery.test.ts |

### S3（AC-19–AC-34）

| AC | 自动验收 | 测试文件 |
|---|---|---|
| AC-19 | HELP/Commands 含精确 inspect 用法；required question、重复 paths、task 组合、UTF-8 长度、未知参数/ID、stdin 旧命令均按约定 | test/m7-s3-inspect-cli.test.ts |
| AC-20 | run/task/job 各目标定位矩阵、diff base 正确；lane 被另一个 task 复用后仍读历史 SHA；cleanup 后对象存在可检查、缺对象不回退 | test/m7-s3-inspect-cli.test.ts |
| AC-21 | 活动 run 合并中只看 verified SHA；活动 job 只看 base，未提交哨兵不出现；task 尚未开始/递归 inspect 拒绝且不建 worktree | test/m7-s3-inspect-cli.test.ts |
| AC-22 | start envelope、status、wait、result.inspection 通过 schema；异步成功/证据不足成功/缺 JSON 失败有明确区别；普通 result 输出结构不变 | test/m7-s3-inspect-lifecycle.test.ts |
| AC-23 | fixture 的 job check、pipeline check、baseline/merge gate 日志选择/行号/exit/SHA 正确；worker 自报 tests 不冒充记录；不启动测试命令 | test/m7-s3-inspect-evidence.test.ts |
| AC-24 | 绝对/父路径/pathspec/目录前缀混淆/symlink/FIFO/伪造日志路径/二进制/gitlink 矩阵不能把外部哨兵带入 prompt/result；worker cwd 为专属快照 | test/m7-s3-inspect-evidence.test.ts |
| AC-25 | 幻觉引文/错误行号/不存在的虚拟来源失败；UTF-8/CRLF/控制码/脱敏后行号正确；gbdev 重建 text 而非直接转发 | test/m7-s3-inspect-evidence.test.ts |
| AC-26 | 每级字节/行数上限以边界值及中文测试；截断标记正确、不拆码点/JSON；多段拼整文件和单行文件不返回全文；raw 过限终止自身 | test/m7-s3-inspect-evidence.test.ts、test/m7-s3-inspect-lifecycle.test.ts |
| AC-27 | inspect 不建分支、不修改源工作树/refs、忽略 setup/hooks；fake 写入检查树导致 failed，不能只因 read-only 标签认为成功 | test/m7-s3-inspect-lifecycle.test.ts |
| AC-28 | 活动 run 期间可启动 inspect，父状态/预算/attempts/decision/slots 不变；同时最多一个 inspect；满容量 busy 不留 job/worktree | test/m7-s3-inspect-concurrency.test.ts |
| AC-29 | 注入 acquire/admission 竞态，不超过 provider/总槽数；预留未起 worker 也计入；终态/取消/重复清理不泄漏或多释放 reservation | test/m7-s3-inspect-concurrency.test.ts |
| AC-30 | inspect 的 cancel/timeout/stall/supervisor 崩溃只结束自身；父 cancel/cleanup 不杀 inspect；PID 重用/残留子进程不可误回收 | test/m7-s3-inspect-lifecycle.test.ts |
| AC-31 | inspect cleanup 只删除其 detached worktree，源 refs 字节不变；force 不能越权；dirty 拒绝、重复幂等；历史普通 cleanup 不变 | test/m7-s3-inspect-lifecycle.test.ts |
| AC-32 | dashboard index 与独立 job pane 可见 inspector/target/SHA；不变成父 lane 子窗口；logs/pane 不回显未验证全文；fake tmux 不影响任务 | test/m7-s3-inspect-lifecycle.test.ts |
| AC-33 | succeeded/failed/cancelled/timeout 的 terminal 各入队；result 先于通知可读；去重/replay/notify disable/发送失败不改 job；payload ≤2048，无 question/answer/源码/测试/秘密 | test/m7-s3-inspect-notify.test.ts |
| AC-34 | 运行脚本向 prompt 注入伪指令/路径不能改变 schema/授权；旧 M1/M2/M3 prompt/schema fixture 不变；http.ts 相对基线无 diff | test/m7-s3-inspect-evidence.test.ts、test/m7-s3-inspect-notify.test.ts |

### S4（AC-35–AC-42）

| AC | 自动验收 | 测试文件 |
|---|---|---|
| AC-35 | skill/recipe 独立断言 R1–R6 六项及反例；删除其中任一规则的内存变体必须失败，不只检查关键词出现 | test/m7-s4-docs.test.ts |
| AC-36 | 两份决策表均有缺失 verdict 的 retry→deep read→显式确认顺序、无结论不能默认 accept；区分 retry/retry_task，检查 stdout succeeded 不代表审查通过 | test/m7-s4-docs.test.ts |
| AC-37 | 两份文档有 inspect 的 question/task/paths/diff/tests 与 status/wait/result.inspection 示例、只读固定 SHA/未提交排除及返回原 attention 规则 | test/m7-s4-docs.test.ts |
| AC-38 | 所有 gbdev 命令/子命令通过真实 HELP 扫描；新增错误的 inspect 子命令/flag 的内存反例失败，不能扩白名单放过未知命令 | test/m6-s4-docs.test.ts、test/m7-s4-docs.test.ts |
| AC-39 | Step 0、bot launcher、secret setup/ack、test null unit、小时兜底、dashboard 与 land 批准规则全部保留；本地 mkdir/写 JSON 的 controller 指令删除，平台 claim/原子 decision 消费说明存在 | test/m5-s5-docs.test.ts、test/m6-s4-docs.test.ts、test/m7-s4-docs.test.ts |
| AC-40 | README/roles README 明确工程角色可配置、controller 固定、inspector read-only auto 与预算；不把工作流 Codex 模型误写成全局默认迁移 | test/m7-s4-docs.test.ts |
| AC-41 | 新增/改动内容无禁用 argv/shell 字面量，skills/roles 原扫描仍有效；M6 快照旧字段无变化，gen-roles --check 通过 | test/m7-s4-docs.test.ts、test/m6-s1-roles.test.ts |
| AC-42 | test/index.ts 导入所有 M7 测试；全套测试、typecheck、diff-check 通过，无真实 HOME/provider/tmux/HTTP 使用；本轮无新增依赖、http.ts 不变 | test/m7-s4-docs.test.ts + §10 检查命令 |

## 10. 既有测试、快照与每片验证

### 10.1 明确受影响或必须回归的旧测试

- S1：`test/roles.test.ts` 的默认角色映射、list 数量、doctor “6 valid roles”；`test/m6-s1-roles.test.ts` 的目录清单、全量 role 快照、isolated dist 清单。只改数量与新增对象检查，原六角色仍逐字段比较。
- S2：`test/s4-gate.test.ts` 的 DECISION_ACTIONS 精确断言/恢复 schema；`test/s4-pipeline.test.ts` AC-S4.4 的第三次 retry 耗尽错误和新的可用动作投影；`test/s3-pipeline.test.ts` 缺 verdict 暂停；`test/m3-s6-final-review.test.ts` 缺失最终 verdict；`test/m3-s4-run.test.ts` accept_final；`test/m3-s4-recovery.test.ts` 的 pending/batch 恢复。原明确 revise/reject 接受测试应原样通过，不能全局给测试 helper 自动补 true。
- `test/s5-g-decisions.test.ts`、`test/m3-s6-notes.test.ts` 保证新审计不会把 note 重复注入数据或丢失既有决策；`test/r6.test.ts`、`test/m2-r1.test.ts` 保持普通只读 prose 交付例外。
- S3：`test/m3-s2-scheduler.test.ts`、`test/m3-s3-run.test.ts`、`test/m3-s4-recovery.test.ts` 保持无 inspect 时的槽位/预算不变量；`test/m4-s3-dashboard.test.ts`、`test/m5-s2-notify.test.ts` 保持正常子 job 不单独通知/建窗。新增独立 inspect 不得放宽其过滤断言。
- S4：`test/m6-s4-docs.test.ts`、`test/m5-s5-docs.test.ts` 中依赖固定 skill 文本的断言按新的同等或更强语义更新；保留提取全部命令、相邻语句/表格的反例、禁用字面量扫描，不删测试绕过。

### 10.2 M6 快照策略

**不改 `test/fixtures/m6-prompts.snapshot.json` 和 `m6-prompts.snapshot-extra.json` 的历史内容。** 调整 `scripts/m6-prompt-snapshot.mjs` 的历史捕获范围：显式使用原六角色名字，旧渲染矩阵保持完整；M6 测试把当前 role list 投影到这六个名字再与旧 fixture 比较，另在 M7 测试精确断言第七角色且不存在额外角色。不能动态读取 fixture 的任意列表来跳过差异。

inspector 自己的提示/schema 使用新的 M7 测试或 fixture；旧公共片段不改，inspect 专有片段独立添加并纳入 gen-roles。默认 buildWorkerResultSchema 及 m1/m2 change/verdict/report 四个 fixture 字节不变。生成的 catalog 必须随 roles 修改入库，不手改 generated。

### 10.3 每片检查命令

在既有依赖已准备的环境中执行，不下载、不初始化真实 home：

```text
npm test
npm run typecheck
node scripts/gen-roles.mjs --check
git diff --check
git diff 109e981 -- src/notify/http.ts
```

最后一项应为空。每片记录新增/通过/失败测试数，不把用户给出的基线 1526 通过冒充本次已复跑。对新增文件逐一核对 test/index.ts 导入；检查 git diff 中除本规格授权范围外无变更。真实 provider 冒烟不作为本任务隐含授权，也不能代替 fake 的可重复验收。

## 11. 威胁模型与安全边界

| 威胁 | 强制边界 | 不作的保证 |
|---|---|---|
| 日志/源码提示注入 | 单独 untrusted 数据区、长度限制、不可执行 next_step、结构化结果来源校验 | 模型回答可能判断错误，controller 仍须判断 |
| 路径逃逸、symlink/FIFO、历史 lane 复用 | 不接受外部路径；固定 commit 专属 worktree；no-follow + realpath/组件/fstat 校验；虚拟日志路径 | cwd 不是 OS 安全隔离的同义词 |
| 全文/超大输出、秘密回显 | 输入/输出双重上限、规范引文重建、无整文件片段并集、sanitize/redact、raw 上限、notify 显式投影 | 打码不是秘密扫描器；仓库本来含秘密时不能宣称“安全公开” |
| 无结论接受 | 真正 accept 路径强制重试事实、显式 true、note；本地审计 | 不声称 boolean 证明人已阅读，不自动认可 inspector 答案 |
| inspect 破坏父任务 | detached 独立工作树，无父所有权/预算 hook；并发 reservation | 无法阻止用户在模型运行时手工改变操作系统/仓库 |
| 伪造/重放通知 | M5 home/ID 校验、status 重新核实、decision 原子消费、不执行 payload 命令 | webhook 至少一次，不保证只唤醒一次 |

provider 的 read-only 沙箱与 plan 模式是执行边界的一部分，**仅写 prompt 或设置 cwd 不足以声称阻止仓库外读取**。本版沿用已支持的 Cursor 沙箱，不发明未经验证的 CLI 参数；实现必须保留 provider argv 约束、gbdev 取材路径封闭及外部哨兵测试。模型可读取的项目资料仅为检查树和注入数据；provider 自身正常运行所需二进制/模型认证不属于授权模型浏览用户目录。若执行环境不能提供项目读取边界，不得降级为无沙箱运行，应报告 provider/环境阻碍；不以本规格授权读取真实配置来“验证”。同 uid 恶意进程、替换可信 CLI/配置、直接篡改 GBDEV_HOME 状态不在本地单用户调度器的防篡改保证内。

新 inspect 不调用现有 finalize 的写快照分支，不允许因 inspector 修改其私有工作树而自动补提交、清理证据或继续 succeeded。diff 生成和 worktree 建立走可信 Git helper，禁止项目 hooks/filter/textconv 执行；不执行仓库 setup 命令来补齐依赖，因此缺依赖只能作为事实报告。

## 12. 切片交付与 open_questions

| 切片 | 可单独审核/提交的结果 | AC 范围 |
|---|---|---|
| S1 | inspector 内置角色、工程配置兼容、固定控制角色显式拒绝 | AC-1–AC-8 |
| S2 | run/pipeline/final-review 缺失 verdict 接受保护、推荐动作与审计 | AC-9–AC-18 |
| S3 | inspect 异步只读取材、固定快照、结果/安全校验、并发与 terminal 通知 | AC-19–AC-34 |
| S4 | R1–R6 skill/recipe/README、文档反例测试与全量回归 | AC-35–AC-42 |

**open_questions：无产品决策待选。** 本规格已选定显式取证确认而非 inspect-ID 强绑定、固定已提交快照而非活动树读取、独立取材预算与共享并发容量。真实 provider 的沙箱能力验证是执行环境验收事项，不是允许放宽边界的开放选项；不能满足时应报告具体阻碍。

## 13. 调度裁定（executor，2026-10-31，优先于上文）

1. **§7.3 webhook 去重不改机制。** 保留现有 `mkdir <state>/handled/<notice_id>` 原子 claim（它是 controller 在 Mac 上的控制面状态，不在任何仓库内，不是代码/仓库文件）。文档把它与 gbdev 控制命令并列为 R3 允许的“控制面动作”，明确它不是修改项目文件；不得把它换成“平台持久记忆 claim”（平台未必提供原子 claim，会引入重复处理）。AC-39 相应改为：mkdir claim 与其失败释放规则保留，并有一句说明它属于控制面状态、不算 R3 的“碰文件”。
2. **决策/请求 JSON 输入**：文档首选 `--input -` / `--request -` 通过 stdin 传入；文件参数形式保留为可选。
3. **S3 可拆成两次提交**：S3a（CLI、目标定位、固定快照 worktree、证据、结果校验、terminal 通知、cleanup）与 S3b（§5.6 共享容量 reservation、竞态与崩溃恢复）。若 §5.6 的完整共享 reservation 实现风险过高，最小可接受版本为：每 home 最多一个活动 inspect（busy 拒绝）+ inspect 计入 provider 并发上限的检查（按已运行/已预留 worker 计数），并在 README 说明其余限制；不得改变无 inspect 时的旧调度行为。
4. 不做真实 provider 冒烟以外的任何真实 home 操作；冒烟只在 ~/.gbdev-m7-smoke。
