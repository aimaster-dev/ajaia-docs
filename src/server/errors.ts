/** An error that maps directly onto an HTTP response. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what = 'Document') =>
  new HttpError(404, 'not_found', `${what} not found, or you don't have access to it.`);

export const forbidden = (message: string) => new HttpError(403, 'forbidden', message);

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'validation_error', message, details);
