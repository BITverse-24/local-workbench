import { useRef, useEffect } from 'react';

type Props = {
  input: string;
  setInput: (v: string) => void;
  plusOpen: boolean;
  setPlusOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  plusBtnRef: React.RefObject<HTMLButtonElement | null>;
  searchActive: boolean;
  setSearchActive: (v: boolean) => void;
  onVoice: () => void;
  onSend?: () => void;
};

export default function InputBar({ input, setInput, plusOpen, setPlusOpen, plusBtnRef, searchActive, setSearchActive, onVoice, onSend }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && onSend) onSend();
    }
    // Shift+Enter: allow default newline insertion (cursor goes to next line)
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // auto-resize up to max-height
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  };

  useEffect(() => {
    if (input === '' && textareaRef.current) {
      textareaRef.current.style.height = '36px';
    }
  }, [input]);

  return (
    <div className="p-3 md:p-4 flex-shrink-0 animate-apple-up delay-300" style={{ background: '#1F1F1F' }}>
      <div className="max-w-3xl mx-auto">
        <div className="relative flex items-end gap-1.5 rounded-[20px] p-2 neu-pressed">
          <button
            ref={plusBtnRef}
            onClick={() => setPlusOpen((o: boolean) => !o)}
            className={`w-9 h-9 rounded-full neu-button grid place-items-center shrink-0 transition-transform duration-300 ${plusOpen ? 'neu-pressed rotate-45' : ''}`}
            title="More options"
            style={{ transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)' }}
          >
            ＋
          </button>
          {searchActive && (
            <span className="group inline-flex items-center gap-0 group-hover:gap-1.5 pl-2 pr-2 group-hover:pr-1 py-1 rounded-full neu-card text-xs shrink-0 animate-apple-scaleIn transition-all duration-200">
              <span className="p-1 rounded-full neu-pressed grid place-items-center shrink-0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
                  <circle cx="11" cy="11" r="7" />
                  <line x1="16.5" y1="16.5" x2="21" y2="21" />
                </svg>
              </span>
              Search
              <button
                onClick={() => setSearchActive(false)}
                className="w-0 h-5 rounded-full neu-button grid place-items-center opacity-0 group-hover:w-5 group-hover:opacity-100 overflow-hidden shrink-0 transition-all duration-200"
                title="Remove search"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </span>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={searchActive ? "Search the web…" : "Ask anything"}
            rows={1}
            className="flex-1 bg-transparent border-none outline-none px-2 md:px-3 py-2 min-w-0 text-sm placeholder:text-white/30 resize-none overflow-y-auto leading-5 max-h-[120px]"
            style={{ height: '36px' }}
          />
          <button onClick={onVoice} className="w-9 h-9 rounded-full neu-button grid place-items-center shrink-0" title="Voice">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="opacity-80">
              <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
              <path d="M19 10a7 7 0 0 1-14 0" />
              <line x1="12" y1="19" x2="12" y2="22" />
              <line x1="8" y1="22" x2="16" y2="22" />
            </svg>
          </button>
          <button onClick={onSend} className="px-5 py-2.5 neu-button-primary font-semibold text-sm shrink-0">Send</button>
        </div>
      </div>
    </div>
  );
}
