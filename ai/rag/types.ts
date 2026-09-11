export interface DocumentRecord {
  doc_id: string;
  title: string;
  source_path: string;
  doc_type: string;
  department: string;
  effective_date: string;
  indexed_at: string;
  page_count: number;
  ocr_used: boolean;
}

export interface ChunkRecord {
  chunk_id: string;
  doc_id: string;
  section_label: string;
  section_title: string;
  text: string;
  page: number;
  embedding?: number[];
}

export interface RetrievalResult {
  chunk_id: string;
  text: string;
  doc_id: string;
  section_label: string;
  page: number;
  score: number;
}

export interface EmbeddingConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}
