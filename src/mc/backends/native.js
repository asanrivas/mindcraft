/**
 * The native (owned) BotClient backend. Not built yet - this is the M2+
 * target from the replacement plan (docs/CLIENT_REPLACEMENT.md): a
 * minecraft-protocol connection feeding a hand-owned world/entity/physics
 * layer, exposing the same BotClient contract as backends/mineflayer.js so
 * no call site in src/ has to change when this lands.
 *
 * Layer sequencing (borrow vs. build), from the plan:
 *   transport/codec  - BORROW minecraft-protocol + protodef + minecraft-data
 *   packet policy    - BUILD  src/mc/net/connection.js
 *   chunks/blocks    - BORROW prismarine-chunk/-block/-registry
 *   world store      - BUILD  src/mc/world/
 *   entities         - BUILD  src/mc/entities/
 *   physics          - BORROW prismarine-physics, then BUILD src/mc/physics/
 *   inventory/windows- BUILD  src/mc/inventory/
 *   crafting         - BORROW minecraft-data recipes, BUILD sequencing
 *   chat             - BUILD  src/mc/chat/
 */

export function createNativeBot(_options, _hooks = {}) {
    throw new Error(
        '[mc/backends/native] not implemented yet - see docs/CLIENT_REPLACEMENT.md milestone M2. ' +
        'Set settings.mc_client to "mineflayer" (the default) until then.'
    );
}
