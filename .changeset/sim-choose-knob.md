---
'@livekit/agents': patch
---

Add `simulation.choose(knob, options, { default })` and `SimulationContext.choices`, so `lk agent simulate --compare llm=gpt-5,gemini` can run each scenario once per option of a knob the agent declares in code. Outside a simulation, or when the run makes no choice for the knob, `choose` returns `options[default]`. The new `simulation` namespace also re-exports the existing simulation APIs, which stay available at the package root.
