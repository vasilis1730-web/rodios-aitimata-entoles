const fs = require('fs');
const vm = require('vm');

for (const file of ['aitimata/index.html', 'entoles/index.html', 'entoles/ack.html']) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  let index = 0;
  while ((match = scripts.exec(html))) {
    index += 1;
    if (/\bsrc\s*=/.test(match[1])) continue;
    if (/\btype\s*=\s*["']module["']/.test(match[1])) {
      new vm.SourceTextModule(match[2], {identifier: `${file}#${index}`});
    } else {
      new vm.Script(match[2], {filename: `${file}#${index}`});
    }
  }
}

console.log('inline JavaScript syntax: OK');
