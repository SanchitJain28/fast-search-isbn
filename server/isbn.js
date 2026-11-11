export function isbn10To13(isbn) {
  if (!/^\d{9}[\dX]$/.test(isbn)) return '';
  const checksum = [...isbn].reduce((sum, digit, index) => sum + (10 - index) * (digit === 'X' ? 10 : Number(digit)), 0);
  if (checksum % 11) return '';
  const prefix = `978${isbn.slice(0, 9)}`;
  return prefix + checkDigit13(prefix);
}

function checkDigit13(prefix) {
  const sum = [...prefix].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
  return String((10 - sum % 10) % 10);
}

export function parsePrintedIsbn(value) {
  const printed = String(value ?? '').normalize('NFKC').trim().toUpperCase()
    .replace(/^ISBN(?:[\p{Dash_Punctuation}\s]?(?:10|13)(?=[:\s]))?\s*:?\s*/u, '')
    .replace(/[\s\p{Dash_Punctuation}]+/gu, '');
  if (/^97[89]\d{10}$/.test(printed) && checkDigit13(printed.slice(0, 12)) === printed[12]) return printed;
  return isbn10To13(printed);
}
