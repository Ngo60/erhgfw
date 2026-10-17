// Мост страницы: принимает запросы расширения (через content script) и отвечает данными движка.
// Принимаются только сообщения этого же окна и этого же origin; формат строго проверяется.
import { BUILTIN_PRESETS, cleanName, MAX_USER_PRESETS } from '../core/presets.ts';
import type { Preset } from '../core/presets.ts';
import { normalizeSettings } from '../core/settings.ts';
import type { Settings } from '../core/settings.ts';
import type { Character } from '../core/types.ts';
import { LENGTHS, PROFILES } from '../core/vocab.ts';
import { ENGINE_VERSION } from '../engine/compose.ts';
import { normalizeCharacter } from '../storage/config.ts';
import { browserStore, loadJSON } from '../storage/local.ts';
import { buildBatch, BridgeFailure } from './build-batch.ts';
import { BRIDGE_VERSION, CHANNEL_SITE, LIMITS, parseCreateBatch, parseRequest, STRATEGIES } from './protocol.ts';
import type { BridgeError, BridgeRequest, BridgeResponse } from './protocol.ts';

export interface BridgeWindow {
  location: { origin: string };
  addEventListener(type: 'message', fn: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (ev: MessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

function readSiteSettings(): Settings {
  return normalizeSettings(loadJSON<unknown>(browserStore(), 'settings', null)).settings;
}

function readUserPresets(): Preset[] {
  const raw = loadJSON<unknown>(browserStore(), 'presets', []);
  if (!Array.isArray(raw)) return [];
  const out: Preset[] = [];
  for (const p of raw.slice(0, MAX_USER_PRESETS)) {
    if (typeof p !== 'object' || p === null) continue;
    const r = p as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.name !== 'string') continue;
    out.push({ id: r.id, name: cleanName(r.name) || 'Без названия', settings: normalizeSettings(r.settings).settings });
  }
  return out;
}

function readSiteCharacter(): Character | null {
  return normalizeCharacter(loadJSON<unknown>(browserStore(), 'character', null));
}

export function installExtensionBridge(win: BridgeWindow = window as unknown as BridgeWindow): () => void {
  const origin = win.location.origin;
  const running = new Map<string, AbortController>();

  const reply = (req: { id: string }, type: string, ok: boolean, payload?: unknown, error?: BridgeError): void => {
    const msg: BridgeResponse = { source: CHANNEL_SITE, version: BRIDGE_VERSION, id: req.id, type, ok, ...(payload !== undefined ? { payload } : {}), ...(error ? { error } : {}) };
    win.postMessage(msg, origin);
  };

  const handle = async (req: BridgeRequest): Promise<void> => {
    switch (req.type) {
      case 'hello': {
        const hasCharacter = readSiteCharacter() !== null;
        reply(req, 'hello:result', true, {
          app: 'RealPhoto Prompt Studio',
          engine: ENGINE_VERSION,
          bridge_version: BRIDGE_VERSION,
          limits: LIMITS,
          strategies: STRATEGIES,
          profiles: PROFILES,
          lengths: LENGTHS,
          site_character: hasCharacter,
        });
        return;
      }
      case 'list-presets': {
        const all = [...BUILTIN_PRESETS.map((p) => ({ ...p, builtin: true })), ...readUserPresets().map((p) => ({ ...p, builtin: false }))];
        reply(req, 'list-presets:result', true, { presets: all.map((p) => ({ id: p.id, name: p.name, description: p.description ?? '', builtin: p.builtin })) });
        return;
      }
      case 'cancel': {
        const target = typeof req.payload === 'object' && req.payload !== null ? (req.payload as { target?: unknown }).target : null;
        const ctl = typeof target === 'string' ? running.get(target) : undefined;
        ctl?.abort();
        reply(req, 'cancel:result', true, { cancelled: Boolean(ctl) });
        return;
      }
      case 'create-batch': {
        const parsed = parseCreateBatch(req.payload);
        if (!parsed.ok) return reply(req, 'create-batch:result', false, undefined, parsed.error);
        if (running.size > 0) return reply(req, 'create-batch:result', false, undefined, { code: 'BUSY', message: 'Сайт уже создаёт другую партию.' });
        const ctl = new AbortController();
        running.set(req.id, ctl);
        try {
          const batch = await buildBatch(parsed.value, {
            origin,
            siteSettings: readSiteSettings,
            userPresets: readUserPresets,
            siteCharacter: readSiteCharacter,
            signal: ctl.signal,
            pause: () => new Promise((r) => setTimeout(r, 0)),
            onProgress: (done, total) => reply(req, 'create-batch:progress', true, { done, total }),
          });
          reply(req, 'create-batch:result', true, { batch });
        } catch (e) {
          if (e instanceof BridgeFailure) reply(req, 'create-batch:result', false, undefined, { code: e.code, message: e.message });
          else reply(req, 'create-batch:result', false, undefined, { code: 'INTERNAL', message: 'Внутренняя ошибка движка при создании партии.' });
        } finally {
          running.delete(req.id);
        }
        return;
      }
    }
  };

  const onMessage = (ev: MessageEvent): void => {
    if (ev.source !== (win as unknown) || ev.origin !== origin) return;
    const parsed = parseRequest(ev.data);
    if (!parsed.ok) {
      const id = typeof ev.data === 'object' && ev.data !== null && typeof (ev.data as { id?: unknown }).id === 'string' ? (ev.data as { id: string }).id : null;
      const source = typeof ev.data === 'object' && ev.data !== null ? (ev.data as { source?: unknown }).source : null;
      if (id !== null && source === 'rps-extension' && /^[A-Za-z0-9._:-]{1,64}$/.test(id)) reply({ id }, 'error', false, undefined, parsed.error);
      return;
    }
    void handle(parsed.value);
  };

  win.addEventListener('message', onMessage);
  return () => win.removeEventListener('message', onMessage);
}
