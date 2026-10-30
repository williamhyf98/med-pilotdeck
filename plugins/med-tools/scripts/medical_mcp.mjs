// 医疗 sidecar MCP 客户端：medical_mcp.mjs <tools|call <toolName> [jsonArgs]>
// 用法:
//   node medical_mcp.mjs tools
//   node medical_mcp.mjs call medical-deep-search "{\"query\":\"...\"}"
import { randomUUID } from 'node:crypto';

const MCP_URL = 'http://127.0.0.1:8766/mcp';
const mode = process.argv[2];
const toolName = process.argv[3];
const argsRaw = process.argv[4] || '{}';

async function rpc(method, params) {
  const body = { jsonrpc: '2.0', id: randomUUID(), method, params };
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function main() {
  // initialize
  const init = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'pilotdeck-agent', version: '1.0.0' },
  });
  console.log('INIT', init.status, init.text.slice(0, 800));
  await rpc('notifications/initialized', {});

  if (mode === 'tools') {
    const list = await rpc('tools/list', {});
    console.log('TOOLS', list.status, list.text.slice(0, 6000));
  } else if (mode === 'call') {
    let args = {};
    try { args = JSON.parse(argsRaw); } catch { args = { query: argsRaw }; }
    const call = await rpc('tools/call', { name: toolName, arguments: args });
    console.log('CALL', call.status);
    console.log(call.text.slice(0, 12000));
  } else {
    console.log('用法: node medical_mcp.mjs tools | call <toolName> [jsonArgs]');
  }
}

main().catch(e => { console.error('ERROR', e.message); process.exit(1); });
