// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type ChatModels =
  | 'gpt-4o'
  | 'gpt-4o-2024-05-13'
  | 'gpt-4o-mini'
  | 'gpt-4o-mini-2024-07-18'
  | 'gpt-4-turbo'
  | 'gpt-4-turbo-2024-04-09'
  | 'gpt-4-turbo-preview'
  | 'gpt-4-0125-preview'
  | 'gpt-4-1106-preview'
  | 'gpt-4-vision-preview'
  | 'gpt-4-1106-vision-preview'
  | 'gpt-4'
  | 'gpt-4-0314'
  | 'gpt-4-0613'
  | 'gpt-4-32k'
  | 'gpt-4-32k-0314'
  | 'gpt-4-32k-0613'
  | 'gpt-3.5-turbo'
  | 'gpt-3.5-turbo-16k'
  | 'gpt-3.5-turbo-0301'
  | 'gpt-3.5-turbo-0613'
  | 'gpt-3.5-turbo-1106'
  | 'gpt-3.5-turbo-16k-0613';

export type WhisperModels = 'whisper-1';

export type TTSModels = 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts';

export type TTSVoices =
  | 'alloy'
  | 'ash'
  | 'ballad'
  | 'coral'
  | 'echo'
  | 'fable'
  | 'nova'
  | 'onyx'
  | 'sage'
  | 'shimmer'
  | 'verse';

// adapters for OpenAI-compatible LLMs, TTSs, STTs

export type TelnyxChatModels =
  | 'meta-llama/Meta-Llama-3.1-8B-Instruct'
  | 'meta-llama/Meta-Llama-3.1-70B-Instruct';

export type CerebrasChatModels = 'llama3.1-8b' | 'llama3.1-70b';

export type PerplexityChatModels =
  | 'llama-3.1-sonar-small-128k-online'
  | 'llama-3.1-sonar-small-128k-chat'
  | 'llama-3.1-sonar-large-128k-online'
  | 'llama-3.1-sonar-large-128k-chat'
  | 'llama-3.1-8b-instruct'
  | 'llama-3.1-70b-instruct';

export type GroqChatModels =
  | 'llama-3.1-405b-reasoning'
  | 'llama-3.1-70b-versatile'
  | 'llama-3.1-8b-instant'
  | 'llama-3.3-70b-versatile'
  | 'llama3-groq-70b-8192-tool-use-preview'
  | 'llama3-groq-8b-8192-tool-use-preview'
  | 'llama-guard-3-8b'
  | 'llama3-70b-8192'
  | 'llama3-8b-8192'
  | 'mixtral-8x7b-32768'
  | 'gemma-7b-it'
  | 'gemma2-9b-it';

export type GroqAudioModels =
  | 'whisper-large-v3'
  | 'distil-whisper-large-v3-en'
  | 'whisper-large-v3-turbo';

export type DeepSeekChatModels = 'deepseek-coder' | 'deepseek-chat';

export type TogetherChatModels =
  | 'garage-bAInd/Platypus2-70B-instruct'
  | 'google/gemma-2-27b-it'
  | 'google/gemma-2-9b-it'
  | 'google/gemma-2b-it'
  | 'google/gemma-7b-it'
  | 'lmsys/vicuna-13b-v1.5'
  | 'lmsys/vicuna-7b-v1.5'
  | 'meta-llama/Llama-2-13b-chat-hf'
  | 'meta-llama/Llama-2-70b-chat-hf'
  | 'meta-llama/Llama-2-7b-chat-hf'
  | 'meta-llama/Llama-3-70b-chat-hf'
  | 'meta-llama/Llama-3-8b-chat-hf'
  | 'meta-llama/Meta-Llama-3-70B-Instruct-Lite'
  | 'meta-llama/Meta-Llama-3-70B-Instruct-Turbo'
  | 'meta-llama/Meta-Llama-3-8B-Instruct-Lite'
  | 'meta-llama/Meta-Llama-3-8B-Instruct-Turbo'
  | 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo'
  | 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo'
  | 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'
  | 'mistralai/Mistral-7B-Instruct-v0.1'
  | 'mistralai/Mistral-7B-Instruct-v0.2'
  | 'mistralai/Mistral-7B-Instruct-v0.3'
  | 'mistralai/Mixtral-8x22B-Instruct-v0.1'
  | 'mistralai/Mixtral-8x7B-Instruct-v0.1'
  | 'openchat/openchat-3.5-1210'
  | 'snorkelai/Snorkel-Mistral-PairRM-DPO'
  | 'teknium/OpenHermes-2-Mistral-7B'
  | 'teknium/OpenHermes-2p5-Mistral-7B'
  | 'togethercomputer/Llama-2-7B-32K-Instruct'
  | 'togethercomputer/RedPajama-INCITE-7B-Chat'
  | 'togethercomputer/RedPajama-INCITE-Chat-3B-v1'
  | 'togethercomputer/StripedHyena-Nous-7B'
  | 'togethercomputer/alpaca-7b'
  | 'upstage/SOLAR-10.7B-Instruct-v1.0'
  | 'zero-one-ai/Yi-34B-Chat';

export type OctoChatModels =
  | 'meta-llama-3-70b-instruct'
  | 'meta-llama-3.1-405b-instruct'
  | 'meta-llama-3.1-70b-instruct'
  | 'meta-llama-3.1-8b-instruct'
  | 'mistral-7b-instruct'
  | 'mixtral-8x7b-instruct'
  | 'wizardlm-2-8x22bllamaguard-2-7b';

export type XAIChatModels = 'grok-2' | 'grok-2-mini' | 'grok-2-mini-public' | 'grok-2-public';
