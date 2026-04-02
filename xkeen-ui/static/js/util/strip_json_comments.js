export function stripJsonComments(input) {
  const s = typeof input === 'string' ? input : String(input ?? '');
  let res = [];
  let inString = false;
  let escape = false;
  let i = 0;
  const length = s.length;

  while (i < length) {
    const ch = s[i];

    if (inString) {
      res.push(ch);
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      res.push(ch);
      i += 1;
      continue;
    }

    if (ch === '/' && i + 1 < length && s[i + 1] === '/') {
      i += 2;
      while (i < length && s[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '#') {
      i += 1;
      while (i < length && s[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && i + 1 < length && s[i + 1] === '*') {
      i += 2;
      while (i + 1 < length && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    res.push(ch);
    i += 1;
  }

  return res.join('');
}

export default stripJsonComments;
