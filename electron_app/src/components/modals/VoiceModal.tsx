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
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-[520px] neu-panel p-5 animate-apple-scaleIn" style={{ background: '#1F1F1F' }}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-white/40'}`} />
            {isRecording ? 'Recording…' : recordedBlob ? 'Recorded' : 'Voice'}
            {isRecording && <span className="text-xs font-mono opacity-60">{String(Math.floor(recTime / 60)).padStart(2, '0')}:{String(recTime % 60).padStart(2, '0')}</span>}
          </h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full neu-button grid place-items-center text-xs">✕</button>
        </div>

        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs opacity-60 shrink-0">Mic</span>
          <select value={selectedMicId} onChange={(e) => setSelectedMicId(e.target.value)} className="flex-1 neu-input px-3 py-2 text-xs outline-none" disabled={isRecording}>
            {devices.length === 0 && <option>Default microphone</option>}
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0, 6)}`}</option>
            ))}
          </select>
          <span className="w-8 h-8 rounded-full neu-pressed grid place-items-center shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="opacity-70"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" /><path d="M19 10a7 7 0 0 1-14 0" /></svg>
          </span>
        </div>

        {error && <div className="mb-3 text-xs text-red-400 neu-card p-2.5">{error}</div>}

        <div className="rounded-2xl neu-pressed p-6 flex flex-col items-center justify-center gap-3" style={{ height: 120 }}>
          <div className={`w-16 h-16 rounded-full grid place-items-center p-2.5 transition-all duration-300 ${isRecording ? 'bg-red-500/15' : 'neu-card'}`}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={isRecording ? '#EF4444' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={isRecording ? 'animate-pulse' : 'opacity-70'}>
              <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
              <path d="M19 10a7 7 0 0 1-14 0" />
              <line x1="12" y1="19" x2="12" y2="22" />
              <line x1="8" y1="22" x2="16" y2="22" />
            </svg>
          </div>
          <span className="text-xs opacity-50">{isRecording ? (transcript || interimTranscript ? (transcript + (interimTranscript ? ' ' + interimTranscript : '')) : 'Listening…') : recordedBlob ? 'Recording ready' : 'Tap record to start'}</span>
          {isRecording && <span className="text-xs font-mono opacity-60">{String(Math.floor(recTime / 60)).padStart(2, '0')}:{String(recTime % 60).padStart(2, '0')}</span>}
        </div>

        {(transcript || interimTranscript) && (
          <div className="mt-3 neu-card p-3 text-xs leading-relaxed max-h-[120px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="opacity-50 text-[10px] uppercase tracking-wide mb-1">Transcript {isRecording ? '• listening' : ''}</div>
            <p className="whitespace-pre-wrap break-words">{transcript}{interimTranscript ? <span className="opacity-50">{transcript ? ' ' : ''}{interimTranscript}</span> : null}</p>
          </div>
        )}

        {recordedBlob && !isRecording && (
          <div className="mt-3 neu-card p-2.5 flex items-center gap-3">
            <audio controls src={URL.createObjectURL(recordedBlob)} className="flex-1 h-8 w-full" />
            <button onClick={() => setRecordedBlob(null)} className="w-8 h-8 rounded-full neu-button grid place-items-center text-xs shrink-0" title="Discard">✕</button>
          </div>
        )}

        <div className="flex gap-2 mt-5">
          {!isRecording ? (
            <>
              <button onClick={onClose} className="flex-1 py-2.5 neu-button text-sm">Cancel</button>
              <button onClick={onStart} disabled={!!error} className="flex-1 py-2.5 neu-button-primary text-sm disabled:opacity-40 flex items-center justify-center gap-2">
                <span className="w-2 h-2 rounded-full bg-white" /> Record
              </button>
            </>
          ) : (
            <>
              <button onClick={onStop} className="flex-1 py-2.5 neu-button text-sm">Stop</button>
              <button onClick={onStop} className="flex-1 py-2.5 neu-button-primary text-sm flex items-center justify-center gap-2">
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> {String(Math.floor(recTime / 60)).padStart(2, '0')}:{String(recTime % 60).padStart(2, '0')}
              </button>
            </>
          )}
        </div>
        {recordedBlob && !isRecording && (
          <button onClick={onUseTranscript} disabled={!transcript && !interimTranscript} className="w-full mt-2 py-2.5 neu-button-primary text-sm disabled:opacity-40 disabled:cursor-not-allowed">
            {transcript || interimTranscript ? 'Insert transcript into chat' : 'No transcript — close to discard'}
          </button>
        )}
      </div>
    </div>
  );
}
