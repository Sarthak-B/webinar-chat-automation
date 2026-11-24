// Works out which chat messages are new from what the Zoom panel shows.
//
// Zoom only draws the newest part of the chat, so each read is a "window" – a run of consecutive
// messages from the full chat. We keep the order of every message seen so far (the transcript).
// A new window normally starts with messages we already have and ends with new ones:
//     transcript: … A B C D            window: C D E F   →  E F are new
// Matching by order (not by counting copies) means:
//   - the same person sending the same text twice is still two messages
//   - an old part of the chat being drawn again (list scrolled up) is not mistaken for new messages
//   - if a window shares nothing with the transcript, messages were lost in between → reported as a gap
const keyOf = (m) => `${m.sender}\u0001${m.text}`;

export class ChatSync {
  constructor(max = 5000) {
    this.max = max;
    this.keys = []; // transcript, oldest first
    this.started = false;
  }

  // Returns { fresh: [messages], gap: boolean }. The very first window only sets the starting point
  // (chat from before the agent joined is not answered).
  ingest(win) {
    if (!win || !win.length) return { fresh: [], gap: false };
    const w = win.map(keyOf);
    if (!this.started) {
      this.started = true;
      this.#push(w);
      return { fresh: [], gap: false };
    }
    const T = this.keys;
    // longest p: the first p messages of the window are the last p of the transcript
    let p = 0;
    for (let len = Math.min(w.length, T.length); len > 0; len--) {
      let ok = true;
      for (let i = 0; i < len; i++) {
        if (w[i] !== T[T.length - len + i]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        p = len;
        break;
      }
    }
    // A 1-message overlap is weak evidence (e.g. an old part of the chat drawn again that happens to start
    // with the newest message's text). If the whole window is a stretch we already have, it is old.
    if (p === 1 && w.length >= 3 && this.#contains(w)) return { fresh: [], gap: false };
    if (p > 0) {
      const fresh = win.slice(p);
      this.#push(w.slice(p));
      return { fresh, gap: false };
    }
    // nothing lines up with the end – is it an older part of the chat drawn again?
    if (this.#contains(w)) return { fresh: [], gap: false };
    // the window ends inside what we have but starts before it in an odd way (e.g. a deleted message):
    // take only what comes after the newest message we know
    const last = T.at(-1);
    const at = w.lastIndexOf(last);
    if (at >= 0 && this.#contains(w.slice(0, at + 1).slice(-3))) {
      const fresh = win.slice(at + 1);
      this.#push(w.slice(at + 1));
      return { fresh, gap: false };
    }
    // completely new window: more messages arrived than Zoom keeps on screen – some may be lost
    this.#push(w);
    return { fresh: win.slice(), gap: true };
  }

  #contains(w) {
    const T = this.keys;
    outer: for (let s = T.length - w.length; s >= 0; s--) {
      for (let i = 0; i < w.length; i++) if (T[s + i] !== w[i]) continue outer;
      return true;
    }
    return false;
  }

  #push(keys) {
    this.keys.push(...keys);
    if (this.keys.length > this.max) this.keys.splice(0, this.keys.length - this.max);
  }
}
