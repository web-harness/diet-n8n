// Wraps the 'url' polyfill with missing Node.js exports.
// Must NOT re-export from 'url' directly — the resolve.fallback maps
// 'url' → this file, which would create a circular import.
import * as _url from '../node_modules/url/url.js';
export * from '../node_modules/url/url.js';
export { _url as default };
export const URL = _url.Url;

export const fileURLToPath = (urlOrString) => {
  if (typeof urlOrString === 'string') {
    return urlOrString.replace(/^file:\/\//, '');
  }
  return urlOrString.pathname || '';
};

export const pathToFileURL = (pathStr) => {
  if (/^[a-zA-Z]:/.test(pathStr) || pathStr.startsWith('/')) {
    return new _url.Url('file://' + pathStr);
  }
  if (pathStr.startsWith('file://')) {
    return new _url.Url(pathStr);
  }
  throw new TypeError('Invalid path');
};
