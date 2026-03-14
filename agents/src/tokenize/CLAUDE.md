# CLAUDE.md

Streaming text tokenization for real-time TTS. Incrementally splits text into sentences or words with configurable buffering.

## Key Classes

- **SentenceTokenizer / WordTokenizer** — Abstract bases with `tokenize()` (batch) and `stream()` (streaming) methods.
- **BufferedTokenStream** — Core streaming implementation. Buffers input until `minContextLength`, then tokenizes and holds output until `minTokenLength` before emitting. Each `flush()` generates a new `segmentId`.
- **Basic implementations** (`basic/`) — Default English tokenizers using rule-based sentence/word splitting. Includes hyphenation support.

## Non-Obvious Patterns

- **Designed for TTS pipeline**: Text arrives incrementally from LLM streaming. Tokenizer buffers enough context for accurate sentence boundaries before emitting.
- **Tuple tokens**: Some tokenizers return `[text, startPos, endPos]` tuples for position tracking, not just strings.
- **Segment tracking**: `flush()` creates new segment IDs, allowing consumers to distinguish continuous speech from intentional breaks.
