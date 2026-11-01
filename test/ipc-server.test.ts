import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Plugin } from '@opencode/plugin';
import { createIPCServer } from '../src/canvas/ipc/server.ts';
import { sendCanvasMessage, socketPathFor } from '../src/plugin/ipc.ts';
import { registerCanvasTools } from '../src/plugin/tools.ts';

async function withSocket(run: (socketPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'canvas-server-test-'));
  try {
    await run(path.join(directory, 'canvas.sock'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('server acknowledges update and close after handler succeeds', async () => {
  await withSocket(async (socketPath) => {
    const seen: string[] = [];
    const server = await createIPCServer({
      socketPath,
      onMessage(message) {
        seen.push(message.type);
      },
    });
    try {
      expect(await sendCanvasMessage(socketPath, { type: 'update', config: {} }, 'ack')).toMatchObject({
        type: 'ack', action: 'update',
      });
      expect(await sendCanvasMessage(socketPath, { type: 'close' }, 'ack')).toMatchObject({
        type: 'ack', action: 'close',
      });
      expect(seen).toEqual(['update', 'close']);
    } finally {
      server.close();
    }
  });
});

test('server reports handler failure without exposing its error message', async () => {
  await withSocket(async (socketPath) => {
    const logged: string[] = [];
    const server = await createIPCServer({
      socketPath,
      onMessage() { throw new Error('private content'); },
      onError(error) { logged.push(error.message); },
    });
    try {
      await expect(sendCanvasMessage(socketPath, { type: 'update', config: {} }, 'ack'))
        .rejects.toThrow('Canvas update failed');
      expect(logged).toEqual(['Canvas IPC handler failed for update']);
    } finally {
      server.close();
    }
  });
});

test('close ACK survives server shutdown started by the handler', async () => {
  await withSocket(async (socketPath) => {
    let server: Awaited<ReturnType<typeof createIPCServer>>;
    server = await createIPCServer({
      socketPath,
      onMessage(message) {
        if (message.type === 'close') server.close();
      },
    });
    expect(await sendCanvasMessage(socketPath, { type: 'close' }, 'ack')).toMatchObject({
      type: 'ack', action: 'close',
    });
  });
});

test('client rejects an ACK for a different action', async () => {
  await withSocket(async (socketPath) => {
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        open() {},
        data(socket) { socket.write('{"type":"ack","action":"close"}\n'); },
        close() {},
        error() {},
      },
    });
    try {
      await expect(sendCanvasMessage(socketPath, { type: 'update', config: {} }, 'ack'))
        .rejects.toThrow('acknowledgment does not match');
    } finally {
      server.stop(true);
    }
  });
});

test('server buffers fragmented messages separately for each connection', async () => {
  await withSocket(async (socketPath) => {
    const seen: string[] = [];
    const server = await createIPCServer({
      socketPath,
      onMessage(message) {
        if (message.type === 'update') seen.push(String((message.config as { source: string }).source));
      },
    });
    const client = () => Bun.connect({
      unix: socketPath,
      socket: { open() {}, data() {}, close() {}, error() {} },
    });
    const [first, second] = await Promise.all([client(), client()]);
    try {
      first.write('{"type":"update","config":{"source":"first"');
      second.write('{"type":"update","config":{"source":"second"');
      first.write('}}\n');
      second.write('}}\n');
      await Bun.sleep(30);
      expect(seen.sort()).toEqual(['first', 'second']);
    } finally {
      first.end();
      second.end();
      server.close();
    }
  });
});

test('tool returns failure when a connected server discards update without ACK', async () => {
  const id = `ack-test-${Date.now()}`;
  const socketPath = socketPathFor(id);
  const server = Bun.listen({
    unix: socketPath,
    socket: { open() {}, data() {}, close() {}, error() {} },
  });
  const tools = new Map<string, { execute: (input: unknown) => Promise<{ content?: string | readonly unknown[] }> }>();
  const ctx = {
    tool: { transform: async (transform: (editor: { add: (tool: { name: string; execute: (input: unknown) => Promise<{ content?: string | readonly unknown[] }> }) => void }) => void) => {
      transform({ add: tool => tools.set(tool.name, tool) });
      return { dispose: async () => {} };
    } },
  } as unknown as Plugin.Context;
  try {
    await registerCanvasTools(ctx, path.resolve(import.meta.dir, '..'));
    const result = await tools.get('canvas_update')!.execute({ id, config: '{}' });
    expect(JSON.parse(result.content as string)).toMatchObject({ success: false, id });
  } finally {
    server.stop(true);
  }
});
