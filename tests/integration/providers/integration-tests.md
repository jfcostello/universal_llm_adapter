# Integration Tests Implementation Guide

## Purpose

This guide shows you **how to write integration tests** when adding a new provider compatibility module to the LLM adapter. Every test you need is documented here with step-by-step implementation instructions.

## How to Use This Guide

When implementing a new provider:

1. Read "Understanding Your Provider" to analyze your provider's API
2. Follow each test category in order
3. For each test: read the purpose, follow implementation steps, add the assertions
4. Use the checklist at the end to verify complete coverage
5. Run tests - they must all pass before your provider is complete

## Understanding Your Provider

Before writing tests, you need to understand your provider's API:

### Questions to Answer

1. **Message Format**: How does your provider structure messages?
   - What role names does it use? (e.g., "assistant" vs "model")
   - Where do system messages go? (in messages array vs separate field)
   - How are tool results attached? (separate role vs content blocks)

2. **Content Handling**: How does content work?
   - Are content parts arrays or strings?
   - What content types are supported? (text, images, etc.)
   - Are empty content blocks allowed or filtered?

3. **Tool Calling**: What's the function calling format?
   - How are tools declared? (as functions, declarations, etc.)
   - How are tool calls structured in responses?
   - What tool choice modes exist? (auto, none, required, specific)
   - Are tool names sanitized? (dots to underscores, etc.)

4. **Settings**: Which settings are supported?
   - What are the field names? (maxTokens vs max_tokens vs maxOutputTokens)
   - Are there provider-specific settings?
   - Are there required settings with defaults?

5. **Reasoning/Thinking**: Does your provider support reasoning?
   - How is reasoning formatted in requests?
   - How is reasoning returned in responses?
   - Is there a budget/token limit for reasoning?

6. **Streaming**: How does streaming work?
   - What's the chunk structure?
   - How are tool calls streamed? (incremental vs instant)
   - What events need to be emitted?

7. **API Method**: HTTP or SDK?
   - Does your provider use HTTP API (buildPayload/parseResponse)?
   - Or does it use an SDK (buildSDKParams/parseSDKResponse)?

---

# Test Categories

## 1. Payload Building Tests

**Goal**: Verify that unified messages, tools, and settings are correctly converted to your provider's format.

### 1.1 Basic Message Serialization

#### Test: "serializes system messages correctly"

**Purpose**: Verify that system messages are converted to your provider's format.

**How to implement**:
1. Create a unified message array with a SYSTEM role message containing text
2. Call your compat's `buildPayload()` or `buildSDKParams()` with the messages
3. Inspect the resulting payload structure

**What to verify**:
- System message is present in your provider's payload
- The role/location matches your provider's spec (e.g., in messages array, in system field, in systemInstruction)
- Text content is preserved
- Multiple system messages are handled per your provider's requirements (separate, first only, or aggregated)

**Why it matters**: System messages set critical AI behavior and context - they must be formatted exactly as your provider expects.

---

#### Test: "serializes user messages correctly"

**Purpose**: Verify that user messages are converted with the correct role.

**How to implement**:
1. Create a unified message with `Role.USER` and text content
2. Call `buildPayload()` with the message
3. Check the serialized message structure

**What to verify**:
- Message has your provider's user role identifier
- Content structure matches provider format (array of parts vs string vs object)
- Text content is preserved

**Why it matters**: User messages represent user input and must maintain correct attribution for multi-turn conversations.

---

#### Test: "serializes assistant messages correctly"

**Purpose**: Verify that assistant messages use your provider's assistant/model role.

**How to implement**:
1. Create a unified message with `Role.ASSISTANT` and text content
2. Call `buildPayload()` with the message
3. Check the role field in the output

**What to verify**:
- Message has your provider's assistant role (might be "assistant", "model", etc.)
- Content is properly formatted

**Why it matters**: Assistant responses must be attributed correctly for the provider to understand conversation context.

---

#### Test: "serializes tool messages correctly"

**Purpose**: Verify that tool result messages are converted to your provider's tool response format.

**How to implement**:
1. Create a message with `Role.TOOL`, a `toolCallId`, and text content
2. Call `buildPayload()` with the message
3. Inspect how the tool result is formatted

**What to verify**:
- Tool result is attached to the correct message type (separate "tool" role, content block in user message, functionResponse part, etc.)
- The tool call ID is preserved (as tool_call_id, tool_use_id, etc.)
- The result content is correctly formatted
- Multiple tool results are handled appropriately

**Why it matters**: Tool results must be properly formatted for your provider to process function calling responses.

---

#### Test: "handles empty content correctly"

**Purpose**: Verify that messages with empty content arrays don't crash and are handled appropriately.

**How to implement**:
1. Create a message with `content: []`
2. Call `buildPayload()` with the message
3. Check the output

**What to verify**:
- No error/crash occurs
- Empty content is handled per your provider's spec (empty array, empty string, filtered out, etc.)

**Why it matters**: Edge case that can occur in conversation flows, especially with tool-only responses.

---

### 1.2 Content Type Handling

#### Test: "handles text content parts"

**Purpose**: Verify that text content blocks are serialized correctly.

**How to implement**:
1. Create a user message with multiple text content parts: `[{ type: 'text', text: 'First. ' }, { type: 'text', text: 'Second.' }]`
2. Call `buildPayload()` with the message
3. Inspect the content structure

**What to verify**:
- All text parts are present in the output
- Text is preserved exactly
- Your provider's content part structure is correct (e.g., `{ type: 'text', text: '...' }` vs `{ text: '...' }`)

**Why it matters**: Text is the primary content type - it must be handled correctly.

---

#### Test: "handles image content parts"

**Purpose**: Verify that image content is converted to your provider's image format.

**How to implement**:
1. Create a message with an image content part (see test-fixtures for examples)
2. Call `buildPayload()` with the message
3. Check the image formatting

**What to verify**:
- Image is converted to your provider's format (e.g., `image_url`, `image.source`, `fileData`)
- URL is preserved
- MIME type is handled if required

**Why it matters**: Vision models require properly formatted image data.

---

#### Test: "handles tool_result content appropriately"

**Purpose**: Verify how your provider handles tool_result content parts.

**How to implement**:
1. Create a message with both tool_result and text content parts
2. Call `buildPayload()` with the message
3. Check what appears in the output

**What to verify**:
- If your provider uses tool_result content blocks: they're converted correctly
- If your provider uses separate tool messages: tool_result parts are filtered from content
- Text content is preserved

**Why it matters**: Different providers handle tool results differently - your compat must match your provider's expectations.

---

#### Test: "handles empty text"

**Purpose**: Verify that empty text strings are handled without crashing.

**How to implement**:
1. Create a message with `{ type: 'text', text: '' }`
2. Call `buildPayload()` with the message
3. Check the output

**What to verify**:
- No crash occurs
- Empty text is either preserved or filtered per your provider's requirements

**Why it matters**: Edge case that shouldn't cause errors.

---

### 1.3 Tool Calling

#### Test: "serializes tools for function calling"

**Purpose**: Verify that tool definitions are converted to your provider's schema format.

**How to implement**:
1. Create a simple tool with name, description, and parameters schema
2. Call `buildPayload()` with the tools array
3. Inspect the tools field in the payload

**What to verify**:
- Tools are present in your provider's format (e.g., `tools` array, `functionDeclarations`, etc.)
- Each tool has: name, description, parameters/input_schema
- Names are sanitized if required (e.g., dots to underscores for Google)
- Schema format matches your provider (JSON Schema vs Google Schema)

**Why it matters**: Tools must be properly declared for function calling to work.

---

#### Test: "serializes single tool call in assistant message"

**Purpose**: Verify that tool calls in assistant messages are formatted correctly.

**How to implement**:
1. Create an assistant message with a `toolCalls` array containing one call
2. Call `buildPayload()` with the message
3. Check how the tool call is represented

**What to verify**:
- Tool call is in your provider's format (e.g., `tool_calls` array, `tool_use` content blocks, `functionCall` parts)
- ID is preserved or generated
- Name is included (sanitized if needed)
- Arguments are properly formatted (as JSON string vs object)

**Why it matters**: Models return tool calls that must be formatted exactly as your provider expects.

---

#### Test: "serializes multiple tool calls"

**Purpose**: Verify that multiple tool calls in one message are all included.

**How to implement**:
1. Create an assistant message with multiple tool calls
2. Call `buildPayload()` with the message
3. Count the tool calls in the output

**What to verify**:
- All tool calls are present
- Each has correct structure
- Order is preserved

**Why it matters**: Models can call multiple tools in parallel.

---

#### Test: "handles tool choice 'auto'"

**Purpose**: Verify that auto tool choice is set correctly.

**How to implement**:
1. Call `buildPayload()` with tools and `toolChoice: 'auto'`
2. Check the tool choice field in the payload

**What to verify**:
- Tool choice is set to your provider's auto format (e.g., `'auto'`, `{ type: 'auto' }`, `{ mode: 'AUTO' }`)

**Why it matters**: Auto mode lets the model decide whether to use tools.

---

#### Test: "handles tool choice 'none'"

**Purpose**: Verify that none/disable tool choice works.

**How to implement**:
1. Call `buildPayload()` with tools and `toolChoice: 'none'`
2. Check the tool choice field

**What to verify**:
- Tool choice is set to your provider's none format (e.g., `'none'`, omitted, `{ mode: 'NONE' }`)

**Why it matters**: Prevents the model from using tools when you don't want it to.

---

#### Test: "handles single tool choice"

**Purpose**: Verify that forcing a specific tool works.

**How to implement**:
1. Call `buildPayload()` with `toolChoice: { type: 'single', name: 'tool_name' }`
2. Check the tool choice field

**What to verify**:
- Tool choice specifies the single tool in your provider's format
- Name is sanitized if required

**Why it matters**: Ensures model uses a designated tool.

---

#### Test: "handles required tool choice with multiple tools"

**Purpose**: Verify that requiring any tool (without specifying which) works.

**How to implement**:
1. Call `buildPayload()` with `toolChoice: { type: 'required', allowed: ['tool1', 'tool2'] }`
2. Check the tool choice field

**What to verify**:
- Tool choice indicates required/any mode in your provider's format
- Allowed list is included if supported

**Why it matters**: Forces model to use tools without specifying which one.

---

#### Test: "handles undefined tool choice"

**Purpose**: Verify default behavior when no tool choice specified.

**How to implement**:
1. Call `buildPayload()` with tools but `toolChoice: undefined`
2. Check the tool choice field

**What to verify**:
- Tool choice is undefined/omitted OR defaults to your provider's standard (some default to auto)

**Why it matters**: Default behavior should work correctly.

---

#### Test: "handles empty tools array"

**Purpose**: Verify non-tool calls work.

**How to implement**:
1. Call `buildPayload()` with `tools: []` or no tools
2. Check the tools and tool choice fields

**What to verify**:
- Tools field is undefined/omitted
- Tool choice field is undefined/omitted

**Why it matters**: Not all requests use tools.

---

### 1.4 Settings Mapping

#### Test: "maps all standard settings"

**Purpose**: Verify that all supported settings are converted to your provider's field names.

**How to implement**:
1. Create a settings object with all your provider's supported settings
2. Call `buildPayload()` with the settings
3. Check each field in the payload

**What to verify**:
- `temperature` → your provider's temperature field
- `topP` → your provider's top_p/topP field
- `maxTokens` → your provider's max_tokens/maxOutputTokens field
- `stop` → your provider's stop/stopSequences field
- Provider-specific settings are included (responseFormat, seed, etc.)

**Why it matters**: Settings control generation behavior and must be mapped correctly.

---

#### Test: "handles undefined settings"

**Purpose**: Verify that missing settings don't cause errors.

**How to implement**:
1. Call `buildPayload()` with empty settings object `{}`
2. Check that no setting fields appear in the payload

**What to verify**:
- Undefined settings are omitted from payload
- No null or undefined values appear (unless required by your provider)

**Why it matters**: Settings are optional.

---

#### Test: "handles partial settings"

**Purpose**: Verify that only specified settings are included.

**How to implement**:
1. Call `buildPayload()` with a few settings (e.g., just temperature)
2. Check which fields appear

**What to verify**:
- Present settings are mapped
- Absent settings are omitted

**Why it matters**: Common use case.

---

### 1.5 Reasoning/Thinking (if applicable)

**Note**: Skip these tests if your provider doesn't support reasoning/thinking.

#### Test: "serializes reasoning in assistant messages"

**Purpose**: Verify that reasoning is included in your provider's format.

**How to implement**:
1. Create an assistant message with `reasoning: { text: 'Let me think...' }`
2. Call `buildPayload()` with the message
3. Check where reasoning appears

**What to verify**:
- Reasoning is in your provider's format (direct field, thinking block, etc.)
- Text is preserved
- Redacted reasoning is handled per your provider (omitted or included)

**Why it matters**: Enables reasoning/thinking features.

---

#### Test: "handles reasoning budget/configuration"

**Purpose**: Verify reasoning budget is set correctly.

**How to implement**:
1. Call `buildPayload()` with `settings.reasoning.budget` or `settings.reasoningBudget`
2. Check the reasoning configuration in the payload

**What to verify**:
- Budget is set in your provider's format (thinkingConfig, thinking.budget_tokens, etc.)
- Default budget is used if not specified (if applicable)
- Priority is correct if both old and new format provided

**Why it matters**: Controls how much computation the model can spend on reasoning.

---

### 1.6 Edge Cases

#### Test: "handles empty messages array"

**Purpose**: Verify that no messages doesn't crash.

**How to implement**:
1. Call `buildPayload()` with `messages: []`
2. Check the output

**What to verify**:
- No crash occurs
- Messages field is empty array or appropriate default

**Why it matters**: Edge case that shouldn't crash.

---

#### Test: "handles complex multi-turn conversation"

**Purpose**: Verify realistic conversation flows work.

**How to implement**:
1. Create a conversation with system, user, assistant, tool call, tool result, and final user messages
2. Call `buildPayload()` with the full conversation
3. Verify structure

**What to verify**:
- All messages are serialized
- Order is preserved
- Tool flow is correct
- System messages are in correct location

**Why it matters**: Real-world usage validation.

---

## 2. Response Parsing Tests

**Goal**: Verify that your provider's responses are correctly converted to unified format.

### 2.1 Basic Parsing

#### Test: "parses text responses"

**Purpose**: Verify simple text responses are converted correctly.

**How to implement**:
1. Create a mock response object matching your provider's format with text content
2. Call `parseResponse()` or `parseSDKResponse()` with it
3. Check the unified output

**What to verify**:
- Returns unified format: `{ content: [{ type: 'text', text: '...' }], provider: '...', model: '...' }`
- Provider and model fields are set
- Text content is extracted correctly

**Why it matters**: Most common response type.

---

#### Test: "handles empty content"

**Purpose**: Verify responses with no/null content don't crash.

**How to implement**:
1. Create a response with `content: null` or `content: []`
2. Call `parseResponse()` with it
3. Check the output

**What to verify**:
- Returns `[{ type: 'text', text: '' }]`
- No crash occurs

**Why it matters**: Edge case handling.

---

#### Test: "handles missing content"

**Purpose**: Verify responses missing the content field don't crash.

**How to implement**:
1. Create a response without a content field
2. Call `parseResponse()` with it
3. Check the output

**What to verify**:
- Returns `[{ type: 'text', text: '' }]`
- No crash occurs

**Why it matters**: Defensive programming.

---

### 2.2 Tool Call Parsing

#### Test: "parses single tool call"

**Purpose**: Verify tool calls are extracted from responses.

**How to implement**:
1. Create a response with one tool call in your provider's format
2. Call `parseResponse()` with it
3. Check the `toolCalls` field

**What to verify**:
- Returns `toolCalls: [{ id: '...', name: '...', arguments: {...} }]`
- ID is extracted or generated
- Name is extracted
- Arguments are parsed from JSON string to object (if needed)

**Why it matters**: Function calling core feature.

---

#### Test: "parses multiple tool calls"

**Purpose**: Verify multiple tool calls in one response work.

**How to implement**:
1. Create a response with multiple tool calls
2. Call `parseResponse()` with it
3. Count the toolCalls

**What to verify**:
- All tool calls are in the array
- Each has correct structure

**Why it matters**: Parallel tool calling.

---

#### Test: "handles missing tool call ID"

**Purpose**: Verify missing IDs are handled gracefully.

**How to implement**:
1. Create a tool call response without an ID field
2. Call `parseResponse()` with it
3. Check the ID in the output

**What to verify**:
- A default ID is generated (e.g., 'call_0', 'call_1')
- No crash occurs

**Why it matters**: Some providers don't provide IDs.

---

#### Test: "handles missing arguments"

**Purpose**: Verify tool calls without arguments work.

**How to implement**:
1. Create a tool call without arguments field
2. Call `parseResponse()` with it
3. Check the arguments

**What to verify**:
- Defaults to empty object `{}`
- No crash occurs

**Why it matters**: Edge case.

---

### 2.3 Usage Statistics

#### Test: "extracts usage stats"

**Purpose**: Verify token counts are extracted correctly.

**How to implement**:
1. Create a response with usage metadata in your provider's format
2. Call `parseResponse()` with it
3. Check the `usage` field

**What to verify**:
- Returns `{ promptTokens: ..., completionTokens: ..., totalTokens: ... }`
- All counts are mapped correctly
- Reasoning tokens extracted if present

**Why it matters**: Usage tracking.

---

#### Test: "handles missing usage"

**Purpose**: Verify responses without usage metadata work.

**How to implement**:
1. Create a response without usage field
2. Call `parseResponse()` with it
3. Check the usage field

**What to verify**:
- `usage` is undefined
- No crash occurs

**Why it matters**: Usage may be optional.

---

### 2.4 Reasoning Parsing (if applicable)

#### Test: "extracts reasoning"

**Purpose**: Verify reasoning is extracted from responses.

**How to implement**:
1. Create a response with reasoning in your provider's format
2. Call `parseResponse()` with it
3. Check the `reasoning` field

**What to verify**:
- Returns `{ text: '...', metadata: {...} }` if reasoning present
- Metadata includes relevant fields (signature, provider, etc.)
- Multiple reasoning parts are aggregated if needed

**Why it matters**: Reasoning extraction.

---

#### Test: "handles missing reasoning"

**Purpose**: Verify responses without reasoning work.

**How to implement**:
1. Create a response without reasoning
2. Call `parseResponse()` with it
3. Check the reasoning field

**What to verify**:
- `reasoning` is undefined
- No crash occurs

**Why it matters**: Most responses don't have reasoning.

---

### 2.5 Finish Reason Mapping

#### Test: "maps finish reasons correctly"

**Purpose**: Verify finish reasons are mapped to unified format.

**How to implement**:
1. Create responses with each of your provider's finish reasons
2. Call `parseResponse()` for each
3. Check the `finishReason` field

**What to verify**:
- Common reasons are mapped (e.g., 'end_turn' → 'stop', 'max_tokens' → 'length', 'tool_use' → 'tool_calls')
- Provider-specific reasons are preserved
- null/undefined handled correctly

**Why it matters**: Finish reasons indicate why generation stopped.

---

## 3. Streaming Tests

**Goal**: Verify streaming response handling.

### 3.1 Text Streaming

#### Test: "emits text deltas"

**Purpose**: Verify text chunks are extracted from stream.

**How to implement**:
1. Create a stream chunk with text in your provider's format
2. Call `parseStreamChunk()` or `parseSDKChunk()` with it
3. Check the `text` field

**What to verify**:
- Returns `{ text: '...' }` with the text delta
- Text is extracted from correct field (delta.content, delta.text, parts[].text, etc.)

**Why it matters**: Core streaming functionality.

---

#### Test: "handles missing delta"

**Purpose**: Verify chunks without deltas don't crash.

**How to implement**:
1. Create a chunk without delta content
2. Call `parseStreamChunk()` with it
3. Check the output

**What to verify**:
- `text` is undefined
- No crash occurs

**Why it matters**: Edge case.

---

### 3.2 Tool Call Streaming

#### Test: "emits TOOL_CALL_START event"

**Purpose**: Verify START event when tool call begins.

**How to implement**:
1. Create a chunk that starts a tool call in your provider's format
2. Call `parseStreamChunk()` with it
3. Check `toolEvents` array

**What to verify**:
- Returns event: `{ type: ToolCallEventType.TOOL_CALL_START, callId: '...', name: '...' }`
- ID and name are extracted

**Why it matters**: Signals tool call initiation.

---

#### Test: "emits TOOL_CALL_ARGUMENTS_DELTA events"

**Purpose**: Verify DELTA events for argument chunks.

**How to implement**:
1. Set up state with a started tool call
2. Create a chunk with argument delta
3. Call `parseStreamChunk()` with it
4. Check `toolEvents` array

**What to verify**:
- Returns event: `{ type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA, callId: '...', argumentsDelta: '...' }`
- Delta is extracted correctly

**Why it matters**: Streaming tool arguments.

---

#### Test: "emits TOOL_CALL_END event on finish"

**Purpose**: Verify END event when tool call completes.

**How to implement**:
1. Set up state with tool call in progress
2. Create finish chunk
3. Call `parseStreamChunk()` with it
4. Check `toolEvents` array

**What to verify**:
- Returns event: `{ type: ToolCallEventType.TOOL_CALL_END, callId: '...', name: '...', arguments: '...' }`
- Full arguments are included

**Why it matters**: Signals completion.

---

#### Test: "emits all events in sequence for complete stream"

**Purpose**: Verify START → DELTA → END lifecycle.

**How to implement**:
1. Create a fresh compat instance
2. Parse start chunk, check for START event
3. Parse delta chunk, check for DELTA event
4. Parse end chunk, check for END event

**What to verify**:
- All three events emitted in order
- Each has correct type and data

**Why it matters**: Proper event lifecycle.

---

### 3.3 State Management

#### Test: "tracks state correctly"

**Purpose**: Verify streaming state is maintained across chunks.

**How to implement**:
1. Parse multiple chunks building up state
2. Verify state accumulates correctly
3. Check that index/ID mapping works if applicable

**What to verify**:
- Arguments accumulate across chunks if needed
- Index-to-ID mapping works if used
- State is isolated between instances

**Why it matters**: Streaming builds up data incrementally.

---

#### Test: "clears state appropriately"

**Purpose**: Verify state resets when needed.

**How to implement**:
1. Build up state
2. Parse a finish/reset chunk
3. Verify state is cleared

**What to verify**:
- State resets after finish
- New stream has clean slate

**Why it matters**: State shouldn't leak between streams.

---

### 3.4 Finish Conditions

#### Test: "detects tool_calls finish reason"

**Purpose**: Verify tool completion is detected.

**How to implement**:
1. Parse a chunk with tool_calls finish reason
2. Check `finishedWithToolCalls` flag

**What to verify**:
- `finishedWithToolCalls: true` when appropriate
- Flag is undefined for other finish reasons

**Why it matters**: Indicates tool call completion.

---

### 3.5 Usage Tracking in Streams

#### Test: "emits usage stats in chunks"

**Purpose**: Verify usage metadata in stream chunks.

**How to implement**:
1. Create a chunk with usage data
2. Call `parseStreamChunk()` with it
3. Check `usage` field

**What to verify**:
- Usage object with token counts
- Reasoning tokens if present

**Why it matters**: Real-time token tracking.

---

### 3.6 Reasoning Streaming (if applicable)

#### Test: "emits reasoning in chunks"

**Purpose**: Verify reasoning extraction from stream.

**How to implement**:
1. Create a chunk with reasoning
2. Call `parseStreamChunk()` with it
3. Check `reasoning` field

**What to verify**:
- Reasoning text extracted
- Metadata includes provider info
- Multiple parts aggregated if needed

**Why it matters**: Streaming reasoning support.

---

## 4. Configuration Tests

**Goal**: Verify helper methods and configuration.

#### Test: "returns streaming flags"

**Purpose**: Verify `getStreamingFlags()` returns correct flags.

**How to implement**:
1. Call `compat.getStreamingFlags()`
2. Check the result

**What to verify**:
- Returns your provider's streaming flags (e.g., `{ stream: true }` or `{}` for SDK)

**Why it matters**: Streaming configuration.

---

#### Test: "serializeTools works correctly"

**Purpose**: Verify tool serialization helper.

**How to implement**:
1. Call `compat.serializeTools(toolsArray)`
2. Check the result

**What to verify**:
- Tools converted to provider format
- Empty array returns `{}`

**Why it matters**: Tool serialization utility.

---

#### Test: "serializeToolChoice works correctly"

**Purpose**: Verify tool choice serialization helper.

**How to implement**:
1. Call `compat.serializeToolChoice(choice)` for each choice type
2. Check results

**What to verify**:
- Each type converted correctly
- undefined returns `{}`

**Why it matters**: Tool choice serialization utility.

---

## 5. Provider-Specific Tests

### For SDK-based Providers (like Google)

#### Test: "initializes with API key"

**Purpose**: Verify SDK initialization.

**How to implement**:
1. Set environment variable
2. Create compat instance
3. Check SDK methods exist

**What to verify**:
- `callSDK` and `streamSDK` methods available
- Supports primary and fallback env vars

**Why it matters**: Required configuration.

---

#### Test: "throws error when API key missing"

**Purpose**: Verify error on missing key.

**How to implement**:
1. Clear environment variables
2. Try to create compat instance
3. Catch error

**What to verify**:
- Throws with clear error message

**Why it matters**: Required configuration.

---

#### Test: "HTTP methods throw errors"

**Purpose**: Verify HTTP methods not available.

**How to implement**:
1. Try calling `buildPayload()` and `parseResponse()`
2. Catch errors

**What to verify**:
- Both throw errors indicating SDK-only support

**Why it matters**: Prevents misuse.

---

### For Schema Conversion (like Google)

If your provider requires schema conversion:

#### Test: "converts all basic types"

**Purpose**: Verify type mapping.

**How to implement**:
1. For each type (string, number, integer, boolean, array, object)
2. Call schema conversion method
3. Check output type

**What to verify**:
- Each type mapped correctly (e.g., 'string' → 'STRING')

**Why it matters**: Correct schema format.

---

#### Test: "preserves all schema fields"

**Purpose**: Verify fields are maintained.

**How to implement**:
1. Create schema with description, properties, required, minimum, maximum, format, enum
2. Convert it
3. Check all fields

**What to verify**:
- All fields preserved
- Nested schemas converted recursively

**Why it matters**: Complete schema support.

---

#### Test: "handles edge cases"

**Purpose**: Verify defensive schema conversion.

**How to implement**:
1. Test null schema, empty schema, missing type
2. Convert each
3. Check defaults

**What to verify**:
- Defaults to OBJECT with empty properties
- No crashes

**Why it matters**: Defensive programming.

---

## Extended Test Suite

For comprehensive coverage, add these edge case tests:

### Message Edge Cases
- Empty content arrays
- Multiple system messages
- Consecutive assistant messages
- Empty/whitespace-only text
- Non-text content in system messages

### Settings Edge Cases
- Zero values (temperature: 0)
- Edge values (topP: 1.0, maxTokens: 1)
- Empty arrays (stop: [])
- All undefined
- Unsupported settings filtered

### Response Edge Cases
- Null/undefined fields in responses
- Empty choices/candidates arrays
- Malformed tool calls
- Missing IDs, names, arguments
- Null usage values

### Streaming Edge Cases
- Null/undefined chunks
- Empty deltas
- Missing function objects
- Interleaved tool calls
- State isolation

### Finish Reason Edge Cases
- All provider-specific reasons
- Null/undefined finish reasons
- Unknown finish reasons

---

# Implementation Checklist

Use this to verify complete coverage:

## Core Functionality
- [ ] System message serialization (correct location/format)
- [ ] User message serialization (correct role)
- [ ] Assistant message serialization (correct role)
- [ ] Tool message serialization (correct format)
- [ ] Empty content handling
- [ ] Text content parts
- [ ] Image content parts (if applicable)
- [ ] Tool result content handling
- [ ] Empty text handling

## Tool Calling
- [ ] Tool definition serialization (correct schema)
- [ ] Single tool call serialization
- [ ] Multiple tool calls serialization
- [ ] Tool choice: 'auto' (correct format)
- [ ] Tool choice: 'none' (correct format)
- [ ] Tool choice: single (specific tool)
- [ ] Tool choice: required (any tool)
- [ ] Undefined tool choice
- [ ] Empty tools array
- [ ] Missing tool call ID (generates default)
- [ ] Missing tool arguments (defaults to {})

## Settings
- [ ] temperature mapped correctly
- [ ] topP mapped correctly
- [ ] maxTokens mapped correctly
- [ ] stop sequences mapped correctly
- [ ] Provider-specific settings included
- [ ] Unsupported settings filtered out
- [ ] Undefined settings omitted
- [ ] Zero/falsy values preserved

## Reasoning (if applicable)
- [ ] Reasoning serialization in requests
- [ ] Reasoning budget configuration
- [ ] Default budget used if not specified
- [ ] Redacted reasoning handled per provider
- [ ] Reasoning extraction from responses
- [ ] Reasoning metadata preserved

## Response Parsing
- [ ] Text responses parsed
- [ ] Empty/missing content handled
- [ ] Single tool call parsed
- [ ] Multiple tool calls parsed
- [ ] Missing tool IDs/arguments handled
- [ ] Usage stats extracted
- [ ] Missing usage handled
- [ ] Reasoning extracted (if applicable)
- [ ] Finish reasons mapped correctly

## Streaming
- [ ] Text deltas emitted
- [ ] Missing delta handled
- [ ] TOOL_CALL_START events
- [ ] TOOL_CALL_ARGUMENTS_DELTA events
- [ ] TOOL_CALL_END events
- [ ] Complete event sequence (START → DELTA → END)
- [ ] State management (accumulation)
- [ ] State clearing (between streams)
- [ ] Finish conditions detected
- [ ] Usage in streams
- [ ] Reasoning in streams (if applicable)

## Configuration
- [ ] getStreamingFlags() returns correct value
- [ ] serializeTools() works
- [ ] serializeToolChoice() works

## Provider-Specific
- [ ] SDK initialization (if applicable)
- [ ] API key validation (if applicable)
- [ ] HTTP method errors (if SDK-only)
- [ ] Schema conversion (if required)

## Edge Cases
- [ ] Empty messages array
- [ ] Multiple system messages
- [ ] Consecutive assistant messages
- [ ] Empty/whitespace-only text
- [ ] Null/undefined in responses
- [ ] Malformed responses
- [ ] All finish reason variants
- [ ] All streaming edge cases

---

# Common Pitfalls

## 1. Not Understanding Your Provider's Format
**Problem**: Copying another provider's tests without understanding differences.
**Solution**: Study your provider's API docs thoroughly first.

## 2. Incomplete Content Type Handling
**Problem**: Only testing text content.
**Solution**: Test images, tool results, empty content, etc.

## 3. Missing Tool Call Edge Cases
**Problem**: Only testing happy path tool calls.
**Solution**: Test missing IDs, missing arguments, multiple calls, etc.

## 4. Ignoring State Management
**Problem**: Streaming state bugs in production.
**Solution**: Test state accumulation, clearing, and isolation.

## 5. Not Testing All Settings
**Problem**: Assuming settings work without verification.
**Solution**: Test each setting individually with defined/undefined/edge values.

## 6. Forgetting Provider-Specific Behavior
**Problem**: Assuming uniform behavior across providers.
**Solution**: Document and test your provider's unique requirements.

## 7. Missing Null/Undefined Tests
**Problem**: Crashes on malformed responses.
**Solution**: Test null, undefined, and missing fields everywhere.

## 8. Not Testing Multi-Turn Conversations
**Problem**: State management across turns fails.
**Solution**: Test realistic conversation flows with tools.

## 9. Insufficient Streaming Coverage
**Problem**: Streaming has many edge cases.
**Solution**: Test all event types, state management, and edge cases.

## 10. Skipping Extended Tests
**Problem**: Only implementing core tests.
**Solution**: Extended tests catch bugs that core tests miss.

---

# Summary

To implement integration tests for a new provider:

1. **Understand your provider**: Answer all questions in "Understanding Your Provider"
2. **Implement core tests**: Follow each test in order, implementing exactly as described
3. **Add extended tests**: Cover all edge cases for production readiness
4. **Use the checklist**: Verify every item is covered
5. **Run tests**: All tests must pass

**Target test counts**:
- Core suite: 70-85 tests
- Extended suite: 70-120 tests
- Total: 140-200 tests depending on provider complexity

**Goal**: 100% test coverage with 0 failing tests before shipping.

Your tests should cover:
- Every message type and edge case
- Every tool calling scenario
- Every setting combination
- Every response format
- Every streaming event
- Every error condition

When in doubt, look at existing provider tests for examples, but **always implement based on YOUR provider's actual behavior**, not another provider's behavior.
