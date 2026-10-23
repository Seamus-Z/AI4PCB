import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { inspectProject, parseEpru } from '../src/archive.mjs';
const row = (header, value) => JSON.stringify(header) + '||' + (value === undefined ? '' : JSON.stringify(value)) + '|\n';
const head = (uuid, docType = 'SCH_PAGE') => row({ type: 'DOCHEAD' }, { uuid, docType });

test('epru repeated document headers update records instead of duplicating old graphics', () => {
  const text = head('page') + row({ type: 'TEXT', id: 't' }, { content: 'old' }) + head('page') + row({ type: 'TEXT', id: 't' }, { content: 'new || label' });
  const docs = parseEpru(text);
  assert.equal(docs.length, 1);
  assert.deepEqual(docs[0].records.map(r => r.value.content), ['new || label']);
});
test('empty/null tombstones and deleted documents never appear as active schematic content', () => {
  const text = head('a') + row({ type: 'TEXT', id: 't' }, { content: 'remove' }) + row({ type: 'TEXT', id: 't' }, undefined) + row({ type: 'CANVAS' }, { width: 1 }) + head('b') + row({ type: 'DELETE_DOC' }, { deleted: true });
  const docs = parseEpru(text);
  assert.deepEqual(docs.map(d => d.head.uuid), ['a']);
  assert.deepEqual(docs[0].records.map(r => r.header.type), ['CANVAS']);
});
test('native archive inspection counts actual document types and real NC attributes without extraction', () => {
  const text = head('a') + row({ type: 'ATTR', id: 'nc' }, { key: 'NO_CONNECT', value: 'yes' }) + head('symbol', 'SYMBOL') + row({ type: 'PIN', id: '1' }, { number: '1' });
  const archive = zipSync({ 'project2.json': strToU8('{}'), 'design.epru': strToU8(text) });
  const result = inspectProject(archive);
  assert.deepEqual(result.documentTypes, { SCH_PAGE: 1, SYMBOL: 1 });
  assert.equal(result.pages[0].ncAttributes, 1);
  assert.equal(result.extractedToDisk, false);
  assert.equal(result.electricalValidityProven, false);
});
test('non-project archives and malformed epru fail rather than report a clean empty project', () => {
  assert.throws(() => inspectProject(zipSync({ 'other.txt': strToU8('x') })), /project2/);
  assert.throws(() => parseEpru('not a native record'), /Invalid/);
  assert.throws(() => parseEpru(''), /No epru/);
});
