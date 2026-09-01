// Assemble the folder Capacitor packages into the mobile app.
// The tool becomes index.html (the app's entry); the landing page becomes about.html.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'www');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });

const rw = (src, dst, edits = []) => {
  let s = fs.readFileSync(path.join(root, src), 'utf8');
  for (const [a, b] of edits) s = s.split(a).join(b);
  fs.writeFileSync(path.join(out, dst), s);
};
rw('app.html', 'index.html', [['href="index.html"', 'href="about.html"']]);
rw('index.html', 'about.html', [['href="app.html"', 'href="index.html"']]);
for (const f of ['app.js', 'icon.svg', 'manifest.webmanifest', 'assets/poster.jpg', 'assets/demo.mp4'])
  fs.copyFileSync(path.join(root, f), path.join(out, f));
console.log('www/ ready');
