import { useState, useCallback, useEffect } from 'react';
import './App.css';
import TitleBar from './components/TitleBar';
import LeftSidebar, { type SidebarChat } from './components/LeftSidebar';
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
import * as wb from './lib/workbench';
import { useDropdownPosition, usePlusPosition } from './lib/hooks/useDropdownPosition';
import { useCamera } from './lib/hooks/useCamera';
import { useVoice } from './lib/hooks/useVoice';
import { useUpload } from './lib/hooks/useUpload';

function toChatMessages(rows: PersistedMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const r of rows) {
    if (r.role === 'user' || r.role === 'assistant') {
      out.push({ id: r.id, role: r.role, text: r.content });
    }
  }
  return out;
}

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
  // NOTE: selectedModel stays local for now — UI model ids (gemini-*) don't map to the
  // backend registry ids (draft-qwen3/…) until Phase 3/14. temperature + lastChatId persist.

  // --- Persisted chat state (backend SQLite via window.workbench) ---
  const [history, setHistory] = useState<SidebarChat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  // persistent === bridge reachable. False in plain `vite` web dev or when the main
  // process backend failed to init — the app then runs fully in-memory as before.
  const [persistent, setPersistent] = useState(false);

  // Launch: restore history, last chat, and temperature from the backend.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!wb.isWorkbenchAvailable()) return;
      try {
        const chats = await wb.getChatHistory(50);
        if (cancelled) return;
        setPersistent(true);
        setHistory(chats.map((c) => ({ id: c.id, title: c.title })));
        const temp = await wb.getSetting<number>('temperature');
        if (!cancelled && typeof temp === 'number') setTemperature(temp);
        const last = await wb.getSetting<string>('lastChatId');
        if (cancelled) return;
        const target =
          (typeof last === 'string' && chats.some((c) => c.id === last) ? last : null) ??
          chats[0]?.id ??
          null;
        if (!target) return; // brand-new DB: first chat is created lazily on send
        setChatId(target);
        await wb.setSetting('lastChatId', target);
        const rows = await wb.getMessages(target);
        if (!cancelled) setMessages(toChatMessages(rows));
      } catch {
        if (!cancelled) setPersistent(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    try {
      const rows = await wb.getMessages(id);
      setMessages(toChatMessages(rows));
    } catch {
      setPersistent(false);
    }
  }, []);

  const handleSelectChat = useCallback(
    async (id: string) => {
      setChatId(id);
      if (!persistent) return;
      try {
        await wb.setSetting('lastChatId', id);
        await loadMessages(id);
      } catch {
        setPersistent(false);
      }
    },
    [persistent, loadMessages],
  );

  const handleNewChat = useCallback(async () => {
    if (persistent) {
      try {
        const id = await wb.createChat('New chat');
        setHistory((prev) => [{ id, title: 'New chat' }, ...prev]);
        setChatId(id);
        setMessages([]);
        await wb.setSetting('lastChatId', id);
        return;
      } catch {
        setPersistent(false);
      }
    }
    const id = `local-${Date.now()}`;
    setHistory((prev) => [{ id, title: 'New chat' }, ...prev]);
    setChatId(id);
    setMessages([]);
  }, [persistent]);

  const handleDeleteChat = useCallback(
    async (id: string) => {
      if (persistent && !id.startsWith('local-')) {
        try {
          await wb.archiveChat(id);
        } catch {
          setPersistent(false);
        }
      }
      const next = history.filter((c) => c.id !== id);
      setHistory(next);
      if (chatId === id) {
        const fallback = next[0]?.id ?? null;
        setChatId(fallback);
        if (fallback && persistent) void loadMessages(fallback);
        else setMessages([]);
      }
    },
    [chatId, history, persistent, loadMessages],
  );

  // Rename persists via workbench:renameChat (backend P-B1). Optimistic local update
  // first so sidebar + header change instantly; a failed persist drops to fallback mode.
  const handleRenameChat = useCallback(
    async (id: string, title: string) => {
      setHistory((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
      if (persistent && !id.startsWith('local-')) {
        try {
          await wb.renameChat(id, title);
        } catch {
          setPersistent(false);
        }
      }
    },
    [persistent],
  );

  const activeTitle = history.find((c) => c.id === chatId)?.title ?? 'Untitled Chat';

  /** Ensure a persisted chat exists for sending; null in fallback mode. */
  const ensureChatId = useCallback(
    async (firstText: string): Promise<string | null> => {
      if (chatId && !chatId.startsWith('local-')) return chatId;
      if (!persistent) return null;
      try {
        const title = firstText.trim().slice(0, 40) || 'New chat';
        const id = await wb.createChat(title);
        setChatId(id);
        setHistory((prev) => [{ id, title }, ...prev]);
        await wb.setSetting('lastChatId', id);
        return id;
      } catch {
        setPersistent(false);
        return null;
      }
    },
    [chatId, persistent],
  );

  const handleTemperature = useCallback(
    (v: number) => {
      setTemperature(v);
      if (persistent) void wb.setSetting('temperature', v).catch(() => undefined);
    },
    [persistent],
  );

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

  const handleSend = async () => {
    const hasText = input.trim().length > 0;
    const hasFiles = attachedFiles.length > 0;
    if (!hasText && !hasFiles) return;
    const text = input;
    const files = attachedFiles.length ? [...attachedFiles] : undefined;
    setInput('');
    setAttachedFiles([]);
    if (persistent) {
      const id = await ensureChatId(text);
      if (id) {
        try {
          const { messageId } = await wb.sendMessage(id, 'user', text);
          setMessages((prev) => [...prev, { id: messageId, role: 'user', text, files }]);
        } catch {
          setPersistent(false);
          setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: 'user', text, files }]);
        }
        // Assistant turns arrive from the orchestrator in Phase 1; no fake reply.
        return;
      }
    }
    const newMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      text,
      files,
    };
    setMessages((prev) => [...prev, newMsg]);
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

  const handleEditMessage = useCallback(
    async (id: string, newText: string) => {
      if (persistent && !id.startsWith('local-')) {
        try {
          await wb.editPersistedMessage(id, newText);
        } catch {
          setPersistent(false);
        }
      }
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: newText } : m)));
    },
    [persistent],
  );

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
        <LeftSidebar
          collapsed={leftCollapsed}
          onCollapse={() => setLeftCollapsed(true)}
          chats={history}
          activeId={chatId}
          onSelect={handleSelectChat}
          onNewChat={handleNewChat}
          onDeleteChat={handleDeleteChat}
          onRename={handleRenameChat}
        />

        <ChatPanel title={activeTitle} leftCollapsed={leftCollapsed} rightCollapsed={rightCollapsed} onToggleLeft={() => setLeftCollapsed(!leftCollapsed)} onToggleRight={() => setRightCollapsed(!rightCollapsed)}>
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
          setTemperature={handleTemperature}
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
