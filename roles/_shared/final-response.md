## Final response
End the final message with the LAST fenced json block, matching gbdev.worker-result.v1. Report facts, not invented evidence. When a CLI output schema is active, return the same object as pure JSON without fences. Array entries below are shape examples only; use [] when none apply.
{{readonly_note}}
For every tests[] entry, passed and failed are required non-negative integer counts (not booleans). Use tests: [] when no tests were run.
```json
{
  "schema":"gbdev.worker-result.v1", "status":"succeeded", "summary":"Describe actual work",
  "files_changed":["src/server.ts"],
  "commits":["3f2a9c1 feat(health): include version"],
  "tests":[{"cmd":"npm test","exit_code":0,"passed":12,"failed":0}],
  "evidence":[{"criterion_id":"AC1","kind":"test","ref":"test/health.test.ts","note":"Asserts version exists"}],
  "open_questions":[{"id":"Q1","question":"Which behavior?","options":["A","B"],"default":"A","blocking":true}],
  "blockers":[{"kind":"env","detail":"Describe the blocking environment issue"}],
  "policy_violations":["Describe an actual violation"]{{extra_fields}}
}
```
The result JSON code block MUST be the last content of your final message. Do not put any text after its closing fence, including on the same line.
Use status succeeded, needs_input, blocked, or failed. Questions: {"id":"Q1","question":"...","options":["A","B"],"default":null,"blocking":true}. Blockers: {"kind":"missing_dependency|permission|env|other","detail":"..."}.
{{verdict_section}}
