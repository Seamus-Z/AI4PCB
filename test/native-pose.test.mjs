import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../extension/src/dispatcher.mjs';

const scope = { projectUuid: 'project', pageUuid: 'page' };
const operation = { kind: 'component.move', ref: 'R1', x: 180, y: -900, rotation: 0, mirror: false };

function nativeFixture(actualY) {
  const state = { X: 0, Y: 0, Rotation: 0, Mirror: false };
  const part = {
    getState_PrimitiveId: () => 'part',
    getState_ComponentType: () => 'part',
    getState_Component: () => ({ uuid: 'device', libraryUuid: 'library' }),
    getState_Designator: () => 'R1',
    getState_Name: () => '10K',
    getState_Manufacturer: () => '',
    getState_ManufacturerId: () => '',
    getState_Supplier: () => '',
    getState_SupplierId: () => '',
    getState_AddIntoBom: () => true,
    getState_AddIntoPcb: () => true,
    getState_OtherProperty: () => ({}),
    getAllPins: async () => [{ pinNumber: '1', x: state.X - 20, y: state.Y, getState_NoConnected: () => false }, { pinNumber: '2', x: state.X + 20, y: state.Y, getState_NoConnected: () => false }],
  };
  for (const name of Object.keys(state)) part['getState_' + name] = () => state[name];
  return createDispatcher({
    dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: scope.projectUuid }) },
    dmt_Schematic: { getCurrentSchematicPageInfo: async () => ({ uuid: scope.pageUuid }) },
    dmt_EditorControl: { openDocument: async () => true },
    sch_Netlist: { getNetlist: async () => '*PART*\nR1 R0805\n*NET*\n*END*\n' },
    sch_PrimitiveComponent: {
      getAll: async () => [part],
      modify: async (_, change) => { state.X = change.x; state.Y = actualY; state.Rotation = change.rotation; state.Mirror = change.mirror; return part; },
    },
    sch_PrimitiveWire: { getAll: async () => [] },
    sch_PrimitiveText: { getAll: async () => [] },
    sch_Document: { save: async () => true },
  });
}

test('SDK pose round-trip noise does not abort a real move or round the observed pins', async () => {
  // Captured native readback: requesting 900 returned 900.0000000000001.
  const actualY = 900.0000000000001;
  const dispatch = nativeFixture(actualY);
  const expectedSnapshot = await dispatch('snapshot', scope);
  const result = await dispatch('apply', { ...scope, expectedSnapshot, operations: [operation] });
  assert.equal(result.snapshot.parts[0].y, -actualY);
  assert.deepEqual(result.snapshot.parts[0].pins.map(pin => [pin.x, pin.y]), [[160, -actualY], [200, -actualY]]);
});

test('half-grid native displacement is still rejected rather than accepted as pose noise', async () => {
  const dispatch = nativeFixture(900.5);
  const expectedSnapshot = await dispatch('snapshot', scope);
  await assert.rejects(dispatch('apply', { ...scope, expectedSnapshot, operations: [operation] }), /Move position readback mismatch: R1/);
});
