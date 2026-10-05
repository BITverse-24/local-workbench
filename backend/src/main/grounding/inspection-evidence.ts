export interface FusedFinding {
  findingId: string;
  title: string;
  value: string;
  sourceFile: string;
  page: number;
  confidence: "high" | "medium" | "low";
  evidence: string;
  pageReferenceIds: string[];
}

export interface HandwrittenAnnotation {
  text: string;
  sourceFile: string;
  page: number;
  confidence?: string;
  flag?: string;
}

