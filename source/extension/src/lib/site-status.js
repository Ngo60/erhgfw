// Причина, по которой сайт «не подключён». Панель показывает разные подсказки: вкладки нет / мост не отвечает / иная ошибка.

/** @param {{code?:string, message?:string}} err */
export function siteFailure(err = {}) {
  const code = typeof err.code === 'string' ? err.code : 'SITE_ERROR';
  const message = typeof err.message === 'string' ? err.message : '';
  if (code === 'NO_TAB') return { connected: false, tabFound: false, code: 'NO_TAB', reason: message || 'Вкладка сайта не открыта.' };
  if (code === 'TIMEOUT' || code === 'NO_BRIDGE') {
    return { connected: false, tabFound: true, code: 'NO_BRIDGE', reason: 'Сайт открыт, но мост расширения на нём не отвечает: на сайте не установлен мост (docs/04-SERVER-SETUP.md) или открыта старая версия страницы — обновите вкладку (Ctrl+F5).' };
  }
  if (code === 'VERSION_MISMATCH') return { connected: false, tabFound: true, code: 'BRIDGE_VERSION', reason: 'Версия моста на сайте не совпадает с версией расширения: обновите сайт или расширение.' };
  return { connected: false, tabFound: true, code, reason: message || 'Не удалось связаться с сайтом.' };
}
