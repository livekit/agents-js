"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __reExport = (target, mod, secondTarget) => (__copyProps(target, mod, "default"), secondTarget && __copyProps(secondTarget, mod, "default"));
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var index_exports = {};
__export(index_exports, {
  LLM: () => import_llm.LLM,
  LLMStream: () => import_llm.LLMStream,
  beta: () => beta
});
module.exports = __toCommonJS(index_exports);
var import_agents = require("@livekit/agents");
var beta = __toESM(require("./beta/index.cjs"), 1);
var import_llm = require("./llm.cjs");
__reExport(index_exports, require("./models.cjs"), module.exports);
class GooglePlugin extends import_agents.Plugin {
  constructor() {
    super({
      title: "google",
      version: "0.1.0",
      package: "@livekit/agents-plugin-google"
    });
  }
}
import_agents.Plugin.registerPlugin(new GooglePlugin());
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LLM,
  LLMStream,
  beta,
  ...require("./models.cjs")
});
//# sourceMappingURL=index.cjs.map