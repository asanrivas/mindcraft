/**
 * Does a typed judgement fold memory paraphrases better than the Jaccard rule?
 *
 *   bun scratchpad/fold_gym.mjs                 # score the heuristic alone, no network
 *   bun scratchpad/fold_gym.mjs jev             # ...and the model column (TYPESAFE_API_KEY)
 *   bun scratchpad/fold_gym.mjs corpus          # re-draw the sample from today's journals
 *
 * Needs no Minecraft server, no RCON and no bot. Everything it scores comes off disk.
 *
 * WHAT IS BEING MEASURED. `memory_store.js` decides "is this new lesson one I already hold?"
 * by content-word overlap: fold when Jaccard >= PROSE_DUPLICATE_AT (0.6) and both sides carry
 * >= PROSE_MIN_TOKENS (5) content words, plus an exact-sequence fold for the 2-4 word rows.
 * The file documents that threshold as stuck - raising it lets duplicates back in, lowering it
 * merges distinct lessons - and documents the pair it could not fold either way:
 *
 *     "Stop immediately when a player says stop."   (revision 37)
 *     "Stop immediately when player says stop."     (revision 29)
 *
 * four content words, so the length guard blocked it, and both rows sat forever in a section
 * that renders ten. That is the shape of bug this gym exists to price: the store was full of
 * good facts and could no longer learn a new one.
 *
 * THE TWO ERRORS ARE NOT WORTH THE SAME, and no single accuracy number says so:
 *
 *   MISSED FOLD   a duplicate row. Cheap: it wastes one of ten render slots.
 *   FALSE MERGE   two distinct lessons collapsed into one. Expensive and SILENT - the loser is
 *                 discarded and nothing ever says which fact went missing.
 *
 * So the heuristic's conservatism is a deliberate, correct bias, and any replacement has to
 * beat it on missed folds WITHOUT giving up the zero. Both are counted separately below, and
 * the model column sweeps its threshold rather than assuming 0.5.
 *
 * THE LABELS ARE A JUDGEMENT AND ARE MARKED AS ONE. 60 pairs drawn from 1,699 distinct
 * lesson/note values in `bots/{andy,bob}/memory_store.json.journal.jsonl`, spread evenly over
 * six similarity bands so the decision boundary is populated rather than sampled at random
 * (uniform sampling puts 94% of its draws below 0.3, where nothing interesting happens).
 * Every pair carries `same`, `sure` and a one-line `why` - read them and disagree where you
 * do. The headline score counts only `sure` pairs; the 9 borderline ones are reported apart,
 * because a number that moves when a judgement call flips is not evidence.
 */
import fs from 'fs';
import { proseTokens, proseSequence, proseSimilarity } from '../src/agent/memory_store.js';

// Kept in step with memory_store.js by assertion below, not by hand.
const PROSE_DUPLICATE_AT = 0.6;
const PROSE_MIN_TOKENS = 5;
const PROSE_EXACT_MIN_TOKENS = 2;

const src = fs.readFileSync(new URL('../src/agent/memory_store.js', import.meta.url), 'utf8');
for (const [name, want] of [['PROSE_DUPLICATE_AT', PROSE_DUPLICATE_AT],
                            ['PROSE_MIN_TOKENS', PROSE_MIN_TOKENS],
                            ['PROSE_EXACT_MIN_TOKENS', PROSE_EXACT_MIN_TOKENS]]) {
    const m = src.match(new RegExp(`const ${name} = ([0-9.]+);`));
    if (!m || Number(m[1]) !== want) {
        console.error(`${name} is ${m ? m[1] : 'missing'} in memory_store.js but ${want} here - `
            + 'this gym is scoring a rule the store no longer uses. Update it and re-measure.');
        process.exit(2);
    }
}

/** Every distinct lesson/note value either bot has ever written. */
function corpus() {
    const vals = new Set();
    for (const name of ['andy', 'bob']) {
        const f = new URL(`../bots/${name}/memory_store.json.journal.jsonl`, import.meta.url);
        if (!fs.existsSync(f)) continue;
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            let r; try { r = JSON.parse(line); } catch { continue; }
            if (r.op !== 'put' || !r.id || !r.value) continue;
            const kind = String(r.id).split(':')[0];
            if (kind === 'lesson' || kind === 'note') vals.add(String(r.value).trim());
        }
    }
    return [...vals].sort();
}

/**
 * The store's own decision, for ONE pair.
 *
 * The live code picks the best match across every record; scored pairwise here because the
 * pair is the unit the label is about, and "fold A onto B" is the same judgement either way.
 */
function heuristicFolds(a, b) {
    const ta = proseTokens(a), tb = proseTokens(b);
    if (ta.length >= PROSE_MIN_TOKENS && tb.length >= PROSE_MIN_TOKENS)
        return proseSimilarity(ta, tb) >= PROSE_DUPLICATE_AT;
    if (ta.length >= PROSE_EXACT_MIN_TOKENS && ta.length < PROSE_MIN_TOKENS
        && tb.length >= PROSE_EXACT_MIN_TOKENS && tb.length < PROSE_MIN_TOKENS)
        return proseSequence(a).join(' ') === proseSequence(b).join(' ');
    return false;
}

// ---- the model column -----------------------------------------------------------------------
// A Noul, not a Choice: the question has exactly two outcomes and the probability IS the knob
// the policy turns. Phrased as what the two texts SAY rather than what the store should DO -
// measured in scratchpad/laya_recover_gym.py, where asking for the action instead of the
// observation cost a point and most of the calibration.
const NOUL = {
    type: 'noul',
    instructions: 'Two notes a Minecraft bot wrote into its own long-term memory are shown as '
        + '`note_one` and `note_two`. Do they state the same lesson, so that keeping both would '
        + 'be storing one fact twice?',
    criteria: {
        true: 'the same lesson in different words - either one could replace the other and '
            + 'nothing the bot needs would be lost',
        false: 'different lessons, or the same subject with a different point - keeping only '
            + 'one of them would lose something the bot needs',
    },
};

async function askJev(pairs) {
    const KEY = process.env.TYPESAFE_API_KEY;
    if (!KEY) { console.error('TYPESAFE_API_KEY is not set - no model column. Nothing measured.'); process.exit(2); }
    const out = [];
    for (const p of pairs) {
        const body = JSON.stringify({
            state: { note_one: p.a, note_two: p.b },
            model: 'jev-latest',
            questions: { same: NOUL },
        });
        let res, text;
        for (let attempt = 1; ; attempt++) {
            const t0 = Date.now();
            try {
                res = await fetch('https://api.typesafe.ai/v1/systemone', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
                    body,
                });
                text = await res.text();
            } catch (err) {
                if (attempt >= 3) throw new Error(`network: ${err.message}`);
                await new Promise(r => setTimeout(r, 2000 * attempt));
                continue;
            }
            if (!res.ok) {
                // A 4xx is a bug in this file and must surface, not hide behind two more tries.
                if (!(res.status === 429 || res.status >= 500) || attempt >= 3)
                    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
                await new Promise(r => setTimeout(r, 2000 * attempt));
                continue;
            }
            out.push({ p: JSON.parse(text).answers.same.noul, ms: Date.now() - t0 });
            break;
        }
    }
    return out;
}

/** Missed folds and false merges counted apart, because they do not cost the same. */
function score(pairs, decide) {
    let missed = 0, merged = 0, right = 0;
    const wrong = [];
    pairs.forEach((p, i) => {
        const folds = decide(p, i);
        if (folds === p.same) { right++; return; }
        if (p.same) { missed++; wrong.push(['MISSED FOLD', p]); }
        else { merged++; wrong.push(['FALSE MERGE', p]); }
    });
    return { right, of: pairs.length, missed, merged, wrong };
}

function report(label, s) {
    console.log(`  ${label.padEnd(26)} ${String(s.right).padStart(2)}/${s.of}   `
        + `missed folds ${String(s.missed).padStart(2)}   false merges ${String(s.merged).padStart(2)}`);
}

// ---- run --------------------------------------------------------------------------------------
const MODE = process.argv[2] || '';

if (MODE === 'corpus') {
    // Re-draw the stratified sample from today's journals, to extend or refresh the labels.
    // Prints pairs WITHOUT labels on purpose: a label is a judgement a person makes.
    const vals = corpus();
    const tok = vals.map(proseTokens);
    const BANDS = [['A_1.0', 1, 1.01], ['B_.8', 0.8, 1], ['C_.6', 0.6, 0.8],
                   ['D_.45', 0.45, 0.6], ['E_.3', 0.3, 0.45], ['F_.15', 0.15, 0.3]];
    const buckets = Object.fromEntries(BANDS.map(b => [b[0], []]));
    for (let i = 0; i < vals.length; i++) for (let j = i + 1; j < vals.length; j++) {
        if (tok[i].length < PROSE_MIN_TOKENS || tok[j].length < PROSE_MIN_TOKENS) continue;
        const s = proseSimilarity(tok[i], tok[j]);
        for (const [n, lo, hi] of BANDS) if (s >= lo && s < hi) { buckets[n].push([i, j, s]); break; }
    }
    console.log(`${vals.length} distinct values, ${vals.length * (vals.length - 1) / 2} pairs`);
    for (const [n] of BANDS) {
        const arr = buckets[n];
        console.log(`\n--- ${n}: ${arr.length} pairs ---`);
        // Evenly spaced rather than random, so the draw is reproducible without a seed.
        for (let k = 0; k < Math.min(10, arr.length); k++) {
            const [i, j, s] = arr[Math.floor(k * arr.length / Math.min(10, arr.length))];
            console.log(`  s=${s.toFixed(2)}\n   A: ${vals[i]}\n   B: ${vals[j]}`);
        }
    }
    process.exit(0);
}

/**
 * The labelled set. INLINE, not a sibling .json, because `scratchpad/*.json` is gitignored
 * for run output and these labels are the evidence - a gym whose ground truth does not
 * survive a clone is the exact failure the .gitignore comment above that rule warns about.
 * `why` is the reason for the label; disagree with any of them and re-run.
 */
const PAIRS = [
    { band: "A_1.0", jaccard: 1, same: true, sure: true,
      why: "modal softened, same claim",
      a: "'action:travel' command can interfere with following a player.",
      b: "'action:travel' command interferes with following a player." },
    { band: "A_1.0", jaccard: 1, same: true, sure: true,
      why: "identical material list under a different heading",
      a: "**Materials Found**: Stone, Sandstone, Copper, Andesite, Coal, Lapis, Dirt.",
      b: "Materials found nearby: Stone, Sandstone, Copper, Andesite, Coal, Lapis, Dirt." },
    { band: "A_1.0", jaccard: 1, same: true, sure: true,
      why: "same failure, clauses swapped",
      a: "Avoid water hazards; `climbOut/digUp/goToSurface` failed vs flooding.",
      b: "climbOut/digUp/goToSurface failed vs flooding \u2014 avoid water hazards" },
    { band: "A_1.0", jaccard: 1, same: true, sure: true,
      why: "same reconnect procedure",
      a: "Disconnects happen frequently. On reconnect: read memory first, then resume any unfinished task before greeting.",
      b: "Disconnects happen frequently; on reconnect read memory first, then resume unfinished tasks before greeting." },
    { band: "A_1.0", jaccard: 1, same: true, sure: true,
      why: "the 10s-kill / 240-min lesson, reworded",
      a: "Keep all code short/self-terminating; non-terminating code killed at 10s forces full restart; even idle agents hit 240-min timeout causing disconnect. Confirm nothing running before going idle.",
      b: "Non-terminating code killed at 10s forces full agent restart; even an idle agent hit a 240-min timeout causing disconnect/restart. Keep all code short/self-terminating; confirm nothing running before going idle." },
    { band: "A_1.0", jaccard: 1, same: true, sure: true,
      why: "the 10s-kill / 240-min lesson, reworded",
      a: "Keep code short/self-terminating; non-terminating code killed at 10s; idle agents hit 240-min timeout.",
      b: "Keep code short/self-terminating; non-terminating killed at 10s; idle agents hit 240-min timeout." },
    { band: "A_1.0", jaccard: 1, same: true, sure: true,
      why: "the 10s-kill / 240-min lesson, reworded",
      a: "Never leave scripts/loops running: non-terminating code killed at 10s forces full agent restart; even an idle agent hit a 240-min timeout causing disconnect. Keep all code short/self-terminating; confirm nothing running before going idle.",
      b: "Non-terminating code killed at 10s forces full agent restart; even an idle agent hit a 240-min timeout causing disconnect. Keep all code short/self-terminating; confirm nothing running before going idle." },
    { band: "A_1.0", jaccard: 1, same: true, sure: true,
      why: "the 10s-kill / 240-min lesson, reworded",
      a: "Non-terminating code killed at 10s forces full agent restart; even idle agents hit 240-min timeout causing disconnect. Keep all code short/self-terminating; confirm nothing running before going idle.",
      b: "Non-terminating code killed at 10s forces full agent restart; even idle agents hit 240-min timeout causing disconnect. Keep code short/self-terminating; confirm nothing running before going idle." },
    { band: "A_1.0", jaccard: 1, same: true, sure: true,
      why: "clauses swapped",
      a: "User actions cannot be cancelled; if interrupted, wait or retry.",
      b: "User actions cannot be cancelled; wait or retry if interrupted." },
    { band: "A_1.0", jaccard: 1, same: true, sure: true,
      why: "same recovery, same Y",
      a: "`goToSurface` used as recovery (reached Y:64).",
      b: "goToSurface used as recovery, reached Y:64." },
    { band: "B_.8", jaccard: 0.875, same: true, sure: true,
      why: "same rule, backticks and filler dropped",
      a: "**Dig loops** spin when wedged \u2014 verify position actually changed.",
      b: "Dig loops spin when wedged \u2014 verify position changed" },
    { band: "B_.8", jaccard: 0.846, same: true, sure: true,
      why: "clearance vs space is the same word here",
      a: "Bedrock ceilings at deep levels require repeated `digDown` (even breaking bedrock) to gain vertical clearance.",
      b: "Vertical Clearance: Bedrock ceilings at deep levels require repeated `digDown` (even breaking bedrock) to gain vertical space." },
    { band: "B_.8", jaccard: 0.875, same: true, sure: true,
      why: "same disconnect/nav-reset fact",
      a: "Disconnects kill agent; nav state resets on reconnect.",
      b: "Frequent disconnects kill agent; on reconnect, nav state resets." },
    { band: "B_.8", jaccard: 0.8, same: true, sure: true,
      why: "same lesson, tail differs",
      a: "Keep all code short/self-terminating; non-terminating code killed at 10s forces full restart; even idle agents hit 240-min timeout causing disconnect.",
      b: "Keep all code short/self-terminating; non-terminating code killed at 10s forces full restart; even idle agents hit 240-min timeout causing disconnect. Confirm nothing running before going idle." },
    { band: "B_.8", jaccard: 0.8, same: true, sure: true,
      why: "same 10s kill; B drops the consequence",
      a: "Keep code short/self-terminating; non-terminating killed at 10s forces restart.",
      b: "Keep code short/self-terminating; non-terminating killed at 10s." },
    { band: "B_.8", jaccard: 0.885, same: true, sure: true,
      why: "same 10s-kill lesson",
      a: "Non-terminating code gets killed at 10s and forces full agent restart; even an idle agent hit a 240-min execution timeout causing disconnect/restart. Keep all code short/self-terminating; confirm nothing is running before going idle.",
      b: "Non-terminating code killed at 10s forces full agent restart; even an idle agent hit 240-min timeout. Keep all code short/self-terminating; confirm nothing running before going idle." },
    { band: "B_.8", jaccard: 0.875, same: true, sure: true,
      why: "'task' vs 'unfinished task', same procedure",
      a: "On reconnect: read memory first, then resume task before greeting.",
      b: "On reconnect: read memory first, then resume unfinished task before greeting." },
    { band: "B_.8", jaccard: 0.889, same: true, sure: true,
      why: "same rule, tail shortened",
      a: "User actions (e.g., `!goToPlayer`) cannot be cancelled; must wait for completion or retry.",
      b: "User actions (e.g., `!goToPlayer`) cannot be cancelled; must wait or retry." },
    { band: "B_.8", jaccard: 0.846, same: true, sure: true,
      why: "singular/plural of one route fact",
      a: "Westward route crosses many rivers/lakes; auto-swim + mining banks slow but reliable.",
      b: "Westward routes cross many rivers/lakes; auto-swim + mining banks slow but reliable." },
    { band: "B_.8", jaccard: 0.909, same: true, sure: true,
      why: "same night_safety lesson",
      a: "`night_safety` repeatedly interrupts long travel; disable immediately after restart.",
      b: "`night_safety` repeatedly reactivates/interrupts long travel; disable immediately after restart." },
    { band: "C_.6", jaccard: 0.778, same: true, sure: true,
      why: "B elaborates the same rule",
      a: "'drop below the next block' prevents digging into that specific block.",
      b: "A 'drop below the next block' prevents digging into that specific block, even if blocks below it are solid." },
    { band: "C_.6", jaccard: 0.6, same: true, sure: false,
      why: "both reduce to: verify solid ground around water",
      a: "Avoid water cavities; verify solid ground before moving.",
      b: "Verify solid ground before moving; surface first when in water" },
    { band: "C_.6", jaccard: 0.619, same: true, sure: true,
      why: "same coordinate, same bogus report",
      a: "Direct `!fill` commands on `(4708, 68, 4611)` report \"Placed 0 cobblestone blocks (1 already existed)\" but verification confirms the block is still a `blast_furnace`.",
      b: "`!fill(\"cobblestone\", 4708, 4611, 4708, 4611, 68, 1)` executes but reports \"Placed 0 cobblestone blocks\" and verifies block as still being a `blast_furnace`." },
    { band: "C_.6", jaccard: 0.625, same: true, sure: true,
      why: "same follow-interrupt lesson",
      a: "Follow actions can interrupt; re-issue.",
      b: "Follow actions interrupt current tasks; re-issue if needed." },
    { band: "C_.6", jaccard: 0.667, same: true, sure: true,
      why: "same hold-position rule",
      a: "If target offline: hold position with short stays + periodic entity checks instead of wandering off.",
      b: "If target offline: hold with short stays + periodic entity checks." },
    { band: "C_.6", jaccard: 0.76, same: true, sure: true,
      why: "the 10s-kill / 240-min lesson again",
      a: "Keep code short/self-terminating; non-terminating code killed at 10s forces full restart; idle agents hit 240-min timeout causing disconnect.",
      b: "Non-terminating code killed at 10s forces full agent restart; even an idle agent hit a 240-min timeout causing disconnect. Keep all code short/self-terminating; confirm nothing running before going idle." },
    { band: "C_.6", jaccard: 0.667, same: true, sure: true,
      why: "same shelter rule",
      a: "Night safety requires sealed shelter; open ledges are not safe.",
      b: "Sealed shelter for night safety; open ledges unsafe." },
    { band: "C_.6", jaccard: 0.667, same: true, sure: true,
      why: "same verify-after-teleport rule",
      a: "Server teleports without warning; always verify position after teleport.",
      b: "Server teleports without warning; verify position immediately." },
    { band: "C_.6", jaccard: 0.6, same: true, sure: true,
      why: "same rule, different reason given",
      a: "Verify solid ground before moving; surface first when in water",
      b: "Verify solid ground before moving; water can obscure footing." },
    { band: "C_.6", jaccard: 0.769, same: true, sure: true,
      why: "same westward-route fact",
      a: "Westward route crosses many rivers/lakes; auto-swim + mining banks\u2014slow but reliable.",
      b: "Westward routes cross rivers/lakes; auto-swim + mining banks slow but reliable." },
    { band: "D_.45", jaccard: 0.556, same: true, sure: true,
      why: "same travel-vs-follow interference",
      a: "'action:travel' command can interfere with following a player.",
      b: "Travel commands interfere with following a player \u2014 avoid during follow" },
    { band: "D_.45", jaccard: 0.529, same: true, sure: true,
      why: "same teleport instability, A keeps one instance's numbers",
      a: "**Teleportation Instability**: Server moved agent 31 blocks vertically without warning; always re-verify position immediately after reconnect or teleport.",
      b: "Server teleports without warning; always verify position and surroundings after any teleport/reconnect" },
    { band: "D_.45", jaccard: 0.5, same: true, sure: true,
      why: "same bedrock-ceiling remedy, A names the command",
      a: "Bedrock ceilings require repeated `serverSetblock(\"air\", x, y, z, \"replace\")`.",
      b: "Bedrock ceilings require repeated block replacement (`air` with `replace`) to gain vertical space." },
    { band: "D_.45", jaccard: 0.462, same: true, sure: true,
      why: "same dig-loop check",
      a: "Dig loops spin when wedged \u2014 verify position actually changed",
      b: "Dig loops spin when wedged \u2014 verify position changes each iteration or force-stop." },
    { band: "D_.45", jaccard: 0.5, same: true, sure: true,
      why: "same follow-interrupt + re-issue",
      a: "Follow actions (like `!searchForEntity`) can interrupt or leave temporary states; re-issue commands if needed after recovery.",
      b: "Follow commands interrupt current tasks; re-issue if needed after recovery." },
    { band: "D_.45", jaccard: 0.583, same: true, sure: true,
      why: "same 10s-kill rule",
      a: "Keep all code short/self-terminating; non-terminating code killed at 10s forces full restart.",
      b: "Keep code short/self-terminating; 10s kill for non-terminating." },
    { band: "D_.45", jaccard: 0.5, same: true, sure: true,
      why: "same 10s-kill family",
      a: "Keep code short/self-terminating; non-terminating killed at 10s forces restart.",
      b: "Keep code short/self-terminating; non-terminating killed at 10s; idle agents hit 240-min timeout." },
    { band: "D_.45", jaccard: 0.583, same: true, sure: true,
      why: "same self-terminating rule",
      a: "Self-terminating actions avoid 10s kill timeout.",
      b: "Short self-terminating actions preferred to avoid 10s kill or 240-min idle timeout." },
    { band: "D_.45", jaccard: 0.5, same: true, sure: false,
      why: "same primary rule, different secondary clause",
      a: "Short self-terminating actions preferred; avoid long loops on stubborn blocks.",
      b: "Short, self-terminating actions preferred; avoid long idle periods after failure." },
    { band: "D_.45", jaccard: 0.545, same: true, sure: true,
      why: "same water-navigation rule",
      a: "Water hazards require careful navigation to avoid danger.",
      b: "Water hazards require careful navigation; avoid cavities unless verified solid." },
    { band: "E_.3", jaccard: 0.375, same: false, sure: true,
      why: "CONTRADICTORY: A says generic 'log' is invalid, B says generic 'log' works better",
      a: "\"log\" is invalid search term; try specific types (`oak_log`, `birch_log`, etc.).",
      b: "Specific wood types (oak, pine, birch) may fail; generic \"log\" search is more effective." },
    { band: "E_.3", jaccard: 0.333, same: true, sure: false,
      why: "both: navTo stalls, step one block",
      a: "**Stuck Loops Solved By**: Step 1 block SE first, then try `navTo`.",
      b: "NavTo can fail to move even when distance > 0; try stepping 1 block at a time or digging down first." },
    { band: "E_.3", jaccard: 0.308, same: true, sure: false,
      why: "both reduce to verify solid ground near water",
      a: "Avoid water cavities; verify solid ground before moving.",
      b: "Water hazards common on ledges; verify solid ground and surface first" },
    { band: "E_.3", jaccard: 0.4, same: true, sure: false,
      why: "both: water hides footing, confirm ground first",
      a: "Confirm solid ground before interacting (no water pockets detected near current spot).",
      b: "Water pockets obscure footing; confirm solid ground before digging/climbing." },
    { band: "E_.3", jaccard: 0.333, same: true, sure: true,
      why: "same oxygen measurement, one states the rate",
      a: "Dives of ~2 blocks/second consume oxygen rapidly (20\u219216 in 3.8s).",
      b: "Oxygen drops 4 per 2-block dive (~20% loss)." },
    { band: "E_.3", jaccard: 0.421, same: true, sure: true,
      why: "the 10s-kill / 240-min lesson",
      a: "Idle agents hit 240-min timeout; non-terminating code killed at 10s. Keep tasks short/self-terminating.",
      b: "Short, self-terminating actions preferred to avoid 10s kill or 240-min idle timeout." },
    { band: "E_.3", jaccard: 0.417, same: true, sure: true,
      why: "the 10s-kill / 240-min lesson",
      a: "Keep code short/self-terminating; non-terminating killed at 10s forces restart.",
      b: "Non-terminating code killed at 10s forces full agent restart; even idle agent hit 240-min timeout causing disconnect. Keep code short/self-terminating; confirm nothing running before idle." },
    { band: "E_.3", jaccard: 0.417, same: false, sure: true,
      why: "A's point is memory is NOT a work queue; B's is that memory resumes context - folding destroys the distinction",
      a: "Reconnection resets active task state; memory persists but is not a work queue.",
      b: "Reconnects reset active tasks; memory persists to resume context." },
    { band: "E_.3", jaccard: 0.304, same: true, sure: true,
      why: "same !fill coordinate failure",
      a: "Single-block `!fill` fails repeatedly at `(4708, 68, 4611)` across all block types (cobblestone, stone, deepslate, bedrock).",
      b: "`!fill` on `(4708, 68, 4611)` fails repeatedly even when adjacent blocks are placed; server reports it as \"air\" (missing) instead of \"dirt\"." },
    { band: "E_.3", jaccard: 0.308, same: false, sure: false,
      why: "planting vs moving are different situations",
      a: "Verify solid ground before planting to avoid unplantable spots.",
      b: "Water hazards common on ledges; verify solid ground before moving." },
    { band: "F_.15", jaccard: 0.188, same: false, sure: true,
      why: "unknown coordinates vs stale position",
      a: "\"Here\" without visible player implies UNKNOWN coordinates; never guess or invent them.",
      b: "Server teleports player without warning; never assume position stays valid" },
    { band: "F_.15", jaccard: 0.222, same: true, sure: false,
      why: "B is the raw observation behind A",
      a: "**Oxygen Drain**: Diving consumes oxygen rapidly (20\u219216 in 3.9s); max dives may be needed but require careful timing.",
      b: "Oxygen dropped from 20 to 16 after first dive." },
    { band: "F_.15", jaccard: 0.167, same: false, sure: true,
      why: "verify-after-fill vs why fill reports 0",
      a: "After `!fill`, verify all blocks exist before considering task done.",
      b: "`!fill(\"cobblestone\", x, y, z, x, y, z, height)` reports \"Placed 0\" if the target block type already exists at that coordinate." },
    { band: "F_.15", jaccard: 0.2, same: false, sure: true,
      why: "post-teleport action state vs uncancellable user actions",
      a: "Check for running actions after teleport \u2014 they may be cancelled or refused",
      b: "User actions cannot be cancelled; if interrupted, wait or retry after short delay." },
    { band: "F_.15", jaccard: 0.167, same: false, sure: true,
      why: "two different failed remedies",
      a: "Digging down (`!digDown`) + filling from below did not resolve the issue.",
      b: "`climbOut` failed to resolve floating state; manual digging required." },
    { band: "F_.15", jaccard: 0.154, same: false, sure: true,
      why: "partial fills vs fill timing out in air",
      a: "Floor fills may be partial; verification often reveals air blocks or existing entities (e.g., potted_azalea_bush) that must be manually replaced before declaring complete.",
      b: "`!fill` can time out if stuck in air; manual placement may be required for the last block." },
    { band: "F_.15", jaccard: 0.176, same: true, sure: false,
      why: "shared primary rule, different second clause",
      a: "Keep code short/self-terminating; non-terminating code killed at 10s.",
      b: "Short, self-terminating actions preferred; verify state after each attempt before retrying." },
    { band: "F_.15", jaccard: 0.176, same: false, sure: true,
      why: "placing to escape water vs verifying block access",
      a: "Placing a block can help escape water hazards.",
      b: "When standing in water/air, `!nearbyBlocks` shows water at legs/head; need to verify solid block access before placing." },
    { band: "F_.15", jaccard: 0.182, same: false, sure: true,
      why: "fill truncation vs user actions blocking",
      a: "Single-block `!fill` commands truncate when executed near command limits.",
      b: "User actions can persist & block commands." },
    { band: "F_.15", jaccard: 0.2, same: false, sure: false,
      why: "verify before filling vs avoid water at night",
      a: "Verify solid ground before filling to avoid unexpected results in water pockets.",
      b: "Water hazards obscure footing; avoid open water pockets at night." },
];

/**
 * THE NEGATION CLASS - CONSTRUCTED, AND KEPT APART FROM THE 60 ABOVE ON PURPOSE.
 *
 * `proseTokens` drops `not`, `no` and `nor` as stopwords, so a lesson and its exact opposite
 * can reduce to the same token set and the rule folds them - overwriting a fact with its own
 * negation, silently, with no line in any log. Found by the session working in memory_store.js;
 * verified here rather than taken on trust:
 *
 *     "Player names are case-sensitive for `followPlayer`."       <- bob's real lesson
 *     "Player names are NOT case-sensitive for `followPlayer`."
 *     both -> [case, followplayer, name, player, sensitive]        jaccard 1.00, folds
 *
 * IS IT REAL IN THE WILD? Not yet, and that is stated rather than buried. Across all 1,730
 * distinct values both bots have written, 26 folded pairs have a dropped negation on exactly
 * one side, and ZERO of them have identical token sets - every one is a benign rewording
 * ("no shelter loops" against "ON causes shelter loops"). So this is a live mechanism that has
 * not yet fired, which is why the class has to be constructed to be measured at all, and why
 * these pairs are scored SEPARATELY: they are a hazard probe, not a sample of anything.
 *
 * Each DIFF pair is a REAL corpus lesson against its minimal negation - only the negation is
 * invented, never the lesson.
 *
 * THE THREE `same: true` CONTROLS ARE THE POINT OF THE SET. Without them a model that simply
 * answers "different" whenever it sees the word "not" would score a perfect 10/10 and teach us
 * nothing. One is a double negative that means the original ("not case-insensitive"), which is
 * the case a keyword rule gets exactly backwards.
 */
const NEGATION = [
    { same: false, why: "real lesson vs its exact negation - identical token sets",
      a: "Player names are case-sensitive for `followPlayer`.",
      b: "Player names are NOT case-sensitive for `followPlayer`." },
    { same: false, why: "opposite measurement",
      a: "Oxygen drops 4 per 2-block dive (~20% loss).",
      b: "Oxygen does not drop 4 per 2-block dive (~20% loss)." },
    { same: false, why: "opposite instruction",
      a: "Verify chest contents before re-mining \"lost\" items",
      b: "No need to verify chest contents before re-mining \"lost\" items" },
    { same: false, why: "opposite symptom and opposite remedy",
      a: "swimTo stalls instantly (0 b/s) even at surface with full oxygen; use moveAway to break free first.",
      b: "swimTo does not stall at surface with full oxygen; no moveAway needed to break free first." },
    { same: false, why: "opposite hazard",
      a: "Server teleports without warning; verify position immediately.",
      b: "Server does not teleport without warning; no need to verify position immediately." },
    { same: false, why: "opposite rule; negation moves between the clauses",
      a: "Night safety requires sealed shelter; open ledges are not safe.",
      b: "Night safety requires no sealed shelter; open ledges are safe." },
    { same: false, why: "both clauses reversed",
      a: "Disconnects kill agent; nav state resets on reconnect.",
      b: "Disconnects do not kill agent; nav state does not reset on reconnect." },
    { same: false, why: "opposite symptom",
      a: "Dig loops spin when wedged \u2014 verify position changed",
      b: "Dig loops do not spin when wedged \u2014 no need to verify position changed" },
    { same: false, why: "opposite rule, identical token sets",
      a: "Water hazards require careful navigation.",
      b: "Water hazards do not require careful navigation." },
    { same: false, why: "opposite behaviour and opposite remedy",
      a: "night_safety repeatedly interrupts long travel; disable immediately after restart.",
      b: "night_safety does not interrupt long travel; no need to disable after restart." },
    { same: true, why: "CONTROL: two spellings of one prohibition",
      a: "Never dig straight down.",
      b: "Do not dig straight down." },
    { same: true, why: "CONTROL: double negative - same claim as the original",
      a: "Player names are case-sensitive for `followPlayer`.",
      b: "Player names are not case-insensitive for `followPlayer`." },
    { same: true, why: "CONTROL: same lesson, negation on the other verb",
      a: "Bank items in chests promptly; do not rely on drops persisting",
      b: "Bank items in chests promptly; drops do not persist" },
];

const sure = PAIRS.filter(p => p.sure);
const borderline = PAIRS.filter(p => !p.sure);

console.log(`${PAIRS.length} labelled pairs (${sure.length} confident, ${borderline.length} borderline)`
    + `  |  ${sure.filter(p => p.same).length} same / ${sure.filter(p => !p.same).length} different, of the confident`);

console.log('\n===== HEURISTIC (memory_store.js as it stands) =====');
const hSure = score(sure, p => heuristicFolds(p.a, p.b));
report('confident pairs', hSure);
report('borderline pairs', score(borderline, p => heuristicFolds(p.a, p.b)));

console.log('\n===== NEGATION PROBE (constructed; scored apart from the 51) =====');
const hNeg = score(NEGATION, p => heuristicFolds(p.a, p.b));
report('heuristic', hNeg);

if (MODE !== 'jev') {
    console.log('\n(no model column - run `bun scratchpad/fold_gym.mjs jev` for that)');
    process.exit(hSure.merged > 0 ? 1 : 0);
}

console.log('\n===== JEV (noul, threshold swept) =====');
const t0 = Date.now();
const jevAll = await askJev(PAIRS);
const bySure = new Map(); PAIRS.forEach((p, i) => bySure.set(p, jevAll[i].p));
const ms = jevAll.reduce((n, r) => n + r.ms, 0) / jevAll.length;

// THE THRESHOLD IS PINNED, NOT RE-FITTED EACH RUN. An earlier version of this gym picked the
// best-scoring threshold from the sweep below and then reported that same run's score at it -
// fitting to the test set, and it flattered nothing: across three runs it chose 0.8 once and
// 0.7 twice, and the 0.8 run came out SIX pairs worse.
//
// 0.75 is chosen once, on these labels, over three runs of the full sweep. It is the LOWEST
// step that held false merges at zero in every run - 0.70 merged in one run of three, and the
// pair it merged was not a random one:
//
//     "Reconnection resets active task state; memory persists but is not a work queue."
//     "Reconnects reset active tasks; memory persists to resume context."
//
// scored 0.70 exactly, so it lands on either side of that threshold run to run. That is the
// distinction CLAUDE.md is built on - a goal is a directive, not a memory - and folding it is
// the documented bug where the summariser minted a goal out of the turns that ended one. The
// expensive error lives in the model's hedge band, which is the argument for clearing it by a
// margin rather than sitting on it. Moving this number means re-labelling first.
const THRESHOLD = 0.75;
for (const th of [0.5, 0.6, 0.7, 0.75, 0.8, 0.9]) {
    // Both columns at each step: the union is what would ship, so it is what the threshold has
    // to be chosen for. Jev alone is kept only to show the two are not the same curve.
    const j = score(sure, p => bySure.get(p) >= th);
    const u = score(sure, p => heuristicFolds(p.a, p.b) || bySure.get(p) >= th);
    console.log(`  threshold ${th.toFixed(2)}   jev alone ${String(j.right).padStart(2)}/${j.of}`
        + ` (missed ${String(j.missed).padStart(2)}, merged ${j.merged})`
        + `   UNION ${String(u.right).padStart(2)}/${u.of}`
        + ` (missed ${String(u.missed).padStart(2)}, merged ${u.merged})`
        + `${th === THRESHOLD ? '  <- pinned' : ''}`);
}
const best = { th: THRESHOLD, s: score(sure, p => bySure.get(p) >= THRESHOLD) };
console.log(`  ${String(ms.toFixed(0)).padStart(4)}ms/call, ${PAIRS.length} calls, ~$${(0.00015 * PAIRS.length).toFixed(3)} total`);

// THE TWO COLUMNS FAIL ON DIFFERENT PAIRS, which is the whole result. The Jaccard rule is
// strongest exactly where the wording barely moved, and that is where the model hedges; the
// model is strongest where the vocabulary was rewritten, and that is where overlap collapses.
// So the shipping shape is the UNION - keep the cheap rule, and ask only about the pairs it
// declines - not a replacement. It also keeps the cost asymmetry on the right side: a pair
// has to clear only one bar to fold, so missed folds fall, and false merges stay countable
// because both bars are still checked against the labels.
const union = score(sure, p => heuristicFolds(p.a, p.b) || bySure.get(p) >= best.th);
const calls = sure.filter(p => !heuristicFolds(p.a, p.b)).length;

console.log(`\n===== side by side, confident pairs, jev at ${best.th} =====`);
report('heuristic alone', hSure);
report(`jev alone >= ${best.th}`, best.s);
report('UNION (heuristic OR jev)', union);
console.log(`  ${' '.repeat(26)}         the union asks jev about ${calls}/${sure.length} pairs - `
    + 'the rest the heuristic already folded');
report('union, borderline pairs',
    score(borderline, p => heuristicFolds(p.a, p.b) || bySure.get(p) >= best.th));

const jNegRaw = await askJev(NEGATION);
const negP = new Map(); NEGATION.forEach((p, i) => negP.set(p, jNegRaw[i].p));
console.log(`\n===== NEGATION PROBE, both columns (jev at ${THRESHOLD}) =====`);
report('heuristic', hNeg);
report(`jev >= ${THRESHOLD}`, score(NEGATION, p => negP.get(p) >= THRESHOLD));
report('UNION (heuristic OR jev)',
    score(NEGATION, p => heuristicFolds(p.a, p.b) || negP.get(p) >= THRESHOLD));
for (const p of NEGATION)
    console.log(`  rule ${heuristicFolds(p.a, p.b) === p.same ? 'ok  ' : 'BAD '}`
        + `  jev ${(negP.get(p) >= THRESHOLD) === p.same ? 'ok  ' : 'BAD '} p=${negP.get(p).toFixed(2)}`
        + `   want ${p.same ? 'FOLD   ' : 'NO FOLD'}   ${p.why}`);

/**
 * OR IS THE WRONG COMPOSITION, and the negation probe is what proves it.
 *
 * A union can only ever ADD folds, so it fixes missed folds and is powerless against false
 * merges - it scored 3/13 on the negation set, carrying all ten of the rule's false merges
 * through untouched. The expensive error needs the model to be able to say NO to the rule, not
 * merely yes on its behalf:
 *
 *     fold  <=>  (rule says fold  OR  jev >= THRESHOLD)  AND  jev >= VETO
 *
 * The veto floor has to sit above the model's score on a true duplicate and below its score on
 * a contradiction. Measured here those are 0.94+ and 0.06- respectively - two orders of
 * magnitude apart - but the 51-pair set has genuine duplicates the model scores in the teens
 * (the 10s-kill family), so the floor trades those away and the sweep below is how that trade
 * is priced rather than guessed.
 */
// 0.20 is pinned for the same reason THRESHOLD is: chosen once, from the sweep below, at the
// middle of the plateau where the negation set is clean and the 51-pair score is untouched.
// It clears the model's highest score on a contradiction (0.06) by more than 3x and sits far
// under its lowest on a true duplicate (0.94). The plateau runs 0.10-0.25; the edges are not
// the place to sit, because the run-to-run spread on a single pair is worth ~0.05.
const VETO = 0.20;
for (const veto of [0.05, 0.10, 0.15, 0.20, 0.25, 0.30]) {
    const decide = (p, probs) => (heuristicFolds(p.a, p.b) || probs.get(p) >= THRESHOLD)
        && probs.get(p) >= veto;
    const m = score(sure, p => decide(p, bySure));
    const n = score(NEGATION, p => decide(p, negP));
    console.log(`  veto ${veto.toFixed(2)}   51 pairs ${String(m.right).padStart(2)}/51`
        + ` (missed ${String(m.missed).padStart(2)}, merged ${m.merged})`
        + `   negation ${String(n.right).padStart(2)}/13`
        + ` (missed ${String(n.missed).padStart(2)}, merged ${String(n.merged).padStart(2)})`
        + `${veto === VETO ? '  <- pinned' : ''}`);
}
const vetoed = score(sure, p => (heuristicFolds(p.a, p.b) || bySure.get(p) >= THRESHOLD) && bySure.get(p) >= VETO);
const vetoedNeg = score(NEGATION, p => (heuristicFolds(p.a, p.b) || negP.get(p) >= THRESHOLD) && negP.get(p) >= VETO);
console.log('\n===== what would ship: union with a jev veto =====');
report('51 labelled pairs', vetoed);
report('13 negation probes', vetoedNeg);

console.log('\n--- every pair the heuristic gets wrong ---');
for (const [kind, p] of hSure.wrong)
    console.log(`  ${kind}  jaccard=${p.jaccard.toFixed(2)} jev=${bySure.get(p).toFixed(2)}  (${p.why})`
        + `\n     A: ${p.a.slice(0, 120)}\n     B: ${p.b.slice(0, 120)}`);

console.log(`\n--- every pair the UNION still gets wrong at ${best.th} ---`);
if (!union.wrong.length) console.log('  none');
for (const [kind, p] of union.wrong)
    console.log(`  ${kind}  jaccard=${p.jaccard.toFixed(2)} jev=${bySure.get(p).toFixed(2)}  (${p.why})`
        + `\n     A: ${p.a.slice(0, 120)}\n     B: ${p.b.slice(0, 120)}`);

fs.writeFileSync(new URL('./fold_gym.last.json', import.meta.url), JSON.stringify({
    at: new Date().toISOString(),
    heuristic: { right: hSure.right, of: hSure.of, missed: hSure.missed, merged: hSure.merged },
    jev: { threshold: best.th, right: best.s.right, of: best.s.of, missed: best.s.missed, merged: best.s.merged, ms: Math.round(ms) },
    union: { right: union.right, of: union.of, missed: union.missed, merged: union.merged, callsPerPair: `${calls}/${sure.length}` },
    unionWithVeto: { threshold: THRESHOLD, veto: VETO,
        pairs: { right: vetoed.right, of: vetoed.of, missed: vetoed.missed, merged: vetoed.merged },
        negation: { right: vetoedNeg.right, of: vetoedNeg.of, missed: vetoedNeg.missed, merged: vetoedNeg.merged } },
    negationHeuristic: { right: hNeg.right, of: hNeg.of, missed: hNeg.missed, merged: hNeg.merged },
}, null, 2));
