// Конечный автомат раннера: единственный источник допустимых переходов (см. docs/02-CONTRACT.md §4).

export const TRANSITIONS = Object.freeze({
  idle: ['preparing'],
  preparing: ['submitting', 'retryable_error', 'blocked', 'paused', 'failed', 'completed', 'idle'],
  submitting: ['waiting', 'downloading', 'retryable_error', 'blocked', 'paused', 'failed', 'idle'],
  waiting: ['downloading', 'retryable_error', 'blocked', 'paused', 'failed', 'idle'],
  downloading: ['verifying', 'retryable_error', 'blocked', 'paused', 'failed', 'idle'],
  verifying: ['completed', 'retryable_error', 'failed', 'blocked', 'paused', 'idle'],
  completed: ['preparing', 'paused', 'idle'],
  retryable_error: ['preparing', 'failed', 'paused', 'blocked', 'idle'],
  paused: ['preparing', 'idle'],
  blocked: ['preparing', 'idle'],
  failed: ['preparing', 'paused', 'idle'],
});

export const canTransition = (from, to) => from === to || (TRANSITIONS[from]?.includes(to) ?? false);

export class IllegalTransition extends Error {
  constructor(from, to) {
    super(`Недопустимый переход автомата: ${from} → ${to}`);
    this.name = 'IllegalTransition';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}
