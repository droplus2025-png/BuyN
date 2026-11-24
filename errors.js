// Every refusal of the engine is an EngineError with a stable code the UI can translate.
export class EngineError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'EngineError';
    this.code = code;
    this.details = details;
  }
}
export const fail = (code, message, details) => { throw new EngineError(code, message, details); };
