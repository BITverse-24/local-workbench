import { ChunkRecord, DocumentRecord } from "./types.js";

// Helper to roughly estimate tokens (1 token ~= 4 characters as a rule of thumb)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Split on section headers like "1.1", "Clause 2", "Section 3"
const SECTION_REGEX = /^(?:Section|Clause)?\s*(\d+(?:\.\d+)*)\b/im;

export function chunkDocument(doc: DocumentRecord, text: string, pageNumber: number): Omit<ChunkRecord, "embedding">[] {
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
