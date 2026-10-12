#!/usr/bin/env bun
import { program } from 'commander';
import { readFile } from 'node:fs/promises';
import { detectTerminal, spawnCanvas, validateCanvas } from './terminal.ts';
import { sendCanvasMessage, socketPathFor } from '../plugin/ipc.ts';

interface CanvasOptions {
  id?: string;
  config?: string;
  configFile?: string;
  socket?: string;
  scenario?: string;
}

async function configText(options: CanvasOptions): Promise<string | undefined> {
  if (options.config && options.configFile) throw new Error('Use either --config or --config-file');
  return options.configFile ? readFile(options.configFile, 'utf8') : options.config;
}

function setWindowTitle(title: string) {
  process.stdout.write(`\x1b]0;${title}\x07`);
}

function commonOptions(command: ReturnType<typeof program.command>) {
  return command
    .option('--id <id>', 'Canvas ID')
    .option('--config <json>', 'Canvas configuration (JSON)')
    .option('--config-file <path>', 'Read canvas configuration from a file')
    .option('--socket <path>', 'Unix socket path for IPC')
    .option('--scenario <name>', 'Canvas scenario');
}

const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
program.name('opencode-canvas').description('Interactive terminal canvases for OpenCode').version(version);

commonOptions(program.command('show <kind>').description('Show a canvas in the current terminal'))
  .action(async (kind: string, options: CanvasOptions) => {
    const id = options.id || `${kind}-1`;
    const config = await configText(options);
    const validated = validateCanvas(kind, id, options.scenario, config);
    setWindowTitle(`canvas: ${kind}`);
    const { renderCanvas } = await import('./canvases/index.tsx');
    await renderCanvas(kind, id, validated.config, {
      socketPath: options.socket,
      scenario: validated.scenario,
    });
  });

commonOptions(program.command('spawn <kind>').description('Spawn a canvas in a tmux split pane'))
  .action(async (kind: string, options: CanvasOptions) => {
    const id = options.id || `${kind}-${Date.now()}`;
    const result = await spawnCanvas(kind, id, await configText(options), {
      socketPath: options.socket,
      scenario: options.scenario,
    });
    console.log(JSON.stringify({ success: true, id, kind, ...result }));
  });

program.command('env').description('Show detected terminal environment').action(() => {
  console.log(JSON.stringify(detectTerminal()));
});

program.command('update <id>').description('Update a running canvas')
  .requiredOption('--config <json>', 'New JSON configuration')
  .action(async (id: string, options: { config: string }) => {
    const config = JSON.parse(options.config) as unknown;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Config must be a JSON object');
    await sendCanvasMessage(socketPathFor(id), { type: 'update', config }, 'ack');
    console.log(JSON.stringify({ success: true, id }));
  });

program.command('selection <id>').description('Read the current document selection')
  .action(async (id: string) => {
    const reply = await sendCanvasMessage(socketPathFor(id), { type: 'getSelection' }, 'selection');
    console.log(JSON.stringify(reply?.data ?? null));
  });

program.command('content <id>').description('Read current document content')
  .action(async (id: string) => {
    const reply = await sendCanvasMessage(socketPathFor(id), { type: 'getContent' }, 'content');
    console.log(JSON.stringify(reply?.data ?? null));
  });

await program.parseAsync().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
