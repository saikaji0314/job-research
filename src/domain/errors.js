export class ResearchError extends Error {
  constructor(code, message = code) { super(message); this.name = 'ResearchError'; this.code = code; }
}
export const isPause = error => ['AUTHENTICATION_REQUIRED', 'VERIFICATION_REQUIRED', 'INTERRUPTED', 'BROWSER_CLOSED'].includes(error?.code);
export function abortIfNeeded(signal) {
  if (signal?.aborted) throw new ResearchError('INTERRUPTED', '已中断，进度已保存，可使用 --resume 继续');
}
