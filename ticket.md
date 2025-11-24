# File Support Implementation Plan

## Table of Contents
1. [Overview](#overview)
2. [Current Architecture](#current-architecture)
3. [Provider-Specific File Handling](#provider-specific-file-handling)
4. [Universal File Type Design](#universal-file-type-design)
5. [File Loading System](#file-loading-system)
6. [Compat Module Transformations](#compat-module-transformations)
7. [Implementation Steps](#implementation-steps)
8. [Testing Strategy](#testing-strategy)
9. [Usage Examples](#usage-examples)
10. [Edge Cases & Error Handling](#edge-cases--error-handling)

---

## Overview

### Goal
Add universal file support to the LLM coordinator, allowing users to pass file paths in messages. The system will:
1. Accept file paths from users
2. Load and read files from disk
3. Detect MIME types automatically
4. Convert files to base64
5. Transform to provider-specific formats via compat modules
6. Support all file types (PDFs, CSVs, TXT, images, etc.)

### Design Philosophy
- **Universal Input**: Users provide file paths in a consistent format
- **Automatic Handling**: System handles loading, MIME detection, and encoding
- **Provider Abstraction**: Compat modules transform to provider-specific formats
- **Permissive Validation**: Let provider APIs reject unsupported files
- **Modular Architecture**: Reusable utilities, minimal coupling

---

## Current Architecture

### Type System (`core/types.ts`)

**Current ContentPart Union:**
```typescript
export type ContentPart = TextContent | ImageContent | ToolResultContent;
```

**Message Structure:**
```typescript
export interface Message {
  role: Role;
  content: ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  reasoning?: string;
}
```

**Existing Image Handling:**
```typescript
export interface ImageContent {
  type: 'image';
  imageUrl: string;
  mimeType?: string;
}
```

### Message Flow
1. User creates `LLMCallSpec` with `Message[]`
2. `LLMCoordinator` receives messages
3. `LLMManager` routes to appropriate provider
4. `ICompatModule` serializes messages to provider format
5. Provider API processes and returns response
6. `ICompatModule` parses response back to universal format

### Compat Module Interface (`plugins/compat/interface.ts`)

```typescript
export interface ICompatModule {
  // HTTP-based providers
  buildPayload?(spec: LLMCallSpec, settings: ProviderSettings): any;
  parseResponse?(response: any): LLMResponse;
  parseStreamChunk?(chunk: string): StreamChunk | null;

  // SDK-based providers
  callSDK?(spec: LLMCallSpec, settings: ProviderSettings): Promise<LLMResponse>;
  streamSDK?(spec: LLMCallSpec, settings: ProviderSettings): AsyncGenerator<StreamChunk>;
}
```

---

## Provider-Specific File Handling

### 1. Google Gemini

**API Approach:** Inline data in content parts array

**Format:**
```javascript
{
  inlineData: {
    mimeType: 'application/pdf',
    data: 'base64EncodedString'  // NO data URL prefix
  }
}
```

**Usage in Message:**
```javascript
const contents = [
  { text: "Summarize this document" },
  {
    inlineData: {
      mimeType: 'application/pdf',
      data: Buffer.from(pdfBytes).toString("base64")
    }
  }
];

const response = await ai.models.generateContent({
  model: "gemini-2.5-flash",
  contents: contents
});
```

**Key Details:**
- Base64 string is RAW (no `data:application/pdf;base64,` prefix)
- Goes in the `contents` array alongside text
- SDK method: `ai.models.generateContent()`
- Uses Buffer for file reading: `Buffer.from(fs.readFileSync(path)).toString("base64")`

**Supported File Types:** PDFs, images, audio, video (API will reject unsupported)

**Constraints:**
- Max file size: 50MB
- Max pages per PDF: 1000
- Total pages across all PDFs in request: 1000

---

### 2. OpenAI Chat Completions

**API Approach:** File content blocks in message content array

**Format (Base64):**
```javascript
{
  type: "file",
  file: {
    filename: "document.pdf",
    file_data: "data:application/pdf;base64,base64EncodedString"  // WITH data URL prefix
  }
}
```

**Format (File ID):**
```javascript
{
  type: "file",
  file: {
    file_id: "file-6F2ksmvXxt4VdoqmHRw6kL"
  }
}
```

**Usage in Message:**
```javascript
const data = fs.readFileSync("document.pdf");
const base64String = data.toString("base64");

const completion = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [
    {
      role: "user",
      content: [
        {
          type: "file",
          file: {
            filename: "document.pdf",
            file_data: `data:application/pdf;base64,${base64String}`
          }
        },
        {
          type: "text",
          text: "What is in this document?"
        }
      ]
    }
  ]
});
```

**Key Details:**
- Base64 requires data URL format: `data:${mimeType};base64,${base64String}`
- The `filename` field is required for base64 uploads
- Can also reference uploaded file IDs
- SDK method: `client.chat.completions.create()`

**Supported File Types:** PDFs (requires vision models like gpt-4o, gpt-4o-mini, o1)

**Constraints:**
- Max file size: 50MB per file
- Total content limit: 50MB across all files per request
- Max pages per PDF: 100

**File Upload (Optional):**
```javascript
const file = await client.files.create({
  file: fs.createReadStream("document.pdf"),
  purpose: "user_data"
});

// Then use file.id in messages
```

---

### 3. OpenAI Responses API

**API Approach:** Same as Chat Completions but via SDK-only interface

**Format:** Identical to Chat Completions API
```javascript
{
  type: "file",
  file: {
    filename: "document.pdf",
    file_data: "data:application/pdf;base64,..."
  }
}
```

**Usage:**
```javascript
// Uses same format as Chat Completions
const response = await client.responses.create({
  model: "gpt-4o",
  messages: [/* same structure as above */]
});
```

**Key Details:**
- SDK-based implementation (uses `callSDK()` in compat module)
- Same constraints as Chat Completions
- No HTTP buildPayload/parseResponse methods

---

### 4. Anthropic Claude

**API Approach:** Document content blocks

**Format (URL):**
```json
{
  "type": "document",
  "source": {
    "type": "url",
    "url": "https://example.com/document.pdf"
  }
}
```

**Format (Base64):**
```json
{
  "type": "document",
  "source": {
    "type": "base64",
    "media_type": "application/pdf",
    "data": "base64EncodedString"
  }
}
```

**Key Details:**
- Base64 string is RAW (no data URL prefix)
- Requires `media_type` field in base64 source
- Can use URLs, base64, or file IDs
- Supports prompt caching via `cache_control` field

**Constraints:**
- Max request size: 32MB
- Max pages per PDF: 100
- No encrypted/password-protected PDFs

---

### 5. OpenRouter (OpenAI Compatible)

**API Approach:** OpenAI-compatible format

**Format:**
```json
{
  "type": "file",
  "file": {
    "filename": "document.pdf",
    "file_data": "https://example.com/file.pdf"
  }
}
```

**Key Details:**
- Accepts both URLs and base64 data URLs
- Supports `plugins` parameter for processing options:
  - `pdf-text`: Free text extraction
  - `mistral-ocr`: OCR for scanned docs ($0.01/1000 pages)
  - `native`: Use model's built-in processing
- Can reuse file annotations from previous responses

---

## Universal File Type Design

### DocumentContent Type

Add to `core/types.ts`:

```typescript
/**
 * Represents a document/file to be processed by the LLM.
 * Users provide file paths; the system loads, encodes, and transforms them.
 */
export interface DocumentContent {
  type: 'document';

  /**
   * Source of the document data.
   * - filepath: Local file path (will be loaded and converted to base64)
   * - base64: Already encoded base64 data
   * - url: Public URL to the document
   * - file_id: Provider-specific file ID from their Files API
   */
  source:
    | { type: 'filepath'; path: string }
    | { type: 'base64'; data: string }
    | { type: 'url'; url: string }
    | { type: 'file_id'; fileId: string };

  /**
   * MIME type of the document.
   * Examples: 'application/pdf', 'text/csv', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
   * If not provided and source is filepath, will be auto-detected.
   */
  mimeType?: string;

  /**
   * Original filename (for logging, debugging, or provider requirements).
   * If not provided and source is filepath, will be extracted from path.
   */
  filename?: string;

  /**
   * Provider-specific options (optional).
   * Only used by certain providers (e.g., Anthropic prompt caching).
   */
  providerOptions?: {
    anthropic?: {
      cacheControl?: {
        type: string;
      };
    };
    openrouter?: {
      plugin?: 'pdf-text' | 'mistral-ocr' | 'native';
    };
  };
}
```

### Updated ContentPart Union

```typescript
export type ContentPart =
  | TextContent
  | ImageContent
  | DocumentContent
  | ToolResultContent;
```

### Why This Design?

1. **Flexibility:** Supports file paths (most common), base64 (for pre-encoded data), URLs (for remote files), and file IDs (for multi-turn conversations)

2. **Auto-Detection:** MIME type and filename are optional for `filepath` source type - system will detect automatically

3. **Provider Agnostic:** Universal format that all compat modules can understand

4. **Forward Compatible:** `providerOptions` allows provider-specific features without breaking the core type

5. **Matches Existing Pattern:** Mirrors the existing `ImageContent` structure

---

## File Loading System

### Directory Structure

```
utils/
└── documents/
    ├── document-loader.ts       # File loading and encoding
    ├── document-validator.ts    # Basic validation utilities
    ├── mime-types.ts            # MIME type detection and constants
    └── index.ts                 # Barrel export
```

### document-loader.ts

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { detectMimeType } from './mime-types';

/**
 * Loaded document with all metadata populated.
 */
export interface LoadedDocument {
  data: string;           // Base64-encoded file data
  mimeType: string;       // Detected or provided MIME type
  filename: string;       // Extracted or provided filename
  sizeBytes: number;      // Original file size in bytes
}

/**
 * Load a document from a file path.
 * Reads the file, detects MIME type, encodes to base64.
 *
 * @param filePath - Absolute or relative path to the file
 * @param providedMimeType - Optional MIME type override
 * @param providedFilename - Optional filename override
 * @returns LoadedDocument with base64 data and metadata
 * @throws Error if file doesn't exist or can't be read
 */
export function loadDocumentFromPath(
  filePath: string,
  providedMimeType?: string,
  providedFilename?: string
): LoadedDocument {
  // Check file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Read file
  const fileBuffer = fs.readFileSync(filePath);

  // Encode to base64
  const base64Data = fileBuffer.toString('base64');

  // Detect or use provided MIME type
  const mimeType = providedMimeType || detectMimeType(filePath);

  // Extract or use provided filename
  const filename = providedFilename || path.basename(filePath);

  return {
    data: base64Data,
    mimeType,
    filename,
    sizeBytes: fileBuffer.length
  };
}

/**
 * Load document from already-encoded base64 string.
 * Useful when user has pre-encoded data.
 *
 * @param base64Data - Base64-encoded string
 * @param mimeType - MIME type of the document
 * @param filename - Filename for reference
 * @returns LoadedDocument
 */
export function loadDocumentFromBase64(
  base64Data: string,
  mimeType: string,
  filename?: string
): LoadedDocument {
  // Calculate approximate size
  const sizeBytes = Math.floor(base64Data.length * 0.75); // Base64 is ~33% larger

  return {
    data: base64Data,
    mimeType,
    filename: filename || 'document',
    sizeBytes
  };
}

/**
 * Process a DocumentContent to ensure it has base64 data.
 * Handles filepath sources by loading the file.
 * Passes through base64/url/file_id sources.
 *
 * @param content - DocumentContent from user
 * @returns DocumentContent with populated mimeType and filename
 */
export function processDocumentContent(content: DocumentContent): DocumentContent {
  // If filepath, load the file
  if (content.source.type === 'filepath') {
    const loaded = loadDocumentFromPath(
      content.source.path,
      content.mimeType,
      content.filename
    );

    return {
      ...content,
      source: { type: 'base64', data: loaded.data },
      mimeType: loaded.mimeType,
      filename: loaded.filename
    };
  }

  // For other source types, ensure mimeType and filename are set
  if (!content.mimeType) {
    throw new Error('mimeType is required for non-filepath document sources');
  }

  return {
    ...content,
    filename: content.filename || 'document'
  };
}
```

### mime-types.ts

```typescript
import * as path from 'path';

/**
 * Common MIME types for document processing.
 */
export const MIME_TYPES = {
  // Documents
  PDF: 'application/pdf',
  CSV: 'text/csv',
  TXT: 'text/plain',
  HTML: 'text/html',
  XML: 'application/xml',
  JSON: 'application/json',

  // Microsoft Office
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  DOC: 'application/msword',
  XLS: 'application/vnd.ms-excel',
  PPT: 'application/vnd.ms-powerpoint',

  // Images (may overlap with ImageContent)
  JPEG: 'image/jpeg',
  PNG: 'image/png',
  GIF: 'image/gif',
  WEBP: 'image/webp',

  // Other
  MD: 'text/markdown',
  RTF: 'application/rtf',
  ZIP: 'application/zip',
} as const;

/**
 * File extension to MIME type mapping.
 */
const EXTENSION_TO_MIME: Record<string, string> = {
  // Documents
  '.pdf': MIME_TYPES.PDF,
  '.csv': MIME_TYPES.CSV,
  '.txt': MIME_TYPES.TXT,
  '.html': MIME_TYPES.HTML,
  '.htm': MIME_TYPES.HTML,
  '.xml': MIME_TYPES.XML,
  '.json': MIME_TYPES.JSON,

  // Microsoft Office (modern)
  '.docx': MIME_TYPES.DOCX,
  '.xlsx': MIME_TYPES.XLSX,
  '.pptx': MIME_TYPES.PPTX,

  // Microsoft Office (legacy)
  '.doc': MIME_TYPES.DOC,
  '.xls': MIME_TYPES.XLS,
  '.ppt': MIME_TYPES.PPT,

  // Images
  '.jpg': MIME_TYPES.JPEG,
  '.jpeg': MIME_TYPES.JPEG,
  '.png': MIME_TYPES.PNG,
  '.gif': MIME_TYPES.GIF,
  '.webp': MIME_TYPES.WEBP,

  // Other
  '.md': MIME_TYPES.MD,
  '.markdown': MIME_TYPES.MD,
  '.rtf': MIME_TYPES.RTF,
  '.zip': MIME_TYPES.ZIP,
};

/**
 * Detect MIME type from file path based on extension.
 * Falls back to 'application/octet-stream' for unknown types.
 *
 * @param filePath - Path to the file
 * @returns MIME type string
 */
export function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_MIME[ext] || 'application/octet-stream';
}

/**
 * Check if a MIME type is a document type (non-image).
 * Useful for routing between DocumentContent and ImageContent.
 *
 * @param mimeType - MIME type to check
 * @returns true if document type, false if image type
 */
export function isDocumentMimeType(mimeType: string): boolean {
  return !mimeType.startsWith('image/');
}
```

### document-validator.ts

```typescript
/**
 * Basic validation utilities for documents.
 * Providers will do their own validation; these are just sanity checks.
 */

/**
 * Validate that base64 string is properly formatted.
 *
 * @param data - Base64 string to validate
 * @returns true if valid base64
 */
export function isValidBase64(data: string): boolean {
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  return base64Regex.test(data);
}

/**
 * Estimate the original file size from base64 string.
 * Base64 encoding increases size by ~33%.
 *
 * @param base64Data - Base64-encoded string
 * @returns Estimated original size in bytes
 */
export function estimateFileSizeFromBase64(base64Data: string): number {
  // Remove padding characters
  const withoutPadding = base64Data.replace(/=/g, '');
  // Each base64 character represents 6 bits
  // Original size = (base64 length * 6) / 8
  return Math.floor((withoutPadding.length * 6) / 8);
}

/**
 * Format file size for human-readable display.
 *
 * @param bytes - File size in bytes
 * @returns Formatted string (e.g., "1.5 MB")
 */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}
```

### index.ts (Barrel Export)

```typescript
export * from './document-loader';
export * from './document-validator';
export * from './mime-types';
```

---

## Compat Module Transformations

### Where to Add Code

Each compat module has a `serializeContent()` method (or equivalent) that transforms `ContentPart` to provider-specific format. Add document handling there.

### 1. Anthropic (`plugins/compat/anthropic.ts`)

**Location:** In `serializeContent()` method

**Transformation:**
```typescript
private serializeContent(part: ContentPart): any {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }

  if (part.type === 'image') {
    return {
      type: 'image',
      source: { type: 'url', url: part.imageUrl }
    };
  }

  // ADD THIS:
  if (part.type === 'document') {
    const docBlock: any = {
      type: 'document',
      source: {}
    };

    // Handle different source types
    if (part.source.type === 'base64') {
      docBlock.source = {
        type: 'base64',
        media_type: part.mimeType,
        data: part.source.data  // Raw base64, no prefix
      };
    } else if (part.source.type === 'url') {
      docBlock.source = {
        type: 'url',
        url: part.source.url
      };
    } else if (part.source.type === 'file_id') {
      docBlock.source = {
        type: 'file',
        file_id: part.source.fileId
      };
    }

    // Add prompt caching if specified
    if (part.providerOptions?.anthropic?.cacheControl) {
      docBlock.cache_control = part.providerOptions.anthropic.cacheControl;
    }

    return docBlock;
  }

  if (part.type === 'tool_result') {
    // existing code...
  }

  throw new Error(`Unknown content type: ${(part as any).type}`);
}
```

**Key Points:**
- Anthropic uses `document` type
- Base64 needs `media_type` field
- Raw base64 string (no data URL prefix)
- Support for prompt caching via `cache_control`

---

### 2. OpenAI Chat Completions (`plugins/compat/openai.ts`)

**Location:** In `serializeContent()` method

**Transformation:**
```typescript
private serializeContent(part: ContentPart): any {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }

  if (part.type === 'image') {
    return {
      type: 'image_url',
      image_url: { url: part.imageUrl }
    };
  }

  // ADD THIS:
  if (part.type === 'document') {
    const fileBlock: any = {
      type: 'file',
      file: {}
    };

    if (part.source.type === 'base64') {
      // OpenAI requires data URL format for base64
      const dataUrl = `data:${part.mimeType};base64,${part.source.data}`;
      fileBlock.file = {
        filename: part.filename || 'document',
        file_data: dataUrl
      };
    } else if (part.source.type === 'url') {
      // Note: OpenAI Chat Completions doesn't support direct URLs
      // Convert URL to base64 or throw error
      throw new Error('OpenAI Chat Completions does not support file URLs. Use file_id or base64.');
    } else if (part.source.type === 'file_id') {
      fileBlock.file = {
        file_id: part.source.fileId
      };
    }

    return fileBlock;
  }

  if (part.type === 'tool_result') {
    // existing code...
  }

  throw new Error(`Unknown content type: ${(part as any).type}`);
}
```

**Key Points:**
- OpenAI uses `file` type
- Base64 requires data URL format: `data:${mimeType};base64,${data}`
- Filename required for base64 uploads
- Chat Completions doesn't support direct URLs (only Responses API does)
- File IDs work for uploaded files

---

### 3. Google Gemini (`plugins/compat/google.ts`)

**Location:** In `serializeContent()` method (or in SDK call preparation)

**Transformation:**
```typescript
private serializeContent(part: ContentPart): any {
  if (part.type === 'text') {
    return { text: part.text };
  }

  if (part.type === 'image') {
    // Google format for images
    return {
      fileData: {
        fileUri: part.imageUrl,
        mimeType: part.mimeType || 'image/jpeg'
      }
    };
  }

  // ADD THIS:
  if (part.type === 'document') {
    if (part.source.type === 'base64') {
      // Google inline data format
      return {
        inlineData: {
          mimeType: part.mimeType,
          data: part.source.data  // Raw base64, no prefix
        }
      };
    } else if (part.source.type === 'url' || part.source.type === 'file_id') {
      // Google Files API format
      return {
        fileData: {
          fileUri: part.source.type === 'url' ? part.source.url : part.source.fileId,
          mimeType: part.mimeType
        }
      };
    }
  }

  if (part.type === 'tool_result') {
    // existing code...
  }

  throw new Error(`Unknown content type: ${(part as any).type}`);
}
```

**Key Points:**
- Google uses `inlineData` for base64
- Google uses `fileData` for URLs/file URIs
- Raw base64 string (no data URL prefix)
- `mimeType` required in both formats

---

### 4. OpenAI Responses API (`plugins/compat/openai-responses.ts`)

**Location:** In SDK call preparation (likely in `callSDK()` method)

**Transformation:**
```typescript
// Similar to OpenAI Chat Completions since they use same format
private serializeContent(part: ContentPart): any {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }

  if (part.type === 'image') {
    return {
      type: 'image_url',
      image_url: { url: part.imageUrl }
    };
  }

  // ADD THIS:
  if (part.type === 'document') {
    const fileBlock: any = {
      type: 'file',
      file: {}
    };

    if (part.source.type === 'base64') {
      const dataUrl = `data:${part.mimeType};base64,${part.source.data}`;
      fileBlock.file = {
        filename: part.filename || 'document',
        file_data: dataUrl
      };
    } else if (part.source.type === 'url') {
      // Responses API supports URLs
      fileBlock.file = {
        filename: part.filename || 'document',
        file_data: part.source.url
      };
    } else if (part.source.type === 'file_id') {
      fileBlock.file = {
        file_id: part.source.fileId
      };
    }

    return fileBlock;
  }

  throw new Error(`Unknown content type: ${(part as any).type}`);
}
```

**Key Points:**
- Same format as Chat Completions
- Responses API DOES support URLs (unlike Chat Completions)
- Still uses data URL format for base64
- SDK-based implementation

---

### Message Serialization Flow

For each compat module, the flow is:

1. Receive `Message[]` from coordinator
2. For each message, iterate through `content: ContentPart[]`
3. Call `serializeContent(part)` for each part
4. Transform to provider-specific format
5. Include in API request payload

**Example (Anthropic):**
```typescript
private serializeMessages(messages: Message[]): any[] {
  return messages.map(msg => ({
    role: msg.role,
    content: msg.content.map(part => this.serializeContent(part))
  }));
}
```

---

## Implementation Steps

### Phase 1: Type System & File Loading (Foundation)

#### Step 1.1: Update Core Types
**File:** `core/types.ts`
**Changes:**
1. Add `DocumentContent` interface (see [Universal File Type Design](#universal-file-type-design))
2. Update `ContentPart` union to include `DocumentContent`
3. Add JSDoc comments explaining usage

**Testing:**
- TypeScript compilation should succeed
- No runtime changes yet

---

#### Step 1.2: Create Document Utilities
**Files:**
- `utils/documents/document-loader.ts`
- `utils/documents/mime-types.ts`
- `utils/documents/document-validator.ts`
- `utils/documents/index.ts`

**Implementation:**
1. Create `utils/documents/` directory
2. Implement `mime-types.ts` with MIME type constants and detection
3. Implement `document-loader.ts` with file loading functions
4. Implement `document-validator.ts` with validation utilities
5. Create barrel export in `index.ts`

**Testing:**
- Unit tests for MIME type detection
- Unit tests for file loading (use test fixtures)
- Unit tests for validation functions

---

#### Step 1.3: Add Preprocessing Hook
**File:** `coordinator/coordinator.ts` or create new middleware

**Implementation:**
1. Add a message preprocessing step before sending to LLMManager
2. Process `DocumentContent` with `filepath` source type
3. Convert to `base64` source type with loaded data

**Code:**
```typescript
import { processDocumentContent } from '../utils/documents';

// In LLMCoordinator class, before calling LLMManager
private preprocessMessages(messages: Message[]): Message[] {
  return messages.map(msg => ({
    ...msg,
    content: msg.content.map(part => {
      if (part.type === 'document') {
        return processDocumentContent(part);
      }
      return part;
    })
  }));
}

// Then in call/stream methods:
async call(spec: LLMCallSpec): Promise<LLMResponse> {
  const preprocessedSpec = {
    ...spec,
    messages: this.preprocessMessages(spec.messages)
  };
  return this.llmManager.call(preprocessedSpec);
}
```

**Testing:**
- Integration test: Create message with `filepath` source, verify it's converted to `base64`
- Test error handling for missing files

---

### Phase 2: Compat Module Integration

#### Step 2.1: Anthropic Compat Module
**File:** `plugins/compat/anthropic.ts`

**Changes:**
1. Add document handling to `serializeContent()` method
2. Transform to Anthropic's `document` format
3. Handle base64, URL, and file_id sources
4. Support cache_control options

**Testing:**
- Unit test: Verify transformation of DocumentContent to Anthropic format
- Mock test: Create mock API call with document, verify payload structure
- Test all three source types (base64, url, file_id)

---

#### Step 2.2: OpenAI Chat Completions Compat Module
**File:** `plugins/compat/openai.ts`

**Changes:**
1. Add document handling to `serializeContent()` method
2. Transform to OpenAI's `file` format
3. Convert base64 to data URL format
4. Error on URL source (not supported by Chat Completions)

**Testing:**
- Unit test: Verify base64 gets data URL prefix
- Unit test: Verify filename is included
- Unit test: Verify URL source throws error
- Mock test: Verify payload structure

---

#### Step 2.3: Google Gemini Compat Module
**File:** `plugins/compat/google.ts`

**Changes:**
1. Add document handling to `serializeContent()` method
2. Transform base64 to `inlineData` format
3. Transform URLs/file IDs to `fileData` format
4. Ensure raw base64 (no data URL prefix)

**Testing:**
- Unit test: Verify `inlineData` format for base64
- Unit test: Verify `fileData` format for URLs
- Mock test: Verify SDK call structure

---

#### Step 2.4: OpenAI Responses API Compat Module
**File:** `plugins/compat/openai-responses.ts`

**Changes:**
1. Add document handling to SDK call preparation
2. Same format as Chat Completions but with URL support
3. Transform base64 to data URL format

**Testing:**
- Unit test: Verify transformation
- Unit test: Verify URL support
- Mock test: Verify SDK call structure

---

### Phase 3: Testing Infrastructure

#### Step 3.1: Test Fixtures
**Location:** `tests/fixtures/sample-documents/`

**Files to Create:**
1. `small.pdf` - Small PDF (< 1MB, ~5 pages) for quick tests
2. `medium.pdf` - Medium PDF (~5MB, 20-30 pages) for realistic tests
3. `sample.csv` - CSV file for non-PDF testing
4. `sample.txt` - Plain text file
5. `sample.json` - JSON file

**Also Create:**
- `tests/fixtures/sample-documents/README.md` - Document sources and licenses

---

#### Step 3.2: Unit Tests
**Location:** `tests/unit/`

**Files:**
1. `tests/unit/utils/document-loader.test.ts`
   - Test file loading from path
   - Test MIME type detection
   - Test error handling for missing files
   - Test base64 encoding

2. `tests/unit/utils/mime-types.test.ts`
   - Test MIME type detection for various extensions
   - Test fallback for unknown types

3. `tests/unit/utils/document-validator.test.ts`
   - Test base64 validation
   - Test file size estimation

4. `tests/unit/compat/document-serialization.test.ts`
   - Test each compat module's document transformation
   - Test all source types
   - Test provider-specific options

**Example Test:**
```typescript
import { loadDocumentFromPath } from '../../../utils/documents';

describe('document-loader', () => {
  describe('loadDocumentFromPath', () => {
    it('should load a PDF file and encode to base64', () => {
      const result = loadDocumentFromPath('tests/fixtures/sample-documents/small.pdf');

      expect(result.data).toBeTruthy();
      expect(result.mimeType).toBe('application/pdf');
      expect(result.filename).toBe('small.pdf');
      expect(result.sizeBytes).toBeGreaterThan(0);
    });

    it('should auto-detect MIME type from extension', () => {
      const result = loadDocumentFromPath('tests/fixtures/sample-documents/sample.csv');
      expect(result.mimeType).toBe('text/csv');
    });

    it('should throw error for non-existent file', () => {
      expect(() => {
        loadDocumentFromPath('does-not-exist.pdf');
      }).toThrow('File not found');
    });
  });
});
```

---

#### Step 3.3: Integration Tests
**Location:** `tests/integration/providers/`

**File:** `tests/integration/providers/document-support.test.ts`

**Tests:**
1. Mock API calls with document content
2. Verify payload structure for each provider
3. Test message preprocessing (filepath → base64 conversion)
4. Test error scenarios

**Example:**
```typescript
import { LLMCoordinator } from '../../../coordinator/coordinator';
import { Role } from '../../../core/types';

describe('Document Support Integration', () => {
  it('should transform filepath to base64 before API call', async () => {
    const coordinator = new LLMCoordinator({
      provider: 'anthropic',
      apiKey: 'test-key'
    });

    // Mock the HTTP call to intercept payload
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ text: 'response' }] })
    });
    global.fetch = mockFetch;

    await coordinator.call({
      messages: [
        {
          role: Role.USER,
          content: [
            { type: 'text', text: 'Summarize this' },
            {
              type: 'document',
              source: { type: 'filepath', path: 'tests/fixtures/sample-documents/small.pdf' }
            }
          ]
        }
      ]
    });

    // Verify the payload sent to API has base64 data
    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    const documentContent = payload.messages[0].content.find(c => c.type === 'document');

    expect(documentContent.source.type).toBe('base64');
    expect(documentContent.source.data).toBeTruthy();
    expect(documentContent.source.media_type).toBe('application/pdf');
  });
});
```

---

#### Step 3.4: Live Tests
**Location:** `tests/live/test-files/`

**File:** `tests/live/test-files/14-document-processing.live.test.ts`

**Tests:**
1. Real API calls to each provider with PDF
2. Test base64 source type
3. Test file_id source type (for providers that support it)
4. Verify responses contain document analysis

**Example:**
```typescript
describe('Live Document Processing Tests', () => {
  it('should process PDF with Anthropic Claude', async () => {
    const coordinator = new LLMCoordinator({
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY!
    });

    const response = await coordinator.call({
      messages: [
        {
          role: Role.USER,
          content: [
            { type: 'text', text: 'What is the main topic of this document?' },
            {
              type: 'document',
              source: { type: 'filepath', path: 'tests/fixtures/sample-documents/small.pdf' }
            }
          ]
        }
      ]
    });

    expect(response.content).toBeTruthy();
    expect(response.content[0].type).toBe('text');
    expect(response.content[0].text.length).toBeGreaterThan(0);
  });

  it('should process PDF with OpenAI gpt-4o', async () => {
    const coordinator = new LLMCoordinator({
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY!
    });

    const response = await coordinator.call({
      model: 'gpt-4o',
      messages: [
        {
          role: Role.USER,
          content: [
            { type: 'text', text: 'Summarize this document in one sentence.' },
            {
              type: 'document',
              source: { type: 'filepath', path: 'tests/fixtures/sample-documents/small.pdf' }
            }
          ]
        }
      ]
    });

    expect(response.content).toBeTruthy();
  });

  // Similar tests for Google, OpenAI Responses
});
```

---

### Phase 4: Documentation

#### Step 4.1: Update README
**File:** `README.md`

**Sections to Add:**
1. **File Support** section in features list
2. **Usage Examples** showing how to include files in messages
3. **Supported File Types** per provider
4. **File Loading** explanation

**Example Content:**
```markdown
## File Support

The LLM coordinator supports file inputs (PDFs, CSVs, TXT, etc.) across all providers.

### Usage

```typescript
import { LLMCoordinator, Role } from './llm-coordinator';

const coordinator = new LLMCoordinator({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY
});

const response = await coordinator.call({
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'Summarize this document' },
        {
          type: 'document',
          source: { type: 'filepath', path: './report.pdf' }
        }
      ]
    }
  ]
});
```

### Supported Source Types

- **filepath**: Load file from local disk (recommended)
- **base64**: Provide pre-encoded base64 data
- **url**: Public URL to the document (not supported by all providers)
- **file_id**: Provider-specific file ID from their Files API

### File Type Support by Provider

| Provider | PDFs | CSVs | TXT | Images | Other |
|----------|------|------|-----|--------|-------|
| Anthropic | ✅ | ✅ | ✅ | ✅ | ✅ |
| OpenAI | ✅ | ❌ | ❌ | ✅ | ❌ |
| Google | ✅ | ✅ | ✅ | ✅ | ✅ |
| OpenRouter | ✅ | Varies | Varies | ✅ | Varies |

Note: The coordinator accepts any file type; providers will reject unsupported formats.
```

---

#### Step 4.2: Add JSDoc Comments
**Files:** All modified files

**Standard:**
- Every public function/interface should have JSDoc
- Include `@param`, `@returns`, `@throws` tags
- Provide usage examples where helpful

---

#### Step 4.3: Create Migration Guide
**File:** `docs/file-support-migration.md` (optional)

**Content:**
- How to migrate from manual base64 encoding to filepath
- Performance considerations
- Best practices

---

### Phase 5: Code Quality & Polish

#### Step 5.1: Error Handling
**Review all code for:**
1. Helpful error messages
2. Proper error types
3. Validation at boundaries
4. Graceful degradation

**Example:**
```typescript
if (!part.mimeType) {
  throw new Error(
    'DocumentContent requires mimeType for non-filepath sources. ' +
    `Received source type: ${part.source.type}`
  );
}
```

---

#### Step 5.2: Performance Optimization
**Consider:**
1. Lazy loading of file utilities (only import when needed)
2. Streaming for large files (future enhancement)
3. Caching loaded documents (future enhancement)

**Not Priority:** Keep simple for initial implementation

---

#### Step 5.3: Type Safety
**Ensure:**
1. No `any` types without justification
2. Discriminated unions are properly checked
3. Type guards where needed

**Example:**
```typescript
function isDocumentContent(part: ContentPart): part is DocumentContent {
  return part.type === 'document';
}
```

---

## Testing Strategy

### Test Pyramid

```
        /\
       /  \  Live Tests (few)
      /    \  - Real API calls
     /------\  - Actual files
    /        \ - End-to-end validation
   /----------\
  / Integration\ Tests (some)
 /    Tests     \ - Mock API calls
/----------------\ - Message processing
/   Unit Tests   \ - File loading
/     (many)      \ - MIME detection
/------------------\ - Transformations
```

### Test Coverage Goals
- **Utilities**: 100% coverage
- **Compat modules**: 90%+ coverage
- **Integration**: Key workflows covered
- **Live**: One test per provider per source type

### Running Tests

```bash
# Unit tests only (fast)
npm run test:unit

# Integration tests (mock APIs)
npm run test:integration

# Live tests (requires API keys)
npm run test:live

# All tests
npm test
```

### Test Fixtures

**Location:** `tests/fixtures/sample-documents/`

**Files:**
1. `small.pdf` - 1-2 pages, < 1MB
2. `medium.pdf` - 20-30 pages, ~5MB
3. `large.pdf` - Near provider limits (for edge case testing)
4. `sample.csv` - Sample spreadsheet data
5. `sample.txt` - Plain text document
6. `sample.json` - JSON data
7. `README.md` - Document sources and licenses

**Creating Fixtures:**
```bash
# Generate a simple PDF for testing
# You can use various methods:
# 1. Export from Google Docs/Word
# 2. Use a PDF generation library
# 3. Find CC0/public domain PDFs
```

---

## Usage Examples

### Basic PDF Processing

```typescript
import { LLMCoordinator, Role } from './llm-coordinator';

const coordinator = new LLMCoordinator({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY
});

const response = await coordinator.call({
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'Summarize this document' },
        {
          type: 'document',
          source: { type: 'filepath', path: './quarterly-report.pdf' }
        }
      ]
    }
  ]
});

console.log(response.content[0].text);
```

### Multiple Files

```typescript
const response = await coordinator.call({
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'Compare these two documents' },
        {
          type: 'document',
          source: { type: 'filepath', path: './report-q1.pdf' },
          filename: 'Q1 Report'  // Optional, for clarity
        },
        {
          type: 'document',
          source: { type: 'filepath', path: './report-q2.pdf' },
          filename: 'Q2 Report'
        }
      ]
    }
  ]
});
```

### Using Base64 (Pre-encoded)

```typescript
import * as fs from 'fs';

const pdfBuffer = fs.readFileSync('./document.pdf');
const base64Data = pdfBuffer.toString('base64');

const response = await coordinator.call({
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'Analyze this document' },
        {
          type: 'document',
          source: { type: 'base64', data: base64Data },
          mimeType: 'application/pdf',
          filename: 'document.pdf'
        }
      ]
    }
  ]
});
```

### Using URLs (Provider-specific)

```typescript
// Works with Anthropic, Google, OpenAI Responses
const response = await coordinator.call({
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'What is in this public document?' },
        {
          type: 'document',
          source: { type: 'url', url: 'https://example.com/public-report.pdf' },
          mimeType: 'application/pdf'
        }
      ]
    }
  ]
});
```

### Using File IDs (Multi-turn)

```typescript
// First, upload file to provider (manual or via their SDK)
// For OpenAI:
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const file = await openai.files.create({
  file: fs.createReadStream('./document.pdf'),
  purpose: 'user_data'
});

// Then use file_id in coordinator
const response = await coordinator.call({
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'Summarize this document' },
        {
          type: 'document',
          source: { type: 'file_id', fileId: file.id },
          mimeType: 'application/pdf'
        }
      ]
    }
  ]
});

// Subsequent messages can reuse the same file_id
const followUp = await coordinator.call({
  messages: [
    response.toMessage(), // Previous assistant response
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'What about the conclusion section?' },
        {
          type: 'document',
          source: { type: 'file_id', fileId: file.id },
          mimeType: 'application/pdf'
        }
      ]
    }
  ]
});
```

### CSV Files

```typescript
const response = await coordinator.call({
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'What trends do you see in this sales data?' },
        {
          type: 'document',
          source: { type: 'filepath', path: './sales-data.csv' }
          // mimeType will be auto-detected as 'text/csv'
        }
      ]
    }
  ]
});
```

### Text Files

```typescript
const response = await coordinator.call({
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'Review this code for security issues' },
        {
          type: 'document',
          source: { type: 'filepath', path: './src/auth.ts' }
        }
      ]
    }
  ]
});
```

### With Provider-Specific Options

```typescript
// Anthropic prompt caching
const response = await coordinator.call({
  provider: 'anthropic',
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'Analyze this large document' },
        {
          type: 'document',
          source: { type: 'filepath', path: './large-document.pdf' },
          providerOptions: {
            anthropic: {
              cacheControl: { type: 'ephemeral' }
            }
          }
        }
      ]
    }
  ]
});

// OpenRouter plugin selection
const response = await coordinator.call({
  provider: 'openrouter',
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'Extract text from this scanned PDF' },
        {
          type: 'document',
          source: { type: 'filepath', path: './scanned.pdf' },
          providerOptions: {
            openrouter: {
              plugin: 'mistral-ocr'  // Use OCR for scanned docs
            }
          }
        }
      ]
    }
  ]
});
```

---

## Edge Cases & Error Handling

### File Not Found

```typescript
try {
  const response = await coordinator.call({
    messages: [
      {
        role: Role.USER,
        content: [
          { type: 'text', text: 'Analyze this' },
          {
            type: 'document',
            source: { type: 'filepath', path: './missing.pdf' }
          }
        ]
      }
    ]
  });
} catch (error) {
  // Error: File not found: ./missing.pdf
  console.error(error.message);
}
```

### Unsupported File Type (Provider Rejection)

```typescript
// Send a .zip file to OpenAI (not supported)
const response = await coordinator.call({
  provider: 'openai',
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'Extract this' },
        {
          type: 'document',
          source: { type: 'filepath', path: './archive.zip' }
        }
      ]
    }
  ]
});
// API will return error: "Unsupported file type"
// Let it bubble up to user
```

### File Too Large

```typescript
// Send 100MB PDF (exceeds most provider limits)
const response = await coordinator.call({
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'Summarize this' },
        {
          type: 'document',
          source: { type: 'filepath', path: './huge-document.pdf' }
        }
      ]
    }
  ]
});
// API will return error: "File too large" or similar
// No pre-validation in coordinator (per requirements)
```

### Missing MIME Type for Non-filepath

```typescript
try {
  const response = await coordinator.call({
    messages: [
      {
        role: Role.USER,
        content: [
          { type: 'text', text: 'Analyze this' },
          {
            type: 'document',
            source: { type: 'base64', data: 'abc123...' }
            // Missing mimeType!
          }
        ]
      }
    ]
  });
} catch (error) {
  // Error: DocumentContent requires mimeType for non-filepath sources
}
```

### Invalid Base64

```typescript
// Malformed base64 string
const response = await coordinator.call({
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'Analyze this' },
        {
          type: 'document',
          source: { type: 'base64', data: 'not valid base64!' },
          mimeType: 'application/pdf'
        }
      ]
    }
  ]
});
// API may return error, or validation could be added
```

### URL Not Supported by Provider

```typescript
try {
  const response = await coordinator.call({
    provider: 'openai',  // Chat Completions doesn't support URLs
    messages: [
      {
        role: Role.USER,
        content: [
          { type: 'text', text: 'Analyze this' },
          {
            type: 'document',
            source: { type: 'url', url: 'https://example.com/doc.pdf' },
            mimeType: 'application/pdf'
          }
        ]
      }
    ]
  });
} catch (error) {
  // Error: OpenAI Chat Completions does not support file URLs
}
```

### Mixed Content Types

```typescript
// Combining text, images, and documents is supported
const response = await coordinator.call({
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'Compare this diagram' },
        {
          type: 'image',
          imageUrl: 'https://example.com/diagram.png'
        },
        { type: 'text', text: 'with this technical specification' },
        {
          type: 'document',
          source: { type: 'filepath', path: './spec.pdf' }
        }
      ]
    }
  ]
});
```

---

## Implementation Checklist

### Phase 1: Foundation
- [ ] Add `DocumentContent` to `core/types.ts`
- [ ] Update `ContentPart` union
- [ ] Create `utils/documents/` directory
- [ ] Implement `mime-types.ts`
- [ ] Implement `document-loader.ts`
- [ ] Implement `document-validator.ts`
- [ ] Create barrel export `index.ts`
- [ ] Add preprocessing hook in coordinator
- [ ] Write unit tests for utilities

### Phase 2: Compat Modules
- [ ] Update Anthropic compat module
- [ ] Update OpenAI Chat Completions compat module
- [ ] Update Google Gemini compat module
- [ ] Update OpenAI Responses API compat module
- [ ] Write unit tests for each transformation
- [ ] Write integration tests with mocked APIs

### Phase 3: Testing
- [ ] Create test fixtures directory
- [ ] Add sample PDF files (small, medium, large)
- [ ] Add sample CSV, TXT, JSON files
- [ ] Write comprehensive unit tests
- [ ] Write integration tests
- [ ] Write live tests for each provider
- [ ] Test all source types (filepath, base64, url, file_id)
- [ ] Test error scenarios

### Phase 4: Documentation
- [ ] Update README with file support section
- [ ] Add usage examples
- [ ] Add provider comparison table
- [ ] Document supported file types
- [ ] Add JSDoc to all public APIs
- [ ] Create migration guide (optional)

### Phase 5: Polish
- [ ] Review error messages
- [ ] Add type guards where needed
- [ ] Performance review
- [ ] Security review (file path validation)
- [ ] Code review with team
- [ ] Final testing pass

---

## File Structure Summary

```
llm_coordinator/
├── core/
│   └── types.ts                          # ✏️ Add DocumentContent
├── plugins/compat/
│   ├── anthropic.ts                      # ✏️ Add document serialization
│   ├── openai.ts                         # ✏️ Add document serialization
│   ├── openai-responses.ts               # ✏️ Add document serialization
│   └── google.ts                         # ✏️ Add document serialization
├── coordinator/
│   └── coordinator.ts                    # ✏️ Add message preprocessing
├── utils/
│   └── documents/                        # ✨ NEW DIRECTORY
│       ├── document-loader.ts            # ✨ NEW - File loading
│       ├── mime-types.ts                 # ✨ NEW - MIME detection
│       ├── document-validator.ts         # ✨ NEW - Validation
│       └── index.ts                      # ✨ NEW - Barrel export
├── tests/
│   ├── unit/
│   │   ├── utils/
│   │   │   ├── document-loader.test.ts   # ✨ NEW
│   │   │   ├── mime-types.test.ts        # ✨ NEW
│   │   │   └── document-validator.test.ts # ✨ NEW
│   │   └── compat/
│   │       └── document-serialization.test.ts # ✨ NEW
│   ├── integration/
│   │   └── providers/
│   │       └── document-support.test.ts  # ✨ NEW
│   ├── live/
│   │   └── test-files/
│   │       └── 14-document-processing.live.test.ts # ✨ NEW
│   └── fixtures/
│       └── sample-documents/             # ✨ NEW DIRECTORY
│           ├── small.pdf                 # ✨ NEW
│           ├── medium.pdf                # ✨ NEW
│           ├── sample.csv                # ✨ NEW
│           ├── sample.txt                # ✨ NEW
│           ├── sample.json               # ✨ NEW
│           └── README.md                 # ✨ NEW
├── README.md                             # ✏️ Update with file support
└── files.md                              # ✨ THIS DOCUMENT

Legend:
✨ NEW - Create new file/directory
✏️ MODIFY - Edit existing file
```

---

## Provider API Reference

### Anthropic

**Documentation:** https://docs.anthropic.com/claude/docs/vision#document-support

**Request Format:**
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "document",
          "source": {
            "type": "base64",
            "media_type": "application/pdf",
            "data": "..."
          }
        },
        {
          "type": "text",
          "text": "Summarize this document"
        }
      ]
    }
  ]
}
```

### OpenAI Chat Completions

**Documentation:** https://platform.openai.com/docs/guides/pdf-files

**Request Format:**
```json
{
  "model": "gpt-4o",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "file",
          "file": {
            "filename": "document.pdf",
            "file_data": "data:application/pdf;base64,..."
          }
        },
        {
          "type": "text",
          "text": "Summarize this document"
        }
      ]
    }
  ]
}
```

### Google Gemini

**Documentation:** https://ai.google.dev/gemini-api/docs/document-processing

**Request Format:**
```json
{
  "contents": [
    {
      "parts": [
        {
          "inlineData": {
            "mimeType": "application/pdf",
            "data": "..."
          }
        },
        {
          "text": "Summarize this document"
        }
      ]
    }
  ]
}
```

### OpenRouter

**Documentation:** https://openrouter.ai/docs/docs/overview/multimodal/pdfs

**Request Format:**
```json
{
  "model": "anthropic/claude-3.5-sonnet",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "file",
          "file": {
            "filename": "document.pdf",
            "file_data": "https://example.com/doc.pdf"
          }
        },
        {
          "type": "text",
          "text": "Summarize this document"
        }
      ]
    }
  ]
}
```

---

## Next Steps After Implementation

### Future Enhancements

1. **File Upload Helpers**
   - Add utilities to upload files to provider Files APIs
   - Return file IDs for reuse in multi-turn conversations
   - Automatic cleanup of uploaded files

2. **Streaming for Large Files**
   - Stream file reading for very large files
   - Chunk processing for documents over size limits

3. **Document Preprocessing**
   - Automatic page splitting for documents over page limits
   - Image extraction from PDFs
   - Text extraction preview

4. **Caching Layer**
   - Cache loaded documents to avoid re-reading
   - Cache base64 encodings
   - TTL-based invalidation

5. **Advanced Validation**
   - Strict mode with provider-specific limit checking
   - Page count estimation before upload
   - OCR quality detection

6. **Multi-format Support**
   - Audio file support (for providers that support it)
   - Video file support
   - Archive extraction (.zip, .tar.gz)

7. **Performance Monitoring**
   - Track document processing time
   - Monitor token usage per document
   - Alert on large file uploads

### Maintenance

- **Keep Provider Documentation Updated:** APIs change; review quarterly
- **Update MIME Type Mappings:** Add new formats as needed
- **Monitor Provider Limits:** Update documentation if limits change
- **Test with New Models:** Verify compatibility when providers release new models

---

## FAQ

### Q: Why not use URLs instead of base64 for all files?
**A:** Not all providers support URLs (OpenAI Chat Completions doesn't). Base64 is the most universal format. Users can use URLs where supported via the `url` source type.

### Q: Should we validate file sizes before sending to APIs?
**A:** Per requirements, no strict validation. Let provider APIs reject oversized files. This keeps the coordinator simple and avoids maintaining provider limit tables.

### Q: How do we handle images vs documents?
**A:** Images should use `ImageContent`, documents use `DocumentContent`. For image files like JPG/PNG, either can work, but `ImageContent` is preferred for simple image analysis. `DocumentContent` is for PDFs, CSVs, TXT, and other document types.

### Q: Can we mix documents and images in the same message?
**A:** Yes! The `content` array can contain any mix of `TextContent`, `ImageContent`, and `DocumentContent`.

### Q: What about encrypted PDFs?
**A:** Most providers reject encrypted/password-protected PDFs. No special handling needed; the API will error and we bubble it up.

### Q: Should we extract text from PDFs ourselves?
**A:** No. Providers do this on their end. We just send the raw PDF data.

### Q: How do we handle multi-turn conversations with documents?
**A:** Use `file_id` source type. Upload once via provider's Files API, then reuse the ID across multiple messages. This is more efficient than re-sending base64 each time.

### Q: What's the token cost of sending a PDF?
**A:** Varies by provider:
- Anthropic: ~1,500-3,000 tokens per page
- OpenAI: Varies, includes both text extraction and page images
- Google: ~258 tokens per page for PDFs
- Check provider docs for exact pricing

### Q: Can we send the same document to different providers?
**A:** Yes! The universal `DocumentContent` type works across all providers. The compat layer handles transformation.

### Q: What if a provider doesn't support a file type?
**A:** The provider API will return an error. We don't pre-validate; we let the error bubble up to the user.

---

## Conclusion

This implementation plan provides a comprehensive, modular approach to adding file support to the LLM coordinator. Key principles:

1. **Universal Input:** Users provide file paths, system handles the rest
2. **Provider Abstraction:** Compat modules transform to provider-specific formats
3. **Modular Design:** Reusable utilities, clear separation of concerns
4. **Permissive Validation:** Let APIs reject unsupported files
5. **Comprehensive Testing:** Unit, integration, and live tests

Follow the implementation steps in order, and you'll have full file support across all LLM providers.
