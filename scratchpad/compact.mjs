// One-time compaction of an already-polluted store, using the same identity rules the store
// now applies on write. Reinforcement is PRESERVED: when rows fold together the surviving row
// keeps the sum of their revisions, so a lesson learned six times outranks one narrated once.
import { proseTokens, proseSimilarity, proseSequence, isTransientPlaceKey, isTransientPlaceValue } from '../src/agent/memory_store.js';
import { readFileSync, writeFileSync } from 'fs';

const PROSE = new Set(['lesson','note']);
const CAPS = { goal: 1, location: 12, player: 8, lesson: 10, note: 10 };
const DUP = 0.6, MIN_TOKENS = 5, EXACT_MIN_TOKENS = 2;

const file = process.argv[2];
const snap = JSON.parse(readFileSync(file,'utf8'));
const rows = Array.isArray(snap.records) ? snap.records : Object.values(snap.records);
console.log('before:', rows.length, 'rows');

const out = [];
let dropped = 0;
for (const r of [...rows].sort((a,b)=>a.updated-b.updated)) {
    // Episode bookkeeping the store now refuses on write, but which is already sitting here and
    // - until the probation slice existed - could never be evicted: bob still holds
    // `hold_spot@X` at revision 66 and `current@X` at 65.
    if (r.kind === 'location' && r.origin === 'agent'
        && (isTransientPlaceKey(r.key) || isTransientPlaceValue(r.key, r.value))) {
        console.log(`  drop transient place: ${r.key} = ${String(r.value).slice(0,60)}`);
        dropped++;
        continue;
    }
    if (PROSE.has(r.kind) && r.origin === 'agent') {
        const tok = proseTokens(r.value);
        let best=null, bs=0;
        if (tok.length >= MIN_TOKENS) {
            for (const o of out) {
                if (o.kind !== r.kind || o.origin !== 'agent') continue;
                const ot = proseTokens(o.value);
                if (ot.length < MIN_TOKENS) continue;
                const sc = proseSimilarity(tok, ot);
                if (sc > bs) { best=o; bs=sc; }
            }
        } else if (tok.length >= EXACT_MIN_TOKENS) {
            // Too short for a fuzzy match to be safe, but an IDENTICAL content-word set is not a
            // fuzzy match. This is what leaves "...when a player says stop." beside "...when
            // player says stop." - 4 tokens each, so MIN_TOKENS refused to fold them.
            for (const o of out) {
                if (o.kind !== r.kind || o.origin !== 'agent') continue;
                const ot = proseTokens(o.value);
                if (proseSequence(o.value).join(' ') === proseSequence(r.value).join(' ')) { best=o; bs=1; break; }
            }
        }
        if (best && bs >= DUP) {               // fold: keep the newer wording, sum reinforcement
            best.revision = (best.revision||1) + (r.revision||1);
            best.value = r.value; best.updated = r.updated;
            continue;
        }
    }
    out.push({ ...r });
}

const kept = [];
for (const kind of Object.keys(CAPS)) {
    const mine = out.filter(r => r.kind === kind);
    const user = mine.filter(r => r.origin !== 'agent');
    const agent = mine.filter(r => r.origin === 'agent')
        .sort((a,b) => (b.revision - a.revision) || (b.updated - a.updated));   // best first
    kept.push(...user, ...agent.slice(0, Math.max(0, CAPS[kind] - user.length)));
}
console.log('after :', kept.length, 'rows', `(${dropped} transient place row(s) dropped)`);
for (const k of Object.keys(CAPS)) {
    const n = kept.filter(r=>r.kind===k).length, was = rows.filter(r=>r.kind===k).length;
    if (was) console.log(`  ${k.padEnd(9)} ${was} -> ${n}`);
}
snap.records = kept;
writeFileSync(file, JSON.stringify(snap, null, 2));
console.log('\nkept lessons:');
for (const r of kept.filter(r=>r.kind==='lesson')) console.log(`  [rev ${String(r.revision).padStart(2)}] ${r.value.slice(0,95)}`);
