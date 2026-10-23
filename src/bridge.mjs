import { timingSafeEqual, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const OPERATIONS = new Set(['status', 'search_devices', 'snapshot', 'create_project', 'export_project', 'export_pdf', 'netlist', 'drc', 'apply']);
const MUTATIONS = new Set(['create_project', 'apply']);

export class BridgeError extends Error {
  constructor(code, message) { super(message); this.name = 'BridgeError'; this.code = code; }
}

export class EditorBridge {
  constructor({ token, port = 49831, timeoutMs = 30000, trustedOrigins = [], authTimeoutMs = 5000 } = {}) {
    if (typeof token !== 'string' || token.length < 32) throw new Error('JLCEDA_BRIDGE_TOKEN must contain at least 32 characters');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid bridge port');
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid bridge request timeout');
    if (!Array.isArray(trustedOrigins) || trustedOrigins.some(origin => typeof origin !== 'string' || !origin || origin === '*')) throw new Error('Trusted origins must be exact, non-wildcard strings');
    this.token = Buffer.from(token);
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.authTimeoutMs = authTimeoutMs;
    this.origins = new Set(trustedOrigins);
    this.socket = null;
    this.sessionId = null;
    this.uncertain = false;
    this.pending = null;
    this.queue = Promise.resolve();
    this.server = null;
    this.closed = false;
  }

  async start() {
    if (this.server || this.closed) throw new Error('Bridge cannot be started twice');
    this.server = new WebSocketServer({
      host: '127.0.0.1', port: this.port, maxPayload: 128 * 1024 * 1024,
      verifyClient: ({ req }, done) => {
        const origin = req.headers.origin;
        done(origin === undefined || this.origins.has(origin), 403, 'Untrusted Origin');
      },
    });
    this.server.on('connection', socket => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('listening', resolve);
      this.server.once('error', reject);
    });
    return this.server.address();
  }

  accept(socket) {
    let authenticated = false;
    const authTimer = setTimeout(() => socket.close(1008, 'Authentication required'), this.authTimeoutMs);
    authTimer.unref?.();
    socket.on('error', () => socket.terminate());
    socket.on('message', (bytes, binary) => {
      let message;
      try { if (binary) throw new Error(); message = JSON.parse(bytes.toString()); } catch {
        socket.close(1008, 'Invalid JSON message'); return;
      }
      if (!authenticated) {
        const candidate = typeof message?.token === 'string' ? Buffer.from(message.token) : Buffer.alloc(0);
        const valid = message?.type === 'hello' && message.protocol === 1 && candidate.length === this.token.length && timingSafeEqual(candidate, this.token);
        if (!valid) { socket.close(1008, 'Authentication failed'); return; }
        if (this.socket) { socket.close(1008, 'An editor is already connected'); return; }
        clearTimeout(authTimer);
        authenticated = true;
        this.socket = socket;
        this.sessionId = randomUUID();
        return;
      }
      if (this.socket !== socket) { socket.close(1008, 'Inactive editor'); return; }
      if (message?.type !== 'result' && message?.type !== 'error') { socket.close(1008, 'Invalid response'); return; }
      const pending = this.pending;
      if (!pending || message.id !== pending.id) return;
      if (message.type === 'error') {
        if (pending.mutation) this.uncertain = true;
        pending.finish(new BridgeError('EDITOR_ERROR', typeof message.error?.message === 'string' ? message.error.message : 'Editor operation failed'));
      } else if (!Object.hasOwn(message, 'result')) {
        if (pending.mutation) this.uncertain = true;
        pending.finish(new BridgeError('INVALID_RESPONSE', 'Editor response has no result'));
      } else pending.finish(null, message.result);
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      if (this.socket !== socket) return;
      this.socket = null;
      this.sessionId = null;
      if (this.pending) {
        if (this.pending.mutation) this.uncertain = true;
        this.pending.finish(new BridgeError('EDITOR_DISCONNECTED', 'Editor disconnected; a dispatched mutation may have partially completed'));
      }
    });
  }

  status() {
    return { connected: this.socket?.readyState === WebSocket.OPEN, sessionId: this.sessionId, uncertain: this.uncertain, pendingOperation: this.pending?.operation ?? null };
  }

  markUncertain() { this.uncertain = true; }

  assertWritable() {
    if (this.uncertain) throw new BridgeError('MUTATION_UNCERTAIN', 'A previous mutation has an uncertain outcome. Inspect the project and native backup; restart the server only after manual reconciliation.');
  }

  call(operation, args = {}) {
    if (!OPERATIONS.has(operation)) return Promise.reject(new BridgeError('UNKNOWN_OPERATION', 'Unsupported editor operation'));
    if (MUTATIONS.has(operation)) {
      try { this.assertWritable(); } catch (error) { return Promise.reject(error); }
    }
    const sessionId = this.sessionId;
    let resolveResult, rejectResult;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const task = async () => {
      try {
        const mutation = MUTATIONS.has(operation);
        if (mutation) this.assertWritable();
        if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN) throw new BridgeError('EDITOR_OFFLINE', 'No authenticated editor is connected');
        if (!sessionId || sessionId !== this.sessionId) throw new BridgeError('EDITOR_CHANGED', 'Editor connection changed before the queued request; inspect and retry explicitly');
        await new Promise(resolveLane => {
          const id = randomUUID();
          let answered = false;
          const timer = setTimeout(() => {
            if (mutation) this.uncertain = true;
            answered = true;
            rejectResult(new BridgeError(mutation ? 'MUTATION_UNCERTAIN' : 'EDITOR_TIMEOUT', mutation
              ? 'Mutation timed out and may have partially completed. No mutations may be retried; inspect the backup and editor.'
              : 'Editor request timed out; waiting for the original operation to settle before issuing further requests.'));
          }, this.timeoutMs);
          const finish = (error, value) => {
            clearTimeout(timer);
            if (!answered) { answered = true; error ? rejectResult(error) : resolveResult(value); }
            this.pending = null;
            resolveLane();
          };
          this.pending = { id, operation, mutation, finish };
          this.socket.send(JSON.stringify({ type: 'call', id, operation, args }), error => {
            if (error && this.pending?.id === id) {
              if (mutation) this.uncertain = true;
              finish(new BridgeError('SEND_FAILED', 'Editor request could not be delivered; inspect before retrying a mutation'));
            }
          });
        });
      } catch (error) { rejectResult(error); }
    };
    this.queue = this.queue.then(task, task);
    return result;
  }

  async close() {
    this.closed = true;
    for (const socket of this.server?.clients ?? []) socket.terminate();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
  }
}
