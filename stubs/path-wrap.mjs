export * from '@zenfs/core/path';
import * as _fromPath from '@zenfs/core/path';
export const posix = _fromPath;
export const win32 = _fromPath;
const _default = { ..._fromPath, posix: _fromPath, win32: _fromPath };
export { _default as default };
