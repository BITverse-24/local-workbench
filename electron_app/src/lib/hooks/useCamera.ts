import { useState, useRef, useEffect, useCallback } from 'react';

export function useCamera() {
  const [show, setShow] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);

  const stopStream = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      setStream(null);
    }
  }, [stream]);

  useEffect(() => {
    if (!show) {
      stopStream();
      return;
    }
    setError(null); setCapturedImage(null);
    let activeStream: MediaStream | null = null;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then((s) => { activeStream = s; setStream(s); if (videoRef.current) videoRef.current.srcObject = s; })
      .catch((err) => setError(err.message || 'Camera not available'));
    return () => {
      if (activeStream) activeStream.getTracks().forEach((t) => t.stop());
      stopStream();
    };
  }, [show, stopStream]);

  useEffect(() => { if (videoRef.current && stream) videoRef.current.srcObject = stream; }, [stream]);

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const v = videoRef.current; const c = canvasRef.current;
      c.width = v.videoWidth; c.height = v.videoHeight;
      const ctx = c.getContext('2d');
      if (ctx) { ctx.drawImage(v, 0, 0); setCapturedImage(c.toDataURL('image/png')); }
    }
  };

  const close = useCallback(() => { setShow(false); setError(null); setCapturedImage(null); }, []);

  return { show, setShow, videoRef, canvasRef, error, capturedImage, setCapturedImage, capturePhoto, close, stream };
}
