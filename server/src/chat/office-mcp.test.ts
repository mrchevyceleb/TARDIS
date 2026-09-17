import assert from 'node:assert/strict';
import { test } from 'node:test';
import { officeMcpConfig } from './office-mcp.ts';

test('private office remains opt-in and normalizes only the intended HTTPS endpoint', () => {
  assert.equal(officeMcpConfig({}),null);
  assert.deepEqual(officeMcpConfig({ TARDIS_OFFICE_MCP_URL:'https://office.example.test/mcp/', TARDIS_OFFICE_MCP_TOKEN:'synthetic-token' }), {base:'https://office.example.test',url:'https://office.example.test/mcp',token:'synthetic-token'});
  for (const url of ['http://office.example.test','https://user:secret@office.example.test','https://office.example.test/other','https://office.example.test/?token=secret']) {
    assert.throws(()=>officeMcpConfig({TARDIS_OFFICE_MCP_URL:url,TARDIS_OFFICE_MCP_TOKEN:'synthetic'}));
  }
  assert.throws(()=>officeMcpConfig({TARDIS_OFFICE_MCP_URL:'https://office.example.test'}));
});
