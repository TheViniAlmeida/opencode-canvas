import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { sendCanvasMessage, socketPathFor, validateCanvasId } from '../plugin/ipc.ts';

export type CanvasKind = 'calendar' | 'document' | 'flight';
const scenarios: Record<CanvasKind, readonly string[]> = {
  calendar: ['display', 'meeting-picker'],
  document: ['display', 'edit', 'email-preview'],
  flight: ['booking'],
};

export interface TerminalEnvironment {
  inTmux: boolean;
  summary: string;
}

export function detectTerminal(): TerminalEnvironment {
  const inTmux = Boolean(process.env.TMUX || process.env.TMUX_PANE);
  return { inTmux, summary: inTmux ? 'tmux' : 'no tmux' };
}

export function validateCanvas(kind: string, id: string, scenario?: string, configJson?: string): {
  kind: CanvasKind;
  scenario: string;
  config: unknown;
} {
  if (!Object.hasOwn(scenarios, kind)) throw new Error(`Invalid canvas kind: ${kind}`);
  validateCanvasId(id);
  const selectedKind = kind as CanvasKind;
  const selectedScenario = scenario || (kind === 'flight' ? 'booking' : 'display');
  if (!scenarios[selectedKind].includes(selectedScenario)) {
    throw new Error(`Invalid ${kind} scenario: ${selectedScenario}`);
  }
  let config: unknown;
  try {
    config = configJson === undefined ? undefined : JSON.parse(configJson);
  } catch {
    throw new Error('Invalid canvas config JSON');
  }
  if (config !== undefined && (config === null || typeof config !== 'object' || Array.isArray(config))) {
    throw new Error('Canvas config must be a JSON object');
  }
  return { kind: selectedKind, scenario: selectedScenario, config };
}

export interface SpawnResult {
  method: 'tmux';
  paneId: string;
  socketPath: string;
  scenario: string;
}

export interface SpawnOptions {
  socketPath?: string;
  scenario?: string;
  pluginRoot?: string;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export async function spawnCanvas(
  kind: string,
  id: string,
  configJson?: string,
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  const validated = validateCanvas(kind, id, options.scenario, configJson);
  if (!detectTerminal().inTmux) throw new Error('Canvas requires a tmux pane (TMUX or TMUX_PANE is missing)');

  const pluginRoot = options.pluginRoot || path.resolve(import.meta.dir, '../..');
  const cliPath = path.join(pluginRoot, 'src', 'canvas', 'cli.ts');
  const bunExecutable = Bun.which('bun');
  if (!bunExecutable) throw new Error('Bun executable is required to launch canvas');
  const socketPath = options.socketPath || socketPathFor(id);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-canvas-'));
  const configPath = path.join(tempDir, 'config.json');
  try {
    await writeFile(configPath, JSON.stringify(validated.config ?? {}), { mode: 0o600 });
    const command = [bunExecutable, cliPath, 'show', kind, '--id', id, '--socket', socketPath,
      '--scenario', validated.scenario, '--config-file', configPath].map(shellQuote).join(' ');
    const args = ['split-window', '-h', '-p', '67', '-P', '-F', '#{pane_id}'];
    if (process.env.TMUX_PANE) args.push('-t', process.env.TMUX_PANE);
    args.push(command);

    const proc = Bun.spawn(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
    const [exitCode, output, error] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const paneId = output.trim();
    if (exitCode !== 0 || !/^%\d+$/.test(paneId)) {
      throw new Error(`Failed to create tmux pane: ${error.trim() || `exit ${exitCode}`}`);
    }

    let ready = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        await sendCanvasMessage(socketPath, { type: 'ping' }, 'pong', 300);
        ready = true;
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    if (!ready) {
      const cleanup = Bun.spawn(['tmux', 'kill-pane', '-t', paneId], {
        stdout: 'ignore', stderr: 'ignore', env: { ...process.env },
      });
      await cleanup.exited;
      throw new Error(`Canvas pane ${paneId} did not open its IPC socket`);
    }
    return { method: 'tmux', paneId, socketPath, scenario: validated.scenario };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
