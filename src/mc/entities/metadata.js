/**
 * Entity metadata index tables, keyed by version.
 *
 * These raw indices are the single most version-fragile thing in the entity
 * layer: Mojang inserts a field into a parent class and every index below it
 * shifts by one, silently. Today the repo has one of these as a bare magic
 * number - `mob.metadata[16]` in src/utils/mcdata.js isHuntable(), used to
 * tell a baby animal from an adult. If that index shifts, isHuntable() starts
 * reading some unrelated boolean and the bot hunts babies (or refuses adults)
 * with no error anywhere.
 *
 * Keeping them here means one table to check against a wiki diff on a version
 * bump, instead of grepping for integers.
 */

// Indices are for the LivingEntity/Mob inheritance chain on modern versions.
// Verified against 1.21.x; 26.1 is assumed identical until the parity harness
// (docs/CLIENT_REPLACEMENT.md) says otherwise.
const MODERN = {
    // Ageable: true when the mob is a baby.
    isBaby: 16,
    // Entity base flags bitfield (bit 0x20 = invisible, 0x01 = on fire).
    entityFlags: 0,
    // LivingEntity health, float.
    health: 9,
};

const TABLES = {
    '1.21': MODERN,
    '26.1': MODERN,
};

/**
 * @param {string} version e.g. "1.21.11" or "26.1"
 * @returns {{isBaby: number, entityFlags: number, health: number}}
 */
export function metadataIndices(version) {
    if (TABLES[version]) return TABLES[version];
    // Fall back on major-version prefix ("1.21.11" -> "1.21").
    const major = String(version).split('.').slice(0, 2).join('.');
    return TABLES[major] ?? MODERN;
}

/**
 * Read a metadata value by index out of the wire format, which is a list of
 * {key, value} rather than a dense array.
 */
export function readMetadata(metadataList, index) {
    if (!Array.isArray(metadataList)) return undefined;
    const entry = metadataList.find((m) => m && m.key === index);
    return entry ? entry.value : undefined;
}
