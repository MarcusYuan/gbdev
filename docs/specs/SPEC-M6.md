> Historical design specification. Milestone labels describe design evolution; consult README.md and docs/reference.md for current behavior. Private execution records are not release certification.

# gbdev M6 规格：每 bot 独立 GBDEV_HOME、共享 CLI 启动器、仓库内 skill、角色与提示词目录

> 版本：v1（2026-10-30）
> 基线：master `8b01a75`（M5 已合入）
> 分支：`gbdev-m6-tooling`
> 状态：已获 user 批准范围；本文所有决策均已定。
> M6 开发分工（仅限本里程碑的开发循环）：**Cursor（`--model auto`）实现，Codex（`gpt-6-astra`，high，read-only）审查**。产品内置默认（Codex executor、Cursor reviewer）不变。

本文没有留给实现者的「可选项」。实现中如发现与代码事实冲突，按本文意图取最小改动实现，并在 final 报告的 open_questions 里报告，不得自行扩大范围。

## 0. 实现边界（硬规则，全部继承 M1–M5，不得放宽）

1. 运行时零依赖；Node 24；`node:test`；`contract_version` 仍为 `"1"`；新增 schema 只加不改。
2. 不修改 user 的 shell rc 文件（`~/.zshrc`、`~/.zprofile`、`~/.bashrc`、`~/.profile` 等），任何命令只**打印** PATH 行。
3. 不读写 `~/.gbdev` 的 notify 配置与状态（只允许 `gbdev init` **只读**读取 `~/.gbdev/notify/state.json` 的 `verified_by_bot` 字段判断旧绑定）；不读任何 notify 秘密文件；不打印 `~/.cursor/mcp.json` 等任何秘密。
4. 默认 home（`~/.gbdev`，绑定 bot `my-bot`）及未设置 `GBDEV_HOME`/`GBDEV_CONFIG` 时的全部既有行为逐字不变。
5. Cursor 一律 `--model auto`；任何角色、生成器、测试都拒绝 `cursor_model ≠ "auto"`（`cursor_model_not_allowed`）。
6. 禁止字面量 `--dangerously-bypass-approvals-and-sandbox`、`--sandbox disabled`、`shell: true` 出现在新代码与新文档的可执行示例中（文档只允许在「禁止」语境出现，沿用 M5 docs 测试规则）。
7. 测试只用 `os.tmpdir()` 下的临时目录，通过 `HOME`、`GBDEV_HOME`、`GBDEV_CONFIG`、`GBDEV_CLI_HOME` 隔离；默认套件不触碰真实 `~/.gbdev*`、`~/.gbdev-cli`、`~/.config`，不联网，不调用真实 codex/cursor-agent。
8. 不引入编译二进制（Node SEA 推迟到 M7 之后评估）。

## 1. 目标与非目标

### 1.1 目标

- G1 **Step 0 先建本 bot 的 GBDEV_HOME**：`gbdev init --bot <label>` 幂等地为每个 bot 建立 `~/.gbdev-<label>`（或识别旧的默认 home），登记绑定、生成 bot 专用启动器，然后才进入 M5 的 webhook 初始化（`notify status` 的 `init`）。
- G2 **skill 唯一真相在仓库**：`skills/gbdev-usage/SKILL.md`；docs 测试保证 skill 提到的每个 gbdev 命令真实存在，且 skill 与 `docs/controller-recipe.md` 在关键规则上不矛盾。
- G3 **共享 CLI 启动器** `~/.gbdev-cli/bin/gbdev`：`gbdev install` 写出固定 Node 24 绝对路径与仓库 `dist/cli.js` 的小脚本；`gbdev doctor` 报告是否安装、是否最新。
- G4 **角色与提示词目录**：所有专家角色与散落在代码中的提示词集中到仓库 `roles/`，构建时打包进 dist，行为与提示词逐字不变（快照测试）。

### 1.2 非目标

- 不做 Node SEA / 单文件二进制；不做 Homebrew/npm 全局发布。
- 不改 `gbdev roles list/show` 的输出结构；不新增角色；不改任何提示词文字（M6 只搬家）。
- 不改 dashboard `watch_hint`/`attach_hint` 文本（非默认 home 由 skill 指导使用 bot 启动器，见 §8.3）。
- 不迁移或合并已有 home（`/tmp/gbdev-smoke` 等保持原样）；不自动删除任何 home。
- 不同步 `allowed_repos` 等配置：bot home 的 config 在 init 时从全局 config 播种一次，此后各自独立（接受分叉，见 N6）。
- 不在仓库内修改 controller 侧已部署的 skill；部署由 controller 在 M6 合入后、经 user 同意执行。
- 不改 launchd、不做登录自启。

## 2. 背景与现状（代码事实，master `8b01a75`）

| 事实 | 出处 | 意义 |
|---|---|---|
| `GBDEV_HOME` 默认 `~/.gbdev`，`GBDEV_CONFIG` 默认 `~/.config/gbdev/config.json` | `src/core/paths.ts` `resolvePaths` | 多个 bot 不设置 env 时共享同一 home 与 config |
| 用户角色/模板目录为 `dirname(config)/roles`、`dirname(config)/pipelines` | `src/roles/registry.ts`、pipeline registry | config 位置决定覆盖目录 |
| `notify enable/disable/setup` 写 `paths.config` 的 `notify` 键 | `src/commands/notify.ts` | 第二个 bot 在共享 config 上 enable 会改掉 `~/.gbdev` 的通知配置——禁止 |
| 秘密文件默认 `~/.config/gbdev/notify/<h12>.secret.json`，h12 = realpath(GBDEV_HOME) 的 sha256 前 12 位 | `src/notify/secret.ts` | 秘密天然按 home 隔离 |
| `~/.gbdev/notify/state.json` 的 `verified_by_bot = "my-bot"`；`~/.gbdev/config.json` 不存在 | Mac 现状 | 旧绑定可识别；home 内 config 规则不影响默认 home |
| Mac 上 `~/.gbdev-cli` 不存在；`~/.config/gbdev/` 只有 `config.json` 与 `notify/`，无 `roles/`、`pipelines/` | Mac 现状 | 启动器全新；当前无用户角色覆盖 |
| 6 个内置角色 + `code-reviewer` 别名，指令写在 `src/roles/builtin.ts` 的数组里 | `builtin.ts`、`registry.ts` | 角色内容散在代码 |
| 公共提示片段在 `src/core/prompt.ts`（`renderPrompt`、`renderWorkerBoundaries`、`renderFinalResponse`、`VERDICT_RETRY_NOTICE`、`renderOrchestratorNotes`）与 `src/pipeline/prompt.ts`（`DATA_NOTICE`、`renderUntrustedData`、`renderDecisions`、`renderPriorSteps`、`renderStepPrompt`）；planner/finalReview/conflicts/run 也拼接提示文字 | 各文件 | 需集中管理且逐字保持 |
| `dist/` 被 `.gitignore`；构建为 `tsc` | `package.json` | 打包进 dist 只能通过生成的 TS 模块 |

## 3. 关键决策（均已定）

| # | 决策 | 理由 |
|---|---|---|
| N1 | 每 bot 一个 home：`~/.gbdev-<label>`；`<label>` 为规范化后的 bot_label（§6.2） | 一个 home 一个 bot（M5 规则）落到默认路径上 |
| N2 | 旧绑定兼容：若默认 home 的 `notify/state.json` 中 `verified_by_bot` 等于该 label，init 选择 `~/.gbdev` 并以 `legacy_default=true` 返回，**不在其中写任何文件** | my-bot 保持原样工作 |
| N3 | **home 内 config**：未设置 `GBDEV_CONFIG` 且 `<GBDEV_HOME>/config/config.json` 存在（lstat 为普通文件）时，`resolvePaths` 使用它；否则沿用全局默认 | 每个 bot 的 `notify enable` 只写自己的 config，绝不改到 `~/.gbdev` 的；默认 home 无此文件，行为不变 |
| N4 | home config 放在 `<home>/config/` 子目录而不是 `<home>/config.json` | `dirname(config)/pipelines` 会与 run 数据目录 `<home>/pipelines/` 重叠；子目录让 `roles/`、`pipelines/` 覆盖目录落在 `<home>/config/` 下 |
| N5 | init 播种 home config：读取当前全局 config（`GBDEV_CONFIG` 或默认路径，经 `validateConfig`），**去掉 `notify` 键**后写入（0600）；全局不存在则写 `{"version":1}`；已存在则永不覆盖 | 新 bot 继承 allowed_repos 等，但通知从未配置态开始 |
| N6 | 播种后各 home config 独立，不做同步 | 简单可预期；文档说明修改 allowed_repos 需对各 home 执行 |
| N7 | init 拒绝在默认 home 创建 `config/`、`home.json` 或任何文件 | 边界 0.3/0.4 |
| N8 | 绑定文件 `<home>/home.json`（`gbdev.home.v1`）；已有且 label 不同 ⇒ `home_conflict`，不改写 | 一个 home 一个 bot |
| N9 | 目标目录已存在、非空且无 `home.json`（如 `/tmp/gbdev-smoke`、`/tmp/gbdev-example`）⇒ `home_conflict`；保留 label：`cli`、`bootstrap` | 不劫持已有目录 |
| N10 | 共享启动器 `~/.gbdev-cli/bin/gbdev` 是 `/bin/sh` 小脚本，固定 `process.execPath`（必须 Node ≥ 24）与 realpath 的 `dist/cli.js`；不是二进制 | 不依赖 nvm/PATH 状态；SEA 推迟 |
| N11 | 每 bot 启动器 `~/.gbdev-cli/bin/gbdev-<label>`：`unset GBDEV_CONFIG`、`export GBDEV_HOME=<home>` 后 exec 共享启动器 | bot 忘记 env 前缀也不会打到别人的 home；detached supervisor 继承 env |
| N12 | 启动器目录可由 `GBDEV_CLI_HOME` 覆盖（测试用），默认 `~/.gbdev-cli` | 测试隔离 |
| N13 | 写启动器：原子替换（同目录临时文件 + rename），mode 0755，目录 0755；无 marker 的同名文件/符号链接/目录 ⇒ `launcher_conflict`，没有 `--force` | 不覆盖用户自己的文件 |
| N14 | 永不修改 shell rc；返回 `path_hint` 与 `on_path` | 边界 0.2 |
| N15 | doctor 新增 `launcher` 检查：`missing/current/stale/foreign`，仅 `current` 为 ok；新增 `home` 检查报告绑定。两者都**不阻塞派活** | 可观察但不改变既有派活规则 |
| N16 | init 默认在启动器缺失或过期时自动安装（`--no-install` 关闭）；Step 0 依赖这一点 | Approved scope：Step 0 自动安装 |
| N17 | 角色源目录 `roles/<name>/role.json` + `roles/<name>/prompt.md`；公共片段在 `roles/_shared/` | 一处可读、可审 |
| N18 | `scripts/gen-roles.mjs`（零依赖）把 `roles/` 生成为**提交入库**的 `src/roles/catalog.generated.ts`；`npm run build` = `node scripts/gen-roles.mjs && tsc`；测试断言生成文件与目录一致 | dist 被 gitignore，只能经 TS 模块打包；运行时不读仓库目录，行为稳定 |
| N19 | 提示词快照在**重构前**从 master 代码捕获，存 `test/fixtures/m6-prompts.snapshot.json`，之后只读 | 证明逐字不变 |
| N21 | 新错误码 `home_conflict`（不可重试）、`launcher_conflict`（不可重试）；非法 label 用 `usage_error` | 最小新增 |
| N22 | 新命令 `init`、`install` 加入 `COMMANDS` 与 HELP；都支持 `--json`（M1 信封）与 `--dry-run` | 与既有命令一致 |

## 4. 用户故事

- U1 新 bot（如 `example-dev`）第一次用 gbdev：执行 `gbdev init --bot example-dev --json` ⇒ 得到 `~/.gbdev-example-dev`、`~/.gbdev-cli/bin/gbdev-example-dev`，此后所有命令用该启动器；webhook 初始化按 M5 Step 0 继续，写入的是该 home 的 config。
- U2 my-bot 执行同样的 Step 0：init 识别旧绑定，返回 `~/.gbdev`，`legacy_default=true`，零写入；继续用 `gbdev`。
- U3 user 在终端看 bot 的 run：`gbdev-example-dev run watch <id>`（skill 告诉 bot 转述时用 bot 启动器名）。
- U4 维护者改某个角色的提示：只改 `roles/<name>/prompt.md`，`npm run build`，快照测试按预期失败并需在同一提交中显式更新快照（M6 期间不允许）。

## 5. 角色与提示词目录（S1）

### 5.1 布局

```
roles/
  README.md                 # 中文：格式说明、如何修改、快照规则
  planner/role.json  planner/prompt.md
  executor/…  fixer/…  reviewer/…  verifier/…  resolver/…
  _shared/fragments.json    # 片段索引
  _shared/<fragment>.md     # 公共提示片段
```

### 5.2 `role.json`（`gbdev.role-source.v1`，闭合 schema）

```json
{
  "schema": "gbdev.role-source.v1",
  "name": "reviewer",
  "description": "<与现 builtin description 逐字相同>",
  "purpose": "中文：这个专家做什么、何时被谁调用",
  "provider": "cursor",
  "mode": "read-only",
  "output": "verdict",
  "allowed_providers": ["cursor", "codex", "fake"],
  "codex_model": null,
  "cursor_model": "auto",
  "default_timeout_min": 40,
  "default_stall_timeout_s": 900,
  "prompt": "prompt.md",
  "aliases": ["code-reviewer"],
  "used_by": ["internal:final_review", "builtin pipeline review steps"]
}
```

- `mode` 由 `output` 推导并必须一致：`change ⇒ workspace-write`，其他 ⇒ `read-only`；不一致 ⇒ 生成器失败。
- `name` 必须等于目录名；`prompt` 只能是 `prompt.md`。
- `purpose`、`used_by`、`aliases` 只用于文档/展示与别名表，不进入 `Role` 对象（`roles list/show` 输出不变）；别名表由 `aliases` 生成，替代 `registry.ts` 的硬编码，结果相同。
- 字段值必须与 master 的 `builtinRoles()` 完全一致（AC-2）。

### 5.3 `prompt.md`

- 文件内容 = 该角色 `instructions` 数组逐行，以 `\n` 连接，末尾恰好一个 `\n`；加载为 `content.slice(0,-1).split('\n')`；任何空行或 `\r` ⇒ 生成器失败。

### 5.4 公共片段 `roles/_shared/`

`fragments.json`（`gbdev.prompt-fragments.v1`）列出每个片段：`id`、`file`、`placeholders`（`{{name}}` 列表，可空）、`used_by`（函数名）。至少包括：

| id | 来源（现代码） |
|---|---|
| `worker-boundaries` / `worker-boundaries-write` / `worker-boundaries-readonly` | `renderWorkerBoundaries` 公共部分与两个条件尾部 |
| `final-response` 及 verdict 附加部分 | `renderFinalResponse` |
| `verdict-retry-notice` | `VERDICT_RETRY_NOTICE` |
| `orchestrator-notes` | `renderOrchestratorNotes` 固定文字 |
| `untrusted-data-notice` | `DATA_NOTICE` |
| `decisions-header` | `renderDecisions` 标题文字 |
| planner / final review / conflicts / run 内部提示中的静态段落 | `planner.ts`、`finalReview.ts`、`conflicts.ts`、`commands/run.ts` 等 |

规则：只搬**静态文字**；动态拼接逻辑留在代码中，代码按原位置取片段并做 `{{placeholder}}` 简单替换（未声明的占位符或未使用的声明 ⇒ 生成器失败）。实现者用 `rg` 全仓搜索提示性字符串，确保没有遗漏的静态提示段（在 final 中列出搬迁清单与刻意保留在代码中的项及理由）。

### 5.5 生成与加载

- `scripts/gen-roles.mjs`：读取 `roles/`，校验（闭合 schema、`cursor_model === "auto"`、mode/output 一致、resolver 的 `allowed_providers` 不含 cursor、占位符一致），输出确定性的 `src/roles/catalog.generated.ts`（`ROLE_SOURCES`、`ROLE_ALIASES`、`PROMPT_FRAGMENTS`，含 `// GENERATED by scripts/gen-roles.mjs — do not edit` 头）。`--check` 模式只比较不写，差异则退出 1。
- `package.json`：`build` = `node scripts/gen-roles.mjs && tsc`；新增 `gen:roles`；`test` 的首个 `tsc` 前同样先运行生成器。
- `builtin.ts` 改为从 `ROLE_SOURCES` 构造 `Role[]`（保留 `builtinRoles()` 导出签名）；`validateRole` 不变（仍拒绝非 auto）。用户覆盖目录（`dirname(config)/roles/*.json`）逻辑不变。

### 5.6 快照（N19）

- 先在未改动的代码上写 `scripts/m6-prompt-snapshot.mjs`（从 `dist/` 导入），生成 `test/fixtures/m6-prompts.snapshot.json`，内容：`builtinRoles()` 全量；`roles list --json` 与每个角色 `roles show <name> --json` 的 result（含别名 `code-reviewer`）；以下固定输入矩阵的渲染文本：`renderPrompt`（write/read-only × verdict 有/无 × extraFields 有/无 × orchestrator notes 有/无）、`renderStepPrompt`（含 prior steps、decisions、untrusted data）、planner/final review/conflict/integration-fix/final-fix 内部提示（用测试已有的 fake 输入）。
- 测试 `test/m6-s1-roles.test.ts` 用同一脚本逻辑在新代码上重算并 `deepStrictEqual` 快照。
- patrol 复核时在 master `8b01a75` 的临时 worktree 上重新运行快照脚本，确认快照确实来自旧代码（见 M6-NOTES）。

## 6. `gbdev init`（S3）

### 6.1 语法

`gbdev init --bot <label> [--home <path>] [--no-install] [--dry-run] [--json]`

### 6.2 label 规范化

输入 → 小写 → `[^a-z0-9-]+` 替换为 `-` → 连续 `-` 合并 → 去掉开头的非字母字符与结尾的 `-` → 截断到 32 字符后再去尾部 `-` → 必须匹配 `^[a-z][a-z0-9-]{0,31}$`（与 M5 `NOTIFY_LABEL` 同一常量），且不是保留字 `cli`、`bootstrap`；否则 `usage_error`。返回 `bot_label`（规范化后）与 `bot_label_input`。之后的 `notify ack --bot` 等一律使用规范化后的值。

### 6.3 home 解析（按顺序，先命中先用）

1. `--home <path>`：允许 `~` 展开，必须为绝对路径。若等于默认 home（realpath 比较，目录不存在时比较规范化路径）：按 2 的旧绑定规则处理；默认 home 已绑定其他 label ⇒ `home_conflict`；未绑定 ⇒ `legacy_default=true`，零写入，`next_steps` 含 `notify_init`。
2. 默认 home 的 `notify/state.json` 可读且 `verified_by_bot === bot_label` ⇒ 默认 home，`legacy_default=true`，零写入。
3. 否则 `~/.gbdev-<bot_label>`。

环境中已有的 `GBDEV_HOME` **不**参与 init 的解析（init 的输出就是该 bot 以后要用的 home）；`GBDEV_CONFIG` 只作为播种源。

### 6.4 非默认 home 的创建（幂等）

1. 目录不存在 ⇒ 创建（0700）；存在且非空且无 `home.json` ⇒ `home_conflict`；存在 `home.json` 但 label 不同或 schema 非法 ⇒ `home_conflict`（details 含 `bound_bot_label`，非法时为 null）。
2. 写 `home.json`（若缺失）：`{"schema":"gbdev.home.v1","bot_label":"…","home":"<realpath>","home_id":"<h12>","created_at":"<ISO>","gbdev_version":"…"}`，0600，原子写。已存在且一致 ⇒ 不改写（`created_at` 不变）。
3. `config/` 目录（0700）与 `config/config.json`（N5 播种，0600），已存在则不动。全局 config 非法 ⇒ `config_invalid`，不创建任何东西。
4. 启动器（除非 `--no-install`）：同 `gbdev install` 的逻辑（§7），然后写每 bot 启动器 `gbdev-<label>`（§7.3）。legacy 默认 home 也写 `gbdev-<label>`（它设置 `GBDEV_HOME=~/.gbdev`），因为它在 `~/.gbdev-cli` 内而非 home 内。
5. 以该 home 计算 notify 状态（复用 `notify status` 的 init 计算，**不**发请求，不读秘密内容——与 `notify status` 相同的只读检查）。

`--dry-run`：只计算并返回将要执行的动作（`action` 为 `would_create`/`would_update`/`unchanged`），不写任何文件。

### 6.5 结果 `gbdev.init.v1`

```json
{
  "schema": "gbdev.init.v1",
  "bot_label": "example-dev",
  "bot_label_input": "Example Dev",
  "home": "/Users/alice/.gbdev-example-dev",
  "home_id": "a1b2c3d4e5f6",
  "legacy_default": false,
  "home_action": "created",
  "binding": { "path": "<home>/home.json", "action": "created" },
  "config": { "path": "<home>/config/config.json", "action": "created", "seeded_from": "/Users/alice/.config/gbdev/config.json" },
  "launcher": { "path": "~/.gbdev-cli/bin/gbdev", "state_before": "missing", "action": "created", "on_path": false, "path_hint": "export PATH=\"$HOME/.gbdev-cli/bin:$PATH\"" },
  "bot_launcher": { "path": "~/.gbdev-cli/bin/gbdev-example-dev", "action": "created" },
  "command": "/Users/alice/.gbdev-cli/bin/gbdev-example-dev",
  "env": { "GBDEV_HOME": "/Users/alice/.gbdev-example-dev" },
  "notify": { "enabled": false, "state": "not_configured", "missing_step": "setup_secret", "verified_by_bot": null },
  "next_steps": ["add_path", "notify_init"],
  "dry_run": false
}
```

- 路径字段输出绝对路径（上例的 `~` 仅为示意）；`command` 为 bot 启动器绝对路径；legacy 时 `home_action`/`binding.action`/`config.action` 为 `"none"`，`config.path` 为实际生效的全局 config 路径，`seeded_from` 为 null。
- `notify` 对象字段与 `notify status` 的 `init` 对象同名同义（值域照搬 §9.5 of SPEC-M5）。
- `next_steps` 枚举（按此顺序，去重）：`install_launcher`（`--no-install` 且启动器非 current）、`add_path`（启动器目录不在 PATH）、`notify_init`（`notify.state !== "verified"` 或 `verified_by_bot !== bot_label`）；全部满足时为 `[]`。
- 输出中绝不含 URL、密钥、秘密文件内容。
- 人读输出（无 `--json`）：home、command、path_hint（若需要）、notify 状态与下一步，一行一项。

### 6.6 错误

`usage_error`（缺 `--bot`、label 非法、`--home` 非绝对）、`home_conflict`、`launcher_conflict`、`config_invalid`；全部为 M1 错误信封，退出码按既有映射（新码按 usage/conflict 类归入不可重试）。

## 7. `gbdev install` 与启动器（S2）

### 7.1 语法与结果

`gbdev install [--dry-run] [--json]` ⇒ `gbdev.install.v1`：

```json
{ "schema": "gbdev.install.v1", "launcher_dir": "/Users/alice/.gbdev-cli/bin", "launcher_path": "/Users/alice/.gbdev-cli/bin/gbdev",
  "node_path": "/Users/alice/.nvm/versions/node/v24.15.0/bin/node", "cli_path": "/path/to/gbdev/dist/cli.js",
  "version": "<package.json version>", "state_before": "missing", "action": "created", "on_path": false,
  "path_hint": "export PATH=\"$HOME/.gbdev-cli/bin:$PATH\"", "dry_run": false }
```

`state_before ∈ {missing,current,stale,foreign}`；`action ∈ {created,updated,unchanged,would_create,would_update}`。foreign ⇒ 错误 `launcher_conflict`（details：`path`）。`process.versions.node` 主版本 < 24 ⇒ `config_invalid`（message 说明需要 Node 24）。`node_path` 或 `cli_path` 含 `'`、换行或控制字符 ⇒ `config_invalid`。`on_path`：`PATH` 中某项 realpath 等于 `launcher_dir` realpath。

### 7.2 共享启动器内容（逐字格式，`gbdev.launcher.v1`）

```sh
#!/bin/sh
# gbdev.launcher.v1 — generated by `gbdev install`; do not edit
# node: <node_path>
# cli: <cli_path>
# version: <version>
exec '<node_path>' '<cli_path>' "$@"
```

- `current` = 文件为普通文件、首两行匹配 marker、内容与本次将生成的内容逐字相同、mode 含 owner 执行位；`stale` = 有 marker 但内容不同（Node 路径、仓库路径或版本变了）；`foreign` = 存在但无 marker（含符号链接、目录）。
- 启动器目录不存在则创建（0755）。

### 7.3 每 bot 启动器（`gbdev-<label>`）

```sh
#!/bin/sh
# gbdev.launcher.v1 bot=<label> — generated by `gbdev init`; do not edit
unset GBDEV_CONFIG
GBDEV_HOME='<home>'; export GBDEV_HOME
exec '<launcher_dir>/gbdev' "$@"
```

同样的 current/stale/foreign 规则与原子写；只由 `init` 写。

### 7.4 doctor

- 新检查 `launcher`（追加在现有检查之后）：`{ name:"launcher", ok: state==="current", detail:"<state>: <path>", launcher:{ state, path, on_path, node_path, cli_path } }`；`DoctorResult` 的 check 新增可选字段 `launcher`（契约只加不改）。
- 新检查 `home`：`ok:true`，detail 为 `default`（默认 home）、`bound:<label>`（有合法 home.json）或 `unbound`；home.json 非法或与 home realpath 不符 ⇒ `ok:false`。
- `config` 检查 detail 中附带实际生效的 config 来源：`env`、`home`、`default`。
- 两项新检查不改变任何派活规则：skill 中「doctor 非 notify 失败项」规则把 `launcher`、`home` 也列为非阻塞（launcher 失败时 Step 0 自动修复）。

## 8. `resolvePaths` 与 GBDEV_HOME 规则（S3）

### 8.1 config 解析

`GBDEV_CONFIG`（若设置）> `<GBDEV_HOME>/config/config.json`（存在且 lstat 为普通文件）> `~/.config/gbdev/config.json`。新增 `paths.configSource ∈ {env, home, default}`。默认 home 下无 `config/` ⇒ 结果与 master 相同（AC-20 固定）。

### 8.2 影响面

- `notify enable/disable/setup` 写 `paths.config` ⇒ 自动写到 bot 的 home config；秘密文件路径规则不变（已按 home 隔离）。
- 用户角色/模板覆盖目录随之为 `<home>/config/roles`、`<home>/config/pipelines`。
- tmux 会话：非默认 home 已是 `gbdev-<h6>`，不变。

### 8.3 bot 侧使用规则（写入 skill）

- 每次使用前 Step 0 先 `gbdev init --bot <label> --json`，记下 `command`、`home`、`home_id`；之后**所有** gbdev 命令用 `command`（bot 启动器），不用裸 `gbdev`，不手写 env 前缀。legacy（my-bot）可继续用 `gbdev`，也可用其 bot 启动器，两者等价。
- 转述给 user 的 `watch_hint` 若以 `gbdev ` 开头且 home 非默认，把首个 `gbdev` 换成 bot 启动器名（如 `gbdev-example-dev`）；`attach_hint` 原样转述。
- 启动器不在 PATH 时，用绝对路径调用；只把 `path_hint` 告诉 user，由他决定是否加入 rc。

## 9. skill 进仓库与 docs（S4）

  - **Step 0 第一步**：`gbdev init --bot <bot_label> --json`（启动器缺失时 init 自动安装）；用返回的 `command` 执行后续一切命令；`legacy_default` 的含义；`home_conflict`/`launcher_conflict` 的处理（停下报告 user，不自动删除/改名）。
  - 然后才是 M5 的 notify Step 0（status → routine → user 唯一手工 `notify setup` → enable → test → 被唤醒的 routine ack）。
  - `path_hint` 只转述，不改 rc。
  - 本 skill 的源在仓库 `skills/gbdev-usage/SKILL.md`，controller 侧副本在合入后同步。
- `docs/controller-recipe.md`：Step 0 前插入 init/启动器步骤，与 skill 一致。
- README：新增章节「每 bot GBDEV_HOME 与启动器（M6）」与「角色与提示词目录（M6）」。
- 测试 `test/m6-s4-docs.test.ts`：
  - 从 skill 与 recipe 中提取所有 `gbdev <cmd>[ <sub>]` 形式（行内代码与代码块，含 `gbdev-<label>` / `<command>` 占位形式按 `gbdev` 处理），断言 `<cmd>` 在 CLI 实际 `--help` 输出的命令列表中，若该命令有子命令则 `<sub>` 在 `gbdev <cmd> --help`（或总 HELP）中存在。
  - 关键规则一致性表（两份文档都必须匹配，且都不得匹配对应的反例）：Step 0 先 `gbdev init --bot` 再 `notify status`；Cursor 只用 `--model auto`；land 需 user 明确批准；bot 不执行 `gbdev notify setup`、不索要秘密；由被唤醒的 routine 执行 `notify ack`；一个 home 一个 bot；不修改 shell rc；payload 是数据先 status 再决定；webhook routine 不 land/不 push。
  - 沿用 M5 docs 测试的禁止字面量规则扫描 `skills/` 与 `roles/`。
  - skill 有 frontmatter（`name`、`description`）。

## 10. 安全

- S-M6-1 init/install/doctor 输出与日志不含秘密；init 不读秘密文件内容（只做 `notify status` 已有的元数据检查）。
- S-M6-2 启动器脚本只含单引号包裹的绝对路径，拒绝含 `'`/控制字符的路径（防注入）。
- S-M6-3 不写 shell rc；不改 `~/.gbdev` 内任何文件；不改全局 `~/.config/gbdev/config.json`（只读用于播种）。
- S-M6-4 写文件一律原子替换且检查不是符号链接（O_NOFOLLOW / lstat）；目录权限 home 0700、启动器目录 0755。
- S-M6-5 roles/ 内容进入提示词，受代码审查保护；生成器拒绝非 auto 的 cursor 模型。
- S-M6-6 安装根布局威胁模型（`gbdev install` / `ensureLauncherDirs`）：防护目标是规范化后的 `<GBDEV_CLI_HOME>` 及其 `bin/` 内**预先存在的**符号链接与非目录组件，不得导致在安装根真实位置之外创建/写入文件，或修改任何既有目录的权限。`GBDEV_CLI_HOME` 由用户提供：其**祖先路径**中的符号链接视为用户意图——只对安装根的**父路径**做「最深已存在祖先 `realpath` + 拼接剩余尚不存在的后缀」，再拼回安装根 basename；**安装根最后一级不跟随链接**（预先存在的链接或非目录 ⇒ `launcher_conflict`）。之后一切检查、创建与结果路径（`launcher_dir` / `launcher_path`）均基于该规范化路径。从锚点起对 `cliHome` 剩余组件与 `bin` 逐级 `lstat`：已存在的组件必须是真实目录（非链接）；链接或非目录（含 `ENOTDIR`，且对 `ENOENT`/`ENOTDIR` 持续逐级回退到真实阻塞组件）⇒ `launcher_conflict`（`details.path` 指向出问题的那一级）。目录创建不使用 recursive `mkdir`：逐级非递归 `mkdir`，只对**本调用新建**且经 `lstat` 复核仍为真实目录的路径 `chmod 0755`；临时启动器文件权限用仍打开的 fd `fchmod`；`rename` 前复核 `bin` 的 `(dev,ino)`。与当前用户同权限、在检查与写入之间并发替换路径的攻击者不在威胁模型内（同用户本可直接写这些位置）；上述复核只做低成本收窄，残余竞态在代码注释中说明。

## 11. 测试（默认套件不碰真实环境）

- `test/m6-s1-roles.test.ts`：生成器校验与确定性、`--check` 漂移、快照、registry 一致、cursor auto、resolver 禁 cursor、别名。
- `test/m6-s2-install.test.ts`：`GBDEV_CLI_HOME` 临时目录；四种状态；幂等；dry-run 零写；foreign 冲突；生成脚本可执行并能以 `env -i PATH=/usr/bin:/bin` 运行 `--help`；doctor `launcher`。
- `test/m6-s3-init.test.ts`：临时 `HOME`；label 规范化表；三种 home 解析；legacy 零写（目录前后快照逐字相同）；播种去 notify；不覆盖；home_conflict 各情形；`resolvePaths` 优先级与默认不变；每 bot 启动器设置 env 后 `notify enable` 只改 bot home config；dry-run 零写；输出无秘密（哨兵）。
- `test/m6-s4-docs.test.ts`：§9。
- 全部既有测试保持通过，既有测试文件只允许为新 doctor 检查做追加式修改。

## 12. 验收标准（编号可测）

**S1 角色与提示词目录**
- AC-1 `roles/` 下恰好 6 个角色目录（planner、executor、fixer、reviewer、verifier、resolver）与 `_shared/`；每个 `role.json` 通过 `gbdev.role-source.v1` 闭合校验，`name` 等于目录名。
- AC-2 新代码的 `builtinRoles()` 与快照中 master 的结果 `deepStrictEqual`；`roles list --json`、每个 `roles show <name> --json`（含 `code-reviewer`）的 result 与快照逐字一致。
- AC-3 §5.6 输入矩阵的全部渲染提示与快照逐字一致；快照文件由 `scripts/m6-prompt-snapshot.mjs` 在 master 代码上生成（patrol 复核）。
- AC-4 `node scripts/gen-roles.mjs --check` 在干净树上退出 0；修改任一 `prompt.md` 一个字符后退出 1；生成文件确定性（连续两次生成字节相同）。
- AC-5 生成器拒绝：`cursor_model` 非 `"auto"`（报 `cursor_model_not_allowed` 文字）、mode 与 output 不一致、resolver 允许 cursor、未知字段、空行/`\r`、未声明/未使用的占位符。
- AC-6 `src/` 中不再存在被搬迁的静态提示段（测试对 `_shared/*.md` 中每个长度 ≥ 40 的行断言其不出现在 `src/**/*.ts` 中，生成文件除外）；final 中列出搬迁清单。
- AC-7 `npm run build` 运行生成器；`dist/` 不需要读取 `roles/` 即可运行（测试在临时目录复制 `dist/` 后运行 `roles list` 成功）。
- AC-8 用户覆盖目录 `dirname(config)/roles/*.json` 行为不变（既有测试通过）。

**S2 启动器与 doctor**
- AC-9 `gbdev install --json` 在空 `GBDEV_CLI_HOME` 下创建逐字符合 §7.2 的脚本，mode 0755，`action=created`；第二次 `unchanged` 且文件 mtime 不变。
- AC-10 修改脚本的 cli 行 ⇒ doctor `launcher` 为 `stale`、ok=false；`install` ⇒ `updated` ⇒ `current`。
- AC-11 无 marker 的普通文件、符号链接、目录 ⇒ `launcher_conflict`，原物逐字不变。
- AC-12 `--dry-run` 零写入，`action` 为 `would_create`/`would_update`/`unchanged`。
- AC-13 生成的启动器在 `env -i PATH=/usr/bin:/bin HOME=<tmp>` 下执行 `--help` 与 `doctor --json` 成功（证明不依赖 PATH 中的 node）。
- AC-14 `path_hint` 精确为 `export PATH="$HOME/.gbdev-cli/bin:$PATH"`；`on_path` 随 PATH 正确变化；测试断言没有任何 rc 文件被创建或修改（临时 HOME 下的 `.zshrc`/`.zprofile`/`.bashrc`/`.profile` 前后一致）。
- AC-15 doctor 新增 `launcher` 与 `home` 检查，其余检查名称、顺序、结果不变；`DoctorResult` 校验接受新可选字段。

**S3 init 与 GBDEV_HOME**
- AC-16 label 规范化表：`"Example Dev"→example-dev`、`"my-bot"` 原样、`"--x__y--"→x-y`、`"9abc"→abc`、超长截断、`""`/`"123"`/`"cli"`/`"bootstrap"` ⇒ `usage_error`。
- AC-17 新 label ⇒ 创建 `~/.gbdev-<label>`（0700）、`home.json`（`gbdev.home.v1`，0600）、`config/config.json`（0600，等于全局 config 去掉 `notify`）、两个启动器；再次执行全部 `unchanged`，`created_at` 不变。
- AC-18 默认 home 的 `verified_by_bot` 等于 label ⇒ `legacy_default=true`、`home` 为默认 home；执行前后默认 home 整棵目录（名称、大小、mtime、内容哈希）逐字不变；全局 config 字节不变。
- AC-19 `home_conflict`：已有 home.json 绑定其他 label；目标目录非空无 home.json；`--home` 指向已被他 bot 绑定的默认 home。每种情况零写入。
- AC-20 未设 `GBDEV_CONFIG`、默认 home 无 `config/` 时 `resolvePaths` 与 master 结果相同；存在 `<home>/config/config.json` 时使用之（`configSource=home`）；`GBDEV_CONFIG` 优先（`env`）；`<home>/config/config.json` 为符号链接时不采用（回退 default，doctor `config` detail 说明）。
- AC-21 通过每 bot 启动器执行 `notify enable …` 只改变 bot home 的 config；全局 config 与默认 home 字节不变；`notify status` 的 `home_id` 等于 init 返回的 `home_id`。
- AC-22 每 bot 启动器即使调用方 env 中有 `GBDEV_CONFIG`/`GBDEV_HOME` 指向别处，也使用自己的 home（测试：fake job 落在 bot home 的 `jobs/`）。
- AC-23 `next_steps` 计算正确（四种组合）；`--no-install` 时启动器缺失给出 `install_launcher` 且零写启动器；`--dry-run` 零写入。
- AC-24 init/install/doctor 的 stdout/stderr 与生成文件不含哨兵 URL/密钥（在临时 HOME 放置 M5 格式的哨兵秘密文件）。
- AC-25 `init`、`install` 出现在 HELP 与 `COMMANDS`；`--json` 输出通过 `gbdev.init.v1`/`gbdev.install.v1` 闭合校验。

**S4 skill 与文档**
- AC-26 `skills/gbdev-usage/SKILL.md` 存在、有 frontmatter，Step 0 以 `gbdev init --bot` 开始且早于任何 `notify` 步骤。
- AC-27 skill 与 recipe 中提到的每个 `gbdev` 命令/子命令都存在于实际 CLI help（§9 测试）。
- AC-28 §9 关键规则一致性表全部通过。
- AC-30 README 两个新章节存在，并说明：不改 rc、启动器不是二进制、home config 播种后独立、角色修改流程与快照规则。

**S5 冒烟**
- AC-31 §14 中不需要 user 的冒烟 M6-R1…R8 全部通过，记录写入 `docs/smoke-m6/README.md`。

**整体**
- AC-32 `npm run build`、`npx tsc --noEmit`、`npx tsc -p tsconfig.test.json --noEmit`、`git diff --check`、`npm test` 全绿（沙箱内 `spawnSync ps EPERM` 类失败由 patrol 在沙箱外复跑确认）。

## 13. 分阶段实施（每阶段一轮 Cursor 实现 → patrol 复核并提交 → 一轮 Codex 只读审查；无 P0/P1 才进入下一阶段）

### S1 角色与提示词目录
- 先写 `scripts/m6-prompt-snapshot.mjs` 并在未改代码上生成快照；再建 `roles/`、生成器、`catalog.generated.ts`，改 `builtin.ts`/`registry.ts`/各提示函数读取片段；`roles/README.md`。
- 测试：AC-1…AC-8。规模：中。

### S2 install 启动器 + doctor
- `src/commands/install.ts`、`src/core/launcher.ts`（内容生成、状态判定、原子写）、契约 `gbdev.install.v1`、错误码 `launcher_conflict`、doctor `launcher`/`home` 检查（`home` 在 S2 只实现 `default`/`unbound`，S3 补 `bound`）。
- 测试：AC-9…AC-15。规模：小到中。

### S3 init / GBDEV_HOME / Step 0
- `src/commands/init.ts`、`resolvePaths` 的 home config、`home.json` 契约、每 bot 启动器、`home_conflict`、`gbdev.init.v1`；skill 的 Step 0 段落草稿可先放在 `skills/gbdev-usage/SKILL.md`（S4 完成整体）。
- 测试：AC-16…AC-25。规模：中。

### S4 skill 进仓库 + docs 测试 + recipe/README
- 测试：AC-26…AC-30。规模：中。

### S5 冒烟
- controller（patrol）在 Mac 上按 §14 执行并记录；合入 master 需 user 明确同意。

## 14. 真实冒烟（用户 Mac；均不需要 user，除 R9）

| 编号 | 场景 | 通过标准 |
|---|---|---|
| M6-R1 | 角色等价：在分支 `dist` 与 master `8b01a75` 临时 worktree 的 `dist` 上分别运行 `roles list --json` 与全部 `roles show --json` | 两者 result 逐字相同 |
| M6-R2 | 真实安装：`gbdev install --json` 两次 | 第一次 created、第二次 unchanged；`~/.gbdev-cli/bin/gbdev` 内容符合 §7.2；`env -i PATH=/usr/bin:/bin HOME=$HOME ~/.gbdev-cli/bin/gbdev doctor --json` 成功且 `launcher` current；rc 文件哈希前后不变 |
| M6-R3 | 过期/冲突：`GBDEV_CLI_HOME=$(mktemp -d)` 下安装后改一行 ⇒ stale ⇒ install 修复；放置无 marker 文件 ⇒ `launcher_conflict` | 如述 |
| M6-R4 | 新 bot：`gbdev init --bot m6-smoke --json` | 创建 `/tmp/gbdev-smoke` 与 `gbdev-m6-smoke`；config 无 notify；`notify.state` 为未配置；`~/.config/gbdev/config.json` 与 `~/.gbdev/notify/state.json` 的 sha256 前后相同 |
| M6-R5 | 旧绑定：`gbdev init --bot my-bot --json` | `legacy_default=true`、home 为 `~/.gbdev`、notify verified；`~/.gbdev` 下 `find -newer <marker>` 为空 |
| M6-R6 | 隔离派活：`gbdev-m6-smoke start --provider fake …`（repo `~/src/gbdev-smoke`，只读 brief） | job 出现在 `/tmp/gbdev-smoke/jobs`，`~/.gbdev/jobs` 数量不变；dashboard 会话为 `gbdev-<h6>` |
| M6-R7 | 真实 provider：经 `gbdev-m6-smoke` 各跑一个真实 Codex executor job（gbdev-smoke 仓库的小改动）与一个 Cursor reviewer job（`--model auto`，read-only） | 两者 succeeded；Cursor argv 含 `--model auto`、不含禁止字面量（`scripts/check-smoke-argv.mjs`）；提示词与快照来源一致 |
| M6-R8 | Step 0 演练：controller 按仓库 skill 对 label `m6-smoke` 走 Step 0 | init 后 notify 进入 `setup_secret`，bot 按 skill 停在需要 user 的步骤（不创建 routine，不执行 setup），继续派活；记录 |
| M6-R9 【需 user，可选】 | 第二个 bot 的完整 webhook 初始化（routine + `gbdev-<label> notify setup`） | 该 bot verified；`~/.gbdev` 的 notify 配置与状态不变 |

每条记录：时间（由执行者配置的时区）、命令、关键 JSON 片段（无秘密）、哈希前后对比。冒烟结束保留 `/tmp/gbdev-smoke`（可由 user 决定删除）。

## 15. 向后兼容

- 未设 env、默认 home 下：所有 M1–M5 命令输出、退出码、文件布局不变（`doctor` 仅追加两项检查）。
- `roles list/show`、所有提示词逐字不变（快照）。
- 旧调用方式 `node dist/cli.js …` 与 `npm link` 方式继续可用；启动器是附加入口。
- 已有自定义 `GBDEV_HOME`（如 `/tmp/gbdev-smoke`）若无 `config/config.json`，行为不变。

## 16. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 启动器固定 repo `dist/cli.js`，仓库切分支或未构建时启动器行为随之变化 | bot 用到开发中代码 | doctor 报告 cli_path；patrol 只在 master 构建后安装正式启动器；开发期冒烟用 `GBDEV_CLI_HOME` 临时目录或在冒烟后重新 install |
| nvm 升级/删除 Node 24.15.0 | 启动器失效 | doctor `stale`/执行失败可见；`gbdev install` 用新 node 重写 |
| home config 与全局 config 分叉 | allowed_repos 不一致 | 文档说明；doctor `config` 显示来源 |
| 提示搬迁遗漏或改字 | 行为漂移 | 快照 + AC-6 扫描 + Codex 审查 |
| 已有 home 目录与 label 撞名 | 劫持 | N9 冲突即停 |
