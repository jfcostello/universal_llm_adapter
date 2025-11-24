# Test Fixtures - Sample Documents

This directory contains sample documents used for testing file support in the LLM coordinator.

## Files

### small.pdf
- Minimal valid PDF document
- Contains single page with text "Test PDF Document"
- Used for testing PDF processing across all providers
- Size: < 1KB

### sample.csv
- Simple CSV file with sample data
- Contains 4 rows of person data (name, age, city)
- Used for testing CSV file processing

### sample.txt
- Plain text file
- Multi-line content for testing text file handling
- Used for testing MIME type detection and file loading

### sample.json
- Valid JSON document
- Contains nested data structure
- Used for testing JSON file processing

## Purpose

These files are used for:
1. Unit testing file loading and base64 encoding
2. Testing MIME type detection
3. Testing document content transformations in compat modules
4. Integration testing of document preprocessing
5. Live testing with real API calls (when API keys are available)

## License

These test fixtures are part of the test suite and are in the public domain for testing purposes.
