import { stableStringify, validateOperations, parsePads } from '../../src/geometry.mjs';

const must = (value, message) => { if (!value) throw new Error(message); return value; };
const str = value => value == null ? '' : String(value);
// Component poses cross the SDK's unit conversion; electrical contacts still
// use the exact observed pin/wire coordinates, without snapping or tolerance.
const samePoseCoordinate = (actual, expected) => Number.isFinite(actual) && Math.abs(actual - expected) <= 4 * Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected));
const pointOn = (p, a, b) => (a[0] === b[0] && p[0] === a[0] && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1])) || (a[1] === b[1] && p[1] === a[1] && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]));
const touches = (a, b) => pointOn(a[0], ...b) || pointOn(a[1], ...b) || pointOn(b[0], ...a) || pointOn(b[1], ...a);
const sorted = rows => rows.sort((a, b) => a.id.localeCompare(b.id));
const clean = value => JSON.parse(JSON.stringify(value));

// SDK getState_Line() is a sequence of independent x1,y1,x2,y2 segments,
// not an arbitrary SVG polyline. Never round half-grid pin coordinates.
function wirePaths(line) {
  const chunks = typeof line[0] === 'number' ? [line] : line;
  return chunks.flatMap(chunk => {
    must(Array.isArray(chunk) && chunk.length % 4 === 0, 'Unsupported native wire representation');
    const paths = [];
    for (let i = 0; i < chunk.length; i += 4) paths.push([[chunk[i], -chunk[i + 1]], [chunk[i + 2], -chunk[i + 3]]]);
    return paths;
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function resolveWireNets(snapshot) {
  const wires = snapshot.wires, roots = wires.map((_, i) => i);
  const root = i => { while (roots[i] !== i) { roots[i] = roots[roots[i]]; i = roots[i]; } return i; };
  for (let i = 0; i < wires.length; i++) for (let j = 0; j < i; j++) {
    if (wires[i].paths.some(a => wires[j].paths.some(b => touches(a, b)))) roots[root(i)] = root(j);
  }
  const names = new Map();
  for (let i = 0; i < wires.length; i++) {
    const r = root(i), set = names.get(r) || new Set();
    if (wires[i].net) set.add(wires[i].net);
    for (const marker of snapshot.markers) if (wires[i].paths.some(p => pointOn([marker.x, marker.y], ...p))) set.add(marker.net);
    for (const part of snapshot.parts) for (const pin of part.pins) if (pin.net && wires[i].paths.some(p => pointOn([pin.x, pin.y], ...p))) set.add(pin.net);
    names.set(r, set);
  }
  for (let i = 0; i < wires.length; i++) {
    const candidates = [...names.get(root(i))];
    must(candidates.length <= 1, 'Native electrical net conflict at wire ' + wires[i].id + ': ' + candidates.join(', '));
    wires[i].net = candidates[0] || '';
  }
}

function covered(segment, net, wires) {
  const vertical = segment[0][0] === segment[1][0], axis = vertical ? 1 : 0, fixed = 1 - axis;
  const lo = Math.min(segment[0][axis], segment[1][axis]), hi = Math.max(segment[0][axis], segment[1][axis]);
  const intervals = wires.filter(w => w.net === net).flatMap(w => w.paths).filter(p => p[0][fixed] === segment[0][fixed] && p[1][fixed] === segment[0][fixed]).map(p => [Math.min(p[0][axis], p[1][axis]), Math.max(p[0][axis], p[1][axis])]).sort((a, b) => a[0] - b[0]);
  let end = lo;
  for (const [a, b] of intervals) { if (a > end) break; if (b > end) end = b; if (end >= hi) return true; }
  return false;
}

async function encodeFile(file) {
  must(file && typeof file.arrayBuffer === 'function', 'SDK did not return a native File');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return { name: file.name, mime: file.type || 'application/octet-stream', base64: btoa(binary) };
}

export function createDispatcher(eda) {
  async function scope(args) {
    const project = await eda.dmt_Project.getCurrentProjectInfo();
    must(project?.uuid === args.projectUuid, 'Project guard failed: open the explicitly requested project');
    const page = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
    must(page?.uuid === args.pageUuid, 'Page guard failed: open the explicitly requested schematic page');
    return { project, page };
  }
  async function snapshot(args) {
    await scope(args);
    const pads = parsePads(await eda.sch_Netlist.getNetlist('PADS'));
    // Some SDK versions change focus while exporting a schematic-wide netlist.
    // Restore only the already-guarded document, then guard again before reads.
    must((await eda.dmt_Project.getCurrentProjectInfo())?.uuid === args.projectUuid, 'Project changed during netlist read');
    await eda.dmt_EditorControl.openDocument(args.pageUuid);
    await scope(args);
    const membership = new Map();
    for (const [net, pins] of Object.entries(pads.nets)) for (const pin of pins) membership.set(pin, net);
    const result = { projectUuid: args.projectUuid, pageUuid: args.pageUuid, parts: [], markers: [], wires: [], texts: [] };
    for (const c of await eda.sch_PrimitiveComponent.getAll()) {
      const type = c.getState_ComponentType(), id = c.getState_PrimitiveId();
      if (type === 'part') {
        const device = c.getState_Component();
        const ref = str(c.getState_Designator());
        result.parts.push({ id, ref, deviceUuid: str(device?.uuid), libraryUuid: str(device?.libraryUuid), x: c.getState_X(), y: -c.getState_Y(), rotation: c.getState_Rotation(), mirror: c.getState_Mirror(), properties: clean({ name: c.getState_Name() ?? '', manufacturer: c.getState_Manufacturer() ?? '', manufacturerId: c.getState_ManufacturerId() ?? '', supplier: c.getState_Supplier() ?? '', supplierId: c.getState_SupplierId() ?? '', addIntoBom: c.getState_AddIntoBom(), addIntoPcb: c.getState_AddIntoPcb(), other: c.getState_OtherProperty() || {} }), pins: (await c.getAllPins()).map(p => ({ number: str(p.pinNumber), x: p.x, y: -p.y, nc: p.getState_NoConnected() === true, net: membership.get(ref + '.' + p.pinNumber) || '' })).sort((a, b) => a.number.localeCompare(b.number)) });
      } else if (type === 'netflag' || type === 'netport') result.markers.push({ id, kind: type, net: str(c.getState_Net()), x: c.getState_X(), y: -c.getState_Y(), rotation: c.getState_Rotation() });
    }
    for (const w of await eda.sch_PrimitiveWire.getAll()) result.wires.push({ id: w.getState_PrimitiveId(), net: str(w.getState_Net()), paths: wirePaths(w.getState_Line()) });
    for (const t of await eda.sch_PrimitiveText.getAll()) result.texts.push({ id: t.getState_PrimitiveId(), text: str(t.getState_Content()), x: t.getState_X(), y: -t.getState_Y() });
    for (const key of ['parts', 'markers', 'wires', 'texts']) sorted(result[key]);
    resolveWireNets(result);
    await scope(args);
    return result;
  }
  async function waitUntil(read, ready, label) {
    const deadline = Date.now() + 15000;
    do {
      const state = await read();
      if (ready(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error('Native metadata did not become ready: ' + label);
  }
  async function createProject(args) {
    must(typeof args.name === 'string' && args.name.trim().length > 0 && args.name.length <= 100, 'Invalid project name');
    must(((await eda.dmt_Project.getCurrentProjectInfo())?.uuid ?? null) === args.expectedSourceProjectUuid, 'Active project changed after the pre-create backup');
    const uuid = must(await eda.dmt_Project.createProject(args.name, undefined, args.teamUuid), 'Native project creation failed');
    const activeUuid = (await eda.dmt_Project.getCurrentProjectInfo())?.uuid ?? null;
    must(activeUuid === args.expectedSourceProjectUuid || activeUuid === uuid, 'Project changed during creation; new project retained without switching: ' + uuid);
    must(await eda.dmt_Project.openProject(uuid), 'Created project could not be opened: ' + uuid);
    await waitUntil(async () => {
      const project = await eda.dmt_Project.getCurrentProjectInfo();
      must(project?.uuid === uuid || project?.uuid === args.expectedSourceProjectUuid, 'Active project changed during native opening');
      return project;
    }, project => project?.uuid === uuid, 'new project ' + uuid);
    must(await eda.dmt_Board.createBoard(), 'Board creation failed in new project: ' + uuid);
    const project = await waitUntil(async () => {
      const current = await eda.dmt_Project.getCurrentProjectInfo();
      must(current?.uuid === uuid, 'Active project changed during board creation');
      return current;
    }, current => !!current.data?.find(d => d.itemType === 'Board')?.schematic?.page?.length, 'new board/page ' + uuid);
    const board = project.data.find(d => d.itemType === 'Board');
    const pageUuid = board.schematic.page[0].uuid;
    await eda.dmt_EditorControl.openDocument(pageUuid);
    await waitUntil(() => eda.dmt_Schematic.getCurrentSchematicPageInfo(), page => page?.uuid === pageUuid, 'new schematic page ' + pageUuid);
    await scope({ projectUuid: uuid, pageUuid });
    return { projectUuid: uuid, boardName: board.name, schematicUuid: board.schematic.uuid, pageUuid };
  }
  async function apply(args) {
    must(stableStringify(await snapshot(args)) === stableStringify(args.expectedSnapshot), 'Snapshot changed; re-plan before writing');
    const validation = validateOperations(args.expectedSnapshot, args.operations);
    must(validation.ok, 'Unsafe operation plan: ' + stableStringify(validation.errors));
    const created = [];
    for (const op of args.operations) {
      await scope(args);
      if (op.kind === 'component.create') {
        const c = must(await eda.sch_PrimitiveComponent.create(op.device, op.x, -op.y, undefined, op.rotation ?? 0, op.mirror ?? false, true, true), 'Native device create failed: ' + op.ref);
        c.setState_Designator(op.ref);
        if (op.value !== undefined) c.setState_OtherProperty({ ...(c.getState_OtherProperty() || {}), Value: op.value, 'Supplier Part': c.getState_SupplierId() || '' });
        await c.done();
        must(c.getState_Designator() === op.ref, 'Designator did not persist: ' + op.ref);
        created.push({ kind: op.kind, id: c.getState_PrimitiveId(), ref: op.ref });
      } else if (op.kind === 'component.move') {
        const c = must((await eda.sch_PrimitiveComponent.getAll()).find(c => c.getState_ComponentType() === 'part' && c.getState_Designator() === op.ref), 'Missing component: ' + op.ref);
        const changed = must(await eda.sch_PrimitiveComponent.modify(c, { x: op.x, y: -op.y, rotation: op.rotation, mirror: op.mirror, otherProperty: { ...(c.getState_OtherProperty() || {}), 'Supplier Part': c.getState_SupplierId() || '' } }), 'Native move failed: ' + op.ref);
        must(samePoseCoordinate(changed.getState_X(), op.x) && samePoseCoordinate(changed.getState_Y(), -op.y), 'Move position readback mismatch: ' + op.ref);
      } else if (op.kind === 'marker.create') {
        const method = ['IN', 'OUT', 'BI'].includes(op.marker) ? 'createNetPort' : 'createNetFlag';
        const c = must(await eda.sch_PrimitiveComponent[method](op.marker, op.net, op.x, -op.y, op.rotation ?? 0, false), 'Native marker creation failed');
        if (method === 'createNetPort') {
          const name = must((await eda.sch_PrimitiveAttribute.getAll(c.getState_PrimitiveId())).find(a => a.getState_Key() === 'Name'), 'Native port name attribute missing');
          // Attribute.done consumes screen Y; its getter reports SDK Y.
          name.setState_Y(-name.getState_Y());
          name.setState_ValueVisible(true);
          name.setState_Rotation(0);
          name.setState_FontSize(8);
          name.setState_AlignMode(name.getState_AlignMode());
          await name.done();
        }
        created.push({ kind: op.kind, id: c.getState_PrimitiveId() });
      } else if (op.kind === 'wire.create') {
        const markers = (await eda.sch_PrimitiveComponent.getAll()).filter(c => ['netflag', 'netport'].includes(c.getState_ComponentType()) && c.getState_Net() === op.net);
        const hasMarker = markers.some(c => op.points.slice(1).some((p, i) => pointOn([c.getState_X(), -c.getState_Y()], op.points[i], p)));
        for (let i = 1; i < op.points.length; i++) {
          const a = op.points[i - 1], b = op.points[i];
          const w = must(await eda.sch_PrimitiveWire.create([a[0], -a[1], b[0], -b[1]], i === 1 && op.label !== false && !hasMarker ? op.net : undefined), 'Native wire creation failed');
          created.push({ kind: op.kind, id: w.getState_PrimitiveId() });
        }
      } else if (op.kind === 'pin.nc') {
        const c = must((await eda.sch_PrimitiveComponent.getAll()).find(c => c.getState_ComponentType() === 'part' && c.getState_Designator() === op.ref), 'Missing NC component');
        const p = must((await c.getAllPins()).find(p => str(p.pinNumber) === op.pin), 'Missing NC pin');
        p.setState_NoConnected(op.enabled);
        await p.done();
        const actual = (await c.getAllPins()).find(p => str(p.pinNumber) === op.pin);
        must(actual?.getState_NoConnected() === op.enabled, 'Native NC readback failed');
      } else if (op.kind === 'wire.delete') must(await eda.sch_PrimitiveWire.delete(op.ids), 'Native wire delete failed');
      else if (op.kind === 'marker.delete') must(await eda.sch_PrimitiveComponent.delete(op.ids), 'Native marker delete failed');
      else if (op.kind === 'text.create') {
        const t = must(await eda.sch_PrimitiveText.create(op.x, -op.y, op.text, 0, undefined, undefined, op.size ?? 10, false, false, false, 1), 'Native text create failed');
        created.push({ kind: op.kind, id: t.getState_PrimitiveId() });
      } else if (op.kind === 'module.create') {
        const p = must(await eda.sch_PrimitivePolygon.create([op.left, -op.top, op.left, -op.bottom, op.right, -op.bottom, op.right, -op.top, op.left, -op.top], '#A8ADB5', 'none', 1, 0), 'Module frame create failed');
        must(await eda.sch_PrimitiveText.create(op.left + 10, -op.top + 25, op.title, 0, undefined, undefined, 12, true, false, false, 1), 'Module title create failed');
        created.push({ kind: op.kind, id: p.getState_PrimitiveId() });
      } else throw new Error('Unsupported operation kind');
    }
    await scope(args);
    must(await eda.sch_Document.save(), 'Native schematic save failed');
    const after = await snapshot(args);
    for (const op of args.operations) if (op.kind === 'wire.create') for (let i = 1; i < op.points.length; i++) must(covered([op.points[i - 1], op.points[i]], op.net, after.wires), 'Native wire/net readback mismatch: ' + op.net);
    return { created, snapshot: after, netlist: await eda.sch_Netlist.getNetlist('PADS') };
  }
  const handlers = {
    status: async () => ({ protocol: 1, sdkCapabilities: ['dmt_Project', 'dmt_Board', 'dmt_Schematic', 'sch_PrimitiveComponent', 'sch_PrimitiveWire', 'sch_Netlist', 'sch_Drc', 'sys_FileManager', 'sch_ManufactureData'].map(name => ({ name, available: !!eda[name] })), project: await eda.dmt_Project.getCurrentProjectInfo(), page: await eda.dmt_Schematic.getCurrentSchematicPageInfo() }),
    search_devices: async args => { must(typeof args.query === 'string' && args.query.trim(), 'Device query required'); const items = await eda.lib_Device.search(args.query); must(Array.isArray(items), 'SDK device search did not return an array'); return items.slice(0, args.limit ?? 10).map(item => clean(item)); },
    snapshot,
    create_project: createProject,
    apply,
    export_project: async args => { must((await eda.dmt_Project.getCurrentProjectInfo())?.uuid === args.projectUuid, 'Project export guard failed'); return encodeFile(await eda.sys_FileManager.getProjectFile('schematic-project', undefined, 'epro2')); },
    export_pdf: async args => { await scope(args); return encodeFile(await eda.sch_ManufactureData.getExportDocumentFile('schematic', 'PDF', { theme: 'Default', lineWidth: 'Default', size: 'Original Size' }, 'Current Schematic', { range: 'All', outputMethod: 'Merged sheet' })); },
    netlist: async args => { await scope(args); return { format: 'PADS', text: await eda.sch_Netlist.getNetlist('PADS') }; },
    drc: async args => { await scope(args); return eda.sch_Drc.check(true, true, true); }
  };
  return async (operation, args = {}) => {
    must(Object.hasOwn(handlers, operation), 'Unsupported toolkit operation: ' + operation);
    return clean(await handlers[operation](args));
  };
}
