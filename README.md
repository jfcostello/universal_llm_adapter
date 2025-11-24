# LLM Coordinator

Universal LLM adapter providing a unified interface across multiple AI providers (Anthropic, OpenAI, Google Gemini, OpenRouter) with support for text, images, documents, tool calls, MCPs, and vector stores.

## Features

- **Multi-Provider Support**: Seamless integration with Anthropic Claude, OpenAI GPT, Google Gemini, and OpenRouter
- **Document Processing**: Universal file support with automatic format detection and conversion
- **Tool Calling**: Unified tool calling interface across providers
- **MCP Integration**: Model Context Protocol server support
- **Vector Stores**: Integration with vector databases for RAG applications
- **Streaming**: Real-time streaming responses with tool support
- **100% Test Coverage**: Comprehensive test suite with full coverage

## File Support

### Overview

The LLM coordinator supports sending files (PDFs, CSVs, text files, images, etc.) to any compatible provider. Files are automatically preprocessed and converted to the appropriate format for each provider.

### Supported File Types

- **Documents**: PDF, CSV, TXT, JSON, HTML, Markdown
- **Microsoft Office**: DOCX, XLSX
- **Images**: JPEG, PNG, GIF, WebP (as ImageContent, not DocumentContent)
- **Custom**: Any file type with MIME type specification

### Usage

#### Filepath Sources (Recommended)

Provide a file path and the coordinator will automatically load, encode, and detect the MIME type:

```typescript
import { LLMCoordinator } from './llm_coordinator';
import { Role } from './core/types';

const coordinator = new LLMCoordinator();

const response = await coordinator.run({
  messages: [
    {
      role: Role.USER,
      content: [
        { type: 'text', text: 'Analyze this document' },
        {
          type: 'document',
          source: { type: 'filepath', path: '/path/to/document.pdf' }
          // mimeType and filename are auto-detected
        }
      ]
    }
  ],
  llmPriority: [
    { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }
  ]
});
```

#### Base64 Sources

For pre-encoded data:

```typescript
{
  type: 'document',
  source: { type: 'base64', data: 'dGVzdCBkYXRh...' },
  mimeType: 'application/pdf',  // Required for base64
  filename: 'report.pdf'         // Optional
}
```

#### URL Sources

For publicly accessible files:

```typescript
{
  type: 'document',
  source: { type: 'url', url: 'https://example.com/doc.pdf' },
  mimeType: 'application/pdf',  // Required
  filename: 'doc.pdf'            // Optional
}
```

**Note**: URL support varies by provider:
- ✅ Anthropic: Supported
- ✅ Google Gemini: Supported (gs:// URLs for Google Cloud Storage)
- ✅ OpenAI Responses API: Supported
- ❌ OpenAI Chat Completions: Not supported (use base64 or file_id instead)

#### File ID Sources

For provider-uploaded files:

```typescript
{
  type: 'document',
  source: { type: 'file_id', fileId: 'file-abc123' },
  mimeType: 'application/pdf',  // Required
  filename: 'doc.pdf'            // Optional
}
```

### Provider-Specific Options

#### Anthropic Cache Control

Enable prompt caching for large documents:

```typescript
{
  type: 'document',
  source: { type: 'filepath', path: '/path/to/large-doc.pdf' },
  providerOptions: {
    anthropic: {
      cacheControl: { type: 'ephemeral' }
    }
  }
}
```

#### OpenRouter Plugins

Use OpenRouter's document processing plugins:

```typescript
{
  type: 'document',
  source: { type: 'filepath', path: '/path/to/document.pdf' },
  providerOptions: {
    openrouter: {
      plugin: 'pdf-text'  // or 'mistral-ocr' or 'native'
    }
  }
}
```

### Implementation Details

#### Automatic Preprocessing

The coordinator automatically:
1. Loads files from filesystem paths
2. Detects MIME types from file extensions
3. Encodes binary data to base64
4. Extracts filenames from paths
5. Converts to provider-specific formats

#### Provider Format Transformations

**Anthropic**:
```json
{
  "type": "document",
  "source": {
    "type": "base64",
    "media_type": "application/pdf",
    "data": "..."
  }
}
```

**OpenAI Chat Completions**:
```json
{
  "type": "file",
  "file": {
    "filename": "doc.pdf",
    "file_data": "data:application/pdf;base64,..."
  }
}
```

**Google Gemini** (base64):
```json
{
  "inlineData": {
    "mimeType": "application/pdf",
    "data": "..."
  }
}
```

**Google Gemini** (URLs/file IDs):
```json
{
  "fileData": {
    "fileUri": "gs://bucket/file.pdf",
    "mimeType": "application/pdf"
  }
}
```

#### MIME Type Detection

Built-in support for common file types:

| Extension | MIME Type |
|-----------|-----------|
| .pdf | application/pdf |
| .csv | text/csv |
| .txt | text/plain |
| .json | application/json |
| .html, .htm | text/html |
| .md, .markdown | text/markdown |
| .docx | application/vnd.openxmlformats-officedocument.wordprocessingml.document |
| .xlsx | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet |
| .jpg, .jpeg | image/jpeg |
| .png | image/png |
| .gif | image/gif |
| .webp | image/webp |

Unknown extensions default to `application/octet-stream`.

### Architecture

```
User Input (filepath)
       ↓
coordinator.prepareMessages()
       ↓
processDocumentContent()
  - Load file
  - Detect MIME
  - Encode base64
       ↓
Provider Compat Module
  - Transform to provider format
       ↓
LLM API
```

**Key Files**:
- `core/types.ts` - DocumentContent type definitions
- `utils/documents/document-loader.ts` - File loading and preprocessing
- `utils/documents/mime-types.ts` - MIME type detection
- `coordinator/coordinator.ts` - Message preprocessing integration
- `plugins/compat/*.ts` - Provider-specific transformations

## Testing

The library maintains 100% test coverage. Run tests with:

```bash
npm test
```

Document-specific tests:
```bash
npm test -- --testPathPattern="document"
```

Coverage report:
```bash
npm test -- --coverage
```

## Contributing

When adding new features:
1. Write tests first (TDD approach)
2. Implement the feature
3. Verify 100% test coverage
4. Update this README

## License

[Your License Here]
