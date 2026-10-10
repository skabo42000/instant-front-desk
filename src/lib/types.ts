export type ModelMode = "fake" | "real";

// Only this small allowlist can be passed to the browser.
export interface ClientConfig {
  mode: ModelMode;
}

export interface Business {
  businessId: string;
  name: string;
  slug: string;
  sourceUrl: string;
}

export interface SourceChunk {
  businessId: string;
  id: string;
  pageUrl: string;
  heading: string;
  text: string;
}

export interface ModelRequest {
  businessId: string;
  question: string;
  sources: readonly SourceChunk[];
}

export interface ModelReply {
  text: string;
  citedChunkIds: string[];
}

export interface ModelAdapter {
  generate(request: ModelRequest): Promise<ModelReply>;
}
