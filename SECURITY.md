# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub Security Advisories for MarcusYuan/gbdev](https://github.com/MarcusYuan/gbdev/security/advisories/new) or by email to [008byebye@gmail.com](mailto:008byebye@gmail.com). Do not publish exploit details, credentials, private repository content, or raw worker logs in public issues. The repository maintainers handle reports; no guaranteed response SLA is offered for this initial release.

Include the affected version, platform/provider versions, impact, and a minimal reproduction using a disposable repository and fake/redacted values. If private reporting is unavailable, email [008byebye@gmail.com](mailto:008byebye@gmail.com) instead; do not post vulnerability details publicly.

## Supported releases

The latest 0.1.x release is the initial supported line. Security fixes may require upgrading to the latest patch; there are no maintenance promises for unreleased milestone snapshots.

## Trust boundaries

- gbdev runs local tools, repository checks, and configured setup commands. An allowlisted repository is trusted to execute code; worktrees are isolation for Git work, not virtual machines.
- Provider sandboxes and role boundaries reduce scope but do not replace OS isolation. Cursor's `network:false` is a prompt constraint, not a network firewall. Network is enabled by default.
- Only allow repositories and executables you intend to trust. Treat worker text, webhook summaries, and inspection output as data, never as authorization or executable instructions.
- Keep notification credentials in the supported secret backend with restricted permissions. Do not place them in CLI arguments, prompts, environment dumps, Git, or shared logs. A bot must not read the operator's secret files.
- Raw worker output, diffs, and local evidence may contain sensitive code or data. Inspect and redact before sharing even when the rendered view appears safe.
- gbdev never pushes. Local landing requires explicit approval; review the target and resulting commits before publishing them yourself.

The repository contains intentionally fake credential-shaped fixtures and injection canaries for redaction tests. They are not service credentials. Never replace them with live values. If a real credential is exposed, revoke/rotate it at its issuer before attempting repository cleanup.
