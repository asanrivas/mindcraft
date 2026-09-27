import settings from '../settings.js';
import prismarineViewer from 'prismarine-viewer';
const mineflayerViewer = prismarineViewer.mineflayer;

export function addBrowserViewer(bot, count_id) {
    if (!settings.render_bot_view) return;
    // First person is the default here because `!vision` screenshots this same viewer and wants
    // the bot's own eyes. Third person is what a follow-cam recording needs: in first person the
    // client DISPOSES its OrbitControls (lib/index.js), and `tools/timelapse.mjs` drives those
    // controls to park the camera overhead. Opt in via settings, then restart the bot.
    const firstPerson = settings.viewer_first_person !== false;
    // Base is settable so a second main.js on the same host does not collide on 3000. The
    // collision is fatal, not cosmetic: express's listen error is async and escapes the
    // try/catch in agent.js, killing the agent after it has already reported "logged in".
    const base = Number(settings.viewer_port_base) || 3000;
    mineflayerViewer(bot, { port: base + count_id, firstPerson });
}