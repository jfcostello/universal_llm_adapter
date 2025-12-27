export type ContentPart = {
  type: string;
  [key: string]: any;
};

export type Message = {
  role: string;
  content: ContentPart[];
  [key: string]: any;
};

export type LLMResponse = {
  provider?: string;
  model?: string;
  role?: string;
  content?: ContentPart[];
  toolCalls?: any[];
  finishReason?: string;
  raw?: any;
  usage?: any;
  [key: string]: any;
};

