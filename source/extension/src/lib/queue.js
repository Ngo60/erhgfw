// Состояние партии/заданий из проверенной партии rps-batch/1 и выбор следующего задания.
import { IN_FLIGHT } from './constants.js';
import { characterFolderName } from './naming.js';

export const emptyTotals = () => ({ total: 0, completed: 0, failed: 0, pending: 0, active: 0, retryable: 0 });

export function computeTotals(jobs) {
  const t = emptyTotals();
  for (const j of jobs) {
    t.total += 1;
    if (j.status === 'completed') t.completed += 1;
    else if (j.status === 'failed') t.failed += 1;
    else if (j.status === 'pending') t.pending += 1;
    else if (j.status === 'retryable_error') t.retryable += 1;
    else if (IN_FLIGHT.has(j.status)) t.active += 1;
  }
  return t;
}

/** Номер партии за день (Batch_2026-10-17_001, _002 …); метаданные хранят счётчик, чтобы имена не повторялись. */
export function nextCounter(meta, dateStr, kind) {
  const key = `${kind}:${dateStr}`;
  const n = (meta.day_counters?.[key] ?? 0) + 1;
  return { n, meta: { ...meta, day_counters: { ...(meta.day_counters ?? {}), [key]: n } } };
}

export function createBatchState(batch, { folder, kind, nowIso }) {
  const jobs = [];
  const characters = batch.characters.map((c) => {
    const job_ids = [];
    for (const j of c.jobs) {
      job_ids.push(j.image_job_id);
      jobs.push({
        image_job_id: j.image_job_id,
        batch_id: batch.batch_id,
        character_id: c.character_id,
        character_index: c.index,
        index: j.index,
        global_index: jobs.length + 1,
        prompt: j.prompt,
        negative: j.negative,
        styling: j.styling,
        params: j.params,
        status: 'pending',
        attempts: 0,
        error: null,
        submitted: null,
        candidates: null,
        downloads: null,
        result: null,
        retry_at: 0,
        started_at: null,
        completed_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      });
    }
    return { character_id: c.character_id, index: c.index, name: c.name, seed: c.seed, identity: c.identity, notes: c.notes, folder: characterFolderName(c.index), job_ids };
  });
  const header = {
    batch_id: batch.batch_id,
    kind,
    status: 'ready',
    folder,
    created_at: batch.created_at,
    added_at: nowIso,
    source: batch.source,
    spec: batch.spec,
    characters,
    totals: computeTotals(jobs),
  };
  return { header, jobs };
}

/**
 * Следующее задание: сначала недоделанное (в полёте), затем ожидающие, затем повторы, у которых наступило время.
 * @returns {{job:object|null, waitUntil:number|null}}
 */
export function pickNextJob(jobsOrdered, nowMs) {
  let waitUntil = null;
  for (const j of jobsOrdered) if (IN_FLIGHT.has(j.status)) return { job: j, waitUntil: null };
  for (const j of jobsOrdered) {
    if (j.status === 'pending') return { job: j, waitUntil: null };
    if (j.status === 'retryable_error') {
      if ((j.retry_at ?? 0) <= nowMs) return { job: j, waitUntil: null };
      waitUntil = waitUntil === null ? j.retry_at : Math.min(waitUntil, j.retry_at);
    }
  }
  return { job: null, waitUntil };
}

export const hasPendingWork = (jobs) => jobs.some((j) => j.status === 'pending' || j.status === 'retryable_error' || IN_FLIGHT.has(j.status));
