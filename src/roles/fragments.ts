import { PROMPT_FRAGMENTS } from './catalog.generated.js';

export type FragmentId = keyof typeof PROMPT_FRAGMENTS;

/** Replace declared `{{name}}` placeholders; unknown keys are ignored by callers (generator enforces the set). */
export function fragment(id: FragmentId, values: Record<string, string> = {}): string {
  return PROMPT_FRAGMENTS[id].replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_, name: string) =>
    Object.hasOwn(values, name) ? values[name]! : `{{${name}}}`);
}
