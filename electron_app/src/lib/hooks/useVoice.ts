import { useState, useRef, useEffect } from 'react';

export function useVoice() {
  const [show, setShow] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recTime, setRecTime] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const timerRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    if (!show) return;
    navigator.mediaDevices.enumerateDevices().then((devs) => {
      const mics = devs.filter((d) => d.kind === 'audioinput');
      setDevices(mics);
      if (mics.length && !selectedMicId) setSelectedMicId(mics[0].deviceId);
    }).catch(() => {});
  }, [show]);

  useEffect(() => {
    if (!show && isRecording) stop();
    if (!show && timerRef.current) clearInterval(timerRef.current);
  }, [show]);

  const start = async () => {
    try {
      setError(null); setRecordedBlob(null);
      const s = await navigator.mediaDevices.getUserMedia({ audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true });
      setStream(s);
      const rec = new MediaRecorder(s);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => setRecordedBlob(new Blob(chunks, { type: 'audio/webm' }));
      rec.start(); recorderRef.current = rec; setIsRecording(true); setRecTime(0);
      timerRef.current = window.setInterval(() => setRecTime((t) => t + 1), 1000) as unknown as number;
    } catch (err: any) { setError(err.message || 'Mic not available'); }
  };

  const stop = () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    if (stream) { stream.getTracks().forEach((t) => t.stop()); setStream(null); }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setIsRecording(false);
  };

  const close = () => {
    if (isRecording) stop();
    setShow(false); setError(null); setRecordedBlob(null); setRecTime(0);
  };

  return { show, setShow, devices, selectedMicId, setSelectedMicId, isRecording, stream, error, recTime, recordedBlob, setRecordedBlob, start, stop, close };
}
