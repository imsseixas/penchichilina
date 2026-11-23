// Persistência simples em arquivos JSON dentro de data/, com escrita atômica.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export async function readJson(name, fallback) {
  try {
    return JSON.parse(await readFile(join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

const pending = new Map(); // name -> promise, para serializar escritas no mesmo arquivo

export function writeJson(name, data) {
  const prev = pending.get(name) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      await mkdir(DATA_DIR, { recursive: true });
      const file = join(DATA_DIR, name);
      await writeFile(file + '.tmp', JSON.stringify(data));
      await rename(file + '.tmp', file);
    });
  pending.set(name, next);
  return next;
}
