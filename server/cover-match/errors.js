export class CoverLookupError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
