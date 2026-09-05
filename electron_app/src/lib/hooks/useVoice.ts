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
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const timerRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<any>(null);
  const transcriptRef = useRef('');
  const interimRef = useRef('');

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);
  useEffect(() => {
    interimRef.current = interimTranscript;
  }, [interimTranscript]);

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
      setError(null); setRecordedBlob(null); setTranscript(''); setInterimTranscript(''); transcriptRef.current = ''; interimRef.current = '';
      const s = await navigator.mediaDevices.getUserMedia({ audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true });
      setStream(s);
      const rec = new MediaRecorder(s);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        setRecordedBlob(blob);
        // fallback demo transcript if STT not available / empty after 500ms
        window.setTimeout(() => {
          const hasSTT = !!(window as any).SpeechRecognition || !!(window as any).webkitSpeechRecognition;
          if (!hasSTT && !transcriptRef.current && !interimRef.current) {
            const demo = 'Hello, this is a voice message.';
            setTranscript(demo);
            transcriptRef.current = demo;
          }
        }, 600);
      };
      rec.start(); recorderRef.current = rec; setIsRecording(true); setRecTime(0);
      timerRef.current = window.setInterval(() => setRecTime((t) => t + 1), 1000) as unknown as number;

      // speech to text via Web Speech API
      const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SR) {
        try {
          const recognition = new SR();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = 'en-US';
          recognition.onresult = (event: any) => {
            let finalText = '';
            let interim = '';
            for (let i = 0; i < event.results.length; i++) {
              const res = event.results[i];
              const text = res[0].transcript;
              if (res.isFinal) finalText += text + ' ';
              else interim += text + ' ';
            }
            finalText = finalText.trim();
            interim = interim.trim();
            transcriptRef.current = finalText;
            interimRef.current = interim;
            setTranscript(finalText);
            setInterimTranscript(interim);
          };
          recognition.onerror = (e: any) => {
            if (e.error === 'not-allowed') setError('Microphone permission denied for transcription');
            else if (e.error === 'no-speech') {
              // ignore, keep listening
            } else {
              // show STT error but don't block recording
              // console.warn('STT error', e)
            }
          };
          recognition.onend = () => {
            // if still recording, restart to keep listening (Chrome stops after ~60s)
            if (recorderRef.current && recorderRef.current.state === 'recording' && recognitionRef.current) {
              try { recognition.start(); } catch {}
            }
          };
          recognition.start();
          recognitionRef.current = recognition;
        } catch (err: any) {
          setError('Speech recognition failed to start — demo transcript will be used');
        }
      } else {
        setError('Speech to text not supported in this browser — demo transcript will be used on stop');
      }
    } catch (err: any) { setError(err.message || 'Mic not available'); }
  };

  const stop = () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    if (stream) { stream.getTracks().forEach((t) => t.stop()); setStream(null); }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setIsRecording(false);
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }
    // merge any remaining interim into final
    const interim = interimRef.current;
    if (interim) {
      const merged = (transcriptRef.current ? transcriptRef.current + ' ' + interim : interim).trim();
      transcriptRef.current = merged;
      setTranscript(merged);
      setInterimTranscript('');
      interimRef.current = '';
    }
  };

  const close = () => {
    if (isRecording) stop();
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }
    setShow(false); setError(null); setRecordedBlob(null); setRecTime(0);
  };

  const clearTranscript = () => {
    setTranscript('');
    setInterimTranscript('');
    transcriptRef.current = '';
    interimRef.current = '';
  };

  return { show, setShow, devices, selectedMicId, setSelectedMicId, isRecording, stream, error, recTime, recordedBlob, setRecordedBlob, transcript, interimTranscript, setTranscript, clearTranscript, start, stop, close };
}
