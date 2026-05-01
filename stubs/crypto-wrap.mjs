import * as _crypto from '../node_modules/crypto-browserify/index.js';
export * from '../node_modules/crypto-browserify/index.js';
export { _crypto as default };

// Node.js 14.17+ crypto.randomUUID — polyfill
export const randomUUID = () => {
  const arr = new Uint8Array(16);
  _crypto.randomFillSync(arr);
  arr[6] = (arr[6] & 0x0f) | 0x40;
  arr[8] = (arr[8] & 0x3f) | 0x80;
  const hex = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
};
