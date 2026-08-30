// One-time compaction of an already-polluted store, using the same identity rules the store
// now applies on write. Reinforcement is PRESERVED: when rows fold together the surviving row
// keeps the sum of their revisions, so a lesson learned six times outranks one narrated once.
import { proseTokens, proseSimilarity } from '../src/agent/memory_store.js';
import { readFileSync, writeFileSync } from 'fs';

const PROSE = new Set(['lesson','note']);
const CAPS = { goal: 1, location: 12, player: 8, lesson: 10, note: 10 };
const DUP = 0.6, MIN_TOKENS = 5;

const file = process.argv[2];
const snap = JSON.parse(readFileSync(file,'utf8'));
const rows = Array.isArray(snap.records) ? snap.records : Object.values(snap.records);
console.log('before:', rows.length, 'rows');

const out = [];
for (const r of [...rows].sort((a,b)=>a.updated-b.updated)) {
    if (PROSE.has(r.kind) && r.origin === 'agent') {
        const tok = proseTokens(r.value);
        if (tok.length >= MIN_TOKENS) {
            let best=null, bs=0;
            for (const o of out) {
                if (o.kind !== r.kind || o.origin !== 'agent') continue;
                const ot = proseTokens(o.value);
                if (ot.length < MIN_TOKENS) continue;
                const sc = proseSimilarity(tok, ot);
                if (sc > bs) { best=o; bs=sc; }
            }
            if (best && bs >= DUP) {           // fold: keep the newer wording, sum reinforcement
                best.revision = (best.revision||1) + (r.revision||1);
                best.value = r.value; best.updated = r.updated;
                continue;
            }
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
console.log('after :', kept.length, 'rows');
for (const k of Object.keys(CAPS)) {
    const n = kept.filter(r=>r.kind===k).length, was = rows.filter(r=>r.kind===k).length;
    if (was) console.log(`  ${k.padEnd(9)} ${was} -> ${n}`);
}
snap.records = kept;
writeFileSync(file, JSON.stringify(snap, null, 2));
console.log('\nkept lessons:');
for (const r of kept.filter(r=>r.kind==='lesson')) console.log(`  [rev ${String(r.revision).padStart(2)}] ${r.value.slice(0,95)}`);
