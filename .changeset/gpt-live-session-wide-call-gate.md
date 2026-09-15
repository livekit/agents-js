---
'@livekit/agents-plugin-openai': patch
---

Continue a GPT-Live response only once every backend function call in the session is answered, instead of only the calls of the one response the plugin tracked per delegation. A continuation sent while another call is still open is refused with function_call_outputs_required, after which the backend never answers again.
