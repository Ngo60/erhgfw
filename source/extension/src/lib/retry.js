// Задержки повтора: нарастающие, ограниченные. Это пауза для временных ошибок, а не средство обхода лимитов
// (ограничения сервиса приводят к остановке очереди, а не к повтору).

export function backoffMs(attempt, baseMs = 15_000, maxMs = 300_000) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export function networkBackoffMs(failures) {
  return Math.min(120_000, 10_000 * 2 ** Math.max(0, Math.min(failures, 4) - 1));
}
