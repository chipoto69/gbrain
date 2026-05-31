#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import matter from 'gray-matter';

export interface CanaryPlan {
  brainRoot: string;
  filePath: string;
  relPath: string;
  slug: string;
  sourceHash: string;
  sourcePath: string;
  byteLength: number;
  content: string;
}

export interface BuildPlanOptions {
  brainRoot: string;
  filePath: string;
  slugPrefix?: string;
  now?: Date;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function normalizeSlugPart(part: string): string {
  return part
    .replace(/\.md$/i, '')
    .normalize('NFKD')
    .replace(/[^\w/-]+/g, '-')
    .replace(/_+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

export function deriveBrainSlug(relPath: string, slugPrefix = 'brain'): string {
  const parts = relPath.split(/[\\/]+/).map(normalizeSlugPart).filter(Boolean);
  const prefix = normalizeSlugPart(slugPrefix);
  if (!prefix) throw new Error('slugPrefix must contain at least one slug character');
  if (parts.length === 0) throw new Error(`cannot derive slug from ${relPath}`);
  return `${prefix}/${parts.join('/')}`;
}

function assertSafePath(brainRoot: string, filePath: string): { root: string; file: string; rel: string } {
  const root = realpathSync(resolve(brainRoot));
  const file = resolve(filePath);
  const realFile = realpathSync(file);
  const fileStat = lstatSync(file);
  if (fileStat.isSymbolicLink()) {
    throw new Error(`refusing symlink input: ${file}`);
  }
  if (!fileStat.isFile()) {
    throw new Error(`input is not a regular file: ${file}`);
  }
  const rel = relative(root, realFile);
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error(`input file must be inside brain root ${root}: ${file}`);
  }
  if (!rel.toLowerCase().endsWith('.md')) {
    throw new Error(`input file must be markdown: ${rel}`);
  }
  if (rel.split(/[\\/]+/).some((part) => part.startsWith('.'))) {
    throw new Error(`refusing hidden path segment in ${rel}`);
  }
  return { root, file: realFile, rel };
}

export function injectProvenance(content: string, opts: {
  relPath: string;
  sourceHash: string;
  syncedAt: string;
}): string {
  const parsed = matter(content);
  const fm = {
    ...(parsed.data ?? {}),
    source_kind: 'brain-md',
    source_path: opts.relPath,
    source_hash: opts.sourceHash,
    synced_at: opts.syncedAt,
  };
  return matter.stringify(parsed.content, fm);
}

export function buildCanaryPlan(opts: BuildPlanOptions): CanaryPlan {
  const checked = assertSafePath(opts.brainRoot, opts.filePath);
  const raw = readFileSync(checked.file, 'utf8');
  const sourceHash = sha256(raw);
  const sourcePath = checked.rel.split(sep).join('/');
  const content = injectProvenance(raw, {
    relPath: sourcePath,
    sourceHash,
    syncedAt: (opts.now ?? new Date()).toISOString(),
  });
  return {
    brainRoot: checked.root,
    filePath: checked.file,
    relPath: sourcePath,
    slug: deriveBrainSlug(sourcePath, opts.slugPrefix),
    sourceHash,
    sourcePath,
    byteLength: Buffer.byteLength(raw, 'utf8'),
    content,
  };
}

function runGbrain(args: string[], cwd: string): { ok: boolean; status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['run', 'src/cli.ts', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function firstSearchNeedle(content: string): string {
  const body = matter(content).content;
  const line = body
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length >= 24 && !l.startsWith('```'));
  const fallback = body.replace(/\s+/g, ' ').trim();
  return line ? line.slice(0, 96) : fallback.slice(0, 64);
}

export function executeCanary(plan: CanaryPlan, repoRoot: string): Record<string, unknown> {
  const tempDir = mkdtempSync(join(tmpdir(), 'gbrain-brain-canary-'));
  const tempFile = join(tempDir, `${plan.slug.split('/').pop()}.md`);
  writeFileSync(tempFile, plan.content);
  try {
    const write = runGbrain(['capture', '--file', tempFile, '--slug', plan.slug, '--json'], repoRoot);
    const get = runGbrain(['get', plan.slug], repoRoot);
    const chunks = runGbrain(['call', 'get_chunks', JSON.stringify({ slug: plan.slug })], repoRoot);
    const search = runGbrain(['search', firstSearchNeedle(plan.content)], repoRoot);
    return {
      slug: plan.slug,
      source_hash: plan.sourceHash,
      checks: {
        write: { ok: write.ok, status: write.status },
        get: { ok: get.ok && get.stdout.includes(plan.sourceHash), status: get.status },
        chunks: { ok: chunks.ok && chunks.stdout.includes('chunk'), status: chunks.status },
        search: { ok: search.ok && search.stdout.includes(plan.slug), status: search.status },
      },
      stdout: { write: write.stdout, get: get.stdout, chunks: chunks.stdout, search: search.stdout },
      stderr: { write: write.stderr, get: get.stderr, chunks: chunks.stderr, search: search.stderr },
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseCli(argv: string[]): { opts: BuildPlanOptions; execute: boolean; repoRoot: string } {
  let brainRoot = '/Users/rudlord/brain';
  let filePath = '';
  let slugPrefix = 'brain';
  let execute = false;
  let repoRoot = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--brain-root') brainRoot = argv[++i];
    else if (a === '--file') filePath = argv[++i];
    else if (a === '--slug-prefix') slugPrefix = argv[++i];
    else if (a === '--execute') execute = true;
    else if (a === '--repo-root') repoRoot = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: bun scripts/rudy/brain-md-canary.ts --file <brain-md> [--execute]

Builds a one-file ~/brain -> GBrain canary plan. Without --execute it only
prints the derived slug, source hash, and provenance-wrapped content preview.

Options:
  --brain-root PATH   Brain markdown repo root (default: /Users/rudlord/brain)
  --file PATH         Markdown file under brain root
  --slug-prefix NAME  Slug prefix for synced canon (default: brain)
  --execute           Write through gbrain capture and validate get/chunks/search
  --repo-root PATH    GBrain repo root for bun run src/cli.ts (default: cwd)`);
      process.exit(0);
    }
  }
  if (!filePath) throw new Error('--file is required');
  return { opts: { brainRoot, filePath, slugPrefix }, execute, repoRoot: resolve(repoRoot) };
}

if (import.meta.main) {
  try {
    const { opts, execute, repoRoot } = parseCli(process.argv.slice(2));
    const plan = buildCanaryPlan(opts);
    if (!execute) {
      const { content, ...safePlan } = plan;
      console.log(JSON.stringify({
        ...safePlan,
        content_preview: content.slice(0, 800),
        execute_hint: `bun scripts/rudy/brain-md-canary.ts --file ${plan.filePath} --execute`,
      }, null, 2));
    } else {
      console.log(JSON.stringify(executeCanary(plan, repoRoot), null, 2));
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
