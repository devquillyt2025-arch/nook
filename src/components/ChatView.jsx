import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { loadChatHistory, saveChatHistory, clearChatHistory } from '../utils/chatStore';
import { sendChatMessage } from '../utils/chatClient';
import { genId } from '../utils/id';
import { isAuthConfigured } from '../utils/authClient';
import { useSpeechToText, isSpeechRecognitionSupported } from '../utils/useSpeechToText';
import { useOnlineStatus } from '../utils/useOnlineStatus';
import { useSyncApplied } from '../utils/useSyncApplied';

const speechSynthesisSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

// Plain conversation with Claude — no side effects on Nook's data (see the
// chat-with-claude edge function header for why that's a deliberate
// boundary from the voice-command action router). Replies are spoken aloud
// via the browser's speechSynthesis unless muted.
export default memo(function ChatView() {
  const [messages, setMessages] = useState(loadChatHistory);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  // Another device's messages. Not while a reply is in flight: the send flow owns `messages` until it lands.
  useSyncApplied(['chat_history'], () => {
    if (sending) return false;               // not refreshed → the engine keeps guarding what it merged in
    setMessages(loadChatHistory());
  });
  const online = useOnlineStatus();
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  // Stop any in-flight speech the moment the tab unmounts, or muting is
  // switched on — never let a reply keep talking after the user leaves.
  useEffect(() => () => { speechSynthesisSupported && window.speechSynthesis.cancel(); }, []);
  useEffect(() => { if (muted && speechSynthesisSupported) window.speechSynthesis.cancel(); }, [muted]);

  const speak = useCallback((text) => {
    if (muted || !speechSynthesisSupported) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }, [muted]);

  const send = useCallback(async (text) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setError('');
    const userMsg = { id: genId(), role: 'user', text: trimmed, createdAt: new Date().toISOString() };
    const withUser = saveChatHistory([...messages, userMsg]);
    setMessages(withUser);
    setInput('');
    setSending(true);
    try {
      const reply = await sendChatMessage(withUser.map(m => ({ role: m.role, text: m.text })));
      const assistantMsg = { id: genId(), role: 'assistant', text: reply, createdAt: new Date().toISOString() };
      setMessages(saveChatHistory([...withUser, assistantMsg]));
      speak(reply);
    } catch (err) {
      setError(err?.message || 'Chat request failed');
    } finally {
      setSending(false);
    }
  }, [messages, sending, speak]);

  const { status: micStatus, start: micStart, stop: micStop } = useSpeechToText({
    onResult: (transcript) => send(transcript),
    onEmpty: () => setError('No speech detected'),
    onError: () => setError('Voice input failed — check mic permission'),
  });

  const gateDisabled = !isAuthConfigured || !online;
  const micDisabledReason = !isSpeechRecognitionSupported
    ? "Voice input isn't supported in this browser"
    : !isAuthConfigured
    ? 'Sign in to use voice chat'
    : !online
    ? 'Chat needs a connection'
    : micStatus === 'listening'
    ? 'Listening — release to send'
    : 'Hold to speak';

  const submit = (e) => { e.preventDefault(); send(input); };

  return (
    <div className="chat-view">
      <div className="chat-view-hdr">
        <h2>Chat</h2>
        <div className="chat-view-hdr-actions">
          {speechSynthesisSupported && (
            <button
              type="button"
              className="hdr-btn"
              title={muted ? 'Unmute spoken replies' : 'Mute spoken replies'}
              aria-label={muted ? 'Unmute spoken replies' : 'Mute spoken replies'}
              onClick={() => setMuted(m => !m)}
            >
              {muted ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
              )}
            </button>
          )}
          <button
            type="button"
            className="hdr-btn"
            title="Clear conversation"
            aria-label="Clear conversation"
            onClick={() => { if (confirm('Clear this conversation?')) { clearChatHistory(); setMessages([]); setError(''); } }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>

      <div className="chat-view-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-view-empty">Say or type something to start a conversation. This is just talk — it won't add tasks or notes.</div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`chat-bubble chat-bubble-${m.role}`}>{m.text}</div>
        ))}
        {sending && <div className="chat-bubble chat-bubble-assistant chat-bubble-pending">…</div>}
      </div>

      {error && <div className="chat-view-error">{error}</div>}

      <form className="chat-view-input-row" onSubmit={submit}>
        <input
          ref={inputRef}
          type="text"
          className="form-inp"
          placeholder={gateDisabled ? 'Sign in and connect to chat' : 'Type a message…'}
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={gateDisabled || sending}
        />
        <button
          type="button"
          className={`hdr-btn voice-mic-btn${micStatus === 'listening' ? ' voice-mic-listening' : ''}`}
          title={micDisabledReason}
          aria-label={micDisabledReason}
          disabled={!isSpeechRecognitionSupported || gateDisabled || sending}
          onMouseDown={micStart}
          onMouseUp={micStop}
          onMouseLeave={micStop}
          onTouchStart={e => { e.preventDefault(); micStart(); }}
          onTouchEnd={micStop}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        </button>
        <button type="submit" className="btn-submit" disabled={gateDisabled || sending || !input.trim()}>Send</button>
      </form>
    </div>
  );
});
