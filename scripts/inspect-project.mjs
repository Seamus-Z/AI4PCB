import { readFile } from 'node:fs/promises';
import { inspectProject } from '../src/archive.mjs';
if (process.argv.length !== 3) {
  console.error('Usage: node scripts/inspect-project.mjs <project.epro2>');
  process.exitCode = 2;
} else {
  try { console.log(JSON.stringify(inspectProject(new Uint8Array(await readFile(process.argv[2]))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
