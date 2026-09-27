# Plan: Dramatically Improving Andy's "Context Sense"

This document outlines the strategy to transform Andy from a text-parser into an embodied agent with strong spatial and temporal awareness.

## 1. Spatial Geometry (`$SURROUNDINGS`)

**The Problem:**
Currently, Andy relies on list-based commands (`!nearbyBlocks`) or active queries (`!surroundings`) to understand his environment. He lacks a constant, proprioceptive "sense" of his immediate physical space.

**The Solution:**
Inject a structured **5x5x3 3D representation** of the immediate voxel grid directly into the system prompt.

### Implementation: `getSurroundingsGrid(bot)`
*   **Scope:** 5x5x3 grid centered on the bot.
    *   **Horizontal (X/Z):** Radius 2 (5 blocks wide). Allows seeing obstacles/paths slightly ahead.
    *   **Vertical (Y):** Radius 1 (Feet, Body, Head). Sufficient for local navigation.
*   **Logic:**
    *   Iterate relative coordinates: `x: -2 to 2`, `z: -2 to 2`, `y: -1 to 1`.
    *   Use `bot.blockAt(bot.entity.position.offset(x, y, z))`.
    *   **Symbols:** Map common blocks to single chars for token efficiency (Air=`_`, Stone=`#`, Water=`~`, Lava=`!`, You=`@`).
*   **Format Example:**
    ```text
    IMMEDIATE SURROUNDINGS (Facing: NORTH):
    [HEAD LEVEL y+1]:
      _ _ _ _ _
      _ _ _ _ _
      _ _ @ _ _  (@ = You)
      _ _ _ _ _
      _ _ _ _ _
    [BODY LEVEL y+0]:
      _ _ # _ _  (# = Stone Wall)
      _ _ # _ _
      _ _ @ _ _
      _ _ _ _ _
      _ _ _ _ _
    [FEET LEVEL y-1]:
      # # # # #
      # # # # #
      # # # # #
      # # # # #
      # # # # #
    ```

## 2. Environmental Context (`$ENV_CONTEXT` / Enhanced `$STATS`)

**The Problem:**
`!stats` provides raw numbers (Health: 20) but lacks *situational meaning*.

**The Solution:**
Enhance the statistics block to include derived environmental data.

### Implementation details
*   **Biome:** `bot.world.getBiome(pos)` -> e.g., "Plains", "Deep Dark".
*   **Light Level:** `block.light` (Sky vs Block).
    *   *Interpretation:* If `light < 7`, append "(DANGER: Mobs)".
*   **Time:** Interpret `bot.time.timeOfDay`.
    *   *Interpretation:* "Night (Monsters active)" vs "Day (Safe)".
*   **Status Effects:** Read `bot.entity.effects`.

## 3. Action History (`$RECENT_ACTIONS`)

**The Problem:**
Andy often "forgets" his immediate physical history (e.g., repeating failed pathfinding).

**The Solution:**
Inject a log of the last 5-10 physical events/outcomes.

### Implementation: `getRecentActions(agent)`
*   **Source:** Scan `Agent.history` for recent system messages containing specific failure/success keywords.
*   **Format:**
    ```text
    RECENT PHYSICAL HISTORY:
    - [10s ago] Pathfinding to (100, 64, 100) -> FAILED (Stuck)
    - [05s ago] Digging Stone -> SUCCESS
    - [02s ago] Placed Torch -> SUCCESS
    ```

## Execution Plan

1.  **Modify `andy.json`**:
    *   Add placeholders `$SURROUNDINGS` and `$RECENT_ACTIONS` to prompts.

2.  **Update `src/models/prompter.js`**:
    *   **Import:** `Vec3`.
    *   **Method:** `getSurroundingsGrid(bot)` (Logic updated for 5x5x3).
    *   **Method:** `getRecentActions(agent)`
    *   **Method:** `replaceStrings()` -> Bind the new methods to the placeholders.

3.  **Verification**:
    *   Start Andy.
    *   Inspect `logs/andy-service.log`.
    *   Verify the prompt contains the new sections.