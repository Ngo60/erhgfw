import { describe, expect, it } from 'vitest';
import { BUILTIN_PRESETS } from '../src/core/presets.ts';
import { safetyProblems } from '../src/core/safety.ts';
import { normalizeSettings } from '../src/core/settings.ts';
import type { Character } from '../src/core/types.ts';
import { generateScenario } from '../src/engine/generate.ts';
import { installExtensionBridge } from '../src/extension-bridge/bridge.ts';
import type { BridgeWindow } from '../src/extension-bridge/bridge.ts';
import { buildBatch, BridgeFailure, canonicalJson, coreDistance, coreOf, defaultSha256 } from '../src/extension-bridge/build-batch.ts';
import type { Batch } from '../src/extension-bridge/build-batch.ts';
import { BRIDGE_VERSION, CHANNEL_EXT, parseCreateBatch, parseRequest } from '../src/extension-bridge/protocol.ts';
import type { CreateBatchPayload } from '../src/extension-bridge/protocol.ts';

const ORIGIN = 'https://promts.vibecods.xyz';

const payload = (over: Partial<CreateBatchPayload> = {}): CreateBatchPayload => ({
  mode: 'multi',
  characters: 3,
  frames_per_character: 5,
  strategy: 'character',
  preset_id: 'natural-selfie',
  seed: 'RP-TESTSEED',
  profile: 'gpt-image',
  length: 'standard',
  include_negative: true,
  use_site_character: false,
  ...over,
});

const FIXED = () => new Date('2026-10-17T12:00:00.000Z');

describe('protocol: parseRequest', () => {
  const ok = { source: CHANNEL_EXT, version: BRIDGE_VERSION, id: 'req-1', type: 'hello' };
  it('принимает корректный запрос', () => {
    expect(parseRequest(ok).ok).toBe(true);
  });
  it.each([
    [null, 'BAD_REQUEST'],
    [[], 'BAD_REQUEST'],
    [{ ...ok, source: 'evil' }, 'BAD_SOURCE'],
    [{ ...ok, version: 2 }, 'VERSION_MISMATCH'],
    [{ ...ok, id: '' }, 'BAD_ID'],
    [{ ...ok, id: 'a b' }, 'BAD_ID'],
    [{ ...ok, id: 'x'.repeat(65) }, 'BAD_ID'],
    [{ ...ok, type: 'drop-tables' }, 'BAD_TYPE'],
  ])('отклоняет %j', (data, code) => {
    const r = parseRequest(data);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });
});

describe('protocol: parseCreateBatch', () => {
  it('принимает корректные параметры и фиксирует одного персонажа в режиме single', () => {
    const r = parseCreateBatch(payload({ mode: 'single', characters: 99 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.characters).toBe(1);
  });
  it.each([
    [{ characters: 0 }, 'BAD_PAYLOAD'],
    [{ characters: 51 }, 'BAD_PAYLOAD'],
    [{ frames_per_character: 0 }, 'BAD_PAYLOAD'],
    [{ frames_per_character: 101 }, 'BAD_PAYLOAD'],
    [{ characters: 50, frames_per_character: 40 }, 'TOO_LARGE'],
    [{ strategy: 'x' }, 'BAD_PAYLOAD'],
    [{ profile: 'x' }, 'BAD_PAYLOAD'],
    [{ length: 'x' }, 'BAD_PAYLOAD'],
    [{ seed: 'a b' }, 'BAD_PAYLOAD'],
    [{ seed: '' }, 'BAD_PAYLOAD'],
    [{ preset_id: 5 }, 'BAD_PAYLOAD'],
    [{ include_negative: 'yes' }, 'BAD_PAYLOAD'],
    [{ characters: 2.5 }, 'BAD_PAYLOAD'],
  ] as const)('отклоняет %j', (over, code) => {
    const r = parseCreateBatch({ ...payload(), ...over });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });
  it('seed и preset_id могут быть null', () => {
    expect(parseCreateBatch(payload({ seed: null, preset_id: null })).ok).toBe(true);
  });
});

describe('buildBatch на реальном движке', () => {
  it('3 персонажа × 5 кадров: структура, идентификаторы, безопасность, неизменное ядро', async () => {
    const b = await buildBatch(payload(), { origin: ORIGIN, now: FIXED });
    expect(b.schema).toBe('rps-batch/1');
    expect(b.batch_id).toMatch(/^RPS-[0-9a-f]{10}$/);
    expect(b.created_at).toBe('2026-10-17T12:00:00.000Z');
    expect(b.characters).toHaveLength(3);
    const ids = new Set<string>();
    for (const [ci, c] of b.characters.entries()) {
      expect(c.character_id).toBe(`${b.batch_id}-C00${ci + 1}`);
      expect(c.jobs).toHaveLength(5);
      expect(c.identity.fingerprint).toBe(await defaultSha256(canonicalJson(c.identity.core)));
      for (const [ji, j] of c.jobs.entries()) {
        expect(j.image_job_id).toBe(`${c.character_id}-F00${ji + 1}`);
        expect(ids.has(j.image_job_id)).toBe(false);
        ids.add(j.image_job_id);
        expect(j.prompt.length).toBeGreaterThan(200);
        expect(safetyProblems(j.prompt, { allowTextTerms: true })).toEqual([]);
        expect(j.negative).toBeTruthy();
        expect(j.reference).toBeNull();
        expect(j.params.scenario_id).toBeTruthy();
      }
    }
    expect(ids.size).toBe(15);
  });

  it('параметры задания содержат детали селфи и положение головы (для метаданных расширения)', async () => {
    const b = await buildBatch(payload({ characters: 2, frames_per_character: 12, seed: 'RP-SELFIEPARAMS' }), { origin: ORIGIN, now: FIXED });
    const jobs = b.characters.flatMap((c) => c.jobs);
    const selfies = jobs.filter((j) => j.params.selfie_hand !== undefined);
    expect(selfies.length).toBeGreaterThan(3);
    for (const j of selfies) {
      expect(['left', 'right']).toContain(j.params.selfie_hand);
      expect(typeof j.params.selfie_grip).toBe('string');
      expect(typeof j.params.head_pose).toBe('string');
      expect(j.prompt).toContain(j.params.selfie_grip === 'both-hands' ? 'with both hands' : `in her ${String(j.params.selfie_hand)} hand`);
    }
    expect(new Set(selfies.map((j) => j.params.selfie_hand)).size).toBe(2);
    expect(new Set(selfies.map((j) => j.params.head_pose)).size).toBeGreaterThan(2);
  });

  it('идемпотентность: одинаковый запрос → одинаковые id и промпты; другой seed → другой batch_id', async () => {
    const a = await buildBatch(payload(), { origin: ORIGIN, now: FIXED });
    const b = await buildBatch(payload(), { origin: ORIGIN, now: () => new Date('2030-01-01T00:00:00Z') });
    expect(b.batch_id).toBe(a.batch_id);
    expect(b.characters.map((c) => c.jobs.map((j) => j.prompt))).toEqual(a.characters.map((c) => c.jobs.map((j) => j.prompt)));
    const c = await buildBatch(payload({ seed: 'RP-OTHERSEED' }), { origin: ORIGIN, now: FIXED });
    expect(c.batch_id).not.toBe(a.batch_id);
  });

  it('персонажи различаются, внутри персонажа ядро внешности постоянно (20 × 10)', async () => {
    const b = await buildBatch(payload({ characters: 20, frames_per_character: 10, preset_id: null, seed: 'RP-BIGBATCH' }), { origin: ORIGIN, now: FIXED });
    expect(b.characters).toHaveLength(20);
    const flagged = b.characters.filter((c) => c.notes.length > 0).length;
    expect(flagged).toBeLessThanOrEqual(2);
    for (let i = 0; i < b.characters.length; i++)
      for (let j = i + 1; j < b.characters.length; j++) {
        const dist = coreDistance(b.characters[i]!.identity.core, b.characters[j]!.identity.core);
        if (b.characters[i]!.notes.length === 0 && b.characters[j]!.notes.length === 0) expect(dist).toBeGreaterThanOrEqual(1);
      }
    const total = b.characters.reduce((n, c) => n + c.jobs.length, 0);
    expect(total).toBe(200);
  }, 60_000);

  it('серия: один персонаж × 8 кадров, ядро постоянно, меняется только стайлинг', async () => {
    const b = await buildBatch(payload({ mode: 'single', characters: 1, frames_per_character: 8, strategy: 'series' }), { origin: ORIGIN, now: FIXED });
    expect(b.characters).toHaveLength(1);
    expect(b.characters[0]!.jobs).toHaveLength(8);
    const scenes = new Set(b.characters[0]!.jobs.map((j) => j.params.scene_id));
    expect(scenes.size).toBe(8);
  });

  it('использует персонажа сайта как первого персонажа', async () => {
    const s = normalizeSettings({ mode: 'new' }).settings;
    const g = generateScenario({ settings: s, seed: 'SITE-CH', index: 0 });
    if (!g.ok) throw new Error('gen');
    const ch: Character = { id: 'CH-SITE', name: 'Сайт', subject: g.result.scenario.subject, createdAt: 1 };
    const b = await buildBatch(payload({ use_site_character: true, characters: 2 }), { origin: ORIGIN, now: FIXED, siteCharacter: () => ch });
    expect(canonicalJson(b.characters[0]!.identity.core)).toBe(canonicalJson(coreOf(ch.subject)));
    await expect(buildBatch(payload({ use_site_character: true }), { origin: ORIGIN, siteCharacter: () => null })).rejects.toMatchObject({ code: 'NO_SITE_CHARACTER' });
  });

  it('неизвестный пресет и отмена', async () => {
    await expect(buildBatch(payload({ preset_id: 'nope' }), { origin: ORIGIN })).rejects.toBeInstanceOf(BridgeFailure);
    const ctl = new AbortController();
    ctl.abort();
    await expect(buildBatch(payload(), { origin: ORIGIN, signal: ctl.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('использует пользовательский пресет', async () => {
    const user = { id: 'user-1', name: 'Мой', settings: BUILTIN_PRESETS[3]!.settings };
    const b = await buildBatch(payload({ preset_id: 'user-1', characters: 1, mode: 'single', frames_per_character: 3 }), { origin: ORIGIN, userPresets: () => [user] });
    expect(b.characters[0]!.jobs).toHaveLength(3);
  });
});

function makeWin(origin = ORIGIN) {
  const listeners = new Set<(ev: MessageEvent) => void>();
  const sent: Array<Record<string, unknown>> = [];
  const win: BridgeWindow = {
    location: { origin },
    addEventListener: (_t, fn) => void listeners.add(fn),
    removeEventListener: (_t, fn) => void listeners.delete(fn),
    postMessage: (m) => void sent.push(m as Record<string, unknown>),
  };
  const emit = (data: unknown, over: { origin?: string; source?: unknown } = {}): void => {
    for (const l of [...listeners]) l({ data, origin: over.origin ?? origin, source: 'source' in over ? over.source : win } as unknown as MessageEvent);
  };
  const waitFor = async (pred: (m: Record<string, unknown>) => boolean, ms = 30_000): Promise<Record<string, unknown>> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = sent.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('timeout waiting for message');
  };
  return { win, sent, emit, waitFor, listeners };
}

const req = (id: string, type: string, p?: unknown) => ({ source: CHANNEL_EXT, version: BRIDGE_VERSION, id, type, payload: p });

describe('installExtensionBridge', () => {
  it('отвечает на hello и list-presets, содержит встроенные пресеты', async () => {
    const { win, emit, waitFor } = makeWin();
    installExtensionBridge(win);
    emit(req('h1', 'hello'));
    const hello = await waitFor((m) => m.id === 'h1');
    expect(hello).toMatchObject({ source: 'rps-site', version: 1, ok: true, type: 'hello:result' });
    expect((hello.payload as { limits: { maxCharacters: number } }).limits.maxCharacters).toBe(50);
    emit(req('p1', 'list-presets'));
    const pr = await waitFor((m) => m.id === 'p1');
    const ids = (pr.payload as { presets: Array<{ id: string }> }).presets.map((p) => p.id);
    expect(ids).toContain('natural-selfie');
    expect(ids.length).toBeGreaterThanOrEqual(7);
  });

  it('игнорирует чужие origin и source; на мусор с валидным id отвечает ошибкой', async () => {
    const { win, sent, emit, listeners } = makeWin();
    const off = installExtensionBridge(win);
    emit(req('x1', 'hello'), { origin: 'https://evil.example' });
    emit(req('x2', 'hello'), { source: {} });
    emit(req('x3', 'hello'), { source: null });
    emit('строка');
    emit({ source: 'other', id: 'x4', type: 'hello' });
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toHaveLength(0);
    emit({ source: CHANNEL_EXT, version: 1, id: 'x5', type: 'drop-tables' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: 'x5', ok: false, error: { code: 'BAD_TYPE' } });
    off();
    expect(listeners.size).toBe(0);
  });

  it('create-batch: прогресс и результат; повторный параллельный запрос получает BUSY', async () => {
    const { win, sent, emit, waitFor } = makeWin();
    installExtensionBridge(win);
    emit(req('b1', 'create-batch', payload({ characters: 2, frames_per_character: 4 })));
    emit(req('b2', 'create-batch', payload()));
    const busy = await waitFor((m) => m.id === 'b2');
    expect(busy).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    const res = await waitFor((m) => m.id === 'b1' && m.type === 'create-batch:result');
    expect(res.ok).toBe(true);
    const batch = (res.payload as { batch: Batch }).batch;
    expect(batch.characters).toHaveLength(2);
    expect(sent.filter((m) => m.id === 'b1' && m.type === 'create-batch:progress').length).toBe(8);
  });

  it('create-batch: плохие параметры → ошибка без падения; cancel прерывает создание', async () => {
    const { win, emit, waitFor } = makeWin();
    installExtensionBridge(win);
    emit(req('e1', 'create-batch', { mode: 'multi' }));
    expect(await waitFor((m) => m.id === 'e1')).toMatchObject({ ok: false, error: { code: 'BAD_PAYLOAD' } });
    emit(req('c1', 'create-batch', payload({ characters: 30, frames_per_character: 30 })));
    await new Promise((r) => setTimeout(r, 20));
    emit(req('c2', 'cancel', { target: 'c1' }));
    expect(await waitFor((m) => m.id === 'c2')).toMatchObject({ ok: true, payload: { cancelled: true } });
    expect(await waitFor((m) => m.id === 'c1' && m.type === 'create-batch:result')).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  }, 60_000);
});
