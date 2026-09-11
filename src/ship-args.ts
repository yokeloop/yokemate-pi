const TICKET_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

export function parseShipArgs(
  words: readonly string[],
  allowJoinedStamp = false,
): { ticket: string; tail: string[] } {
  const stop = words.indexOf("--model");
  const head = stop === -1 ? words : words.slice(0, stop);
  const keys: string[] = [];
  const tail: string[] = [];
  for (const word of head) {
    if (TICKET_KEY.test(word)) {
      keys.push(word);
      continue;
    }
    const joined = allowJoinedStamp ? word.split("+") : [];
    if (joined.length > 1 && joined.every((key) => TICKET_KEY.test(key))) {
      keys.push(...joined);
      continue;
    }
    tail.push(word);
  }
  return {
    ticket: keys.join("+"),
    tail: [...tail, ...(stop === -1 ? [] : words.slice(stop))],
  };
}
