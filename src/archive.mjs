import { unzipSync, strFromU8 } from 'fflate';

/** Read JLCEDA's append-only epru records; never rewrite electrical records. */
export function parseEpru(text) {
  const documents = new Map();
  let document;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const separator = line.indexOf('||');
    if (separator < 0) throw Error('Invalid epru record at line ' + (index + 1));
    const header = JSON.parse(line.slice(0, separator));
    const payload = line.slice(separator + 2).replace(/\|+$/, '');
    const value = payload ? JSON.parse(payload) : null;
    if (header.type === 'DOCHEAD') {
      if (!value?.uuid || !value.docType) throw Error('Invalid document header');
      const key = value.docType + '#' + value.uuid;
      if (!documents.has(key)) documents.set(key, { head: value, records: new Map() });
      document = documents.get(key);
      document.head = value;
    } else {
      if (!document || typeof header.type !== 'string') throw Error('Unscoped epru record at line ' + (index + 1));
      const key = header.type + '#' + header.id;
      if (value === null) document.records.delete(key);
      else document.records.set(key, { header, value });
    }
  }
  if (!documents.size) throw Error('No epru documents found');
  return [...documents.values()].map(d => ({ head: d.head, records: [...d.records.values()] })).filter(d => !d.records.some(r => r.header.type === 'DELETE_DOC'));
}

export function inspectProject(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 256 * 1024 * 1024) throw Error('Expected epro2 ZIP up to 256 MiB');
  let total = 0;
  const files = unzipSync(bytes, { filter(file) {
    total += file.originalSize;
    if (total > 512 * 1024 * 1024) throw Error('Uncompressed archive exceeds 512 MiB');
    if (file.name.split(/[\\/]/).includes('..') || /^[\\/]/.test(file.name)) throw Error('Unsafe archive member path');
    return file.name === 'project2.json' || file.name.endsWith('.epru');
  } });
  if (!files['project2.json']) throw Error('Not a supported epro2: project2.json missing');
  const project = JSON.parse(strFromU8(files['project2.json']));
  const sources = Object.keys(files).filter(name => name.endsWith('.epru'));
  if (!sources.length) throw Error('No native epru source in archive');
  const documents = sources.flatMap(name => parseEpru(strFromU8(files[name])));
  const types = {};
  for (const d of documents) types[d.head.docType] = (types[d.head.docType] || 0) + 1;
  const pages = documents.filter(d => d.head.docType === 'SCH_PAGE').map(d => {
    const records = {};
    for (const r of d.records) records[r.header.type] = (records[r.header.type] || 0) + 1;
    return { uuid: d.head.uuid, records, ncAttributes: d.records.filter(r => r.header.type === 'ATTR' && r.value.key === 'NO_CONNECT' && r.value.value === 'yes').length };
  });
  return { project, sources, documentTypes: types, pages, extractedToDisk: false, electricalValidityProven: false };
}
