import type { Socket } from 'bun';

type CanvasReply = { type: string; action?: unknown; data?: unknown; message?: string };

export function validateCanvasId(id: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(id)) {
    throw new Error('Invalid canvas id');
  }
}

export function socketPathFor(id: string): string {
  validateCanvasId(id);
  return `/tmp/canvas-${id}.sock`;
}

export async function sendCanvasMessage(
  socketPath: string,
  message: object,
  expectedType: string,
  timeoutMs = 2000,
): Promise<CanvasReply> {
  const action = 'type' in message ? message.type : undefined;
  return new Promise((resolve, reject) => {
    let socket: Socket<unknown> | undefined;
    let settled = false;
    let buffer = '';
    const finish = (error?: Error, reply?: CanvasReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket?.end();
      if (error) reject(error);
      else if (reply) resolve(reply);
      else reject(new Error('Canvas IPC response missing'));
    };
    const timeout = setTimeout(() => finish(new Error(`Canvas IPC timeout after ${timeoutMs}ms`)), timeoutMs);

    void Bun.connect({
      unix: socketPath,
      socket: {
        open(connected) {
          socket = connected;
          if (settled) {
            connected.end();
            return;
          }
          connected.write(JSON.stringify(message) + '\n');
        },
        data(_connected, data) {
          if (settled) return;
          buffer += data.toString();
          if (buffer.length > 1_000_000) return finish(new Error('Canvas IPC response too large'));
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
              const reply = JSON.parse(line) as CanvasReply;
              if (reply.type === 'error') return finish(new Error(reply.message || 'Canvas IPC error'));
              if (reply.type === expectedType) {
                if (expectedType === 'ack' && reply.action !== action) {
                  return finish(new Error('Canvas IPC acknowledgment does not match request'));
                }
                return finish(undefined, reply);
              }
            } catch (error) {
              return finish(error instanceof Error ? error : new Error('Invalid canvas IPC response'));
            }
            newline = buffer.indexOf('\n');
          }
        },
        close() {
          if (!settled) finish(new Error('Canvas IPC closed before responding'));
        },
        error(_connected, error) {
          finish(error);
        },
      },
    }).then(connected => {
      socket = connected;
      if (settled) connected.end();
    }).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}
