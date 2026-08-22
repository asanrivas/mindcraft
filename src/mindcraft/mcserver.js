import net from 'net';
import mc from 'minecraft-protocol';
import minecraftData from 'minecraft-data';

/**
 * Maps a protocol number (response.version.protocol) to the real Minecraft
 * major version, via minecraft-data's own protocol table - the same table
 * mineflayer, prismarine-chunk and prismarine-registry are keyed on.
 *
 * This used to be skipped entirely: mcserver.js only regex-extracted a
 * version from the server's ping *name* string (e.g. "Purpur 1.21.11"),
 * which is a label the server operator chose and can lag or misrepresent
 * the real protocol. Against this server that mislabeling is exactly what
 * hid the 1.21.11-vs-26.1 mismatch documented in CLAUDE.md - see "Movement".
 *
 * @returns {string|null} the majorVersion (e.g. "26.1"), or null if this
 *   protocol number isn't in minecraft-data's table.
 */
function majorVersionForProtocol(protocol) {
    const entries = minecraftData.postNettyVersionsByProtocolVersion?.pc?.[protocol];
    if (!entries || entries.length === 0) return null;
    return entries[0].majorVersion || entries[0].minecraftVersion || null;
}

/**
 * Gets the player count from a Minecraft server.
 * @param {string} ip - The server IP address.
 * @param {number} port - The server port.
 * @param {number} timeout - The connection timeout in ms.
 * @returns {Promise<Object|null>} - Player info {online, max, sample} or null if failed.
 */
export async function getPlayerCount(ip, port, timeout = 3000) {
    return new Promise((resolve) => {
        let timeoutId = setTimeout(() => {
            resolve(null);
        }, timeout);

        mc.ping({
            host: ip,
            port
        }, (err, response) => {
            clearTimeout(timeoutId);

            if (err) {
                return resolve(null);
            }

            const players = response?.players || { online: 0, max: 0, sample: [] };
            resolve({
                online: players.online || 0,
                max: players.max || 0,
                sample: players.sample || []
            });
        });
    });
}

/**
 * Scans the IP address for Minecraft LAN servers and collects their info.
 * @param {string} ip - The IP address to scan.
 * @param {number} port - The port to check.
 * @param {number} timeout - The connection timeout in ms.
 * @param {boolean} verbose - Whether to print output on connection errors.
 * @returns {Promise<Array>} - A Promise that resolves to an array of server info objects.
 */
export async function serverInfo(ip, port, timeout = 1000, verbose = false) {
    return new Promise((resolve) => {

        let timeoutId = setTimeout(() => {
            if (verbose)
                console.error(`Timeout pinging server ${ip}:${port}`);
            resolve(null); // Resolve as null if no response within timeout
        }, timeout);

        mc.ping({
            host: ip,
            port
        }, (err, response) => {
            clearTimeout(timeoutId);

            if (err) {
                if (verbose)
                    console.error(`Error pinging server ${ip}:${port}`, err);
                return resolve(null);
            }

            // extract version number from modded servers like "Paper 1.21.4"
            const version = response?.version?.name || '';
            const match = String(version).match(/\d+\.\d+(?:\.\d+)?/);
            const numericVersion = match ? match[0] : null;
            if (numericVersion !== version) {
                console.log(`Modded server found (${version}), attempting to use ${numericVersion}...`);
            }

            // The name string is a label the operator chose and can lag the
            // real protocol (this server's says "Purpur 1.21.11" while
            // protocol 775 is actually 26.1). Cross-check it here so the
            // mismatch is visible instead of silently ignored - but keep
            // `version` (the string mindcraft.js actually connects with)
            // pinned to the name-derived value: mineflayer's testedVersions
            // gate still caps at 1.21.11, so switching the connect version
            // to the true protocol version would break the live bot until
            // that gate is lifted (see settings.mc_client / CLAUDE.md).
            const protocol = response?.version?.protocol ?? null;
            const majorVersion = protocol != null ? majorVersionForProtocol(protocol) : null;
            if (majorVersion && majorVersion !== numericVersion) {
                console.log(`[mcserver] Server ping name says "${numericVersion}" but protocol ${protocol} is actually Minecraft ${majorVersion}. Connecting as ${numericVersion} - the mineflayer backend's testedVersions gate caps there; see settings.mc_client and CLAUDE.md "Movement".`);
            }

            const serverInfo = {
                host: ip,
                port,
                name: response.description.text || 'No description provided.',
                ping: response.latency,
                version: numericVersion,
                protocol,
                majorVersion,
            };

            resolve(serverInfo);
        });
    });
}

/**
 * Scans the IP address for Minecraft LAN servers and collects their info.
 * @param {string} ip - The IP address to scan.
 * @param {boolean} earlyExit - Whether to exit early after finding a server.
 * @param {number} timeout - The connection timeout in ms.
 * @returns {Promise<Array>} - A Promise that resolves to an array of server info objects.
 */
export async function findServers(ip, earlyExit = false, timeout = 100) {
    const servers = [];
    const startPort = 49000;
    const endPort = 65000;

    const checkPort = (port) => {
        return new Promise((resolve) => {
            const socket = net.createConnection({ host: ip, port, timeout }, () => {
                socket.end();
                resolve(port); // Port is open
            });

            socket.on('error', () => resolve(null)); // Port is closed
            socket.on('timeout', () => {
                socket.destroy();
                resolve(null);
            });
        });
    };

    // This supresses a lot of annoying console output from the mc library
    // TODO: find a better way to do this, it supresses other useful output
    const originalConsoleLog = console.log;
    console.log = () => { };
    
    for (let port = startPort; port <= endPort; port++) {
        const openPort = await checkPort(port);
        if (openPort) {
            const server = await serverInfo(ip, port, 200, false);
            if (server) {
                servers.push(server);

                if (earlyExit) break;
            }
        }
    }

    // Restore console output
    console.log = originalConsoleLog;

    return servers;
}

/**
 * Gets the MC server info from the host and port.
 * @param {string} host - The host to search for.
 * @param {number} port - The port to search for.
 * @param {string} version - The version to search for.
 * @returns {Promise<Object>} - A Promise that resolves to the server info object.
 */
export async function getServer(host, port, version) {
    let server = null;
    let serverString = "";
    let serverVersion = "";
    
    // Search for server
    if (port == -1)
    {
        console.log(`No port provided. Searching for LAN server on host ${host}...`);
        
        await findServers(host, true).then((servers) => {
            if (servers.length > 0)
                server = servers[0];
        });

        if (server == null)
            throw new Error(`No server found on LAN.`);
    }
    else
        server = await serverInfo(host, port, 1000, true);

    // Server not found
    if (server == null) 
        throw new Error(`MC server not found. (Host: ${host}, Port: ${port}) Check the host and port in settings.js, and ensure the server is running and open to public or LAN.`);

    serverString = `(Host: ${server.host}, Port: ${server.port}, Version: ${server.version})`;

    if (version === "auto")
        serverVersion = server.version;
    else
        serverVersion = version;

    // Server version unsupported / mismatch
    if (mc.supportedVersions.indexOf(serverVersion) === -1) {
        // If server version unsupported and we have a specific version set, use that
        if (version !== "auto" && mc.supportedVersions.indexOf(version) !== -1) {
            console.warn(`warn: Server version ${server.version} unsupported, forcing ${version}...`);
            server.version = version;
        } else {
            throw new Error(`MC server was found ${serverString}, but version is unsupported. Supported versions are: ${mc.supportedVersions.join(", ")}.`);
        }
    } else if (version !== "auto" && server.version !== version) {
        console.warn(`warn: Server reports ${server.version}, but forcing ${version} as configured.`);
        server.version = version;
    } else {
        console.log(`MC server found. ${serverString}`);
    }

    return server;
}