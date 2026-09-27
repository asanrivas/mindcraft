/**
 * Potted plants: the block you want is not an item you can hold.
 *
 *   bun tests/potted.test.mjs
 *
 * Found live on 2026-08-30, mid-build:
 *   [builder] equip potted_cherry_sapling failed: undefined is not an object
 *             (evaluating 'item.components.length')
 *
 * There is no `potted_cherry_sapling` ITEM. A player places a `flower_pot` and then uses the
 * sapling on it. `mc.makeItem` for a name with no item form does not fail cleanly - it yields
 * something prismarine-item cannot serialise, and the throw surfaces from deep inside the equip
 * looking like a library bug rather than a blueprint the builder cannot express.
 *
 * The important half of this file is the sweep at the bottom: it checks the mapping against the
 * REAL 1.21.11 item table for every potted block that exists, so a wrong rename cannot pass by
 * agreeing with a hand-written expectation.
 */
import { pottedPlantItem } from '../src/agent/library/blueprint_builder.js';

let failures = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}

// the three that were actually in survival_base.json
check('potted_cherry_sapling', pottedPlantItem('potted_cherry_sapling'), 'cherry_sapling');
check('potted_azure_bluet',    pottedPlantItem('potted_azure_bluet'), 'azure_bluet');
// the block says "bush"; the item does not. A mechanical strip gets this one wrong.
check('potted_azalea_bush -> azalea', pottedPlantItem('potted_azalea_bush'), 'azalea');
check('potted_flowering_azalea_bush -> flowering_azalea',
    pottedPlantItem('potted_flowering_azalea_bush'), 'flowering_azalea');

// Not potted blocks: these must return null, or itemNameFor would send a flower_pot for them.
check('a plain block is not potted', pottedPlantItem('stone'), null);
check('the empty pot itself is not potted', pottedPlantItem('flower_pot'), null);
// "potted_" as a bare prefix with nothing after it is not a plant.
check('bare prefix is not potted', pottedPlantItem('potted_'), null);
check('a substring match does not count', pottedPlantItem('unpotted_thing'), null);
check('non-strings are safe', pottedPlantItem(null), null);
check('undefined is safe', pottedPlantItem(undefined), null);

// --- the sweep: every potted block this server's data knows about must resolve to a real item ---
const md = require('minecraft-data')('1.21.11');
const items = new Set(md.itemsArray.map((i) => i.name));
const pottedBlocks = md.blocksArray.map((b) => b.name).filter((n) => n.startsWith('potted_'));

check('there are potted blocks to check', pottedBlocks.length > 0, true);
// If any potted block WERE an item, the two-step would be unnecessary for it and the simple
// path would have worked - so this asserts the premise of the whole patch.
const alsoItems = pottedBlocks.filter((b) => items.has(b));
check('no potted block is itself an item', alsoItems.length, 0);
check('flower_pot IS an item', items.has('flower_pot'), true);

const unresolved = pottedBlocks.filter((b) => {
    const item = pottedPlantItem(b);
    return !item || !items.has(item);
});
check(`all ${pottedBlocks.length} potted blocks map to a real item`, unresolved.join(',') || 'none', 'none');

console.log(failures === 0 ? 'potted: all checks passed' : `potted: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
