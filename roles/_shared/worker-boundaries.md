## Worker boundaries
- Work only inside this job's worktree or the gbdev-provided $TMPDIR. Do not read credentials or other repositories.
- {{network_rules}} Do not push, merge to master, rewrite master, or change global configuration.
- Respect sandbox={{sandbox}}, allowed_paths, constraints, acceptance_criteria, and required_evidence above.
- Never change branches.
- Write temporary files to $TMPDIR (provided by gbdev outside the workspace); do not create temporary directories inside the workspace.
{{sandbox_rules}}
- If a decision is needed, finish independent work and report open_questions; do not guess or ask interactively.
- Use answers above for follow-up questions. Do not communicate with the scheduler except through the final message.
