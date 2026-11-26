// Lessons from the 24 Nov webinar: what must get NO reply, and promises that must never be sent.
import assert from 'node:assert/strict';
import { needsReply, stripPromises, stripQuote, firstName, detectLang, isTrivial } from '../src/brain.js';

const quiet = (t) => isTrivial(t) || !needsReply(t);
for (const t of ['Delhi', 'ILYAS FROM SURAT', 'Jin, Haryana', 'First time', 'yes sir first time', 'me', 'type 2', 'T2 & T3', 'F\nF', 'Cosmetic', 'own spices brand', 'Life Coach', 'thank you sir', 'hi I\'m Sayyed dastgir', 'good evening sir saourabh sir ji', '10%', '1lakh', 'Hear and See'])
  assert.ok(quiet(t), `should get no reply: ${t}`);
for (const t of ['how much price?', 'Total amount kitna hay', 'how to opt for EMI', 'what is 2% sir', 'sir hindi me boliye na', 'Can we learn offline?', 'aapka network slow lag raha hai sir', 'I sell Garlands in a market, can I go online', 'contact number'])
  assert.ok(!quiet(t), `should get a reply: ${t}`);

assert.equal(stripPromises('Thank you for your question. Our team will review and get back to you shortly.'), '');
assert.equal(stripPromises('We will have a team member reach out shortly to schedule a brief 10-15 minute call with you.'), '');
assert.equal(stripPromises('Sure, Sir will repeat that part now.'), '');
assert.equal(stripPromises('Jonty, aapka payment issue note kar liya hai. Humari team jald hi iski jaanch karke aapko update degi.'), '');
assert.equal(stripPromises('Sir will share the complete offer and pricing details later in this session. Please stay till then.'), 'Sir will share the complete offer and pricing details later in this session. Please stay till then.');
assert.equal(stripPromises('Azeem, your number has been shared with our senior mentors. They will contact you shortly.'), 'Azeem, your number has been shared with our senior mentors. They will contact you shortly.');
assert.match(stripPromises('You can choose EMI here: https://sb.flexifunnels.com/get?id=19029. Our team will guide you through the process.'), /^You can choose EMI here: https:\/\/sb\.flexifunnels\.com\/get\?id=19029\.?$/);

assert.equal(stripQuote('Replying to "Vishnu, the guides are…"\n\nok thanks'), 'ok thanks');
assert.equal(firstName('Oneplus Nord'), '');
assert.equal(firstName('Md Kamal Hussain'), 'Kamal');
assert.equal(detectLang('sir payment gateway wala sb repeat krdijiye plz'), 'hinglish');
console.log('✓ reply-quality tests passed');

// the webinar is a recording – no promises about what Sir will do
assert.equal(stripPromises("Ilyas, Sir will cover this in today's session – please stay connected till the end."), '');
assert.equal(stripPromises('Sir aaj ke session mein ise detail mein cover karenge – kripya end tak jude rahiye.'), '');
assert.equal(stripPromises('The complete offer and pricing come later in this session – please stay connected till then.'), 'The complete offer and pricing come later in this session – please stay connected till then.');
console.log('✓ recording-safe reply tests passed');

// 26 Nov: problems/concerns must never be skipped
for (const t of ['My friend he cnt joining', 'looks like this is recording', 'no sound', 'link not working', 'payment failed'])
  assert.ok(needsReply(t), `should reach the AI/team: ${t}`);
console.log('✓ problem/concern tests passed');

// recording answers (26 Nov)
assert.equal(stripPromises("Rahul, the recording of today's session will be provided tomorrow."), "Rahul, the recording of today's session will be provided tomorrow.");
assert.equal(stripPromises('Rahul, please drop your number here – our senior mentor team will give you the recording personally after the session.'), 'Rahul, please drop your number here – our senior mentor team will give you the recording personally after the session.');
console.log('✓ recording answer tests passed');
