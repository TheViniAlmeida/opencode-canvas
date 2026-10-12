import type { Plugin } from '@opencode/plugin';
import { sendCanvasMessage, socketPathFor } from './ipc.ts';
import { spawnCanvas, validateCanvas } from '../canvas/terminal.ts';

const textResult = (value: object) => ({ content: JSON.stringify(value) });
const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a nonempty string`);
  return value;
};

function parseConfig(value: unknown): object {
  const raw = requiredString(value, 'config');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid canvas config JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Canvas config must be a JSON object');
  }
  return parsed;
}

function asInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid tool input');
  return input as Record<string, unknown>;
}

export async function registerCanvasTools(ctx: Plugin.Context, pluginRoot: string) {
  return ctx.tool.transform(editor => {
    editor.add({
      name: 'canvas_spawn',
      description: 'Spawn an interactive calendar, document, or flight canvas in a tmux pane. Config is a JSON object encoded as a string.',
      input: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['calendar', 'document', 'flight'] },
          scenario: { type: 'string' },
          config: { type: 'string' },
        },
        required: ['kind', 'config'],
        additionalProperties: false,
      },
      async execute(input) {
        try {
          const args = asInput(input);
          const kind = requiredString(args.kind, 'kind');
          const scenario = args.scenario === undefined ? undefined : requiredString(args.scenario, 'scenario');
          const config = requiredString(args.config, 'config');
          validateCanvas(kind, `${kind}-validation`, scenario, config);
          const id = `${kind}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
          const result = await spawnCanvas(kind, id, config, { scenario, pluginRoot });
          return textResult({ success: true, id, kind, ...result });
        } catch (error) {
          return textResult({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    });

    editor.add({
      name: 'canvas_update',
      description: 'Send updated JSON configuration to a running canvas.',
      input: {
        type: 'object',
        properties: { id: { type: 'string' }, config: { type: 'string' } },
        required: ['id', 'config'],
        additionalProperties: false,
      },
      async execute(input) {
        let id: string | undefined;
        try {
          const args = asInput(input);
          id = requiredString(args.id, 'id');
          const config = parseConfig(args.config);
          await sendCanvasMessage(socketPathFor(id), { type: 'update', config }, 'ack');
          return textResult({ success: true, id });
        } catch (error) {
          return textResult({ success: false, id, error: error instanceof Error ? error.message : String(error) });
        }
      },
    });

    editor.add({
      name: 'canvas_selection',
      description: 'Read the current selection from a document canvas.',
      input: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      async execute(input) {
        let id: string | undefined;
        try {
          id = requiredString(asInput(input).id, 'id');
          const reply = await sendCanvasMessage(socketPathFor(id), { type: 'getSelection' }, 'selection');
          return textResult({ success: true, id, selection: reply?.data ?? null });
        } catch (error) {
          return textResult({ success: false, id, selection: null, error: error instanceof Error ? error.message : String(error) });
        }
      },
    });

    editor.add({
      name: 'canvas_close',
      description: 'Close a running canvas.',
      input: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      async execute(input) {
        let id: string | undefined;
        try {
          id = requiredString(asInput(input).id, 'id');
          await sendCanvasMessage(socketPathFor(id), { type: 'close' }, 'ack');
          return textResult({ success: true, id, closed: true });
        } catch (error) {
          return textResult({ success: false, id, closed: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    });
  });
}
