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
var _Mutex_locking, _Mutex_locks, _Mutex_limit, _Queue_limit, _Queue_events, _Future_await;
import { AudioFrame, TrackSource } from '@livekit/rtc-node';
import { EventEmitter, once } from 'events';
/**
 * Merge one or more {@link AudioFrame}s into a single one.
 *
 * @param buffer Either an {@link AudioFrame} or a list thereof
 * @throws
 * {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/TypeError
 * | TypeError} if sample rate or channel count are mismatched
 */
export const mergeFrames = (buffer) => {
    if (Array.isArray(buffer)) {
        buffer = buffer;
        if (buffer.length == 0) {
            throw new TypeError('buffer is empty');
        }
        const sampleRate = buffer[0].sampleRate;
        const channels = buffer[0].channels;
        let samplesPerChannel = 0;
        let data = new Int16Array();
        for (const frame of buffer) {
            if (frame.sampleRate !== sampleRate) {
                throw new TypeError('sample rate mismatch');
            }
            if (frame.channels !== channels) {
                throw new TypeError('channel count mismatch');
            }
            data = new Int16Array([...data, ...frame.data]);
            samplesPerChannel += frame.samplesPerChannel;
        }
        return new AudioFrame(data, sampleRate, channels, samplesPerChannel);
    }
    return buffer;
};
export const findMicroTrackId = (room, identity) => {
    var _a;
    let p = room.remoteParticipants.get(identity);
    if (identity === ((_a = room.localParticipant) === null || _a === void 0 ? void 0 : _a.identity)) {
        p = room.localParticipant;
    }
    if (!p) {
        throw new Error(`participant ${identity} not found`);
    }
    // find first micro track
    let trackId;
    p.trackPublications.forEach((track) => {
        if (track.source === TrackSource.SOURCE_MICROPHONE) {
            trackId = track.sid;
            return;
        }
    });
    if (!trackId) {
        throw new Error(`participant ${identity} does not have a microphone track`);
    }
    return trackId;
};
/** @internal */
export class Mutex {
    constructor(limit = 1) {
        _Mutex_locking.set(this, void 0);
        _Mutex_locks.set(this, void 0);
        _Mutex_limit.set(this, void 0);
        __classPrivateFieldSet(this, _Mutex_locking, Promise.resolve(), "f");
        __classPrivateFieldSet(this, _Mutex_locks, 0, "f");
        __classPrivateFieldSet(this, _Mutex_limit, limit, "f");
    }
    isLocked() {
        return __classPrivateFieldGet(this, _Mutex_locks, "f") >= __classPrivateFieldGet(this, _Mutex_limit, "f");
    }
    async lock() {
        __classPrivateFieldSet(this, _Mutex_locks, __classPrivateFieldGet(this, _Mutex_locks, "f") + 1, "f");
        let unlockNext;
        const willLock = new Promise((resolve) => (unlockNext = () => {
            __classPrivateFieldSet(this, _Mutex_locks, __classPrivateFieldGet(this, _Mutex_locks, "f") - 1, "f");
            resolve();
        }));
        const willUnlock = __classPrivateFieldGet(this, _Mutex_locking, "f").then(() => unlockNext);
        __classPrivateFieldSet(this, _Mutex_locking, __classPrivateFieldGet(this, _Mutex_locking, "f").then(() => willLock), "f");
        return willUnlock;
    }
}
_Mutex_locking = new WeakMap(), _Mutex_locks = new WeakMap(), _Mutex_limit = new WeakMap();
/** @internal */
export class Queue {
    constructor(limit) {
        /** @internal */
        this.items = [];
        _Queue_limit.set(this, void 0);
        _Queue_events.set(this, new EventEmitter());
        __classPrivateFieldSet(this, _Queue_limit, limit, "f");
    }
    async get() {
        if (this.items.length === 0) {
            await once(__classPrivateFieldGet(this, _Queue_events, "f"), 'put');
        }
        const item = this.items.shift();
        __classPrivateFieldGet(this, _Queue_events, "f").emit('get');
        return item;
    }
    async put(item) {
        if (__classPrivateFieldGet(this, _Queue_limit, "f") && this.items.length >= __classPrivateFieldGet(this, _Queue_limit, "f")) {
            await once(__classPrivateFieldGet(this, _Queue_events, "f"), 'get');
        }
        this.items.push(item);
        __classPrivateFieldGet(this, _Queue_events, "f").emit('put');
    }
}
_Queue_limit = new WeakMap(), _Queue_events = new WeakMap();
/** @internal */
export class Future {
    constructor() {
        _Future_await.set(this, new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        }));
    }
    get await() {
        return __classPrivateFieldGet(this, _Future_await, "f");
    }
    resolve() { }
    reject(_) {
        _;
    }
}
_Future_await = new WeakMap();
//# sourceMappingURL=utils.js.map