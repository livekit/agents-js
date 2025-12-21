import { Plugin } from "@livekit/agents";
import * as beta from "./beta/index.js";
import { LLM, LLMStream } from "./llm.js";
export * from "./models.js";
class GooglePlugin extends Plugin {
  constructor() {
    super({
      title: "google",
      version: "0.1.0",
      package: "@livekit/agents-plugin-google"
    });
  }
}
Plugin.registerPlugin(new GooglePlugin());
export {
  LLM,
  LLMStream,
  beta
};
//# sourceMappingURL=index.js.map