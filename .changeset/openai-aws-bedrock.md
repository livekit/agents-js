---
'@livekit/agents-plugin-openai': minor
---

Add Amazon Bedrock support to the OpenAI plugin: `LLM.withAWSBedrock` (Chat Completions, gpt-oss models) and `responses.LLM.withAWSBedrock` (Responses API, gpt-5.5 / gpt-5.4). Both build an `openai` `BedrockOpenAI` client and resolve the regional `bedrock-mantle` endpoint, routing gpt-oss to the `/v1` path and gpt-5.x to `/openai/v1`.
