export type BoundedLineEvent = { kind: 'line'; value: string } | { kind: 'too-large' };

export async function* readBoundedLines(
  input: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<BoundedLineEvent> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError('maxBytes must be a nonnegative safe integer');

  let chunks: Buffer[] = [];
  let bytes = 0;
  let lastByte: number | undefined;
  let discarding = false;

  for await (const inputChunk of input) {
    const chunk = Buffer.isBuffer(inputChunk) ? inputChunk : Buffer.from(inputChunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      let event: BoundedLineEvent | undefined;

      if (!discarding) {
        const nextBytes = bytes + segment.length;
        const nextLastByte = segment.length > 0 ? segment[segment.length - 1] : lastByte;
        const contentBytes = newline >= 0 && nextLastByte === 0x0d ? nextBytes - 1 : nextBytes;
        const pendingCrLf = newline < 0 && nextBytes === maxBytes + 1 && nextLastByte === 0x0d;

        if (contentBytes > maxBytes && !pendingCrLf) {
          event = { kind: 'too-large' };
          discarding = newline < 0;
          chunks = [];
          bytes = 0;
          lastByte = undefined;
        } else {
          if (segment.length > 0) chunks.push(segment);
          bytes = nextBytes;
          lastByte = nextLastByte;
          if (newline >= 0) {
            event = {
              kind: 'line',
              value: Buffer.concat(chunks, bytes).subarray(0, contentBytes).toString('utf8'),
            };
          }
        }
      }

      if (newline < 0) {
        offset = chunk.length;
      } else {
        offset = newline + 1;
        chunks = [];
        bytes = 0;
        lastByte = undefined;
        discarding = false;
      }
      if (event) yield event;
    }
  }

  if (discarding || bytes === 0) return;
  if (bytes > maxBytes) {
    yield { kind: 'too-large' };
    return;
  }
  yield { kind: 'line', value: Buffer.concat(chunks, bytes).toString('utf8') };
}
