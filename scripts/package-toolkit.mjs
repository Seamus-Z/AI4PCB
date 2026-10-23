import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const prefix = 'JLCEDA-Schematic-Toolkit/';
const entries = {};
const roots = ['README.md', '.gitignore', 'package.json', 'package-lock.json', 'src', 'scripts', 'extension', 'skills', 'examples', 'test', 'verification'];
let localSecret;
try { localSecret = JSON.parse(await readFile(path.join(root, 'local/settings.json'), 'utf8')).bridgeToken; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
async function include(relative) {
  let children;
  try { children = await readdir(path.join(root, relative), { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT' && relative === 'verification') return;
    if (error.code !== 'ENOTDIR') throw error;
    const content = await readFile(path.join(root, relative));
    if (localSecret && content.includes(Buffer.from(localSecret))) throw Error('Refusing to package local secret: ' + relative);
    entries[prefix + relative.replaceAll(path.sep, '/')] = [new Uint8Array(content), { mtime: new Date('2020-01-01T00:00:00Z') }];
    return;
  }
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (child.isSymbolicLink()) throw Error('Refusing symlink in public package: ' + relative + '/' + child.name);
    if (child.name === 'node_modules' || child.name === 'local' || child.name === 'outputs' || child.name === 'dist') continue;
    await include(path.join(relative, child.name));
  }
}
for (const name of roots) await include(name);
const checksums = Object.entries(entries).map(([name, [bytes]]) => createHash('sha256').update(bytes).digest('hex') + '  ' + name.slice(prefix.length)).join('\n') + '\n';
entries[prefix + 'SHA256SUMS'] = [strToU8(checksums), { mtime: new Date('2020-01-01T00:00:00Z') }];
const archive = zipSync(entries, { level: 9 });
const output = path.resolve(root, '..', 'JLCEDA-Schematic-Toolkit.zip');
await writeFile(output, archive);
console.log(JSON.stringify({ file: output, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex'), members: Object.keys(entries).length, excluded: ['local/', 'node_modules/', 'outputs/', 'paired eext secret'], localSecretPresent: false }, null, 2));
