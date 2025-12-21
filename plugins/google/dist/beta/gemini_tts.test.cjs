"use strict";
var import_agents_plugin_openai = require("@livekit/agents-plugin-openai");
var import_agents_plugins_test = require("@livekit/agents-plugins-test");
var import_vitest = require("vitest");
var import_gemini_tts = require("./gemini_tts.cjs");
import_vitest.describe.skip("Google Gemini TTS", async () => {
  await (0, import_agents_plugins_test.tts)(new import_gemini_tts.TTS(), new import_agents_plugin_openai.STT());
});
//# sourceMappingURL=gemini_tts.test.cjs.map