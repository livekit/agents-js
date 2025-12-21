import { GoogleGenAI } from '@google/genai';
import { type APIConnectOptions, tts } from '@livekit/agents';
export type GeminiTTSModels = 'gemini-2.5-flash-preview-tts' | 'gemini-2.5-pro-preview-tts';
export type GeminiVoices = 'Zephyr' | 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Leda' | 'Orus' | 'Aoede' | 'Callirrhoe' | 'Autonoe' | 'Enceladus' | 'Iapetus' | 'Umbriel' | 'Algieba' | 'Despina' | 'Erinome' | 'Algenib' | 'Rasalgethi' | 'Laomedeia' | 'Achernar' | 'Alnilam' | 'Schedar' | 'Gacrux' | 'Pulcherrima' | 'Achird' | 'Zubenelgenubi' | 'Vindemiatrix' | 'Sadachbia' | 'Sadaltager' | 'Sulafat';
export interface TTSOptions {
    model: GeminiTTSModels | string;
    voiceName: GeminiVoices | string;
    vertexai: boolean;
    project?: string;
    location?: string;
    instructions?: string;
}
export declare class TTS extends tts.TTS {
    #private;
    label: string;
    /**
     * Create a new instance of Gemini TTS.
     *
     * Environment Requirements:
     * - For VertexAI: Set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to the path of the service account key file.
     * - For Google Gemini API: Set the `apiKey` argument or the `GOOGLE_API_KEY` environment variable.
     *
     * @param opts - Configuration options for Gemini TTS
     */
    constructor({ model, voiceName, apiKey, vertexai, project, location, instructions, }?: Partial<TTSOptions & {
        apiKey: string;
    }>);
    synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): ChunkedStream;
    /**
     * Update the TTS options.
     *
     * @param opts - Options to update
     */
    updateOptions(opts: {
        voiceName?: GeminiVoices | string;
    }): void;
    stream(): tts.SynthesizeStream;
    get opts(): TTSOptions;
    get client(): GoogleGenAI;
}
export declare class ChunkedStream extends tts.ChunkedStream {
    #private;
    label: string;
    constructor(inputText: string, tts: TTS, connOptions?: APIConnectOptions, abortSignal?: AbortSignal);
    protected run(): Promise<void>;
}
//# sourceMappingURL=gemini_tts.d.ts.map