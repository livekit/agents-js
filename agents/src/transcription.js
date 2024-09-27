var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _BasicTranscriptionForwarder_room, _BasicTranscriptionForwarder_participantIdentity, _BasicTranscriptionForwarder_trackSid, _BasicTranscriptionForwarder_currentText, _BasicTranscriptionForwarder_totalAudioDuration, _BasicTranscriptionForwarder_currentPlayoutTime, _BasicTranscriptionForwarder_DEFAULT_CHARS_PER_SECOND, _BasicTranscriptionForwarder_charsPerSecond, _BasicTranscriptionForwarder_messageId, _BasicTranscriptionForwarder_isRunning;
import { log } from './log.js';
export class BasicTranscriptionForwarder {
    constructor(room, participantIdentity, trackSid, messageId) {
        _BasicTranscriptionForwarder_room.set(this, void 0);
        _BasicTranscriptionForwarder_participantIdentity.set(this, void 0);
        _BasicTranscriptionForwarder_trackSid.set(this, void 0);
        _BasicTranscriptionForwarder_currentText.set(this, '');
        _BasicTranscriptionForwarder_totalAudioDuration.set(this, 0);
        _BasicTranscriptionForwarder_currentPlayoutTime.set(this, 0);
        _BasicTranscriptionForwarder_DEFAULT_CHARS_PER_SECOND.set(this, 16);
        _BasicTranscriptionForwarder_charsPerSecond.set(this, __classPrivateFieldGet(this, _BasicTranscriptionForwarder_DEFAULT_CHARS_PER_SECOND, "f"));
        _BasicTranscriptionForwarder_messageId.set(this, void 0);
        _BasicTranscriptionForwarder_isRunning.set(this, false);
        this.currentCharacterIndex = 0;
        this.textIsComplete = false;
        this.audioIsComplete = false;
        __classPrivateFieldSet(this, _BasicTranscriptionForwarder_room, room, "f");
        __classPrivateFieldSet(this, _BasicTranscriptionForwarder_participantIdentity, participantIdentity, "f");
        __classPrivateFieldSet(this, _BasicTranscriptionForwarder_trackSid, trackSid, "f");
        __classPrivateFieldSet(this, _BasicTranscriptionForwarder_messageId, messageId, "f");
    }
    start() {
        if (!__classPrivateFieldGet(this, _BasicTranscriptionForwarder_isRunning, "f")) {
            __classPrivateFieldSet(this, _BasicTranscriptionForwarder_isRunning, true, "f");
            this.startPublishingLoop().catch((error) => {
                log().error('Error in publishing loop:', error);
                __classPrivateFieldSet(this, _BasicTranscriptionForwarder_isRunning, false, "f");
            });
        }
    }
    pushAudio(frame) {
        __classPrivateFieldSet(this, _BasicTranscriptionForwarder_totalAudioDuration, __classPrivateFieldGet(this, _BasicTranscriptionForwarder_totalAudioDuration, "f") + frame.samplesPerChannel / frame.sampleRate, "f");
    }
    pushText(text) {
        __classPrivateFieldSet(this, _BasicTranscriptionForwarder_currentText, __classPrivateFieldGet(this, _BasicTranscriptionForwarder_currentText, "f") + text, "f");
    }
    markTextComplete() {
        this.textIsComplete = true;
        this.adjustTimingIfBothFinished();
    }
    markAudioComplete() {
        this.audioIsComplete = true;
        this.adjustTimingIfBothFinished();
    }
    adjustTimingIfBothFinished() {
        if (this.textIsComplete && this.audioIsComplete) {
            const actualDuration = __classPrivateFieldGet(this, _BasicTranscriptionForwarder_totalAudioDuration, "f");
            if (actualDuration > 0 && __classPrivateFieldGet(this, _BasicTranscriptionForwarder_currentText, "f").length > 0) {
                __classPrivateFieldSet(this, _BasicTranscriptionForwarder_charsPerSecond, __classPrivateFieldGet(this, _BasicTranscriptionForwarder_currentText, "f").length / actualDuration, "f");
            }
        }
    }
    computeSleepInterval() {
        return Math.min(Math.max(1 / __classPrivateFieldGet(this, _BasicTranscriptionForwarder_charsPerSecond, "f"), 0.0625), 0.5);
    }
    async startPublishingLoop() {
        __classPrivateFieldSet(this, _BasicTranscriptionForwarder_isRunning, true, "f");
        let sleepInterval = this.computeSleepInterval();
        let isComplete = false;
        while (__classPrivateFieldGet(this, _BasicTranscriptionForwarder_isRunning, "f") && !isComplete) {
            __classPrivateFieldSet(this, _BasicTranscriptionForwarder_currentPlayoutTime, __classPrivateFieldGet(this, _BasicTranscriptionForwarder_currentPlayoutTime, "f") + sleepInterval, "f");
            this.currentCharacterIndex = Math.floor(__classPrivateFieldGet(this, _BasicTranscriptionForwarder_currentPlayoutTime, "f") * __classPrivateFieldGet(this, _BasicTranscriptionForwarder_charsPerSecond, "f"));
            isComplete = this.textIsComplete && this.currentCharacterIndex >= __classPrivateFieldGet(this, _BasicTranscriptionForwarder_currentText, "f").length;
            await this.publishTranscription(false);
            if (__classPrivateFieldGet(this, _BasicTranscriptionForwarder_isRunning, "f") && !isComplete) {
                sleepInterval = this.computeSleepInterval();
                await new Promise((resolve) => setTimeout(resolve, sleepInterval * 1000));
            }
        }
        if (__classPrivateFieldGet(this, _BasicTranscriptionForwarder_isRunning, "f")) {
            this.close(false);
        }
    }
    async publishTranscription(final) {
        var _a;
        const textToPublish = __classPrivateFieldGet(this, _BasicTranscriptionForwarder_currentText, "f").slice(0, this.currentCharacterIndex);
        await ((_a = __classPrivateFieldGet(this, _BasicTranscriptionForwarder_room, "f").localParticipant) === null || _a === void 0 ? void 0 : _a.publishTranscription({
            participantIdentity: __classPrivateFieldGet(this, _BasicTranscriptionForwarder_participantIdentity, "f"),
            trackSid: __classPrivateFieldGet(this, _BasicTranscriptionForwarder_trackSid, "f"),
            segments: [
                {
                    text: textToPublish,
                    final: final,
                    id: __classPrivateFieldGet(this, _BasicTranscriptionForwarder_messageId, "f"),
                    startTime: BigInt(0),
                    endTime: BigInt(0),
                    language: '',
                },
            ],
        }));
    }
    async close(interrupt) {
        __classPrivateFieldSet(this, _BasicTranscriptionForwarder_isRunning, false, "f");
        // Publish whatever we had as final
        if (!interrupt) {
            this.currentCharacterIndex = __classPrivateFieldGet(this, _BasicTranscriptionForwarder_currentText, "f").length;
        }
        await this.publishTranscription(true);
    }
}
_BasicTranscriptionForwarder_room = new WeakMap(), _BasicTranscriptionForwarder_participantIdentity = new WeakMap(), _BasicTranscriptionForwarder_trackSid = new WeakMap(), _BasicTranscriptionForwarder_currentText = new WeakMap(), _BasicTranscriptionForwarder_totalAudioDuration = new WeakMap(), _BasicTranscriptionForwarder_currentPlayoutTime = new WeakMap(), _BasicTranscriptionForwarder_DEFAULT_CHARS_PER_SECOND = new WeakMap(), _BasicTranscriptionForwarder_charsPerSecond = new WeakMap(), _BasicTranscriptionForwarder_messageId = new WeakMap(), _BasicTranscriptionForwarder_isRunning = new WeakMap();
//# sourceMappingURL=transcription.js.map