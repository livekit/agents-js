<!--
SPDX-FileCopyrightText: 2025 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Interruption Detection Refactoring - Summary

## Overview
This document describes the refactoring of the interruption detection logic in the LiveKit Agents framework, specifically in the `AgentActivity` class.

## Problem Statement
Previously, the `minInterruptionWords` check was only applied when the STT text result was non-empty. This created inconsistent behavior:
- Empty strings and undefined transcripts always allowed interruptions (bypassing word count validation)
- Only non-empty transcripts were subject to the word count minimum threshold
- This inconsistency could allow unwanted interruptions from silence or very short utterances

## Solution
The refactored logic ensures that **all interruptions are filtered based on word count**, including:
- Empty strings (0 words)
- Undefined/null transcripts (normalized to 0 words)
- Short utterances (fewer than `minInterruptionWords`)
- Exact matches (exactly `minInterruptionWords`)
- Full speech (more than `minInterruptionWords`)

## Changes Made

### 1. File: `agents/src/voice/agent_activity.ts`

#### Method: `onVADInferenceDone` (lines 613-653)
**Before:**
```typescript
if (this.stt && this.agentSession.options.minInterruptionWords > 0 && this.audioRecognition) {
  const text = this.audioRecognition.currentTranscript;
  
  // Only checked if text was truthy
  if (text && splitWords(text, true).length < this.agentSession.options.minInterruptionWords) {
    return;
  }
}
```

**After:**
```typescript
if (this.stt && this.agentSession.options.minInterruptionWords > 0 && this.audioRecognition) {
  const text = this.audioRecognition.currentTranscript;
  
  // Normalize text: convert undefined/null to empty string for consistent word counting
  const normalizedText = text ?? '';
  const wordCount = splitWords(normalizedText, true).length;
  
  // Only allow interruption if word count meets or exceeds minInterruptionWords
  if (wordCount < this.agentSession.options.minInterruptionWords) {
    return;
  }
}
```

**Key Changes:**
- Removed the `text &&` condition that skipped checking empty strings
- Added explicit normalization: `text ?? ''` converts undefined/null to empty string
- Calculate word count on normalized text for all cases
- Apply the same threshold comparison uniformly

#### Method: `onEndOfTurn` (lines 770-809)
**Before:**
```typescript
if (
  this.stt &&
  this.turnDetection !== 'manual' &&
  this._currentSpeech &&
  this._currentSpeech.allowInterruptions &&
  !this._currentSpeech.interrupted &&
  this.agentSession.options.minInterruptionWords > 0 &&
  info.newTranscript.split(' ').length < this.agentSession.options.minInterruptionWords
) {
  // avoid interruption if the new_transcript is too short
  this.cancelPreemptiveGeneration();
  this.logger.info('skipping user input, new_transcript is too short');
  return false;
}
```

**After:**
```typescript
if (
  this.stt &&
  this.turnDetection !== 'manual' &&
  this._currentSpeech &&
  this._currentSpeech.allowInterruptions &&
  !this._currentSpeech.interrupted &&
  this.agentSession.options.minInterruptionWords > 0
) {
  const wordCount = splitWords(info.newTranscript, true).length;
  if (wordCount < this.agentSession.options.minInterruptionWords) {
    // avoid interruption if the new_transcript contains fewer words than minInterruptionWords
    this.cancelPreemptiveGeneration();
    this.logger.info(
      {
        wordCount,
        minInterruptionWords: this.agentSession.options.minInterruptionWords,
      },
      'skipping user input, word count below minimum interruption threshold',
    );
    return false;
  }
}
```

**Key Changes:**
- Updated to use consistent `splitWords` function (was using `split(' ')` before)
- Separated the word count check from the condition block for clarity
- Added detailed logging with word count and threshold values
- Ensures consistency with `onVADInferenceDone` logic

### 2. File: `agents/src/voice/interruption_detection.test.ts` (NEW)
Comprehensive unit test suite with 23 tests covering:

#### Word Splitting Tests (8 tests)
- Empty string handling
- Single word detection
- Multiple word counting
- Punctuation handling
- Multiple spaces between words
- Whitespace-only strings
- Leading/trailing whitespace

#### Interruption Threshold Logic (5 tests)
- Word count below threshold (should block)
- Word count at threshold (should allow)
- Word count above threshold (should allow)
- Zero threshold behavior (check disabled)
- High threshold behavior

#### Undefined/Null Handling (4 tests)
- Undefined normalization
- Null normalization
- Empty string preservation
- Valid string preservation

#### Integration Tests (6 tests)
- Complete flow for empty string
- Complete flow for undefined
- Complete flow for single word
- Complete flow for exact threshold match
- Complete flow for exceeding threshold
- Consistency between `onVADInferenceDone` and `onEndOfTurn`

## Test Results
```
✓ |nodejs| agents/src/voice/interruption_detection.test.ts (23 tests) 4ms

Test Files  1 passed (1)
      Tests  23 passed (23)
```

All 23 tests pass successfully!

## Impact

### Behavioral Changes
1. **Empty/Undefined Transcripts**: Now blocked by default when `minInterruptionWords > 0`
   - Before: Allowed interruption
   - After: Blocked (0 words < threshold)

2. **Short Utterances**: Consistently blocked based on word count
   - Before: Only blocked for non-empty strings
   - After: All utterances checked uniformly

3. **Word Counting Logic**: Now uses `splitWords()` consistently
   - Before: `onEndOfTurn` used basic `split(' ')`
   - After: Both methods use `splitWords()` with proper punctuation handling

### Configuration
- Applications can still disable word count checking by setting `minInterruptionWords: 0`
- Default value remains `minInterruptionWords: 0` (check disabled by default)

## Benefits
1. **Consistency**: Uniform behavior across all code paths
2. **Predictability**: No edge cases where empty speech bypasses word count check
3. **Robustness**: Explicit normalization prevents undefined/null related issues
4. **Maintainability**: Clear, well-documented code with comprehensive test coverage
5. **Logging**: Enhanced debug information for troubleshooting interruption issues

## Migration Guide
No action required for most users. However, if your application relies on the previous behavior where empty speech could interrupt:
- Set `minInterruptionWords: 0` explicitly to disable word count checking
- Or adjust `minInterruptionWords` to accommodate shorter utterances

## Files Modified
- `agents/src/voice/agent_activity.ts` - Refactored interruption logic
- `agents/src/voice/interruption_detection.test.ts` - NEW comprehensive test suite

## Branch
Created on branch: `mini-interruption`
