const check = (condition, message) => { if (!condition) throw Error(message); };
const byRef = (snapshot, ref) => { const part = snapshot.parts.find(p => p.ref === ref); check(part, 'Missing example part ' + ref); check(part.pins.length === 2, 'Example requires a real two-pin device: ' + ref); return part; };
const wire = (net, points) => ({ kind: 'wire.create', net, points, label: false });
const marker = (type, net, x, y, rotation = 0) => ({ kind: 'marker.create', marker: type, net, x, y, rotation });
const member = (part, pin) => part.ref + '.' + pin.number;

export function orientationStages(snapshot, goals) {
  return Object.entries(goals).flatMap(([ref, orientation]) => {
    const part = byRef(snapshot, ref), [a, b] = part.pins;
    const horizontal = a.y === b.y && a.x !== b.x, vertical = a.x === b.x && a.y !== b.y;
    check(horizontal || vertical, 'Non-orthogonal official pin geometry requires human layout review: ' + ref);
    return (orientation === 'horizontal' ? horizontal : vertical) ? [] : [{ kind: 'component.move', ref, x: part.x, y: part.y, rotation: (part.rotation + 90) % 360, mirror: part.mirror }];
  });
}

export function rcWiring(snapshot, design) {
  const resistor = byRef(snapshot, design.roles.resistor), capacitor = byRef(snapshot, design.roles.capacitor);
  const { input, output, ground } = design.netRoles;
  const [left, right] = [...resistor.pins].sort((a, b) => a.x - b.x);
  const [top, bottom] = [...capacitor.pins].sort((a, b) => a.y - b.y);
  check(left.y === right.y && top.x === bottom.x && top.y > right.y && top.x > right.x, 'RC placement does not provide clear signal/ground channels');
  const y = right.y, inputX = left.x - 130, outputX = top.x + 180, groundY = bottom.y + 80;
  const operations = [
    marker('IN', input, inputX, left.y, 180), marker('OUT', output, outputX, y), marker('Ground', ground, bottom.x, groundY),
    wire(input, [[inputX, left.y], [left.x, left.y]]),
    wire(output, [[right.x, y], [top.x, y], [top.x, top.y]]),
    wire(output, [[top.x, y], [outputX, y]]),
    wire(ground, [[bottom.x, bottom.y], [bottom.x, groundY]])
  ];
  return { operations, expectedNets: { [input]: [member(resistor, left)], [output]: [member(resistor, right), member(capacitor, top)].sort(), [ground]: [member(capacitor, bottom)] } };
}

export function dividerWiring(snapshot, design) {
  const upper = byRef(snapshot, design.roles.upper), lower = byRef(snapshot, design.roles.lower);
  const { input, output, ground } = design.netRoles;
  const [a, b] = [...upper.pins].sort((x, y) => x.y - y.y), [c, d] = [...lower.pins].sort((x, y) => x.y - y.y);
  check(a.x === b.x && c.x === d.x && a.x === c.x && b.y < c.y, 'Divider requires a clear vertical resistor chain');
  const x = a.x, middle = (b.y + c.y) / 2;
  return {
    operations: [marker('Power', input, x, a.y - 80), marker('OUT', output, x + 220, middle), marker('Ground', ground, x, d.y + 80), wire(input, [[x, a.y - 80], [x, a.y]]), wire(output, [[x, b.y], [x, middle], [x, c.y]]), wire(output, [[x, middle], [x + 220, middle]]), wire(ground, [[x, d.y], [x, d.y + 80]])],
    expectedNets: { [input]: [member(upper, a)], [output]: [member(upper, b), member(lower, c)].sort(), [ground]: [member(lower, d)] }
  };
}
