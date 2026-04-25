import fs from 'node:fs/promises';
for (const dir of ['dist', 'release', 'coverage']) {
  await fs.rm(new URL(`../${dir}`, import.meta.url), { recursive: true, force: true });
}
