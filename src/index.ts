/**
 * OpenCode Canvas Plugin
 *
 * Interactive terminal canvases (TUIs) for OpenCode:
 * - Calendar: Display events and pick meeting times
 * - Document: View/edit markdown documents with text selection
 * - Flight: Compare flights and select seats
 *
 * Requires: tmux session, Bun runtime
 */

import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import path from 'path';

// ============================================================
// SKILL LOADER
// Loads SKILL.md files from .opencode/skill/ directory
// ============================================================

interface SkillFrontmatter {
  name?: string;
  description?: string;
}

interface ParsedSkill {
  name: string;
  frontmatter: SkillFrontmatter;
  content: string;
}

function parseSkillFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  const [, yamlContent, body] = match;
  const frontmatter: SkillFrontmatter = {};

  for (const line of yamlContent.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key === 'name') frontmatter.name = value;
    if (key === 'description') frontmatter.description = value;
  }

  return { frontmatter, body: body.trim() };
}

async function loadSkills(): Promise<ParsedSkill[]> {
  const skills: ParsedSkill[] = [];
  // Go up from src/ to find .opencode/skill/
  const skillDir = path.join(import.meta.dir, '..', '.opencode', 'skill');
  const glob = new Bun.Glob('**/SKILL.md');

  try {
    for await (const file of glob.scan({ cwd: skillDir, absolute: true })) {
      const content = await Bun.file(file).text();
      const { frontmatter, body } = parseSkillFrontmatter(content);

      // Extract skill name from directory (e.g., "canvas/SKILL.md" -> "canvas")
      const relativePath = path.relative(skillDir, file);
      const name = path.dirname(relativePath);

      skills.push({
        name: frontmatter.name || name,
        frontmatter,
        content: body,
      });
    }
  } catch {
    // Skills directory may not exist in all environments
  }

  return skills;
}

// ============================================================
// COMMAND LOADER
// Loads .md files from src/command/ directory as slash commands
// ============================================================

interface CommandFrontmatter {
  description?: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
}

interface ParsedCommand {
  name: string;
  frontmatter: CommandFrontmatter;
  template: string;
}

function parseFrontmatter(content: string): { frontmatter: CommandFrontmatter; body: string } {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  const [, yamlContent, body] = match;
  const frontmatter: CommandFrontmatter = {};

  for (const line of yamlContent.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key === 'description') frontmatter.description = value;
    if (key === 'agent') frontmatter.agent = value;
    if (key === 'model') frontmatter.model = value;
    if (key === 'subtask') frontmatter.subtask = value === 'true';
  }

  return { frontmatter, body: body.trim() };
}

async function loadCommands(): Promise<ParsedCommand[]> {
  const commands: ParsedCommand[] = [];
  const commandDir = path.join(import.meta.dir, 'command');
  const glob = new Bun.Glob('**/*.md');

  try {
    for await (const file of glob.scan({ cwd: commandDir, absolute: true })) {
      const content = await Bun.file(file).text();
      const { frontmatter, body } = parseFrontmatter(content);

      const relativePath = path.relative(commandDir, file);
      const name = relativePath.replace(/\.md$/, '').replace(/\//g, '-');

      commands.push({
        name,
        frontmatter,
        template: body,
      });
    }
  } catch {
    // Command directory may not exist
  }

  return commands;
}

// ============================================================
// CANVAS TOOLS
// ============================================================

// Get the plugin root directory
const getPluginRoot = () => path.join(import.meta.dir, '..');

export const CanvasPlugin: Plugin = async () => {
  const commands = await loadCommands();
  const skills = await loadSkills();
  const pluginRoot = getPluginRoot();

  // ============================================================
  // CANVAS SPAWN TOOL
  // ============================================================
  const canvasSpawn = tool({
    description: `Spawn an interactive terminal canvas (calendar, document, flight) in a tmux split pane.

**Canvas Types:**
- calendar: Display calendars or pick meeting times (scenarios: display, meeting-picker)
- document: View/edit markdown documents with text selection (scenarios: display, edit, email-preview)
- flight: Compare flights and select seats (scenarios: booking)

**Requirements:** Must be running inside tmux.

**Returns:** JSON with { success, id, kind, scenario, socketPath }`,
    args: {
      kind: tool.schema.enum(['calendar', 'document', 'flight']).describe('Type of canvas to spawn'),
      scenario: tool.schema
        .string()
        .optional()
        .describe('Interaction mode: display, edit, meeting-picker, booking, email-preview'),
      config: tool.schema.string().describe('JSON configuration for the canvas'),
    },
    async execute(args: { kind: 'calendar' | 'document' | 'flight'; scenario?: string; config: string }) {
      const { kind, scenario, config } = args;
      const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const configFile = `/tmp/canvas-config-${id}.json`;
      const socketPath = `/tmp/canvas-${id}.sock`;

      // Check if in tmux
      if (!process.env.TMUX) {
        return JSON.stringify({
          success: false,
          error: 'Canvas requires tmux. Please run inside a tmux session.',
          id,
          kind,
        });
      }

      // Write config to temp file
      await Bun.write(configFile, config);

      // Build command
      let cmd = `${pluginRoot}/run-canvas.sh show ${kind} --id ${id} --socket ${socketPath}`;
      cmd += ` --config "$(cat ${configFile})"`;
      if (scenario) {
        cmd += ` --scenario ${scenario}`;
      }

      // Spawn in tmux split pane
      const proc = Bun.spawn(['tmux', 'split-window', '-h', '-p', '67', cmd], {
        stdout: 'inherit',
        stderr: 'inherit',
      });

      const exitCode = await proc.exited;

      return JSON.stringify({
        success: exitCode === 0,
        id,
        kind,
        scenario: scenario || 'display',
        socketPath,
      });
    },
  });

  // ============================================================
  // CANVAS UPDATE TOOL
  // ============================================================
  const canvasUpdate = tool({
    description: `Send updated configuration to a running canvas via IPC.

Use this to dynamically update a canvas that was previously spawned with canvas_spawn.

**Returns:** JSON with { success, id }`,
    args: {
      id: tool.schema.string().describe('Canvas instance ID (returned from canvas_spawn)'),
      config: tool.schema.string().describe('New JSON configuration to send to the canvas'),
    },
    async execute(args: { id: string; config: string }) {
      const { id, config } = args;
      const socketPath = `/tmp/canvas-${id}.sock`;

      try {
        const parsedConfig = JSON.parse(config);

        return new Promise<string>((resolve) => {
          let resolved = false;
          const timeout = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              resolve(JSON.stringify({ success: false, id, error: 'Timeout connecting to canvas' }));
            }
          }, 2000);

          Bun.connect({
            unix: socketPath,
            socket: {
              data() {},
              open(socket) {
                const msg = JSON.stringify({ type: 'update', config: parsedConfig });
                socket.write(msg + '\n');
                socket.end();
                if (!resolved) {
                  resolved = true;
                  clearTimeout(timeout);
                  resolve(JSON.stringify({ success: true, id }));
                }
              },
              close() {
                if (!resolved) {
                  resolved = true;
                  clearTimeout(timeout);
                  resolve(JSON.stringify({ success: true, id }));
                }
              },
              error(_socket, error) {
                if (!resolved) {
                  resolved = true;
                  clearTimeout(timeout);
                  resolve(JSON.stringify({ success: false, id, error: error.message }));
                }
              },
            },
          }).catch((err: Error) => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              resolve(JSON.stringify({ success: false, id, error: `Failed to connect: ${err.message}` }));
            }
          });
        });
      } catch (err) {
        return JSON.stringify({ success: false, id, error: `Invalid config JSON: ${err}` });
      }
    },
  });

  // ============================================================
  // CANVAS SELECTION TOOL
  // ============================================================
  const canvasSelection = tool({
    description: `Get the current text selection from a running document canvas.

Use this to retrieve what the user has selected in a document canvas.

**Returns:** JSON with { success, id, selection: { selectedText, startOffset, endOffset } | null }`,
    args: {
      id: tool.schema.string().describe('Canvas instance ID (returned from canvas_spawn)'),
    },
    async execute(args: { id: string }) {
      const { id } = args;
      const socketPath = `/tmp/canvas-${id}.sock`;

      return new Promise<string>((resolve) => {
        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve(JSON.stringify({ success: false, id, selection: null, error: 'Timeout' }));
          }
        }, 2000);

        Bun.connect({
          unix: socketPath,
          socket: {
            data(_socket, data) {
              if (resolved) return;
              clearTimeout(timeout);
              resolved = true;
              try {
                const response = JSON.parse(data.toString().trim());
                if (response.type === 'selection') {
                  resolve(JSON.stringify({ success: true, id, selection: response.data }));
                } else {
                  resolve(JSON.stringify({ success: true, id, selection: null }));
                }
              } catch {
                resolve(JSON.stringify({ success: false, id, selection: null, error: 'Parse error' }));
              }
              _socket.end();
            },
            open(socket) {
              socket.write(JSON.stringify({ type: 'getSelection' }) + '\n');
            },
            close() {
              if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                resolve(JSON.stringify({ success: true, id, selection: null }));
              }
            },
            error(_socket, error) {
              if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                resolve(JSON.stringify({ success: false, id, selection: null, error: error.message }));
              }
            },
          },
        }).catch((err: Error) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(JSON.stringify({ success: false, id, selection: null, error: err.message }));
          }
        });
      });
    },
  });

  // ============================================================
  // CANVAS CLOSE TOOL
  // ============================================================
  const canvasClose = tool({
    description: 'Close a running canvas instance',
    args: {
      id: tool.schema.string().describe('Canvas instance ID'),
    },
    async execute(args: { id: string }) {
      const { id } = args;
      const socketPath = `/tmp/canvas-${id}.sock`;

      return new Promise<string>((resolve) => {
        const timeout = setTimeout(() => resolve(JSON.stringify({ success: true, id, closed: true })), 1000);

        Bun.connect({
          unix: socketPath,
          socket: {
            open(socket) {
              socket.write(JSON.stringify({ type: 'close' }) + '\n');
              clearTimeout(timeout);
              socket.end();
              resolve(JSON.stringify({ success: true, id, closed: true }));
            },
            data() {},
            close() {
              clearTimeout(timeout);
              resolve(JSON.stringify({ success: true, id, closed: true }));
            },
            error() {
              clearTimeout(timeout);
              resolve(JSON.stringify({ success: true, id, closed: true }));
            },
          },
        }).catch(() => {
          clearTimeout(timeout);
          resolve(JSON.stringify({ success: true, id, closed: true }));
        });
      });
    },
  });

  return {
    // Register canvas tools
    tool: {
      canvas_spawn: canvasSpawn,
      canvas_update: canvasUpdate,
      canvas_selection: canvasSelection,
      canvas_close: canvasClose,
    },

    // Register skills
    skill: Object.fromEntries(skills.map((s) => [s.name, { description: s.frontmatter.description, content: s.content }])),

    // Config hook for commands
    async config(config: Record<string, unknown>) {
      const commandRecord = (config.command ?? {}) as Record<string, unknown>;

      for (const cmd of commands) {
        commandRecord[cmd.name] = {
          template: cmd.template,
          description: cmd.frontmatter.description,
          agent: cmd.frontmatter.agent,
          model: cmd.frontmatter.model,
          subtask: cmd.frontmatter.subtask,
        };
      }

      config.command = commandRecord;
    },
  };
};
