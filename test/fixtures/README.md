# Regression fixtures

These files are test data, not credentials or deployment configuration. `fake-secrets.jsonl`, terminal injection samples, authorization strings, and webhook endpoints are intentionally synthetic redaction/security canaries. Never replace them with live service values.

Provider event fixtures preserve the JSON/event shapes needed by parser regression tests. Recorded session/request UUIDs were replaced with deterministic synthetic UUIDs (`00000000-0000-4000-8000-00000000000N`); their identifiers are not real provider sessions. Repository/home paths are placeholders or temporary paths, not locations tests may assume exist.

Prompt snapshots preserve role/prompt behavior. The public-release wording changes replace personal names and controller branding; role boundaries, untrusted-data framing, and JSON output contracts remain intact. Generate the role catalog from `roles/` before intentionally capturing snapshots.
