export interface AttachmentReference {
  attachmentId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  relativePath: string;
}

export interface InputFileReference {
  attachmentId: string;
  filename: string;
  mediaType: string;
  columns?: string[];
  rowCount?: number;
}
