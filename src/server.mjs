import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EditorBridge } from './bridge.mjs';
import { ToolkitTools, TOOL_DEFINITIONS } from './tools.mjs';

function integerSetting(value, fallback, name, min, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return number;
}

export function loadConfig(env = process.env) {
  const token = env.JLCEDA_BRIDGE_TOKEN;
  if (typeof token !== 'string' || token.length < 32) throw new Error('JLCEDA_BRIDGE_TOKEN is required and must contain at least 32 characters');
  if (env.JLCEDA_ENABLE_WRITES !== undefined && !['0', '1'].includes(env.JLCEDA_ENABLE_WRITES)) throw new Error('JLCEDA_ENABLE_WRITES must be 0 or 1');
  if (env.JLCEDA_OUTPUT_DIR !== undefined && !env.JLCEDA_OUTPUT_DIR.trim()) throw new Error('JLCEDA_OUTPUT_DIR must not be empty');
  return {
    token,
    port: integerSetting(env.JLCEDA_BRIDGE_PORT, 49831, 'JLCEDA_BRIDGE_PORT', 1, 65535),
    timeoutMs: integerSetting(env.JLCEDA_REQUEST_TIMEOUT_MS, 30000, 'JLCEDA_REQUEST_TIMEOUT_MS', 1, 3600000),
    trustedOrigins: (env.JLCEDA_TRUSTED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean),
    enableWrites: env.JLCEDA_ENABLE_WRITES === '1',
    outputDir: env.JLCEDA_OUTPUT_DIR ?? './outputs',
  };
}

export function createMcpServer(tools) {
  const server = new Server({ name: 'jlceda-schematic-toolkit', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async request => tools.call(request.params.name, request.params.arguments ?? {}));
  return server;
}

export async function startServer(config = loadConfig(), transport = new StdioServerTransport()) {
  const bridge = new EditorBridge(config);
  let server;
  try {
    const address = await bridge.start();
    const tools = new ToolkitTools({ bridge, enableWrites: config.enableWrites, outputDir: config.outputDir });
    server = createMcpServer(tools);
    const close = async () => { await bridge.close(); await server.close(); };
    // A closed stdio transport must not leave a listening bridge process behind.
    server.onclose = () => { void bridge.close(); };
    await server.connect(transport);
    process.stderr.write(`JLCEDA bridge listening on 127.0.0.1:${address.port}; writes ${config.enableWrites ? 'enabled' : 'disabled'}\n`);
    return { server, bridge, tools, close };
  } catch (error) {
    await bridge.close();
    if (server) await server.close();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const runtime = await startServer();
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void runtime.close().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    process.stderr.write(`JLCEDA startup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
