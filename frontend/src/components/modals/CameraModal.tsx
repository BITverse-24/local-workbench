type Props = {
  open: boolean;
  error: string | null;
  capturedImage: string | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onClose: () => void;
  onCapture: () => void;
  onRetake: () => void;
};

export default function CameraModal({ open, error, capturedImage, videoRef, canvasRef, onClose, onCapture, onRetake }: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-[560px] rounded-[var(--radius-md)] neu-panel p-5 bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-[var(--text-primary)]">Camera</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-[var(--radius-sm)] neu-button grid place-items-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
        </div>
        <div className="rounded-[var(--radius-sm)] overflow-hidden bg-[var(--bg-canvas)] border border-[var(--border-subtle)] aspect-video flex items-center justify-center relative">
          {error ? (
            <div className="text-center p-6">
              <p className="text-xs text-[var(--status-error)]">{error}</p>
              <p className="text-[11px] text-[var(--text-tertiary)] mt-2">Check permissions in system settings.</p>
            </div>
          ) : capturedImage ? (
            <img src={capturedImage} alt="captured" className="w-full h-full object-contain" />
          ) : (
            <video ref={videoRef as React.RefObject<HTMLVideoElement>} autoPlay playsInline muted className="w-full h-full object-cover" />
          )}
          <canvas ref={canvasRef as React.RefObject<HTMLCanvasElement>} className="hidden" />
        </div>
        <div className="flex gap-2 mt-4">
          {capturedImage ? (
            <>
              <button onClick={onRetake} className="flex-1 h-10 rounded-[var(--radius-sm)] neu-button text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Retake</button>
              <button onClick={onClose} className="flex-1 h-10 rounded-[var(--radius-sm)] neu-button-primary text-sm font-semibold">Use photo</button>
            </>
          ) : (
            <>
              <button onClick={onClose} className="flex-1 h-10 rounded-[var(--radius-sm)] neu-button text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
              <button onClick={onCapture} disabled={!!error} className="flex-1 h-10 rounded-[var(--radius-sm)] neu-button-primary text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-primary)]" /> Capture
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
