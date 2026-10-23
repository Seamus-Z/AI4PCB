import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm, readdir, readFile, lstat, symlink, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';
import { stableStringify } from '../src/geometry.mjs';
import { ArtifactStore } from '../src/tools.mjs';
import { loadConfig } from '../src/server.mjs';

const token = 'mcp-test-secret-at-least-32-characters';
const scope = { projectUuid: 'project-fixture', pageUuid: 'page-fixture' };
const note = { kind: 'text.create', x: 10.25, y: 20.5, text: 'Reviewed annotation' };
const decode = result => JSON.parse(result.content[0].text);
async function freePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

// A stateful native-editor fixture, not a forwarding mock: edits change the native
// snapshot, backup captures pre-edit state, and the peer independently checks scope.
async function fixture(t, { writes = true, backupFails = false, timeoutMs = 2000 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jlceda-mcp-'));
  const outputDir = path.join(root, 'artifacts');
  const port = await freePort();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    env: { ...process.env, JLCEDA_BRIDGE_TOKEN: token, JLCEDA_BRIDGE_PORT: String(port), JLCEDA_ENABLE_WRITES: writes ? '1' : '0', JLCEDA_OUTPUT_DIR: outputDir, JLCEDA_REQUEST_TIMEOUT_MS: String(timeoutMs), JLCEDA_TRUSTED_ORIGINS: '' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'consumer-safety-test', version: '1.0.0' }, { capabilities: {} });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.connect(transport);
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, 'open');
  t.after(() => socket.terminate());
  let snapshot = { ...scope, parts: [], markers: [], wires: [], texts: [] };
  let mutationCount = 0;
  let holdApply = false;
  let heldApply;
  let backupVisibleBeforeMutation = false;
  let fixtureError;
  let nextId = 0;
  socket.on('message', async bytes => {
    const call = JSON.parse(bytes.toString());
    try {
      let result;
      switch (call.operation) {
        case 'status': result = { protocol: 1, sdkCapabilities: {}, project: { uuid: scope.projectUuid }, page: { uuid: scope.pageUuid } }; break;
        case 'snapshot': result = structuredClone(snapshot); break;
        case 'export_project': {
          if (backupFails) throw new Error('Native export failed');
          result = { name: '../../do-not-trust-editor-name.epro2', mime: 'application/octet-stream', base64: Buffer.from(JSON.stringify(snapshot)).toString('base64') };
          break;
        }
        case 'apply': {
          if (holdApply) { heldApply = call; return; }
          assert.equal(call.args.projectUuid, scope.projectUuid);
          assert.equal(call.args.pageUuid, scope.pageUuid);
          assert.equal(stableStringify(call.args.expectedSnapshot), stableStringify(snapshot));
          const files = await readdir(outputDir);
          const backup = files.find(name => name.startsWith('native-backup-') && name.endsWith('.epro2'));
          assert.ok(backup, 'backup must exist on disk before a mutation reaches the editor');
          assert.deepEqual(JSON.parse(await readFile(path.join(outputDir, backup), 'utf8')), snapshot);
          backupVisibleBeforeMutation = true;
          const created = [];
          for (const op of call.args.operations) {
            assert.equal(op.kind, 'text.create');
            const id = `native-text-${++nextId}`;
            snapshot.texts.push({ id, text: op.text, x: op.x, y: op.y });
            created.push({ kind: 'text', id });
          }
          mutationCount++;
          result = { created, snapshot: structuredClone(snapshot), netlist: '*PADS-PCB*\n*PART*\n*NET*\n*END*\n' };
          break;
        }
        default: throw new Error(`Unexpected fixture operation ${call.operation}`);
      }
      socket.send(JSON.stringify({ type: 'result', id: call.id, result }));
    } catch (error) {
      if (error.name === 'AssertionError') fixtureError = error;
      socket.send(JSON.stringify({ type: 'error', id: call.id, error: { message: error.message } }));
    }
  });
  socket.send(JSON.stringify({ type: 'hello', protocol: 1, token }));
  // The same socket's message ordering ensures authentication precedes this RPC.
  // Give status an explicit retry only for initial unauthenticated connection setup.
  for (let i = 0; i < 100; i++) {
    const status = decode(await client.callTool({ name: 'jlc_status', arguments: {} }));
    if (status.bridge?.connected) break;
    if (i === 99) throw new Error('Editor did not authenticate');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return {
    client, outputDir, root,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    get snapshot() { return snapshot; },
    get mutationCount() { return mutationCount; },
    get backupVisibleBeforeMutation() { return backupVisibleBeforeMutation; },
    get fixtureError() { return fixtureError; },
    async disconnectEditor() { const closed = once(socket, 'close'); socket.close(); await closed; },
    setHoldApply(value) { holdApply = value; },
    settleHeldApply() { socket.send(JSON.stringify({ type: 'result', id: heldApply.id, result: { created: [], snapshot, netlist: '*PADS-PCB*\n*END*' } })); },
  };
}

test('rejects script injection fields and a snapshot from the wrong page', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('jlc_snapshot', { ...scope, script: 'anything' })).isError, true);
  assert.equal(decode(await f.call('jlc_snapshot', { ...scope, pageUuid: 'wrong-page' })).code, 'SCOPE_MISMATCH');
});

test('read-only default rejects project creation, planning, and applying; export stays available', async t => {
  const f = await fixture(t, { writes: false });
  for (const [name, args] of [['jlc_create_project', { name: 'new' }], ['jlc_plan', { ...scope, operations: [note] }], ['jlc_apply', { planId: 'not-a-plan' }]]) {
    const result = await f.call(name, args);
    assert.equal(result.isError, true);
    assert.equal(decode(result).code, 'READ_ONLY');
  }
  const exported = decode(await f.call('jlc_export_project', { projectUuid: scope.projectUuid }));
  assert.equal(path.dirname(exported.path), await import('node:fs/promises').then(fs => fs.realpath(f.outputDir)));
  assert.ok(!exported.path.includes('do-not-trust'));
  assert.equal(exported.base64, undefined);
  assert.deepEqual(JSON.parse(await readFile(exported.path, 'utf8')), f.snapshot);
  assert.equal((await lstat(exported.path)).mode & 0o777, 0o600);
  assert.equal(f.mutationCount, 0);
});

test('validated plans are single-use and a durable native backup precedes the only mutation', async t => {
  const f = await fixture(t);
  const plan = decode(await f.call('jlc_plan', { ...scope, operations: [note] }));
  assert.ok(plan.planId);
  assert.match(plan.snapshotHash, /^[a-f0-9]{64}$/);
  assert.equal(f.snapshot.texts.length, 0, 'planning must not edit');
  const [first, replay] = await Promise.all([f.call('jlc_apply', { planId: plan.planId }), f.call('jlc_apply', { planId: plan.planId })]);
  assert.equal(first.isError, undefined, JSON.stringify(decode(first)));
  assert.equal(decode(first).createdCount, 1);
  assert.equal(decode(replay).code, 'PLAN_CONSUMED');
  assert.equal(f.backupVisibleBeforeMutation, true);
  assert.equal(f.mutationCount, 1);
  assert.equal(f.snapshot.texts[0].x, 10.25);
  assert.equal(f.fixtureError, undefined);
  const log = JSON.parse(await readFile(decode(first).log.path, 'utf8'));
  assert.equal(log.result.snapshot.texts.length, 1);
});

test('stale page content rejects and consumes the plan without mutation', async t => {
  const f = await fixture(t);
  const plan = decode(await f.call('jlc_plan', { ...scope, operations: [note] }));
  f.snapshot.texts.push({ id: 'manual-edit', text: 'changed outside MCP', x: 1, y: 2 });
  const result = await f.call('jlc_apply', { planId: plan.planId });
  assert.equal(decode(result).code, 'STALE_SNAPSHOT');
  assert.equal(f.mutationCount, 0);
  assert.equal(decode(await f.call('jlc_apply', { planId: plan.planId })).code, 'PLAN_CONSUMED');
  const files = await readdir(f.outputDir);
  assert.ok(files.some(name => name.startsWith('apply-failure-')));
  assert.ok(!files.some(name => name.startsWith('native-backup-')));
});

test('native backup failure prevents edits and consumes the plan', async t => {
  const f = await fixture(t, { backupFails: true });
  const plan = decode(await f.call('jlc_plan', { ...scope, operations: [note] }));
  assert.ok(plan.planId);
  assert.equal((await f.call('jlc_apply', { planId: plan.planId })).isError, true);
  assert.equal(f.mutationCount, 0);
  assert.equal(decode(await f.call('jlc_apply', { planId: plan.planId })).code, 'PLAN_CONSUMED');
});

test('invalid projected geometry cannot produce an applicable plan', async t => {
  const f = await fixture(t);
  const result = await f.call('jlc_plan', { ...scope, operations: [{ kind: 'wire.create', net: 'N', points: [[0, 0], [1, 1]] }] });
  const plan = decode(result);
  assert.equal(plan.planId, null);
  assert.equal(plan.validation.ok, false);
  assert.equal(f.mutationCount, 0);
  assert.equal((await f.call('jlc_plan', { ...scope, operations: [{ ...note, arbitraryNativeCall: 'forbidden' }] })).isError, true);
});

test('a plan cannot outlive its authenticated editor connection', async t => {
  const f = await fixture(t);
  const plan = decode(await f.call('jlc_plan', { ...scope, operations: [note] }));
  await f.disconnectEditor();
  // Status observes the disconnected peer before attempting to consume the plan.
  const status = decode(await f.call('jlc_status'));
  assert.equal(status.bridge.connected, false);
  assert.equal(decode(await f.call('jlc_apply', { planId: plan.planId })).code, 'EDITOR_CHANGED');
  assert.equal(f.mutationCount, 0);
  assert.equal(decode(await f.call('jlc_apply', { planId: plan.planId })).code, 'PLAN_CONSUMED');
});

test('mutation timeout is reported through MCP with backup and persistent write latch', async t => {
  const f = await fixture(t, { timeoutMs: 200 });
  const plan = decode(await f.call('jlc_plan', { ...scope, operations: [note] }));
  f.setHoldApply(true);
  const timedOut = decode(await f.call('jlc_apply', { planId: plan.planId }));
  assert.equal(timedOut.code, 'MUTATION_UNCERTAIN');
  const log = JSON.parse(await readFile(timedOut.artifact.path, 'utf8'));
  assert.ok(log.backup.path.endsWith('.epro2'));
  assert.equal(log.phase, 'mutation');
  assert.equal(decode(await f.call('jlc_plan', { ...scope, operations: [note] })).code, 'MUTATION_UNCERTAIN');
  f.settleHeldApply();
  const status = decode(await f.call('jlc_status'));
  assert.equal(status.bridge.uncertain, true);
  assert.deepEqual(decode(await f.call('jlc_snapshot', scope)), f.snapshot);
});

test('artifact store rejects unsafe names and a swapped output-root symlink', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jlceda-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  const outside = path.join(root, 'outside');
  const store = new ArtifactStore(output);
  await store.root();
  await assert.rejects(store.write('../escape', 'json', '{}'), /Unsafe artifact/);
  await assert.rejects(store.write('export', '../json', '{}'), /Unsafe artifact/);
  await rm(output, { recursive: true });
  await mkdir(outside);
  await symlink(outside, output);
  await assert.rejects(store.write('export', 'json', '{}'), { code: 'ARTIFACT_ROOT_CHANGED' });
  assert.deepEqual(await readdir(outside), []);
});

test('environment configuration is portable and fails closed on absent secrets or ambiguous gates', () => {
  assert.throws(() => loadConfig({}), /TOKEN/);
  assert.throws(() => loadConfig({ JLCEDA_BRIDGE_TOKEN: token, JLCEDA_ENABLE_WRITES: 'true' }), /0 or 1/);
  const config = loadConfig({ JLCEDA_BRIDGE_TOKEN: token, JLCEDA_OUTPUT_DIR: './another-project-artifacts', JLCEDA_BRIDGE_PORT: '51001' });
  assert.equal(config.enableWrites, false);
  assert.equal(config.outputDir, './another-project-artifacts');
  assert.equal(config.port, 51001);
});
