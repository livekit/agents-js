export type EOUModelType = 'basic' | 'en' | 'multilingual';

export const MAX_HISTORY_TOKENS = 128;
export const MAX_HISTORY_TURNS = 6;

export const MODEL_REVISIONS: Record<EOUModelType, string> = {
  basic: 'v1.2.0',
  en: 'v1.2.2-en',
  multilingual: 'v0.2.0-intl',
};

export const HG_MODEL = 'livekit/turn-detector';

export const ONNX_FILENAME = 'model_q8.onnx';
