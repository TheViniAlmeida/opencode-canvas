import type { Socket } from 'bun';
import { existsSync, unlinkSync } from 'node:fs';
import type { CanvasMessage, ControllerMessage } from './types.ts';

export interface IPCServerOptions {
  socketPath: string;
  onMessage: (msg: ControllerMessage) => void;
  onClientConnect?: () => void;
  onClientDisconnect?: () => void;
  onError?: (error: Error) => void;
}

export interface IPCServer {
  broadcast: (msg: CanvasMessage) => void;
  close: () => void;
}

function parseControllerMessage(line: string): ControllerMessage {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid canvas IPC message');
  }
  const input = value as Record<string, unknown>;
  switch (input.type) {
    case 'update':
      if (!Object.hasOwn(input, 'config')) throw new Error('Missing canvas update config');
      return { type: 'update', config: input.config };
    case 'close':
    case 'ping':
    case 'getSelection':
    case 'getContent':
      return { type: input.type };
    default:
      throw new Error('Unsupported canvas IPC message');
  }
}

export async function createIPCServer(options: IPCServerOptions): Promise<IPCServer> {
  const { socketPath, onMessage, onClientConnect, onClientDisconnect, onError } = options;
  if (existsSync(socketPath)) unlinkSync(socketPath);

  const clients = new Set<Socket<unknown>>();
  const buffers = new Map<Socket<unknown>, string>();
  const send = (socket: Socket<unknown>, message: CanvasMessage): void => {
    socket.write(JSON.stringify(message) + '\n');
  };

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        clients.add(socket);
        buffers.set(socket, '');
        onClientConnect?.();
      },
      data(socket, data) {
        let buffer = (buffers.get(socket) ?? '') + data.toString();
        if (buffer.length > 1_000_000) {
          onError?.(new Error('Canvas IPC input exceeds size limit'));
          send(socket, { type: 'error', message: 'Canvas IPC input too large' });
          socket.end();
          buffers.delete(socket);
          return;
        }

        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim()) {
            let message: ControllerMessage;
            try {
              message = parseControllerMessage(line);
            } catch {
              onError?.(new Error('Canvas IPC parse failed'));
              send(socket, { type: 'error', message: 'Invalid canvas IPC message' });
              newline = buffer.indexOf('\n');
              continue;
            }
            try {
              onMessage(message);
              if (message.type === 'update' || message.type === 'close') {
                send(socket, { type: 'ack', action: message.type });
              }
            } catch {
              onError?.(new Error(`Canvas IPC handler failed for ${message.type}`));
              send(socket, { type: 'error', message: `Canvas ${message.type} failed` });
            }
          }
          newline = buffer.indexOf('\n');
        }
        buffers.set(socket, buffer);
      },
      close(socket) {
        clients.delete(socket);
        buffers.delete(socket);
        onClientDisconnect?.();
      },
      error(_socket, error) {
        onError?.(error);
      },
    },
  });

  return {
    broadcast(message) {
      for (const client of clients) send(client, message);
    },
    close() {
      server.stop();
      if (existsSync(socketPath)) unlinkSync(socketPath);
    },
  };
}
