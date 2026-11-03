import { homedir } from 'node:os';
import { GbdevError } from '../contracts/error.js';
import { validateJobId } from '../core/ids.js';
import { JobRenderer, Tail } from '../render/job.js';
import { formatLine, type RenderLine } from '../render/format.js';
export interface LogsOptions { json?: boolean; follow?: boolean; tail?: string; 'from-start'?: boolean; verbose?: boolean; 'no-color'?: boolean }
export async function logs(home: string, jobId: string | undefined, options: LogsOptions, write: (text: string) => void | Promise<void>): Promise<void> {
  try { validateJobId(jobId); } catch { throw new GbdevError('usage_error', 'logs requires a valid job_id'); }
  if (options.follow && options.json) throw new GbdevError('usage_error', '--follow and --json are mutually exclusive');
  if (options.tail !== undefined && (!/^\d+$/.test(options.tail) || !Number.isSafeInteger(Number(options.tail)) || Number(options.tail) > 5000)) throw new GbdevError('usage_error', '--tail must be an integer between 0 and 5000');
  if (options.tail !== undefined && options['from-start']) throw new GbdevError('usage_error', '--tail and --from-start are mutually exclusive');
  const renderer = new JobRenderer(home, jobId, { follow: options.follow ?? false, fromStart: options['from-start'] ?? false, verbose: options.verbose ?? false, columns: process.stdout.columns ?? 120, userHome: homedir(), onBackfill: async () => { if (backfill) { for (const value of tail.all()) await emit(value); backfill = false; } } });
  const color = !options['no-color'] && !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
  let first = true;
  const emit = async (value: RenderLine) => {
    if (options.json) { await write(`${first ? '' : ','}${JSON.stringify(value)}`); first = false; }
    else await write(formatLine(value, color));
  };
  // Stream the array too: --from-start --json never accumulates the full history.
  if (options.json) await write(`{"contract_version":"1","ok":true,"command":"logs","result_schema":"gbdev.render-lines.v1","result":{"job_id":${JSON.stringify(jobId)},"provider":${JSON.stringify(renderer.provider)},"lines":[`);
  const tail = new Tail<RenderLine>(Number(options.tail ?? 200));
  let backfill = !options['from-start'];
  for await (const value of renderer.lines()) {
    if (value.tag === 'SKIP') { await emit(value); continue; }
    if (backfill) tail.push(value); else await emit(value);
  }
  if (backfill) for (const value of tail.all()) await emit(value);
  if (options.json) await write(`],"corrupt_lines":${renderer.stats.corrupt_lines},"truncated_lines":${renderer.stats.truncated_lines},"skipped_bytes":${renderer.stats.skipped_bytes}}}\n`);
}
