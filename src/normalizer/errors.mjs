export const ErrorCodes = Object.freeze({
  ODD_UTF16_LENGTH: 'odd_utf16_length',
  INVALID_SURROGATE: 'invalid_surrogate',
  INVALID_UTF8: 'invalid_utf8',
});

export class NormalizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NormalizationError';
    this.code = code;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}
