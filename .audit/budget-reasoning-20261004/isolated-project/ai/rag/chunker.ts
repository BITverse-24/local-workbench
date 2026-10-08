import { ChunkRecord, DocumentRecord } from "./types.js";

// Helper to roughly estimate tokens (1 token ~= 4 characters as a rule of thumb)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const MAX_CHUNK_TOKENS = 350;

function detectSectionHeader(firstLine: string): { label: string; title: string } | null {
  const line = firstLine.trim();

  // Explicit bracketed syntax: e.g. ## [section:4.2] Isolation valve rating or ## [Clause 4.2]
  const bracketMatch = line.match(/^#{1,6}\s*\[\s*(?:(?:section|clause)\s*:?\s*)?([0-9A-Za-z._-]+)\s*\]\s*(.*)$/i);
  if (bracketMatch) {
    const label = bracketMatch[1];
    const rawTitle = bracketMatch[2]?.trim() || `Section ${label}`;
    return { label, title: rawTitle };
  }

  // Markdown heading: e.g. # Section 1: Scope, ## 2.1 Materials, # Overview
  const mdMatch = line.match(/^#{1,6}\s*(?:(?:Section|Clause)\s*)?(\d+(?:\.\d+)*|[A-Z]\b|[A-Z]-\d+)?[:.\s-]*(.*)$/i);
  if (mdMatch) {
    const rawTitle = mdMatch[2]?.trim() || line.replace(/^#{1,6}\s*/, "").trim();
    const label = mdMatch[1] || (rawTitle ? rawTitle.toLowerCase().replace(/[^\w]+/g, "-").slice(0, 30) : "section");
    const title = rawTitle || `Section ${label}`;
    return { label, title };
  }

  // Explicit Section / Clause: e.g. Section 2.1: Materials, Clause 4 - Testing
  const explicitMatch = line.match(/^(?:Section|Clause|Item|Article)\s+(\d+(?:\.\d+)*|[A-Z]\b|[A-Z]-\d+)\b[:.\s-]*(.*)$/i);
  if (explicitMatch) {
    const label = explicitMatch[1];
    const title = explicitMatch[2]?.trim() || `Section ${label}`;
    return { label, title };
  }

  // Numbered hierarchical section: e.g. 1.1 Scope, 2.3.1 Hydrostatic Test
  const numberedMatch = line.match(/^(\d+\.\d+(?:\.\d+)*)\b[:.\s-]*(.*)$/);
  if (numberedMatch) {
    const label = numberedMatch[1];
    const title = numberedMatch[2]?.trim() || `Section ${label}`;
    return { label, title };
  }

  return null;
}

function splitLargeParagraph(text: string, maxTokens: number = MAX_CHUNK_TOKENS): string[] {
  if (estimateTokens(text) <= maxTokens) {
    return [text];
  }

  const sentenceRegex = /(?<=[.?!;])\s+(?=[A-Z0-9])/g;
  const sentences = text.split(sentenceRegex);
  const result: string[] = [];
  let current = "";

  for (const s of sentences) {
    const candidate = current ? `${current} ${s}` : s;
    if (estimateTokens(candidate) > maxTokens && current) {
      result.push(current.trim());
      current = s;
    } else {
      current = candidate;
    }
  }

  if (current) {
    result.push(current.trim());
  }

  // If a single unit was still oversized (e.g. continuous log/code without punctuation), slice by character window
  const finalChunks: string[] = [];
  for (const chunk of result) {
    if (estimateTokens(chunk) > maxTokens * 1.5) {
      const maxChars = maxTokens * 4;
      for (let i = 0; i < chunk.length; i += maxChars - 100) {
        finalChunks.push(chunk.slice(i, i + maxChars).trim());
      }
    } else {
      finalChunks.push(chunk);
    }
  }

  return finalChunks.filter((c) => c.length > 0);
}

// PERF OPTIMIZATION: Bounded LRU cache for document chunking.
const CHUNKER_CACHE_MAX_SIZE = 100;
const chunkerCache = new Map<string, Omit<ChunkRecord, "embedding">[]>();

export function clearChunkerCache(): void {
  chunkerCache.clear();
}

function fnv1a32String(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function chunkDocument(doc: DocumentRecord, text: string, pageNumber: number): Omit<ChunkRecord, "embedding">[] {
  if (!text || !text.trim()) {
    return [];
  }

  const cacheKey = `${doc.doc_id}:${pageNumber}:${fnv1a32String(text)}`;
  const cached = chunkerCache.get(cacheKey);
  if (cached) {
    chunkerCache.delete(cacheKey);
    chunkerCache.set(cacheKey, cached);
    return cached.map((c) => ({ ...c }));
  }

  const result = computeChunkDocument(doc, text, pageNumber);

  if (chunkerCache.size >= CHUNKER_CACHE_MAX_SIZE) {
    const firstKey = chunkerCache.keys().next().value;
    if (firstKey !== undefined) chunkerCache.delete(firstKey);
  }
  chunkerCache.set(cacheKey, result);

  return result.map((c) => ({ ...c }));
}

function computeChunkDocument(doc: DocumentRecord, text: string, pageNumber: number): Omit<ChunkRecord, "embedding">[] {
  const chunks: Omit<ChunkRecord, "embedding">[] = [];

  // Split into paragraphs first
  const rawParagraphs = text.split(/\n\s*\n/);
  const paragraphs: string[] = [];

  for (const raw of rawParagraphs) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Subdivide any oversized paragraphs
    const subs = splitLargeParagraph(trimmed, MAX_CHUNK_TOKENS);
    paragraphs.push(...subs);
  }

  let currentSectionLabel = "unknown";
  let currentSectionTitle = "";
  let currentText = "";

  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (!trimmed) continue;

    const firstLine = trimmed.split("\n")[0];
    const headerMatch = detectSectionHeader(firstLine);

    if (headerMatch) {
      // Save previously accumulated text if any
      if (currentText) {
        chunks.push({
          chunk_id: `${doc.doc_id}-p${pageNumber}-c${currentSectionLabel}-${chunks.length + 1}`,
          doc_id: doc.doc_id,
          section_label: currentSectionLabel,
          section_title: currentSectionTitle,
          text: currentText.trim(),
          page: pageNumber,
        });
        currentText = "";
      }

      currentSectionLabel = headerMatch.label;
      currentSectionTitle = headerMatch.title;
      currentText = trimmed;
    } else {
      // Append to current text, checking if we exceed MAX_CHUNK_TOKENS
      const newText = currentText ? `${currentText}\n\n${trimmed}` : trimmed;
      if (estimateTokens(newText) > MAX_CHUNK_TOKENS && currentText) {
        chunks.push({
          chunk_id: `${doc.doc_id}-p${pageNumber}-c${currentSectionLabel}-${chunks.length + 1}`,
          doc_id: doc.doc_id,
          section_label: currentSectionLabel,
          section_title: currentSectionTitle,
          text: currentText.trim(),
          page: pageNumber,
        });
        currentText = trimmed;
      } else {
        currentText = newText;
      }
    }
  }

  // Push remaining text
  if (currentText) {
    chunks.push({
      chunk_id: `${doc.doc_id}-p${pageNumber}-c${currentSectionLabel}-${chunks.length + 1}`,
      doc_id: doc.doc_id,
      section_label: currentSectionLabel,
      section_title: currentSectionTitle,
      text: currentText.trim(),
      page: pageNumber,
    });
  }

  return chunks;
}
