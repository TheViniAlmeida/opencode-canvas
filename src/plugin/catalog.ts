import path from 'node:path';
import { Skill } from '@opencode/plugin';

type Frontmatter = { name?: string; description?: string };

export type CanvasSkill = Skill.Info;

export interface CanvasCommand {
  name: string;
  description?: string;
  template: string;
}

export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: normalized.trim() };

  const frontmatter: Frontmatter = {};
  const lines = match[1].split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const field = line.match(/^(name|description):\s*(.*)$/);
    if (!field) continue;
    const key = field[1] as keyof Frontmatter;
    let value = field[2];
    if (value === '|' || value === '>') {
      const folded = value === '>';
      const block: string[] = [];
      while (index + 1 < lines.length && (lines[index + 1].startsWith('  ') || lines[index + 1] === '')) {
        block.push(lines[++index].replace(/^  /, ''));
      }
      value = block.join(folded ? ' ' : '\n').trim();
    } else {
      value = value.replace(/^("|')(.*)\1$/, '$2');
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body: match[2].trim() };
}

export async function loadCatalog(pluginRoot: string): Promise<{ skills: CanvasSkill[]; commands: CanvasCommand[] }> {
  const skillRoot = path.join(pluginRoot, '.opencode', 'skill');
  const commandRoot = path.join(pluginRoot, 'src', 'command');
  const skills: CanvasSkill[] = [];
  const commands: CanvasCommand[] = [];

  for await (const file of new Bun.Glob('**/SKILL.md').scan({ cwd: skillRoot, absolute: true })) {
    if (!path.isAbsolute(file)) throw new Error(`Skill path is not absolute: ${file}`);
    const { frontmatter, body } = parseFrontmatter(await Bun.file(file).text());
    const fallback = path.dirname(path.relative(skillRoot, file));
    const name = frontmatter.name || fallback;
    skills.push({
      id: Skill.ID.make(`opencode-canvas:${name}`),
      name: Skill.Name.make(name),
      description: frontmatter.description,
      path: file as Skill.Info['path'],
      content: body,
    });
  }

  for await (const file of new Bun.Glob('**/*.md').scan({ cwd: commandRoot, absolute: true })) {
    const { frontmatter, body } = parseFrontmatter(await Bun.file(file).text());
    const name = path.relative(commandRoot, file).replace(/\.md$/, '').split(path.sep).join('-');
    commands.push({ name, description: frontmatter.description, template: body });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, commands };
}
