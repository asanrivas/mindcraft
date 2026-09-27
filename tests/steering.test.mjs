// Steering store behaviour, no bot or server needed.
import fs from 'fs';
import { Steering } from '../src/agent/steering.js';

const NAME = '__steertest__';
const dir = `bots/${NAME}`;
fs.rmSync(dir, { recursive: true, force: true });

const s = new Steering({ name: NAME });
s.load();
let bad = 0;
const check = (label, cond) => { if (!cond) { console.error('FAIL:', label); bad++; } };

check('starts empty', s.directives.length === 0);
check('empty list message', s.list().includes('No steering directives'));
check('renders empty string', s.render() === '');

check('add ok', s.add('be brief, no questions').ok);
check('stored', s.directives.length === 1);
check('render includes text', s.render().includes('be brief, no questions'));
check('render has header', s.render().includes('STANDING INSTRUCTIONS'));

check('rejects duplicate', !s.add('BE BRIEF, NO QUESTIONS').ok);
check('rejects blank', !s.add('   ').ok);
check('rejects undefined', !s.add(undefined).ok);
check('rejects over-long', !s.add('x'.repeat(200)).ok);
check('whitespace collapsed', s.add('a    b\n\nc').ok && s.directives[1].text === 'a b c');

// persistence across a fresh instance
const s2 = new Steering({ name: NAME });
s2.load();
check('persisted across reload', s2.directives.length === 2);
check('persisted text', s2.directives[0].text === 'be brief, no questions');

check('bad index rejected', !s2.remove(99).ok);
check('zero index rejected', !s2.remove(0).ok);
check('remove ok', s2.remove(1).ok);
check('removed', s2.directives.length === 1);
check('clear all', s2.remove('all').ok);
check('cleared', s2.directives.length === 0);

// cap enforcement
const s3 = new Steering({ name: NAME });
for (let i = 0; i < 8; i++) s3.add(`rule number ${i}`);
check('cap reached at 8', s3.directives.length === 8);
check('9th rejected', !s3.add('one too many').ok);

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad === 0 ? 'PASS: steering store correct' : `FAIL: ${bad}`);
process.exit(bad ? 1 : 0);
