import type { ErrorCode } from './messages.js';

/** Base class for failures that are part of the contract and map to a protocol or HTTP error. */
export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;
}

export class DocumentNotFoundError extends DomainError {
  readonly code = 'doc_not_found';
  readonly httpStatus = 404;
  constructor(readonly docId: string) {
    super(`document ${docId} does not exist`);
    this.name = 'DocumentNotFoundError';
  }
}

export class ProtocolError extends DomainError {
  readonly httpStatus = 400;
  constructor(
    readonly code: Extract<ErrorCode, 'bad_message' | 'unsupported_version' | 'not_joined' | 'already_joined'>,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export class ForbiddenOperationError extends DomainError {
  readonly code = 'forbidden_op';
  readonly httpStatus = 403;
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenOperationError';
  }
}

export class DocumentClosedError extends DomainError {
  readonly code = 'internal';
  readonly httpStatus = 503;
  constructor(readonly docId: string) {
    super(`document ${docId} is closed`);
    this.name = 'DocumentClosedError';
  }
}
