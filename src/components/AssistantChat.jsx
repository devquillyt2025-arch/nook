import { useState, useRef, useEffect } from 'react';
import { askAssistant } from '../utils/aiAssistant';
import { askConfirm } from '../utils/confirmDialog';

export default function AssistantChat({ isOpen, onClose }) {
  const [messages, setMessages] = useState(() => {
    try {
      const stored = localStorage.getItem('nook_ai_chat_history');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    try {
      localStorage.setItem('nook_ai_chat_history', JSON.stringify(messages));
    } catch {}
  }, [messages]);

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  if (!isOpen) return null;

  const handleSend = async (e) => {
    e?.preventDefault();
    if (!input.trim() || isTyping) return;

    const question = input.trim();
    setInput('');
    const newMessages = [...messages, { role: 'user', content: question }];
    setMessages(newMessages);
    setIsTyping(true);

    try {
      const answer = await askAssistant(messages, question);
      setMessages([...newMessages, { role: 'assistant', content: answer }]);
    } catch (err) {
      setMessages([...newMessages, { role: 'assistant', content: `Error: ${err.message}` }]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleClear = async () => {
    if (await askConfirm({ title: 'Clear chat history?', message: "The whole conversation will be deleted. This can't be undone.", confirmLabel: 'Clear' })) {
      setMessages([]);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      bottom: 20,
      right: 20,
      width: 380,
      height: 600,
      maxHeight: '80vh',
      maxWidth: '90vw',
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 16,
      boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 9999,
      overflow: 'hidden'
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'var(--surface-nested)'
      }}>
        <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '1.2rem' }}>✨</span> AI Assistant
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleClear} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.8rem' }}>Clear</button>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }}>&times;</button>
        </div>
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12
      }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)', marginTop: 40, fontSize: '0.9rem' }}>
            Ask me anything about your tasks, habits, or schedule!
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{
            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
            background: msg.role === 'user' ? 'var(--accent)' : 'var(--surface-nested)',
            color: msg.role === 'user' ? '#fff' : 'var(--text-primary)',
            padding: '8px 12px',
            borderRadius: 12,
            borderBottomRightRadius: msg.role === 'user' ? 4 : 12,
            borderBottomLeftRadius: msg.role === 'assistant' ? 4 : 12,
            maxWidth: '85%',
            fontSize: '0.9rem',
            lineHeight: 1.4,
            whiteSpace: 'pre-wrap'
          }}>
            {msg.content}
          </div>
        ))}
        {isTyping && (
          <div style={{ alignSelf: 'flex-start', padding: '8px 12px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Typing...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Form */}
      <form onSubmit={handleSend} style={{
        padding: 12,
        borderTop: '1px solid var(--border)',
        display: 'flex',
        gap: 8,
        background: 'var(--surface-nested)'
      }}>
        <input 
          type="text" 
          value={input} 
          onChange={e => setInput(e.target.value)}
          placeholder="Ask about your data..." 
          style={{
            flex: 1,
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            fontSize: '0.9rem'
          }}
        />
        <button 
          type="submit" 
          disabled={!input.trim() || isTyping}
          style={{
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            padding: '0 16px',
            cursor: (!input.trim() || isTyping) ? 'not-allowed' : 'pointer',
            opacity: (!input.trim() || isTyping) ? 0.5 : 1,
            fontWeight: 600
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
