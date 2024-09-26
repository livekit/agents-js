// # livekit-agents/livekit/agents/omni_assistant/omni_assistant.py

// from typing import Literal, Protocol

// EventTypes = Literal[
//     "user_started_speaking",
//     "user_stopped_speaking",
//     "agent_started_speaking",
//     "agent_stopped_speaking",
// ]

// class AssistantTranscriptionOptions:
//     # Public attributes
//     user_transcription: bool
//     agent_transcription: bool
//     agent_transcription_speed: float
//     sentence_tokenizer: tokenize.SentenceTokenizer
//     word_tokenizer: tokenize.WordTokenizer
//     hyphenate_word: Callable[[str], list[str]]

// class S2SModel(Protocol):
//     # Protocol class, no methods defined

// class OmniAssistant(utils.EventEmitter[EventTypes]):
//     def __init__(
//         self,
//         *,
//         model: S2SModel,
//         vad: vad.VAD | None = None,
//         chat_ctx: llm.ChatContext | None = None,
//         fnc_ctx: llm.FunctionContext | None = None,
//         transcription: AssistantTranscriptionOptions = AssistantTranscriptionOptions(),
//         loop: asyncio.AbstractEventLoop | None = None,
//     ) -> None:
//         # Constructor

//     @property
//     def vad(self) -> vad.VAD | None:
//         # Getter for vad property

//     @property
//     def fnc_ctx(self) -> llm.FunctionContext | None:
//         # Getter for fnc_ctx property

//     @fnc_ctx.setter
//     def fnc_ctx(self, value: llm.FunctionContext | None) -> None:
//         # Setter for fnc_ctx property

//     def start(
//         self, room: rtc.Room, participant: rtc.RemoteParticipant | str | None = None
//     ) -> None:
//         # Public method to start the assistant