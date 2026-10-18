import { useState, useRef, useEffect } from 'react';

export default function Select({
  value,
  onChange,
  options,
  placeholder = 'Select an option...',
  disabled = false,
  className = '',
  style = {},
  menuFontSize = '0.95rem',   // size of the dropdown list's text; a compact trigger can ask for a matching list
  id
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef(null);
  const listboxId = id ? `${id}-listbox` : undefined;

  const selectedOption = options.find(opt => opt.value === value);

  useEffect(() => {
    const handleMouseDown = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, []);

  useEffect(() => {
    if (isOpen) {
      const index = options.findIndex(opt => opt.value === value);
      setHighlightedIndex(index !== -1 ? index : 0);
    }
  }, [isOpen, value, options]);

  const handleSelect = (selectedValue) => {
    // Provide a mocked event object so existing onChange handlers work seamlessly
    onChange({ target: { value: selectedValue } });
    setIsOpen(false);
  };

  const handleKeyDown = (e) => {
    if (disabled) return;

    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (isOpen) {
          if (options[highlightedIndex]) {
            handleSelect(options[highlightedIndex].value);
          }
        } else {
          setIsOpen(true);
        }
        break;
      case 'Escape':
        if (isOpen) {
          e.preventDefault();
          setIsOpen(false);
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          setHighlightedIndex(prev => (prev + 1) % options.length);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          setHighlightedIndex(prev => (prev - 1 + options.length) % options.length);
        }
        break;
      case 'Tab':
        if (isOpen) setIsOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div 
      className="relative-select-container" 
      style={{ position: 'relative', width: style.width || '100%' }} 
      ref={containerRef}
    >
      <button
        type="button"
        id={id}
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        disabled={disabled}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        className={className}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          textAlign: 'left',
          color: 'var(--text-primary)',
          fontFamily: 'inherit',
          ...style
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {selectedOption?.color && (
            <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: selectedOption.color, flexShrink: 0 }} />
          )}
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <svg 
          width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{
            flexShrink: 0,
            color: 'var(--text-muted)',
            transition: 'transform 0.2s',
            transform: isOpen ? 'rotate(180deg)' : 'none'
          }}
        >
          <path d="m6 9 6 6 6-6"/>
        </svg>
      </button>

      {isOpen && (
        <ul
          id={listboxId}
          role="listbox"
          style={{
            position: 'absolute',
            zIndex: 9999,
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-strong)',
            borderRadius: '12px',
            boxShadow: '0 10px 30px rgba(0,0,0,0.6)',
            maxHeight: '240px',
            overflowY: 'auto',
            padding: '6px',
            margin: 0,
            listStyle: 'none'
          }}
        >
          {options.map((opt, index) => {
            const isSelected = value === opt.value;
            const isHighlighted = highlightedIndex === index;

            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                onClick={() => handleSelect(opt.value)}
                onMouseEnter={() => setHighlightedIndex(index)}
                style={{
                  padding: '10px 12px',
                  fontSize: menuFontSize,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderRadius: '8px',
                  background: isHighlighted ? 'var(--bg-hover)' : 'transparent',
                  color: isSelected ? 'var(--accent-light)' : 'var(--text-primary)',
                  fontWeight: isSelected ? 500 : 400,
                  transition: 'background 0.1s'
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {opt.color && (
                    <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: opt.color, flexShrink: 0 }} />
                  )}
                  {opt.label}
                </span>
                {isSelected && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
