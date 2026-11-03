import assert from 'node:assert/strict';

/** Check the actual prompt artifact, including fences embedded in a JSON task context. */
export function assertOrchestratorNote(prompt: string, note: string): void {
  const blocks = [...prompt.matchAll(/<<<GBDEV_UNTRUSTED_DATA[\s\S]*?GBDEV_UNTRUSTED_DATA>>>/g)].map(m => m[0]);
  for (const block of blocks) assert.ok(!block.includes(note), 'note must not be repeated in untrusted evidence');
  const trusted = prompt.replace(/<<<GBDEV_UNTRUSTED_DATA[\s\S]*?GBDEV_UNTRUSTED_DATA>>>/g, '');
  assert.ok(trusted.includes(`Note from the orchestrator: ${note}`), 'verbatim note must be in trusted prompt context');
}
