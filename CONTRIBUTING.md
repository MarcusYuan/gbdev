# Contributing to gbdev

Thanks for helping improve gbdev. Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Development setup

Use Node.js >=24, npm, Git >=2.38, and a POSIX shell. Real provider access and tmux are not required for the default automated suite.

```sh
npm ci --registry=https://registry.npmjs.org
npm run build
npm run typecheck
npm test
node scripts/gen-roles.mjs --check
```

Tests create and clean temporary repositories, use synthetic data and fake providers, and must not read a contributor's personal configuration or credentials. Keep tests offline except deliberately stubbed/local HTTP fixtures. Do not add real Codex/Cursor calls to the default suite. Real-provider smoke testing is opt-in, can incur charges, and requires a separate disposable allowlisted repository and state home; record redacted evidence rather than private transcripts.

The full suite can take tens of minutes. On macOS, `caffeinate -i npm test` can prevent idle sleep from interrupting real-time process tests; closing the lid can still suspend the machine.

## Changes and review

1. Open an issue for substantial design changes, or send a focused pull request for a fix.
2. Explain the behavior change, compatibility impact, and verification performed. Keep meaningful safety/regression tests, especially sandbox, path, decision, and redaction coverage.
3. Maintain versioned JSON schema/CLI compatibility and old-record readers. Update example documents and assertions together when contracts change.
4. Never include credentials, personal machine paths, raw model sessions, private notification URLs, or local runtime state.
5. Keep documentation links and English/Chinese overview aligned. Maintainers review changes before merge; do not include unrelated generated artifacts.

## Roles and prompt snapshots

The source of truth is `roles/<name>/role.json`, `prompt.md`, and `roles/_shared/`. Change those sources, then run `node scripts/gen-roles.mjs`; never edit only `src/roles/catalog.generated.ts`. Verify with `node scripts/gen-roles.mjs --check`.

Prompt snapshots deliberately detect wording and boundary changes. For an intentional prompt change, review the complete source/snapshot diff and explain it in the pull request. After building, `node scripts/m6-prompt-snapshot.mjs` captures the main prompt matrix; review the separate snapshot-extra fixture against its capture code in `test/m6-s1-roles.test.ts` when affected. Do not regenerate snapshots merely to hide a failing test.

## Licensing

By intentionally submitting a contribution, you agree to license it under Apache-2.0, consistent with [LICENSE](LICENSE). Retain required third-party notices and identify any material that cannot be contributed under those terms.
