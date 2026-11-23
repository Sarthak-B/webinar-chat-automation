import assert from 'node:assert/strict';
import { Brain, detectLang, asksForNumber, firstName, teamVoice, mentionsPrice } from '../src/brain.js';

// language detection
const cases = {
  'What is the price?': 'english', 'Is EMI available for students?': 'english', 'I have a job, can I do this?': 'english',
  'price kya hai?': 'hinglish', 'EMI milega kya': 'hinglish', 'mujhe samajh nahi aaya': 'hinglish', 'recording milegi?': 'hinglish',
  'sir ye kaise kaam karta hai': 'hinglish', 'कीमत क्या है?': 'hindi', 'क्या EMI मिलेगी?': 'hindi', '🔥🔥': null, 'Mumbai': 'english',
};
for (const [t, want] of Object.entries(cases)) assert.equal(detectLang(t), want, `${t} → ${detectLang(t)} (want ${want})`);
assert.ok(asksForNumber('अपना नंबर शेयर करें')); assert.ok(asksForNumber('apna number drop karo')); assert.ok(!asksForNumber('Haan bilkul, EMI available hai'));
assert.equal(firstName('rahul sharma'), 'Rahul'); assert.equal(firstName('राहुल शर्मा'), 'राहुल');

// fake OpenAI
let next;
globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(next) } }] }) });
const b = new Brain({ openaiKey: 'x', model: 'x', personaName: 'Saurabh Sir',
  replies: [{ when: 'price', reply: '{Name}, $447 today – https://sb.flexifunnels.com/get?id=19029' }], objections: [{ key: 'obj1', objection: 'not technical', chat: 'No coding' }],
  numberBank: [{ angle: 'Trust', line: 'No spam. Drop your number 📞' }] });
assert.match(b.system, /on behalf of Saurabh Sir/); assert.match(b.system, /Never say you are AI/); assert.match(b.system, /our team/);
assert.equal(teamVoice('My team will call. Meri team call karegi. मेरी टीम कॉल करेगी'), 'Our team will call. Humari team call karegi. हमारी टीम कॉल करेगी');

next = { action: 'reply', reply: 'Haan bilkul, EMI ₹59/day se start hai', objection: null, safe_to_ask: true };
let d = await b.decide({ sender: 'Rahul', text: 'EMI milega kya', hasNumber: false });
console.log('hinglish reply w/o ask  →', d.reply); assert.ok(asksForNumber(d.reply)); assert.equal(d.lang, 'hinglish');

next = { action: 'reply', reply: 'हाँ, EMI उपलब्ध है', safe_to_ask: true };
d = await b.decide({ sender: 'राहुल', text: 'क्या EMI मिलेगी?', hasNumber: false });
console.log('hindi reply w/o ask     →', d.reply); assert.match(d.reply, /नंबर/);

next = { action: 'reply', reply: 'Yes! EMI is available. My team will call you on your number.', safe_to_ask: true };
d = await b.decide({ sender: 'Priya', text: 'Is EMI available?', hasNumber: true });
console.log('has number, no re-ask   →', d.reply);

next = { action: 'reply', reply: 'Buy here https://evil.example.com', safe_to_ask: true };
d = await b.decide({ sender: 'X', text: 'link?', hasNumber: false });
console.log('unknown link            →', d.action, '·', d.reason); assert.equal(d.action, 'escalate');

next = { action: 'escalate', reply: 'You are an idiot', safe_to_ask: false };
d = await b.decide({ sender: 'Troll', text: 'scam!!', hasNumber: false });
console.log('abusive                 →', d.action, '· reply:', d.reply); assert.equal(d.reply, null);

next = { message: 'Aap apna number share kijiye, meri team call karke sab samjha degi.' };
const ca = await b.compose({ purpose: 'ask', sender: 'Ankit', said: 'haan', lang: 'hinglish' });
console.log('compose ask (hinglish)  →', ca); assert.match(ca, /humari team/); assert.doesNotMatch(ca, /meri team/);
globalThis.fetch = async () => { throw new Error('network down'); };
console.log('AI down, ask fallback   →', await b.compose({ purpose: 'ask', sender: 'सुनीता', said: 'जी', lang: 'hindi' }));
console.log('AI down, thanks fallback→', await b.compose({ purpose: 'thanks', sender: 'Mike', said: '9876543210', lang: 'english' }));
d = await b.decide({ sender: 'Mike', text: 'what about refunds?', hasNumber: false });
console.log('AI down, decide         →', d.action, '·', d.reason);
// ---- pricing lock (hard rule: no pricing before 1h15m) ----
for (const t of ['It is $447 today', 'Rs. 59/day EMI', '₹36,999 incl. GST', 'EMI available hai', 'link: https://sb.flexifunnels.com/get?id=19029', 'token payment of 2,000 rupees', '$447 is today only', 'EMI उपलब्ध है'])
  assert.ok(mentionsPrice(t), `should be price: ${t}`);
for (const t of ['Our team will call you shortly.', 'Yes, you can connect your own domain.', '60 minutes a day is enough', 'Kripya apna number share kijiye', 'Sir will share the complete offer and pricing details later in this session'])
  assert.ok(!mentionsPrice(t), `not price: ${t}`);
globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ action: 'reply', reply: 'Ji, aaj ka offer $447 hai – https://sb.flexifunnels.com/get?id=19029', safe_to_ask: true }) } }] }) });
let locked = await b.decide({ sender: 'Rahul', text: 'price kya hai?', hasNumber: false, lang: 'hinglish', pricingLocked: true });
console.log('price asked, LOCKED     →', locked.reply); assert.ok(!mentionsPrice(locked.reply)); assert.ok(asksForNumber(locked.reply));
let open = await b.decide({ sender: 'Rahul', text: 'price kya hai?', hasNumber: false, lang: 'hinglish', pricingLocked: false });
console.log('price asked, unlocked   →', open.reply); assert.match(open.reply, /\$447/);
globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ message: 'EMI ₹59/day se, apna number share kijiye' }) } }] }) });
const ask = await b.compose({ purpose: 'ask', sender: 'सुनीता', said: 'जी', lang: 'hindi', pricingLocked: true });
console.log('number ask, LOCKED      →', ask); assert.ok(!mentionsPrice(ask));
console.log('✓ brain tests passed');
