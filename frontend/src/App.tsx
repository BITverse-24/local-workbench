import { useState, useCallback, useEffect, useRef } from "react";
import "./App.css";
import TitleBar from "./components/TitleBar";
import LeftSidebar, { type SidebarChat } from "./components/LeftSidebar";
import ChatPanel from "./components/ChatPanel";
import ChatArea, { type ChatMessage } from "./components/ChatArea";
import InputBar from "./components/InputBar";
import RightSidebar from "./components/RightSidebar";
import ModelDropdown from "./components/ModelDropdown";
import PlusDropup from "./components/PlusDropup";
import UploadModal from "./components/modals/UploadModal";
import CameraModal from "./components/modals/CameraModal";
import VoiceModal from "./components/modals/VoiceModal";
import ConfirmationModal from "./components/ConfirmationModal";
import RouteBadge from "./components/RouteBadge";
import { MODELS } from "./lib/models";
import * as wb from "./lib/workbench";
import { useDropdownPosition, usePlusPosition } from "./lib/hooks/useDropdownPosition";
import { useCamera } from "./lib/hooks/useCamera";
import { useVoice } from "./lib/hooks/useVoice";
import { useUpload } from "./lib/hooks/useUpload";

const MAX_SIZE = 10 * 1024 * 1024;

function toChatMessages(rows: PersistedMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const r of rows) {
    if (r.role === "user" || r.role === "assistant") {
      out.push({
        id: r.id,
        role: r.role,
        text: r.content,
        artifacts: r.artifacts,
        files: r.attachments?.map((a) => ({ name: a.filename, size: a.sizeBytes })),
      });
    }
  }
  return out;
}

export default function App() {
  const [input, setInput] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [selectedModel, setSelectedModel] = useState(MODELS[0]);
  const [modelOpen, setModelOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [history, setHistory] = useState<SidebarChat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [persistent, setPersistent] = useState(false);

  // Run state
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState | null>(null);
  const [activeRoute, setActiveRoute] = useState<{ taskType: string; modelId: string; reason: string } | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingAction | null>(null);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [, setRunArtifacts] = useState<ArtifactRef[]>([]);
  const [runError, setRunError] = useState<{ code: string; message: string } | null>(null);
  const [serviceHealth, setServiceHealth] = useState<ModelHealth[] | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [groundingEnabled, setGroundingEnabled] = useState(true);
  const [groundingStatus, setGroundingStatus] = useState<{ status: "retrieving" | "injected" | "skipped"; chunkCount?: number } | null>(null);
  const activeRunRef = useRef<string | null>(null);
  activeRunRef.current = activeRunId;
  const isRunning = runState !== null && !["completed", "failed", "cancelled"].includes(runState);

  // Workspace state
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);
  const [workspaceTree, setWorkspaceTree] = useState<HarnessDirEntry[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);

  // Launch: restore history, last chat, temperature, workspace
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!wb.isWorkbenchAvailable()) return;
      try {
        const chats = await wb.getChatHistory(50);
        if (cancelled) return;
        setPersistent(true);
        setHistory(chats.map((c) => ({ id: c.id, title: c.title, updated_at: c.updated_at })));
        const temp = await wb.getSetting<number>("temperature");
        if (!cancelled && typeof temp === "number") setTemperature(temp);
        // Open a fresh new chat on startup (chat history remains accessible in the sidebar)
        setChatId(null);
        setMessages([]);
        setActiveRunId(null);
        setRunState(null);
        setActiveRoute(null);
        setRunEvents([]);
        setRunArtifacts([]);
        setRunError(null);
        setGroundingStatus(null);
        // Health probe on startup
        try {
          const h = await wb.getHealth();
          if (!cancelled) setServiceHealth(h);
        } catch {
          void 0;
        }
        // Check if a workspace is already active
        try {
          const ws = await wb.getCurrentWorkspace();
          if (!cancelled && ws) {
            setActiveWorkspace(ws);
            const treeRes = await wb.listWorkspaceDir();
            if (!cancelled && treeRes?.result) setWorkspaceTree(treeRes.result);
          }
        } catch {
          void 0;
        }
      } catch {
        if (!cancelled) setPersistent(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshHealth = useCallback(async () => {
    if (!wb.isWorkbenchAvailable()) return;
    setHealthLoading(true);
    try {
      const h = await wb.getHealth();
      setServiceHealth(h);
    } catch {
      void 0;
    }
    setHealthLoading(false);
  }, []);

  // Single run-event subscription
  useEffect(() => {
    if (!wb.isWorkbenchAvailable()) return;
    let unsub: (() => void) | undefined;
    try {
      unsub = wb.onRunEvent((event: RunEvent) => {
        // Ignore events for other runs when we have an active run filter
        // but never drop assistant_message or routing for chat coherence.
        const rid = (event as { runId?: string }).runId;
        if (event.type !== "assistant_message") {
          if (activeRunRef.current && rid && rid !== activeRunRef.current) {
            return;
          }
        }
        if (rid && !activeRunRef.current) {
          activeRunRef.current = rid;
          setActiveRunId(rid);
        }
        setRunEvents((prev) => [...prev, event]);
        switch (event.type) {
          case "run_state":
            setRunState(event.state);
            if (event.state === "completed" || event.state === "failed" || event.state === "cancelled") {
              setPendingConfirmation(null);
            }
            break;
          case "routing":
            setActiveRoute({ taskType: event.taskType, modelId: event.modelId, reason: event.reason });
            break;
          case "confirmation_required":
            setPendingConfirmation(event.action);
            break;
          case "artifact_ready":
            setRunArtifacts((prev) => [...prev, event.artifact]);
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "assistant") {
                const existing = last.artifacts ?? [];
                if (!existing.some((a) => a.artifactId === event.artifact.artifactId)) {
                  return [...prev.slice(0, -1), { ...last, artifacts: [...existing, event.artifact] }];
                }
                return prev;
              }
              return [
                ...prev,
                {
                  id: `artifact-msg-${event.artifact.artifactId}`,
                  role: "assistant",
                  text: "",
                  artifacts: [event.artifact],
                },
              ];
            });
            break;
          case "assistant_message":
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "assistant" && (!last.text || last.id.startsWith("artifact-msg-"))) {
                return [
                  ...prev.slice(0, -1),
                  { ...last, id: event.messageId, text: event.text },
                ];
              }
              return [...prev, { id: event.messageId, role: "assistant", text: event.text }];
            });
            break;
          case "grounding_context":
            setGroundingStatus({ status: event.status, chunkCount: event.chunkCount });
            break;
          case "error":
            setRunError({ code: event.code, message: event.message });
            setRunState("failed");
            setPendingConfirmation(null);
            break;
          default:
            break;
        }
      });
    } catch {
      void 0;
    }
    return () => {
      try {
        unsub?.();
      } catch {
        void 0;
      }
    };
  }, []);

  // Single workspace-event subscription
  useEffect(() => {
    if (!wb.isWorkbenchAvailable()) return;
    let unsub: (() => void) | undefined;
    try {
      unsub = wb.onWorkspaceEvent((event: any) => {
        if (event?.type === "workspace_registered") {
          setActiveWorkspace(event.workspace);
        } else if (event?.type === "workspace_deregistered") {
          setActiveWorkspace(null);
          setWorkspaceTree([]);
        } else if (event?.type === "workspace_tree") {
          setWorkspaceTree(event.entries ?? []);
        }
      });
    } catch {
      void 0;
    }
    return () => {
      try {
        unsub?.();
      } catch {
        void 0;
      }
    };
  }, []);

  const handlePickWorkspace = useCallback(async () => {
    if (!wb.isWorkbenchAvailable()) return;
    setWorkspaceLoading(true);
    try {
      const folder = await wb.pickWorkspaceFolder();
      if (folder) {
        const info = await wb.registerWorkspace(folder);
        setActiveWorkspace(info);
        const treeRes = await wb.listWorkspaceDir();
        if (treeRes?.result) setWorkspaceTree(treeRes.result);
      }
    } catch (e) {
      console.error("Failed to register workspace:", e);
    } finally {
      setWorkspaceLoading(false);
    }
  }, []);

  const handleCloseWorkspace = useCallback(async () => {
    if (!wb.isWorkbenchAvailable()) return;
    setWorkspaceLoading(true);
    try {
      await wb.deregisterWorkspace();
      setActiveWorkspace(null);
      setWorkspaceTree([]);
    } catch (e) {
      console.error("Failed to deregister workspace:", e);
    } finally {
      setWorkspaceLoading(false);
    }
  }, []);

  const handleRefreshWorkspaceTree = useCallback(async () => {
    if (!wb.isWorkbenchAvailable() || !activeWorkspace) return;
    setWorkspaceLoading(true);
    try {
      const treeRes = await wb.listWorkspaceDir();
      if (treeRes?.result) setWorkspaceTree(treeRes.result);
    } catch (e) {
      console.error("Failed to refresh workspace tree:", e);
    } finally {
      setWorkspaceLoading(false);
    }
  }, [activeWorkspace]);

  const handleSelectWorkspaceFile = useCallback((relPath: string) => {
    setInput((prev) => (prev ? `${prev} ${relPath}` : `@${relPath} `));
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
      // Reset run UI when switching chats
      setActiveRunId(null);
      setRunState(null);
      setActiveRoute(null);
      setPendingConfirmation(null);
      setRunEvents([]);
      setRunArtifacts([]);
      setRunError(null);
      setGroundingStatus(null);
      if (!persistent) return;
      try {
        await wb.setSetting("lastChatId", id);
        await loadMessages(id);
      } catch {
        setPersistent(false);
      }
    },
    [persistent, loadMessages],
  );

  const handleNewChat = useCallback(async () => {
    setActiveRunId(null);
    setRunState(null);
    setActiveRoute(null);
    setPendingConfirmation(null);
    setRunEvents([]);
    setRunArtifacts([]);
    setRunError(null);
    setGroundingStatus(null);
    if (persistent) {
      try {
        const id = await wb.createChat("New chat");
        setHistory((prev) => [{ id, title: "New chat", updated_at: new Date().toISOString() }, ...prev]);
        setChatId(id);
        setMessages([]);
        await wb.setSetting("lastChatId", id);
        return;
      } catch {
        setPersistent(false);
      }
    }
    const id = `local-${Date.now()}`;
    setHistory((prev) => [{ id, title: "New chat", updated_at: new Date().toISOString() }, ...prev]);
    setChatId(id);
    setMessages([]);
  }, [persistent]);

  const handleDeleteChat = useCallback(
    async (id: string) => {
      if (persistent && !id.startsWith("local-")) {
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

  const handleRenameChat = useCallback(
    async (id: string, title: string) => {
      setHistory((prev) => prev.map((c) => (c.id === id ? { ...c, title, updated_at: new Date().toISOString() } : c)));
      if (persistent && !id.startsWith("local-")) {
        try {
          await wb.renameChat(id, title);
        } catch {
          setPersistent(false);
        }
      }
    },
    [persistent],
  );

  const activeTitle = history.find((c) => c.id === chatId)?.title ?? "Untitled Chat";

  const ensureChatId = useCallback(
    async (firstText: string): Promise<string | null> => {
      if (chatId && !chatId.startsWith("local-")) return chatId;
      if (!persistent) return null;
      try {
        const title = firstText.trim().slice(0, 40) || "New chat";
        const id = await wb.createChat(title);
        setChatId(id);
        setHistory((prev) => [{ id, title, updated_at: new Date().toISOString() }, ...prev]);
        await wb.setSetting("lastChatId", id);
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
      if (persistent) void wb.setSetting("temperature", v).catch(() => undefined);
    },
    [persistent],
  );

  const { btnRef: modelBtnRef, pos: dropdownPos } = useDropdownPosition(modelOpen);
  const { btnRef: plusBtnRef, pos: plusPos } = usePlusPosition(plusOpen);

  const upload = useUpload();
  const camera = useCamera();
  const voice = useVoice();

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

  const handleConfirm = useCallback(async (approved: boolean) => {
    if (!pendingConfirmation || !activeRunId) return;
    if (confirmationBusy) return;
    const { actionId, runId } = pendingConfirmation;
    setConfirmationBusy(true);
    try {
      await wb.confirmAction({ runId, actionId, approved });
      setPendingConfirmation(null);
    } catch (e) {
      setRunError({ code: "confirm_failed", message: e instanceof Error ? e.message : String(e) });
      setPendingConfirmation(null);
    } finally {
      setConfirmationBusy(false);
    }
  }, [pendingConfirmation, activeRunId, confirmationBusy]);

  const handleCancelRun = useCallback(async () => {
    if (!activeRunId) return;
    try {
      await wb.cancelRun(activeRunId);
      setRunState("cancelled");
      setPendingConfirmation(null);
    } catch (e) {
      setRunError({ code: "cancel_failed", message: e instanceof Error ? e.message : String(e) });
    }
  }, [activeRunId]);

  const handleSaveArtifact = useCallback(async (artifact: ArtifactRef) => {
    try {
      await wb.saveArtifact({ runId: artifact.runId, artifactId: artifact.artifactId });
    } catch (e) {
      setRunError({ code: "save_failed", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const handleSend = async () => {
    const hasText = input.trim().length > 0;
    const hasFiles = attachedFiles.length > 0;
    if (!hasText && !hasFiles) return;
    if (isRunning) return;
    if (attachedFiles.length > 10) {
      setRunError({ code: "too_many_attachments", message: "Maximum 10 attachments per run supported." });
      return;
    }
    const text = input;
    const currentFiles = [...attachedFiles];
    if (currentFiles.length === 0) setInput("");

    // Persistent chat + backend run path
    if (persistent) {
      const cid = await ensureChatId(text);
      if (cid) {
        try {
          const attachmentTokens: string[] = [];
          let runIdForAttachment: string | undefined;
          if (currentFiles.length > 0) {
            for (const f of currentFiles) {
              const reg = await wb.registerAttachment({ chatId: cid, file: f });
              attachmentTokens.push(reg.attachment.attachmentId);
              if (!runIdForAttachment) runIdForAttachment = reg.runId;
            }
            setInput("");
            setAttachedFiles([]);
          } else {
            setAttachedFiles([]);
          }

          // Persist user message linked with attachment IDs (visible immediately)
          const { messageId } = await wb.sendMessage(
            cid,
            "user",
            text,
            attachmentTokens.length > 0 ? attachmentTokens : undefined,
          );
          setMessages((prev) => [
            ...prev,
            {
              id: messageId,
              role: "user",
              text,
              files: currentFiles.length > 0 ? currentFiles.map((f) => ({ name: f.name, size: f.size })) : undefined,
            },
          ]);
          setHistory((prev) => prev.map((c) => (c.id === cid ? { ...c, updated_at: new Date().toISOString() } : c)));

          // Reset run UI
          setRunEvents([]);
          setRunArtifacts([]);
          setRunError(null);
          setActiveRoute(null);
          setPendingConfirmation(null);
          setGroundingStatus(null);
          setRunState("created");

          const clientRunId = runIdForAttachment ?? crypto.randomUUID();
          activeRunRef.current = clientRunId;
          setActiveRunId(clientRunId);

          const { runId } = await wb.startRun({
            userText: text,
            attachmentToken: attachmentTokens[0],
            attachmentTokens,
            runId: clientRunId,
            chatId: cid,
            temperature,
            groundingEnabled,
          });
          setActiveRunId(runId);
          activeRunRef.current = runId;

          // Re-sync messages from SQLite in case fast background run finished
          try {
            const latest = await wb.getMessages(cid);
            if (latest && latest.length > 0) {
              setMessages(toChatMessages(latest));
            }
          } catch {}

          // Chat stays on cid; run is linked via DB.
          return;
        } catch (e) {
          setRunError({ code: "send_failed", message: e instanceof Error ? e.message : String(e) });
          // keep composer content if register/start failed
          if (currentFiles.length > 0) {
            // do not clear on failure — keep file for retry
          }
          return;
        }
      }
    }

    // Fallback / non-persistent: in-memory only, no backend run
    const fallbackFiles = currentFiles.length > 0 ? currentFiles : undefined;
    setInput("");
    setAttachedFiles([]);
    const newMsg: ChatMessage = { id: Date.now().toString(), role: "user", text, files: fallbackFiles };
    setMessages((prev) => [...prev, newMsg]);
    if (chatId) {
      const now = new Date().toISOString();
      setHistory((prev) => prev.map((c) => (c.id === chatId ? { ...c, updated_at: now } : c)));
    }
    window.setTimeout(() => {
      setMessages((prev) => [...prev, { id: (Date.now() + 1).toString(), role: "assistant", text: "Backend unavailable — response is local only. Launch inside Electron to enable AI runs." }]);
    }, 200);
  };

  const handleEditMessage = useCallback(
    async (id: string, newText: string) => {
      if (persistent && !id.startsWith("local-")) {
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
    const text = `${voice.transcript}${voice.interimTranscript ? " " + voice.interimTranscript : ""}`.trim();
    if (text) {
      setInput((prev) => (prev ? (prev.endsWith(" ") ? prev : prev + " ") + text : text));
      window.setTimeout(() => {
        const el = document.querySelector("textarea") as HTMLTextAreaElement | null;
        el?.focus();
      }, 50);
    }
    voice.close();
    window.setTimeout(() => voice.clearTranscript(), 200);
  }, [voice]);

  useEffect(() => {
    if (!voice.isRecording && voice.recordedBlob && (voice.transcript || voice.interimTranscript)) {
      const text = `${voice.transcript}${voice.interimTranscript ? " " + voice.interimTranscript : ""}`.trim();
      if (text) {
        setInput((prev) => {
          if (prev.includes(text)) return prev;
          return prev ? (prev.endsWith(" ") ? prev : prev + " ") + text : text;
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
    <div className="flex flex-col h-screen w-full font-sans overflow-hidden relative select-none page-apple-enter" style={{ background: "#181818" }}>
      <TitleBar />

      <div className="flex flex-1 overflow-hidden p-3 gap-3 relative z-10" style={{ background: "#181818" }}>
        <LeftSidebar
          collapsed={leftCollapsed}
          onCollapse={() => setLeftCollapsed(true)}
          chats={history}
          activeId={chatId}
          onSelect={handleSelectChat}
          onNewChat={handleNewChat}
          onDeleteChat={handleDeleteChat}
          onRename={handleRenameChat}
          workspace={activeWorkspace}
          workspaceTree={workspaceTree}
          onPickWorkspace={handlePickWorkspace}
          onCloseWorkspace={handleCloseWorkspace}
          onRefreshTree={handleRefreshWorkspaceTree}
          onSelectWorkspaceFile={handleSelectWorkspaceFile}
          workspaceLoading={workspaceLoading}
        />

        <ChatPanel title={activeTitle} leftCollapsed={leftCollapsed} rightCollapsed={rightCollapsed} onToggleLeft={() => setLeftCollapsed(!leftCollapsed)} onToggleRight={() => setRightCollapsed(!rightCollapsed)}>
          {activeRoute && <RouteBadge route={activeRoute} state={runState} />}
          {runError && (
            <div className="mx-4 mt-2 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-300 flex flex-col gap-1 select-text">
              <div className="flex items-start justify-between gap-2">
                <span className="break-words whitespace-pre-wrap cursor-text"><strong>{runError.code}:</strong> {runError.message}</span>
                <button onClick={() => setRunError(null)} className="shrink-0 w-6 h-6 rounded-full bg-white/10 grid place-items-center">x</button>
              </div>
              <span className="opacity-60 text-[11px] cursor-text">Full model response is in Model Trace (Settings sidebar & terminal logs) — expand provider_content_raw / normalized to see what the model returned.</span>
            </div>
          )}
          {isRunning && (
            <div className="mx-4 mt-2 flex items-center gap-2 text-xs opacity-60">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              {runState === "awaiting_confirmation" ? "Awaiting confirmation" : `Run ${runState}...`}
              {groundingStatus && (
                <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
                  {groundingStatus.status === "retrieving"
                    ? "Retrieving SOP context..."
                    : groundingStatus.status === "injected"
                    ? `Grounding: ${groundingStatus.chunkCount ?? 0} SOP chunks`
                    : "Grounding: No SOP found"}
                </span>
              )}
              <button onClick={handleCancelRun} className="ml-auto px-3 py-1 rounded-full neu-button text-xs">Cancel</button>
            </div>
          )}
          <ChatArea
            messages={messages}
            onEditMessage={handleEditMessage}
            onAttachFiles={addFiles}
            onSaveArtifact={handleSaveArtifact}
            isRunning={isRunning}
            runState={runState}
            activeRoute={activeRoute}
            runEvents={runEvents}
          />
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
            disabled={isRunning}
            groundingEnabled={groundingEnabled}
            setGroundingEnabled={setGroundingEnabled}
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
          activeRoute={activeRoute}
          runState={runState}
          health={serviceHealth}
          healthLoading={healthLoading}
          onRefreshHealth={refreshHealth}
          runEvents={runEvents}
          runId={activeRunId}
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

      <ConfirmationModal
        open={!!pendingConfirmation}
        action={pendingConfirmation}
        runState={runState}
        onApprove={() => handleConfirm(true)}
        onReject={() => handleConfirm(false)}
        onClose={() => {}}
        busy={confirmationBusy}
      />
    </div>
  );
}
