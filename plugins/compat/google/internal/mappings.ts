export type GooglePart = {
  text?: string;
  fileData?: { fileUri: string; mimeType?: string };
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name?: string; args?: any };
  functionResponse?: { name?: string; response?: any };
  // Allow extra Google SDK fields (e.g., thoughtSignature) without widening call sites.
  [key: string]: any;
};

export type GoogleContent = {
  role: 'user' | 'model';
  parts: GooglePart[];
};

