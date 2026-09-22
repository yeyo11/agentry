/**
 * A minimal reader for the server's `GET /api/events` stream. The main process has `fetch` but no
 * `EventSource`, and the monitor only needs each event's name and id, so this is the part of the
 * text/event-stream format the server writes: `id:`, `event:`, `data:` fields, `:` comments,
 * events ended by a blank line, chunks cut anywhere.
 */

export interface SseEvent {
  type: string;
  data: string;
  id: string | null;
}

export class SseParser {
  private buffer = '';
  private type = '';
  private data: string[] = [];
  private id: string | null = null;

  /** Feeds a chunk and returns the events it completed */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let newline: number;
    while ((newline = this.buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.buffer.slice(0, newline);
      // A lone \r at the end of a chunk may be the first half of \r\n: wait for the next chunk
      if (this.buffer[newline] === '\r' && newline === this.buffer.length - 1) break;
      this.buffer = this.buffer.slice(newline + (this.buffer.startsWith('\r\n', newline) ? 2 : 1));
      if (line === '') {
        if (this.data.length || this.type) events.push({ type: this.type || 'message', data: this.data.join('\n'), id: this.id });
        this.type = '';
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') this.type = value;
      else if (field === 'data') this.data.push(value);
      else if (field === 'id') this.id = value;
    }
    return events;
  }
}
