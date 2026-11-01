import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from '@opencode/plugin';
import type { Info, ToolContext } from '@opencode/plugin/promise/tool';

// Uses a private tmux server and synthetic content; no running OpenCode configuration is read.
const entry = path.resolve(process.argv[2] || 'dist/index.js');
const plugin = (await import(pathToFileURL(entry).href)).default;
const tools = new Map<string, Info>();
const registration = { async dispose() {} };
const context = {
  tool: {
    async transform(callback: (editor: { add(tool: Info): void }) => void) {
      callback({ add: (tool) => tools.set(tool.name, tool) });
      return registration;
    },
  },
  skill: { async transform() { return registration; } },
  command: { async transform() { return registration; } },
} as unknown as Plugin.Context;
const cleanup = await plugin.setup(context);
const label = `canvas-smoke-${process.pid}`;
const tmux = (...args: string[]) => {
  const result = Bun.spawnSync(['tmux', '-L', label, ...args]);
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return result.stdout.toString().trim();
};
const originalTmux = process.env.TMUX;
const originalPane = process.env.TMUX_PANE;
const execute = async (name: string, input: unknown) => {
  const tool = tools.get(name);
  assert.ok(tool, `Missing ${name}`);
  const result = await tool.execute(input, {} as ToolContext);
  assert.equal(typeof result.content, 'string');
  const output = JSON.parse(result.content as string);
  assert.equal(output.success, true, JSON.stringify(output));
  return output;
};

try {
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'smoke', '-x', '180', '-y', '60', 'sleep 120');
  process.env.TMUX = tmux('display-message', '-p', '#{socket_path},#{pid},0');
  process.env.TMUX_PANE = tmux('display-message', '-p', '#{pane_id}');
  const scenarios = [
    { kind: 'calendar', scenario: 'display', config: { title: 'Calendar smoke', events: [] } },
    { kind: 'calendar', scenario: 'meeting-picker', config: { title: 'Meeting smoke', calendars: [] } },
    { kind: 'document', scenario: 'edit', config: { title: 'Document smoke', content: '# Synthetic notes' } },
    {
      kind: 'flight',
      scenario: 'booking',
      config: {
        title: 'Flight smoke',
        flights: [{
          id: 'synthetic-flight', airline: 'Test airline', flightNumber: 'TEST 1',
          origin: { code: 'AAA', name: 'Origin', city: 'Origin', timezone: 'UTC' },
          destination: { code: 'BBB', name: 'Destination', city: 'Destination', timezone: 'UTC' },
          departureTime: '2026-10-12T10:00:00Z', arrivalTime: '2026-10-12T11:00:00Z',
          duration: 60, price: 10000, currency: 'USD', cabinClass: 'economy', stops: 0,
          seatmap: { rows: 4, seatsPerRow: ['A', 'B', 'C'], aisleAfter: ['B'],
            unavailable: [], premium: ['1A'], occupied: ['2B'] },
        }],
      },
    },
  ];
  for (const fixture of scenarios) {
    const spawn = await execute('canvas_spawn', { ...fixture, config: JSON.stringify(fixture.config) });
    await execute('canvas_update', { id: spawn.id, config: JSON.stringify({ ...fixture.config, title: 'Updated smoke' }) });
    if (fixture.kind === 'document') {
      const selection = await execute('canvas_selection', { id: spawn.id });
      assert.equal(selection.selection, null);
    }
    await execute('canvas_close', { id: spawn.id });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!tmux('list-panes', '-F', '#{pane_id}').split('\n').includes(spawn.paneId)) break;
      await Bun.sleep(50);
    }
    assert.ok(!tmux('list-panes', '-F', '#{pane_id}').split('\n').includes(spawn.paneId), 'Canvas pane must exit after close');
    assert.equal(await Bun.file(spawn.socketPath).exists(), false, 'Canvas socket must be removed');
    process.stdout.write(`PASS ${fixture.kind}/${fixture.scenario}: spawn, update, close${fixture.kind === 'document' ? ', selection' : ''}\n`);
  }
} finally {
  Bun.spawnSync(['tmux', '-L', label, 'kill-server']);
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
  if (originalPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = originalPane;
  await cleanup?.();
}
