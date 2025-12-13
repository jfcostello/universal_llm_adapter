# `modules/documents`

Document ingestion helpers (path → base64), MIME detection, and lightweight validation.

## Hard rules
- Provider-agnostic only.
- Production code imports only `modules/documents/index.ts` (tests may import internals).

## Exports
- `loadDocumentFromPath(filePath, mimeType?, filename?)`
- `loadDocumentFromBase64(data, mimeType, filename?)`
- `processDocumentContent(content)`
- `isValidBase64(data)`
- `estimateFileSizeFromBase64(data)`
- `formatFileSize(bytes)`
- `MIME_TYPES`, `detectMimeType(filePath)`, `isDocumentMimeType(mimeType)`

