/**
 * Knowing what difficulty the world is on. Two small rules, both learned the hard way.
 *
 * `mode:night_safety` interrupts every action in the agent, so a wrong answer here is not a
 * cosmetic problem: on a Peaceful world the bot digs itself a hole at dusk, cancelling whatever
 * a person asked for, and gains nothing because nothing hostile spawns. It took three attempts
 * to make `bot.game.difficulty` trustworthy, and each failure looked exactly like the last.
 */

const NAMES = ['peaceful', 'easy', 'normal', 'hard'];

/**
 * The difficulty name from whatever the wire happened to carry, or null.
 *
 * **The form is not stable across versions.** mineflayer assumes the numeric index
 * (`difficultyNames[packet.difficulty]`, game.js:134), and on this server (protocol 774) the
 * `difficulty` packet carries the STRING `"peaceful"` - so its lookup yields `undefined` and the
 * field is never set. The `login` packet, meanwhile, has no `difficulty` field at all any more.
 * Accept both forms; refuse to guess from anything else.
 *
 * `0` is peaceful and is falsy, which is the original bug in mineflayer's own
 * `if (packet.difficulty)` guard - so the absence test has to be `== null`, never truthiness.
 */
export function difficultyName(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return NAMES[raw] ?? null;
    const s = String(raw).toLowerCase();
    return NAMES.includes(s) ? s : null;
}

/**
 * Make `game.difficulty` ignore writes of `undefined`/`null`.
 *
 * Not a race we can win by registering later: mineflayer's own listener is attached when its
 * game plugin is injected, which happens after `createBot` returns, so it always runs after
 * ours and its `difficultyNames["peaceful"]` puts `undefined` back a moment after we set the
 * right value. Measured - the guard kept reading `undefined` with a working listener attached.
 *
 * A write of `undefined` means "this client could not parse the packet", never "the difficulty
 * is now unknown". Encoding that in the field makes ordering irrelevant in both directions.
 *
 * Idempotent, and returns false if there is nothing to install onto - `bot.game` DOES NOT EXIST
 * until mineflayer injects its plugins, and touching it at construction throws and kills the
 * agent before it can log in.
 */
export function installDifficultyField(game) {
    if (!game || typeof game !== 'object') return false;
    const existing = Object.getOwnPropertyDescriptor(game, 'difficulty');
    if (existing && existing.get) return true;          // already installed
    let value = game.difficulty;
    Object.defineProperty(game, 'difficulty', {
        get: () => value,
        set: (v) => { if (v != null) value = v; },
        configurable: true,
        enumerable: true,
    });
    return true;
}

/** Is the world Peaceful? Unknown is NOT peaceful - the safe direction is to assume danger. */
export function isPeaceful(game) {
    return String(game?.difficulty ?? '').toLowerCase() === 'peaceful';
}
