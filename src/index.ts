import path from 'node:path';
import { Plugin } from '@opencode/plugin';
import { loadCatalog } from './plugin/catalog.ts';
import { registerCanvasTools } from './plugin/tools.ts';

export const CanvasPlugin = Plugin.define({
  id: 'opencode-canvas',
  async setup(ctx) {
    // Both src/index.ts and dist/index.js live one level below the package root.
    const pluginRoot = path.resolve(import.meta.dir, '..');
    const { skills, commands } = await loadCatalog(pluginRoot);

    const toolRegistration = await registerCanvasTools(ctx, pluginRoot);
    const skillRegistration = await ctx.skill.transform(editor => {
      for (const skill of skills) editor.add(skill);
    });
    const commandRegistration = await ctx.command.transform(editor => {
      for (const command of commands) {
        editor.add({
          name: command.name,
          description: command.description,
          async execute({ sessionID, prompt, delivery }) {
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              text: command.template + (prompt.text ? `\n\n${prompt.text}` : ''),
              delivery,
            });
          },
        });
      }
    });

    return async () => {
      await commandRegistration.dispose();
      await skillRegistration.dispose();
      await toolRegistration.dispose();
    };
  },
});

export default CanvasPlugin;
