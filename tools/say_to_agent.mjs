#!/usr/bin/env bun
/**
 * Send a message to a running agent through the MindServer, the way the web UI does.
 *
 *   bun tools/say_to_agent.mjs bob '!buildBlueprint("blueprints/survival_base.json", 4649, 70, 4605)'
 *   bun tools/say_to_agent.mjs andy 'what are you working on?'
 *
 * WHY NOT `mc "msg bob ..."`, which CLAUDE.md's quick reference suggests: measured 2026-09-22, the
 * RCON whisper produced no reply, no log line, and no reaction - bob went idle instead of building.
 * `msg` is in the class of commands whose output this server drops (as are `tp`, `say` and
 * `locate biome`), so a lost whisper is indistinguishable from a delivered one, and the failure is
 * silent on both sides.
 *
 * This path is observable instead: `send-message` reaches `mindserver_proxy.js:64` and calls the
 * agent's own respondFunc, exactly as the web UI's ADMIN box does (public/js/main.js:648). If the
 * agent is not connected the MindServer says so (`Agent <name> not in game`) rather than
 * swallowing it. Use ASCII quotes in the message - curly quotes parse as 0 arguments.
 */
import { io } from 'socket.io-client';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const [, , agent, ...rest] = process.argv;
const message = rest.filter(r => !r.startsWith('--') && r !== arg('waitMs', '')).join(' ');
if (!agent || !message) { console.error('usage: say_to_agent.mjs <agent> <message>'); process.exit(2); }
/**
 * CONFIRM THE AGENT IS THERE BEFORE CLAIMING DELIVERY. The MindServer drops a `send-message` for an
 * agent whose socket is not registered - it logs `Agent <name> not in game` on ITS console and
 * returns - so the sender sees success either way. Measured 2026-09-22: a send 25s after a restart
 * printed "sent to bob", bob went idle instead of building, and the resend two minutes later worked.
 * A tool that cannot tell a delivered command from a dropped one is worse than no tool, because the
 * next thing you debug is the bot.
 *
 * `listen-to-agents` makes the server emit `agents-status`, which carries in_game and
 * socket_connected per agent - the same feed the web UI's agent list uses.
 */
const socket = io('http://localhost:8080');
const deadline = Date.now() + Number(arg('waitMs', 30000));
let sent = false;

socket.on('connect', () => socket.emit('listen-to-agents'));
socket.on('agents-status', (agents) => {
    if (sent) return;
    const a = (agents ?? []).find(x => x.name === agent);
    if (a?.in_game && a?.socket_connected) {
        sent = true;
        socket.emit('send-message', agent, { from: 'ADMIN', message });
        console.log(`delivered to ${agent} (in_game, socket connected): ${message}`);
        setTimeout(() => { socket.disconnect(); process.exit(0); }, 1500);
        return;
    }
    if (Date.now() > deadline) {
        const why = !a ? 'not known to the MindServer'
            : !a.in_game ? 'known but not in game' : 'in game but its socket is not connected';
        console.error(`NOT SENT: ${agent} is ${why} - the MindServer would have dropped it silently`);
        socket.disconnect();
        process.exit(1);
    }
});
socket.on('connect_error', (e) => { console.error(`mindserver: ${e.message}`); process.exit(1); });
