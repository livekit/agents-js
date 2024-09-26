// # livekit-plugins/livekit-plugins-openai/livekit/plugins/openai/realtime/realtime_model.py

// class RealtimeModel:
//     def __init__(self, ...)
//     def session(self, ...) -> RealtimeSession
//     async def aclose(self) -> None

// class RealtimeSession(utils.EventEmitter[EventTypes]):
//     class InputAudioBuffer:
//         def append(self, frame: rtc.AudioFrame) -> None
//         def clear(self) -> None
//         def commit(self) -> None

//     class ConversationItem:
//         def create(self, message: llm.ChatMessage, previous_item_id: str | None = None) -> None
//         def truncate(self, *, item_id: str, content_index: int, audio_end_ms: int) -> None
//         def delete(self, *, item_id: str) -> None

//     class Conversation:
//         @property
//         def item(self) -> RealtimeSession.ConversationItem

//     class Response:
//         def create(self) -> None
//         def cancel(self) -> None

//     def __init__(self, ...)
//     async def aclose(self) -> None
//     @property
//     def chat_ctx(self) -> llm.ChatContext
//     @property
//     def fnc_ctx(self) -> llm.FunctionContext | None
//     @fnc_ctx.setter
//     def fnc_ctx(self, fnc_ctx: llm.FunctionContext | None) -> None
//     @property
//     def default_conversation(self) -> Conversation
//     @property
//     def input_audio_buffer(self) -> InputAudioBuffer
//     @property
//     def response(self) -> Response
//     def session_update(self, ...) -> None

// # Dataclasses
// @dataclass
// class InputTranscriptionCompleted:
//     item_id: str
//     transcript: str

// @dataclass
// class InputTranscriptionFailed:
//     item_id: str
//     message: str

// @dataclass
// class RealtimeResponse:
//     id: str
//     status: api_proto.ResponseStatus
//     output: list[RealtimeOutput]
//     done_fut: asyncio.Future[None]

// @dataclass
// class RealtimeOutput:
//     response_id: str
//     item_id: str
//     output_index: int
//     role: api_proto.Role
//     type: Literal["message", "function_call"]
//     content: list[RealtimeContent]
//     done_fut: asyncio.Future[None]

// @dataclass
// class RealtimeToolCall:
//     name: str
//     arguments: str
//     tool_call_id: str

// @dataclass
// class RealtimeContent:
//     response_id: str
//     item_id: str
//     output_index: int
//     content_index: int
//     text: str
//     audio: list[rtc.AudioFrame]
//     text_stream: AsyncIterable[str]
//     audio_stream: AsyncIterable[rtc.AudioFrame]
//     tool_calls: list[RealtimeToolCall]