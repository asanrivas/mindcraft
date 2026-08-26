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
    mineflayerViewer(bot, { port: 3000 + count_id, firstPerson });
}