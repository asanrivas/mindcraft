/**
 * Resolving "here" - and every other word that points at the speaker.
 *
 * "Bob. build hut here" carries no coordinates. The model only ever sees the bot's OWN
 * position ($STATS), so when a player says "here" while the bot is 100 blocks away
 * mid-navigation, the model fabricates plausible-looking coordinates near ITSELF - observed
 * 2026-08-29: hut requested at the player, planned at x=4912 (the bot's x), z=5066 (invented),
 * then garbled into a 2.3-million-block !fill. The model cannot use what it never receives.
 *
 * So: when a human's message points at their own location, append a system note with the
 * speaker's real position - or an explicit "position unknown" when their entity is not
 * visible, because silence there is exactly the fabrication trap again.
 *
 * The detection is deliberately cheap and FAILS OPEN in the harmless direction: a false
 * positive costs one extra line of context; a false negative reproduces the hut bug. So the
 * word list is broad and there is no attempt to be clever about grammar.
 */

/**
 * Words and phrases that point at the speaker's location. Word-bounded so "adhere" and
 * "coherent" do not fire. "there" is deliberately absent - it points AWAY from the speaker,
 * and a position note would be wrong more often than right.
 */
const DEICTIC = new RegExp(
    [
        '\\bhere\\b',                       // "build hut here", "over here", "come here"
        '\\bto me\\b', '\\bat me\\b',       // "bring it to me"
        '\\bcome\\b', '\\bfollow me\\b',
        '\\bthis spot\\b', '\\bthis place\\b', '\\bright where\\b',
        '\\bwhere i am\\b', "\\bwhere i'm\\b", '\\bmy (position|location|spot|place)\\b',
        '\\bnext to me\\b', '\\bbeside me\\b', '\\bnear me\\b', '\\bby me\\b',
    ].join('|'),
    'i'
);

/**
 * Does this message point at the speaker's own location?
 * @param {string} text
 * @returns {boolean}
 */
export function isDeictic(text) {
    if (typeof text !== 'string' || !text) return false;
    return DEICTIC.test(text);
}

/**
 * The note appended to history when the speaker's position is known.
 * Phrased as fact, not instruction: the model treats system lines as ground truth, and
 * "here means (x,y,z)" survives even when the deictic word was incidental.
 * @param {string} name    speaker's username
 * @param {{x:number,y:number,z:number}} pos
 * @returns {string}
 */
export function deixisNote(name, pos) {
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    return `${name} is standing at (${x}, ${y}, ${z}). Words like "here"/"come"/"to me" in their message refer to that position, not to yours.`;
}

/**
 * The note when the speaker's entity is NOT visible (out of render distance, other
 * dimension, or a non-player source like Rcon). Explicitly forbids inventing coordinates -
 * the failure this whole module exists to prevent.
 * @param {string} name
 * @returns {string}
 */
export function deixisUnknownNote(name) {
    return `${name} said "here" (or similar) but you cannot see them, so their position is UNKNOWN. Do not guess or invent coordinates - ask them for coordinates or to come closer.`;
}

/**
 * The full decision, pure so it is testable: given the message and the speaker's entity
 * position (or null/undefined when not visible), return the system note to add - or null
 * when the message does not point at the speaker.
 * @param {string} name
 * @param {string} text
 * @param {{x:number,y:number,z:number}|null|undefined} pos
 * @returns {string|null}
 */
export function deixisVerdict(name, text, pos) {
    if (!isDeictic(text)) return null;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
        return deixisNote(name, pos);
    }
    return deixisUnknownNote(name);
}
