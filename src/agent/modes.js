import * as skills from "./library/skills.js";
import { isFallingBlockName } from "./library/tools.js";
import * as swim from "./library/swim.js";
import * as night from "./library/night.js";
import { isPeaceful } from "./difficulty.js";
import * as nav from "./library/nav.js";
import * as world from "./library/world.js";
import * as mc from "../utils/mcdata.js";
import settings from "./settings.js";
import convoManager from "./conversation.js";

function say(agent, message) {
    agent.bot.modes.behavior_log += message + "\n";
    if (agent.shut_up || !settings.narrate_behavior) return;
    agent.openChat(message);
}

// a mode is a function that is called every tick to respond immediately to the world
// it has the following fields:
// on: whether 'update' is called every tick
// active: whether an action has been triggered by the mode and hasn't yet finished
// paused: whether the mode is paused by another action that overrides the behavior (eg followplayer implements its own self defense)
// update: the function that is called every tick (if on is true)
// when a mode is active, it will trigger an action to be performed but won't wait for it to return output

// the order of this list matters! first modes will be prioritized
// while update functions are async, they should *not* be awaited longer than ~100ms as it will block the update loop
// to perform longer actions, use the execute function which won't block the update loop
/**
 * Is a real person connected and not asleep?
 *
 * Used to stand `night_safety` down: the bot cannot skip the night on its own - vanilla
 * requires every player to be in bed - so digging in while a person is up buys nothing and
 * costs the bot the night, plus whatever it was asked to do.
 *
 * Other agents are excluded deliberately: bots counting each other as "people" would just make
 * both of them stop.
 */
/**
 * Is there a solid roof close overhead - a dungeon, a building, a shallow cave, an overhang?
 *
 * Complements the "deep underground" depth test: that one only fires more than 8 blocks below
 * the surface, so a bot standing inside a room at surface level reads as exposed and digs
 * itself a hole in the floor of a building it is already safe in.
 *
 * An unloaded chunk reads as NO roof: unknown must not be mistaken for cover.
 */
function hasRoofOverhead(bot, maxUp = 5) {
    const p = bot.entity.position.floored();
    for (let i = 2; i <= maxUp + 1; i++) {
        const b = bot.blockAt(p.offset(0, i, 0));
        if (b && b.boundingBox === 'block') return true;
    }
    return false;
}

function humanAwakeOnline(bot) {
    const players = bot.players ?? {};
    for (const [name, p] of Object.entries(players)) {
        if (name === bot.username) continue;
        if (convoManager.isOtherAgent(name)) continue;   // another bot, not a person
        // `entity` is absent for players outside render distance - still online, still awake.
        if (p?.entity?.isSleeping || p?.entity?.metadata?.isSleeping) continue;
        return true;
    }
    return false;
}

/**
 * Is a real person currently IN BED? The mirror of `humanAwakeOnline`, and needed for the
 * opposite reason: vanilla skips the night only when every player sleeps, and this bot counts
 * as a player, so an awake bot silently holds a person's night hostage.
 *
 * Other agents are excluded for the same reason they are there: a bot is not a person, and two
 * bots each getting into bed because the other did is not a vote, it is a mirror.
 */
function anyHumanSleeping(bot) {
    const players = bot.players ?? {};
    for (const [name, p] of Object.entries(players)) {
        if (name === bot.username) continue;
        if (convoManager.isOtherAgent(name)) continue;   // another bot, not a person
        if (p?.entity?.isSleeping || p?.entity?.metadata?.isSleeping) return true;
    }
    return false;
}

const modes_list = [
    {
        // First on purpose: nothing else matters if the bot drowns, and drowning is the one
        // hazard with a hard clock on it (300 ticks of air, then 1 heart every second).
        //
        // Replaces a branch inside self_preservation that read `if (blockAbove.name === "water")
        // bot.setControlState("jump", true)`. That was wrong in four ways: it bypassed execute()
        // so it had no timeout and never marked itself active, it NEVER released the jump key,
        // it was gated on `bot.pathfinder.goal` which this project no longer uses, and it fired
        // on any submerged head - so it fought every deliberate dive.
        name: "drowning",
        description: "Surface for air before oxygen runs out. Interrupts all actions.",
        interrupts: ["all"],
        // Drowning outranks builds and travel - but NOT a surface run that is already under way.
        // Interrupting one is self-defeating: each interruption sets bot.interrupt_code, which
        // aborts the other's climb mid-rise, and the two then trade interrupts indefinitely.
        // Observed live at 2 hearts of drowning damage:
        //   mode:drowning  interrupts  action:surface
        //   action:surface interrupts  mode:drowning
        //   mode:drowning  interrupts  action:surface   ...
        excludeFromInterrupt: ["action:surface"],
        on: true,
        active: false,
        threshold: 8,             // bubbles. One bubble is ~0.75s of air, so this is ~6s.
        // Backstop, in ms of continuous submersion. Vanilla air is 300 ticks = 15s, so this
        // fires with a few seconds to spare.
        maxSubmergedMs: 10000,
        submergedSince: 0,
        cooldownUntil: 0,
        failures: 0,
        update: async function (agent) {
            const bot = agent.bot;
            const submerged = swim.isSubmerged(bot);
            // Measure submersion ourselves. `bot.oxygenLevel` is set from the `air_supply`
            // entity metadata, and that packet does not reliably reach this client for its own
            // entity here - `!stats` cheerfully reported "Air: 20 / 20" while the SERVER had 13
            // ticks of air left, so the guard below never tripped and the bot drowned at
            // (4322.60, 61.00, 5034.30) with its safety net silent. Trust measured state over
            // reported state, exactly as the movement code has to.
            if (!submerged) this.submergedSince = 0;
            else if (!this.submergedSince) this.submergedSince = Date.now();

            if (Date.now() < this.cooldownUntil) return;
            if (!submerged) return;
            // Require BOTH the number and the block read: oxygenLevel arrives by entity
            // metadata, so a late packet during lag could otherwise trigger a surface run
            // while the bot is stood on dry land.
            const outOfAir = swim.oxygen(bot) <= this.threshold;
            const tooLong = Date.now() - this.submergedSince > this.maxSubmergedMs;
            if (!outOfAir && !tooLong) return;

            // Why it fired, at the moment it fired. This mode interrupts every action in the
            // agent, so a spurious trigger is expensive, and after the fact the only evidence
            // left is a bare "finished executing" line.
            console.log(`[${agent.name}] mode:drowning firing - air=${swim.oxygen(bot)}/20 `
                + `submerged=${submerged} inWater=${swim.inWater(bot)} `
                + `under=${((Date.now() - this.submergedSince) / 1000).toFixed(1)}s `
                + `trigger=${outOfAir ? 'air' : 'duration'} pos=${bot.entity.position.floored()}`);
            execute(this, agent, async () => {
                const r = await swim.surface(bot, { timeoutMs: 12000 });
                if (r.surfaced) {
                    this.failures = 0;
                    // Air refills over a second or so, so without a short pause the mode
                    // re-fires every tick while oxygen climbs back past the threshold - observed
                    // firing four times in ten seconds, each one interrupting the running action.
                    this.cooldownUntil = Date.now() + 1500;
                    return;
                }
                // Cannot reach air. Back off before retrying, or this mode spins every tick and
                // pins currentActionLabel exactly like the bug it replaces.
                this.failures++;
                this.cooldownUntil = Date.now() + 5000;
                say(agent, `I can't reach air (${r.reason}${r.blocker ? `: ${r.blocker}` : ''}) `
                    + `at y=${r.y.toFixed(0)} with ${swim.oxygen(bot)}/20 air.`);
            }, 0.5);
        },
        unpause: function () {
            this.cooldownUntil = 0;
            this.failures = 0;
            this.submergedSince = 0;
        },
    },
    {
        name: "self_preservation",
        description:
            "Respond to drowning, burning, and damage at low health. Interrupts all actions.",
        interrupts: ["all"],
        on: true,
        active: false,
        update: async function (agent) {
            const bot = agent.bot;
            let block = bot.blockAt(bot.entity.position);
            let blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (!block) block = { name: "air" }; // hacky fix when blocks are not loaded
            if (!blockAbove) blockAbove = { name: "air" };
            if (
                isFallingBlockName(blockAbove.name)
            ) {
                // Dig it out rather than run from it. Fleeing surrenders the position - and
                // mid-journey it actively undoes progress - whereas the sand above is a couple
                // of seconds' work with a shovel. moveAway stays only as the last resort.
                // Bounded timeout: with -1, a mode that cannot finish pins currentActionLabel
                // forever and no action can ever start again (observed: the agent stuck on
                // mode:self_preservation at full health, travel unable to run).
                execute(this, agent, async () => {
                    const dug = await skills.clearFallingBlocksAbove(bot);
                    if (!dug) await skills.moveAway(bot, 2);
                }, 0.5);
            } else if (
                block.name === "lava" ||
                block.name === "fire" ||
                blockAbove.name === "lava" ||
                blockAbove.name === "fire"
            ) {
                say(agent, "I'm on fire!");
                // if you have a water bucket, use it
                let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                if (waterBucket) {
                    execute(this, agent, async () => {
                        let success = await skills.placeBlock(
                            bot,
                            "water_bucket",
                            block.position.x,
                            block.position.y,
                            block.position.z,
                        );
                        if (success)
                            say(
                                agent,
                                "Placed some water, ahhhh that's better!",
                            );
                    }, 0.5);
                } else {
                    execute(this, agent, async () => {
                        let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                        if (waterBucket) {
                            let success = await skills.placeBlock(
                                bot,
                                "water_bucket",
                                block.position.x,
                                block.position.y,
                                block.position.z,
                            );
                            if (success)
                                say(
                                    agent,
                                    "Placed some water, ahhhh that's better!",
                                );
                            return;
                        }
                        let nearestWater = world.getNearestBlock(
                            bot,
                            "water",
                            20,
                        );
                        if (nearestWater) {
                            const pos = nearestWater.position;
                            let success = await skills.goToPosition(
                                bot,
                                pos.x,
                                pos.y,
                                pos.z,
                                0.2,
                            );
                            if (success)
                                say(
                                    agent,
                                    "Found some water, ahhhh that's better!",
                                );
                            return;
                        }
                        await skills.moveAway(bot, 5);
                    }, 0.5);
                }
            } else if (
                Date.now() - bot.lastDamageTime < 3000 &&
                (bot.health < 5 || bot.lastDamageTaken >= bot.health)
            ) {
                say(agent, "I'm dying!");
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 20);
                }, 1);
            } else if (agent.isIdle() && !swim.inWater(bot) && !bot.isSleeping) {
                // Not while wet: SwimAssist holds jump to keep the head above water, and
                // clearing it here every idle tick would quietly sink the bot.
                bot.clearControlStates();
            }
        },
    },
    {
        name: "unstuck",
        description:
            "Attempt to get unstuck when in the same place for a while. Interrupts some actions.",
        interrupts: ["all"],
        // Building operations should not be interrupted - they have their own timeout
        // travel pauses to mine through obstructions, which looks like being stuck;
        // it has its own stall detection and a hard deadline, so let it run.
        //
        // `action:marathonRun` is the same case and was simply missed when it was added: it
        // wraps travelToward, so it already detects a stalled checkpoint and shoves sideways
        // itself. Letting unstuck fire on top ran a SECOND moveAway and CANCELLED the whole
        // run - observed twice in one race, each time costing the bot a checkpoint's progress.
        excludeFromInterrupt: ["action:fill", "action:plantTrees", "action:travel", "action:navTo",
            "action:marathonRun",
            "action:swimTo", "action:dive", "action:surface", "action:swimProbe", "mode:drowning",
            "action:goToBed", "action:shelter", "mode:night_safety"],
        on: true,
        active: false,
        prev_location: null,
        distance: 2,
        stuck_time: 0,
        last_time: Date.now(),
        max_stuck_time: 20,
        prev_dig_block: null,
        update: async function (agent) {
            if (agent.isIdle()) {
                this.prev_location = null;
                this.stuck_time = 0;
                return; // don't get stuck when idle
            }
            const bot = agent.bot;
            // Water is the drowning mode's territory. Sinking runs at 0.5 blocks/s and holding
            // depth is stationary by this test, so a legitimate 20s dive would trip the stuck
            // timer - and this mode arms a cleanKill 10s after that.
            if (swim.inWater(bot)) {
                this.prev_location = null;
                this.stuck_time = 0;
                return;
            }
            const cur_dig_block = bot.targetDigBlock;
            if (cur_dig_block && !this.prev_dig_block) {
                this.prev_dig_block = cur_dig_block;
            }
            if (
                this.prev_location &&
                this.prev_location.distanceTo(bot.entity.position) <
                    this.distance &&
                cur_dig_block == this.prev_dig_block
            ) {
                this.stuck_time += (Date.now() - this.last_time) / 1000;
            } else {
                this.prev_location = bot.entity.position.clone();
                this.stuck_time = 0;
                this.prev_dig_block = null;
            }
            const max_stuck_time =
                cur_dig_block?.name === "obsidian"
                    ? this.max_stuck_time * 2
                    : this.max_stuck_time;
            if (this.stuck_time > max_stuck_time) {
                say(agent, "I'm stuck!");
                this.stuck_time = 0;
                execute(this, agent, async () => {
                    const crashTimeout = setTimeout(() => {
                        agent.cleanKill("Got stuck and couldn't get unstuck");
                    }, 10000);
                    await skills.moveAway(bot, 5);
                    clearTimeout(crashTimeout);
                    say(agent, "I'm free.");
                }, 1);
            }
            this.last_time = Date.now();
        },
        unpause: function () {
            this.prev_location = null;
            this.stuck_time = 0;
            this.prev_dig_block = null;
        },
    },
    {
        name: "cowardice",
        description: "Run away from enemies. Interrupts most actions (except building).",
        interrupts: ["all"],
        // Actions that should NOT be interrupted by cowardice (building operations)
        excludeFromInterrupt: ["action:fill", "action:plantTrees", "action:!stay"],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(
                agent.bot,
                (entity) => mc.isHostile(entity),
                16,
            );
            if (enemy && (await world.isClearPath(agent.bot, enemy))) {
                // Safety check: Don't run from villagers or friendly entities
                if (mc.isFriendly(enemy)) {
                    console.log(
                        `[COWARDICE] Skipping ${enemy.name} - marked as friendly`,
                    );
                    return;
                }

                say(agent, `Aaa! A ${enemy.name.replace("_", " ")}!`);
                execute(this, agent, async () => {
                    await skills.avoidEnemies(agent.bot, 24);
                }, 1);
            }
        },
    },
    {
        name: "self_defense",
        description: "Attack nearby enemies. Interrupts most actions (except building).",
        interrupts: ["all"],
        // Actions that should NOT be interrupted by self_defense (building operations)
        excludeFromInterrupt: ["action:fill", "action:plantTrees", "action:!stay"],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(
                agent.bot,
                (entity) => mc.isHostile(entity),
                8,
            );
            if (enemy && (await world.isClearPath(agent.bot, enemy))) {
                // Enhanced logging to debug attacks
                const entityType = enemy.type || "unknown";
                const entityName = enemy.name || "unknown";
                const isActuallyHostile = mc.isHostile(enemy);
                console.log(
                    `[SELF_DEFENSE] Detected entity: name="${entityName}", type="${entityType}", isHostile=${isActuallyHostile}`,
                );

                // Safety check: Don't attack villagers, players, or other friendly entities
                if (mc.isFriendly(enemy)) {
                    console.log(
                        `[SELF_DEFENSE] Skipping ${entityName} - marked as friendly`,
                    );
                    return;
                }

                say(agent, `Fighting ${enemy.name}!`);
                execute(this, agent, async () => {
                    await skills.defendSelf(agent.bot, 8);
                }, 2);
            }
        },
    },
    {
        // Positioned AFTER self_defense and BEFORE hunting, deliberately. Everything above keeps
        // updating while this is active - a creeper at the bedside still triggers self_defense,
        // low air still triggers drowning. Everything below goes quiet, which is what we want:
        // chasing a pig at dusk is how you meet a skeleton.
        name: "night_safety",
        description: "At dusk, sleep in a bed (or place one), or dig in when there is none.",
        interrupts: ["all"],
        // Never interrupt the survival modes above us, nor the commands doing this same job -
        // that mutual-interrupt livelock cost the bot 2 hearts of drowning damage once already
        // (!surface vs mode:drowning, docs/SWIMMING.md 5.2).
        excludeFromInterrupt: [
            "mode:drowning", "mode:self_preservation", "mode:self_defense",
            "action:goToBed", "action:shelter", "action:surface",
            "action:fill", "action:plantTrees", "action:!stay",
        ],
        on: true,
        active: false,
        cooldownUntil: 0,
        sheltered: null,
        // Consecutive failed shelter attempts, and whether we have given up for tonight.
        // Both reset at dawn - see the dig-out branch.
        failures: 0,
        gaveUp: false,
        update: async function (agent) {
            const bot = agent.bot;
            if (Date.now() < this.cooldownUntil) return;
            if (bot.isSleeping) return;

            const t = bot.time.timeOfDay;

            // Dawn: break out of last night's hole, and forget last night's failures.
            //
            // The reset is gated on FULL DAYLIGHT, not merely `!isNight`. The two predicates do
            // not partition the day: `isNight` starts at 13000 while `isDuskApproaching` starts
            // 600 ticks earlier, so the dusk window is "not night" AND "time to shelter". A
            // reset on `!isNight` alone therefore cleared the counter on every tick of exactly
            // the window in which the mode is trying and failing - measured as 35 attempts in
            // 110 seconds, with the give-up never latching.
            const daylight = !night.isNight(t) && !night.isDuskApproaching(t);
            if (daylight) {
                this.failures = 0;
                this.gaveUp = false;
            }
            if (!night.isNight(t) && this.sheltered) {
                const seal = this.sheltered;
                this.sheltered = null;
                execute(this, agent, async () => { await skills.digOut(bot, seal); }, 1);
                return;
            }
            if (!night.isDuskApproaching(t) && !(bot.thunderState > 0)) return;

            // A HUMAN IS IN BED: join the vote.
            //
            // Vanilla skips the night only when EVERY player is asleep, and this bot counts as
            // a player - so an awake bot silently prevents a person from skipping the night,
            // with nothing in chat to say why. Voting is a different goal from sheltering:
            // it is worth doing on Peaceful, under a roof, deep underground, and after the
            // shelter attempts have given up for the night. Every stand-down below correctly
            // blocks SHELTERING and would wrongly block VOTING, which is the whole reason this
            // block sits above all of them - and below the dawn dig-out, so a bot sealed in
            // last night is let out before it is asked to walk anywhere.
            if (anyHumanSleeping(bot)) {
                const bedNearby = bot.findBlocks({
                    matching: (b) => night.isBedName(b.name), maxDistance: 48, count: 1,
                }).length > 0;
                const bedItem = night.bedInInventory(bot.inventory.items());
                const verdict = night.sleepVoteVerdict({
                    anyHumanSleeping: true, timeOfDay: t, thundering: bot.thunderState > 0,
                    isSleeping: bot.isSleeping, dimension: bot.game.dimension,
                    inWater: swim.inWater(bot),
                    hasBed: bedNearby || !!bedItem,
                    // A courtesy must not cancel what a person explicitly asked for. Modes are
                    // exempt from the ownership rule so that DROWNING and SELF_DEFENSE can save
                    // the bot's life; a sleep vote is not that, and killing a user's marathon
                    // to be polite about their bedtime is damage this repo has already paid for
                    // once. Nothing is lost by waiting: a sleeping human stays in bed, so the
                    // first tick after their action finishes joins the vote anyway.
                    userActionRunning: agent.actions.isUserOwned(),
                });
                if (verdict === 'join') {
                    // A failed join must not become a metronome - same rule as the shelter
                    // backoff below. Worst case for a bed-less bot beside a sleeping human is
                    // one interrupted action per 30s, and only inside the vote window.
                    this.cooldownUntil = Date.now() + 30000;
                    execute(this, agent, async () => {
                        if (!bedNearby && bedItem) await skills.placeNearby(bot, bedItem.name);
                        const r = await skills.goToBed(bot);
                        say(agent, r.slept ? `Joining the sleep vote.`
                                           : `Could not join the sleep: ${r.reason}.`);
                    }, 3);   // 3 minutes, never -1
                    return;
                }
                // 'defer' or 'no': fall THROUGH to the ordinary chain. Returning here would
                // silently disable every stand-down below whenever anyone was in bed.
            }

            // Nothing hostile spawns on Peaceful, so a night shelter costs a whole night and
            // buys exactly nothing. This mode interrupts every action in the agent, so on a
            // Peaceful world it is a pure tax: an in-flight journey stops at dusk, digs a hole,
            // and resumes at dawn having gained no safety at all. Read the difficulty rather
            // than assuming danger - the bot is told it on login and on every /difficulty.
            //
            // Deliberately AFTER the dawn dig-out above: a bot that sealed itself in while the
            // world was on Normal must still be let out if the difficulty is lowered overnight.
            if (isPeaceful(bot.game)) return;

            // A HUMAN IS ONLINE AND AWAKE: do not dig in.
            //
            // Sheltering only pays for itself if it skips the night, and the bot cannot skip it
            // alone - vanilla needs every player asleep. So while a person is connected and not
            // in bed, a shelter costs the bot the whole night and changes nothing about when
            // morning arrives. Worse, it does it by cancelling whatever the person asked for:
            // observed cancelling a user's marathon 12 seconds after it started.
            //
            // Other agents do not count as people - two bots digging in because the other one
            // is "online" is just both of them stopping.
            if (humanAwakeOnline(bot)) return;

            // Water belongs to the drowning mode; never contest the jump key with SwimAssist.
            if (swim.inWater(bot)) return;

            // Already underground = already sheltered. Observed live: the mode fired while the
            // bot was mining at y=25, dug a hole in the floor and sealed itself in at y=9 -
            // 50 blocks of stone overhead was strictly better cover than anything it built,
            // and it abandoned the job it was sent to do. Mobs underground are a self_defense
            // problem, not a nightfall one.
            const surf = nav.surfaceY(bot, Math.floor(bot.entity.position.x),
                                      Math.floor(bot.entity.position.z), 140,
                                      Math.floor(bot.entity.position.y));
            if (surf !== null && surf - bot.entity.position.y > 8) return;

            // ALREADY UNDER COVER: a dungeon, a building, a shallow cave, an overhang. The
            // depth test above only catches being DEEP underground (>8 blocks); it misses a bot
            // standing inside a room at surface level, which is already sheltered by anything
            // that matters. Digging a second hole inside a structure is pure waste.
            if (hasRoofOverhead(bot)) return;

            // Stand off while something is trying to kill us: self_defense owns that tick. The
            // cooldown below means we retry after the fight instead of fighting IT for control.
            const hostile = world.getNearbyEntities(bot, 12)
                .find(e => e && mc.isHostile(e));
            if (hostile) { this.cooldownUntil = Date.now() + 8000; return; }

            // GIVE UP FOR THE NIGHT rather than retrying until dawn.
            //
            // A flat 20s cooldown on failure is not a backoff, it is a metronome: the mode
            // interrupts every action in the agent, so on ground it cannot shelter on - bare
            // stone, no pickaxe, nothing to place - it cancelled whatever the bot was doing
            // three times a minute, all night. Observed exactly that during the chest work.
            // Nothing about the ground or the inventory changes while the bot stands still, so
            // the third identical failure is evidence, not bad luck.
            if (this.gaveUp) return;

            execute(this, agent, async () => {
                const outcome = await skills.nightRoutine(bot, this);
                say(agent, outcome);
                if (/could not|cannot|nowhere/i.test(outcome)) {
                    this.failures++;
                    if (this.failures >= 3) {
                        this.gaveUp = true;
                        // Console as well as chat, and named: this is the line that explains why
                        // the bot spent a night in the open, and `say` only reaches Minecraft
                        // chat - which is not where anyone debugs a mode from.
                        console.log(`[${agent.name}] night_safety: giving up for tonight after `
                            + `3 failed attempts (${outcome.trim()})`);
                        say(agent, `I cannot shelter here tonight; carrying on in the open.`);
                        return;
                    }
                    // Escalating, so a transient failure (a mob wandered past the spot) still
                    // gets a prompt second try while a permanent one stops costing actions.
                    this.cooldownUntil = Date.now() + [20000, 60000][this.failures - 1];
                } else {
                    this.failures = 0;
                }
            }, 3);   // 3 minutes, never -1
        },
        unpause: function () {
            this.cooldownUntil = 0;
            // An explicit unpause is a person putting the mode back in charge; that is new
            // information, so last night's "I cannot shelter here" no longer stands.
            this.failures = 0;
            this.gaveUp = false;
        },
    },
    {
        name: "hunting",
        description: "Hunt nearby animals when idle.",
        interrupts: ["action:followPlayer"],
        on: true,
        active: false,
        update: async function (agent) {
            const huntable = world.getNearestEntityWhere(
                agent.bot,
                (entity) => mc.isHuntable(entity),
                8,
            );
            if (huntable && (await world.isClearPath(agent.bot, huntable))) {
                execute(this, agent, async () => {
                    say(agent, `Hunting ${huntable.name}!`);
                    await skills.attackEntity(agent.bot, huntable);
                }, 2);
            }
        },
    },
    {
        name: "item_collecting",
        description:
            "Collect nearby items when idle.",
        // ONLY WHEN NOT BUSY. `action:followPlayer` used to be in this list, so a single dropped
        // item within 3 blocks ended a follow outright - and mining drops items constantly, so
        // the bot interrupted itself on its own output. What is left are the two actions whose
        // whole purpose is to stand still: those are idleness with a name, and picking things up
        // during them is the point of them.
        interrupts: ["action:!stop", "action:!stayHere"],
        on: true,
        active: false,

        wait: 1.5, // reduced from 2 to 1.5 seconds for faster response
        prev_item: null,
        noticed_at: -1,
        last_inventory_snapshot: null,
        update: async function (agent) {
            let item = world.getNearestEntityWhere(
                agent.bot,
                (entity) => entity.name === "item",
                8,
            );
            let empty_inv_slots = agent.bot.inventory.emptySlotCount();

            const distance = item
                ? agent.bot.entity.position.distanceTo(item.position)
                : 999;
            // Still used to shorten the wait and to speak up: an item dropped at the bot's feet
            // is almost always a person handing it something, and should not sit for 1.5s.
            const is_very_close = distance < 3;
            // PROXIMITY IS NOT PERMISSION. This was `agent.isIdle() || is_very_close`, which let
            // any item within 3 blocks preempt a running action - the "more aggressive" comment
            // that used to sit here was describing the bug. The mode framework already gates
            // `update()` on `isIdle() || interruptible` (see runAll), and `interrupts` above is
            // now only the stand-still actions, so this states the same rule rather than widening
            // it: pick up when there is nothing else to do.
            const standingStill = agent.actions.currentActionLabel === 'action:!stop'
                || agent.actions.currentActionLabel === 'action:!stayHere';
            const can_interrupt = agent.isIdle() || standingStill;

            if (
                item &&
                item !== this.prev_item &&
                (await world.isClearPath(agent.bot, item)) &&
                empty_inv_slots > 1 &&
                can_interrupt
            ) {
                if (this.noticed_at === -1) {
                    this.noticed_at = Date.now();
                    // Reduce wait time for very close items (likely given by player)
                    if (is_very_close) {
                        say(agent, `I see items nearby!`);
                    }
                }
                const wait_time = is_very_close ? 0.5 : this.wait; // 0.5s for close items, 1.5s for others
                if (Date.now() - this.noticed_at > wait_time * 1000) {
                    // Take inventory snapshot before pickup
                    const before_items = agent.bot.inventory
                        .items()
                        .map((i) => ({ name: i.name, count: i.count }));

                    say(agent, `Picking up items!`);
                    this.prev_item = item;
                    execute(this, agent, async () => {
                        await skills.pickupNearbyItems(agent.bot);

                        // Check what was picked up
                        const after_items = agent.bot.inventory.items();
                        const new_items = [];

                        for (const item of after_items) {
                            const before_item = before_items.find(
                                (b) => b.name === item.name,
                            );
                            if (!before_item) {
                                new_items.push(`${item.count} ${item.name}`);
                            } else if (item.count > before_item.count) {
                                new_items.push(
                                    `${item.count - before_item.count} ${item.name}`,
                                );
                            }
                        }

                        // Notify agent about picked up items
                        if (new_items.length > 0) {
                            const items_list = new_items.join(", ");
                            say(agent, `Picked up: ${items_list}`);
                            // Auto-message to inform LLM about new resources
                            setTimeout(() => {
                                const message = agent.isIdle()
                                    ? `(AUTO) You just picked up ${items_list}. What would you like to do with these items?`
                                    : `(AUTO) You just picked up ${items_list}. You now have these materials available. Check your inventory and continue with your current task if you have what you need.`;
                                agent.handleMessage("system", message);
                            }, 500);
                        }
                    }, 1);
                    this.noticed_at = -1;
                }
            } else {
                this.noticed_at = -1;
            }
        },
    },
    {
        name: "torch_placing",
        description: "Place torches when idle and there are no torches nearby.",
        interrupts: ["action:followPlayer"],
        on: true,
        active: false,
        cooldown: 5,
        last_place: Date.now(),
        update: function (agent) {
            if (world.shouldPlaceTorch(agent.bot)) {
                if (Date.now() - this.last_place < this.cooldown * 1000) return;
                execute(this, agent, async () => {
                    const pos = agent.bot.entity.position;
                    await skills.placeBlock(
                        agent.bot,
                        "torch",
                        pos.x,
                        pos.y,
                        pos.z,
                        "bottom",
                        true,
                    );
                }, 0.5);
                this.last_place = Date.now();
            }
        },
    },
    {
        name: "elbow_room",
        description: "Move away from nearby players when idle.",
        // IDLE MEANS IDLE. This used to carry `interrupts: ["action:followPlayer"]`, and on
        // 2026-08-30 that stopped a follow dead. Log times below are UTC (the service log is
        // UTC while this host is +0800 - worth remembering before concluding an event is old):
        //
        //   16:32:51  pinned: pos=(4744.5, 65.50, 4810.7)        <- stuck in sand
        //   16:32:52  mode:elbow_room interrupts action:followPlayer
        //   16:32:52  dig sand at (4744, 65, 4811): Digging aborted   <- the recovery, cancelled
        //   16:32:52  pinned: nothing worked - recentring
        //   16:32:55  mode:elbow_room interrupts action:followPlayer  (third time in 16s)
        //   16:32:57  follow resumes, target now out of entity range, refuses
        //   ...and the bot then stood on that block, motionless, until it was restarted.
        //
        // Three faults compounded. Being 0.5 blocks from the person you are FOLLOWING is the
        // goal state, not a problem to fix. The remedy - shuffle half a block - competes with
        // the navigator's own stall ladder and aborted the dig that was getting the bot out.
        // And each interrupt tears the follow down and restarts it from the top, so a target
        // who keeps walking eventually gets out of range during one of the gaps.
        //
        // `followPlayer` already pauses this mode when it is within `distance + 2`, but that
        // line sits at the BOTTOM of a loop iteration which blocks for seconds inside
        // navigateTo - so a player walking up to a stuck bot beats the pause every time. The
        // pause stays as belt-and-braces; not interrupting is what actually fixes it.
        interrupts: [],
        on: true,
        active: false,
        distance: 0.5,
        update: async function (agent) {
            const player = world.getNearestEntityWhere(
                agent.bot,
                (entity) => entity.type === "player",
                this.distance,
            );
            if (player) {
                execute(this, agent, async () => {
                    // wait a random amount of time to avoid identical movements with other bots
                    const wait_time = Math.random() * 1000;
                    await new Promise((resolve) =>
                        setTimeout(resolve, wait_time),
                    );
                    if (
                        player.position.distanceTo(agent.bot.entity.position) <
                        this.distance
                    ) {
                        await skills.moveAwayFromEntity(
                            agent.bot,
                            player,
                            this.distance,
                        );
                    }
                }, 0.5);
            }
        },
    },
    {
        name: "idle_staring",
        description: "Animation to look around at entities when idle.",
        interrupts: [],
        on: true,
        active: false,

        staring: false,
        last_entity: null,
        next_change: 0,
        update: function (agent) {
            const entity = agent.bot.nearestEntity();
            let entity_in_view =
                entity &&
                entity.position.distanceTo(agent.bot.entity.position) < 10 &&
                entity.name !== "enderman";
            if (entity_in_view && entity !== this.last_entity) {
                this.staring = true;
                this.last_entity = entity;
                this.next_change = Date.now() + Math.random() * 1000 + 4000;
            }
            if (entity_in_view && this.staring) {
                let isbaby = entity.type !== "player" && entity.metadata[16];
                let height = isbaby ? entity.height / 2 : entity.height;
                agent.bot.lookAt(entity.position.offset(0, height, 0));
            }
            if (!entity_in_view) this.last_entity = null;
            if (Date.now() > this.next_change) {
                // look in random direction
                this.staring = Math.random() < 0.3;
                if (!this.staring) {
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() * Math.PI) / 2 - Math.PI / 4;
                    agent.bot.look(yaw, pitch, false);
                }
                this.next_change = Date.now() + Math.random() * 10000 + 2000;
            }
        },
    },
    {
        name: "cheat",
        description: "Use cheats to instantly place blocks and teleport.",
        interrupts: [],
        on: false,
        active: false,
        update: function (agent) {
            /* do nothing */
        },
    },
];

/**
 * Run a mode's action through the action manager.
 *
 * ALWAYS pass a timeout. The `-1` default means "no timeout", and a mode action that cannot
 * finish then pins `currentActionLabel` forever - after which NO action can ever start again.
 * That is not hypothetical: one `self_preservation` trigger left the agent frozen at full
 * health for 11 minutes (CLAUDE.md, "Tools and modes"). `tests/modes.test.mjs` fails the build
 * if a call site here omits it.
 */
async function execute(mode, agent, func, timeout = -1) {
    if (agent.self_prompter.isActive()) agent.self_prompter.stopLoop();
    let interrupted_action = agent.actions.currentActionLabel;
    mode.active = true;
    let code_return = await agent.actions.runAction(
        `mode:${mode.name}`,
        async () => {
            await func();
        },
        // 'mode', explicitly: `agent.command_author` still holds whoever issued the LAST
        // command, so without this a safety interrupt would inherit "user" and then be
        // protected from being interrupted itself.
        { timeout, author: 'mode' },
    );
    mode.active = false;
    // Name the agent. This log is the ONLY record that a mode fired, and with two bots
    // sharing one service log an unattributed "Mode drowning finished executing" is
    // undiagnosable - you cannot tell which bot is wet, or even that only one of them is.
    console.log(
        `[${agent.name}] Mode ${mode.name} finished executing, code_return: ${code_return.message}`,
    );

    let should_reprompt =
        interrupted_action && // it interrupted a previous action
        !agent.actions.resume_func && // there is no resume function
        !agent.self_prompter.isActive() && // self prompting is not on
        !code_return.interrupted; // this mode action was not interrupted by something else

    if (should_reprompt) {
        // auto prompt to respond to the interruption
        let role = convoManager.inConversation() ? agent.last_sender : "system";
        let logs = agent.bot.modes.flushBehaviorLog();
        agent.handleMessage(
            role,
            `(AUTO MESSAGE)Your previous action '${interrupted_action}' was interrupted by ${mode.name}.
        Your behavior log: ${logs}\nRespond accordingly.`,
        );
    }
}

let _agent = null;
const modes_map = {};
for (let mode of modes_list) {
    modes_map[mode.name] = mode;
}

class ModeController {
    /*
    SECURITY WARNING:
    ModesController must be reference isolated. Do not store references to external objects like `agent`.
    This object is accessible by LLM generated code, so any stored references are also accessible.
    This can be used to expose sensitive information by malicious prompters.
    */
    constructor() {
        this.behavior_log = "";
    }

    exists(mode_name) {
        return modes_map[mode_name] != null;
    }

    setOn(mode_name, on) {
        modes_map[mode_name].on = on;
    }

    isOn(mode_name) {
        return modes_map[mode_name].on;
    }

    /** Is this mode currently mid-action? Lets a command stand down rather than compete. */
    isActive(mode_name) {
        return !!modes_map[mode_name]?.active;
    }

    pause(mode_name) {
        modes_map[mode_name].paused = true;
    }

    unpause(mode_name) {
        const mode = modes_map[mode_name];
        //if  unpause func is defined and mode is currently paused
        if (mode.unpause && mode.paused) {
            mode.unpause();
        }
        mode.paused = false;
    }

    unPauseAll() {
        for (let mode of modes_list) {
            if (mode.paused) console.log(`Unpausing mode ${mode.name}`);
            this.unpause(mode.name);
        }
    }

    getMiniDocs() {
        // no descriptions
        let res = "Agent Modes:";
        for (let mode of modes_list) {
            let on = mode.on ? "ON" : "OFF";
            res += `\n- ${mode.name}(${on})`;
        }
        return res;
    }

    getDocs() {
        let res = "Agent Modes:";
        for (let mode of modes_list) {
            let on = mode.on ? "ON" : "OFF";
            res += `\n- ${mode.name}(${on}): ${mode.description}`;
        }
        return res;
    }

    async update() {
        if (_agent.isIdle()) {
            this.unPauseAll();
        }
        for (let mode of modes_list) {
            const currentAction = _agent.actions.currentActionLabel;

            // Check if current action is excluded from this mode's interrupts
            const isExcluded = mode.excludeFromInterrupt &&
                mode.excludeFromInterrupt.some((i) => i === currentAction);

            let interruptible =
                !isExcluded && (
                    mode.interrupts.some((i) => i === "all") ||
                    mode.interrupts.some((i) => i === currentAction)
                );
            if (
                mode.on &&
                !mode.paused &&
                !mode.active &&
                (_agent.isIdle() || interruptible)
            ) {
                await mode.update(_agent);
            }
            if (mode.active) break;
        }
    }

    flushBehaviorLog() {
        const log = this.behavior_log;
        this.behavior_log = "";
        return log;
    }

    getJson() {
        let res = {};
        for (let mode of modes_list) {
            res[mode.name] = mode.on;
        }
        return res;
    }

    loadJson(json) {
        for (let mode of modes_list) {
            if (json[mode.name] != undefined) {
                mode.on = json[mode.name];
            }
        }
    }
}

export function initModes(agent) {
    _agent = agent;
    // the mode controller is added to the bot object so it is accessible from anywhere the bot is used
    agent.bot.modes = new ModeController();
    if (agent.task) {
        agent.bot.restrict_to_inventory = agent.task.restrict_to_inventory;
    }
    let modes_json = agent.prompter.getInitModes();
    if (modes_json) {
        agent.bot.modes.loadJson(modes_json);
    }
}
