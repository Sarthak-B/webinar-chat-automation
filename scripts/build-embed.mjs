// Builds dashboard/flexifunnels-embed.html – the whole dashboard as ONE paste-ready snippet for a
// FlexiFunnels "Custom Code" block (or any page builder). The dashboard runs in a full-screen frame so
// the builder's CSS can't clash with it; it keeps the page's origin, so saved settings, GitHub and
// Apps Script calls and the copy buttons work exactly like the standalone page.
// Run: node scripts/build-embed.mjs
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
// JSON string, with "</" escaped so the dashboard's own </script> tags can't end this <script> early.
const payload = JSON.stringify(html)
  .replace(/<\//g, '<\\/')
  .replace(/<!--/g, '<\\!--')
  // every non-ASCII character (₹, –, emojis, Hindi…) as \uXXXX – works whatever encoding the host page uses
  .replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const embed = `<!-- Webinar Autopilot dashboard - paste this whole block into a FlexiFunnels Custom Code element.
     Generated from dashboard/index.html by scripts/build-embed.mjs - don't edit by hand. -->
<div id="webinar-autopilot-root"></div>
<style>
  html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; background: #0C0E13 !important; }
  #webinar-autopilot-root { position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
    width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important; margin: 0 !important; padding: 0 !important;
    transform: none !important; z-index: 2147483000 !important; background: #0C0E13 !important; display: block !important; }
  #webinar-autopilot-root > iframe { position: absolute !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important;
    max-width: none !important; max-height: none !important; min-width: 0 !important; margin: 0 !important; padding: 0 !important;
    border: 0 !important; display: block !important; background: #0C0E13 !important; transform: none !important; }
</style>
<script>
(function () {
  var root = document.getElementById('webinar-autopilot-root');
  if (!root || root.getAttribute('data-ready')) return;
  root.setAttribute('data-ready', '1');
  // move to the top of the page so builder sections (transforms, overflow, widths) can't clip or shrink it
  if (root.parentNode !== document.body) document.body.appendChild(root);
  var f = document.createElement('iframe');
  f.title = 'Webinar Autopilot';
  f.setAttribute('allow', 'clipboard-read; clipboard-write');
  f.srcdoc = ${payload};
  root.appendChild(f);
  // keep the page itself out of search results
  var m = document.createElement('meta'); m.name = 'robots'; m.content = 'noindex,nofollow'; document.head.appendChild(m);
  document.title = 'Webinar Autopilot | FlexiFunnels';
})();
</script>
`;
fs.writeFileSync(new URL('../dashboard/flexifunnels-embed.html', import.meta.url), embed);
console.log(`✓ dashboard/flexifunnels-embed.html (${(embed.length / 1024).toFixed(0)} KB)`);
