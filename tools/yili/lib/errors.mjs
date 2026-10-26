export class YiliError extends Error {
  constructor(message, { code = 'YILI_ERROR', kind = 'unknown', status = null, retryable = false, cause, details } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

export class ConfigError extends YiliError {
  constructor(message, options = {}) {
    super(message, { code: 'CONFIG_ERROR', kind: 'config', ...options });
  }
}

export class AuthError extends YiliError {
  constructor(message, options = {}) {
    super(message, { code: 'AUTH_ERROR', kind: 'auth', ...options });
  }
}

export class CaptchaError extends YiliError {
  constructor(message, options = {}) {
    super(message, { code: 'CAPTCHA_ERROR', kind: 'captcha', retryable: true, ...options });
  }
}

export class ApiError extends YiliError {
  constructor(message, options = {}) {
    super(message, { code: 'API_ERROR', kind: 'api', ...options });
  }
}

export class DataIncompleteError extends YiliError {
  constructor(message, options = {}) {
    super(message, { code: 'DATA_INCOMPLETE', kind: 'data', ...options });
  }
}

export function isAuthFailureCode(code) {
  return Number(code) === 401 || Number(code) === 601;
}
