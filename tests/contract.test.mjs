/**
 * BotClient contract conformance. No real Minecraft server, no external
 * network: spins up an in-process minecraft-protocol server on a loopback
 * port (offline auth, random port), connects the mineflayer backend to it,
 * and walks src/mc/contract.js against the result.
 *
 * This is what turns the ~1000-call-site bot.* audit from a document into
 * an executable spec: it fails loudly if a name the rest of src/ depends on
 * stops being injected, and it's the target the native backend (M2+) has to
 * hit before any call site can be pointed at it.
 *
 *   bun tests/contract.test.mjs
 */
import mc from 'minecraft-protocol';
import { createMineflayerBot } from '../src/mc/backends/mineflayer.js';
import { checkContract, METHODS, EVENTS } from '../src/mc/contract.js';

let failures = 0;
const check = (name, cond) => {
    if (!cond) { console.error(`FAIL ${name}`); failures++; }
    else console.log(`ok - ${name}`);
};

const VERSION = '1.21.11'; // what settings.js actually connects as today

function startFakeServer() {
    const server = mc.createServer({
        'online-mode': false,
        port: 0,
        version: VERSION,
        maxPlayers: 1,
        motd: 'contract-test',
    });

    server.on('playerJoin', () => {
        // Deliberately not sending a `login` packet here. Confirmed
        // empirically: mineflayer injects bot.chat/bot.dig/etc. as soon as
        // the protocol handshake (encryption/compression/version) settles,
        // before any play-state packet arrives - and minecraft-data's
        // 1.21.11 loginPacket.dimension is undefined (the schema moved to a
        // different shape), which makes a hand-built login packet fail
        // protodef serialization and log noisily for no contract-test value.
    });
    server.on('error', () => { /* fake server errors are not what this test checks */ });

    return new Promise((resolve) => {
        server.on('listening', () => resolve(server));
    });
}

const server = await startFakeServer();
const port = server.socketServer.address().port;

const bot = createMineflayerBot({
    host: '127.0.0.1',
    port,
    username: 'contract-test',
    version: VERSION,
    auth: 'offline',
});
bot.on('error', () => { /* connection noise from the fake server, not under test */ });

// Give the handshake a moment to complete and inject plugin methods.
await new Promise((resolve) => setTimeout(resolve, 1500));

const { missing } = checkContract(bot);
check('all contract METHODS present on mineflayer backend', missing.length === 0);
if (missing.length) console.error('  missing:', missing.join(', '));

check('bot.command exists (chat/command split, M1)', typeof bot.command === 'function');
check('EVENTS list is non-empty (documents what a native backend must emit)', EVENTS.length > 0);
check('METHODS list is non-empty', METHODS.length > 0);
check('bot is a real EventEmitter (arbitrary property assignment must keep working)',
    typeof bot.on === 'function' && typeof bot.removeListener === 'function');

// Custom mindcraft properties must be assignable without the backend throwing
// or silently dropping them (agent.js, modes.js, swim_assist.js etc. rely on
// this) - not a Proxy, not sealed.
bot.output = 'probe';
check('arbitrary property assignment sticks (not sealed/frozen/Proxy)', bot.output === 'probe');

bot._client.end();
server.close();

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: BotClient contract holds for the mineflayer backend');
// The fake server's socket/timers can outlive close(); this test has nothing
// left to check once we get here, so exit explicitly rather than hang.
process.exit(0);
