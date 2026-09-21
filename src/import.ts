import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import type { LegacyItemRow } from './store.ts';

const IMAGE_REF = /(?:\.claude\/testing\/)?images\/[^\s)`"']+/g;
const IMAGE_PREFIX = /^(?:\.claude\/testing\/)?images\//;

export interface ImageMatch { path: string; files: string[]; }
export interface ImportPlan {
  rows: readonly (LegacyItemRow & { projectId: number })[];
  matches: readonly ImageMatch[];
  skipped: string[];
}

export function findImageRefs(details: string): string[] {
  return [...details.matchAll(IMAGE_REF)].map((match) => match[0].replace(/[.,;:!?]+$/, ''));
}

export function resolveImageRefs(refs: readonly string[], imagesDir: string): ImageMatch[] {
  const root = resolve(imagesDir);
  const matches: ImageMatch[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const path = ref.replace(IMAGE_PREFIX, '');
    const clean = path.replace(/\/$/, '');
    const absolute = resolve(root, clean);
    if (!inside(root, absolute) || clean === '' || clean.split('/').includes('..')) continue;
    const files = resolveReference(clean, absolute).filter((file) => {
      if (seen.has(file)) return false;
      seen.add(file);
      return true;
    });
    matches.push({ path: ref, files });
  }
  return matches;
}

export function planImport(rows: readonly LegacyItemRow[], projectId: number, imagesDir?: string): ImportPlan {
  const imported = rows.map((row) => ({ ...row, projectId }));
  const refs = new Set<string>();
  for (const row of rows) for (const ref of findImageRefs(row.details)) refs.add(ref);
  const matches = imagesDir === undefined ? [] : resolveImageRefs([...refs], imagesDir);
  const attached = new Set(matches.flatMap((match) => match.files));
  const skipped = listPngs(imagesDir).filter((file) => !attached.has(file));
  return { rows: imported, matches, skipped };
}

function resolveReference(path: string, absolute: string): string[] {
  if (path.includes('*')) {
    const directory = dirname(absolute);
    const pattern = basename(path);
    if (!isDirectory(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.png') && wildcard(pattern, entry.name))
      .sort((a, b) => a.name.localeCompare(b.name)).map((entry) => join(directory, entry.name));
  }
  if (isDirectory(absolute)) {
    return readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
      .sort((a, b) => a.name.localeCompare(b.name)).map((entry) => join(absolute, entry.name));
  }
  return isFile(absolute) ? [absolute] : [];
}

function listPngs(imagesDir: string | undefined): string[] {
  return imagesDir === undefined || !isDirectory(imagesDir) ? [] : walk(resolve(imagesDir));
}

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.png') files.push(path);
  }
  return files;
}

function wildcard(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`);
}
function isDirectory(path: string): boolean { try { return statSync(path).isDirectory(); } catch { return false; } }
function isFile(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }
