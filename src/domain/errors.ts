/** Errors whose message is safe to show to the user (no personal data, no internals). */
export class DomainError extends Error {
  override name = 'DomainError';
}

export class NotFoundError extends DomainError {
  override name = 'NotFoundError';
  constructor(entity: string, id: number) {
    super(`${entity} ${String(id)} not found`);
  }
}

export class InvalidInputError extends DomainError {
  override name = 'InvalidInputError';
}
