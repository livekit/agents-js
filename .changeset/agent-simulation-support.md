---
'@livekit/agents': minor
---

Add agent-simulation support: resolve the scenario dispatch from the job's `lk.simulator.dispatch` attribute into a `SimulationContext`, end the job when the simulator participant leaves, run the new `defineAgent` `onSimulationEnd` callback on `finalizeSimulation`, and disable STT/TTS/VAD and audio I/O under text simulations.
