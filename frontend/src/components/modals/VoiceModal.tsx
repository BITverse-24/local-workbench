type Props = {
  open: boolean;
  devices: MediaDeviceInfo[];
  selectedMicId: string;
  setSelectedMicId: (id: string) => void;
  isRecording: boolean;
  recTime: number;
  recordedBlob: Blob | null;
  setRecordedBlob: (b: Blob | null) => void;
  transcript: string;
  interimTranscript: string;
  error: string | null;
  onClose: () => void;
  onStart: () => void;
  onStop: () => void;
  onUseTranscript: () => void;
};

export default function VoiceModal({ open, devices, selectedMicId, setSelectedMicId, isRecording, recTime, recordedBlob, setRecordedBlob, transcript, interimTranscript, error, onClose, onStart, onStop, onUseTranscript }: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-[520px] rounded-[var(--radius-md)] neu-panel p-5 bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${isRecording ? 'bg-[var(--status-error)]' : 'bg-[var(--text-tertiary)]'}`} />
            {isRecording ? 'Recording…' : recordedBlob ? 'Recorded' : 'Voice'}
            {isRecording && <span className="text-xs font-mono text-[var(--text-tertiary)]">{String(Math.floor(recTime / 60)).padStart(2, '0')}:{String(recTime % 60).padStart(2, '0')}</span>}
          </h3>
          <button onClick={onClose} className="w-7 h-7 rounded-[var(--radius-sm)] neu-button grid place-items-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
        </div>

        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs text-[var(--text-tertiary)] shrink-0">Mic</span>
          <select value={selectedMicId} onChange={(e) => setSelectedMicId(e.target.value)} className="flex-1 rounded-[var(--radius-sm)] neu-input px-3 py-1.5 text-xs text-[var(--text-primary)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] outline-none" disabled={isRecording}>
            {devices.length === 0 && <option>Default microphone</option>}
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0, 6)}`}</option>
            ))}
          </select>
          <span className="w-7 h-7 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] grid place-items-center shrink-0 text-[var(--text-secondary)]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" /><path d="M19 10a7 7 0 0 1-14 0" /></svg>
          </span>
        </div>

        {error && <div className="mb-3 text-xs text-[var(--status-error)] rounded-[var(--radius-sm)] neu-card border border-[var(--status-error)]/40 p-2.5">{error}</div>}

        <div className="rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-subtle)] p-6 flex flex-col items-center justify-center gap-2" style={{ height: 120 }}>
          <div className={`w-12 h-12 rounded-[var(--radius-sm)] grid place-items-center p-2.5 transition-colors ${isRecording ? 'bg-[var(--status-error)]/15 border border-[var(--status-error)]/30 text-[var(--status-error)]' : 'bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-[var(--text-secondary)]'}`}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
              <path d="M19 10a7 7 0 0 1-14 0" />
              <line x1="12" y1="19" x2="12" y2="22" />
              <line x1="8" y1="22" x2="16" y2="22" />
            </svg>
          </div>
          <span className="text-xs text-[var(--text-secondary)]">{isRecording ? (transcript || interimTranscript ? (transcript + (interimTranscript ? ' ' + interimTranscript : '')) : 'Listening…') : recordedBlob ? 'Recording ready' : 'Click record to start'}</span>
          {isRecording && <span className="text-xs font-mono text-[var(--text-tertiary)]">{String(Math.floor(recTime / 60)).padStart(2, '0')}:{String(recTime % 60).padStart(2, '0')}</span>}
        </div>

        {(transcript || interimTranscript) && (
          <div className="mt-3 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] p-3 text-xs leading-relaxed max-h-[120px] overflow-y-auto text-[var(--text-primary)]">
            <div className="text-[var(--text-tertiary)] text-[10px] uppercase font-mono mb-1">Transcript {isRecording ? '• listening' : ''}</div>
            <p className="whitespace-pre-wrap break-words">{transcript}{interimTranscript ? <span className="text-[var(--text-tertiary)]">{transcript ? ' ' : ''}{interimTranscript}</span> : null}</p>
          </div>
        )}

        {recordedBlob && !isRecording && (
          <div className="mt-3 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] p-2.5 flex items-center gap-3">
            <audio controls src={URL.createObjectURL(recordedBlob)} className="flex-1 h-8 w-full" />
            <button onClick={() => setRecordedBlob(null)} className="w-7 h-7 rounded-[var(--radius-sm)] neu-button grid place-items-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] shrink-0" title="Discard">✕</button>
          </div>
        )}

        <div className="flex gap-2.5 mt-5">
          {!isRecording ? (
            <>
              <button onClick={onClose} className="flex-1 h-10 rounded-[var(--radius-sm)] neu-button text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
              <button onClick={onStart} disabled={!!error} className="flex-1 h-10 rounded-[var(--radius-sm)] neu-button-primary text-sm font-semibold disabled:opacity-40 flex items-center justify-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-primary)]" /> Record
              </button>
            </>
          ) : (
            <>
              <button onClick={onStop} className="flex-1 h-10 rounded-[var(--radius-sm)] neu-button text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Stop</button>
              <button onClick={onStop} className="flex-1 h-10 rounded-[var(--radius-sm)] neu-button-primary text-sm font-semibold flex items-center justify-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-primary)]" /> {String(Math.floor(recTime / 60)).padStart(2, '0')}:{String(recTime % 60).padStart(2, '0')}
              </button>
            </>
          )}
        </div>
        {recordedBlob && !isRecording && (
          <button onClick={onUseTranscript} disabled={!transcript && !interimTranscript} className="w-full mt-2.5 h-10 rounded-[var(--radius-sm)] neu-button-primary text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
            {transcript || interimTranscript ? 'Insert transcript into chat' : 'No transcript — close to discard'}
          </button>
        )}
      </div>
    </div>
  );
}
