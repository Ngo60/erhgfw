// Метаданные пакета: manifest.json, character.json, prompts.jsonl и экспорт журнала.
import { EXT_BY_FORMAT } from './naming.js';

export const csvCell = (value) => {
  let v = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

export function dataUrl(text, mime = 'application/json') {
  return `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
}

export function jobRecord(job) {
  const r = job.result;
  return {
    image_job_id: job.image_job_id,
    index: job.index,
    status: job.status,
    prompt: job.prompt,
    negative: job.negative,
    params: job.params,
    styling: job.styling,
    file: r?.file ?? null,
    files: r?.files ?? null,
    format: r?.format ?? null,
    bytes: r?.bytes ?? null,
    width: r?.width ?? null,
    height: r?.height ?? null,
    sha256: r?.sha256 ?? null,
    attempts: job.attempts,
    started_at: job.started_at ?? null,
    completed_at: job.completed_at ?? null,
    error: job.error ? { code: job.error.code, message: job.error.message } : null,
  };
}

export function buildPromptsJsonl(jobs) {
  return jobs.map((j) => JSON.stringify(jobRecord(j))).join('\n') + '\n';
}

export function buildCharacterJson(batch, ch) {
  return {
    schema: 'rps-character/1',
    batch_id: batch.batch_id,
    character_id: ch.character_id,
    index: ch.index,
    name: ch.name,
    folder: ch.folder,
    seed: ch.seed,
    identity: ch.identity,
    notes: ch.notes,
    frames: ch.job_ids.length,
    note: 'identity.core — неизменяемое ядро внешности; изменяемые параметры кадра лежат в prompts.jsonl (params, styling).',
  };
}

export function buildManifest(batch, jobsByChar, nowIso) {
  const totals = { total: 0, completed: 0, failed: 0 };
  const characters = batch.characters.map((ch) => {
    const jobs = jobsByChar.get(ch.character_id) ?? [];
    for (const j of jobs) {
      totals.total += 1;
      if (j.status === 'completed') totals.completed += 1;
      if (j.status === 'failed') totals.failed += 1;
    }
    return {
      character_id: ch.character_id,
      index: ch.index,
      name: ch.name,
      folder: ch.folder,
      identity: ch.identity,
      jobs: jobs.map((j) => ({ image_job_id: j.image_job_id, index: j.index, status: j.status, file: j.result?.file ?? null })),
    };
  });
  return {
    schema: 'rps-manifest/1',
    batch_id: batch.batch_id,
    folder: batch.folder,
    kind: batch.kind,
    created_at: batch.created_at,
    updated_at: nowIso,
    source: batch.source,
    spec: batch.spec,
    totals,
    characters,
  };
}

const LOG_COLUMNS = ['seq', 'ts', 'level', 'state', 'job_id', 'code', 'message'];

export function logToCsv(events) {
  const rows = events.map((e) => LOG_COLUMNS.map((c) => csvCell(e[c])).join(','));
  return `\uFEFF${LOG_COLUMNS.join(',')}\r\n${rows.join('\r\n')}\r\n`;
}

export function logToJson(events, batchId) {
  return JSON.stringify({ app: 'RealPhoto ChatGPT Batch', batch_id: batchId, count: events.length, events }, null, 2);
}

export const formatExt = (format) => EXT_BY_FORMAT[format] ?? 'bin';
