import { useState } from 'react';
import { motion } from 'framer-motion';
import { rangeBounds, habitRangeStats, perHabitConsistency, tasksDoneInRange, focusInRange, delta } from '../trackers/reportsAnalytics';
import Select from './Select';

// The summary step and the habit picker read the REAL Habits / Tasks / Focus data, with the
// same maths as Reports. (They used to read the legacy `nook-trackers`, so anyone on the current
// Habits tab saw zeros and "No habits found." `trackers` is now only needed for legacy targets.)
export default function WeeklyReviewModal({ trackers = [], habits = [], tasks, pomodoroLog, onClose, onSave }) {
  const [step, setStep] = useState(1);
  
  // Reflection state
  const [wentWell, setWentWell] = useState('');
  const [wasHard, setWasHard] = useState('');
  const [nextFocus, setNextFocus] = useState('');
  const [rating, setRating] = useState(3);
  
  // Intentions state
  const [selectedHabits, setSelectedHabits] = useState([]);
  const [selectedTarget, setSelectedTarget] = useState('');

  // Auto-generated summary: the last 7 days against the 7 before them
  const r = rangeBounds('week');
  const habitNow = habitRangeStats(habits, r.start, r.end), habitPrev = habitRangeStats(habits, r.prevStart, r.prevEnd);
  const tasksNow = tasksDoneInRange(tasks, r.start, r.end), tasksPrev = tasksDoneInRange(tasks, r.prevStart, r.prevEnd);
  const focusNow = focusInRange(pomodoroLog, r.start, r.end), focusPrev = focusInRange(pomodoroLog, r.prevStart, r.prevEnd);
  const ranked = perHabitConsistency(habits, r.start, r.end).filter(h => h.due > 0);   // best first
  const bestHabit = ranked[0] || null;
  const worstHabit = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  const vsPrev = (cur, prev, unit = '') => { const d = delta(cur, prev); return d.dir === 'flat' ? 'same as the week before' : `${d.dir === 'up' ? '↑' : '↓'} ${Math.abs(d.diff)}${unit} vs the week before`; };
  const pickableHabits = habits.filter(h => !h.archived);
  const targets = trackers.filter(t => t.type === 'target');   // legacy: nothing creates these any more

  const toggleHabit = (id) => {
    setSelectedHabits(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length < 3) return [...prev, id];
      return prev;
    });
  };

  const handleSave = () => {
    const reviewData = {
      date: new Date().toISOString(),
      wentWell,
      wasHard,
      nextFocus,
      rating,
      focusHabits: selectedHabits,
      focusTarget: selectedTarget
    };
    onSave(reviewData);
  };

  return (
    <motion.div
      className="modal-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
    >
      <motion.div
        className="modal-box modal-box-wide"
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 24, scale: 0.97 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-hdr">
          <h3>Weekly Review</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        
        <div className="modal-body" style={{ minHeight: 400, padding: 24 }}>
          {/* Step 1: Summary */}
          {step === 1 && (
            <div className="review-step">
              <h4 style={{ marginBottom: 16 }}>Step 1: Your last 7 days</h4>
              <div className="detail-stats-grid">
                <div className="stat-card">
                  <div className="stat-val">{tasksNow}</div>
                  <div className="stat-lbl">Tasks completed</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>{vsPrev(tasksNow, tasksPrev)}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-val">{habitNow.due ? `${habitNow.rate}%` : '—'}</div>
                  <div className="stat-lbl">Habit completion</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>{habitNow.due && habitPrev.due ? vsPrev(habitNow.rate, habitPrev.rate, 'pt') : `${habitNow.done}/${habitNow.due} scheduled`}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-val">{focusNow.sessions}</div>
                  <div className="stat-lbl">Focus sessions</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>{vsPrev(focusNow.sessions, focusPrev.sessions)}</div>
                </div>
              </div>

              <div style={{ marginTop: 24, display: 'flex', gap: 16 }}>
                {bestHabit && (
                  <div style={{ flex: 1, background: 'var(--color-green-bg)', padding: 16, borderRadius: 12 }}>
                    <h5 style={{ color: 'var(--color-green)', marginBottom: 8 }}>🏆 Top Performing</h5>
                    <p style={{ fontWeight: 600 }}>{bestHabit.name}</p>
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{bestHabit.rate}% ({bestHabit.done}/{bestHabit.due})</p>
                  </div>
                )}
                {worstHabit && (
                  <div style={{ flex: 1, background: 'var(--color-red-bg)', padding: 16, borderRadius: 12 }}>
                    <h5 style={{ color: 'var(--color-red)', marginBottom: 8 }}>⚠️ Needs Attention</h5>
                    <p style={{ fontWeight: 600 }}>{worstHabit.name}</p>
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{worstHabit.rate}% ({worstHabit.done}/{worstHabit.due})</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 2: Reflection */}
          {step === 2 && (
            <div className="review-step">
              <h4 style={{ marginBottom: 16 }}>Step 2: Reflection</h4>
              
              <div className="form-group">
                <label>What went well this week?</label>
                <textarea className="modal-input" rows={3} value={wentWell} onChange={e => setWentWell(e.target.value)} spellCheck="true" autoCorrect="on" />
              </div>
              
              <div className="form-group">
                <label>What made it hard?</label>
                <textarea className="modal-input" rows={3} value={wasHard} onChange={e => setWasHard(e.target.value)} spellCheck="true" autoCorrect="on" />
              </div>
              
              <div className="form-group">
                <label>One thing to focus on next week</label>
                <textarea className="modal-input" rows={2} value={nextFocus} onChange={e => setNextFocus(e.target.value)} spellCheck="true" autoCorrect="on" />
              </div>

              <div className="form-group" style={{ marginTop: 16 }}>
                <label>Rate your week</label>
                <div style={{ display: 'flex', gap: 8, fontSize: '1.5rem', cursor: 'pointer' }}>
                  {[1,2,3,4,5].map(star => (
                    <span key={star} onClick={() => setRating(star)} style={{ color: rating >= star ? 'var(--color-amber)' : 'var(--text-muted)' }}>
                      ★
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Intentions */}
          {step === 3 && (
            <div className="review-step">
              <h4 style={{ marginBottom: 16 }}>Step 3: Next Week's Intentions</h4>
              
              <div className="form-group">
                <label>Pick 3 habits to prioritize ({selectedHabits.length}/3)</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 150, overflowY: 'auto', padding: 8, background: 'var(--bg-hover)', borderRadius: 8 }}>
                  {pickableHabits.map(h => (
                    <label key={h.id} className="custom-checkbox-wrapper">
                      <input type="checkbox" checked={selectedHabits.includes(h.id)} onChange={() => toggleHabit(h.id)} disabled={!selectedHabits.includes(h.id) && selectedHabits.length >= 3} />
                      {h.name}
                    </label>
                  ))}
                  {pickableHabits.length === 0 && <span style={{ color: 'var(--text-muted)' }}>No habits yet — add some in the Habits tab.</span>}
                </div>
              </div>

              {/* Targets are a legacy tracker type nothing creates any more — only offer them if some still exist. */}
              {targets.length > 0 && (
                <div className="form-group" style={{ marginTop: 16 }}>
                  <label>Set one target to focus on</label>
                  <Select
                    className="modal-input"
                    value={selectedTarget}
                    onChange={e => setSelectedTarget(e.target.value)}
                    options={[
                      { value: '', label: '-- Select a target --' },
                      ...targets.map(t => ({ value: t.id, label: t.name })),
                    ]}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', padding: '16px 20px', borderTop: '1px solid var(--border)' }}>
          {step > 1 ? (
            <button className="secondary-btn" style={{ minWidth: 80, height: 40, borderRadius: 8, background: 'transparent' }} onClick={() => setStep(step - 1)}>Back</button>
          ) : <div></div>}
          
          {step < 3 ? (
            <button className="primary-btn" style={{ minWidth: 80, height: 40, borderRadius: 8 }} onClick={() => setStep(step + 1)}>Next</button>
          ) : (
            <button className="primary-btn" style={{ minWidth: 80, height: 40, borderRadius: 8 }} onClick={handleSave}>Finish Review</button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
