// Why a file cannot be shown. The message names the reason and the structure that failed, never the file's contents
// or its part names, so it is safe to log.

export type ViewerErrorReason = 'too_big' | 'damaged' | 'encrypted' | 'unsupported';

export class ViewerError extends Error {
  override readonly name = 'ViewerError';
  readonly reason: ViewerErrorReason;

  constructor(reason: ViewerErrorReason, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.reason = reason;
  }
}
