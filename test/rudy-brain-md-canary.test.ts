import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCanaryPlan,
  deriveBrainSlug,
  injectProvenance,
} from '../scripts/rudy/brain-md-canary.ts';
import { resolveSchemaEmbeddingDim } from '../src/core/embedding-dim-check.ts';

describe('rudy brain markdown canary', () => {
  test('derives brain-prefixed stable slugs', () => {
    expect(deriveBrainSlug('personal/agent2human-advice.md')).toBe('brain/personal/agent2human-advice');
    expect(deriveBrainSlug('Projects/Foo Bar.md', 'canon')).toBe('canon/projects/foo-bar');
  });

  test('injects provenance into existing frontmatter', () => {
    const content = `---\ntitle: Existing\ntags: [memory]\n---\n# Body\n`;
    const got = injectProvenance(content, {
      relPath: 'personal/agent2human-advice.md',
      sourceHash: 'abc123',
      syncedAt: '2026-05-31T00:00:00.000Z',
    });
    expect(got).toContain('title: Existing');
    expect(got).toContain('source_kind: brain-md');
    expect(got).toContain('source_path: personal/agent2human-advice.md');
    expect(got).toContain('source_hash: abc123');
  });

  test('rejects files outside brain root and hidden paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'brain-root-'));
    const outside = join(tmpdir(), `outside-${Date.now()}.md`);
    writeFileSync(outside, '# Outside\n');
    expect(() => buildCanaryPlan({ brainRoot: root, filePath: outside })).toThrow(/inside brain root/);

    mkdirSync(join(root, '.private'));
    const hidden = join(root, '.private', 'note.md');
    writeFileSync(hidden, '# Hidden\n');
    expect(() => buildCanaryPlan({ brainRoot: root, filePath: hidden })).toThrow(/hidden path/);
  });

  test('rejects symlink inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'brain-root-'));
    const target = join(root, 'target.md');
    const link = join(root, 'link.md');
    writeFileSync(target, '# Target\n');
    symlinkSync(target, link);
    expect(() => buildCanaryPlan({ brainRoot: root, filePath: link })).toThrow(/symlink/);
  });
});

describe('rudy 384-dim embedding compatibility', () => {
  test('accepts explicit dims for configured custom OpenAI-compatible models', () => {
    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'openai:all-MiniLM-L6-v2',
      embedding_dimensions: 384,
    });
    expect(got).toEqual({
      ok: true,
      dim: 384,
      model: 'openai:all-MiniLM-L6-v2',
      provider: 'openai',
      recipeDefault: 1536,
    });
  });

  test('requires explicit dims for custom OpenAI-compatible models', () => {
    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'openai:all-MiniLM-L6-v2',
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain('requires explicit embedding_dimensions');
  });

  test('keeps ada-002 fixed at 1536 dimensions', () => {
    expect(resolveSchemaEmbeddingDim({
      embedding_model: 'openai:text-embedding-ada-002',
    })).toEqual({
      ok: true,
      dim: 1536,
      model: 'openai:text-embedding-ada-002',
      provider: 'openai',
      recipeDefault: 1536,
    });

    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'openai:text-embedding-ada-002',
      embedding_dimensions: 384,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain('fixed 1536-dimensional vectors');
  });
});
