import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import type { Plugin } from '@opencode/plugin';
import CanvasPlugin from '../src/index.ts';
import { loadCatalog, parseFrontmatter } from '../src/plugin/catalog.ts';
import { sendCanvasMessage, socketPathFor } from '../src/plugin/ipc.ts';
import { spawnCanvas, validateCanvas } from '../src/canvas/terminal.ts';

const root = path.resolve(import.meta.dir, '..');

test('catalog loads source assets and multiline descriptions', async () => {
  const catalog = await loadCatalog(root);
  expect(catalog.skills).toHaveLength(4);
  expect(catalog.commands.map(command => command.name)).toEqual(['explain', 'format-check', 'hello', 'quick-review']);
  expect(catalog.skills.find(skill => skill.name === 'canvas')?.description).toContain('Covers spawning');
  expect(catalog.skills.every(skill => path.isAbsolute(skill.path))).toBe(true);
  expect(parseFrontmatter('---\r\ndescription: |\r\n  first\r\n  second\r\n---\r\nbody')).toEqual({
    frontmatter: { description: 'first\nsecond' }, body: 'body',
  });
});

test('v2 setup registers replay safe tools, commands and skills', async () => {
  const tools: Array<{ name: string; execute: (input: unknown) => Promise<{ content?: string | readonly unknown[] }> }> = [];
  const commands: Array<{ name: string; execute: (input: unknown) => Promise<void> }> = [];
  const skills: Array<{ id: string; name: string; path: string }> = [];
  const prompts: unknown[] = [];
  let replayTools: ((editor: { add: (value: (typeof tools)[number]) => void }) => void) | undefined;
  let disposals = 0;
  const registration = { dispose: async () => { disposals++; } };
  const ctx = {
    tool: { transform: async (transform: (editor: { add: (value: (typeof tools)[number]) => void }) => void) => {
      replayTools = transform;
      transform({ add: value => tools.push(value) });
      return registration;
    } },
    command: { transform: async (transform: (editor: { add: (value: (typeof commands)[number]) => void }) => void) => {
      transform({ add: value => commands.push(value) });
      return registration;
    } },
    skill: { transform: async (transform: (editor: { add: (value: (typeof skills)[number]) => void }) => void) => {
      transform({ add: value => skills.push(value) });
      return registration;
    } },
    session: { prompt: async (input: unknown) => { prompts.push(input); } },
  } as unknown as Plugin.Context;
  // Replaying transforms must produce the same effective registrations.
  const cleanup = await CanvasPlugin.setup(ctx);
  expect(tools.map(tool => tool.name)).toEqual(['canvas_spawn', 'canvas_update', 'canvas_selection', 'canvas_close']);
  tools.length = 0;
  replayTools?.({ add: value => tools.push(value) });
  expect(tools.map(tool => tool.name)).toEqual(['canvas_spawn', 'canvas_update', 'canvas_selection', 'canvas_close']);
  expect(commands.map(command => command.name)).toEqual(['explain', 'format-check', 'hello', 'quick-review']);
  expect(skills).toHaveLength(4);
  expect(skills.every(skill => path.isAbsolute(skill.path))).toBe(true);
  const invocation = {
    sessionID: 'session-1', delivery: 'queue',
    prompt: { text: 'extra context', files: [{ path: '/tmp/example' }], agents: [], skills: [] },
  };
  await commands.find(command => command.name === 'hello')!.execute(invocation);
  expect(prompts[0]).toMatchObject({
    sessionID: 'session-1', delivery: 'queue', files: invocation.prompt.files,
    text: 'Say hello to the user in a friendly and creative way.\n\nextra context',
  });
  const badUpdate = await tools.find(tool => tool.name === 'canvas_update')!.execute({ id: '../escape', config: '{}' });
  expect(JSON.parse(badUpdate.content as string)).toMatchObject({ success: false, id: '../escape' });
  const missingClose = await tools.find(tool => tool.name === 'canvas_close')!.execute({ id: 'missing-canvas' });
  expect(JSON.parse(missingClose.content as string)).toMatchObject({ success: false, closed: false });
  if (cleanup) await cleanup();
  expect(disposals).toBe(3);
});

test('canvas validation rejects unsafe identifiers and invalid inputs before tmux', async () => {
  expect(() => socketPathFor('../../escape')).toThrow('Invalid canvas id');
  expect(() => validateCanvas('flight', 'flight-1', 'edit', '{}')) .toThrow('Invalid flight scenario');
  expect(() => validateCanvas('calendar', 'calendar-1', undefined, '[]')).toThrow('JSON object');
  const previousTmux = process.env.TMUX;
  const previousPane = process.env.TMUX_PANE;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  try {
    await expect(spawnCanvas('document', 'document-1', '{}', { pluginRoot: root })).rejects.toThrow('requires a tmux pane');
  } finally {
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
    if (previousPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = previousPane;
  }
});

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-ipc-test-'));
describe('canvas IPC', () => {
  const socketPath = path.join(tempDir, 'canvas.sock');
  afterAll(async () => rm(tempDir, { recursive: true, force: true }));

  test('buffers fragmented selection response until newline', async () => {
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        open() {},
        data(socket) {
          socket.write('{"type":"selec');
          setTimeout(() => socket.write('tion","data":{"selectedText":"hello"}}\n'), 20);
        },
        close() {},
        error() {},
      },
    });
    try {
      const reply = await sendCanvasMessage(socketPath, { type: 'getSelection' }, 'selection');
      expect(reply?.data).toEqual({ selectedText: 'hello' });
    } finally {
      server.stop(true);
    }
  });

  test('reports connection failure instead of success', async () => {
    await expect(sendCanvasMessage(socketPath, { type: 'close' }, 'ack')).rejects.toThrow();
  });

  test('times out and closes a socket when the server does not respond', async () => {
    let closeCount = 0;
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        open() {},
        data() {},
        close() { closeCount++; },
        error() {},
      },
    });
    try {
      await expect(sendCanvasMessage(socketPath, { type: 'update', config: {} }, 'ack', 30)).rejects.toThrow('timeout');
      await Bun.sleep(20);
      expect(closeCount).toBeGreaterThanOrEqual(1);
    } finally {
      server.stop(true);
    }
  });
});
