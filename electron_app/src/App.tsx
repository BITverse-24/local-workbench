import { useState, useCallback, useEffect } from 'react';
import './App.css';
import TitleBar from './components/TitleBar';
import LeftSidebar from './components/LeftSidebar';
import ChatPanel from './components/ChatPanel';
import ChatArea, { type ChatMessage } from './components/ChatArea';
import InputBar from './components/InputBar';
import RightSidebar from './components/RightSidebar';
import ModelDropdown from './components/ModelDropdown';
import PlusDropup from './components/PlusDropup';
import UploadModal from './components/modals/UploadModal';
import CameraModal from './components/modals/CameraModal';
import VoiceModal from './components/modals/VoiceModal';
import { MODELS } from './lib/models';
import { useDropdownPosition, usePlusPosition } from './lib/hooks/useDropdownPosition';
import { useCamera } from './lib/hooks/useCamera';
import { useVoice } from './lib/hooks/useVoice';
import { useUpload } from './lib/hooks/useUpload';

export default function App() {
  const [input, setInput] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [selectedModel, setSelectedModel] = useState(MODELS[0]);
  const [modelOpen, setModelOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const { btnRef: modelBtnRef, pos: dropdownPos } = useDropdownPosition(modelOpen);
  const { btnRef: plusBtnRef, pos: plusPos } = usePlusPosition(plusOpen);

  const upload = useUpload();
  const camera = useCamera();
  const voice = useVoice();

  const MAX_SIZE = 10 * 1024 * 1024;

  const addFiles = useCallback((incoming: File[]) => {
    const valid: File[] = [];
    const tooBig: File[] = [];
    for (const f of incoming) {
      if (f.size > MAX_SIZE) tooBig.push(f);
      else valid.push(f);
    }
    if (valid.length) {
      setAttachedFiles((prev) => {
        const existing = new Set(prev.map((p) => `${p.name}-${p.size}-${p.lastModified}`));
        const deduped = valid.filter((f) => !existing.has(`${f.name}-${f.size}-${f.lastModified}`));
        return [...prev, ...deduped];
      });
    }
    return { added: valid.length, rejected: tooBig };
  }, []);

  const removeAttached = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSend = () => {
    const hasText = input.trim().length > 0;
    const hasFiles = attachedFiles.length > 0;
    if (!hasText && !hasFiles) return;
    const newMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      text: input,
      files: attachedFiles.length ? [...attachedFiles] : undefined,
    };
    setMessages((prev) => [...prev, newMsg]);
    setInput('');
    setAttachedFiles([]);
    // auto-reply with "Chat response" for every sent text
    const reply: ChatMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      text: '**Akakakakaa** ```java System.out.println("Hello, World"); class Sky { public Sky(){int k = 69;} }  ```\n Add stuffs to it',
    };
    // slight delay to preserve message order and allow auto-scroll animation
    window.setTimeout(() => {
      setMessages((prev) => [...prev, reply]);
    }, 300);
  };

  const handleEditMessage = useCallback((id: string, newText: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: newText } : m)));
  }, []);

  const handleVoiceUseTranscript = useCallback(() => {
    const text = `${voice.transcript}${voice.interimTranscript ? ' ' + voice.interimTranscript : ''}`.trim();
    if (text) {
      setInput((prev) => (prev ? (prev.endsWith(' ') ? prev : prev + ' ') + text : text));
      // auto-focus input after paste
      window.setTimeout(() => {
        const el = document.querySelector('textarea[placeholder*="Write your prompt"]') as HTMLTextAreaElement | null;
        el?.focus();
      }, 50);
    }
    voice.close();
    window.setTimeout(() => voice.clearTranscript(), 200);
  }, [voice]);

  // auto paste transcript when recording stops (so input is filled without extra click)
  useEffect(() => {
    if (!voice.isRecording && voice.recordedBlob && (voice.transcript || voice.interimTranscript)) {
      const text = `${voice.transcript}${voice.interimTranscript ? ' ' + voice.interimTranscript : ''}`.trim();
      if (text) {
        setInput((prev) => {
          if (prev.includes(text)) return prev;
          return prev ? (prev.endsWith(' ') ? prev : prev + ' ') + text : text;
        });
      }
    }
  }, [voice.isRecording, voice.recordedBlob, voice.transcript, voice.interimTranscript]);

  const handleUploadConfirm = useCallback(() => {
    if (upload.files.length) {
      addFiles(upload.files);
      upload.setFiles(() => []);
    }
    upload.setShow(false);
  }, [upload, addFiles]);

  return (
    <div className="flex flex-col h-screen w-full font-sans overflow-hidden relative select-none page-apple-enter" style={{ background: '#181818' }}>
      <TitleBar />

      <div className="flex flex-1 overflow-hidden p-3 gap-3 relative z-10" style={{ background: '#181818' }}>
        <LeftSidebar collapsed={leftCollapsed} onCollapse={() => setLeftCollapsed(true)} />

        <ChatPanel leftCollapsed={leftCollapsed} rightCollapsed={rightCollapsed} onToggleLeft={() => setLeftCollapsed(!leftCollapsed)} onToggleRight={() => setRightCollapsed(!rightCollapsed)}>
          <ChatArea messages={messages} onEditMessage={handleEditMessage} onAttachFiles={addFiles} />
          <InputBar
            input={input}
            setInput={setInput}
            plusOpen={plusOpen}
            setPlusOpen={setPlusOpen}
            plusBtnRef={plusBtnRef}
            searchActive={searchActive}
            setSearchActive={setSearchActive}
            onVoice={() => voice.setShow(true)}
            onSend={handleSend}
            attachedFiles={attachedFiles}
            onAttachFiles={addFiles}
            onRemoveFile={removeAttached}
          />
        </ChatPanel>

        <RightSidebar
          collapsed={rightCollapsed}
          onCollapse={() => setRightCollapsed(true)}
          models={MODELS}
          selectedModel={selectedModel}
          modelOpen={modelOpen}
          setModelOpen={setModelOpen}
          modelBtnRef={modelBtnRef}
          temperature={temperature}
          setTemperature={setTemperature}
        />
      </div>

      <ModelDropdown open={modelOpen} pos={dropdownPos} models={MODELS} selected={selectedModel} onSelect={(m) => { setSelectedModel(m); setModelOpen(false); }} onClose={() => setModelOpen(false)} />

      <PlusDropup
        open={plusOpen}
        pos={plusPos}
        onClose={() => setPlusOpen(false)}
        onUpload={() => { setPlusOpen(false); upload.setShow(true); }}
        onCamera={() => { setPlusOpen(false); camera.setShow(true); }}
        onSearch={() => { setPlusOpen(false); setSearchActive(true); }}
      />

      <UploadModal open={upload.show} dragOver={upload.dragOver} setDragOver={upload.setDragOver} files={upload.files} setFiles={upload.setFiles} onClose={() => upload.setShow(false)} onConfirm={handleUploadConfirm} />

      <CameraModal open={camera.show} error={camera.error} capturedImage={camera.capturedImage} videoRef={camera.videoRef} canvasRef={camera.canvasRef} onClose={camera.close} onCapture={camera.capturePhoto} onRetake={() => camera.setCapturedImage(null)} />

      <VoiceModal
        open={voice.show}
        devices={voice.devices}
        selectedMicId={voice.selectedMicId}
        setSelectedMicId={voice.setSelectedMicId}
        isRecording={voice.isRecording}
        recTime={voice.recTime}
        recordedBlob={voice.recordedBlob}
        setRecordedBlob={voice.setRecordedBlob}
        transcript={voice.transcript}
        interimTranscript={voice.interimTranscript}
        error={voice.error}
        onClose={voice.close}
        onStart={voice.start}
        onStop={voice.stop}
        onUseTranscript={handleVoiceUseTranscript}
      />
    </div>
  );
}
