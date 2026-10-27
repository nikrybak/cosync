export class CrdtError extends Error {
  constructor(
    readonly code: 'out_of_range' | 'integrity' | 'invalid_snapshot',
    message: string,
  ) {
    super(message);
    this.name = 'CrdtError';
  }
}
