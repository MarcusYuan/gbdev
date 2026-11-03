import { installSharedLauncher, type InstallResult } from '../core/launcher.js';

export function installCommand(options: { dryRun?: boolean } = {}): InstallResult {
  return installSharedLauncher({ dryRun: options.dryRun === true });
}

export function installText(result: InstallResult): string {
  const lines = [
    `launcher: ${result.launcher_path}`,
    `state_before: ${result.state_before}`,
    `action: ${result.action}`,
    `on_path: ${result.on_path}`,
    `node: ${result.node_path}`,
    `cli: ${result.cli_path}`,
  ];
  if (!result.on_path) lines.push(`path_hint: ${result.path_hint}`);
  if (result.dry_run) lines.push('dry_run: true');
  return `${lines.join('\n')}\n`;
}
