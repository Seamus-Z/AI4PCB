import { createDispatcher } from './dispatcher.mjs';

const ID = 'jlceda-schematic-toolkit';
const PORT = __BRIDGE_PORT__;
const TOKEN = __BRIDGE_TOKEN__;
let connected = false;
let queue = Promise.resolve();
const dispatch = createDispatcher(eda);
const send = message => eda.sys_WebSocket.send(ID, JSON.stringify(message));

export function connect() {
  // Explicit manual reconnect, never an automatic mutation retry. The SDK's
  // fifth argument is subprotocols, NOT a disconnect/error callback.
  eda.sys_WebSocket.close(ID, 1000, 'Manual reconnect');
  connected = false;
  eda.sys_WebSocket.register(ID, 'ws://127.0.0.1:' + PORT, event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type !== 'call' || typeof message.id !== 'string' || typeof message.operation !== 'string') return;
    queue = queue.then(async () => {
      try { send({ type: 'result', id: message.id, result: await dispatch(message.operation, message.args || {}) }); }
      catch (error) { send({ type: 'error', id: message.id, error: { message: String(error?.message || error) } }); }
    }).catch(error => { connected = false; console.error('Schematic toolkit bridge stopped:', String(error?.message || error)); });
  }, () => {
    connected = true;
    send({ type: 'hello', protocol: 1, token: TOKEN });
  });
}

export function disconnect() {
  eda.sys_WebSocket.close(ID, 1000, 'Manual disconnect');
  connected = false;
}

export function showStatus() {
  eda.sys_MessageBox.showInformationMessage(connected ? 'Schematic Toolkit: WebSocket opened. MCP jlc_status confirms authentication and editor context.' : 'Schematic Toolkit: disconnected. Start MCP, enable extension external interaction, then Connect.');
}
