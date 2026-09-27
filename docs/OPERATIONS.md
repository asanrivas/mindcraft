# Operations — processes, recording, web UI, common issues

Running the stack: the duplicate-process crash loop, the bird-view timelapse recorder and its
viewer-asset patching, the web UI endpoints, and the short list of recurring symptoms.

> **Provenance.** Everything below was in `CLAUDE.md` until the 2026-08-31 restructure.
> CLAUDE.md keeps the RULES; this file keeps the EVIDENCE — the measurements, the log
> excerpts and the incidents that produced each rule. Text is verbatim; heading levels
> are demoted by one so they nest under this file's title.

### Two `main.js` processes = an endless bot crash-loop

Symptom: a bot joining and leaving every ~14 seconds, forever.

```
[Event] bob left the game
[Event] bob joined the game
Agent bob disconnected
WARN: Bot kicked! { translate: "multiplayer.disconnect.duplicate_login" }
[Watchdog] Force restart scheduled in 5000ms
```

Two `main.js` instances were running, each with its own MindServer (the second binds **8082**
because 8080 is taken) and each spawning its own `bob`. Two clients on one account evict each
other with `duplicate_login`, and `agent.js`'s `kicked` handler schedules a 5-second auto-restart
for whichever was evicted - so the pair kick each other in perpetuity, burning a model call per
respawn. `mc "list"` shows only ONE bob, which is what makes it confusing: the duplicate is never
online long enough to be listed.

Diagnosis is one command - **look for two mains, or a second MindServer port**:

```bash
ps -eo pid,etimes,cmd | grep -E "bun (run main|.*init_agent)"
```

`scratchpad/restart_bot.sh` now kills the parents first (`main.js` respawns a dead agent by
itself, so killing `init_agent.js` alone just brings it back), waits until they are really gone
rather than sleeping a fixed 4 seconds, and **refuses to start if anything survives**.

**Anchor any `ps | grep` guard at the executable.** An unanchored pattern also matches any SHELL
whose command line contains it - including the command invoking the check - so the guard refused
to start with nothing running at all.


### Recording a run (bird-view timelapse)

```bash
bun tools/setup_viewer_assets.mjs          # once, and after every `bun install`
# settings.js: viewer_first_person: false  # then restart the bot
bun tools/timelapse.mjs --seconds 1800 --interval 5   # --height defaults to 16
# -> recordings/timelapse-3000-<timestamp>.mp4  (recordings/ is gitignored)
```

**The viewer renders the wrong blocks out of the box.** prismarine-viewer ships textures and
block states only up to **1.21.4**, and its prebuilt browser bundle only carries minecraft-data
for those versions - against this 1.21.11 server that is **107 block types** rendering as the
wrong block or vanishing: pale oak (every variant), copper chest, copper golem statue, firefly
bush, cactus flower, leaf litter, wildflowers, dried ghast, dry grass, the whole shelf family.

`tools/setup_viewer_assets.mjs` fixes it, and it is idempotent. What it does, and why each step
is needed:

1. Fetches `minecraft-assets` into `.viewer-assets-cache/` - kept OUT of the project's own
   dependencies because it unpacks to ~142MB.
2. Builds the atlas and block states. It must NOT call `require('minecraft-assets')('1.21.11')`:
   that package's own version table stops at 1.21.8, so it silently returns the **1.21.8**
   directory. The real `data/1.21.11` exists on disk and the generators only need
   `directory`, `blocksStates` and `blocksModels`, so the script builds that object itself.
3. Registers the version in `viewer/lib/version.js`.
4. Patches `lib/index.js` to expose `window.pv` - see below.
5. **Rebuilds the browser bundles.** This is the step that is easy to miss: adding the version
   without rebuilding gets you `Using version: 1.21.11` followed by
   `Error: Do not have data for 1.21.11` and a null world - the viewer renders *nothing*, which
   is worse than wrong textures. The worker bundle grows 63MB -> 121MB and takes ~4.5 min; the
   index bundle alone is ~6s.

**Everything above lives in `node_modules`, so `bun install` wipes it.** Re-run the script.

#### Why the timelapse tool needs `window.pv`

The client keeps `viewer` and `controls` as module locals, and in third person it aims
`controls.target` at the bot **only on the first position update** - so a headless screenshotter
has no way to place the camera, and the bot walks out of frame within seconds. The patch exposes
the scene graph and tracks the latest position, and `birdCam(height)` parks the camera directly
overhead. That is what makes it a follow-cam instead of a fixed shot of the starting point.

`viewer_first_person` (settings.js) must be **false**: first person makes the client *dispose*
the OrbitControls the camera driver depends on. It defaults to true because `!vision` screenshots
this same viewer and wants the bot's own eyes - so flip it for a recording run and flip it back.

**Cost.** Headless Chromium has no GPU here, so the viewer's WebGL runs on SwiftShader at about
**6.7 of this machine's 8 cores** while the scene renders. That is why frames are taken on an
interval, not continuously. Shorten `--interval` only while watching server tick health.

**The efficient path is closed.** prismarine-viewer has a proper headless renderer
(`lib/headless.js`, node-canvas-webgl straight into ffmpeg, no browser) - but it needs `gl`, a
NAN native module, and this project runs on **bun**, where `node` on PATH is bun's shim. It dies
with `undefined symbol: _ZN2v816FunctionTemplate16InstanceTemplateEv`. Only real Node would fix it.

Measured: 15 frames at 960x600 -> 2.0MB MP4. Entity models are still 1.16.4 only (a separate
prismarine-viewer limitation) - blocks are correct, mobs may not be.


### Web UI

- **MindServer**: http://localhost:8080 (`mindserver_host_public: true` is set, binds 0.0.0.0)
- **From a phone via Twingate**: connector `twingate-abiding-jerboa` runs on this host
  (network=host). Add a Resource in the Twingate admin for this machine (`cbx3` / LAN IP)
  with ports 8080 + 3000, assign it to your user, then open http://cbx3:8080 in the phone's
  browser with the Twingate app connected. (Tailscale was tried first and torn down.)
- **3D Viewer**: http://localhost:3000 (per agent: 3001, 3002...)
- **Map**: http://localhost:8090 (run `./regenerate_map.sh` first)

### Security

`allow_insecure_coding: true` enables `!newAction` (LLM code execution). Use Docker for safety.

### Common Issues

| Issue | Fix |
|-------|-----|
| Command 0 args | Check quote format (use ASCII `"` not curly `"`) |
| embed not function | Check embedding model has `embed()` method |
| Bot stuck | Check modes.js unstuck, reduce area size |
| Vision blank | Expected in Docker/headless |


## Driving a running agent from the shell (2026-09-22)

**`mc "msg <bot> <message>"` does not work on this server.** Measured: the whisper returned no
reply, produced no log line, and the bot went idle rather than acting on the command inside it.
`msg` is in the same class as `tp`, `say` and `locate biome` - commands whose sender feedback this
server drops over RCON - so a lost whisper looks exactly like a delivered one.

Use **`bun tools/say_to_agent.mjs <agent> '<message>'`** instead. It emits the MindServer's own
`send-message` event, which reaches `src/agent/mindserver_proxy.js:64` and calls the agent's
respondFunc - the same path the web UI's ADMIN box uses. An agent that is not connected produces
`Agent <name> not in game, cannot send message via MindServer` instead of silence.

Commands work inside the message, so this is how you hand a build back to a bot after a restart:

```bash
bun tools/say_to_agent.mjs bob '!buildBlueprint("blueprints/survival_base.json", 4649, 70, 4605)'
```

ASCII quotes only - curly quotes parse as zero arguments.

### The restart script's guard had a hole

`scratchpad/restart_bot.sh` anchored its liveness check at `^[^ ]*/bun`, which requires a path
ending in `/bun`. A bot started as plain `bun run main.js` (PATH lookup - how the 23-hour run on
this host was launched) did not match, so the guard reported nothing alive, killed only the agent
children, and started a SECOND `main.js`. Only the 8080 bind failing (`EADDRINUSE`) prevented the
duplicate-login crash loop the script exists to stop. It now matches a bare `bun` invocation too,
and its paths are derived from the script's own location rather than hardcoded to `/home/asanrivas`.

## RCON wedged itself, and reported the wedge as success (2026-09-22)

A session ran three RCON commands back to back — `clear` (count before), `give ... grass_block
192`, `clear` (count after). All three printed **nothing** and exited **0**. There was no error to
read, so the give looked like it had worked. It had not: a later count showed the player still had
zero grass blocks.

### The defect: two frames in one event-loop tick

`tools/rcon.mjs` paired every command with an **empty-body sentinel command**, written immediately
after it, to mark the end of a reply that the server might split across packets:

```js
sock.write(frame(2, 2, command));
sock.write(frame(3, 2, ''));      // sentinel - both writes in the SAME tick
```

Node concatenates same-tick writes into one TCP segment. This server reads **one packet per socket
read and discards the rest of the buffer**, so the sentinel was silently dropped, the `id === 3`
reply that the client was waiting for never arrived, and the connection was wedged from then on.

Measured against the live server, one connection, `list` x5, per-command timeout 6s:

| How the frames are written | Result |
|---|---|
| `write(cmd); write(sentinel)` — same tick | **1/5 OK**, then 6000ms timeouts forever |
| `write(cmd); await 30ms; write(sentinel)` | **5/5 OK**, ~31ms each |
| `write(cmd)` only, await the reply, then the next | **8/8 OK**, 0–2ms each |

`setNoDelay(true)` does not help — the coalescing happens in Node, above the socket.

Two things this rules out, both of which were believed beforehand:

- **It is not the sentinel.** A connection answering normally still answers **3/3** after one empty
  frame is fired at it. Pairing it with a command in the same tick is what kills it.
- **It is not reconnecting.** CLAUDE.md said "reconnecting per command stalls the server after ~13
  rapid cycles". Reconnect-per-command did fail in a probe — but the probe pipelined too. One
  connection reused for 15 rapid commands, one frame at a time, is **15/15**.
- **It is not load.** The failures are silence, not slowness: a 40s per-command timeout expired
  just as an 8s one did, while healthy replies land in 0–2ms.

### The second defect: silence read as success

The old client resolved on the sentinel's reply and `console.log`ged whatever it had accumulated —
so "no reply at all" and "the command printed nothing" were the same output, followed by `exit 0`.
That is the house bug shape: *absence of evidence defaulting to fine*. `send()` now **rejects**
when no frame echoing its request id ever arrives, the CLI exits 1, and the message says the
command *may or may not have run*. A reply that is present but empty resolves normally, with a note
on stderr, because the server answering means the command did run.

### What the client does now

- One frame in flight, always; concurrent `send()` calls queue (`tests/rcon.test.mjs` pins both).
- No empty-body command is ever sent. Split replies are reassembled with a **25ms idle window**
  after the last same-id frame, which needs no extra command to delimit.
- Many commands over one connection in one invocation:
  `printf 'list\nseed\n' | bun tools/rcon.mjs -`. Single-arg and joined-argv forms still work, so
  `mc "give andy stone 1"` is unchanged.
- `RconClient` is exported with an injectable `connect`, so the suite drives it against a fake
  socket with no server.

### Collateral: `difficulty` was never a quirk

`mc "difficulty"` returning an empty body was written off as a server quirk (and briefly recorded
as one). It was this bug. The fixed client answers `The difficulty is Peaceful` — which also means
the world was **not** on the `easy` that `server.properties` shows, so `mode:night_safety` and
`self_defense` were standing down. Read it, do not assume; it has now changed four times.
