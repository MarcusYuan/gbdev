import { type Provider, type Sandbox } from '../contracts/brief.js';
import type { WorkerSchemaOptions } from '../contracts/workerResultSchema.js';

export interface ProviderContext {
  bin: string;
  worktree: string;
  jobDir: string;
  prompt: string;
  sandbox: Sandbox;
  network: boolean;
  model: string | null;
  writableRoots?: string[];
  taskId?: string | undefined;
  stepInstance?: string | undefined;
}
export interface ProviderAdapter {
  name: Provider;
  buildInvocation(ctx: ProviderContext): { cmd: string; args: string[]; cwd: string; finalMessageFile: string | null };
  prepareJob?(jobDir: string, schemaOptions?: WorkerSchemaOptions): void;
  extractFinalMessage(jobDir: string): string | null;
}
