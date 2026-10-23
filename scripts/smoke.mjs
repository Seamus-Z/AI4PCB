import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parsePads, stableStringify } from '../src/geometry.mjs';
import { orientationStages, rcWiring, dividerWiring } from '../src/examples.mjs';
import { inspectProject } from '../src/archive.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const create = process.argv.includes('--create');
if (process.argv.slice(2).some(arg => arg !== '--create')) throw Error('Usage: npm run smoke [-- --create]');
const config = JSON.parse(await readFile(path.join(root, 'local/mcp.json'), 'utf8')).mcpServers['jlceda-schematic'];
const client = new Client({ name: 'schematic-toolkit-native-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({ ...config, env: { ...process.env, ...config.env, JLCEDA_ENABLE_WRITES: create ? '1' : '0' }, stderr: 'inherit' });
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const value = JSON.parse(response.content[0].text);
  if (response.isError) throw Error(name + ': ' + JSON.stringify(value));
  return value;
}
async function stage(scope, operations, log) {
  const plan = await call('jlc_plan', { ...scope, operations });
  if (!plan.planId) throw Error('Plan rejected: ' + JSON.stringify(plan.validation));
  const applied = await call('jlc_apply', { planId: plan.planId });
  log.push({ plan: { ...plan, operations: undefined }, applied });
  return call('jlc_snapshot', scope);
}
async function exactDevice(supplierId, manufacturerPart) {
  const devices = await call('jlc_search_devices', { query: supplierId, limit: 20 });
  const device = devices.find(d => d.supplierId === supplierId && d.manufacturerId === manufacturerPart);
  if (!device) throw Error('Exact official device unavailable: ' + supplierId + ' / ' + manufacturerPart);
  return { uuid: device.uuid, libraryUuid: device.libraryUuid };
}
async function generate(design, wireBuilder, teamUuid) {
  const parts = [];
  for (const part of design.parts) parts.push({ kind: 'component.create', ref: part.ref, device: await exactDevice(part.supplierId, part.manufacturerPart), x: part.x, y: part.y, rotation: part.rotation, mirror: part.mirror });
  const name = design.name;
  const created = await call('jlc_create_project', { name: name + '-' + Date.now(), ...(teamUuid ? { teamUuid } : {}) });
  const scope = { projectUuid: created.project.projectUuid, pageUuid: created.project.pageUuid };
  const log = [];
  let snapshot = await stage(scope, [...parts, ...design.modules, { kind: 'text.create', x: 100, y: 70, text: 'Official library devices | native wires / ports / GND | PCB not routed', size: 12 }], log);
  const transforms = orientationStages(snapshot, design.orientations);
  if (transforms.length) snapshot = await stage(scope, transforms, log);
  // Exercise actual native NC on an isolated pin, then restore it before wiring.
  const ref = design.parts[0].ref;
  const pin = snapshot.parts.find(p => p.ref === ref).pins[0].number;
  snapshot = await stage(scope, [{ kind: 'pin.nc', ref, pin, enabled: true }], log);
  if (!snapshot.parts.find(p => p.ref === ref).pins.find(p => p.number === pin).nc) throw Error('NC true did not persist');
  snapshot = await stage(scope, [{ kind: 'pin.nc', ref, pin, enabled: false }], log);
  if (snapshot.parts.find(p => p.ref === ref).pins.find(p => p.number === pin).nc) throw Error('NC false did not persist');
  const wiring = wireBuilder(snapshot, design);
  snapshot = await stage(scope, wiring.operations, log);
  const netlist = await call('jlc_netlist', scope);
  const parsed = parsePads(await readFile(netlist.path, 'utf8'));
  if (stableStringify(parsed.nets) !== stableStringify(wiring.expectedNets) || stableStringify(parsed.refs) !== stableStringify(parts.map(p => p.ref).sort())) throw Error('Native pin membership differs from intended example: ' + JSON.stringify(parsed));
  const drc = await call('jlc_drc', scope);
  if (drc.some(entry => ['fatal', 'error'].includes(entry.type) && entry.count)) throw Error('Native DRC errors: ' + JSON.stringify(drc));
  const projectFile = await call('jlc_export_project', { projectUuid: scope.projectUuid });
  const archive = inspectProject(new Uint8Array(await readFile(projectFile.path)));
  const pdf = await call('jlc_export_pdf', scope);
  return { name, project: created.project, sourceBackup: created.sourceBackup, scope, snapshot, expectedNets: wiring.expectedNets, nativeNets: parsed.nets, drc, archive, projectFile, pdf, stages: log, visualReviewRequired: true, reimportReviewRequired: true, pcbRouted: false };
}

try {
  await client.connect(transport);
  console.log('MCP initialized. In JLCEDA choose Schematic Toolkit > Connect MCP. One server per bridge port.');
  let status;
  const deadline = Date.now() + 120000;
  do {
    status = await call('jlc_status');
    if (status.bridge.connected) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  if (!status?.bridge.connected) throw Error('Editor authentication timed out; no project was created');
  if (!create) { console.log(JSON.stringify({ status, mutations: 0 }, null, 2)); }
  else {
    const team = status.editor?.project?.teamUuid;
    const examples = [];
    for (const [file, builder] of [['rc-filter.json', rcWiring], ['resistor-divider.json', dividerWiring]]) {
      const design = JSON.parse(await readFile(path.join(root, 'examples', file), 'utf8'));
      examples.push(await generate(design, builder, team));
    }
    const out = path.join(root, 'outputs');
    await mkdir(out, { recursive: true });
    const report = path.join(out, 'native-smoke-' + Date.now() + '.json');
    await writeFile(report, JSON.stringify({ applicationTitleFromUiRequired: true, examples }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ report, projects: examples.map(e => ({ ...e.project, projectFile: e.projectFile.path, pdf: e.pdf.path, drc: e.drc })), next: 'Visually inspect each native PDF, then import each epro2 into a fresh project and compare native pin membership/NC.' }, null, 2));
  }
} finally { await client.close(); }
