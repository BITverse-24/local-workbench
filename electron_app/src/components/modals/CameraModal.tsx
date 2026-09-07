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
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-[560px] neu-panel p-4 animate-apple-scaleIn" style={{ background: '#1F1F1F' }}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Camera</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full neu-button grid place-items-center text-xs">✕</button>
        </div>
        <div className="rounded-2xl overflow-hidden neu-pressed bg-black aspect-video flex items-center justify-center relative">
          {error ? (
            <div className="text-center p-6">
              <p className="text-sm opacity-70">{error}</p>
              <p className="text-xs opacity-40 mt-2">Check permissions in system settings.</p>
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
              <button onClick={onRetake} className="flex-1 py-2.5 neu-button text-sm">Retake</button>
              <button onClick={onClose} className="flex-1 py-2.5 neu-button-primary text-sm">Use photo</button>
            </>
          ) : (
            <>
              <button onClick={onClose} className="flex-1 py-2.5 neu-button text-sm">Cancel</button>
              <button onClick={onCapture} disabled={!!error} className="flex-1 py-2.5 neu-button-primary text-sm disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> Capture
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
