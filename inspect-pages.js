const fs = require('fs');
const html = fs.readFileSync('C:\\edulock\\remote-admin.html','utf8');
const lines = html.split(/\r?\n/);
const stack=[];
const pageParents=[];
for (let i=0; i<lines.length; i++) {
  const line = lines[i];
  const regex = /<div\b[^>]*>/gi;
  let match;
  while ((match = regex.exec(line)) !== null) {
    const tag = match[0];
    const clsMatch = /class=(['"])(.*?)\1/.exec(tag);
    const idMatch = /id=(['"])(.*?)\1/.exec(tag);
    const cls = clsMatch ? clsMatch[2] : '';
    const id = idMatch ? idMatch[2] : '';
    const node = {line:i+1, cls, id, parent: stack.length ? stack[stack.length-1].id || stack[stack.length-1].cls : null};
    if (cls.split(/\s+/).includes('page')) pageParents.push(node);
    stack.push(node);
  }
  const closes = line.match(/<\/div>/gi);
  if (closes) {
    for (let j=0; j<closes.length; j++) stack.pop();
  }
}
for (const node of pageParents) {
  console.log(`id=${node.id || '(none)'} line=${node.line} cls=${node.cls} parent=${node.parent}`);
}
