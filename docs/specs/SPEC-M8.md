> Historical design specification. Milestone labels describe design evolution; consult README.md and docs/reference.md for current behavior. Private execution records are not release certification.

# SPEC-M8：修复 live run 暴露的 B1–B6

> 实现级规格，2026-10-31。  
> 规划基线：`gbdev-controller`，HEAD `b36eb3f2951f8ca266b564cce7e9784f928738b0`。以下行号均指该 HEAD，不指工作区版本。  
> 参考：`SPEC-M7.md`；`docs/controller-role.md` §4，特别是 G3/G4/G5。  
> 本次只进行了仓库内只读代码核对：未修改文件、未运行构建或测试、未联网，也未读取仓库外的配置或运行记录。未将另一 worker 正在实施的 M7 S3 改动作为规划依据。

## 0. 总体决策与边界

### 0.1 不变项

1. Node 24、TypeScript、运行时不新增第三方依赖。
2. 保持 `contract_version: "1"`；持久化契约采用可选追加字段，旧记录仍可读取。
3. 不修改 `src/notify/http.ts`，不新增通知发送链。新增详细证据只进入本地 job/result/events/handoff，不进入 webhook 正文。
4. Cursor 仅使用 `auto`；Codex effort 恒为 `high`；不新增批准或沙箱绕过参数。
5. 不自动重启整个 task 来处理可修复的检查失败、工作区残留或轻微违规。优先复用当前 pipeline、当前分支、既有 fix loop。
6. 不伪造 worker 的 `status`、`review.verdict`、findings 或测试结果。调度器生成的问题必须明确标为调度器观察，不写入 `worker_reported.review`。
7. 保留 M7 S2 的缺失 verdict 保护：已完成审查重试、显式取证确认、非空 note、审计记录，均不得因 M8 回退提取而取消。
8. M7 S3 合入后按可选字段合并，不覆盖 inspection 字段、不令 inspect 执行 task checks、不把 inspect 计入业务 job 预算。

### 0.2 六项设计摘要

| 项目 | 采用的设计 |
|---|---|
| B1 | 输出、文件内容进展和进程 CPU 增量组合判断；subagent/tool pending 只提供有上限的宽限，不提供永久存活豁免 |
| B2 | 在单次 job 的 check phase 内按执行身份去重；保留每条标准的结果及日志入口；不跨 job/attempt/HEAD 复用 |
| B3 | 每个 job 启动前记录工作区基线；区分 worker 增量、继承状态、check 增量；取消“只要脏就拒绝 reviewer”的判定 |
| B4 | 结构化轻微事件＋窄白名单＋结束状态核验；符合条件降 warning，残留可修复项进入现有 fix loop，严重项保持失败 |
| B5 | run request 新增可选 `task_checks: string[]`，引用现有 `checks[]`；默认 `[]`；merge gate 继续独立运行 |
| B6 | 修复 terminal result 遮蔽有效 assistant JSON 的路径；严格限制候选来源；复用现有一次自动重试，不增加隐形续写 job |

### 0.3 三个必须区分的概念

- **任务审查范围**：通常是 task/pipeline 的 diff base 到当前 HEAD，提供给 reviewer。
- **当前 job 责任范围**：当前 job 启动基线到其 worker 退出状态的增量。
- **当前工作区是否适合交付**：包含继承残留、当前 worker 残留和 check 残留；它可以阻止 pipeline 完成，但不能一概归罪当前 reviewer。

此外，源码可以确认缺陷路径，但不能仅凭本仓库证明某次 live run 的 `.omc/notepad.md` 究竟由 executor、本地子进程还是 check 创建。M8 必须补足归属证据，而不是把推测写成运行事实。

---

## 1. B1：避免误杀静默等待内部 subagent 的 Cursor executor

### 1.1 根因定位

| 位置 | 已确认事实 |
|---|---|
| [src/core/supervise.ts:70](../../src/core/supervise.ts#L70)，`superviseJobWork` | `lastOutputAt` 初始化后，stdout 收到非空 chunk 就刷新 |
| [src/core/supervise.ts:106](../../src/core/supervise.ts#L106) | watchdog 比较 raw 输出文件与 `worker.log` 的总大小；增长即刷新；超过 `stall_timeout_s` 就停止 worker |
| [src/render/cursor.ts:39](../../src/render/cursor.ts#L39)，Cursor renderer | 已识别 `tool_call` 的 started/completed，以及 task/await 类调用；这些信息目前仅用于展示 |
| [src/core/proc.ts:27](../../src/core/proc.ts#L27)，`groupAlive` | 当前进程存活探测用于清理，不参与 stall 活跃度判断 |

**结论：当前依据是 stdout/stderr 字节增长，不是 worker 心跳、worktree 变化或 CPU。** Pipeline/run supervisor 的 heartbeat 只说明调度器存活，不能证明 worker 有进展。

单纯增加 tool_call 解析也不够：started 事件本来已经产生 stdout，真正的问题是其后的长静默区间。

### 1.2 修复设计

新增 `src/core/activity.ts`，实现可注入时钟、进程探针和文件探针的 `ActivityTracker`。

#### 信号分类

| 信号 | 作用 |
|---|---|
| stdout/stderr 新字节 | 保留现有行为，刷新进展时间 |
| worktree 受监测文件内容、类型、权限或路径集合发生变化 | 刷新进展时间 |
| 文件只有 mtime 变化、内容不变 | 不作为有效内容进展 |
| 已确认 worker 进程组的累计 CPU 时间增加 | 有限宽限信号 |
| Cursor task/tool started，尚未 completed | 有限宽限信号 |
| PID/进程组存在 | 只说明仍存活，不刷新任何进展时间 |
| supervisor heartbeat、gbdev 自己写日志 | 不算 worker 活跃度 |

文件监测复用 B3 的路径安全及状态比较工具：

- 只检查该 worktree；不跟随 symlink。
- 排除 Git 管理目录和 gbdev 自身日志。
- 默认覆盖 tracked、非 ignored untracked，以及 B4 明确关注的临时路径。
- mtime/size 可用于筛选候选，但不能仅凭 mtime 变化认定内容进展。
- 不要求每个 tick 全量读取所有文件内容。

CPU 探针：

- 通过有超时的进程信息查询读取 PID、PGID、启动身份、累计 CPU。
- 只累计已确认属于 worker 组且身份未变的进程。
- 不读取进程环境、命令行秘密或仓库外文件。
- 查询失败表示信号不可用，不表示 worker 已死，也不无限延长存活。

#### 判定规则

令 `S = stall_timeout_s`：

1. `S = 0`：保持旧语义，关闭 stall 检测，绝对 deadline 和取消仍有效。
2. 没有输出/文件进展，也没有有效宽限信号：静默达到 `S` 后判 stalled。
3. 有 pending tool/subagent 或近期 CPU 增量：允许等待，但不得超过最后一次输出/文件进展之后的 `3 × S`。
4. pending 集合在 completed/error 时移除；重复 started 不得重复续租。
5. CPU 活跃不能将 `3 × S` 上限无限后移。持续空转最终仍会 stalled。
6. 真正输出/文件进展会开启新窗口；无论是否持续有进展，都不能超过既有 job deadline。

默认不增加用户配置项，直接沿用 `stall_timeout_s`。这是明确选择的折中：静默远程计算无法被本地完全证明，给有限宽限，不承诺无限等待。

探针间隔使用 `min(1000ms, max(100ms, S × 250ms))`；文件扫描异步、禁止重入，不在全局锁内运行。

### 1.3 契约、事件和错误码

- 保留 `worker_stalled`、`retryable: true` 和现有终态。
- `warning/worker_stalled` 追加可选诊断字段：
  - `idle_s`
  - `last_progress_source`
  - `pending_tool_count`
  - `cpu_progress_observed`
  - `grace_used`
- 使用已有 `heartbeat` 事件类型，`data.kind = "worker_activity"`；仅在来源变化、首次进入宽限或退出宽限时记录，避免按 tick 刷屏。
- 探针不可用记录一次 `warning`，例如 `activity_probe_unavailable`；这是事件 code，不新增公共 CLI ErrorCode。
- 不保存工具参数、文件内容或 CPU 探针原始输出。

### 1.4 对旧测试的影响

- `test/r6.test.ts` 中纯静默 fake worker 仍应按原 stall 窗口失败。
- stdout/stderr 持续增长及 `stall_timeout_s: 0` 测试保持。
- `test/r7.test.ts` 的 thinking stream 测试保持。
- 新增测试用 fake clock/probe 验证 `S`、`3S` 边界，不把全部测试改成真实长等待。

### 1.5 验收标准

- **AC-B1-1**：fake Cursor 发出 task started 后静默 `2S`，随后输出合法结果；不得 stalled。
- **AC-B1-2**：没有输出、文件变化和 CPU 增量，仅进程存在；在 `S` 加一个采样周期内触发 stalled。
- **AC-B1-3**：pending tool 永不结束，或 CPU 持续增长但无输出/文件进展；在 `3S` 加一个采样周期内 stalled。
- **AC-B1-4**：静默 worker 每隔 `< S` 修改 worktree 中测试文件内容，持续超过 `3S`；不得因 stall 被杀；停止变化后仍会进入 stall 判定。
- **AC-B1-5**：只刷新 mtime、只写 gbdev heartbeat，不能无限保活。
- **AC-B1-6**：分段 JSON、重复 started、未知事件、探针异常和 PID 身份变化不导致崩溃或无限续租。
- **AC-B1-7**：取消和绝对 deadline 优先；worker 及既有清理范围内的子进程被回收；fake tmux 不影响结果。

### 1.6 涉及文件

- 新增：`src/core/activity.ts`、`test/m8-b1-activity.test.ts`
- 修改：`src/core/supervise.ts`、`src/core/proc.ts`
- 按职责抽取：`src/providers/cursor.ts` 或新增 `src/providers/cursorEvents.ts`
- 测试：`test/fixtures/provider-stub.js`、相关 fixtures、`test/index.ts`
- 复用 B3 的 workspace snapshot/path 工具，不复制另一套路径判断。

### 1.7 风险

- 远程 subagent 的真实工作可能完全无本地信号，仍可能在 `3S` 之后被判 stalled；应通过正常 timeout 配置调整，而非永久豁免。
- CPU 采样存在平台精度差异，只能做辅助信号。
- 大仓库扫描可能增加负载，因此必须异步、限频、避免重叠。

---

## 2. B2：相同 check 命令在同一步骤、同一 HEAD 下只执行一次

### 2.1 根因定位

- [src/core/finalize.ts:195](../../src/core/finalize.ts#L195)，`finalize`：遍历 `brief.acceptance_criteria`，每个非空 `check_cmd` 都调用一次 `runCheck`。
- [src/core/finalize.ts:61](../../src/core/finalize.ts#L61)，`runCheck`：实际执行身份是 `/bin/sh` 加 `['-c', cmd]`，cwd 为 job worktree，环境当前继承主进程。
- [src/run/requests.ts:15](../../src/run/requests.ts#L15)：多个 criterion 引用同一个 trusted check 时，被展开成多个相同 `check_cmd`，check ID 身份没有保留下来。

### 2.2 修复设计

抽取 `src/core/checks.ts`，包含 check plan、执行、结果投影；本项不改 merge gate 的重试策略。

#### 去重范围与 key

缓存仅存在于**当前 job 的一次 check phase**：

```text
key = SHA256(
  canonical_cwd,
  executable,
  exact_argv,
  effective_environment_fingerprint,
  head_sha,
  workspace_generation
)
```

具体规则：

1. `canonical_cwd` 为已验证 worktree 的规范路径。
2. executable/argv 按实际传给 spawn 的值计算；不对 shell 字符串做拆词、空白压缩或“语义等价”推测。
3. 在 check phase 开始冻结 effective env，并显式传给每次 spawn。
4. 对全部实际传入的环境变量按 key 排序后计算指纹，保守包含所有可能相关变量；不落盘环境值，不把指纹放 webhook。
5. `workspace_generation` 用于避免 HEAD 未变但源码/工作区输入改变后的错误复用：
   - 使用 B3 的状态指纹；
   - 每个物理执行结束后检查 HEAD 和受监测工作区；
   - 发生改变则失效已有缓存，后续不得复用旧结果。
6. 不跨 reviewer、fixer、job、attempt、pipeline 或 merge gate 缓存。
7. 相同执行组 timeout 不一致时，采用组内最短 timeout；旧 `check_cmd` 默认仍为 10 分钟。此规则在生成 plan 时确定，不依赖出现顺序。

取消后不得启动剩余物理执行；未执行的引用不能获得伪造的成功结果。

#### 每条标准仍保留结果与日志

- `gbdev_observed.checks` 仍按原标准顺序保留一条记录。
- 第一次引用使用原安全命名规则，例如 `checks/AC1.log`。
- 后续引用保留自己的日志入口，例如 `checks/AC2.log`，在执行完成后复制同一日志；不使用 symlink。
- 每条记录可追加：

```ts
{
  execution_id?: string;
  reused_from?: string; // 首次引用的逻辑 check ID
  checked_sha?: string;
}
```

- 只有一个物理执行，但每条标准各自保留 `check_failed:<id>`，确保失败索引和旧消费者语义不丢失。
- `fixInput` 按 `execution_id` 去重日志正文和机器生成 finding，并在 finding 中列出受影响的所有标准 ID，避免给 fixer 重复四份相同输出。

### 2.3 契约、事件和错误码

- `gbdev.job-result.v1.gbdev_observed.checks[]` 追加上述可选字段。
- `Handoff.checks` 已引用 JobResult checks 类型，需要同步验证及投影。
- 每条标准仍发一个 `check` 事件；追加 `execution_id`、`reused_from`。
- 保留 `check_failed:<id>`；不增加公共错误码。
- 单条、无复用的旧检查记录可保持原序列化形状；旧记录缺少执行 ID 时按独立执行理解。

### 2.4 对旧测试的影响

- `checks/AC1.log`、危险 criterion ID 的安全文件名测试保持。
- `test/r2.test.ts` 对单条 checks 的精确对象断言可保持。
- 多条相同命令的测试改为断言“标准结果数不变、物理执行数为 1”。
- 原 G6 检查失败进入 fixer 的测试保持；新增多标准共享失败输出测试。

### 2.5 验收标准

- **AC-B2-1**：四条标准使用相同命令；fake 执行计数为 1，结果有四条，每条日志存在且内容正确。
- **AC-B2-2**：共享执行退出 7；四条标准都记录退出 7，失败原因能关联四个 ID，fixer 只收到一份日志正文。
- **AC-B2-3**：改变 cwd、argv、任一传入环境变量或 HEAD，均不得复用。
- **AC-B2-4**：同 HEAD 下，中间检查修改 tracked 文件或新增受监测文件；后续相同命令重新执行。
- **AC-B2-5**：fixer 新 job、手动 retry、新 task 即使命令/HEAD 相同，也重新执行。
- **AC-B2-6**：危险 ID、重复命令、日志文件名碰撞均不产生路径逃逸或错误日志关联。
- **AC-B2-7**：共享执行被取消或超时，不遗留子进程，不把尚未执行的其他组标为成功。

### 2.6 涉及文件

- 新增：`src/core/checks.ts`、`test/m8-b2-check-dedup.test.ts`
- 修改：`src/core/finalize.ts`、`src/contracts/jobResult.ts`
- 修改：`src/pipeline/fixLoop.ts`、`src/pipeline/handoff.ts`
- 测试及入口：相关 execution/pipeline 测试、`test/index.ts`

### 2.7 风险

- 有副作用的检查不能被视为纯函数；工作区 generation 负责阻止明显错误复用，但不声称检测数据库、网络等外部状态。
- 日志复制增加少量磁盘占用，换取旧日志路径兼容。
- 不按“看起来都是 cargo test”合并不同 shell 字符串，避免错误优化。

---

## 3. B3：以 job 启动基线确定文件归属，不让 reviewer 为继承脏文件失败

### 3.1 根因定位

| 位置 | 已确认问题 |
|---|---|
| [src/core/finalize.ts:100](../../src/core/finalize.ts#L100)，`observeGit` / `observeGitAsync` | 将相对 `status.base_sha` 的变化与当前 dirty 文件合并，再统一判断 allowed_paths；没有 job 启动时的文件状态 |
| [src/core/finalize.ts:108](../../src/core/finalize.ts#L108) | read-only 只要 HEAD 不同或工作区脏就记录 `readonly_modified` |
| [src/pipeline/supervisor.ts:81](../../src/pipeline/supervisor.ts#L81) 和同文件第 109 行 | reviewer 启动前已存在“工作区脏即抛错”的 preflight，可能根本没有 reviewer job |
| [src/core/finalize.ts:170](../../src/core/finalize.ts#L170) | 写 job 对全部 dirty 内容做整体 snapshot，可能混入继承状态 |
| [src/core/finalize.ts:195](../../src/core/finalize.ts#L195) | check 在 Git 观察之后执行，check 留下的文件没有纳入该次最终观察 |

补充：当前 `dirtyFiles` 使用 `--exclude-standard`，所以 ignored 文件与普通 untracked 文件不能混为一谈；M8 对明确关注的 `.omc/notepad.md` 必须显式纳入。

### 3.2 修复设计

新增 `src/core/workspaceSnapshot.ts`，在持有该 worktree 使用权、worker spawn 之前保存不可变 `workspace-before.json`。

#### 基线内容

```ts
{
  version: 1;
  job_id: string;
  head_sha: string;
  captured_at: string;
  entries: {
    path: string;
    kind: "file" | "symlink" | "other";
    content_hash: string | null;
    mode: number;
    index_state: unknown; // 实现中定义为稳定、可验证结构
  }[];
  inherited_dirty_paths: string[];
  previous_job_id: string | null;
}
```

要求：

- 记录 tracked、非 ignored untracked，以及窄白名单临时路径，包含 `.omc/notepad.md`。
- 内容比较不能只用“路径是否已在 dirty 列表”或 mtime；既有脏文件被 reviewer 改写仍须检测。
- symlink 比较链接本身，不读取目标；目录不递归跟随 symlink。
- 保存 index 变化证据，避免仅 staging/unstaging 被当成完全未修改。
- 快照采集失败或不完整，不得当作 clean baseline。
- 旧历史 job 没有基线时，保留旧结果，标记归属未知；不得读取今天已复用的 lane 后倒推历史责任。

#### 分阶段观察

按以下阶段保存证据：

1. `before_worker`
2. `after_worker`：worker 和受管理子进程停止后，自动 snapshot 之前
3. `after_checks`

由此生成：

- `job_files_changed`：worker 相对启动基线的变化。
- `inherited_dirty_paths`：启动时已经存在的脏状态。
- `check_files_changed`：check phase 相对 worker 后状态的变化。
- `workspace_issues`：尚需解决、但不一定归当前 worker 的工作区问题。

read-only policy 只根据当前 worker 增量判断：

- 继承文件内容、类型、权限、index 状态均未变化：不产生 `readonly_modified`。
- reviewer 修改、删除继承文件，或产生新文件：仍产生 `readonly_modified`。
- reviewer HEAD 改变：仍失败。
- task 的完整审查 diff 继续使用原 diff base，不缩减为当前 reviewer 增量。

#### 启动和交付流程

- 替换两个“dirty 即拒绝 reviewer”的 preflight：允许基线可完整记录的脏工作区进入只读 job。
- 已知前序 job/check 留下的可修复临时残留，优先在进入 reviewer 前走 fixer。
- 历史遗留或启动时才发现的残留即使允许 reviewer 执行，也不能因 reviewer approve 就忽略。
- 当前 reviewer 可正常完成并保留 verdict；pipeline 根据独立 `workspace_issues` 决定修复或暂停，不把问题写进 reviewer 的 policy violation。
- 来源无法证明时，`owner_job_id = null`，不得强行指定 executor；不能自动删除未知来源文件。

#### 自动 snapshot 修正

- 不再对继承脏内容无差别整体加入 snapshot。
- 只 snapshot 当前写 job 产生、且被允许交付的变化。
- B4 识别的临时残留不进入自动 snapshot。
- 如果继承 index 已有 staged 内容，普通自动提交会混入继承内容：本版选择暂停该写 job 的自动 snapshot，保留工作区并记录基线冲突；不隐式提交或重置它。
- check 结束后补做观察；check 造成的变化归执行该 check 的 job/check phase，不能留到下一 reviewer 才被发现。

### 3.3 契约、事件和错误码

`gbdev_observed` 追加可选字段：

```ts
{
  workspace_baseline?: string; // job 内相对证据路径
  job_files_changed?: string[];
  inherited_dirty_paths?: string[];
  check_files_changed?: string[];
  workspace_issues?: {
    code: string;
    path: string;
    owner_job_id: string | null;
    source_phase: "worker" | "check" | "unknown";
    repairable: boolean;
  }[];
}
```

- 保留现有 `files_changed`、`worktree_dirty_at_exit` 事实字段，不把“整体脏”伪装成 clean。
- `readonly_modified`、`outside_allowed_paths` 的当前 job 判定改用本 job 责任增量。
- 新增内部证据错误 `workspace_snapshot_invalid`：exit 1、retryable=false。
- pipeline 对无法安全处理的基线问题使用现有 `step_failed` 决策，detail 指明证据错误；不自动从头启动 task。
- 事件使用已有 `warning`、`gate`，增加归属和 phase 数据，不新增 webhook 类型。
- `failureResult` 崩溃恢复必须复用相同基线比较，不再采用另一套归属逻辑。

### 3.4 对旧测试的影响

- clean baseline 上 reviewer 新建/改文件的失败测试不变。
- executor 真正修改 allowed_paths 外源码的失败测试不变。
- “任何 dirty 状态都属于 reviewer”的断言应改为基线差异断言。
- snapshot 测试补充“不能提交继承 staged 内容”和“check 残留不归 reviewer”。
- 旧无基线结果读取、旧 schema fixture 继续通过。

### 3.5 验收标准

- **AC-B3-1**：reviewer 启动前存在 `.omc/notepad.md`，reviewer 未改变它并输出合法 verdict；job 不出现 `readonly_modified` 或因该文件出现 `outside_allowed_paths`。
- **AC-B3-2**：reviewer 修改同一个继承文件，即使仍处于 dirty 状态且长度不变，也检测到自身违规。
- **AC-B3-3**：reviewer 新建、删除文件，改变 symlink、mode、index 或 HEAD，按自身变化处理；不跟随 symlink 到 worktree 外。
- **AC-B3-4**：executor 后的 check 新建游离文件，记录在 executor 的 check phase；不能归下一 reviewer。
- **AC-B3-5**：已知可修复继承残留进入同一 pipeline fixer；保留前序 job/result/HEAD；不创建新的 task attempt。
- **AC-B3-6**：来源未知的继承文件不导致 reviewer policy failure，但 pipeline 不得带着未处理问题成功交付，也不得自动删除文件。
- **AC-B3-7**：缺失/损坏基线、崩溃恢复、lane 后续复用均不产生虚假责任归属。
- **AC-B3-8**：写 job 自动 snapshot 不混入继承 staged 内容；失败时原 index 和文件状态保留。

### 3.6 涉及文件

- 新增：`src/core/workspaceSnapshot.ts`、`test/m8-b3-workspace-baseline.test.ts`
- 修改：`src/core/supervise.ts`、`src/core/finalize.ts`、`src/core/git.ts`
- 修改：`src/contracts/jobResult.ts`、`src/contracts/error.ts`
- 修改：`src/pipeline/supervisor.ts`、`src/pipeline/gate.ts`、`src/pipeline/fixLoop.ts`、`src/pipeline/handoff.ts`
- 测试：execution、recovery、pipeline 测试及 `test/index.ts`

### 3.7 风险

- 内容快照有 I/O 成本；需要流式 hash、异步采集和既有 deadline/cancel 支持。
- 外部进程在同一 worktree 并发写入时无法可靠认定作者；检测为归属不明，不能猜测。
- 基线只能证明前后差异，不能证明期间从未发生短暂写入；该限制与 B4 的自报审计分开处理。

---

## 4. B4：轻微且已清理的 policy 事件降 warning，可修复失败保留当前进度

### 4.1 根因定位

- [src/contracts/workerResult.ts:31](../../src/contracts/workerResult.ts#L31)：`policy_violations` 只有 `string[]`，没有类别、严重程度或清理证据。
- [src/core/finalize.ts:29](../../src/core/finalize.ts#L29)，`finalOutcome`：观察到的 violation 和 worker 自报的任意非空 violation 都直接进入失败原因。
- [src/pipeline/gate.ts:33](../../src/pipeline/gate.ts#L33)，G5：policy failure 直接 settle 为 failed，先于 G6 检查修复和 G11 reviewer revise。
- [src/run/supervisor.ts:335](../../src/run/supervisor.ts#L335)：pipeline failed 通常转为 `task_failed`，后续 retry_task 是 task 级恢复，而非原 pipeline 的 fixer。
- 当前机器观察类别主要是：
  - `outside_allowed_paths`
  - `readonly_modified`
  - `resolver_modified_head`
  - `conflict_markers_left`
  - `conflict_unresolved`

**不存在可直接复用的“minor policy”枚举。不能用字符串包含“temporary”“cleaned”等词来降级。**

### 4.2 修复设计

新增 `src/core/policy.ts`，统一分类为：

- `warning_cleaned`
- `repairable`
- `fatal`

保留原 `worker_reported.policy_violations`，分类结果单独记录。

#### 新增结构化自报

为 M8 新 job 显式启用可选 `policy_incidents`：

```ts
{
  violation_index: number; // 对应 policy_violations 的下标
  category: "temporary_workspace_file";
  path: string;           // worktree 内相对路径
  cleaned: boolean;
}
```

- 无事件时 `[]`。
- 重复下标、越界下标、非法路径或不合法结构不得用来降级。
- 原自由文本仍可写；没有结构化且可核验的解释时按原失败行为处理。
- `WorkerSchemaOptions` 增加独立 `policyIncidents?: boolean`；未启用时旧四种 schema fixture 字节保持。
- 新提示片段只在启用时加入，不全局改写旧 prompt。

#### “轻微且已清理”的首版白名单

首版仅将 `outside_allowed_paths` 的一个狭窄子类纳入：

> workspace-write job 临时创建的 `.omc/notepad.md` 普通文件，启动时不存在、未被跟踪，结束时已删除，没有进入提交，没有其他违规。

这是内置窄白名单，不新增任意路径豁免配置。不得因为目录名以点开头就自动认定临时文件。

全部条件必须成立：

1. 结构化事件明确对应某条自报 violation，类别和路径符合白名单。
2. B3 基线证明该文件原先不存在且未被跟踪。
3. worker 退出、自动 snapshot 前，该文件已不存在。
4. HEAD/提交差异没有遗留该路径；其余工作区交付要求满足。
5. 没有其他未解释的 violation。
6. 没有 provider error、非零退出、强制终止或其他失败事实。

“结束时无残留”不等于“gbdev 已替 worker 自动 commit”：清理核验必须先于自动 snapshot。

**本版不自动降级真实 worktree 外写入。** 在不检查外部路径的边界下，无法核实其已删除、未覆盖原文件，也无法证明无副作用；自报“已清理”不足以通过。未来可为受管理临时目录单独设计可信证明，不在 M8 扩大范围。

#### 严重类别

以下保持失败，不能进入上述 warning 白名单：

- `readonly_modified`
- `resolver_modified_head`
- 对已有文件、非白名单路径、symlink 或仓库管理数据的越界修改
- 未知/未解释的 policy 字符串
- 报告中的网络、凭据、外部文件等不可由本地工作区清理证明恢复的违规

`conflict_markers_left`、`conflict_unresolved` 保持 resolver 原恢复路径，不转进普通 task fixer。

worker 显式 `status: failed` 也是独立事实，不能仅因 policy 降级而将其改成 succeeded。

#### 可修复残留

若白名单临时文件仍存在：

- 归类 `repairable`，job 仍为 failed。
- 必须有明确前序责任及完整路径证据。
- 在已有 fix loop 中进入 fixer，不重跑 executor、不创建新 task attempt。
- 给 fixer 的内部 repair scope 仅允许删除该已知 untracked 普通文件；记录预期路径和状态指纹。
- 删除前状态不匹配则暂停，不扩大 `allowed_paths`，也不执行通用清理。
- 删除成功后重新观察并运行 checks，再进入 reviewer。
- 仅清理 untracked 文件可能不改变 HEAD：G8/FIX_NO_CHANGES 必须允许“已证实 workspace issue 被解决”的 fixer，不再仅靠 HEAD 相等判定无变化。

严重 violation 和可修复项同时存在时，严重项优先，不自动运行 fixer。

### 4.3 契约、事件和错误码

JobResult 追加：

```ts
gbdev_observed.policy_assessment?: {
  policy_version: 1;
  warnings: {
    violation_index: number;
    category: string;
    path: string;
    evidence_ref: string;
  }[];
  repairable: {
    code: string;
    path: string;
    owner_job_id: string;
    evidence_ref: string;
  }[];
  fatal: string[];
};
```

- 原报告和原观察事实不删除。
- `finalOutcome` 接收评估后的阻断事实，避免又把已降级的原始字符串重复加入 failure reasons。
- 默认未传 assessment 的旧调用保留原行为。
- warning 同时投影到 handoff/pipeline warnings，保证最终结果可见。
- 可修复失败 reason 为 `policy_repair_required`；gate 使用 assessment 路由，不能只匹配 reason 字符串。
- 已有 `policy_violations: ...` 继续用于 fatal。
- 复用现有 `gate`、`warning` 事件，分别记录 `policy_warning_cleaned`、`policy_repair_required`。
- 无 fix loop 或预算/round 耗尽时暂停，使用现有 `step_failed` / `max_rounds_exceeded` 决策，不自动 task retry。

### 4.4 对旧测试的影响

- `test/finalize.test.ts` 的原优先级表默认不变。
- `test/r1.test.ts` 中任意自报 `reported_violation` 仍失败。
- 真实越界源码和 reviewer 写入测试不变。
- 新增带有效 assessment 的 warning/repairable 分支。
- schema fixture 用独立 opt-in 测试，不能整体覆盖旧 fixture。
- 增加“HEAD 未变但清理确实完成”的 fixer 成功测试。

### 4.5 验收标准

- **AC-B4-1**：fake executor 创建并删除白名单临时文件，输出匹配 incident；job 成功，原 violation 仍保留，warning 在 job、handoff、pipeline result 可见。
- **AC-B4-2**：仅自报“已清理”、没有 incident，或 baseline 原有该文件；不得降级。
- **AC-B4-3**：worktree 外路径、路径逃逸、symlink、已跟踪文件、未知类别、reviewer 自身写入均不得降级。
- **AC-B4-4**：白名单文件未清理，进入当前 pipeline 的 fixer；task attempt 不增加，executor 不重跑，历史 HEAD/result 保留。
- **AC-B4-5**：fixer 删除残留但 HEAD 不变；证据确认 issue 已消失后可以继续 reviewer，不误报 `fix_no_changes`。
- **AC-B4-6**：混合 fatal 与 repairable 事件不启动自动修复；严重失败保持。
- **AC-B4-7**：round/job 预算耗尽、无 fix loop、repair scope 状态不匹配时暂停，不扩展写权限、不从头重启。
- **AC-B4-8**：provider error、非零退出、`status: failed`、取消和 timeout 不因 policy warning 而被抹掉。

### 4.6 涉及文件

- 新增：`src/core/policy.ts`、`test/m8-b4-policy.test.ts`
- 修改：`src/core/finalize.ts`、`src/core/supervise.ts`
- 修改：`src/contracts/workerResult.ts`、`src/contracts/workerResultSchema.ts`、`src/contracts/jobResult.ts`
- 修改：`src/pipeline/gate.ts`、`src/pipeline/fixLoop.ts`、`src/pipeline/supervisor.ts`、`src/pipeline/handoff.ts`
- 按新增 schema option 传递点修改 job 创建代码，包括普通 start/pipeline 创建路径。
- 新增条件式角色片段；同步 `roles/_shared/fragments.json` 及生成产物。
- `test/index.ts`

### 4.7 风险

- 自报事件无法证明完整历史；本设计只对有限、可核验的恢复状态做分类，不声称证明“期间没有任何其他行为”。
- 首版白名单刻意狭窄，一些真实轻微事件仍会失败；优于按自然语言大范围放行。
- 清理残留时不得隐式扩大 fixer 的源码修改范围。

---

## 5. B5：将选定格式/静态检查前移到 task check 阶段

### 5.1 根因定位及现有关系

- [src/contracts/runRequest.ts:10](../../src/contracts/runRequest.ts#L10)：`checks[]` 是可信命令库，`integration_checks[]` 是检查 ID 列表。
- [src/run/requests.ts:15](../../src/run/requests.ts#L15)：只有 task criterion 的 `check` 引用被展开为 task `check_cmd`；`integration_checks` 不会自动传入。
- [src/pipeline/supervisor.ts:115](../../src/pipeline/supervisor.ts#L115)：只有 output 为 change 的步骤保留 `check_cmd`，reviewer 不执行这些检查。
- [src/run/supervisor.ts:166](../../src/run/supervisor.ts#L166)：merge gate 检查集合包含 integration checks、当前及已合并 task 的 criterion checks、run-level criterion checks。
- [src/run/supervisor.ts:292](../../src/run/supervisor.ts#L292)：integration checks 也在 run baseline gate 执行。
- [src/run/gate.ts:15](../../src/run/gate.ts#L15)：gate 按 check ID 去重，每项最多两次执行；task check 当前固定单次、默认 10 分钟。

因此，格式检查如果只在 `integration_checks`，task 修改后不会在 executor/fixer 结束时执行；baseline 通过也不能证明 task 修改后的格式仍正确。

### 5.2 修复设计

RunRequest 增加：

```ts
task_checks?: string[]; // 默认 []
```

例：

```json
{
  "checks": [
    {"id": "fmt", "cmd": "cargo fmt --check", "timeout_min": 5},
    {"id": "test", "cmd": "cargo test", "timeout_min": 10}
  ],
  "integration_checks": ["fmt", "test"],
  "task_checks": ["fmt"]
}
```

规则：

1. `task_checks` 仅能引用 `checks[].id`，重复 ID 拒绝；未知 ID 使用既有 `run_invalid`。
2. 不自动复制全部 integration checks，也不从命令名猜测 formatter/linter。
3. 默认空列表时，现有检查集合、环境和执行流程不变。
4. 对所有 task 的 workspace-write/change 步骤生效，包括 executor、fixer、integration-fix/final-fix 的 change 步骤。
5. reviewer、verifier、planner、inspect 等 read-only job 不执行此集合。
6. merge gate 和 baseline gate 保持独立，不因 task check 成功而跳过。
7. 用户应配置非修改型检查；M8 不自动执行格式修复命令。

#### 配置传递

增加可选、冻结的执行检查列表：

```ts
execution_checks?: {
  id: string;
  cmd: string;
  timeout_min: number;
}[];
```

从 `RunRequest.task_checks` 解析可信命令后，传入 PipelineRequest，再传入 change job 的 TaskBrief。

- 独立 pipeline/brief 可显式使用该列表，默认 `[]`。
- 不伪造 acceptance criterion。
- 保留真实 check ID，输出另加 `source: "task_check"` 区分 criterion。
- criterion 与 execution check 的逻辑身份分别命名，避免 `AC1` 恰好与 trusted check ID 相同造成碰撞。
- 合并执行计划交给 B2 去重；同命令、同环境、同 HEAD、同工作区 generation 可以共享一次物理执行。
- task 阶段沿用其既有 effective env；merge gate 继续保留过滤 `GBDEV_*` 的现有语义，不宣称两阶段执行环境完全相同。

#### 失败路由

- 新检查失败仍产生 `check_failed:<logical-id>`。
- 复用 G6 → `insertFix` → fixer → task checks → reviewer。
- `fixInput` 提供真实 check ID、命令、退出码、checked SHA 和有界日志。
- 不合成 reviewer 的 `revise` verdict；这是调度器检查失败触发的修复回合。
- check 本身修改工作区时，由 B3 记录为 check phase 问题，不能悄悄归给 worker 或下一 reviewer。
- 检查 timeout 使用 `checks[].timeout_min`，并受剩余 job/pipeline/run deadline 和取消约束。

### 5.3 契约、事件和错误码

- `gbdev.run-request.v1` 追加可选 `task_checks`，缺省按 `[]` 解释。
- 同步 `gbdev.run-request.v1.schema.json`。
- PipelineRequest/TaskBrief 追加可选 `execution_checks`，冻结到请求和 job brief。
- 检查结果可追加 `source`、`check_id`、`checked_sha`，其余复用 B2 字段。
- 事件仍使用 `check`、`gate`。
- 不新增公共错误码；输入错误复用 `run_invalid`、`pipeline_invalid`、brief 校验错误。

### 5.4 对旧测试的影响

- 无 `task_checks` 的旧 run fixture 保持原执行次数和流程。
- reviewer brief 仍不携带可执行 task checks。
- merge gate 两次尝试、flaky warning、baseline gate 及 rollback 测试不变。
- 新增 task-only 配置和与 criterion 共享命令的去重测试。

### 5.5 验收标准

- **AC-B5-1**：临时 repo 的 baseline fmt 通过，fake executor 制造格式错误；task check 在 reviewer 前失败，自动进入 fixer。
- **AC-B5-2**：fake fixer 修复后先重跑 task checks，再 reviewer；不重跑 executor，不增加 task attempt。
- **AC-B5-3**：merge gate 仍在合并 HEAD 上再次执行 fmt，不能使用 task 阶段缓存代替。
- **AC-B5-4**：缺省/空 `task_checks` 时与旧行为一致；仅 integration check 不会被隐式前移。
- **AC-B5-5**：未知 ID、重复 ID 在启动 worker 前被拒绝；timeout 从可信检查库正确传递。
- **AC-B5-6**：一个 fmt 同时被四条 criterion 和 task_checks 引用，在执行身份一致时只运行一次，但所有逻辑结果可追溯。
- **AC-B5-7**：read-only job、final reviewer 和 inspect 不运行前移检查。
- **AC-B5-8**：取消、检查改写文件、round 耗尽均保留正确证据和现有决策边界。

测试中的“fmt”用本地小脚本模拟，不要求安装 Rust 或执行真实 cargo。

### 5.6 涉及文件

- 修改：`src/contracts/runRequest.ts`、对应 JSON schema
- 修改：`src/contracts/pipelineRequest.ts`、`src/contracts/brief.ts`
- 修改：`src/run/requests.ts`、`src/pipeline/supervisor.ts`
- 修改：B2 的 `src/core/checks.ts`、`src/core/finalize.ts`
- 修改：`src/contracts/jobResult.ts`、`src/pipeline/fixLoop.ts`
- 新增：`test/m8-b5-task-checks.test.ts`
- 文档：README 的 run request/check 配置说明、`docs/controller-recipe.md`
- `test/index.ts`

### 5.7 风险

- 某些 integration check 依赖所有 task 合并后的完整功能，不适合前移；显式 ID 列表避免自动误选。
- 额外检查增加 task 耗时；B2 去重只能消除同一阶段的重复，不能消除必要的 merge gate。
- baseline 本身格式不通过时仍按现有 baseline gate 失败，不在本项偷偷新增“先运行 task 修 baseline”的语义。

---

## 6. B6：Cursor exit 0 但缺少 worker-result/verdict 的稳健恢复

### 6.1 根因定位

| 位置 | 已确认事实 |
|---|---|
| [src/providers/cursor.ts:10](../../src/providers/cursor.ts#L10)，`extractCursorResult` | 只取 result envelope 中字符串形式的 `.result` |
| [src/providers/cursor.ts:22](../../src/providers/cursor.ts#L22)，`assistantText` | 收集全部 assistant text 并拼接 |
| [src/providers/cursor.ts:63](../../src/providers/cursor.ts#L63)，`extractFinalMessage` | 只要存在 terminal result，就不尝试 assistant fallback，即使 `.result` 缺失、为空或没有合法 worker JSON |
| [src/core/supervise.ts:134](../../src/core/supervise.ts#L134) | gbdev 将 adapter 提取的文本写入 `final.md` |
| [src/core/finalize.ts:158](../../src/core/finalize.ts#L158) | 从 `final.md` 调用 `extractWorkerResult` 得到结构化报告 |
| [src/contracts/workerResult.ts:198](../../src/contracts/workerResult.ts#L198) | 已支持纯 JSON 和 fenced JSON，不需要从零重写 fenced parser |
| [src/pipeline/gate.ts:29](../../src/pipeline/gate.ts#L29) | 缺失 verdict 已有一次自动 retry，之后暂停；同 step 总 attempt 上限为 3 |
| [src/run/finalReview.ts:25](../../src/run/finalReview.ts#L25) | final review 已有最多两次尝试 |

**结果文件由 gbdev 写入，不是 Cursor 必须自己写一个 worker-result 文件。** 缺失可能是输出协议不完整，也可能是有效 JSON 被 terminal result 的提取优先级遮蔽。

仓库中现有证据不能确定 live Cursor `createPlan` 的具体数据结构；本项不凭猜测递归搜索任意 tool payload。

### 6.2 修复设计

#### A. 新增“结构化结果候选”提取接口

保留普通文本提取 API，新增用于结构化交付的接口，例如：

```ts
extractResultCandidates(jobDir, context): {
  source: "terminal_result" | "assistant_final";
  event_index: number;
  session_id: string | null;
  text: string;
}[];
```

`context` 至少包含该 job 期望的 output 类型。

候选顺序和限制：

1. 最后一个当前执行/session 的 terminal result 文本。
2. 同一执行中、最后一次终止结果之前的最终 assistant 消息。
3. 无 terminal result 时，使用当前执行最后的完整 assistant 消息。
4. 不将不同 assistant 回合直接无边界拼接来寻找 verdict。
5. 不读取 user、thinking、read/grep/shell 等 tool 返回正文作为 verdict。
6. 不回溯到更早已经终止的 attempt/session。
7. terminal result 显式表示 provider failure 时，不以更早成功候选覆盖它。

同一 assistant message 的多个 text block可以拼接；没有明确 message identity 时，按事件边界保守处理，不臆测跨事件 delta 关系。

#### B. 严格验证，不回收陈旧 approve

- terminal result 已含合法、满足期望 output 的报告时，它是权威结果。
- terminal result 缺失文本、仅有普通 prose 或未提供完整期望报告时，才尝试最终 assistant 候选。
- 对 verdict job，候选必须包含完整、可验证的 worker-result，以及真实的 `review.verdict`、`review.findings`。
- `revise` 空 findings 仍按既有 G9 视为缺失有效结论。
- 明确存在损坏/未闭合的最新结果 JSON 时，不跳过它去捡更早 approve。
- 同一最终交付出现互相冲突的明确 verdict 时，记录结果无效，不自行选择 approve。
- verdict 路径新增严格候选选择，不全局改变普通 prose/report 的宽容解析行为。

`createPlan` 的处理决定：

- **M8 不把任意 createPlan/tool 文本直接升级为 verdict。**
- 如果 stream 只有计划工具调用、没有最终结构化交付，则进入既有 retry。
- 后续只有在仓库加入经过脱敏、结构明确的 fixture 后，才能以精确 allowlist 增加候选来源；不是本版验收前置条件。

#### C. 复用现有一次重试，不增加隐形调用

- pipeline G9 的一次自动重试和 final review 的第二次尝试继续使用正常 job 创建、预算、slot、deadline、取消和审计路径。
- 不在 provider adapter 内偷偷再调用一次 Cursor。
- Cursor 缺失结果的重试增加专用提示：
  - 前次缺少可用结构化交付；
  - 最终回复必须直接给出完整 JSON；
  - 不要求 worker写结果文件；
  - 不得根据 exit 0 推断 approve；
  - 证据不足必须如实给出问题或阻塞，不能猜 verdict。
- 将 gbdev 已提取的前次最终文本以有界、不可信证据片段提供，而不只给空 summary：
  - 默认最多 16 KiB；
  - 优先提供最终回复尾部；
  - 明确截断标记及来源 job/HEAD。
- 不向 worker 提供外部 job 日志路径让其自行读取。
- 不依赖当前 adapter 尚未实现的会话续写能力。第二次仍是正式只读审查 job，可复核原结论并补齐协议。

### 6.3 契约、事件和错误码

JobResult 追加可选：

```ts
worker_result_source?: {
  kind: "terminal_result" | "assistant_final";
  event_index: number;
  raw_file: string; // job 内相对路径
};
```

- `worker_result_warnings` 可加入 `worker_result_recovered_from_assistant`。
- 原 raw 文件不覆盖；`final.md` 保存实际选中的文本。
- 可选 `result-extraction.json` 记录候选索引及拒绝原因，不复制整份 tool 输出。
- 保留 `worker_result_missing`、`worker_result_invalid: ...`、`verdict_missing` 和所有 M7 S2 错误码。
- 回退提取不算新 attempt，不增加 jobs_used；真正重试仍计入。
- 使用既有 `warning` 事件记录恢复来源，不自动生成 `verdict_missing_reviewed` 或 accept。

### 6.4 对旧测试的影响

- `test/r7.test.ts` 中“最后一个 provider error 不得复活更早结果”的测试必须保持。
- legacy pretty JSON 和正常 stream-json result 测试保持。
- 普通文本 `extractFinalMessage` 的兼容测试可以保持；新结构化路径单独测试。
- `test/s4-pipeline.test.ts`、`test/m7-s2-verdict.test.ts` 中真正无 JSON 的自动重试次数、第三次手动 retry、accept 保护保持。
- 新增“终止 result 无有效正文，但最终 assistant 有完整 JSON”的成功用例。

### 6.5 验收标准

- **AC-B6-1**：terminal success 没有 `.result`，同次最终 assistant 有完整合法 verdict JSON；成功恢复，不新建 job，来源可追溯。
- **AC-B6-2**：terminal result 只有 prose，最终 assistant 有合法 JSON；可恢复；若 terminal 已有合法 verdict，则使用 terminal。
- **AC-B6-3**：terminal provider error、非零退出、取消或 timeout，不因 assistant 中有 approve 而成功。
- **AC-B6-4**：user/tool 输出、旧 session、较早 assistant 回合中的 approve 不得被选为当前 verdict。
- **AC-B6-5**：只有 createPlan、只有 prose、缺 review、损坏最终 JSON或冲突 verdict，进入原缺失/无效流程，不伪造结论。
- **AC-B6-6**：首次缺失、第二次补齐 JSON：只增加既有一个 retry job，预算和 attempt 正确；前次原始结果不改写。
- **AC-B6-7**：两次仍缺 verdict 时暂停；M7 S2 接受保护完整通过，不能仅凭 exit 0 接受。
- **AC-B6-8**：final review 使用相同提取规则，仍最多两次；结构化回退不会额外消耗 slot 或新增隐藏 provider 调用。
- **AC-B6-9**：分段 JSONL、CRLF、尾部残缺事件、长文本截断均可确定性处理；raw 日志和 provenance 正确。

### 6.6 涉及文件

- 修改：`src/providers/cursor.ts`、`src/providers/types.ts`
- 必要时新增：`src/providers/cursorResults.ts`
- 修改：`src/core/supervise.ts`、`src/core/finalize.ts`
- 修改：`src/contracts/workerResult.ts`、`src/contracts/jobResult.ts`
- 修改：`src/pipeline/supervisor.ts`、`src/run/finalReview.ts`、相关 prompt assembly
- 新增条件式 Cursor 结果重试提示片段，更新角色生成产物
- 新增：`test/m8-b6-cursor-results.test.ts`、脱敏 stream fixtures
- `test/index.ts`

### 6.7 风险

- Cursor 的输出结构可能继续变化；未知结构必须保持缺失/无效，不做任意深度字符串搜索。
- assistant 中可能引用示例 JSON，因此候选必须限制在最终交付位置，且仍要求完整 schema。
- 有界片段可能无法包含全部审查证据；重试允许重新只读核验，不能假装它是可靠的会话续写。

---

## 7. 实施顺序：每项一个提交

| 顺序 | 提交主题 | 原因与完成条件 |
|---|---|---|
| 1 | **B3 — job workspace baseline and phase attribution** | 先建立归属、阶段观察、路径安全和状态指纹；后续 B1/B2/B4 复用 |
| 2 | **B4 — classified policy warnings and in-place repair** | 基于 B3 做窄白名单、清理证据、repair scope 和原 pipeline 修复 |
| 3 | **B2 — deduplicate job check executions** | 抽取 check runner，建立执行身份、日志索引和按状态失效 |
| 4 | **B5 — opt-in task checks from trusted check catalog** | 基于 B2 接入额外 task checks，默认空列表，保持 merge gate |
| 5 | **B1 — bounded multi-signal stall detection** | 复用 B3 文件状态探针，加入 CPU/tool 有限宽限，不改变取消和绝对 deadline |
| 6 | **B6 — strict Cursor result recovery and existing retry enrichment** | 修复提取和提示，最后集中验证与 M7 S2/S3 的兼容性 |

每个提交必须：

- 注册自己的测试到 `test/index.ts`。
- 通过对应定向测试及项目要求的完整测试。
- 保持旧结果/请求读取兼容。
- 不依赖真实 Cursor/Codex、网络、真实用户配置或真实 tmux。
- 避免重写另一 worker 的 S3 文件；以已合入后的实际接口做最小适配。

完整回归特别覆盖：

- M7 verdict accept 保护；
- inspect 的 read-only、无 checks、独立生命周期；
- cancel/timeout/进程组清理；
- pipeline round/job budget；
- merge gate/baseline gate/rollback；
- 安全 argv 检查；
- webhook 内容上限和不包含详细证据。

本次规划未执行这些检查；它们是后续实现提交的完成门槛。

## 8. open_questions

```yaml
open_questions: []
```

已自行确定的关键边界：

- stall 使用有限宽限，不用“进程存在”永久保活。
- dedup 只限单 job check phase，不做跨 job 或跨 merge 的缓存。
- reviewer 只对自身增量负责；继承残留仍需独立阻止不干净的交付。
- 初版 policy warning 白名单只覆盖可核验的窄范围工作区临时文件；真实 worktree 外写入不凭自报降级。
- 格式/静态检查通过显式 `task_checks` 前移，默认不改变旧行为。
- 不猜测 createPlan 结构，不新增 adapter 内隐形续写；结果恢复失败仍走既有正式重试与 M7 决策保护。
## B7（追加，2026-10-31 调度方；顺序：M8 第一项，先于 B3）
现象：live run r_20261030_2354_f79f 两个 Cursor final-review job（j_20261031_0533_68b8 / 0a51）在 ~0.3–0.55s 内 exit 0、零输出（raw_events 0、worker.log 空），同一秒内背靠背、无 backoff；gbdev 记录 worker_result_missing，触发 final_review_revise，dispatcher accept_final，最终评审实际从未运行。证据：provider argv 最后一项是 646,995 字节的 prompt（prompt.md 658KB）。
要求：
1. 启动失败分类：worker 退出时 duration < LAUNCH_FAIL_MAX_S（默认 5s，可配置）且 raw 事件数 0 且无 final message → failure_reason `launch_failed`（新错误码，加入契约/schema），不是 worker_result_missing / verdict_missing。
2. 对 launch_failed 自动重试，指数 backoff（如 2s、8s，最多 2 次重试，可配置），每次写事件 `launch_retry`；全部失败后 job 以 launch_failed 失败，notify/status 明确展示，**不**生成可被 accept 的 verdict 决策；pipeline 步骤以 launch_failed 暂停（需 retry 或 user 介入），不得进入 final_review_revise 的可接受路径。
3. accept_final：当最终评审无 verdict（verdict_missing / worker_result_missing / launch_failed）时，accept_final 走与 S2 verdict_missing 相同的证据守卫（需重试过 + diff/test 证据 + verdict_missing_reviewed:true + note），否则拒绝（action_not_allowed / verdict_retry_required）。
4. Prompt 上界：最终评审（及所有 Cursor 评审）prompt 设字节上限（如 200KB）；内嵌 diff 超限时截断并改为引用 diff 文件路径（worker 可在只读模式读取），而不是把整份 diff 放进 argv；超出仍不可行时报 `prompt_too_large` 失败，不静默。
5. 测试：fake provider 模拟 0.3s 空退出 → launch_failed + 重试次数 + backoff 时序（注入时钟）；accept_final 守卫正反用例；大 diff 时 prompt 被有界化。


---

<!-- 附录：B7 详细规格（M8 第 21 轮 Codex 只读规划，基线 8f4981c）。B7 实施以本附录为准。 -->

# B7：Worker 启动失败隔离、退避重试与评审 Prompt 上界

## 1. 基线、目标与范围

### 1.1 基线

- 仓库：`/path/to/gbdev-m7`
- 分支：`gbdev-controller`
- 代码基线：`8f4981ce1a45d093d42642d5eb9c671342fc4603`
- 本章所有文件行号均对应上述提交，不依赖其他会话的未提交内容。
- 本轮仅产出规格，不修改文件、不运行 build/test。

### 1.2 问题定义

根据本轮提供的 live run 取证：

1. 两个最终评审 Cursor job 分别在约 `0.3–0.55s` 内 exit `0`。
2. `raw.json`、`worker.log` 均为空；`worker_output` 显示 `raw_events=0`、`bytes=0`。
3. 两次启动背靠背发生，没有退避。
4. 无输出被归为 `worker_result_missing`，最终进入 `final_review_revise`，随后被 `accept_final` 接受。
5. provider argv 的最后一项是约 `646,995` 字节的单个 prompt 参数。

**已确定的工程问题**是：启动阶段的快速空退出没有独立分类；最终评审丢失失败原因；现有重试计数不能区分启动失败与有效的审查重试；最终评审 prompt 无总字节上限。

**尚未证明的因果关系**是：Cursor 是否因超大 prompt 参数静默退出。B7 不以证明该 provider 内部行为为实施前提，同时修复失败分类与 prompt 上界。

### 1.3 目标

- 快速无输出退出识别为 `launch_failed`，不降级为缺少审查结论。
- 启动失败自动有限重试，每次有指数 backoff 和可审计事件。
- 重试耗尽后保留失败事实，pipeline/run 只能重试或人工介入，不能直接接受。
- `accept_final` 继续使用 S2 共用守卫，并修复启动失败计数、轮次及结果关联缺口。
- 最终评审及所有 Cursor 评审 prompt 有明确 UTF-8 字节上限；大 diff 文件化，无法压缩到上限内时明确失败。

### 1.4 不变项

- 不修改 `src/notify/http.ts`。
- Cursor 固定使用 `--model auto`；Codex 保持 high effort。
- 不改变现有只读评审权限，不为读取 diff 扩大写权限。
- 不增加“接受未运行评审”的开关。
- 不把决策者接受伪装成 reviewer approve。
- 不引入真实 provider、真实通知端点或真实用户目录依赖到测试。
- B1、B6 的对接按本章接口规则实施；不假定当前 HEAD 已包含它们的后续实现。

---

## 2. 根因定位

| 问题 | HEAD 定位 | 现状与缺口 |
|---|---|---|
| 无单次进程启动耗时判定 | [src/core/supervise.ts:72](../../src/core/supervise.ts#L72) | spawn 后收集输出，close 后直接进入收尾；没有将快速空退出识别为启动失败。 |
| `raw_events` 只是换行计数 | [src/core/supervise.ts:93](../../src/core/supervise.ts#L93) | 每遇到 LF 加一，不等同于 provider JSON 事件数。无换行的有效 JSON 不能被误认为无事件。 |
| final message 提取在 close 后进行 | [src/core/supervise.ts:147](../../src/core/supervise.ts#L147) | 已有 raw、exit code 和提取器，适合在此加入单次执行分类；必须在输出完全关闭后判定。 |
| 空输出进入缺结果路径 | [src/core/finalize.ts:238](../../src/core/finalize.ts#L238) | 无 final message 时仍调用 worker-result 提取，产生 `result_missing` warning，再映射为 `worker_result_missing`。 |
| 总 job 耗时不能用于启动判定 | [src/core/finalize.ts:94](../../src/core/finalize.ts#L94) | `duration_s` 从 job 创建开始计算，包含启动前等待及收尾，不能代替单次 worker 进程耗时。 |
| 最终评审统一执行最多两次 | [src/run/finalReview.ts:24](../../src/run/finalReview.ts#L24) | null verdict 与 reject 等情况由同一循环继续，缺少启动失败专门退避。 |
| 最终评审丢失失败类别 | [src/run/finalReview.ts:58](../../src/run/finalReview.ts#L58) | 返回值仅保留 `job_id/verdict/findings`；失败 job 转成 `verdict:null`，原 `failure_reason` 未传播。 |
| null verdict 进入可接受决策 | [src/run/supervisor.ts:391](../../src/run/supervisor.ts#L391) | null verdict 被映射为 `final_review_revise`，动作包含 `add_fix_task/accept_final`。 |
| pipeline 将缺结果评审交给 G9 | [src/pipeline/gate.ts:26](../../src/pipeline/gate.ts#L26) | `worker_result_missing` 或 invalid verdict result 会触发缺 verdict 重试；必须在该分支前截住启动失败。 |
| S2 已覆盖 `accept_final` | [src/run/decisions.ts:131](../../src/run/decisions.ts#L131) | 设置 `accepted_by_decider` 前已调用 `assertFinalReviewVerdictAccept`，不是完全缺守卫。 |
| S2 的终态计数过宽 | [src/core/verdictAcceptance.ts:113](../../src/core/verdictAcceptance.ts#L113) | 收集整个 run 中所有 `run:final_review#...` 终态 job，没有按审查轮次隔离，也没有排除启动失败、限流等非有效审查。 |
| S2 final-review 关联验证不足 | [src/core/verdictAcceptance.ts:95](../../src/core/verdictAcceptance.ts#L95) | 读取并验证摘要基本形状，但未完整核实该摘要对应当前轮次、当前目标 SHA 和最新 job result。 |
| 最终评审内嵌完整 diff | [src/run/finalReview.ts:42](../../src/run/finalReview.ts#L42) | 将完整集成 diff 与 tasks/pipelines JSON 拼入 `untrusted`。 |
| 渲染后还可能继续膨胀 | [src/run/promptAssembly.ts:33](../../src/run/promptAssembly.ts#L33)、[src/pipeline/prompt.ts:14](../../src/pipeline/prompt.ts#L14) | `renderUntrustedData` 再做 JSON 编码，转义会增加字节；原始 diff 大小不是最终 argv 参数大小。 |
| Cursor 将整个 prompt 放入 argv | [src/providers/cursor.ts:55](../../src/providers/cursor.ts#L55) | `ctx.prompt` 是最后一个参数，adapter 无字节上限。 |
| 通知可能丢失新原因 | [src/contracts/notify.ts:15](../../src/contracts/notify.ts#L15)、[src/notify/filter.ts:18](../../src/notify/filter.ts#L18) | reason 使用白名单，pipeline attention 目前也未显式透传 reason code，必须同步更新。 |

### 2.1 对 live run 与 S2 的准确解释

当前 HEAD 的 `assertFinalReviewVerdictAccept` 在 `verdict:null` 时已要求：

- 至少两个已结束的最终评审 job；
- `verdict_missing_reviewed:true`；
- 非空且不超过 2000 字符的 note。

因此，不能仅根据 live run 被接受，断言本 HEAD 未调用守卫；本轮也没有读取该 live run 的 resume 输入或部署版本。

**本 HEAD 可确认的漏洞是：两个快速空退出 job 会满足现有终态数量检查。** 即便调用者提供了确认字段和 note，也可能接受从未有效运行的评审。

另须保留 S2 的真实边界：`SPEC-M7.md:124` 明确规定 diff/test 证据由 note 作决策者声明，代码不验证自然语言语义。B7 不将此机制描述成“机器已证明决策者读过 diff 和测试”。

---

## 3. 技术决策与配置

### 3.1 配置

在现有配置中新增可选闭合对象：

```json
{
  "worker_launch": {
    "failure_threshold_ms": 5000,
    "max_retries": 2,
    "backoff_initial_ms": 2000,
    "backoff_multiplier": 4,
    "backoff_max_ms": 30000
  },
  "review_prompt": {
    "max_bytes": 200000
  }
}
```

| 字段 | 默认值 | 合法范围与语义 |
|---|---:|---|
| `failure_threshold_ms` | 5000 | 整数，1–60000；严格小于该值才满足快速退出条件。 |
| `max_retries` | 2 | 整数，0–5；不含首次启动。0 仅关闭自动重试，不关闭分类。 |
| `backoff_initial_ms` | 2000 | 整数，1–60000。 |
| `backoff_multiplier` | 4 | 整数，2–10。 |
| `backoff_max_ms` | 30000 | 整数，不小于 initial，最大 300000。 |
| `max_bytes` | 200000 | 整数，4096–200000；200KB 在本章精确定义为 200000 字节。 |

未知字段、非整数、非法范围返回 `config_invalid`。

第 `n` 次自动启动重试的延迟：

```text
delay_ms(n) =
  min(backoff_max_ms, backoff_initial_ms × backoff_multiplier^(n - 1))
```

默认两次延迟为 `2000ms`、`8000ms`，不添加随机抖动。

配置在逻辑执行链创建时冻结；运行中的自动重试不得因重新读取配置而重置预算。人工显式 retry 创建新执行链，可读取新的合法配置。

### 3.2 重试单位

区分以下三个概念：

| 概念 | 定义 |
|---|---|
| worker execution | 一次真实 provider 子进程执行。 |
| job attempt | 现有 job ID，对应 pipeline attempt 或一次最终评审尝试。 |
| retry chain | 从首次执行到自动重试结束的逻辑执行链；人工 retry 才创建新链。 |

**B7 的启动重试在同一 job 内进行，不创建第二个 job。**

- 默认全程快速空退出：一个 job、三次 worker execution、两个 `launch_retry` 事件。
- job 在自动重试期间保持非终态，最终只发布一次终态 result。
- 启动重试不增加 pipeline attempt 数，不计入 S2 审查重试次数。
- `jobs_used` 保持“创建 job 数量”的原语义；新增执行次数字段单独展示，不能将子进程次数伪装为 job 数。
- 同一逻辑链的 B6/G9 后继 job 继承已消费的 B7 启动重试预算，不能重新获得两次免费启动重试。

实现一个共用的 retry-chain 记录，包含链 ID、owner、策略快照、各类已用预算及待执行重试。pipeline、final review 和独立 job 只负责绑定 owner，不分别实现启动重试循环。

---

## 4. 启动失败分类与生命周期

### 4.1 分类条件

在 provider 子进程 `close`、stdout/stderr 完成收集、final message 提取完成后，对**本次 execution**判定：

```text
launch_failed =
  worker 已成功 spawn 且已 close
  AND worker_duration_ms < failure_threshold_ms
  AND 本次 raw_events == 0
  AND 本次没有可解析的 provider JSON 事件
  AND 本次 final message 不存在或 trim 后为空
  AND 没有优先处理的强制终止或已识别 provider 故障
```

说明：

1. `worker_duration_ms` 使用可注入单调时钟，从成功 spawn 到 close 计算。
2. 不使用 `JobResult.duration_s` 作启动判定。
3. 不要求 `exit_code===0`；非零的快速空退出同样可能是启动失败，但保留真实 exit code。
4. 不要求 stderr 为空；stderr 可提供失败线索。
5. 保留现有 `raw_events` 的兼容含义，同时用 provider JSON 解析结果补充判定，防止有效但无末尾换行的 JSON 被误分类。
6. 短时间内已输出 final message、有效结果或 provider 事件的正常 worker，不属于 `launch_failed`。
7. 未成功 spawn 的操作系统错误沿用明确的启动错误路径；参数过长的系统错误映射为 `prompt_too_large`，不得进入空退出重试。

### 4.2 分类优先级

按以下顺序处理，**同一次 execution 只能选择一个自动重试责任方**：

| 优先级 | 情况 | 处理 |
|---:|---|---|
| 1 | 已确认取消、总 deadline 到期 | 保留取消/timeout；不启动下一次 execution。 |
| 2 | B1 已触发 stall 终止 | 保留 `worker_stalled`；不因 close 很快改为启动失败。 |
| 3 | Prompt 预检或系统参数长度失败 | `prompt_too_large`；不自动重试相同输入。 |
| 4 | 已识别 rate-limit、信任/认证等具体 provider 故障 | 保留具体原因；限流交给既有 cooldown 路径。 |
| 5 | 满足快速无输出条件 | `launch_failed`，仅 B7 负责退避重试。 |
| 6 | 普通退出但缺 worker-result/verdict | 进入 B6/G9 或既有缺结果逻辑。 |
| 7 | 其他结果 | 保持现有结果、检查及策略处理。 |

原有策略违规、只读工作区修改检测不能被跳过。若快速退出同时存在工作区修改：

- 保留启动失败观测及策略违规事实；
- 不自动再次执行该 worker；
- 进入不可接受的故障处理，不用“启动失败重试”掩盖副作用。

### 4.3 收尾要求

- 中间启动失败不得调用会发布终态或执行验收命令的完整 `finalize`。
- 对已经确定的 `launch_failed`，不再产生以缺 worker-result 为主因的 `result_missing` warning。
- 最终失败结果为：

```json
{
  "state": "failed",
  "worker_exit_code": 0,
  "worker_reported": null,
  "failure_reason": "launch_failed",
  "failure_reasons": ["launch_failed"]
}
```

存在其他真实故障事实时可追加 `failure_reasons`，但不能追加派生的 `worker_result_missing` 并让上层据此走 G9。

- `worker_exit_code` 保留实际值，不能为了使失败“看起来正常”而改写。
- 最终成功的 job 不保留终态 `failure_reason:"launch_failed"`；历史启动失败从 execution 记录和事件读取。
- 只读 prose 成功容错不能将启动失败改为成功。

### 4.4 单次输出隔离

每次 execution 必须拥有独立输出事实：

- 增加 `launch-attempts/<n>/` 保存该次 raw、worker log、final message及执行摘要。
- 顶层既有 raw/log/final-message 路径继续表示当前或最终一次 execution，保证现有读取器兼容。
- 下一次启动前清除上一 execution 的 final message/session 提取状态。
- classifier 和 provider-failure 检测只使用当前 execution 输出，不能被旧日志里的限流文本污染。
- 所有 attempts 的原始输出均保留，不能通过覆盖顶层 raw 丢失首次故障证据。

### 4.5 退避、取消与恢复

- 使用可注入 `Clock`，至少提供单调时间、墙钟时间和支持 abort 的异步等待。
- 在不持有全局 store 锁时等待 backoff。
- 本次子进程及其进程组完成清理后，才可开始下一次启动。
- B7 同 job 退避期间保留现有容量租约，避免同时持有多个 worker；不得额外 acquire 第二份租约。
- backoff 算入原 job/pipeline/run deadline，不重置超时时间。
- 等待期间继续响应 cancel、abort 和父级 deadline；收到终止后不得再 spawn。
- B1 stall 计时器只监控活跃子进程，不监控 backoff；下一次 execution 使用新 stall 起点。

重试记录先持久化，再等待。至少持久化：

- `chain_id`
- 已完成 execution 数
- 已消费启动重试数
- 待启动 execution 序号
- `retry_not_before`
- 策略快照
- 上一次分类及结束事实

恢复时不得重置计数或跳过剩余 backoff；若不能证明旧进程已退出，不得并发启动新进程。无法安全续跑时保留既有 supervisor recovery 故障路径并暂停，不能把恢复视为成功审查。

---

## 5. 与现有重试、B6 和 B1 的关系

### 5.1 Rate-limit

现有识别入口为 `src/run/scheduler.ts:58`；pipeline 自动重试分支位于 `src/pipeline/supervisor.ts:186`。

B7 要求：

- 在启动失败分类前识别真实 rate-limit。
- 同一次 execution 被选为 rate-limit 后，不发布 `launch_retry`，不消费 B7 预算。
- B7 耗尽后的 `launch_failed` 不再进入外层 rate-limit/G9 自动重试分支。
- rate-limit 重试继续受 provider cooldown、job budget、attempt 上限约束。
- 旧 execution 的日志不得参与新 execution 的限流识别。

### 5.2 B6：exit 0 缺 worker-result 的一次重试

统一重试归属：

| 结果 | 责任方 |
|---|---|
| 快速、无 raw event、无 final message | B7 |
| 已排除 B7，exit 0，缺 worker-result | B6 |
| worker-result 存在但缺有效 verdict | 现有 G9 |
| exit 0 缺 worker-result 且属于 verdict role | B6/G9 共用同一个“缺结果重试已用”标记，仅重试一次 |

不得形成“B6 重试一次，再因同一缺失事实让 G9 重试一次”。

B6/G9 后继 job：

- 继承 `chain_id` 和已消费的启动重试预算；
- 不因新 job ID 重置 B7 预算；
- 只有真正结束且不属于启动失败、限流、取消、stall 等故障的审查 attempt，才可能计入 S2。

### 5.3 B1：stall 检测

- B1 处理仍存活但长期无进展的 worker；B7 处理已经结束且过早无输出的 worker。
- 被 B1 主动终止的 worker 即使最终耗时小于 B7 阈值，也保持 `worker_stalled`。
- B1 自身是否允许重试，由其策略决定；B7 不追加第二轮重试。
- 自动重试链的原因选择与预算持久化必须共用，不能在 core、pipeline 和 finalReview 三层分别重试同一次故障。

---

## 6. Pipeline、最终评审与接受守卫

### 6.1 Pipeline 路由

在 `gate()` 中，普通缺结果/G9 分支之前增加明确规则：

| 结果原因 | pipeline state | decision reason | allowed_actions |
|---|---|---|---|
| `launch_failed` | `needs_decision` | `launch_failed` | 有剩余手动 attempt 时仅 `retry`，否则空数组 |
| `prompt_too_large` | `needs_decision` | `prompt_too_large` | 满足既有 retry 条件时仅 `retry`，否则空数组 |

两者均不得：

- 返回 G9；
- 自动切换 fixer；
- 暴露 `accept`；
- 被预算暂停转换成可直接接受的 `job_budget_exhausted` 路径。

人工介入指修复 provider、配置或输入后重试，或使用既有取消/故障处理能力；不是新增一种接受动作。

`preparePipelineResume` 必须重新核实最新 job 的失败类别，不仅信任持久化 `allowed_actions`。旧决策中即使仍包含 `accept`，也不能接受当前启动失败。

### 6.2 最终评审路由

扩展 `finalReview()` 返回及 `final-review.json`，至少新增可选字段：

```ts
{
  round_id?: string;
  reviewed_base_sha?: string;
  reviewed_head_sha?: string;
  failure_reason?: string | null;
  review_completed?: boolean;
}
```

新写入的记录必须填写上述字段；旧记录仍可读取，但不能默认将缺字段解释为已完成审查。

行为：

1. B7 内部重试全部耗尽后，`finalReview()` 立即返回启动失败事实。
2. 不再进入原两次最终评审循环的下一次 job。
3. `run/supervisor` 写入结构化结果后，产生：
   - `state=needs_decision`
   - `reason=launch_failed`
   - `allowed_actions=["retry"]`，前提是预算允许；否则为空。
4. `prompt_too_large` 同理使用独立 reason。
5. 不产生 `final_review_revise`，不提供 `add_fix_task` 或 `accept_final`。

本章扩展已有 run action `retry` 的适用范围：

- 对 `scope=run`、`task_id=null` 且原因是最终评审 `launch_failed/prompt_too_large` 的决策，表示“重新执行最终评审”。
- 对 task-scoped retry 保持现有 pipeline 转发行为。
- 不新增另一套含义重复的 action。
- 显式 retry 创建新执行链、保留旧故障历史、重新校验集成 SHA 和预算。
- 因该故障尚未恢复而出现的预算决策，同样不能提供 `accept_final`。

### 6.3 审查轮次与有效重试

新增结构化 `round_id`，标识同一审查目标：

- 绑定 owner、审查实例、base SHA、target SHA。
- 自动缺结果重试属于同一轮。
- 新增修复任务导致 target SHA 变化后，必须创建新轮。
- 同一 job 内的 B7 execution 不构成新的审查 attempt。

S2 的“至少一次已完成重试”改为：

> 同一轮、同一审查目标中，至少两个不同 job 的有效审查 attempt 已结束，最新结果仍缺 verdict。

以下均不得计入：

- `launch_failed`
- `prompt_too_large`
- rate-limit 中断
- 取消、timeout、stall
- 未完成或结果损坏的 job
- 其他 task、其他 step instance、其他最终评审轮次
- 同一 job 的多个启动 execution

普通慢退出的 `worker_result_missing` 继续属于原缺结果语义，不因没有结构化结果而自动排除；其接受仍须经过完整 S2 守卫。

### 6.4 `accept_final` 守卫

保持 `src/core/verdictAcceptance.ts` 为共用实现，在执行任何接受状态变更前验证：

1. 当前 action、decision ID、scope、task 和 ownership 合法。
2. `final-review.json` 对应当前轮次的最新最终评审 job。
3. job/status/result 与该 run、round、base/target SHA 一致。
4. 结构化结果与摘要一致；缺失或损坏时拒绝，不能猜为“非缺 verdict”。
5. 当前未解决原因属于 `launch_failed/prompt_too_large` 时，**无条件禁止接受**。
6. 对普通 `verdict_missing/worker_result_missing`：
   - 满足有效审查重试要求；
   - `verdict_missing_reviewed===true`；
   - note trim 后非空，长度不超过 2000 字符；
   - 决策者已查看当前目标的 diff 和测试/检查证据，并在 note 记录基准/目标 SHA、证据来源、检查结果或缺失情况、接受理由及残余风险。

第 6 项的证据语义沿用 S2：

- 系统提供并核实结果关联，不能用错误轮次的工件支持接受。
- note 是显式证据声明，不进行自然语言关键词匹配。
- 没有配置测试时必须如实声明，不伪造通过记录。
- 不新增默认填充确认字段，不宣称系统能验证决策者是否真的阅读了证据。

`launch_failed` 的禁接受规则强于普通缺 verdict 的证据例外：即使提供 `true+note`，也不能接受当前未恢复的启动故障。

### 6.5 旧记录与旁路防护

- 旧 `final_review_revise` 决策必须重新读取实际 job 事实。
- 若历史记录足以证明是快速空退出，则按启动失败保护，不重写原始 job。
- 只有 raw 文件为空、缺少可信执行耗时等事实时，不猜测分类；若不能核实有效审查重试，则返回 `verdict_retry_required`。
- 不使用 job 创建到结束的总耗时反推 worker 启动耗时。
- status 可以只读投影安全动作，不因读取 status 改写历史记录。
- CLI prepare、批量 prepare、pending input 消费及最终 apply 前均不能绕过共用检查。
- 拒绝时不消费 decision、不写 resume input/continuation、不写接受审计、不部分应用批量操作。

---

## 7. Prompt 有界化

### 7.1 覆盖范围

强制上限覆盖：

1. 所有 provider 的最终评审 prompt。
2. 所有 Cursor `output=verdict` 的评审 prompt，包括 pipeline、自定义评审 role、review-only 和重试。
3. Cursor adapter 的最终 argv prompt 参数统一兜底；即使调用者漏标 role，也不能发送超过上限的参数。

Cursor 的其他 prompt 若触发 adapter 上限，同样明确返回 `prompt_too_large`，不静默继续。

### 7.2 计量位置

使用：

```ts
Buffer.byteLength(finalPrompt, 'utf8')
```

必须在以下内容全部组装后检查：

- role instructions；
- task/context/constraints；
- orchestrator notes；
- untrusted 包装及 JSON 转义；
- handoff、findings；
- retry notice；
- diff 文件引用和截断标记。

不能使用字符串 `.length`、原始 diff 字节数或 prompt 文件的显示单位代替。

### 7.3 Diff 文件化

将 `assembleFinalReviewPrompt` 的输入从混合 `untrusted` 字符串拆成结构化部分：

- 完整 diff；
- tasks/pipelines 证据；
- diff 工件引用；
- 其他既有上下文。

处理顺序：

1. 在 worker 启动前，生成当前 base/target SHA 的完整 diff 工件。
2. 将其保存至该 review round 自有的证据目录，不能覆盖旧轮次工件。
3. 记录：
   - 路径；
   - base/target SHA；
   - UTF-8 字节数；
   - SHA-256。
4. 首先尝试原完整 prompt；未超限则保持原内容。
5. 超限时缩减**调度器明确标记的内嵌 diff 部分**，保留有界预览与完整文件引用。
6. 必要时将预览缩减到零，仅保留引用。
7. 再次完成全部渲染并按 UTF-8 计数；仍超限则 `prompt_too_large`。

引用必须说明：

> 内嵌 diff 已截断；完整审查必须读取所列 diff 文件，不能仅根据预览作出结论。

文件路径必须 JSON 转义，并位于 untrusted evidence 区；不得将 diff 文件名或 diff 内容解释为调度指令。

不对用户 context 中“看起来像 diff”的任意字符串作正则切割。无法结构化识别或不能安全缩减的非 diff 内容导致超限时，直接失败。

### 7.4 可读性与一致性

- 完整 diff 文件先于 provider 启动存在。
- 文件必须能被当前只读评审执行环境读取。
- 不将证据文件写入被审查 worktree，以免造成只读脏工作区或污染 diff。
- 不通过扩大写权限解决文件读取问题。
- 文件内容必须与记录的 SHA 范围和摘要一致。
- 重试复用同一轮的不可变工件；目标 SHA 改变时创建新工件。
- 预览截断必须落在有效 UTF-8 边界；不得产生乱码、破坏 JSON 或删除最终响应协议。
- 不复用 finalizer 生成的“review job 自身变更 diff”冒充集成 diff：最终评审 job 的 base 已可能是集成 HEAD，其自身 diff 可以为空。

### 7.5 超限失败

无法降到上限内时：

- 不调用 provider spawn；
- job 明确失败为 `prompt_too_large`；
- `worker_exit_code=null`；
- 不触发 B7/B6/G9 自动重试；
- pipeline/run 进入仅可修复后 retry 的暂停状态。

错误 details 仅包含：

```ts
{
  provider: string;
  job_id?: string;
  prompt_bytes: number;
  max_bytes: number;
  diff_externalized: boolean;
}
```

不包含 prompt 正文、diff 正文或完整 argv。

200000 字节是应用级上限，不保证所有操作系统都接受同样长度的单个参数。若操作系统仍拒绝参数长度，必须显式映射为 `prompt_too_large`，不能当作可重复的空启动故障。

---

## 8. 契约、事件、错误码与展示

### 8.1 错误码

| code | exit | retryable | 用途 |
|---|---:|---|---|
| `launch_failed` | 1 | true | worker 快速无输出退出；自动预算耗尽后仍允许受控人工 retry。 |
| `prompt_too_large` | 1 | false | 相同输入不可自动重试，需先修复输入或生成方式。 |
| `verdict_retry_required` | 1 | false | 复用 S2；有效审查重试不足。 |
| `verdict_evidence_required` | 1 | false | 复用 S2；缺确认或有效 note。 |
| `run_state_conflict` / `pipeline_state_conflict` | 1 | false | 禁止接受启动失败、动作不合法或结果关联不一致。 |

`retryable:true` 不代表自动无限重试。启动故障 details 应同时提供 `automatic_retries_exhausted` 和剩余手动恢复条件。

对接受启动故障的拒绝，使用状态冲突码，并令 `details.reason` 为 `launch_failed_not_acceptable`；prompt 故障对应 `prompt_too_large_not_acceptable`。

### 8.2 Job 附加字段

`JobStatus`、`JobResult` 增加可选结构化 execution 摘要，至少表达：

- `chain_id`
- execution 次数
- 已使用启动重试次数
- 自动重试是否耗尽
- 当前/最后 execution 序号及分类
- 最后 worker 耗时
- 当前 `retry_not_before`
- prompt 字节数及上限

详细 execution 历史保存在有校验器的独立记录中，避免 status 无限增长。

新字段必须：

- 有 TypeScript 类型和运行时校验；
- 拒绝负数、非整数计数、非法枚举及不一致组合；
- 对旧记录缺省保持兼容；
- 不改变既有自由字符串 `failure_reason` 的整体兼容性。

### 8.3 `launch_retry` 事件

在 `EVENT_TYPES` 中新增 `launch_retry`。每次已安排的自动启动重试产生一条：

```json
{
  "type": "launch_retry",
  "source": "gbdev",
  "data": {
    "chain_id": "chain-example",
    "provider": "cursor",
    "reason": "launch_failed",
    "failed_execution": 1,
    "next_execution": 2,
    "retry_index": 1,
    "max_retries": 2,
    "delay_ms": 2000,
    "retry_not_before": "2026-10-31T10:00:02.300-07:00",
    "worker_duration_ms": 300,
    "exit_code": 0,
    "raw_events": 0,
    "bytes": 0,
    "has_final_message": false
  }
}
```

约束：

- 事件表示“重试已安排”，不表示下一进程已经启动。
- 取消发生于等待期间时，保留安排事件，但不得伪造下一次启动。
- 恢复时以 `(chain_id, retry_index)` 去重。
- 第三次仍失败后不再产生第三条 `launch_retry`。
- `worker_output` 增加 execution 序号和单次耗时，使空输出证据可关联。
- 不在事件中记录 prompt 正文。

### 8.4 Schema 同步

同步以下类型及对应 schema：

- `error.ts`：新增错误码及 retryable 映射。
- `event.ts`：事件枚举及新事件 data 校验。
- `jobStatus.ts`、`jobResult.ts`：execution 摘要。
- `run.ts`：新增 `launch_failed/prompt_too_large` 决策原因。
- `runResult.ts`：扩展 `final_review` 可选字段。
- `pipelineRun.ts`、pipeline result：保留具体故障与重试投影。
- `notify.ts`：新增原因白名单。

必须同步已提交的：

- `gbdev.run.v1.schema.json`
- `gbdev.run-result.v1.schema.json`

`retry` 已在现有 action 枚举中，不需要因复用它而新增 action schema 值；但 run resume 的 scope/reason 语义校验和测试必须更新。

不修改 worker-result 输出 schema 来承载 scheduler 自身的启动故障。

### 8.5 Status / Dashboard / Notify

**Status / Dashboard**

自动重试中明确展示：

```text
启动失败，等待第 1/2 次自动重试；退避 2s。
```

耗尽后明确展示：

```text
launch_failed：3 次启动均未产生有效评审输出。
当前不能接受最终评审；需修复后 retry 或人工介入。
```

展示 prompt 故障时包含字节数与上限，不展示完整 prompt。

`recommended_action`：

- 有合法 retry：`retry`；
- 无预算或达到原有 attempt 上限：`null`；
- 不将 accept 标为推荐，不展示无效 retry。

**Notify**

- 独立 job：终态通知保留 `reason_code=launch_failed/prompt_too_large`。
- 独立 pipeline：attention 透传具体原因。
- run-owned job/pipeline：沿用现有去重与归属规则，由 run attention 报告故障。
- 摘要明确“评审未完成，需重试”，而不只是泛化“需要决策”。
- `launch_retry` 默认仅为本地事件，不逐次发送 webhook。
- payload 继续不超过 2048 字节；不包含 note、diff、prompt、日志正文。
- `next_step` 继续使用 status 模板，不生成 accept 提示。
- 不修改 `src/notify/http.ts`。

---

## 9. 对旧测试的影响

### 9.1 应保持不变

- 正常 approve/revise/reject 的结果与 findings。
- 已运行但缺 verdict 的 G9 行为，除与 B6 合并重复自动重试外。
- 普通慢退出 `worker_result_missing` 的分类。
- 只读非空 prose 容错。
- S2 的确认字段、note、审计及批量原子性。
- provider argv 的模型与只读约束。
- M7 inspect 的 ownership、预算、取消与通知隔离。

### 9.2 需要定向调整

1. **依赖“快速空输出即缺结果”的 fixture**

   若测试目标是普通 `worker_result_missing`，必须让 fake clock 表达耗时达到阈值，或产生真实 provider 事件。不能全局关闭 B7 来维持旧断言。

2. **S2 最终评审计数测试**

   不能只创建两个 terminal job 就代表已重试；补充同轮次、同目标、有效结束事实。

3. **最终评审自动两次的断言**

   对正常缺 verdict 保持；对启动失败改为一个 job 内三次 execution。

4. **Prompt snapshot**

   小 prompt 不变；大 diff 新增引用模式断言。不能删除旧快照断言来通过测试。

5. **精确事件/枚举/schema 断言**

   增加新事件、新原因及可选字段；旧记录缺字段仍可读取。

6. **恢复与预算测试**

   增加 backoff 中断、重试计数持久化、旧可接受决策被新事实拒绝的用例。

---

## 10. 验收标准与测试计划

### 10.1 AC

| 编号 | 自动验收标准 |
|---|---|
| **AC-B7-1** | fake provider 单次耗时 300ms、exit 0、raw/log 空、无 final message，分类为 `launch_failed`，不产生主因 `worker_result_missing` 或 G9。 |
| **AC-B7-2** | 默认连续失败时恰有 3 次 execution、1 个 job、2 条 `launch_retry`；退避依次 2000ms、8000ms；第三次后无额外启动。 |
| **AC-B7-3** | 注入时钟断言：到期前不启动、到期后才启动；阈值前为空启动失败，恰好阈值及以上不属于 B7；配置上限和非法配置均验证。 |
| **AC-B7-4** | 首次空退出、第二次成功：job 最终成功；不再重试；首次原始证据仍在，最终 result 不带终态启动失败原因。 |
| **AC-B7-5** | 有效 JSON 无末尾换行、快速非空 final message、正常快速 verdict 均不误判为启动失败。 |
| **AC-B7-6** | rate-limit、B1 stall、取消、timeout 与启动失败条件同时出现时，按优先级选择一个责任方；没有双重 retry。 |
| **AC-B7-7** | B6 与 G9 对同一次缺 worker-result 仅共用一次自动重试；后继 job 不重置已消费的 B7 预算。 |
| **AC-B7-8** | backoff 中取消或 deadline 到期后零新增 spawn；恢复不重复消费/重置预算、不重复发同序号事件、不并发启动旧新进程。 |
| **AC-B7-9** | pipeline 启动失败耗尽后停在 `needs_decision/launch_failed`；仅合法 retry 或空动作；不进入 G9、fix 或可接受预算路径。 |
| **AC-B7-10** | 最终评审启动失败耗尽后，run 不产生 `final_review_revise`；不暴露 `accept_final/add_fix_task`；人工 run-scoped retry 能重新评审。 |
| **AC-B7-11** | 直接、批量、pending input 中的 `accept_final` 对启动失败均拒绝，包括 `true+note` 和旧 allowed_actions 含 accept 的记录；拒绝前后持久化状态不变。 |
| **AC-B7-12** | 两个同轮有效缺 verdict attempt 加 `true+有效 note` 可按 S2 接受；缺确认/空 note 被拒；跨轮、限流、启动失败、未完成 attempt 不算重试。已有明确 revise/reject 接受保持不变。 |
| **AC-B7-13** | 至少 650KB 大 diff 构造后，最终 prompt 不超过 200000 UTF-8 字节；含完整 diff 文件引用；文件 hash/字节数/SHA 正确且只读 worker 可读。 |
| **AC-B7-14** | 中文、多字节字符、转义符、retry notice 的最终字节计数准确；非 diff 内容仍超限时 `prompt_too_large`，provider spawn 次数为 0，无自动重试。 |
| **AC-B7-15** | status/dashboard 明确显示启动失败、重试次数与不可接受提示；notify 原因不丢失、归属不重复、payload ≤2048 字节且无正文泄漏。 |
| **AC-B7-16** | 普通慢退出仍为 `worker_result_missing`；旧 v1 记录可读；schema 与运行时类型一致；新测试全部接入 `test/index.ts`。 |

### 10.2 新测试归属

| 文件 | 内容 |
|---|---|
| `test/m8-b7-launch.test.ts` | 分类、时钟、次数、退避、取消、恢复及互斥重试。 |
| `test/m8-b7-final-review.test.ts` | pipeline/run 路由、最终评审 retry、接受守卫、轮次与预算旁路。 |
| `test/m8-b7-prompt.test.ts` | 大 diff 文件化、UTF-8 上界、可读性、adapter 兜底。 |
| `test/m8-b7-contracts-notify.test.ts` | 配置、契约、schema、旧记录、status/dashboard/notify。 |

fake provider 增加快速空退出及按 execution 序号返回结果的场景。测试用例采用注入时钟，不为覆盖 5s 阈值及 2s/8s 退避而真实等待。

### 10.3 定向回归文件

至少覆盖：

- `test/m7-s2-verdict.test.ts`
- `test/m3-s6-final-review.test.ts`
- `test/m3-s4-run.test.ts`
- `test/m3-s4-recovery.test.ts`
- `test/s4-gate.test.ts`
- `test/s4-pipeline.test.ts`
- `test/finalize.test.ts`
- `test/providers.test.ts`
- `test/safety-argv.test.ts`
- `test/m3-s1-contracts.test.ts`
- `test/m6-s1-roles.test.ts`
- `test/m5-s1-notify.test.ts`

测试全部使用 `os.tmpdir()` 下的隔离 HOME、GBDEV 配置目录、临时 git repo、fake provider 和 fake tmux，不启动真实 provider 或真实通知服务。

实施阶段执行顺序：

1. 设置指定 Node PATH：

   ```sh
   export PATH=/Users/alice/.nvm/versions/node/v24.15.0/bin:$PATH
   ```

2. `npm run build`
3. 对上述新增及定向回归文件执行对应的 `node --test dist/test/<file>.test.js`。
4. `npm run typecheck`
5. `node scripts/gen-roles.mjs --check`

不运行完整测试集，不安装依赖。本轮不执行以上命令。

---

## 11. 涉及文件

以下为**实施阶段预计涉及文件**，不是本轮已改动清单。

| 范围 | 文件 | 责任 |
|---|---|---|
| 启动执行 | `src/core/supervise.ts`、`src/core/finalize.ts` | 单次执行事实、分类、内部重试、终态收尾。 |
| 共用策略 | 新增 `src/core/launchRetry.ts`、`src/core/retryPolicy.ts` | 退避、注入时钟、retry-chain 预算与互斥责任。 |
| 配置与时间 | `src/core/config.ts`、`src/core/time.ts` | 配置校验、默认值、时间接口。 |
| Prompt 上界 | 新增 `src/core/promptBudget.ts` | 字节计量、结构化 diff 缩减与引用。 |
| Prompt 接入 | `src/run/finalReview.ts`、`src/run/promptAssembly.ts`、`src/pipeline/prompt.ts`、`src/pipeline/supervisor.ts`、`src/run/jobs.ts` | 完整组装后的预算检查及证据文件化。 |
| Provider | `src/providers/cursor.ts`、`src/providers/types.ts`、`src/providers/jsonOutput.ts` | argv 上限兜底、单次输出解析及必要上下文。 |
| Pipeline 控制 | `src/pipeline/gate.ts`、`src/pipeline/resume.ts`、`src/pipeline/reconcile.ts` | 独立故障暂停、禁止接受、恢复。 |
| Run 控制 | `src/run/supervisor.ts`、`src/run/decisions.ts`、`src/run/result.ts`、`src/run/reconcile.ts` | 保留最终评审故障、run-scoped retry、结果与恢复。 |
| 接受保护 | `src/core/verdictAcceptance.ts` | 同轮有效重试计数、结果绑定、启动失败硬拒绝。 |
| 契约 | `src/contracts/{error,event,jobStatus,jobResult,pipelineRun,pipelineResult,run,runResume,runResult,notify}.ts` | 新字段、错误、原因、验证。 |
| JSON schema | `src/contracts/gbdev.run.v1.schema.json`、`src/contracts/gbdev.run-result.v1.schema.json` | 与运行时 schema 同步。 |
| 展示 | `src/render/gbdevEvents.ts`、`src/render/job.ts`、`src/render/views/{pipeline,runStatus}.ts`、相关 status 投影 | 重试过程、明确失败原因与合法动作。 |
| 通知 | `src/notify/filter.ts`、`src/notify/payload.ts` | 原因透传及有界摘要。 |
| 测试 | 上述四个 B7 新测试、相关 fixture/helper、`test/index.ts` | AC 与回归。 |
| 文档 | 调度方指定的 M8 SPEC 文件 | 合入本章，避免覆盖其他会话改动。 |

`src/notify/http.ts` 不在允许修改范围内。角色生成文件仅在实际调整共享提示片段时同步生成，不手改生成产物。

---

## 12. 风险与控制

| 风险 | 控制 |
|---|---|
| 将正常快速完成误判为启动失败 | 同时要求无 raw event、无可解析事件、无非空 final message；覆盖无末尾换行 JSON。 |
| 进程耗时被排队/收尾时间污染 | 使用每次 spawn→close 的单调时间，保留 job 总耗时原语义。 |
| B7、B6、G9、rate-limit 叠加放大重试 | 单一责任分类、共享链 ID 和预算；同一结果只有一个 retry owner。 |
| 自动重试掩盖副作用 | 每次重启前检查只读/策略事实；发现修改即停止自动重试。 |
| 恢复造成重复启动 | 先持久化重试计划，验证旧进程退出，按链 ID/序号去重。 |
| 旧终态 job 被当作有效审查 | 按轮次、目标 SHA、结果关联及失败类别筛选；证据不足则要求重试。 |
| 超大 diff 文件化后 worker 无法读取 | 启动前建立完整工件；用真实只读执行形态的 fake-provider 集成测试验证路径可读，不扩大写权限。 |
| Prompt 截断改变任务语义 | 只缩减显式 diff 证据；保留完整文件、协议和可信指令；非 diff 超限明确失败。 |
| 200KB 仍遇到系统参数限制 | adapter 预检加系统参数长度错误映射；不宣称应用上限等于平台保证。 |
| 通知用词混淆“需人工处理”和“可接受” | 固定摘要明确评审未完成，next_step 仅指向 status。 |
| 保留租约的 backoff 降低吞吐 | 延迟有上限、可取消并受原 deadline 控制；本切片不引入额外租约状态机。 |

---

## 13. 本轮交付状态

- **实际改动文件：0 个。**
- **实现要点：**本章已确定快速空退出分类、同 job 启动退避、跨重试责任去重、最终评审故障隔离、S2 接受守卫补强及 200000 字节 prompt 上界。
- **定向测试执行：0 个；通过数：0 个；失败数：0 个。** 本轮按只读要求未运行测试，以上数字不代表实现已通过验证。
- **Build/typecheck/生成一致性检查执行：0 次。**
- **未完成项：**代码实施及本章 AC 验证，均属于后续实施轮；Cursor 超大 argv 静默退出的内部原因未获独立证明，不阻碍本规格实施。

## open_questions

```yaml
open_questions: []
```