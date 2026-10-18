// Ошибки адаптеров (страница ChatGPT, загрузка файлов) и команд пользователя.

export class AdapterError extends Error {
  constructor(code, message, extra = {}) {
    super(message ?? code);
    this.name = 'AdapterError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}
