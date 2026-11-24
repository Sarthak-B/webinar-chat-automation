import assert from 'node:assert/strict';
import { ChatSync } from '../src/chatsync.js';

const m = (s) => s.split(' ').map((x) => ({ sender: x[0], text: x.slice(1) }));
const f = (r) => r.fresh.map((x) => x.sender + x.text).join(' ');
const c = new ChatSync();
assert.equal(f(c.ingest(m('Aa Bb Cc'))), ''); // chat from before joining is not answered
assert.equal(f(c.ingest(m('Bb Cc Dd Ee'))), 'Dd Ee');
assert.equal(f(c.ingest(m('Cc Dd Ee Aa'))), 'Aa'); // A repeats an old message → still new
assert.equal(f(c.ingest(m('Cc Dd Ee Aa Aa'))), 'Aa'); // same person, same text twice → both handled
assert.equal(f(c.ingest(m('Aa Bb Cc'))), ''); // old part of the chat drawn again
assert.equal(f(c.ingest(m('Ee Aa Aa'))), ''); // nothing new
const g = c.ingest(m('Xx Yy Zz'));
assert.equal(f(g), 'Xx Yy Zz');
assert.equal(g.gap, true); // nothing lines up → reported so the team can check
console.log('chatsync tests passed');
