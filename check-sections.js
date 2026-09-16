const fs = require('fs');
const paths = [{name:'local', path:'C:\\edulock\\admin.html'}, {name:'remote', path:'C:\\edulock\\remote-admin.html'}];
const ids = ['dashboard','catalog','students','playback-audit','leak','watermark','security','player-version'];
for (const file of paths) {
  const text = fs.readFileSync(file.path, 'utf8');
  const lines = text.split(/\r?\n/);
  console.log(`FILE ${file.name} ${file.path}`);
  for (const id of ids) {
    const pattern = `<div class="page" id="page-${id}"`;
    const idx = lines.findIndex(l => l.includes(pattern));
    if (idx === -1) {
      console.log(`${id} missing`);
      continue;
    }
    let depth = 0;
    let closeLine = -1;
    for (let i = idx; i < lines.length; i++) {
      const line = lines[i];
      const opens = (line.match(/<div\b/gi) || []).length;
      const closes = (line.match(/<\/div>/gi) || []).length;
      depth += opens - closes;
      if (depth === 0) { closeLine = i + 1; break; }
    }
    console.log(`${id} start ${idx+1} close ${closeLine} depth ${depth}`);
  }
}
