# gbdev setup guide for Grok Bot

> **Audience: the AI controller (Grok Bot).** A user starts this guide by pasting one instruction into Grok Bot:
>
> ```text
> Set up gbdev for me by following https://github.com/MarcusYuan/gbdev/blob/main/docs/grokbot-setup.md
> ```
>
> Follow every step below in order, end to end. Humans can read along; [the README](../README.md) has the manual version.

## Ground rules

- **Run every command on the user's computer** (a machine-targeted shell on their Mac/Linux machine), not in your own sandbox. gbdev, the user's repositories, Codex CLI, and Cursor agent all live there.
- **Never** edit shell startup files (`~/.zshrc`, `~/.bashrc`, …), install anything globally, or change global tool configuration without the user's explicit yes in chat.
- **Never** read, print, or ask for credentials: no provider tokens, no `~/.codex` / `~/.cursor` contents, no webhook URL or key. The user logs into providers and pastes webhook secrets **in their own terminal**.
- **Never** use approval/sandbox bypass flags for Codex or Cursor, and never push anything.
- Ask the user only for what you cannot discover yourself: which repository (or repositories) gbdev may work on, and permission for anything in the bullets above. Batch questions into one message.
- If a step fails, stop that step, report the exact error (envelope `error.code` / message, no secrets), and say what the user must do. Everything up to the failure stays valid; re-running this guide is safe.

Throughout, `<gbdev_dir>` is the clone directory, `<bot_label>` the bot label, and `<command>` the absolute bot launcher returned by `init` in Step 4.

## Step 1 — Check prerequisites

```sh
uname -s
node --version            # must be v24 or newer
npm --version
git --version             # must be 2.38 or newer
command -v codex && codex --version
command -v cursor-agent && cursor-agent --version
command -v tmux && tmux -V   # optional: live dashboard (tmux >= 3.2)
```

- `uname -s` must be `Darwin` or `Linux`. Native Windows is not supported.
- **Node.js < 24 or missing:** stop and tell the user to install Node.js 24+ (for example with their version manager). Do not change their Node installation yourself without an explicit yes.
- **Git < 2.38:** stop and ask the user to upgrade Git.
- **Workers:** at least one of `codex` (Codex CLI) and `cursor-agent` (Cursor agent) is required; the default workflow uses both. If one is missing, tell the user and ask whether you may install it, or let them install it themselves.
- **Logins — the user's job.** Check status only:

  ```sh
  codex login status
  cursor-agent status
  ```

  If not logged in, ask the user to run `codex login` and/or `cursor-agent login` in their own terminal, then continue. Provider accounts, model access, and usage charges are the user's responsibility.
- tmux missing is fine; say the live dashboard will be unavailable (`watch` commands still work).

## Step 2 — Get the code and build

Default clone directory: `$HOME/src/gbdev`, unless the user named another location.

```sh
# Fresh install
mkdir -p "$HOME/src"
git clone https://github.com/MarcusYuan/gbdev.git "$HOME/src/gbdev"
cd "$HOME/src/gbdev"

# Existing clone of this repository (check `git remote -v` first): update instead
# cd <gbdev_dir> && git pull --ff-only

npm ci --registry=https://registry.npmjs.org
npm run build
node dist/cli.js --help
```

- If the target directory exists and is **not** a gbdev clone, do not overwrite it; ask the user for another location.
- `npm test` is optional (about 2,000 tests, several minutes; CI runs it on every push).
- Keep the clone where it is: launchers record the absolute paths of `node` and `dist/cli.js`. After moving the clone, upgrading Node, or pulling a new version, rebuild and re-run Step 4 to refresh the launchers.

## Step 3 — Choose the bot label

Use your own bot name, normalized: lowercase; characters other than `a-z`, `0-9`, `-` become `-`; must start with a letter; at most 32 characters; `cli` and `bootstrap` are reserved. Example: "My Dev Bot" → `my-dev-bot`. Use the same label every time; one label per bot, one gbdev home per bot.

## Step 4 — Create the home and launchers

```sh
cd <gbdev_dir>
node dist/cli.js init --bot <bot_label> --dry-run --json   # preview, writes nothing
node dist/cli.js init --bot <bot_label> --json
```

From the JSON envelope (`ok: true`), record in memory:

| Field | Meaning |
| --- | --- |
| `result.command` | Absolute bot launcher (`…/.gbdev-cli/bin/gbdev-<bot_label>`). Use it as `<command>` for **every** later gbdev call. |
| `result.home`, `result.home_id` | This bot's gbdev home (`~/.gbdev-<bot_label>` for a new bot) and its ID. |
| `result.config.path` | The config file this home uses. |
| `result.legacy_default` | `true` means this bot reuses the default home `~/.gbdev`. |
| `result.launcher.on_path`, `result.launcher.path_hint` | Whether the shared `gbdev` launcher is on `PATH`. |

- `init` also installs the shared launcher (`~/.gbdev-cli/bin/gbdev`) and the bot launcher when missing or stale. `gbdev install` alone only installs the shared launcher.
- Do not hand-write `GBDEV_HOME` / `GBDEV_CONFIG` prefixes; the bot launcher sets them.
- `home_conflict` or `launcher_conflict`: stop and report; never delete or rename anything to resolve it.
- If `on_path` is `false`, give the user `path_hint` as an optional line for their own shell profile. Do not edit it yourself; you do not need it, because you always use the absolute `<command>`.

## Step 5 — Allow the user's repositories

gbdev only touches repositories listed in `allowed_repos` (exact canonical paths, not prefixes). Ask the user which repository gbdev should work on if they have not said so. For each one:

```sh
cd /path/to/their/repo
git rev-parse --show-toplevel     # must succeed: a Git repository
git rev-parse --verify HEAD       # must succeed: at least one commit
pwd -P                            # canonical path to allow (use the toplevel)
```

Then add the canonical path to `result.config.path` from Step 4, keeping all existing keys and entries:

```sh
node -e '
const fs = require("fs");
const path = require("path");
const [file, repo] = process.argv.slice(1);
const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1 };
cfg.version = cfg.version ?? 1;
cfg.allowed_repos = [...new Set([...(cfg.allowed_repos ?? []), repo])];
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
' "<result.config.path>" "<canonical repo path>"
```

Show the user the resulting `allowed_repos` list. Each bot home has its own config; seeding happens only once, so later changes must be made in this file deliberately. Optional provider settings (see the [README configuration section](../README.md#configuration)) go in the same file.

## Step 6 — Verify

```sh
<command> doctor --json
<command> roles list --json
<command> pipeline templates --json
```

Check every `result.checks[]` entry, not only `ok` on the envelope:

- Must be `ok: true`: `node`, `git`, `git_merge_tree`, `config`, `roles`, `home_writable`, plus `codex`/`codex_login` and/or `cursor`/`cursor_login` for the workers in use.
- Non-blocking: `tmux` (dashboard only), `notify` (Step 8), `launcher`/`home` (re-run Step 4 to repair).

Report any blocking failure to the user with what they need to do.

## Step 7 — Install the gbdev-usage skill

Install the repository file [`skills/gbdev-usage/SKILL.md`](../skills/gbdev-usage/SKILL.md) as one of your own skills:

1. Read `<gbdev_dir>/skills/gbdev-usage/SKILL.md` from the user's computer.
2. Save it with your skill-saving capability as a skill named **`gbdev-usage`**, copying the content verbatim (front matter included). If the skill already exists, replace it with the repository version.
3. Remember `<gbdev_dir>`, `<bot_label>`, `<command>`, `home`, and `home_id`. The skill's Step 0.A is what you just did; it is safe to re-run `init` any time.

The repository file stays the source of truth: after every `git pull`, re-install the skill. The long-form companion docs are [docs/controller-recipe.md](controller-recipe.md) and [docs/controller-role.md](controller-role.md).

## Step 8 — Optional: webhook notifications

Without notifications you follow progress by polling (skill §3); everything works. With them, gbdev wakes you when a run needs a decision or finishes. Ask the user whether they want them; if yes, follow **skill Step 0.B exactly**, using `<command>` from Step 4. In short:

1. `<command> doctor --json` and `<command> notify status --json`. Done when `result.init.state` is `verified` **and** `init.verified_by_bot` equals `<bot_label>`. If it is verified by another label, do not rebind; that home belongs to another bot.
2. Create **one** webhook-triggered routine for this bot with the routine prompt from the skill ("Webhook routine prompt"; fill in the bot label and trusted home, never a URL or key). Reuse an existing one; never duplicate. Send the user the routine panel's links for the webhook URL, key, and Authorization header.
3. **User's only manual step:** in their own terminal they run `<command> notify setup` (input is hidden) and paste the URL and key from the panel. You never run `setup`, and you never see or ask for the key.
4. `<command> notify enable --key-placement header --key-name Authorization --key-prefix "Bearer " --json` — this matches the routine panel's Authorization header. If the panel shows something else, follow the panel; never guess.
5. `<command> notify test --json`, then check `<command> notify status --json` every 15 seconds for up to 2 minutes while the woken routine runs `<command> notify ack <notice_id> --bot <bot_label> --json`. You never ack on the routine's behalf.
6. When `init.state=verified` and bound to `<bot_label>`, record `home_id` with the label and tell the user notifications are connected. If it times out, say the platform accepted the test but the routine did not confirm, and ask them to check that the routine is enabled.

A failed or unfinished notify setup never blocks work; fall back to polling and say which step is missing.

## Step 9 — Report to the user

Send one concise summary:

- gbdev version (`node <gbdev_dir>/dist/cli.js --help` works; `package.json` version) and clone location.
- Bot label, home, and launcher path (`<command>`); `path_hint` if they want plain `gbdev` in their own terminal.
- Allowed repositories.
- Doctor results: worker availability and logins, tmux/dashboard availability.
- Skill installed (`gbdev-usage`) and notification status (verified / skipped / waiting for the user's `notify setup`).
- How to start: "Tell me what to build in <repo>; I'll plan it with gbdev, run it in isolated worktrees, and ask you before anything is merged."

Never claim a step succeeded unless its command output showed it.
