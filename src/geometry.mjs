// Coordinates are native SDK numbers. Deliberately no rounding, tolerances, or body bounds.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const sorted = values => [...values].sort();
const rotation = value => finite(value) && value % 90 === 0;
const angle = value => ((value % 360) + 360) % 360;
const point = value => Array.isArray(value) && value.length === 2 && value.every(finite);
const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Canonical JSON for fingerprints; reject values JSON would silently lose or coerce. */
export function stableStringify(value) {
  const ancestors = new Set();
  function encode(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (finite(item)) return JSON.stringify(item);
    if (!Array.isArray(item) && !record(item)) throw new TypeError('Canonical JSON requires finite JSON values and plain objects');
    if (ancestors.has(item)) throw new TypeError('Canonical JSON cannot contain cycles');
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      const entries = [];
      for (let i = 0; i < item.length; i++) {
        if (!own(item, i)) throw new TypeError('Canonical JSON cannot contain sparse arrays');
        entries.push(encode(item[i]));
      }
      result = `[${entries.join(',')}]`;
    } else {
      if (Object.getOwnPropertySymbols(item).length) throw new TypeError('Canonical JSON cannot contain symbol keys');
      result = `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode(item[key])}`).join(',')}}`;
    }
    ancestors.delete(item);
    return result;
  }
  return encode(value);
}

/** PADS ASCII PART/SIGNAL membership, independent of package names and line wrapping. */
export function parsePads(text) {
  if (typeof text !== 'string') throw new TypeError('PADS text must be a string');
  const refs = new Set();
  const nets = new Map();
  let section = '';
  let net;
  let sawParts = false;
  let sawEnd = false;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || line.startsWith('!') || /^\*REMARK\*/i.test(line)) continue;
    const directive = line.match(/^\*([^*]+)\*(.*)$/);
    if (directive) {
      const kind = directive[1].toUpperCase();
      if (kind === 'PART') { section = 'part'; sawParts = true; net = undefined; }
      else if (kind === 'NET') { section = 'net'; net = undefined; }
      else if (kind === 'SIGNAL') {
        const name = directive[2].trim();
        if (!name) throw new Error(`PADS line ${index + 1}: SIGNAL requires a net name`);
        net = name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name;
        if (!nets.has(net)) nets.set(net, new Set());
        section = 'signal';
      } else if (kind === 'END') { sawEnd = true; break; }
      else throw new Error(`PADS line ${index + 1}: unsupported section ${kind}`);
      continue;
    }
    if (section === 'part') {
      const fields = line.split(/\s+/);
      if (fields.length < 2) throw new Error(`PADS line ${index + 1}: PART requires reference and package`);
      if (refs.has(fields[0])) throw new Error(`PADS line ${index + 1}: duplicate reference ${fields[0]}`);
      refs.add(fields[0]);
    } else if (section === 'signal' && net !== undefined) {
      for (const member of line.split(/\s+/)) {
        const dot = member.lastIndexOf('.');
        if (dot <= 0 || dot === member.length - 1) throw new Error(`PADS line ${index + 1}: invalid pin membership ${member}`);
        nets.get(net).add(member);
      }
    } else throw new Error(`PADS line ${index + 1}: content outside PART or SIGNAL`);
  }
  if (!sawParts || !sawEnd) throw new Error('PADS requires PART and END sections');
  const membership = new Map();
  for (const [name, pins] of nets) {
    for (const pin of pins) {
      const ref = pin.slice(0, pin.lastIndexOf('.'));
      if (!refs.has(ref)) throw new Error(`PADS net ${name}: unknown reference ${ref}`);
      if (membership.has(pin) && membership.get(pin) !== name) throw new Error(`PADS pin ${pin} belongs to multiple nets`);
      membership.set(pin, name);
    }
  }
  return { refs: sorted(refs), nets: Object.fromEntries(sorted(nets.keys()).map(name => [name, sorted(nets.get(name))])) };
}

/** Named nets compare strictly, including generated net names; no rename guessing. */
export function compareNetlists(aText, bText) {
  const a = parsePads(aText);
  const b = parsePads(bText);
  const addedRefs = b.refs.filter(ref => !a.refs.includes(ref));
  const removedRefs = a.refs.filter(ref => !b.refs.includes(ref));
  const changedNets = sorted(new Set([...Object.keys(a.nets), ...Object.keys(b.nets)]))
    .filter(net => stableStringify(a.nets[net] ?? null) !== stableStringify(b.nets[net] ?? null))
    .map(net => ({ net, before: a.nets[net] ?? [], after: b.nets[net] ?? [] }));
  return { equal: !addedRefs.length && !removedRefs.length && !changedNets.length, addedRefs, removedRefs, changedNets };
}

function onSegment(p, segment) {
  const [a, b] = segment;
  return a[0] === b[0]
    ? p[0] === a[0] && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1])
    : p[1] === a[1] && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]);
}

function intersection(first, second) {
  const [a, b] = first;
  const [c, d] = second;
  const av = a[0] === b[0];
  const cv = c[0] === d[0];
  if (av !== cv) {
    const p = av ? [a[0], c[1]] : [c[0], a[1]];
    return onSegment(p, first) && onSegment(p, second) ? { point: p } : null;
  }
  const fixed = av ? 0 : 1;
  const axis = av ? 1 : 0;
  if (a[fixed] !== c[fixed]) return null;
  const low = Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]));
  const high = Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis]));
  if (low > high) return null;
  const p = av ? [a[0], low] : [low, a[1]];
  return low === high ? { point: p } : { overlap: [p, av ? [a[0], high] : [high, a[1]]] };
}

const fields = {
  'component.create': ['kind', 'device', 'ref', 'x', 'y', 'rotation', 'mirror', 'value'],
  'component.move': ['kind', 'ref', 'x', 'y', 'rotation', 'mirror'],
  'marker.create': ['kind', 'marker', 'net', 'x', 'y', 'rotation'],
  'wire.create': ['kind', 'net', 'points', 'label'],
  'pin.nc': ['kind', 'ref', 'pin', 'enabled'],
  'wire.delete': ['kind', 'ids'],
  'marker.delete': ['kind', 'ids'],
  'text.create': ['kind', 'x', 'y', 'text', 'size'],
  'module.create': ['kind', 'left', 'top', 'right', 'bottom', 'title'],
};

/** Validate the projected native state, never mutate the supplied snapshot or operations. */
export function validateOperations(snapshot, operations, rules = {}) {
  const errors = [];
  const warnings = [];
  const metrics = { operations: Array.isArray(operations) ? operations.length : 0, parts: 0, pins: 0, wires: 0, segments: 0, markers: 0 };
  const issue = (code, message, details = {}) => errors.push({ code, message, ...details });
  const warn = (code, message, details = {}) => warnings.push({ code, message, ...details });
  const result = () => ({ ok: errors.length === 0, errors, warnings, metrics });
  const shape = (value, allowed, path) => {
    if (!record(value)) { issue('INVALID_SHAPE', `${path} must be a plain object`, { path }); return false; }
    for (const key of Object.keys(value).sort()) if (!allowed.includes(key)) issue('UNKNOWN_FIELD', `${path}.${key} is not allowed`, { path: `${path}.${key}` });
    return true;
  };
  const position = (value, path) => {
    for (const key of ['x', 'y']) if (!finite(value[key])) issue('INVALID_COORDINATE', `${path}.${key} must be finite`, { path: `${path}.${key}` });
  };
  const pose = (value, path, optional = false) => {
    if ((!optional || own(value, 'rotation')) && !rotation(value.rotation)) issue('INVALID_ROTATION', `${path}.rotation must be a finite multiple of 90 degrees`, { path });
    if ((!optional || own(value, 'mirror')) && typeof value.mirror !== 'boolean') issue('INVALID_MIRROR', `${path}.mirror must be boolean`, { path });
  };
  const textField = (value, key, path, allowEmpty = false) => {
    if (!(allowEmpty ? typeof value[key] === 'string' : nonempty(value[key]))) issue('INVALID_STRING', `${path}.${key} must be ${allowEmpty ? 'a string' : 'a nonempty string'}`, { path: `${path}.${key}` });
  };
  const pathSegments = (points, path) => {
    if (!Array.isArray(points) || points.length < 2 || !points.every(point)) {
      issue('INVALID_PATH', `${path} requires at least two exact finite [x,y] points`, { path }); return [];
    }
    const segments = [];
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1];
      const b = points[index];
      if (samePoint(a, b)) issue('ZERO_LENGTH_WIRE', `${path} segment ${index - 1} has zero length`, { path, segment: index - 1 });
      else if (a[0] !== b[0] && a[1] !== b[1]) issue('DIAGONAL_WIRE', `${path} segment ${index - 1} must be orthogonal`, { path, segment: index - 1 });
      else segments.push([a, b]);
    }
    return segments;
  };
  if (!shape(rules, ['maxBends'], 'rules')) return result();
  if (own(rules, 'maxBends') && (!Number.isInteger(rules.maxBends) || rules.maxBends < 0)) issue('INVALID_RULE', 'rules.maxBends must be a nonnegative integer');
  if (!shape(snapshot, ['projectUuid', 'pageUuid', 'parts', 'markers', 'wires', 'texts'], 'snapshot')) return result();
  textField(snapshot, 'projectUuid', 'snapshot');
  textField(snapshot, 'pageUuid', 'snapshot');
  for (const key of ['parts', 'markers', 'wires', 'texts']) if (!Array.isArray(snapshot[key])) issue('INVALID_SHAPE', `snapshot.${key} must be an array`, { path: `snapshot.${key}` });
  if (!Array.isArray(operations)) issue('INVALID_SHAPE', 'operations must be an array');
  if (errors.length) return result();
  const ids = new Set();
  const refs = new Set();
  const entity = (value, allowed, path) => {
    if (!shape(value, allowed, path)) return false;
    textField(value, 'id', path);
    if (ids.has(value.id)) issue('DUPLICATE_ID', `${path} repeats native ID ${value.id}`, { id: value.id });
    ids.add(value.id);
    return true;
  };
  for (const [index, part] of snapshot.parts.entries()) {
    const path = `snapshot.parts[${index}]`;
    if (!entity(part, ['id', 'ref', 'deviceUuid', 'libraryUuid', 'x', 'y', 'rotation', 'mirror', 'properties', 'pins'], path)) continue;
    textField(part, 'ref', path);
    if (refs.has(part.ref)) issue('DUPLICATE_REF', `Duplicate component reference ${part.ref}`, { ref: part.ref });
    refs.add(part.ref);
    position(part, path); pose(part, path);
    for (const key of ['deviceUuid', 'libraryUuid']) if (own(part, key) && typeof part[key] !== 'string') issue('INVALID_STRING', `${path}.${key} must be a string`, { path });
    if (own(part, 'properties')) {
      if (!record(part.properties)) issue('INVALID_SHAPE', `${path}.properties must be a plain object`, { path });
      else { try { stableStringify(part.properties); } catch (error) { issue('INVALID_PROPERTIES', `${path}.properties: ${error.message}`, { path }); } }
    }
    if (!Array.isArray(part.pins)) { issue('INVALID_SHAPE', `${path}.pins must be an array`, { path }); continue; }
    const numbers = new Set();
    for (const [pinIndex, pin] of part.pins.entries()) {
      const pinPath = `${path}.pins[${pinIndex}]`;
      if (!shape(pin, ['number', 'x', 'y', 'nc', 'net'], pinPath)) continue;
      if (!(nonempty(pin.number) || finite(pin.number))) issue('INVALID_PIN', `${pinPath}.number must be a nonempty string or finite number`, { path: pinPath });
      const number = String(pin.number);
      if (numbers.has(number)) issue('DUPLICATE_PIN', `${part.ref} repeats pin ${number}`, { ref: part.ref, pin: number });
      numbers.add(number);
      position(pin, pinPath);
      if (typeof pin.nc !== 'boolean') issue('INVALID_NC', `${pinPath}.nc must be boolean`, { path: pinPath });
      if (own(pin, 'net') && typeof pin.net !== 'string') issue('INVALID_STRING', `${pinPath}.net must be a string`, { path: pinPath });
    }
  }
  for (const [index, marker] of snapshot.markers.entries()) {
    const path = `snapshot.markers[${index}]`;
    if (!entity(marker, ['id', 'kind', 'net', 'x', 'y', 'rotation'], path)) continue;
    textField(marker, 'kind', path); textField(marker, 'net', path, true); position(marker, path);
    if (!rotation(marker.rotation)) issue('INVALID_ROTATION', `${path}.rotation must be a finite multiple of 90 degrees`, { path });
  }
  for (const [index, wire] of snapshot.wires.entries()) {
    const path = `snapshot.wires[${index}]`;
    if (!entity(wire, ['id', 'net', 'paths'], path)) continue;
    textField(wire, 'net', path, true);
    if (!Array.isArray(wire.paths) || !wire.paths.length) issue('INVALID_PATH', `${path}.paths must contain paths`, { path });
    else wire.paths.forEach((points, i) => pathSegments(points, `${path}.paths[${i}]`));
  }
  for (const [index, text] of snapshot.texts.entries()) {
    const path = `snapshot.texts[${index}]`;
    if (!entity(text, ['id', 'text', 'x', 'y'], path)) continue;
    textField(text, 'text', path, true); position(text, path);
  }
  if (errors.length) return result();

  const parts = new Map(snapshot.parts.map(part => [part.ref, { ...part, pins: part.pins.map(pin => ({ ...pin, number: String(pin.number) })) }]));
  const wires = new Map(snapshot.wires.map(wire => [wire.id, { ...wire, source: 'snapshot' }]));
  const markers = new Map(snapshot.markers.map(marker => [marker.id, { ...marker, source: 'snapshot' }]));
  const newRefs = new Set();
  const movedRefs = new Set();
  const wireOperations = [];
  const transforms = new Map();
  const plannedId = index => {
    let id = `operation:${index}`;
    while (ids.has(id)) id += ':planned';
    ids.add(id);
    return id;
  };
  for (const [index, op] of operations.entries()) {
    const path = `operations[${index}]`;
    if (!record(op) || !own(fields, op.kind)) { issue('UNKNOWN_OPERATION', `${path} has an unknown operation kind`, { operation: index }); continue; }
    const before = errors.length;
    shape(op, fields[op.kind], path);
    if (['component.create', 'component.move', 'marker.create', 'text.create'].includes(op.kind)) position(op, path);
    if (op.kind === 'component.create') {
      textField(op, 'ref', path); pose(op, path, true);
      if (shape(op.device, ['uuid', 'libraryUuid'], `${path}.device`)) { textField(op.device, 'uuid', `${path}.device`); textField(op.device, 'libraryUuid', `${path}.device`); }
      if (own(op, 'value') && typeof op.value !== 'string') issue('INVALID_STRING', `${path}.value must be a string`, { operation: index });
      if (parts.has(op.ref)) issue('DUPLICATE_REF', `Component reference ${op.ref} already exists`, { operation: index, ref: op.ref });
      if (errors.length === before) {
        parts.set(op.ref, { ...op, rotation: op.rotation ?? 0, mirror: op.mirror ?? false, pins: [] });
        newRefs.add(op.ref);
      }
    } else if (op.kind === 'component.move') {
      textField(op, 'ref', path); pose(op, path);
      const part = parts.get(op.ref);
      if (!part) issue('UNKNOWN_REF', `Cannot move unknown reference ${op.ref}`, { operation: index, ref: op.ref });
      const transform = part && (angle(op.rotation) !== angle(part.rotation) || op.mirror !== part.mirror);
      if (transform && operations.some(item => item && ['wire.create', 'pin.nc', 'marker.create'].includes(item.kind))) issue('PIN_TRANSFORM_REQUIRES_STAGING', `Stage ${op.ref} rotation/mirror without new wires, markers or NC changes, then read native pins before wiring`, { operation: index, ref: op.ref });
      if (errors.length === before) {
        // Transformed pins must come from native readback, never imagined graphics.
        const dx = op.x - part.x;
        const dy = op.y - part.y;
        if (transform && !transforms.has(op.ref)) transforms.set(op.ref, { index, pins: [...(snapshot.parts.find(item => item.ref === op.ref)?.pins ?? []), ...part.pins] });
        parts.set(op.ref, { ...part, ...op, pins: transform || transforms.has(op.ref) ? [] : part.pins.map(pin => ({ ...pin, x: pin.x + dx, y: pin.y + dy })) });
        movedRefs.add(op.ref);
      }
    } else if (op.kind === 'marker.create') {
      if (!['Ground', 'Power', 'AnalogGround', 'ProtectGround', 'IN', 'OUT', 'BI'].includes(op.marker)) issue('INVALID_MARKER', `${path}.marker is not an allowed native marker`, { operation: index });
      textField(op, 'net', path);
      if (own(op, 'rotation') && !rotation(op.rotation)) issue('INVALID_ROTATION', `${path}.rotation must be a finite multiple of 90 degrees`, { operation: index });
      if (errors.length === before) {
        const id = plannedId(index);
        markers.set(id, { ...op, id, source: 'operation', operation: index });
      }
    } else if (op.kind === 'wire.create') {
      textField(op, 'net', path);
      pathSegments(op.points, `${path}.points`);
      if (own(op, 'label') && typeof op.label !== 'boolean') issue('INVALID_LABEL', `${path}.label must be boolean`, { operation: index });
      if (errors.length === before) {
        const id = plannedId(index);
        wires.set(id, { ...op, id, paths: [op.points], source: 'operation', operation: index });
        wireOperations.push(index);
        let bends = 0;
        for (let i = 2; i < op.points.length; i++) {
          const previousVertical = op.points[i - 2][0] === op.points[i - 1][0];
          const nextVertical = op.points[i - 1][0] === op.points[i][0];
          if (previousVertical !== nextVertical) bends++;
        }
        if (bends > (rules.maxBends ?? 2)) warn('WIRE_BENDS', `Wire operation ${index} has ${bends} bends; simplify or visually review its route`, { operation: index, bends });
      }
    } else if (op.kind === 'wire.delete' || op.kind === 'marker.delete') {
      const collection = op.kind === 'wire.delete' ? wires : markers;
      if (!Array.isArray(op.ids) || !op.ids.length || !op.ids.every(nonempty)) issue('INVALID_IDS', `${path}.ids requires nonempty native IDs`, { operation: index });
      else {
        const seen = new Set();
        for (const id of op.ids) {
          if (seen.has(id)) issue('DUPLICATE_DELETE_ID', `${path} repeats ID ${id}`, { operation: index, id });
          seen.add(id);
          if (!collection.has(id) || collection.get(id).source !== 'snapshot') issue('UNKNOWN_ID', `${path} cannot delete absent or non-native scoped ID ${id}`, { operation: index, id });
        }
      }
      if (errors.length === before) op.ids.forEach(id => collection.delete(id));
    } else if (op.kind === 'pin.nc') {
      textField(op, 'ref', path);
      if (!(nonempty(op.pin) || finite(op.pin))) issue('INVALID_PIN', `${path}.pin must be a nonempty string or finite number`, { operation: index });
      if (typeof op.enabled !== 'boolean') issue('INVALID_NC', `${path}.enabled must be boolean`, { operation: index });
      const part = parts.get(op.ref);
      const pin = part?.pins.find(item => item.number === String(op.pin));
      if (!part) issue('UNKNOWN_REF', `Cannot set NC on unknown reference ${op.ref}`, { operation: index, ref: op.ref });
      else if (newRefs.has(op.ref)) issue('NEW_COMPONENT_REQUIRES_STAGING', `Create ${op.ref}, read its native pins, then plan NC changes`, { operation: index, ref: op.ref });
      else if (transforms.has(op.ref)) issue('PIN_TRANSFORM_REQUIRES_STAGING', `Read ${op.ref} native pins after its transform before changing NC`, { operation: index, ref: op.ref });
      else if (!pin) issue('UNKNOWN_PIN', `${op.ref} has no pin ${op.pin}`, { operation: index, ref: op.ref, pin: String(op.pin) });
      if (errors.length === before) pin.nc = op.enabled;
    } else if (op.kind === 'text.create') {
      textField(op, 'text', path);
      if (own(op, 'size') && (!finite(op.size) || op.size <= 0)) issue('INVALID_TEXT_SIZE', `${path}.size must be positive and finite`, { operation: index });
    } else if (op.kind === 'module.create') {
      for (const key of ['left', 'top', 'right', 'bottom']) if (!finite(op[key])) issue('INVALID_COORDINATE', `${path}.${key} must be finite`, { operation: index });
      textField(op, 'title', path);
      if (finite(op.left) && finite(op.right) && finite(op.top) && finite(op.bottom) && !(op.left < op.right && op.top < op.bottom)) issue('INVALID_MODULE_BOUNDS', `${path} requires left < right and top < bottom`, { operation: index });
    }
  }
  if (newRefs.size) {
    for (const index of wireOperations) issue('NEW_COMPONENT_REQUIRES_STAGING', `Create components ${sorted(newRefs).join(', ')}, read native pins, then plan wires separately`, { operation: index });
    warn('UNOBSERVED_COMPONENT_PINS', `New component pins and bodies are unknown until native creation; stage placement and read a new snapshot`, { refs: sorted(newRefs) });
  }
  if (errors.length) return result();

  const segments = [];
  for (const wire of wires.values()) for (const points of wire.paths) for (let index = 1; index < points.length; index++) segments.push({ wire, points: [points[index - 1], points[index]] });
  const markerList = [...markers.values()];
  const pins = [...parts.values()].flatMap(part => part.pins.map(pin => ({ ...pin, ref: part.ref })));
  metrics.parts = parts.size; metrics.pins = pins.length; metrics.wires = wires.size; metrics.segments = segments.length; metrics.markers = markers.size;
  const islands = new Map([...wires.keys(), ...markers.keys()].map(id => [id, id]));
  const island = id => {
    let root = id;
    while (islands.get(root) !== root) root = islands.get(root);
    while (id !== root) {
      const next = islands.get(id);
      islands.set(id, root);
      id = next;
    }
    return root;
  };
  const conflict = (a, b, contact) => {
    islands.set(island(a.id), island(b.id));
    // Unknown disconnected islands can remain in snapshots, but cannot be used to
    // claim a new named connection is safe without a native naming source.
    if (a.net && b.net && a.net === b.net) return;
    if (!a.net && !b.net && a.source === 'snapshot' && b.source === 'snapshot') return;
    issue(a.net && b.net ? 'NET_CONTACT' : 'AMBIGUOUS_NET_CONTACT', `${a.id} (${a.net || 'unnamed'}) contacts ${b.id} (${b.net || 'unnamed'}); reroute or establish the actual native net`, { ids: [a.id, b.id], nets: [a.net, b.net], ...contact });
  };
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const a = segments[i];
    const b = segments[j];
    if (a.wire.id === b.wire.id) continue;
    const contact = intersection(a.points, b.points);
    if (contact) conflict(a.wire, b.wire, contact);
  }
  for (const marker of markerList) {
    const p = [marker.x, marker.y];
    for (const segment of segments) if (onSegment(p, segment.points)) conflict(marker, segment.wire, { point: p });
  }
  for (let i = 0; i < markerList.length; i++) for (let j = i + 1; j < markerList.length; j++) {
    const a = markerList[i]; const b = markerList[j];
    if (a.x === b.x && a.y === b.y) conflict(a, b, { point: [a.x, a.y] });
  }
  const contacts = p => [
    ...segments.filter(segment => onSegment(p, segment.points)).map(segment => segment.wire),
    ...markerList.filter(marker => marker.x === p[0] && marker.y === p[1]),
  ];
  for (const [ref, transform] of transforms) {
    const touching = new Set();
    for (const pin of transform.pins) for (const item of contacts([pin.x, pin.y])) touching.add(item.id);
    if (touching.size) issue('PIN_TRANSFORM_REQUIRES_STAGING', `Explicitly delete all native wires and markers touching ${ref} pins before staging its rotation/mirror; then read native pin coordinates`, { operation: transform.index, ref, ids: sorted(touching) });
    else warn('UNOBSERVED_TRANSFORMED_PINS', `${ref} native pin positions must be read after this isolated rotation/mirror stage; no transformed body or pin positions were guessed`, { operation: transform.index, ref });
  }
  for (const pin of pins) {
    const p = [pin.x, pin.y];
    const touched = contacts(p);
    if (pin.nc && touched.length) issue('NC_CONTACT', `NC pin ${pin.ref}.${pin.number} touches projected electrical geometry; remove the contact or disable NC`, { ref: pin.ref, pin: pin.number, point: p, ids: sorted(new Set(touched.map(item => item.id))) });
    const named = sorted(new Set(touched.map(item => item.net).filter(Boolean)));
    if (named.length > 1) issue('PIN_NET_CONTACT', `Pin ${pin.ref}.${pin.number} touches different nets ${named.join(', ')}`, { ref: pin.ref, pin: pin.number, nets: named, point: p });
    if (movedRefs.has(pin.ref) && pin.net && touched.some(item => item.net && item.net !== pin.net)) issue('MOVED_PIN_NET_CHANGE', `Translated pin ${pin.ref}.${pin.number} would contact a different net than ${pin.net}; stage the disconnected move and inspect native memberships`, { ref: pin.ref, pin: pin.number, before: pin.net, nets: named, point: p });
    else if (pin.net && touched.some(item => item.source === 'operation' && item.net && item.net !== pin.net)) issue('PIN_NET_CHANGE', `New geometry would connect ${pin.ref}.${pin.number} from native net ${pin.net} to another net; disconnect and stage a native membership readback first`, { ref: pin.ref, pin: pin.number, before: pin.net, nets: named, point: p });
  }
  for (const ref of movedRefs) {
    const before = snapshot.parts.find(part => part.ref === ref);
    if (!before || transforms.has(ref)) continue;
    const after = parts.get(ref);
    for (const pin of before.pins) {
      const projected = after.pins.find(item => item.number === String(pin.number));
      if (pin.x === projected.x && pin.y === projected.y) continue;
      const oldPoint = [pin.x, pin.y]; const newPoint = [projected.x, projected.y];
      const retained = contacts(oldPoint).filter(item => item.source === 'snapshot');
      const newContacts = contacts(newPoint);
      if (retained.some(item => !newContacts.some(other => island(other.id) === island(item.id)))) issue('PIN_MOVE_DISCONNECTS', `Moving ${ref}.${pin.number} leaves retained native wires/markers disconnected at its old position; delete or physically reroute them explicitly`, { ref, pin: String(pin.number), before: oldPoint, after: newPoint, ids: sorted(new Set(retained.map(item => item.id))) });
    }
  }
  for (let i = 0; i < pins.length; i++) for (let j = i + 1; j < pins.length; j++) {
    const a = pins[i]; const b = pins[j];
    if (a.ref === b.ref || a.x !== b.x || a.y !== b.y) continue;
    if (a.nc || b.nc) issue('NC_PIN_CONTACT', `Coincident pins ${a.ref}.${a.number} and ${b.ref}.${b.number} include NC`, { pins: [`${a.ref}.${a.number}`, `${b.ref}.${b.number}`], point: [a.x, a.y] });
    else if ((a.net && b.net && a.net !== b.net) || ((movedRefs.has(a.ref) || movedRefs.has(b.ref)) && (!a.net || !b.net))) issue('PIN_CONTACT', `Pins ${a.ref}.${a.number} and ${b.ref}.${b.number} coincide without a confirmed common net`, { pins: [`${a.ref}.${a.number}`, `${b.ref}.${b.number}`], point: [a.x, a.y] });
  }
  if (operations.some(op => ['component.create', 'component.move', 'wire.create', 'module.create', 'text.create'].includes(op.kind))) warn('VISUAL_REVIEW_REQUIRED', 'Only observed pin coordinates and electrical centerlines were checked. Native symbol bodies, text, labels, keepouts and annotation overlap require visual review; no body bounds were invented.');
  return result();
}
