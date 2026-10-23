import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { packageExtension } from './package-extension.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = path.join(root, 'local');
await mkdir(local, { recursive: true, mode: 0o700 });
await chmod(local, 0o700);
let settings;
try { settings = JSON.parse(await readFile(path.join(local, 'settings.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!settings) {
  settings = { bridgePort: 49831, bridgeToken: randomBytes(32).toString('hex') };
  await writeFile(path.join(local, 'settings.json'), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
if (!Number.isInteger(settings.bridgePort) || settings.bridgePort < 1024 || settings.bridgePort > 65535 || !/^[a-f0-9]{64}$/.test(settings.bridgeToken)) throw Error('Invalid local/settings.json; do not replace a pairing silently');
const env = {
  JLCEDA_BRIDGE_PORT: String(settings.bridgePort),
  JLCEDA_BRIDGE_TOKEN: settings.bridgeToken,
  JLCEDA_ENABLE_WRITES: '0',
  JLCEDA_TRUSTED_ORIGINS: 'https://pro.lceda.cn,https://pro.easyeda.com',
  JLCEDA_OUTPUT_DIR: path.join(root, 'outputs'),
  JLCEDA_REQUEST_TIMEOUT_MS: '60000'
};
await writeFile(path.join(local, 'bridge.env'), Object.entries(env).map(([key, value]) => key + '=' + JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 });
await writeFile(path.join(local, 'mcp.json'), JSON.stringify({ mcpServers: { 'jlceda-schematic': { command: process.execPath, args: [path.join(root, 'src/server.mjs')], env } } }, null, 2) + '\n', { mode: 0o600 });
await packageExtension(root, settings);
console.log('Pairing retained/generated. Import local/JLCEDA-Schematic-Bridge.eext in JLCEDA Pro.');
console.log('MCP client configuration: local/mcp.json (read-only default; contains secret, do not share).');
