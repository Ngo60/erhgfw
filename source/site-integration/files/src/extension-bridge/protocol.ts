// Версионированный протокол обмена «страница сайта ↔ расширение Chrome» (канал window.postMessage).
// Сайт остаётся единственным источником логики генерации; расширение только исполняет очередь.
import { LENGTHS, PROFILES } from '../core/vocab.ts';
import type { Length, Profile } from '../core/vocab.ts';

export const BRIDGE_VERSION = 1;
export const CHANNEL_EXT = 'rps-extension';
export const CHANNEL_SITE = 'rps-site';
export const BATCH_SCHEMA = 'rps-batch/1';

export const LIMITS = { maxCharacters: 50, maxFrames: 100, maxTotalJobs: 1500 } as const;

export const STRATEGIES = ['character', 'series'] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const REQUEST_TYPES = ['hello', 'list-presets', 'create-batch', 'cancel'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export interface BridgeError {
  code: string;
  message: string;
}

export interface BridgeRequest {
  source: typeof CHANNEL_EXT;
  version: number;
  id: string;
  type: RequestType;
  payload?: unknown;
}

export interface BridgeResponse {
  source: typeof CHANNEL_SITE;
  version: number;
  id: string;
  type: string;
  ok: boolean;
  payload?: unknown;
  error?: BridgeError;
}

export interface CreateBatchPayload {
  mode: 'single' | 'multi';
  characters: number;
  frames_per_character: number;
  strategy: Strategy;
  /** null — текущие настройки на странице сайта. */
  preset_id: string | null;
  /** null — сайт выберет случайный seed. */
  seed: string | null;
  profile: Profile;
  length: Length;
  include_negative: boolean;
  /** Использовать персонажа, сохранённого на сайте, как первого персонажа партии. */
  use_site_character: boolean;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: BridgeError };

const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const SEED_RE = /^[A-Za-z0-9._~:-]{1,64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (code: string, message: string): { ok: false; error: BridgeError } => ({ ok: false, error: { code, message } });

export function parseRequest(data: unknown): Parsed<BridgeRequest> {
  if (!isObj(data)) return fail('BAD_REQUEST', 'Сообщение должно быть объектом.');
  if (data.source !== CHANNEL_EXT) return fail('BAD_SOURCE', 'Неизвестный источник сообщения.');
  if (data.version !== BRIDGE_VERSION) return fail('VERSION_MISMATCH', `Поддерживается только версия протокола ${BRIDGE_VERSION}.`);
  if (typeof data.id !== 'string' || !ID_RE.test(data.id)) return fail('BAD_ID', 'Некорректный идентификатор запроса.');
  if (typeof data.type !== 'string' || !(REQUEST_TYPES as readonly string[]).includes(data.type)) return fail('BAD_TYPE', 'Неизвестный тип запроса.');
  return { ok: true, value: { source: CHANNEL_EXT, version: BRIDGE_VERSION, id: data.id, type: data.type as RequestType, payload: data.payload } };
}

function intIn(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

export function parseCreateBatch(payload: unknown): Parsed<CreateBatchPayload> {
  if (!isObj(payload)) return fail('BAD_PAYLOAD', 'Нужен объект параметров партии.');
  const mode = payload.mode;
  if (mode !== 'single' && mode !== 'multi') return fail('BAD_PAYLOAD', 'mode: «single» или «multi».');
  const characters = mode === 'single' ? 1 : intIn(payload.characters, 1, LIMITS.maxCharacters);
  if (characters === null) return fail('BAD_PAYLOAD', `characters: целое от 1 до ${LIMITS.maxCharacters}.`);
  const frames = intIn(payload.frames_per_character, 1, LIMITS.maxFrames);
  if (frames === null) return fail('BAD_PAYLOAD', `frames_per_character: целое от 1 до ${LIMITS.maxFrames}.`);
  if (characters * frames > LIMITS.maxTotalJobs) return fail('TOO_LARGE', `Партия больше лимита ${LIMITS.maxTotalJobs} изображений.`);
  const strategy = payload.strategy;
  if (typeof strategy !== 'string' || !(STRATEGIES as readonly string[]).includes(strategy)) return fail('BAD_PAYLOAD', 'strategy: «character» или «series».');
  const preset = payload.preset_id;
  if (preset !== null && (typeof preset !== 'string' || !ID_RE.test(preset))) return fail('BAD_PAYLOAD', 'preset_id: строка или null.');
  const seed = payload.seed;
  if (seed !== null && (typeof seed !== 'string' || !SEED_RE.test(seed))) return fail('BAD_PAYLOAD', 'seed: 1–64 символа [A-Za-z0-9._~:-] или null.');
  if (typeof payload.profile !== 'string' || !(PROFILES as readonly string[]).includes(payload.profile)) return fail('BAD_PAYLOAD', 'profile: неизвестный профиль.');
  if (typeof payload.length !== 'string' || !(LENGTHS as readonly string[]).includes(payload.length)) return fail('BAD_PAYLOAD', 'length: неизвестная длина.');
  if (typeof payload.include_negative !== 'boolean' || typeof payload.use_site_character !== 'boolean') return fail('BAD_PAYLOAD', 'include_negative и use_site_character должны быть boolean.');
  return {
    ok: true,
    value: {
      mode,
      characters,
      frames_per_character: frames,
      strategy: strategy as Strategy,
      preset_id: preset as string | null,
      seed: seed as string | null,
      profile: payload.profile as Profile,
      length: payload.length as Length,
      include_negative: payload.include_negative,
      use_site_character: payload.use_site_character,
    },
  };
}
