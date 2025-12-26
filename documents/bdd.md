# Product BDD Scenario Catalog (Gherkin)

This document lists **user-perspective** scenarios that define whether the adapter “works”.

Notes:
- Scenarios intentionally do **not** reference any specific entrypoint or transport. The same behavior must hold regardless of how the adapter is invoked.
- Scenarios are **provider-agnostic** and do not name specific providers/models/SDKs.
- `# Modules:` lines indicate the primary internal modules involved (for mapping coverage later).

---

Feature: Request validation and error reporting

  # Modules: kernel
  Scenario: Invalid JSON input is rejected with a structured error
    Given a client submits a spec that is not valid JSON
    When the adapter parses the spec
    Then the adapter returns a structured error with a stable error code

  # Modules: kernel
  Scenario: Structurally invalid specs are rejected with validation details
    Given a client submits a spec that is missing required fields for the requested operation
    When the adapter validates the spec
    Then the adapter returns a structured validation error
    And the error includes a details list describing what is invalid

  # Modules: kernel, logging, security
  Scenario: Error outputs do not leak secrets
    Given a request includes secrets in configuration values
    When the adapter returns an error
    Then secret values are redacted in logs and error outputs

  # Modules: kernel
  Scenario: Unknown operations are rejected with a structured error
    Given a client submits a spec with an unknown operation type
    When the adapter validates the spec
    Then the adapter returns a structured error describing the unknown operation

---

Feature: Plugin loading and configuration

  # Modules: kernel, logging
  Scenario: Adapter loads configured plugins successfully
    Given a configured plugins directory
    When the adapter initializes
    Then plugins are discovered and loaded
    And the adapter is ready to process requests

  # Modules: kernel, logging
  Scenario: Adapter fails fast on malformed plugin configuration
    Given a configured plugins directory that contains malformed plugin configuration
    When the adapter initializes
    Then initialization fails with a structured error
    And the error identifies the malformed file or configuration

  # Modules: kernel, logging
  Scenario: Adapter fails fast when configured plugin implementations are missing
    Given plugin configuration references an implementation that is not available
    When the adapter initializes
    Then initialization fails with a structured error
    And the error identifies the missing implementation

---

Feature: Settings merging and overrides

  # Modules: settings
  Scenario: Settings are partitioned into runtime and call settings
    Given a client provides a settings object that includes runtime controls and call controls
    When the adapter prepares execution
    Then runtime settings are applied to adapter behavior
    And call settings are applied to provider requests
    And unknown settings are preserved as extras for compatibility mapping

  # Modules: settings
  Scenario: Per-request settings override global defaults deterministically
    Given global default settings are configured
    And a client provides per-request settings overrides
    When the adapter merges settings
    Then the merged settings are deterministic
    And override keys take precedence over defaults

  # Modules: settings
  Scenario: Nested provider settings are deep-merged deterministically
    Given settings include nested provider-specific configuration objects
    When the adapter merges nested settings overrides
    Then nested objects are deep-merged without losing unrelated keys

  # Modules: settings
  Scenario: Invalid settings shapes are rejected with structured validation errors
    Given a client provides settings with invalid types or shapes
    When the adapter validates the spec
    Then the adapter returns a structured validation error describing the invalid fields

---

Feature: LLM calls (non-streaming)

  # Modules: llm, messages, settings, usage
  Scenario: Basic LLM call returns a normalized response with text content
    Given a client submits a spec with messages and an LLM priority list
    When the adapter executes the LLM call
    Then the adapter returns a normalized response object
    And the response includes provider and model identifiers
    And the response includes one or more text content parts

  # Modules: llm, messages
  Scenario: System prompt influences the assistant response
    Given a client submits a spec with a system prompt and user message
    When the adapter executes the LLM call
    Then the response complies with system prompt constraints

  # Modules: llm, retry, logging
  Scenario: Provider fallback returns the first successful result from the priority list
    Given a client submits an LLM priority list with multiple candidates
    And an earlier candidate fails
    When the adapter executes the LLM call
    Then the adapter attempts the next candidate(s) in order
    And returns the first successful response

  # Modules: llm, retry
  Scenario: Failures return structured errors (not crashes)
    Given a client submits a spec that causes the provider call to fail
    When the adapter executes the LLM call
    Then the adapter returns a structured error response
    And the adapter remains usable for subsequent requests

  # Modules: llm, usage
  Scenario: Usage metadata is normalized when present
    Given the underlying provider returns token usage information
    When the adapter parses the response
    Then the normalized response includes usage fields in a consistent shape

  # Modules: llm, usage
  Scenario: Cached token usage is extracted when present in raw usage payloads
    Given the underlying provider returns cached token usage in its raw usage payload
    When the adapter parses the response
    Then normalized usage.cachedTokens is populated correctly

  # Modules: llm, settings
  Scenario: Unknown settings extras do not break LLM execution
    Given a client submits a spec with valid required settings and unknown extra settings fields
    When the adapter executes the LLM call
    Then the call succeeds if the underlying provider succeeds
    And unsupported settings extras are surfaced as warnings without leaking secrets

  # Modules: llm, context
  Scenario: Large context inputs are handled safely
    Given a client submits a spec with a large conversation history
    When the adapter executes the LLM call
    Then the adapter returns a normalized response or a structured provider error
    And the adapter does not hang or crash

---

Feature: LLM calls (streaming)

  # Modules: llm, messages
  Scenario: Streaming emits incremental output and a final normalized response
    Given a client submits a streaming spec
    When the adapter executes the streaming call
    Then the client receives incremental output events
    And the stream terminates with a final normalized response

  # Modules: llm, tools
  Scenario: Streaming supports tool calling with observable tool events
    Given a streaming spec that enables tools
    When the adapter executes the streaming call and a tool is invoked
    Then the client receives tool call events
    And the client receives tool result events
    And the stream completes with a final normalized response

  # Modules: llm
  Scenario: Streaming and non-streaming have equivalent final response semantics
    Given a client submits the same spec in streaming and non-streaming modes
    When the adapter executes both
    Then both results contain the same semantic answer and normalized shape

---

Feature: Messages and content parts

  # Modules: messages
  Scenario: Messages support multiple content parts in a single message
    Given a client submits a message with multiple content parts (for example text plus attachments)
    When the adapter prepares the request
    Then all content parts are preserved and transmitted in a consistent normalized form

  # Modules: messages
  Scenario: Multiple system messages are aggregated deterministically
    Given a request contains multiple system messages
    When the adapter prepares the final message array
    Then system messages are aggregated in a deterministic way
    And the resulting message order is stable

  # Modules: messages, llm
  Scenario: Assistant responses support multiple content parts
    Given an LLM provider returns multiple content parts (for example, text plus metadata)
    When the adapter parses the response
    Then the normalized response contains all parts in a stable typed array

  # Modules: messages
  Scenario: Tool calls are represented canonically in the normalized response
    Given an execution that results in tool calls
    When the adapter returns the final response
    Then toolCalls exist in a canonical normalized format
    And tool call arguments are represented as JSON objects

  # Modules: messages
  Scenario: Tool call arguments are accessible via args and arguments fields
    Given an execution that results in tool calls
    When the adapter returns the final response
    Then each tool call includes a JSON object of arguments
    And the tool call arguments are accessible via both args and arguments
    And args and arguments are semantically equivalent

  # Modules: messages, tools
  Scenario: Tool results are appended and can be extracted canonically
    Given a tool call is executed and produces a result payload
    When the adapter appends that tool result to the conversation
    Then the tool result is represented in a canonical shape
    And the canonical tool result can be extracted deterministically

---

Feature: Context pruning and trimming

  # Modules: context, messages
  Scenario: Tool results are pruned from context while preserving the most recent N
    Given a multi-iteration tool loop that produces multiple tool results
    And preserveToolResults is set to N
    When subsequent iterations execute
    Then the most recent N tool results remain available in context
    And older tool results are replaced with a placeholder marker

  # Modules: context, messages
  Scenario: Tool results are pruned from context when preserveToolResults is none
    Given a multi-iteration tool loop that produces one or more tool results
    And preserveToolResults is set to none
    When subsequent iterations execute
    Then prior tool result payloads are not included verbatim in model-visible context
    And tool results are replaced with a placeholder marker or omitted deterministically

  # Modules: context, messages
  Scenario: Tool results are retained when preserveToolResults is all
    Given a multi-iteration tool loop that produces multiple tool results
    And preserveToolResults is set to all
    When subsequent iterations execute
    Then all prior tool result payloads remain available in context in a canonical shape
    And placeholder redaction is not applied due to tool result pruning

  # Modules: context, messages, llm
  Scenario: Reasoning is pruned from context while preserving the most recent N
    Given a multi-iteration tool loop where reasoning content is present
    And preserveReasoning is set to N
    When subsequent iterations execute
    Then the most recent N reasoning payloads remain available in context
    And older reasoning payloads are removed or redacted consistently

  # Modules: context, messages, llm
  Scenario: Conversation is trimmed to a token budget deterministically
    Given a conversation that exceeds a configured token budget
    When the adapter trims the conversation to the budget
    Then the resulting conversation is within budget
    And trimming behavior is deterministic for the same inputs

---

Feature: Tool discovery and tool execution

  # Modules: tools
  Scenario: Exposed tools are discoverable and invocable
    Given a tool is exposed to the model
    When the model requests that tool by name with valid JSON arguments
    Then the adapter routes to the correct tool implementation
    And the tool result is recorded and returned in the normalized response

  # Modules: tools
  Scenario: Tool name normalization is deterministic
    Given tools exist whose names require sanitization or normalization
    When tool names are normalized
    Then normalization is deterministic and collision-safe

  # Modules: tools
  Scenario: Tool choice controls tool selection behavior
    Given tools are enabled for a request
    When the client sets toolChoice to auto
    Then the model may choose whether to call tools
    When the client sets toolChoice to none
    Then no tools are executed even if tools are available
    When the client sets toolChoice to required with an allow-list
    Then the model must call an allowed tool before finalizing
    When the client sets toolChoice to single with a tool name
    Then the model must call that tool before finalizing

  # Modules: tools
  Scenario: Disallowed tool calls are blocked when an allow-list is enforced
    Given tools are enabled and an allow-list is enforced
    When the model attempts to call a tool that is not in the allow-list
    Then the adapter rejects the tool call with a structured tool error

  # Modules: tools
  Scenario: Unknown tool names are rejected with a structured tool error
    Given tools are enabled
    When the model calls a tool name that is not exposed
    Then the adapter returns a structured tool error describing the unknown tool

  # Modules: tools
  Scenario: Tool arguments must be valid JSON objects
    Given tools are enabled
    When the model submits tool call arguments that are not valid JSON or not a JSON object
    Then the adapter returns a structured tool error describing the invalid arguments

  # Modules: tools
  Scenario: Tool routing respects configured timeouts
    Given a tool route is configured with a timeout
    When the tool execution exceeds the timeout
    Then the adapter records a structured tool timeout error

  # Modules: tools, llm
  Scenario: Tool loop executes multiple tool calls in sequence
    Given a request that requires multiple tool calls in order
    When the tool loop executes
    Then tool calls are executed in a deterministic order
    And later tool calls can consume outputs from earlier tool results

  # Modules: tools, llm
  Scenario: Tool loop uses real tool outputs (anti-guessing)
    Given a tool returns an unpredictable value at runtime
    When the model is instructed to use that value in a follow-up step
    Then the model’s follow-up tool call arguments contain the real tool output
    And the final assistant answer reflects the real tool output

  # Modules: tools, llm
  Scenario: Parallel tool execution runs multiple tools within the same iteration
    Given a request that causes multiple tool calls in one iteration
    And parallel tool execution is enabled
    When the tool loop executes
    Then multiple tool calls execute without serial dependency
    And the final response accounts for all executed tool results

  # Modules: tools
  Scenario: Tool errors are surfaced as structured tool execution failures
    Given a tool invocation fails due to validation, timeout, or runtime error
    When the adapter executes the tool call
    Then the failure is recorded as a structured tool error
    And the overall request returns a structured error or continues per configured behavior

  # Modules: tools, llm
  Scenario: Tool loop can recover after a tool failure
    Given a request that triggers a failing tool call followed by a valid tool call
    When the tool loop executes
    Then the failure is recorded
    And the later valid tool call can still execute successfully

  # Modules: tools, llm
  Scenario: Tool result truncation applies to oversized tool outputs
    Given tool result truncation is configured
    When a tool returns output larger than the configured limit
    Then the stored tool output is truncated deterministically
    And truncation is indicated via a marker or structured metadata

  # Modules: tools, llm
  Scenario: Tool budget limits tool iteration count deterministically
    Given a maximum tool iteration budget is configured
    When the tool loop reaches the maximum iterations
    Then the adapter stops executing further tool iterations
    And the adapter returns a structured error or finalizes with a clear finish reason

  # Modules: tools, llm, messages
  Scenario: Tool countdown metadata is injected when enabled
    Given tool countdown injection is enabled
    When tool calls are executed
    Then tool result messages include remaining/used call metadata in a stable format

  # Modules: tools, llm, messages
  Scenario: Tool final prompt injection occurs when enabled and budget is exhausted
    Given tool final prompt injection is enabled
    When tool budget is exhausted
    Then the adapter injects a final prompt message in a stable format

---

Feature: Terminal tool calls and terminal overrides

  # Modules: tools, llm
  Scenario: Terminal tools stop the loop immediately after tool execution
    Given a tool is defined as terminal
    When the tool is executed
    Then the adapter stops the tool loop immediately after execution
    And the final response has finishReason tool_stop

  # Modules: tools, llm
  Scenario: Tool result override terminal=false forces follow-up even for terminal tools
    Given a tool is defined as terminal
    And the tool result sets tool_type_response_override_terminal to false
    When the tool is executed
    Then the tool loop continues
    And a follow-up model call occurs

  # Modules: tools, llm
  Scenario: Tool result override terminal=true forces early stop even for non-terminal tools
    Given a tool is not defined as terminal
    And the tool result sets tool_type_response_override_terminal to true
    When the tool is executed
    Then the tool loop stops immediately after execution
    And the final response has finishReason tool_stop

  # Modules: tools
  Scenario: Non-boolean terminal override values are ignored
    Given a tool result sets tool_type_response_override_terminal to a non-boolean value
    When terminal override evaluation runs
    Then the override is ignored
    And only strict boolean values affect terminal behavior

---

Feature: MCP tool integration

  # Modules: mcp, tools
  Scenario: MCP tools are available when MCP servers are configured
    Given one or more MCP servers are configured for a request
    When the adapter collects tools
    Then MCP tools are included alongside other tools with namespaced names

  # Modules: mcp, tools, llm
  Scenario: MCP tool results can be used in tool chains (anti-guessing)
    Given an MCP tool returns an unpredictable runtime value
    When the model is instructed to reuse that value in a follow-up tool call
    Then the follow-up tool call uses the real MCP result value

  # Modules: mcp, tools
  Scenario: MCP tool host failures are surfaced as structured tool errors
    Given an MCP tool call fails due to MCP process error or connection issues
    When the adapter executes the tool call
    Then a structured tool error is recorded for that tool call

  # Modules: mcp, tools, llm
  Scenario: MCP works in streaming mode
    Given a streaming spec with MCP enabled
    When an MCP tool is invoked during streaming
    Then streaming emits tool call and tool result events for the MCP tool

---

Feature: Documents (attachment ingestion)

  # Modules: documents
  Scenario: A client can attach a document by file path
    Given a request contains a document attachment with source type filepath
    When the adapter processes the request
    Then the adapter loads the file, detects MIME type when missing, and encodes content

  # Modules: documents
  Scenario: Client-supplied document MIME type and filename overrides are respected
    Given a request contains a document attachment with explicit mimeType and filename overrides
    When the adapter processes the request
    Then the adapter uses the provided mimeType and filename metadata

  # Modules: documents
  Scenario: Document MIME type detection is deterministic
    Given a request contains a document attachment by file path without an explicit mimeType
    When the adapter detects the MIME type
    Then the detected MIME type is deterministic for the same input path

  # Modules: documents
  Scenario: A client can attach a document by base64
    Given a request contains a document attachment with source type base64 and an explicit MIME type
    When the adapter processes the request
    Then base64 is validated
    And invalid base64 is rejected with a structured validation error

  # Modules: documents
  Scenario: Document base64 size estimation is consistent
    Given a request contains a base64 document payload
    When the adapter estimates file size from base64
    Then the size estimate is consistent and non-negative
    And any human-readable size formatting is consistent

  # Modules: documents
  Scenario: A client can attach a document by URL
    Given a request contains a document attachment with source type url
    When the adapter processes the request
    Then the attachment is represented canonically
    And unsafe credential components are redacted in logs

  # Modules: documents
  Scenario: A client can attach a document by file id
    Given a request contains a document attachment with source type file_id
    When the adapter processes the request
    Then the attachment is represented canonically

  # Modules: documents
  Scenario: Unsupported document types are rejected with a clear error
    Given a request contains a document attachment with an unsupported MIME type
    When the adapter processes the request
    Then the adapter rejects the request with a structured error describing the unsupported type

  # Modules: documents, llm, messages
  Scenario: The assistant can answer questions grounded in attached documents
    Given a request includes an attached document and a question answerable from that document
    When the adapter executes the LLM call
    Then the assistant response includes facts present in the document
    And assertions are tolerant to phrasing while validating the extracted fact(s)

---

Feature: Images (attachment ingestion)

  # Modules: llm, messages
  Scenario: A client can attach an image by URL
    Given a request contains an image content part with an image URL
    When the adapter executes the LLM call
    Then the image is included in the provider request in a provider-compatible way

  # Modules: llm, messages
  Scenario: The assistant can answer questions grounded in attached images
    Given a request includes an attached image and a question answerable from the image
    When the adapter executes the LLM call
    Then the assistant response contains image-grounded information

---

Feature: Embeddings operations

  # Modules: embeddings
  Scenario: Embedding a single text returns one vector
    Given a client submits an embeddings spec with one text input
    When the adapter executes embedding
    Then exactly one numeric vector is returned
    And dimensions is a positive integer

  # Modules: embeddings
  Scenario: Embedding a batch returns one vector per input
    Given a client submits an embeddings spec with multiple text inputs
    When the adapter executes embedding
    Then one numeric vector is returned per input
    And all vectors share the same dimensions

  # Modules: embeddings
  Scenario: Similar texts have higher similarity than dissimilar texts
    Given two semantically similar texts and one dissimilar text
    When the adapter embeds all texts
    Then similarity(similar pair) is greater than similarity(with dissimilar text)

  # Modules: embeddings, retry
  Scenario: Embedding provider fallback succeeds when an earlier candidate fails
    Given an embedding priority list with multiple candidates
    And an earlier candidate fails
    When the adapter executes embedding
    Then the adapter falls back to the next candidate
    And returns a successful result

  # Modules: embeddings
  Scenario: Dimensions operation returns the configured dimensions
    Given a client requests embedding dimensions for a configured embedding provider
    When the adapter executes the dimensions operation
    Then a positive integer dimensions value is returned

  # Modules: embeddings
  Scenario: Validate operation returns a structured validity result
    Given a client requests validation for a configured embedding provider
    When the adapter executes the validate operation
    Then it returns a structured result indicating whether the provider is valid

---

Feature: Vector operations (direct)

  # Modules: vector
  Scenario: A client can create a collection
    Given a client submits a vector spec to create a collection with dimensions
    When the adapter executes the operation
    Then the collection is created successfully

  # Modules: vector
  Scenario: A client can verify whether a collection exists
    Given a client submits a vector spec to check collection existence
    When the adapter executes the operation
    Then a structured exists boolean is returned

  # Modules: vector
  Scenario: A client can delete a collection
    Given a client submits a vector spec to delete a collection
    When the adapter executes the operation
    Then deletion succeeds
    And a follow-up existence check reports exists=false

  # Modules: vector, embeddings
  Scenario: A client can embed and upsert chunks into a collection
    Given a collection exists
    And a client submits chunks with ids, text, and optional metadata
    When the adapter executes an embed-and-upsert operation
    Then embeddings are computed as needed
    And the chunks are upserted
    And counts (embedded, upserted) are returned

  # Modules: vector, embeddings
  Scenario: A client can query a collection using a text query
    Given a collection seeded with chunks
    When the client submits a vector query with a text query and topK
    Then a structured results array is returned
    And each result contains id and score

  # Modules: vector
  Scenario: A client can query a collection using a precomputed query vector
    Given a collection seeded with chunks
    And a client has a precomputed query vector
    When the client submits a vector query with a query vector and topK
    Then a structured results array is returned
    And each result contains id and score
    And embeddingPriority is not required for this query

  # Modules: vector
  Scenario: A client can query with a metadata filter
    Given a collection seeded with chunks containing metadata
    When the client submits a vector query with a metadata filter
    Then all returned results satisfy the filter constraint

  # Modules: vector
  Scenario: Vector query results can include payload metadata when requested
    Given a collection seeded with chunks that include metadata payloads
    When the client submits a vector query with includePayload enabled
    Then a structured results array is returned
    And each result contains id and score
    And each result contains a payload object in a stable shape

  # Modules: vector
  Scenario: A client can query with a score threshold
    Given a collection seeded with chunks of varying similarity to a query
    When the client submits a vector query with scoreThreshold set
    Then all returned results have score greater than or equal to the threshold

  # Modules: vector
  Scenario: A client can delete items by id
    Given a collection seeded with a known id
    When the client submits a delete-by-id operation
    Then deletion succeeds
    And subsequent queries do not return the deleted id

  # Modules: vector
  Scenario: Vector operations support streaming progress events
    Given a vector operation that can report progress
    When the client executes the operation in streaming mode
    Then progress events are emitted
    And the stream ends with a done event and a final structured result

---

Feature: Vector chunking helpers

  # Modules: vector
  Scenario: Chunking returns no chunks for empty or whitespace-only input
    Given a client provides empty or whitespace-only text
    When text chunking runs
    Then no chunks are produced

  # Modules: vector
  Scenario: Chunking splits text into size-bounded chunks with overlap
    Given a client provides text and chunking options including chunkSize and chunkOverlap
    When text chunking runs
    Then chunks are produced whose text length does not exceed chunkSize
    And successive chunks overlap by at most chunkOverlap characters
    And chunk boundaries are consistent for the same text and options

  # Modules: vector
  Scenario: Chunk overlap is clamped when overlap is larger than chunk size
    Given a client provides chunkOverlap greater than or equal to chunkSize
    When text chunking runs
    Then overlap is clamped to a safe value
    And chunking still completes without infinite loops

  # Modules: vector
  Scenario: Chunking can split on a custom separator
    Given a client provides text and a separator option
    When separator-based chunking runs
    Then chunks are produced by combining separator-delimited parts
    And no chunk exceeds chunkSize

  # Modules: vector
  Scenario: Chunking can preserve sentence boundaries when enabled
    Given a client enables preserveSentences
    When sentence-aware chunking runs
    Then chunks prefer sentence boundaries when possible
    And no chunk exceeds chunkSize

  # Modules: vector
  Scenario: Chunking does not break unicode characters
    Given a client provides text containing unicode characters
    When text chunking runs
    Then chunk texts do not contain broken unicode boundaries

  # Modules: vector
  Scenario: Chunk ids are unique and well-formed
    Given a client chunks a non-empty text
    When chunks are produced
    Then each chunk has a unique id
    And ids are well-formed identifiers

  # Modules: vector
  Scenario: File chunking includes file metadata
    Given a client provides a file path to chunk
    When file chunking runs
    Then produced chunks include metadata describing the file path and file name

---

Feature: Retrieval (RAG) using vector context injection

  # Modules: vector, embeddings, llm, messages
  Scenario: Auto-inject inserts retrieved context before the model answers
    Given a collection seeded with a fact "The meaning of life is 42."
    And vector context is configured in auto mode
    When the user asks "What is the meaning of life?"
    Then retrieved context is injected into the prompt in the configured location
    And the assistant answer contains "42"

  # Modules: vector, embeddings, llm, messages
  Scenario: Auto-inject supports choosing where retrieved context is injected
    Given vector context auto mode is configured with an injection target (for example system or user)
    When retrieval executes
    Then retrieved context is injected at the configured target location

  # Modules: vector, embeddings, llm, messages, string
  Scenario: Auto-inject supports an injection template
    Given vector context auto mode is configured with an injection template containing a placeholder for results
    When retrieval executes
    Then the template is rendered with retrieved results substituted deterministically
    And the rendered template is injected into the prompt

  # Modules: vector, embeddings, llm, messages
  Scenario: Auto-inject query construction can include the system prompt in the retrieval query
    Given vector context is configured in auto mode
    And queryConstruction.includeSystemPrompt is always
    When retrieval executes
    Then the retrieval query includes the system prompt text

  # Modules: vector, embeddings, llm, messages
  Scenario: Auto-inject query construction can exclude the system prompt in the retrieval query
    Given vector context is configured in auto mode
    And queryConstruction.includeSystemPrompt is never
    When retrieval executes
    Then the retrieval query does not include the system prompt text

  # Modules: vector, embeddings, llm, messages
  Scenario: Auto-inject query construction includeSystemPrompt if-in-range is applied deterministically
    Given vector context is configured in auto mode
    And queryConstruction.includeSystemPrompt is if-in-range
    When retrieval executes
    Then the system prompt is included only when messagesToInclude is 0 or total message count is less than or equal to messagesToInclude
    And otherwise the system prompt is excluded from the retrieval query

  # Modules: vector, embeddings, llm, messages
  Scenario: Auto-inject query construction can include assistant messages when enabled
    Given vector context is configured in auto mode
    And queryConstruction.includeAssistantMessages is true
    When retrieval executes
    Then assistant message text is included in the retrieval query when assistant messages are within the included message window

  # Modules: vector, embeddings, llm, messages
  Scenario: Auto-inject query construction excludes assistant messages when disabled
    Given vector context is configured in auto mode
    And queryConstruction.includeAssistantMessages is false
    When retrieval executes
    Then assistant message text is excluded from the retrieval query

  # Modules: vector, embeddings, llm, messages
  Scenario: Auto-inject query construction uses the last N messages deterministically
    Given vector context is configured in auto mode
    And queryConstruction.messagesToInclude is a positive integer N
    When retrieval executes
    Then the retrieval query is constructed from the last N non-system messages per role inclusion rules
    And query construction is deterministic for the same inputs

  # Modules: vector, embeddings, llm, messages
  Scenario: Auto-inject query construction includes all eligible messages when messagesToInclude is 0
    Given vector context is configured in auto mode
    And queryConstruction.messagesToInclude is 0
    When retrieval executes
    Then the retrieval query includes all eligible non-system messages per role inclusion rules
    And query construction is deterministic for the same inputs

  # Modules: vector, embeddings, llm
  Scenario: Auto-inject supports metadata filters
    Given a collection seeded with multiple metadata categories
    And vector context auto mode is configured with a metadata filter
    When a user asks a question
    Then retrieval uses the filter constraint
    And the injected context matches the filter constraint

  # Modules: vector, embeddings, llm
  Scenario: Auto-inject supports score thresholding
    Given a collection seeded with unrelated content
    And vector context auto mode is configured with a high score threshold
    When a user asks an unrelated question
    Then retrieval yields empty or minimal context
    And the assistant does not assert the unrelated seeded facts

  # Modules: vector, embeddings
  Scenario: Embedding priority resolution follows documented precedence
    Given vector context is configured without explicit embedding priority
    And the vector store configuration provides a default embedding priority
    When retrieval executes
    Then embeddings are resolved using the store default

  # Modules: vector, embeddings
  Scenario: Missing embedding priority yields a structured configuration error
    Given vector context is configured without explicit embedding priority
    And the vector store configuration does not provide a default embedding priority
    When retrieval executes
    Then a structured configuration error is returned
    And the error explains how to configure embedding priority

  # Modules: vector, embeddings, llm, tools, messages
  Scenario: Both mode supports injection and exposes the vector search tool
    Given vector context is configured in both mode
    And a collection contains relevant facts
    When a user asks a question that may require retrieval
    Then retrieved context may be injected into the prompt
    And the vector search tool is available for explicit invocation

---

Feature: Retrieval using a built-in vector search tool

  # Modules: vector, tools, embeddings, llm
  Scenario: The model can invoke vector search as a tool to retrieve facts
    Given vector search tool mode is enabled
    And a collection contains a fact "The meaning of life is 42."
    When a user asks a question that requires retrieval
    Then the model invokes the vector search tool
    And tool results contain the fact
    And the assistant answer contains "42"

  # Modules: vector, tools
  Scenario: Vector search tool results are formatted consistently and bounded
    Given vector search returns multiple results with text and metadata
    When the adapter formats tool results for the model
    Then formatting is consistent and readable
    And formatted output respects configured size limits

  # Modules: vector, tools
  Scenario: Vector search failures return structured tool errors
    Given a vector search tool invocation fails due to configuration or store errors
    When the adapter executes the tool call
    Then a structured tool error is returned for that tool invocation

  # Modules: vector, tools
  Scenario: Locked vector parameters cannot be overridden by the model (topK)
    Given vector search tool mode is enabled with topK locked
    When the model attempts to request a different topK
    Then the executed query uses the locked topK

  # Modules: vector, tools
  Scenario: Locked vector parameters cannot be overridden by the model (filter)
    Given vector search tool mode is enabled with filter locked
    When the model attempts to change or remove the filter
    Then the executed query uses the locked filter

  # Modules: vector, tools
  Scenario: Locked vector parameters cannot be overridden by the model (collection)
    Given vector search tool mode is enabled with collection locked
    When the model attempts to request a different collection
    Then the executed query uses the locked collection

  # Modules: vector, tools
  Scenario: Locked vector parameters cannot be overridden by the model (scoreThreshold)
    Given vector search tool mode is enabled with scoreThreshold locked
    When the model attempts to request a different scoreThreshold
    Then the executed query uses the locked scoreThreshold

  # Modules: vector, tools
  Scenario: Locked store cannot be overridden by the model
    Given vector search tool mode is enabled with store locked
    When the model attempts to select a different store
    Then the executed query uses the locked store

  # Modules: vector, tools
  Scenario: Locked parameters are omitted from the exposed tool schema
    Given vector search tool mode is enabled with one or more parameters locked
    When the tool schema is exposed to the model
    Then locked parameters are omitted from the schema
    And the tool still executes using only unlocked inputs

---

Feature: Reasoning configuration

  # Modules: llm, settings
  Scenario: Enabling reasoning sends reasoning configuration to the provider
    Given a client enables reasoning in request settings
    When the adapter builds the provider request
    Then the provider request contains a reasoning configuration

  # Modules: llm
  Scenario: Disabling reasoning does not require reasoning output in the response
    Given a client disables reasoning in request settings
    When the adapter executes the request
    Then the adapter returns a normal response regardless of whether reasoning output is present

  # Modules: llm
  Scenario: Provider rejection of reasoning triggers a compatibility retry without reasoning
    Given a client enables reasoning
    And the provider rejects reasoning parameters
    When the adapter executes the request
    Then the adapter retries once with reasoning removed
    And returns a successful response or a final structured error

---

Feature: Rate limiting and retries

  # Modules: llm, retry
  Scenario: Rate limit responses are detected and classified
    Given a provider response indicates a rate limit condition
    When the adapter processes the failure
    Then the adapter classifies the failure as rate-limited
    And exposes a structured error or retry decision

  # Modules: llm, retry
  Scenario: Retry policy executes bounded retries with backoff
    Given retry is enabled with a maximum attempt count
    When a transient failure occurs
    Then the adapter retries up to the configured maximum
    And retry delays are bounded and non-negative

  # Modules: llm, retry
  Scenario: Retry-after hints are honored when present
    Given a rate-limited response includes a retry-after hint
    When the adapter retries the request
    Then the adapter waits at least the hinted duration before retrying

---

Feature: Usage extraction and normalization

  # Modules: usage
  Scenario: Usage fields are normalized to a stable shape
    Given a provider response includes some usage fields and omits others
    When the adapter normalizes usage
    Then normalized usage fields exist in a stable shape
    And missing optional fields are represented consistently

  # Modules: usage
  Scenario: Usage extraction supports multiple possible raw field paths
    Given a provider emits usage under different possible raw field paths
    When the adapter extracts usage using a configured extraction spec
    Then the adapter extracts the correct values deterministically

  # Modules: usage
  Scenario: Usage extraction supports sum-mode aggregation
    Given usage fields may be split across multiple raw fields
    When the extraction spec uses sum-mode candidates
    Then the adapter computes aggregated fields deterministically
    And explicit null candidates yield null deterministically

  # Modules: usage, usage-cost
  Scenario: Cached token accounting metadata is preserved for cost calculation
    Given a provider indicates whether prompt tokens include cached tokens
    When the adapter computes cost
    Then cached token billing follows the documented rule for that metadata

---

Feature: Usage cost calculation

  # Modules: usage-cost, usage
  Scenario: Cost is computed when enabled and rates exist
    Given usage cost calculation is enabled
    And a cost table contains rates for the provider and model used
    And the provider returns token usage
    When the adapter returns the normalized response
    Then usage.cost is present and non-negative

  # Modules: usage-cost
  Scenario: Cost is not required when disabled or rates do not exist
    Given usage cost calculation is disabled or cost rates are unavailable
    When the adapter returns the normalized response
    Then usage.cost may be absent
    And the request is not failed because cost is missing

---

Feature: Observability export

  # Modules: observability
  Scenario: Enabling observability exports request/response telemetry
    Given observability export is enabled for a request
    When the adapter executes the request
    Then request and response telemetry events are recorded and exported

  # Modules: observability
  Scenario: Batch identifiers propagate to observability session correlation
    Given observability export is enabled
    And a request includes a batch identifier
    When the adapter exports telemetry for that request
    Then exported telemetry includes a session identifier equal to the batch identifier
    And traces for the batch can be grouped by that session identifier

  # Modules: observability
  Scenario: Observability is non-blocking (export failures do not fail the request)
    Given observability export is enabled
    And the exporter is unavailable or returns errors
    When the adapter executes a request
    Then the request still returns successfully
    And export failure is recorded separately

  # Modules: observability
  Scenario: Capture controls control what content is exported
    Given observability is enabled
    When captureMessages is set to none
    Then message bodies are not exported
    When captureMessages is set to text
    Then only text content is exported
    When captureMessages is set to full
    Then full structured content is exported

  # Modules: observability
  Scenario: Tool call argument capture is controlled explicitly
    Given observability is enabled
    When captureToolArgs is disabled
    Then tool call arguments are not exported
    When captureToolArgs is enabled
    Then tool call arguments are exported in a bounded form

  # Modules: observability
  Scenario: Raw request and raw response capture are controlled explicitly
    Given observability is enabled
    When captureRequestPayload is enabled
    Then the provider request payload is exported in a bounded form
    When captureRawResponse is enabled
    Then the raw provider response payload is exported in a bounded form

  # Modules: observability, shared
  Scenario: Observability export enforces size budgets
    Given observability is enabled with maximum attribute and content size budgets
    When a request or response contains very large fields
    Then exported fields are truncated or summarized to respect budgets

  # Modules: observability
  Scenario: Sampling can skip exports without affecting correctness
    Given observability is enabled with sampleRate less than 1
    When many requests execute
    Then some requests are not exported due to sampling
    And requests still succeed normally

  # Modules: observability
  Scenario: Queue overflow drops oldest events safely
    Given observability is enabled with a bounded queue
    When the queue is full and new events arrive
    Then oldest events are dropped
    And the adapter continues operating safely

---

Feature: Logging behavior

  # Modules: logging, security
  Scenario: Logs redact secrets consistently
    Given logging is enabled and requests include secrets (keys, tokens, credentials)
    When the adapter logs requests or responses
    Then secrets are redacted consistently in logs

  # Modules: logging
  Scenario: Disabling file logging prevents log file creation
    Given file logging is disabled by configuration
    When requests execute
    Then no log files are created

  # Modules: logging
  Scenario: Logs correlate request and response entries for a single call
    Given logging is enabled
    When a request executes
    Then request and response logs contain correlation metadata allowing pairing

  # Modules: logging
  Scenario: Batch identifiers group logs for a set of requests
    Given a client configures a batch identifier
    When multiple requests execute in the same batch
    Then logs include the batch identifier for each request

  # Modules: logging, security
  Scenario: Batch logging writes a per-batch log file and redacts secrets
    Given logging is enabled
    And file logging is enabled
    And a batch identifier is configured
    When one or more requests execute in that batch
    Then a per-batch log file is created with a deterministic name that includes the batch identifier
    And secrets are redacted consistently in the batch log file

---

Feature: Security helpers

  # Modules: security
  Scenario: Header redaction masks sensitive header values
    Given a headers object containing sensitive values
    When header redaction runs
    Then redacted values are masked consistently

  # Modules: security
  Scenario: URL redaction removes credentials and sensitive query parameters
    Given a URL that includes embedded credentials or sensitive query parameters
    When URL redaction runs
    Then redacted output does not expose credentials

  # Modules: security
  Scenario: Signed websocket tokens can be minted and verified
    Given a secret and payload
    When a signed token is minted and then verified
    Then verification succeeds and returns the expected payload

  # Modules: security
  Scenario: Signed websocket token verification fails with wrong secret
    Given a token minted with secret A
    When verification runs with secret B
    Then verification fails deterministically

  # Modules: security
  Scenario: Signed websocket token verification fails when token is expired
    Given a token minted outside the allowed TTL window
    When verification runs
    Then verification fails deterministically due to TTL bounds

---

Feature: Realtime sessions

  # Modules: realtime, audio
  Scenario: Opening a realtime session yields a ready event or a structured failure
    Given a realtime session spec with required configuration
    When the client opens a realtime session
    Then the first emitted event is ready
    Or an error event is emitted followed by closed

  # Modules: realtime
  Scenario: Realtime transport selection is honored
    Given a realtime session specifies a transport type
    When the client opens the session
    Then the session connects using the specified transport
    And the normalized event contract is unchanged

  # Modules: realtime, security
  Scenario: Realtime transport requiring client credentials rejects missing credentials
    Given a realtime session transport requires a short-lived client credential
    When the client opens the session without that credential
    Then the adapter returns a structured error describing the missing credential

  # Modules: realtime
  Scenario: Session history provided at open is available to the model
    Given a realtime session spec includes prior conversation history
    When the session opens and becomes ready
    Then the model can reference facts contained in that history

  # Modules: realtime
  Scenario: Earlier turns within a realtime session remain available to later turns
    Given a realtime session is open and ready
    And the user provides information in an earlier turn (via audio or text)
    When the user asks a follow-up question in a later turn
    Then the assistant can reference the earlier-turn information

  # Modules: realtime
  Scenario: Concurrent realtime sessions are isolated (no cross-talk)
    Given multiple realtime sessions are open concurrently with different session-specific context
    When each session receives a user turn and commits
    Then each session’s assistant response follows only its own session context
    And no cross-session content leakage occurs

  # Modules: realtime
  Scenario: Injecting context mid-session does not auto-trigger a response
    Given a realtime session is open
    When the client injects context without committing a new user turn
    Then no assistant response is triggered automatically

  # Modules: realtime
  Scenario: Manual commit mode requires commit to trigger model responses
    Given a realtime session is configured for manual commit
    When the client sends text or audio without committing
    Then no assistant response is triggered
    When the client commits
    Then the assistant response begins

  # Modules: realtime
  Scenario: Automatic turn detection mode triggers responses without explicit commit
    Given a realtime session is configured for automatic turn detection
    When the client sends audio and the user turn boundary is detected
    Then the assistant response begins without an explicit commit call

  # Modules: realtime
  Scenario: Realtime events are streamed in a stable normalized taxonomy
    Given a realtime session is open
    When the session emits lifecycle, transcript, tool, and usage events
    Then all events conform to the normalized realtime event taxonomy

  # Modules: realtime, usage
  Scenario: Realtime usage events surface usage information when available
    Given a realtime session is open
    When the underlying provider supplies usage information
    Then the adapter emits normalized usage events

  # Modules: realtime
  Scenario: Text input produces assistant transcript final
    Given a realtime session is open
    When the client sends a user text message and commits
    Then assistant transcript delta events may be emitted
    And assistant transcript final is eventually emitted

  # Modules: realtime, audio
  Scenario: Audio input produces user transcript final when transcription is enabled
    Given a realtime session is open with transcription enabled
    When the client streams audio frames and commits
    Then user transcript final is emitted containing the user’s spoken intent

  # Modules: realtime, tools
  Scenario: Tool calling works in realtime when enabled
    Given a realtime session is open with tools enabled
    When the model emits a tool call
    Then tool call events are emitted
    And the tool executes and a tool result is sent
    And the session continues generation

  # Modules: realtime, tools
  Scenario: Tool choice none disables tool execution in realtime
    Given a realtime session is open with tools configured
    And tool choice is set to none
    When the user asks for an action that could be performed by a tool
    Then no tool calls are executed
    And the assistant responds without tool execution

  # Modules: realtime, tools
  Scenario: Tool choice required restricts tool execution in realtime
    Given a realtime session is open with tools configured
    And tool choice is set to required with an allow-list
    When the user asks for an action requiring a tool
    Then the model emits a tool call
    And the tool call name is within the allow-list

  # Modules: realtime, tools
  Scenario: Tool call received when tools are disabled terminates the session
    Given a realtime session is open with tools disabled
    When the model emits a tool call
    Then the session emits an error and closes

  # Modules: realtime
  Scenario: Barge-in clears playback during assistant output
    Given barge-in is enabled
    When a configured barge-in trigger occurs during assistant output
    Then a playback.clear_requested event is emitted with reason barge_in

  # Modules: realtime
  Scenario: Explicit interrupt clears playback during assistant output
    Given a realtime session is open and the assistant is outputting
    When the client invokes interrupt
    Then a playback.clear_requested event is emitted with reason interrupt

  # Modules: realtime
  Scenario: Interrupt does not break the session (follow-up turns still work)
    Given a realtime session is open and the assistant is outputting
    When the client invokes interrupt and playback is cleared
    And the client sends a new user turn and commits
    Then the session continues generation
    And the assistant responds to the new turn normally

  # Modules: realtime
  Scenario: Idle timeout emits timeout and closes when configured to close
    Given idle timeout is configured to close the session
    When the session remains idle beyond the configured duration
    Then timeout is emitted
    And playback.clear_requested is emitted with reason timeout
    And the session closes

  # Modules: realtime
  Scenario: Max duration timeout emits timeout and closes when configured to close
    Given a maximum session duration is configured to close the session
    When the session exceeds the configured maximum duration
    Then timeout is emitted
    And playback.clear_requested is emitted with reason timeout
    And the session closes

  # Modules: realtime
  Scenario: Event buffer overflow fails fast to preserve memory safety
    Given event buffer limits are configured
    When the client does not drain events and the buffer limit is exceeded
    Then an error is emitted with an overflow code
    And playback.clear_requested is emitted with reason error
    And the session closes

  # Modules: realtime
  Scenario: DTMF digit mode injects a user-visible turn
    Given DTMF digit mode is enabled
    When the client sends a digit
    Then the adapter injects a model-visible user turn representing that digit

  # Modules: realtime
  Scenario: DTMF sequence mode buffers until terminator or max length
    Given DTMF sequence mode is enabled with terminators and max length
    When the client sends multiple digits
    Then digits are buffered until terminator or max length
    And a model-visible user turn representing the sequence is injected

  # Modules: realtime
  Scenario: Session recovery allows reconnection to an existing session
    Given a realtime session was previously established and the connection was lost
    When the client attempts to reconnect using session recovery
    Then the session is restored with prior context intact
    And the client can continue the conversation from where it left off

  # Modules: realtime
  Scenario: Telephony mode applies telephony-specific settings
    Given a realtime session is configured with telephony mode enabled
    When the session opens
    Then telephony-specific audio and protocol settings are applied
    And the session behaves appropriately for telephony use cases

  # Modules: realtime
  Scenario: Telephony mode can be disabled for non-telephony use cases
    Given a realtime session is configured with telephony mode disabled
    When the session opens
    Then default non-telephony settings are applied
    And the session operates in standard realtime mode

---

Feature: Audio utilities (used by realtime)

  # Modules: audio
  Scenario: Audio frames are base64-safe and round-trip correctly
    Given raw audio bytes
    When audio bytes are converted to base64 and back
    Then decoded bytes match the original bytes

  # Modules: audio
  Scenario: PCM16 conversions are deterministic
    Given PCM16 bytes
    When bytes are converted to samples and back
    Then the resulting bytes match the input bytes

  # Modules: audio
  Scenario: Framing produces deterministic frame boundaries
    Given audio bytes and a requested frame duration
    When audio framing runs
    Then frames are produced deterministically
    And no frame exceeds the requested frame size

  # Modules: audio
  Scenario: Resampling is deterministic for the same inputs
    Given PCM16 samples at a source sample rate
    When resampling runs to a target sample rate
    Then the output is deterministic for the same inputs

---

Feature: Shared utilities (behavioral contracts relied on by product features)

  # Modules: shared
  Scenario: Boolean flag normalization accepts common user inputs
    Given a flag input may be boolean, number, or common strings
    When flag normalization runs with a default
    Then the normalized boolean matches documented interpretation

  # Modules: shared
  Scenario: Safe JSON stringify never throws and produces bounded output
    Given an object that includes cycles and non-JSON primitives
    When safe JSON stringify runs with a byte limit
    Then output is valid JSON
    And output respects the configured bound

  # Modules: shared
  Scenario: Flattened primitive extraction provides bounded summaries
    Given a nested structure containing many primitive values
    When flattening runs with a byte limit
    Then output is bounded and deterministically truncated if needed

---

Feature: String utilities (template interpolation)

  # Modules: string
  Scenario: Template interpolation replaces placeholders deterministically
    Given a template string containing placeholders
    And a data object containing values
    When interpolation runs
    Then placeholders are replaced deterministically

---

Feature: Resource cleanup and stability

  # Modules: lifecycle, logging
  Scenario: Resources are closed cleanly after success
    Given a request completes successfully
    When the adapter finishes processing
    Then resources are closed cleanly (loggers, background workers)

  # Modules: lifecycle, logging
  Scenario: Resources are closed cleanly after failure
    Given a request fails with a structured error
    When the adapter finishes processing
    Then resources are closed cleanly
    And subsequent requests can still be processed
