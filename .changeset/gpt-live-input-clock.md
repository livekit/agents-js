---
'@livekit/agents-plugin-openai': patch
'@livekit/agents': patch
---

GPT-Live sessions keep the model's input clock running with silence when no microphone audio is pushed, so text simulations, text-mode consoles and muted input get replies instead of timing out. The text-simulation refusal for duplex models is removed.
