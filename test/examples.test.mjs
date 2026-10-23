import test from 'node:test';
import assert from 'node:assert/strict';
import { rcWiring, dividerWiring } from '../src/examples.mjs';
import { validateOperations } from '../src/geometry.mjs';
const part = (ref, x, y, pins) => ({ id: ref, ref, x, y, rotation: 0, mirror: false, pins: pins.map(([number, x, y]) => ({ number, x, y, nc: false, net: '' })) });
const snapshot = parts => ({ projectUuid: 'project', pageUuid: 'page', parts, wires: [], markers: [], texts: [] });

// Infer connectivity from coordinates and real marker anchors, not declared wire
// net fields or the builder's own expectedNets. Shared T nodes must be endpoints.
function physicalPinNets(snap, operations) {
  const graph = new Map();
  const key = point => JSON.stringify(point);
  for (const op of operations.filter(op => op.kind === 'wire.create')) for (let i = 1; i < op.points.length; i++) {
    const a = key(op.points[i - 1]), b = key(op.points[i]);
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a).add(b); graph.get(b).add(a);
  }
  const markers = operations.filter(op => op.kind === 'marker.create');
  return Object.fromEntries(snap.parts.flatMap(p => p.pins.map(pin => {
    const seen = new Set([key([pin.x, pin.y])]), pending = [...seen];
    while (pending.length) for (const next of graph.get(pending.pop()) || []) if (!seen.has(next)) { seen.add(next); pending.push(next); }
    const nets = [...new Set(markers.filter(m => seen.has(key([m.x, m.y]))).map(m => m.net))];
    assert.equal(nets.length, 1, 'Every intended pin must reach exactly one named native marker');
    return [p.ref + '.' + pin.number, nets[0]];
  })));
}

test('RC geometry connects physical input, output and ground using configured roles and exact fractional pins', () => {
  const snap = snapshot([part('RX12', 400.5, 250.5, [['2', 440.5, 250.5], ['1', 360.5, 250.5]]), part('CF3', 650.5, 370.5, [['9', 650.5, 390.5], ['4', 650.5, 350.5]])]);
  const plan = rcWiring(snap, { roles: { resistor: 'RX12', capacitor: 'CF3' }, netRoles: { input: 'SIG_A', output: 'SIG_B', ground: 'AGND' } });
  assert.equal(validateOperations(snap, plan.operations).ok, true);
  assert.deepEqual(physicalPinNets(snap, plan.operations), { 'RX12.1': 'SIG_A', 'RX12.2': 'SIG_B', 'CF3.4': 'SIG_B', 'CF3.9': 'AGND' });
});
test('divider output is an explicit shared node connecting both resistor pins and the output port', () => {
  const snap = snapshot([part('RA', 500.5, 280.5, [['1', 500.5, 240.5], ['2', 500.5, 320.5]]), part('RB', 500.5, 500.5, [['1', 500.5, 460.5], ['2', 500.5, 540.5]])]);
  const plan = dividerWiring(snap, { roles: { upper: 'RA', lower: 'RB' }, netRoles: { input: 'VIN12', output: 'VHALF', ground: 'PGND' } });
  assert.equal(validateOperations(snap, plan.operations).ok, true);
  assert.deepEqual(physicalPinNets(snap, plan.operations), { 'RA.1': 'VIN12', 'RA.2': 'VHALF', 'RB.1': 'VHALF', 'RB.2': 'PGND' });
});
