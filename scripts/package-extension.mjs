import { build } from 'esbuild';
import { zipSync, strToU8 } from 'fflate';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function packageExtension(root, settings) {
  if (!Number.isInteger(settings.bridgePort) || !/^[a-f0-9]{64}$/.test(settings.bridgeToken)) throw Error('Run npm run setup first');
  const result = await build({
    absWorkingDir: root, entryPoints: ['extension/src/index.mjs'], bundle: true, write: false,
    platform: 'browser', format: 'iife', globalName: 'edaEsbuildExportName', target: 'es2022',
    define: { __BRIDGE_PORT__: String(settings.bridgePort), __BRIDGE_TOKEN__: JSON.stringify(settings.bridgeToken) }
  });
  const manifest = await readFile(path.join(root, 'extension/extension.json'));
  const archive = zipSync({ 'extension.json': new Uint8Array(manifest), 'dist/index.js': new Uint8Array(result.outputFiles[0].contents), '.edaignore': strToU8('src/\n') }, { level: 9 });
  const local = path.join(root, 'local');
  await mkdir(local, { recursive: true, mode: 0o700 });
  await writeFile(path.join(local, 'JLCEDA-Schematic-Bridge.eext'), archive, { mode: 0o600 });
  await chmod(path.join(local, 'JLCEDA-Schematic-Bridge.eext'), 0o600);
  console.log('Built local/JLCEDA-Schematic-Bridge.eext (paired; contains local secret).');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await packageExtension(root, JSON.parse(await readFile(path.join(root, 'local/settings.json'), 'utf8')));
}
