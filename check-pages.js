const fs = require('fs');
const paths = ['C:\\edulock\\admin.html','C:\\edulock\\remote-admin.html'];
for (const p of paths) {
  const text = fs.readFileSync(p, 'utf8');
  const lines = text.split(/\r?\n/);
  const ids = ['dashboard','catalog','students','playback-audit','leak','watermark','security','player-version'];
  console.log('FILE', p);
  for (const id of ids) {
    const pattern = `<div class="page" id="page-${id}"`;
    const idx = lines.findIndex(l => l.includes(pattern));
    if (idx === -1) { console.log(id, 'missing'); continue; }
    let depth = 0;
    let closeLine = -1;
    for (let i = idx; i < lines.length; i++) {
      const line = lines[i];
      const opens = (line.match(/<div\b/gi) || []).length;
      const closes = (line.match(/<\/div>/gi) || []).length;
      depth += opens - closes;
      if (depth === 0) { closeLine = i + 1; break; }
    }
    console.log(id, 'start', idx+1, 'end', closeLine, 'depthEnd', depth);
  }
}
