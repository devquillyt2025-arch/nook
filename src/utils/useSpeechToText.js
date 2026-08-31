import { useState, useRef, useCallback } from 'react';

const SpeechRecognitionCtor = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

export const isSpeechRecognitionSupported = Boolean(SpeechRecognitionCtor);

// Push-to-talk speech-to-text, shared by VoiceCommandButton (dispatches a
// parsed command) and ChatView's mic (sends a chat message) — both need the
// same start/stop/result plumbing, just different things done with the
// transcript once captured.
//
// Call start() on press, stop() on release. status is 'idle' | 'listening'.
// onResult(transcript) fires once with the final non-empty transcript;
// onEmpty() fires instead if the mic was released with nothing captured.
export function useSpeechToText({ onResult, onEmpty, onError } = {}) {
  const [status, setStatus] = useState('idle');
  const recognitionRef = useRef(null);
  const gotResultRef = useRef(false);
  const callbacksRef = useRef({ onResult, onEmpty, onError });
  callbacksRef.current = { onResult, onEmpty, onError };

  const start = useCallback(() => {
    if (!SpeechRecognitionCtor || status !== 'idle') return;
    const rec = new SpeechRecognitionCtor();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    gotResultRef.current = false;

    rec.onresult = (e) => {
      gotResultRef.current = true;
      const transcript = e.results?.[0]?.[0]?.transcript?.trim() || '';
      if (transcript) callbacksRef.current.onResult?.(transcript);
      else callbacksRef.current.onEmpty?.();
      setStatus('idle');
    };
    rec.onerror = () => { callbacksRef.current.onError?.(); setStatus('idle'); };
    rec.onend = () => {
      // onresult/onerror already moved status past 'listening'; only reset
      // here for the release-with-no-speech-captured case.
      if (!gotResultRef.current) setStatus(s => (s === 'listening' ? 'idle' : s));
    };

    recognitionRef.current = rec;
    setStatus('listening');
    try { rec.start(); } catch { setStatus('idle'); }
  }, [status]);

  const stop = useCallback(() => {
    if (status === 'listening') recognitionRef.current?.stop();
  }, [status]);

  return { status, start, stop };
}
