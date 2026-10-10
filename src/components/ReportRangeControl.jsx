import DateInput from './DateInput';

// "This Week / This Month / Custom" selector shared by both Reports views, so
// switching between them keeps the same period. `range` is
// { mode, customStart, customEnd }; `onChange` is a useState setter.
export default function ReportRangeControl({ range, onChange }) {
  const set = patch => onChange(r => ({ ...r, ...patch }));
  return (
    <>
      <div className="ra-seg" role="group" aria-label="Time range">
        {[['week', 'This Week'], ['month', 'This Month'], ['custom', 'Custom']].map(([m, l]) => (
          <button key={m} className={range.mode === m ? 'ra-seg-on' : ''} onClick={() => set({ mode: m })} aria-pressed={range.mode === m}>{l}</button>
        ))}
      </div>
      {range.mode === 'custom' && (
        <div className="ra-custom">
          <DateInput value={range.customStart} max={range.customEnd || undefined} onChange={e => set({ customStart: e.target.value })} aria-label="Start date" />
          <span>→</span>
          <DateInput value={range.customEnd} min={range.customStart || undefined} onChange={e => set({ customEnd: e.target.value })} aria-label="End date" />
        </div>
      )}
    </>
  );
}
