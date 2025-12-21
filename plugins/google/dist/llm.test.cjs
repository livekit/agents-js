"use strict";
var import_agents_plugins_test = require("@livekit/agents-plugins-test");
var import_vitest = require("vitest");
var import_llm = require("./llm.cjs");
(0, import_vitest.describe)("Google", async () => {
  await (0, import_agents_plugins_test.llm)(
    new import_llm.LLM({
      model: "gemini-2.5-flash",
      temperature: 0
    }),
    true
  );
});
//# sourceMappingURL=llm.test.cjs.map