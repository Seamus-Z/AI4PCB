import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { EditorBridge } from '../src/bridge.mjs';

const token = 'bridge-test-secret-at-least-32-characters';
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture did not become ready'); await delay(5); }
}
async function setup(t, options = {}) {
  const bridge = new EditorBridge({ token, port: 0, timeoutMs: 1000, ...options });
  const address = await bridge.start();
  t.after(() => bridge.close());
  const connect = async (hello = { type: 'hello', protocol: 1, token }) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, 'open');
    const closed = once(socket, 'close');
    socket.send(JSON.stringify(hello));
    return { socket, closed };
  };
  return { bridge, address, connect };
}

test('rejects missing/wrong authentication and accepts only one authenticated editor', async t => {
  const { bridge, connect } = await setup(t);
  const bad = await connect({ type: 'hello', protocol: 1, token: `${token}wrong` });
  const [code] = await bad.closed;
  assert.equal(code, 1008);
  assert.equal(bridge.status().connected, false);
  await assert.rejects(bridge.call('status'), { code: 'EDITOR_OFFLINE' });
  const first = await connect();
  await until(() => bridge.status().connected);
  const session = bridge.status().sessionId;
  const second = await connect();
  assert.equal((await second.closed)[0], 1008);
  assert.equal(bridge.status().sessionId, session);
  first.socket.on('message', bytes => {
    const call = JSON.parse(bytes.toString());
    first.socket.send(JSON.stringify({ type: 'result', id: call.id, result: { project: 'original-editor' } }));
  });
  assert.deepEqual(await bridge.call('status'), { project: 'original-editor' });
});

test('rejects cross-site browser Origin before WebSocket authentication', async t => {
  const { address, bridge } = await setup(t);
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, { origin: 'https://attacker.example' });
  const [error] = await once(socket, 'error');
  assert.match(error.message, /403/);
  assert.equal(bridge.status().connected, false);
});

test('permits only an explicitly configured exact trusted Origin', async t => {
  const { address, bridge } = await setup(t, { trustedOrigins: ['https://editor.example'] });
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, { origin: 'https://editor.example' });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'hello', protocol: 1, token }));
  await until(() => bridge.status().connected);
  assert.equal(bridge.status().connected, true);
});

test('serializes native operations and retains the lane after a mutation timeout', async t => {
  const { bridge, connect } = await setup(t, { timeoutMs: 60 });
  const { socket } = await connect();
  await until(() => bridge.status().connected);
  const received = [];
  socket.on('message', bytes => {
    const call = JSON.parse(bytes.toString());
    received.push(call);
    if (call.operation === 'status') socket.send(JSON.stringify({ type: 'result', id: call.id, result: { inspected: true } }));
  });
  await assert.rejects(bridge.call('apply', {}), { code: 'MUTATION_UNCERTAIN' });
  assert.equal(received.length, 1);
  assert.equal(bridge.status().uncertain, true);
  await assert.rejects(bridge.call('create_project', { name: 'must-not-run' }), { code: 'MUTATION_UNCERTAIN' });
  const inspection = bridge.call('status');
  await delay(20);
  assert.equal(received.length, 1, 'inspection must not race the still-running mutation');
  socket.send(JSON.stringify({ type: 'result', id: received[0].id, result: { late: true } }));
  assert.deepEqual(await inspection, { inspected: true });
  assert.equal(received.length, 2);
  await assert.rejects(bridge.call('apply', {}), { code: 'MUTATION_UNCERTAIN' });
});

test('disconnect during a dispatched mutation latches writes across reconnection', async t => {
  const { bridge, connect } = await setup(t);
  const first = await connect();
  await until(() => bridge.status().connected);
  first.socket.on('message', () => first.socket.terminate());
  await assert.rejects(bridge.call('apply', {}), { code: 'EDITOR_DISCONNECTED' });
  await first.closed;
  assert.equal(bridge.status().uncertain, true);
  const second = await connect();
  await until(() => bridge.status().connected);
  second.socket.on('message', bytes => {
    const call = JSON.parse(bytes.toString());
    second.socket.send(JSON.stringify({ type: 'result', id: call.id, result: { inspected: true } }));
  });
  assert.deepEqual(await bridge.call('status'), { inspected: true });
  await assert.rejects(bridge.call('apply', {}), { code: 'MUTATION_UNCERTAIN' });
});

test('rejects generic SDK/eval operations without forwarding them to the editor', async t => {
  const { bridge } = await setup(t);
  await assert.rejects(bridge.call('eval', { code: '1+1' }), { code: 'UNKNOWN_OPERATION' });
  await assert.rejects(bridge.call('shell', { command: 'anything' }), { code: 'UNKNOWN_OPERATION' });
});
