import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { stableStringify, validateOperations } from './geometry.mjs';

const string = { type: 'string', minLength: 1, maxLength: 4096 };
const number = { type: 'number' };
const boolean = { type: 'boolean' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const array = (items, minItems = 0, maxItems = 10000) => ({ type: 'array', items, minItems, maxItems });
const point = array(number, 2, 2);
const rotation = { type: 'number', enum: [0, 90, 180, 270] };
const scope = { projectUuid: string, pageUuid: string };
const tagged = (kind, fields, required = Object.keys(fields)) => object({ kind: { const: kind }, ...fields }, ['kind', ...required]);
export const operationSchema = { anyOf: [
  tagged('component.create', { device: object({ uuid: string, libraryUuid: string }), ref: string, x: number, y: number, rotation, mirror: boolean, value: { type: 'string', maxLength: 4096 } }, ['device', 'ref', 'x', 'y']),
  tagged('component.move', { ref: string, x: number, y: number, rotation, mirror: boolean }),
  tagged('marker.create', { marker: { enum: ['Ground', 'Power', 'AnalogGround', 'ProtectGround', 'IN', 'OUT', 'BI'] }, net: string, x: number, y: number, rotation }, ['marker', 'net', 'x', 'y']),
  tagged('wire.create', { net: string, points: array(point, 2), label: boolean }, ['net', 'points']),
  tagged('pin.nc', { ref: string, pin: string, enabled: boolean }),
  tagged('wire.delete', { ids: array(string, 1) }),
  tagged('marker.delete', { ids: array(string, 1) }),
  tagged('text.create', { x: number, y: number, text: string, size: { type: 'number', exclusiveMinimum: 0 } }, ['x', 'y', 'text']),
  tagged('module.create', { left: number, top: number, right: number, bottom: number, title: string }),
] };
const definitions = [
  ['jlc_status', 'Inspect the authenticated editor connection, write safety latch, and native project/page.', object({}), false],
  ['jlc_search_devices', 'Search actual library DEVICE entries; use their UUID and library UUID for placement.', object({ query: string, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['query']), false],
  ['jlc_snapshot', 'Read exact native schematic objects and pin coordinates for an explicitly scoped page.', object(scope), false],
  ['jlc_create_project', 'Create a new native project without replacing an existing project. Requires JLCEDA_ENABLE_WRITES=1; do not retry automatically.', object({ name: string, teamUuid: string }, ['name']), true],
  ['jlc_plan', 'Validate and stage explicit operations without editing. Requires writes enabled. Returns an expiring single-use plan bound to the current editor and exact snapshot.', object({ ...scope, operations: array(operationSchema, 1, 1000) }), true],
  ['jlc_apply', 'Consume a plan once, recheck the exact scoped snapshot, download a native backup, then apply. Never retry an uncertain mutation.', object({ planId: string }), true],
  ['jlc_export_project', 'Download an actual native epro2 project to JLCEDA_OUTPUT_DIR; returns a local artifact path, not base64.', object({ projectUuid: string }), false],
  ['jlc_export_pdf', 'Download an actual PDF of the current schematic pages to JLCEDA_OUTPUT_DIR.', object(scope), false],
  ['jlc_netlist', 'Export the actual PADS netlist to JLCEDA_OUTPUT_DIR.', object(scope), false],
  ['jlc_drc', 'Run native schematic DRC for the explicit project and page.', object(scope), false],
];

export const TOOL_DEFINITIONS = definitions.map(([name, description, inputSchema, mutation]) => ({
  name, description, inputSchema,
  annotations: { readOnlyHint: !mutation, destructiveHint: name === 'jlc_apply', idempotentHint: !mutation, openWorldHint: true },
}));

function conforms(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(option => conforms(value, option));
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if ((schema.required ?? []).some(key => !Object.hasOwn(value, key))) return false;
    return Object.keys(value).every(key => Object.hasOwn(schema.properties, key) && conforms(value[key], schema.properties[key]));
  }
  if (schema.type === 'array') return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems && value.every(item => conforms(item, schema.items));
  if (schema.type === 'string') return typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'number' || schema.type === 'integer') return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity) && (schema.exclusiveMinimum === undefined || value > schema.exclusiveMinimum);
  return true;
}

const hash = value => createHash('sha256').update(stableStringify(value)).digest('hex');
function failure(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }
const errorInfo = error => ({ code: error.code ?? 'TOOL_FAILED', message: error.message ?? String(error), ...(error.artifact ? { artifact: error.artifact } : {}) });

export class ArtifactStore {
  constructor(directory = './outputs') { this.directory = path.resolve(directory); this.rootPromise = null; }
  async root() {
    if (!this.rootPromise) this.rootPromise = (async () => { await mkdir(this.directory, { recursive: true }); return realpath(this.directory); })();
    return this.rootPromise;
  }
  async write(kind, extension, data) {
    if (!/^[a-z-]+$/.test(kind) || !/^[a-z0-9]+$/.test(extension)) throw new Error('Unsafe artifact filename');
    const root = await this.root();
    if (await realpath(root) !== root || await realpath(this.directory) !== root) throw failure('ARTIFACT_ROOT_CHANGED', 'Configured artifact directory changed; refusing to write');
    const filename = `${kind}-${Date.now()}-${randomUUID()}.${extension}`;
    const target = path.resolve(root, filename);
    if (path.dirname(target) !== root) throw new Error('Artifact escaped configured root');
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    return { path: target, bytes: Buffer.byteLength(data) };
  }
  json(kind, value) { return this.write(kind, 'json', `${JSON.stringify(value, null, 2)}\n`); }
  async download(kind, extension, payload) {
    if (!payload || typeof payload.base64 !== 'string' || payload.base64.length === 0 || payload.base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.base64)) throw failure('INVALID_EXPORT', 'Editor did not return a nonempty native file');
    const bytes = Buffer.from(payload.base64, 'base64');
    if (bytes.length === 0 || bytes.toString('base64') !== payload.base64) throw failure('INVALID_EXPORT', 'Invalid native file encoding');
    if (extension === 'pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') throw failure('INVALID_EXPORT', 'Editor returned a non-PDF file');
    return { ...await this.write(kind, extension, bytes), mime: payload.mime ?? 'application/octet-stream' };
  }
}

export class ToolkitTools {
  constructor({ bridge, enableWrites = false, outputDir = './outputs', planTtlMs = 15 * 60 * 1000, maxPlans = 128 } = {}) {
    if (!bridge) throw new Error('Editor bridge required');
    this.bridge = bridge;
    this.enableWrites = enableWrites;
    this.artifacts = new ArtifactStore(outputDir);
    this.planTtlMs = planTtlMs;
    this.maxPlans = maxPlans;
    this.plans = new Map();
    this.queue = Promise.resolve();
  }
  call(name, args = {}) {
    // Hold the entire workflow, not just each editor RPC, so concurrent consumers cannot interleave backup/apply.
    const execute = async () => {
      try {
        const definition = TOOL_DEFINITIONS.find(tool => tool.name === name);
        if (!definition) throw failure('UNKNOWN_TOOL', 'Unknown tool');
        if (!conforms(args, definition.inputSchema)) throw failure('INVALID_ARGUMENTS', `Arguments do not match the closed schema for ${name}`);
        if (['jlc_create_project', 'jlc_plan', 'jlc_apply'].includes(name)) {
          if (!this.enableWrites) throw failure('READ_ONLY', 'Writes are disabled. Set JLCEDA_ENABLE_WRITES=1 explicitly before starting the server.');
          this.bridge.assertWritable();
        }
        const result = await this.execute(name, args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorInfo(error)) }] }; }
    };
    const result = this.queue.then(execute, execute);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  async snapshot(args) {
    const snapshot = await this.bridge.call('snapshot', args);
    if (!snapshot || snapshot.projectUuid !== args.projectUuid || snapshot.pageUuid !== args.pageUuid || !['parts', 'markers', 'wires', 'texts'].every(key => Array.isArray(snapshot[key]))) throw failure('SCOPE_MISMATCH', 'Editor snapshot does not match the requested project and page');
    return snapshot;
  }
  async execute(name, args) {
    switch (name) {
      case 'jlc_status': {
        const bridge = this.bridge.status();
        return { writesEnabled: this.enableWrites, bridge, editor: bridge.connected ? await this.bridge.call('status', {}) : null };
      }
      case 'jlc_search_devices': return this.bridge.call('search_devices', { limit: 10, ...args });
      case 'jlc_snapshot': return this.snapshot(args);
      case 'jlc_create_project': {
        const sessionId = this.bridge.status().sessionId;
        const source = await this.bridge.call('status', {});
        const sourceProjectUuid = source?.project?.uuid ?? null;
        const sourceBackup = sourceProjectUuid
          ? await this.artifacts.download('before-create-backup', 'epro2', await this.bridge.call('export_project', { projectUuid: sourceProjectUuid }))
          : null;
        const intent = await this.artifacts.json('create-intent', { requestedAt: new Date().toISOString(), sessionId, args, sourceProjectUuid, sourceBackup });
        try {
          if (!sessionId || this.bridge.status().sessionId !== sessionId) throw failure('EDITOR_CHANGED', 'Editor changed before project creation');
          const project = await this.bridge.call('create_project', { ...args, expectedSourceProjectUuid: sourceProjectUuid });
          if (!project || !['projectUuid', 'boardName', 'schematicUuid', 'pageUuid'].every(key => typeof project[key] === 'string' && project[key])) {
            this.bridge.markUncertain();
            throw failure('INVALID_CREATE_RESULT', 'Project creation returned an incomplete result; inspect the native editor before proceeding');
          }
          const log = await this.artifacts.json('create-result', { args, project, sourceBackup });
          return { project, log, intent, sourceBackup };
        } catch (error) {
          try { error.artifact = await this.artifacts.json('create-failure', { args, error: errorInfo(error), bridge: this.bridge.status(), intent }); } catch (loggingError) { error.message += `; failure log unavailable: ${loggingError.message}`; }
          throw error;
        }
      }
      case 'jlc_plan': {
        for (const [id, plan] of this.plans) if (plan.expiresAt <= Date.now()) this.plans.delete(id);
        if (this.plans.size >= this.maxPlans) throw failure('PLAN_LIMIT', 'Too many pending plans; consume them or wait for expiration');
        const sessionId = this.bridge.status().sessionId;
        const snapshot = await this.snapshot({ projectUuid: args.projectUuid, pageUuid: args.pageUuid });
        if (!sessionId || this.bridge.status().sessionId !== sessionId) throw failure('EDITOR_CHANGED', 'Editor changed during planning');
        const validation = validateOperations(snapshot, args.operations);
        const snapshotHash = hash(snapshot);
        if (!validation.ok) return { planId: null, snapshotHash, validation };
        const planId = randomUUID();
        const expiresAt = Date.now() + this.planTtlMs;
        // Clone the caller-owned operations so they cannot be altered after validation.
        const operations = JSON.parse(JSON.stringify(args.operations));
        const fingerprint = hash({ snapshot, operations });
        this.plans.set(planId, { ...args, operations, sessionId, snapshotHash, fingerprint, expiresAt });
        return { planId, projectUuid: args.projectUuid, pageUuid: args.pageUuid, snapshotHash, fingerprint, expiresAt: new Date(expiresAt).toISOString(), coordinates: 'native screen coordinates; +Y down; exact fractional pins', operations, validation };
      }
      case 'jlc_apply': return this.apply(args.planId);
      case 'jlc_export_project': return this.artifacts.download('project-export', 'epro2', await this.bridge.call('export_project', args));
      case 'jlc_export_pdf': return this.artifacts.download('schematic-export', 'pdf', await this.bridge.call('export_pdf', args));
      case 'jlc_netlist': {
        const result = await this.bridge.call('netlist', args);
        if (result?.format !== 'PADS' || typeof result.text !== 'string') throw failure('INVALID_NETLIST', 'Editor did not return a PADS netlist');
        return { format: 'PADS', ...await this.artifacts.write('netlist', 'pads', result.text) };
      }
      case 'jlc_drc': return this.bridge.call('drc', args);
      default: throw failure('UNKNOWN_TOOL', 'Unknown tool');
    }
  }
  async apply(planId) {
    const plan = this.plans.get(planId);
    this.plans.delete(planId); // Every attempt consumes the plan, including stale scope or backup failure.
    if (!plan) throw failure('PLAN_CONSUMED', 'Plan does not exist or was already consumed; inspect and make a new plan');
    let backup;
    let phase = 'preflight';
    try {
      if (plan.expiresAt <= Date.now()) throw failure('PLAN_EXPIRED', 'Plan expired; inspect and create a new plan');
      const checkSession = () => { if (this.bridge.status().sessionId !== plan.sessionId) throw failure('EDITOR_CHANGED', 'Editor connection changed since planning'); };
      checkSession();
      const scopeArgs = { projectUuid: plan.projectUuid, pageUuid: plan.pageUuid };
      const snapshot = await this.snapshot(scopeArgs);
      if (hash({ snapshot, operations: plan.operations }) !== plan.fingerprint) throw failure('STALE_SNAPSHOT', 'Native schematic changed since planning; no edits were dispatched');
      checkSession();
      phase = 'backup';
      const native = await this.bridge.call('export_project', { projectUuid: plan.projectUuid });
      backup = await this.artifacts.download('native-backup', 'epro2', native);
      const intent = await this.artifacts.json('apply-intent', { planId, projectUuid: plan.projectUuid, pageUuid: plan.pageUuid, snapshotHash: plan.snapshotHash, fingerprint: plan.fingerprint, operations: plan.operations, backup });
      checkSession();
      this.bridge.assertWritable();
      phase = 'mutation';
      const result = await this.bridge.call('apply', { ...scopeArgs, expectedSnapshot: snapshot, operations: plan.operations });
      phase = 'result-log';
      const log = await this.artifacts.json('apply-result', { planId, backup, intent, result });
      if (!result || !Array.isArray(result.created) || result.snapshot?.projectUuid !== plan.projectUuid || result.snapshot?.pageUuid !== plan.pageUuid || !['parts', 'markers', 'wires', 'texts'].every(key => Array.isArray(result.snapshot?.[key])) || typeof result.netlist !== 'string') {
        this.bridge.markUncertain();
        throw failure('INVALID_APPLY_RESULT', 'Mutation returned an incomplete or differently scoped result; inspect editor and result log before further work', { artifact: log });
      }
      return { planId, backup, log, createdCount: result.created.length, created: result.created.slice(0, 50), snapshotHash: hash(result.snapshot) };
    } catch (error) {
      try { error.artifact = await this.artifacts.json('apply-failure', { planId, phase, backup: backup ?? null, error: errorInfo(error), bridge: this.bridge.status(), guidance: 'No rollback or automatic retry. Inspect the native project and backup; create a fresh plan only after reconciliation.' }); }
      catch (loggingError) { error.message += `; failure log unavailable: ${loggingError.message}`; }
      throw error;
    }
  }
}
