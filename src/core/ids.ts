const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Short, collision-resistant ids. Never shown in the UI. */
export function newId(prefix = ''): string {
  let s = '';
  const buf = new Uint8Array(12);
  cryptoFill(buf);
  for (let i = 0; i < buf.length; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return prefix + s;
}

function cryptoFill(buf: Uint8Array) {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto?.getRandomValues) g.crypto.getRandomValues(buf);
  else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
}
