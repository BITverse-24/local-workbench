import { ChunkRecord, DocumentRecord } from "./types.js";

// Helper to roughly estimate tokens (1 token ~= 4 characters as a rule of thumb)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Split on section headers like "1.1", "Clause 2", "Section 3"
const SECTION_REGEX = /^(?:Section|Clause)?\s*(\d+(?:\.\d+)*)\b/im;

// PERF OPTIMIZATION: Bounded LRU cache for document chunking.
// Prevents redundant paragraph splitting, regex matching, and token estimation loops for identical document pages.
const CHUNKER_CACHE_MAX_SIZE = 100;
const chunkerCache = new Map<string, Omit<ChunkRecord, "embedding">[]>();

function fnv1a32String(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function chunkDocument(doc: DocumentRecord, text: string, pageNumber: number): Omit<ChunkRecord, "embedding">[] {
  const cacheKey = `${doc.doc_id}:${pageNumber}:${fnv1a32String(text)}`;
  const cached = chunkerCache.get(cacheKey);
  if (cached) {
    // Refresh position for true LRU eviction
    chunkerCache.delete(cacheKey);
    chunkerCache.set(cacheKey, cached);
    // Deep clone chunks so downstream mutations do not affect cached objects
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
  const paragraphs = text.split(/\n\s*\n/);

  let currentSectionLabel = "unknown";
  let currentSectionTitle = "";
  let currentText = "";

  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (!trimmed) continue;

    const match = SECTION_REGEX.exec(trimmed);
    if (match) {
      // If we have accumulated text, save it as a chunk
      if (currentText) {
        chunks.push({
          chunk_id: `${doc.doc_id}-c${currentSectionLabel}-p${chunks.length + 1}`,
          doc_id: doc.doc_id,
          section_label: currentSectionLabel,
          section_title: currentSectionTitle,
          text: currentText.trim(),
          page: pageNumber,
        });
        currentText = "";
      }

      currentSectionLabel = match[1];
      // Try to extract the title from the rest of the line
      const lines = trimmed.split("\n");
      const titleMatch = lines[0].replace(match[0], "").trim();
      currentSectionTitle = titleMatch || `Section ${currentSectionLabel}`;

      currentText = trimmed;
    } else {
      // Append to current text, checking if we exceed ~300 tokens
      const newText = currentText ? `${currentText}\n\n${trimmed}` : trimmed;
      if (estimateTokens(newText) > 300 && currentText) {
        chunks.push({
          chunk_id: `${doc.doc_id}-c${currentSectionLabel}-p${chunks.length + 1}`,
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
      chunk_id: `${doc.doc_id}-c${currentSectionLabel}-p${chunks.length + 1}`,
      doc_id: doc.doc_id,
      section_label: currentSectionLabel,
      section_title: currentSectionTitle,
      text: currentText.trim(),
      page: pageNumber,
    });
  }

  return chunks;
}
