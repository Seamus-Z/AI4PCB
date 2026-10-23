import test from 'node:test';
import assert from 'node:assert/strict';
import { stableStringify, parsePads, compareNetlists, validateOperations } from '../src/geometry.mjs';

const snapshot = (changes = {}) => ({ projectUuid: 'project', pageUuid: 'page', parts: [], markers: [], wires: [], texts: [], ...changes });
const part = (changes = {}) => ({ id: 'part-1', ref: 'U1', deviceUuid: 'device', libraryUuid: 'library', x: 0, y: 0, rotation: 0, mirror: false, properties: { 'Supplier Part': '' }, pins: [{ number: '1', x: 0, y: 0, nc: false }], ...changes });
const wire = (id, net, points) => ({ id, net, paths: [points] });
const createWire = (net, points) => ({ kind: 'wire.create', net, points });
const move = (changes = {}) => ({ kind: 'component.move', ref: 'U1', x: 10, y: 20, rotation: 0, mirror: false, ...changes });
const createPart = (changes = {}) => ({ kind: 'component.create', device: { uuid: 'device', libraryUuid: 'library' }, ref: 'U2', x: 100, y: 200, ...changes });
const codes = validation => validation.errors.map(error => error.code);
const hasError = (validation, code) => assert.ok(codes(validation).includes(code), JSON.stringify(validation));
const valid = validation => assert.equal(validation.ok, true, JSON.stringify(validation));

// Native F-export grammar: PART ... ITEMS, NET, SIGNAL and wrapped REF.pin lists.
// These small original fixtures deliberately have no dependency on any project export.
const pads = (parts = 'U1 PACKAGE\nR1 RESISTOR', signals = '*SIGNAL* VCC\nU1.1 R1.2\n*SIGNAL* GND\nU1.2 R1.1') => `!PADS-POWERPCB-V9.0-MILS-CP936! Created by editor\n*REMARK* Schematic\n*PART* ITEMS\n${parts}\n*NET*\n${signals}\n*END*\n`;

test('canonical JSON recursively sorts keys without rounding fractional coordinates', () => {
  assert.equal(stableStringify({ z: [0.125, { y: 1.0000000000000002, a: -0 }], a: { z: false, a: '' } }), '{"a":{"a":"","z":false},"z":[0.125,{"a":0,"y":1.0000000000000002}]}');
  assert.equal(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 }));
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
  const cycle = {}; cycle.self = cycle;
  for (const value of [NaN, Infinity, undefined, { x: undefined }, [undefined], new Date(), cycle, Array(1), { x: 1n }]) assert.throws(() => stableStringify(value), TypeError);
});

test('PADS parsing supports arbitrary pinlist wrapping, dotted refs and sorted memberships', () => {
  const input = pads('U.1 PACKAGE\nR1 RESISTOR', '*SIGNAL* VCC\n R1.2\tU.1.A1\n\nR1.1\n*SIGNAL* GND\nU.1.B2');
  assert.deepEqual(parsePads(input.replaceAll('\n', '\r\n')), { refs: ['R1', 'U.1'], nets: { GND: ['U.1.B2'], VCC: ['R1.1', 'R1.2', 'U.1.A1'] } });
  assert.deepEqual(parsePads(pads('', '')), { refs: [], nets: {} });
});

test('identical PADS memberships in different order compare equal', () => {
  const reordered = pads('R1 OTHER_PACKAGE\nU1 PACKAGE', '*SIGNAL* GND\nR1.1\nU1.2\n*SIGNAL* VCC\nR1.2\nU1.1');
  assert.deepEqual(compareNetlists(pads(), reordered), { equal: true, addedRefs: [], removedRefs: [], changedNets: [] });
});

test('PADS comparison reports real pin changes, refs and strict net renames', () => {
  const changed = pads('U1 PACKAGE\nC1 CAP', '*SIGNAL* POWER\nU1.1 C1.1\n*SIGNAL* GND\nU1.2 C1.2');
  const comparison = compareNetlists(pads(), changed);
  assert.equal(comparison.equal, false);
  assert.deepEqual(comparison.addedRefs, ['C1']);
  assert.deepEqual(comparison.removedRefs, ['R1']);
  assert.deepEqual(comparison.changedNets, [
    { net: 'GND', before: ['R1.1', 'U1.2'], after: ['C1.2', 'U1.2'] },
    { net: 'POWER', before: [], after: ['C1.1', 'U1.1'] },
    { net: 'VCC', before: ['R1.2', 'U1.1'], after: [] },
  ]);
});

test('malformed PADS never silently produces equivalent empty netlists', () => {
  for (const input of ['', 'not a netlist', pads('U1 P\nU1 P'), pads('U1 P', '*SIGNAL* N\nNOPE.1'), pads('U1 P', '*SIGNAL* N\nU1.1\n*SIGNAL* M\nU1.1'), pads('U1 P', '*SIGNAL*\nU1.1'), pads('U1 P', '*SIGNAL* N\nBAD'), pads().replace('*END*', '')]) assert.throws(() => parsePads(input));
});

test('strict operation shape rejects illegal component changes and fake operations', () => {
  const state = snapshot({ parts: [part()] });
  hasError(validateOperations(state, [move({ properties: { 'Supplier Part': 'changed' } })]), 'UNKNOWN_FIELD');
  hasError(validateOperations(state, [move({ deviceUuid: 'replacement' })]), 'UNKNOWN_FIELD');
  hasError(validateOperations(state, [{ kind: 'component.delete', ref: 'U1' }]), 'UNKNOWN_OPERATION');
  hasError(validateOperations(state, [{ kind: 'text.delete', ids: ['part-1'] }]), 'UNKNOWN_OPERATION');
  hasError(validateOperations(state, [createPart({ device: { uuid: 'd', libraryUuid: 'l', symbolUuid: 'hand-drawn' } })]), 'UNKNOWN_FIELD');
  hasError(validateOperations(state, [move({ rotation: 45 })]), 'INVALID_ROTATION');
  hasError(validateOperations(state, [move({ mirror: 1 })]), 'INVALID_MIRROR');
  hasError(validateOperations(state, [move({ x: Infinity })]), 'INVALID_COORDINATE');
});

test('duplicate refs, native IDs, stale deletion IDs and unknown pins are actionable', () => {
  const state = snapshot({ parts: [part()] });
  hasError(validateOperations(state, [createPart({ ref: 'U1' })]), 'DUPLICATE_REF');
  hasError(validateOperations(snapshot({ parts: [part(), part({ id: 'part-2' })] }), []), 'DUPLICATE_REF');
  hasError(validateOperations(snapshot({ parts: [part()], wires: [wire('part-1', 'N', [[2, 2], [4, 2]])] }), []), 'DUPLICATE_ID');
  hasError(validateOperations(state, [{ kind: 'wire.delete', ids: ['missing'] }]), 'UNKNOWN_ID');
  hasError(validateOperations(state, [{ kind: 'marker.delete', ids: ['part-1'] }]), 'UNKNOWN_ID');
  hasError(validateOperations(state, [{ kind: 'pin.nc', ref: 'U1', pin: '9', enabled: true }]), 'UNKNOWN_PIN');
  hasError(validateOperations(state, [move({ ref: 'U404' })]), 'UNKNOWN_REF');
  const wired = snapshot({ wires: [wire('w', 'N', [[0, 0], [4, 0]])] });
  hasError(validateOperations(wired, [{ kind: 'wire.delete', ids: ['w', 'w'] }]), 'DUPLICATE_DELETE_ID');
  hasError(validateOperations(wired, [{ kind: 'wire.delete', ids: ['w'] }, { kind: 'wire.delete', ids: ['w'] }]), 'UNKNOWN_ID');
});

test('wire shapes reject nonfinite, zero and diagonal segments', () => {
  for (const [points, code] of [
    [[[0, 0], [0, 0]], 'ZERO_LENGTH_WIRE'],
    [[[0, 0], [1, 1]], 'DIAGONAL_WIRE'],
    [[[0, 0], [NaN, 0]], 'INVALID_PATH'],
    [[[0, 0, 1], [1, 0]], 'INVALID_PATH'],
  ]) hasError(validateOperations(snapshot(), [createWire('N', points)]), code);
});

test('different-net perpendicular crossings, T-junctions and endpoints are rejected', () => {
  const state = snapshot({ wires: [wire('base', 'A', [[0, 0], [10, 0]])] });
  for (const points of [[[5, -2], [5, 2]], [[5, -2], [5, 0]], [[10, 0], [10, 2]], [[0, -2], [0, 0]]]) {
    hasError(validateOperations(state, [createWire('B', points)]), 'NET_CONTACT');
  }
  valid(validateOperations(state, [createWire('A', [[5, -2], [5, 0]])]));
});

test('collinear overlaps detect reversed segments, containment and exact endpoint contact', () => {
  const state = snapshot({ wires: [wire('base', 'A', [[10, 0], [0, 0]])] });
  for (const points of [[[8, 0], [2, 0]], [[-2, 0], [12, 0]], [[10, 0], [12, 0]]]) hasError(validateOperations(state, [createWire('B', points)]), 'NET_CONTACT');
  valid(validateOperations(state, [createWire('B', [[10.000000000000002, 0], [12, 0]])]));
  const vertical = snapshot({ wires: [wire('base', 'A', [[0, 10], [0, 0]])] });
  hasError(validateOperations(vertical, [createWire('B', [[0, 2], [0, 8]])]), 'NET_CONTACT');
});

test('fractional endpoint contacts are exact, not rounded or fuzzy', () => {
  const state = snapshot({ parts: [part({ pins: [{ number: '1', x: 1.125, y: 2.375, nc: true }] })] });
  const touching = validateOperations(state, [createWire('N', [[0, 2.375], [1.125, 2.375]])]);
  hasError(touching, 'NC_CONTACT');
  assert.deepEqual(touching.errors.find(error => error.code === 'NC_CONTACT').point, [1.125, 2.375]);
  valid(validateOperations(state, [createWire('N', [[0, 2.375], [1.1249999999999998, 2.375]])]));
});

test('NC endpoint, segment interior, marker and coincident-pin contacts are rejected', () => {
  const state = snapshot({ parts: [part({ pins: [{ number: 1, x: 0, y: 0, nc: true }] })] });
  hasError(validateOperations(state, [createWire('N', [[-1, 0], [1, 0]])]), 'NC_CONTACT');
  hasError(validateOperations(state, [{ kind: 'marker.create', marker: 'Ground', net: 'GND', x: 0, y: 0 }]), 'NC_CONTACT');
  valid(validateOperations(state, [{ kind: 'pin.nc', ref: 'U1', pin: '1', enabled: false }, createWire('N', [[0, 0], [1, 0]])]));
  const coincident = snapshot({ parts: [state.parts[0], part({ id: 'part-2', ref: 'U2' })] });
  hasError(validateOperations(coincident, []), 'NC_PIN_CONTACT');
});

test('projected deletion resolves conflicts and NC uses final state', () => {
  const state = snapshot({ parts: [part()], wires: [wire('old', 'A', [[0, 0], [10, 0]])], markers: [{ id: 'marker', kind: 'netflag', net: 'A', x: 0, y: 0, rotation: 0 }] });
  valid(validateOperations(state, [{ kind: 'wire.delete', ids: ['old'] }, { kind: 'marker.delete', ids: ['marker'] }, { kind: 'pin.nc', ref: 'U1', pin: 1, enabled: true }]));
  valid(validateOperations(state, [{ kind: 'wire.delete', ids: ['old'] }, { kind: 'marker.delete', ids: ['marker'] }, createWire('B', [[0, 0], [0, 10]])]));
});

test('unknown disconnected wire nets are inspectable but new named contact is ambiguous', () => {
  const state = snapshot({ wires: [wire('unknown', '', [[0, 0], [10, 0]])] });
  valid(validateOperations(state, []));
  hasError(validateOperations(state, [createWire('A', [[5, -5], [5, 0]])]), 'AMBIGUOUS_NET_CONTACT');
  valid(validateOperations(state, [createWire('A', [[0, 1], [10, 1]])]));
});

test('simple translation uses projected fractional pin coordinates and preserves procurement properties', () => {
  const state = snapshot({ parts: [part({ x: 1.125, y: 2.375, pins: [{ number: '1', x: 1.625, y: 2.625, nc: true }] })] });
  const before = stableStringify(state);
  const ops = [move({ x: 11.125, y: 22.375 }), createWire('N', [[11.625, 20], [11.625, 22.625]])];
  hasError(validateOperations(state, ops), 'NC_CONTACT');
  assert.equal(stableStringify(state), before);
  assert.equal(state.parts[0].properties['Supplier Part'], '');
});

test('translation cannot silently leave old connected wires or collide with wrong net', () => {
  const state = snapshot({ parts: [part({ pins: [{ number: '1', x: 0, y: 0, nc: false, net: 'A' }] })], wires: [wire('old', 'A', [[0, 0], [-10, 0]])] });
  hasError(validateOperations(state, [move()]), 'PIN_MOVE_DISCONNECTS');
  valid(validateOperations(state, [{ kind: 'wire.delete', ids: ['old'] }, move()]));
  hasError(validateOperations(state, [{ kind: 'wire.delete', ids: ['old'] }, move(), createWire('B', [[10, 20], [20, 20]])]), 'MOVED_PIN_NET_CHANGE');
  hasError(validateOperations(snapshot({ parts: state.parts }), [createWire('B', [[0, 0], [1, 0]])]), 'PIN_NET_CHANGE');
});

test('translation into another observed pin needs a confirmed common net', () => {
  const state = snapshot({ parts: [part(), part({ id: 'part-2', ref: 'U2', x: 10, y: 20, pins: [{ number: '1', x: 10, y: 20, nc: false }] })] });
  hasError(validateOperations(state, [move()]), 'PIN_CONTACT');
});

test('rotation and mirror require isolated staging with explicit contact deletion', () => {
  const state = snapshot({ parts: [part()], wires: [wire('old', 'A', [[0, 0], [-10, 0]])], markers: [{ id: 'marker', kind: 'netport', net: 'A', x: 0, y: 0, rotation: 0 }] });
  for (const transform of [move({ rotation: 90 }), move({ mirror: true })]) {
    hasError(validateOperations(state, [transform]), 'PIN_TRANSFORM_REQUIRES_STAGING');
    hasError(validateOperations(state, [{ kind: 'wire.delete', ids: ['old'] }, transform]), 'PIN_TRANSFORM_REQUIRES_STAGING');
    const stage = [{ kind: 'wire.delete', ids: ['old'] }, { kind: 'marker.delete', ids: ['marker'] }, transform];
    const staged = validateOperations(state, stage);
    valid(staged);
    assert.ok(staged.warnings.some(warning => warning.code === 'UNOBSERVED_TRANSFORMED_PINS'));
    hasError(validateOperations(state, [...stage, createWire('A', [[10, 20], [20, 20]])]), 'PIN_TRANSFORM_REQUIRES_STAGING');
    hasError(validateOperations(state, [{ kind: 'pin.nc', ref: 'U1', pin: 1, enabled: false }, ...stage]), 'PIN_TRANSFORM_REQUIRES_STAGING');
  }
  valid(validateOperations(snapshot({ parts: [part()] }), [move({ rotation: 360 })]));
});

test('new components may stage native poses and decoration, never guessed wiring or NC', () => {
  const state = snapshot();
  const create = createPart({ rotation: 270, mirror: true });
  const staged = validateOperations(state, [create, { kind: 'text.create', x: 1.5, y: 2.5, text: 'Review', size: 10 }, { kind: 'module.create', left: 0, top: 0, right: 100, bottom: 100, title: 'Block' }]);
  valid(staged);
  assert.ok(staged.warnings.some(warning => warning.code === 'UNOBSERVED_COMPONENT_PINS'));
  hasError(validateOperations(state, [create, createWire('N', [[100, 200], [110, 200]])]), 'NEW_COMPONENT_REQUIRES_STAGING');
  hasError(validateOperations(state, [create, { kind: 'pin.nc', ref: 'U2', pin: 1, enabled: true }]), 'NEW_COMPONENT_REQUIRES_STAGING');
  hasError(validateOperations(state, [createWire('N', [[0, 0], [1, 0]]), create]), 'NEW_COMPONENT_REQUIRES_STAGING');
});

test('route bends and unknown visual bounds produce actionable warnings without imaginary collisions', () => {
  const ops = [createWire('N', [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]])];
  const result = validateOperations(snapshot(), ops);
  valid(result);
  assert.ok(result.warnings.some(warning => warning.code === 'WIRE_BENDS' && warning.bends === 3));
  assert.ok(result.warnings.some(warning => warning.code === 'VISUAL_REVIEW_REQUIRED'));
  assert.deepEqual(result.metrics, { operations: 1, parts: 0, pins: 0, wires: 1, segments: 4, markers: 0 });
  assert.equal(validateOperations(snapshot(), ops, { maxBends: 3 }).warnings.some(warning => warning.code === 'WIRE_BENDS'), false);
  hasError(validateOperations(snapshot(), ops, { tolerance: 0.1 }), 'UNKNOWN_FIELD');
  assert.deepEqual(validateOperations(snapshot(), ops), result);
});

test('planned entity IDs cannot overwrite arbitrary native IDs and hide contacts', () => {
  const state = snapshot({ wires: [wire('operation:0', 'A', [[0, 0], [10, 0]])] });
  hasError(validateOperations(state, [createWire('B', [[5, -1], [5, 1]])]), 'NET_CONTACT');
});

test('translation may retain connectivity through an explicit same-net orthogonal reroute', () => {
  const state = snapshot({ parts: [part({ pins: [{ number: '1', x: 0, y: 0, nc: false, net: 'A' }] })], wires: [wire('old', 'A', [[0, 0], [-10, 0]])] });
  valid(validateOperations(state, [move(), createWire('A', [[0, 0], [10, 0], [10, 20]])]));
  hasError(validateOperations(state, [move(), createWire('A', [[1, 0], [10, 0], [10, 20]])]), 'PIN_MOVE_DISCONNECTS');
});

test('repeated transforms cannot lose original pin-contact staging guards', () => {
  const state = snapshot({ parts: [part()], wires: [wire('old', 'A', [[0, 0], [10, 0]])] });
  hasError(validateOperations(state, [move({ rotation: 90 }), move({ rotation: 180 })]), 'PIN_TRANSFORM_REQUIRES_STAGING');
});

test('coincident observed pins on different named nets are explicit conflicts', () => {
  const state = snapshot({ parts: [
    part({ pins: [{ number: '1', x: 0, y: 0, nc: false, net: 'A' }] }),
    part({ id: 'part-2', ref: 'U2', pins: [{ number: '1', x: 0, y: 0, nc: false, net: 'B' }] }),
  ] });
  hasError(validateOperations(state, []), 'PIN_CONTACT');
});
