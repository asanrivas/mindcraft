/**
 * Knowing the world's difficulty:
 *   bun tests/difficulty.test.mjs
 *
 * `mode:night_safety` interrupts every action in the agent, so a wrong answer here digs the bot
 * into a hole at dusk on a world where nothing can hurt it - cancelling whatever a person asked
 * for. This was fixed three times before it worked; each attempt is a case below.
 */
import { difficultyName, installDifficultyField, isPeaceful } from '../src/agent/difficulty.js';

let failures = 0;
const check = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};

// --- attempt 1: the falsy-zero bug in mineflayer's own guard -----------------------------------
// `if (packet.difficulty)` never fires for peaceful, because peaceful is 0.
check('numeric 0 is peaceful, not absent', difficultyName(0), 'peaceful');
check('numeric 1', difficultyName(1), 'easy');
check('numeric 3', difficultyName(3), 'hard');

// --- attempt 2: assuming the numeric form ------------------------------------------------------
// This server sends the STRING. `NAMES["peaceful"]` is undefined, which read as "no packet".
check('string form', difficultyName('peaceful'), 'peaceful');
check('string form, odd case', difficultyName('Hard'), 'hard');
check('a string that is not a difficulty is refused, not passed through',
    difficultyName('sometimes'), null);
check('absent', difficultyName(undefined), null);
check('null', difficultyName(null), null);
check('out of range index', difficultyName(9), null);

// --- attempt 3: losing the race to mineflayer's own listener -----------------------------------
// It is registered when the game plugin is injected - after createBot returns - so it always
// runs after ours and wrote `undefined` back over the correct value.
{
    const game = {};
    check('installs onto a real object', installDifficultyField(game), true);
    game.difficulty = 'peaceful';
    check('a good value is kept', game.difficulty, 'peaceful');
    game.difficulty = undefined;                 // <- mineflayer, a tick later
    check('a later undefined does NOT erase it', game.difficulty, 'peaceful');
    game.difficulty = null;
    check('null is refused too', game.difficulty, 'peaceful');
    game.difficulty = 'hard';
    check('a real change still lands', game.difficulty, 'hard');
    check('installing twice is harmless', installDifficultyField(game), true);
    check('...and does not reset the value', game.difficulty, 'hard');
    check('enumerable, so nothing that walks bot.game loses the key',
        Object.keys(game).includes('difficulty'), true);
}
// `bot.game` does not exist until mineflayer injects its plugins; touching it at construction
// threw and killed the agent process before it could log in.
check('no object: refuses rather than throwing', installDifficultyField(undefined), false);
check('not an object', installDifficultyField('peaceful'), false);

// --- the question callers actually ask ---------------------------------------------------------
check('peaceful', isPeaceful({ difficulty: 'peaceful' }), true);
check('normal', isPeaceful({ difficulty: 'normal' }), false);
// Unknown must NOT read as peaceful: the safe direction is to assume the night is dangerous.
check('unknown is not peaceful', isPeaceful({}), false);
check('no game object at all is not peaceful', isPeaceful(undefined), false);

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('difficulty: all checks passed');
