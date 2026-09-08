import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RetrievedKnowledgeChunk } from "../../shared/contracts.js";

type ManifestSection = {
  sectionId: string;
  label: string;
  heading: string;
  excerpt: string;
  keywords: string[];
  chromaMetadata: {
    documentId: string;
    sectionId: string;
    label: string;
    documentTitle: string;
  };
};

type ManifestDocument = {
  documentId: string;
  title: string;
  sections: ManifestSection[];
};

type CorpusManifest = {
  embedding: { model: string; dimensions: number; distanceMetric: string; normalizeEmbeddings: boolean };
  documents: ManifestDocument[];
};

let cachedManifest: CorpusManifest | null | undefined;

function resolveManifestPath(): string | null {
  const candidates = [
    path.join(process.cwd(), "demo-fixtures", "rag-corpus", "corpus-manifest.json"),
    path.resolve(process.cwd(), "..", "demo-fixtures", "rag-corpus", "corpus-manifest.json"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

function loadManifest(): CorpusManifest | null {
  if (cachedManifest !== undefined) return cachedManifest;
  const manifestPath = resolveManifestPath();
  if (!manifestPath) {
    cachedManifest = null;
    return null;
  }
  try {
    const raw = readFileSync(manifestPath, "utf8");
    cachedManifest = JSON.parse(raw) as CorpusManifest;
    return cachedManifest;
  } catch {
    cachedManifest = null;
    return null;
  }
}

export function clearCache(): void {
  cachedManifest = undefined;
}

export function searchKnowledge(query: string, topK = 5): RetrievedKnowledgeChunk[] {
  const manifest = loadManifest();
  if (!manifest) return [];

  const lower = query.toLowerCase();
  const hyphenated = lower.match(/[a-z0-9]+-[a-z0-9]+/g) ?? [];
  const splitTerms = lower.split(/\W+/).filter(Boolean);
  const terms = [...new Set([...splitTerms, ...hyphenated])];
  if (terms.length === 0) return [];

  const termSet = new Set(terms);
  const hasCritical = terms.some((t) => ["tube-wall", "pitting", "gasket"].includes(t));

  const chunks: RetrievedKnowledgeChunk[] = [];
  for (const doc of manifest.documents) {
    for (const section of doc.sections) {
      const keywordsLower = section.keywords.map((k) => k.toLowerCase());
      const keywordsSet = new Set(keywordsLower);
      const excerptLower = section.excerpt.toLowerCase();
      const labelLower = section.label.toLowerCase();

      let keywordOverlap = 0;
      let excerptOverlap = 0;
      for (const t of termSet) {
        if (keywordsSet.has(t)) keywordOverlap++;
        if (excerptLower.includes(t)) excerptOverlap++;
      }

      let score = keywordOverlap * 2 + excerptOverlap * 1;

      // Bonus: approval criteria section when query contains critical defects
      if (hasCritical && labelLower.includes("approval criteria")) score += 3;
      if (labelLower.includes("approval criteria") && termSet.has("approval")) score += 1;

      // Template boost: approval-note template is relevant for any inspection/approval query
      if (doc.documentId === "TPL-012") {
        if (termSet.has("approval") || termSet.has("inspection") || termSet.has("report") || hasCritical) score += 2;
        if (section.sectionId === "equipment-header") score += 1;
      }

      if (score === 0) continue;

      // Normalize to prefer precise matches (shorter keyword sets)
      const normalized = score / Math.sqrt(keywordsLower.length);

      chunks.push({
        chunkId: `${doc.documentId}:${section.sectionId}`,
        documentId: doc.documentId,
        sectionId: section.sectionId,
        label: `${doc.documentId} §${section.sectionId}`,
        documentTitle: doc.title,
        excerpt: section.excerpt,
        score: normalized,
      });
    }
  }

  return chunks.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, topK);
}
