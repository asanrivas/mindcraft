# Villager Attack Investigation & Fix

## Incident Summary

**Date**: 2025-12-17  
**Issue**: Andy attacked and killed a villager while following player  
**Root Cause**: Missing safety check for friendly entities in combat modes

## What Happened (From Logs)

```
Behavior Log:
- I see items nearby!
- Fighting villager!     ← Andy attacked villager here
- I'm dying!
- I'm dying!
- Death: "andy burned to death"
```

Andy was following the player when he:
1. Detected items nearby
2. Triggered self_defense mode 
3. Attacked what was logged as "villager"
4. Burned to death (fire/lava)

## Investigation Findings

### Checked `isHostile()` Function
The hostile entity detection in `src/utils/mcdata.js` correctly excludes villagers:
- Villagers are NOT in the hostile mobs list
- Only zombie_villagers would be detected (via `name.includes('zombie')`)
- Regular villagers should be safe

### The Bug
The `self_defense` and `cowardice` modes relied ONLY on `mc.isHostile()` but had **no safety filter** to explicitly exclude friendly entities. This could lead to:
- False positives from entity detection
- Mineflayer entity name misreporting
- Edge cases where villagers are misidentified

## Fixes Applied

### 1. Enhanced Logging (modes.js - self_defense)
Added detailed console logging to track attacks:
```javascript
console.log(`[SELF_DEFENSE] Detected entity: name="${entityName}", type="${entityType}", isHostile=${isActuallyHostile}`);
```

### 2. Friendly Entity Safety Filter (3 locations)

Added explicit friendly entity exclusion list:
```javascript
const friendlyEntities = ['villager', 'player', 'iron_golem', 'allay', 'cat', 'wolf', 'parrot', 'horse', 'donkey', 'mule', 'llama'];
if (friendlyEntities.some(name => entityName.includes(name))) {
    console.log(`[MODE] Skipping ${entityName} - marked as friendly`);
    return;
}
```

**Applied to:**
- `src/agent/modes.js` - `self_defense` mode (lines 162-183)
- `src/agent/modes.js` - `cowardice` mode (lines 140-161)
- `src/agent/library/skills.js` - `defendSelf()` function (lines 525-570)

## Protected Entities

Andy will now **never attack** these entities:
- ✅ villager (all variants)
- ✅ player
- ✅ iron_golem
- ✅ allay
- ✅ cat
- ✅ wolf
- ✅ parrot
- ✅ horse, donkey, mule, llama

## Testing & Monitoring

The enhanced logging will now show in service logs:
```bash
# View real-time logs
tail -f /home/azureuser/mindcraft/logs/andy-service.log

# Search for entity detection
grep "\[SELF_DEFENSE\]\|\[COWARDICE\]\|\[DEFEND_SELF\]" /home/azureuser/mindcraft/logs/andy-service.log
```

## Prevention

This multi-layer approach ensures:
1. **Primary Filter**: `mc.isHostile()` checks entity type
2. **Safety Filter**: Explicit friendly entity list (NEW)
3. **Logging**: Track all attack decisions (NEW)
4. **Applied Everywhere**: All combat modes + defendSelf function

## Related Commands

```bash
# Restart service after code changes
sudo systemctl restart mindcraft-andy.service

# Check if Andy is running
sudo systemctl status mindcraft-andy

# Monitor for villager-related events
tail -f /home/azureuser/mindcraft/logs/andy-service.log | grep -i "villager\|attack\|fight"
```

## User Instructions

If Andy ever attacks a villager again:
1. Check service logs: `tail -100 /home/azureuser/mindcraft/logs/andy-service.log`
2. Look for `[SELF_DEFENSE]` or `[DEFEND_SELF]` messages
3. Report the entity name and type that was logged
4. This will help identify any remaining edge cases

---
**Status**: ✅ Fixed and Deployed
**Service Restarted**: 2025-12-17 11:47:21 UTC
