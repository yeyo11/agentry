/**
 * What the chat page shows while its conversation is on the way: the shape of one, a person's message
 * and the answer to it, in the loading shimmer. A spinner and a word in the middle of an empty page
 * read as a black screen; this reads as a conversation that is arriving.
 */
export function ChatLoading({ label }: { label: string }) {
  return (
    <div className="chat-loading" role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="chat-loading-turn is-user" aria-hidden>
        <div className="skeleton" style={{ width: '46%' }} />
      </div>
      <div className="chat-loading-turn" aria-hidden>
        <div className="skeleton" style={{ width: '88%' }} />
        <div className="skeleton" style={{ width: '94%' }} />
        <div className="skeleton" style={{ width: '62%' }} />
      </div>
      <div className="chat-loading-turn is-user" aria-hidden>
        <div className="skeleton" style={{ width: '30%' }} />
      </div>
      <div className="chat-loading-turn" aria-hidden>
        <div className="skeleton" style={{ width: '76%' }} />
        <div className="skeleton" style={{ width: '90%' }} />
      </div>
    </div>
  );
}
