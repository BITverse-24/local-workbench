import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import "./App.css";
import TitleBar from "./components/TitleBar";
import LeftSidebar, { type SidebarChat } from "./components/LeftSidebar";
import ChatPanel from "./components/ChatPanel";
import ChatArea, { type ChatMessage } from "./components/ChatArea";
import InputBar from "./components/InputBar";
import RightSidebar from "./components/RightSidebar";
import ModelDropdown from "./components/ModelDropdown";
import UploadModal from "./components/modals/UploadModal";
import CameraModal from "./components/modals/CameraModal";
import VoiceModal from "./components/modals/VoiceModal";
import ConfirmationModal from "./components/ConfirmationModal";
import RouteBadge from "./components/RouteBadge";
import OnboardingPage from "./components/onboarding/OnboardingPage";
import { getModelRoutes, MODELS } from "./lib/models";
import * as wb from "./lib/workbench";
import { useDropdownPosition } from "./lib/hooks/useDropdownPosition";
import { useCamera } from "./lib/hooks/useCamera";
import { useVoice } from "./lib/hooks/useVoice";
import { useUpload } from "./lib/hooks/useUpload";
import { RunSessions } from "./lib/run-sessions";
import { updateRunEvents } from "./lib/run-progress";

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
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [history, setHistory] = useState<SidebarChat[]>([]);
  const chatIdRef=useRef<string|null>(null);
  const [,setRunRevision]=useState(0);
  const sessions=useRef(new RunSessions());
  const pendingSubmissions=useRef(new Set<string>());
  const [chatId, updateChatId] = useState<string | null>(null);
  const setChatId=useCallback((id:string|null)=>{chatIdRef.current=id;updateChatId(id);},[]);
  const [persistent, setPersistent] = useState(false);

  // Run state
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState | null>(null);
  const [activeRoute, setActiveRoute] = useState<{ taskType?: string; tier?: "text" | "vision"; modelId: string; reason: string } | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingAction | null>(null);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [verificationReport, setVerificationReport] = useState<RunVerificationReport | null>(null);
  const [, setRunArtifacts] = useState<ArtifactRef[]>([]);
  const [runError, setRunError] = useState<{ code: string; message: string } | null>(null);
  const [serviceHealth, setServiceHealth] = useState<ModelHealth[] | null>(null);
  const [executionCapabilities, setExecutionCapabilities] = useState<ExecutionCapabilities | null>(null);
  const [executionCapabilitiesError, setExecutionCapabilitiesError] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [groundingEnabled, setGroundingEnabled] = useState(false);
  const [, setGroundingStatus] = useState<{ status: "retrieving" | "injected" | "skipped"; chunkCount?: number } | null>(null);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("workbench:execution_mode");
      if (saved === "chat" || saved === "work" || saved === "agent") return saved;
    }
    return "chat";
  });
  const handleModeChange=(next:ExecutionMode)=>{setExecutionMode(next);localStorage.setItem("workbench:execution_mode",next);};

  const activeRunRef = useRef<string | null>(null);
  activeRunRef.current = activeRunId;
  const runEventsRef = useRef<RunEvent[]>([]);
  runEventsRef.current = runEvents;
  const runArtifactsRef = useRef<ArtifactRef[]>([]);
  const activeRouteRef = useRef<{ taskType?: string; tier?: "text" | "vision"; modelId: string; reason: string } | null>(null);
  activeRouteRef.current = activeRoute;
  const runStartTimeRef = useRef<number | null>(null);
  const isRunning = pendingSubmissions.current.has(chatId??"new-chat") || (runState !== null && !["completed", "partial", "failed", "cancelled", "limit_exceeded"].includes(runState));

  useEffect(() => {
    let active = true;
    setVerificationReport(null);
    if (activeRunId && wb.isWorkbenchAvailable()) {
      void wb.getVerificationReport({ runId: activeRunId }).then((report) => { if (active) setVerificationReport(report ?? null); }).catch(() => { if (active) setVerificationReport(null); });
    }
    return () => { active = false; };
  }, [activeRunId]);

  // Onboarding state
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null);
  const [cachedModels, setCachedModels] = useState<ModelConfigRow[] | undefined>(undefined);
  const [modelSettingsError, setModelSettingsError] = useState<string | null>(null);

  const availableModels = useMemo(() => getModelRoutes(cachedModels), [cachedModels]);

  useEffect(() => {
    if (availableModels.length > 0) {
      const savedModelId = typeof window !== "undefined" ? localStorage.getItem("workbench_selected_model") : null;
      setSelectedModel((prev) => {
        if (availableModels.length === 1) {
          return availableModels[0];
        }
        const match = availableModels.find((m) => m.id === savedModelId)
          ?? availableModels.find((m) => m.id === prev?.id)
          ?? availableModels.find((m) => m.name === prev?.name);
        return match ?? availableModels[0];
      });
    }
  }, [availableModels]);

  // Workspace state
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);
  const [workspaceTree, setWorkspaceTree] = useState<HarnessDirEntry[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);

  useEffect(()=>{if(!activeWorkspace&&executionMode==="agent")setExecutionMode("chat");},[activeWorkspace,executionMode]);

  const refreshExecutionCapabilities = useCallback(async () => {
    if (!wb.isWorkbenchAvailable()) return;
    try {
      setExecutionCapabilities(await wb.getExecutionCapabilities());
      setExecutionCapabilitiesError(null);
    } catch {
      setExecutionCapabilities(null);
      setExecutionCapabilitiesError("Execution support could not be checked. Use Refresh in Service health to retry. Workspace commands still require OS isolation. Python requires separate approval if isolation is unavailable.");
    }
  }, []);
  useEffect(() => { void refreshExecutionCapabilities(); }, [refreshExecutionCapabilities]);

  // Launch: restore history, last chat, temperature, workspace, onboarding
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!wb.isWorkbenchAvailable()) return;
      try {
        // Check onboarding status first
        try {
          const ob = await wb.getOnboardingStatus();
          if (!cancelled) {
            setOnboardingCompleted(ob.completed);
            setCachedModels(ob.configuredModels);
          }
        } catch {
          if (!cancelled) setOnboardingCompleted(true);
        }

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
        runArtifactsRef.current = [];
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
    void refreshExecutionCapabilities();
    try {
      const h = await wb.getHealth();
      setServiceHealth(h);
    } catch {
      void 0;
    }
    setHealthLoading(false);
  }, [refreshExecutionCapabilities]);

  // Single run-event subscription
  useEffect(() => {
    if (!wb.isWorkbenchAvailable()) return;
    let unsub: (() => void) | undefined;
    let chunkTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingChunks: Array<Extract<RunEvent, { type: "assistant_message_chunk" }>> = [];
    const flushChunks = () => {
      if (chunkTimer) clearTimeout(chunkTimer);
      chunkTimer = undefined;
      const chunks = pendingChunks;
      pendingChunks = [];
      if (!chunks.length) return;
      setMessages((previous) => {
        let next = previous;
        for (const event of chunks) {
          if(!sessions.current.belongsTo(event.runId,chatIdRef.current))continue;
          const last = next[next.length - 1];
          if (last?.id === event.messageId) next = [...next.slice(0, -1), { ...last, text: last.text + event.delta }];
          else if (last?.role === "assistant" && (!last.text || last.id.startsWith("artifact-msg-"))) {
            next = [...next.slice(0, -1), { ...last, id: event.messageId, runId: event.runId, text: event.delta }];
          } else next = [...next, { id: event.messageId, runId: event.runId, role: "assistant", text: event.delta }];
        }
        return next;
      });
    };
    try {
      unsub = wb.onRunEvent((event: RunEvent) => {
        const rid = (event as {runId?:string}).runId;
        sessions.current.record(event);
        if(event.type==="run_state"||event.type==="confirmation_required")setRunRevision(value=>value+1);
        if(rid && !sessions.current.belongsTo(rid,chatIdRef.current))return;
        if(event.type==="run_registered") {activeRunRef.current=event.runId;setActiveRunId(event.runId);return;}
        if(rid && rid!==activeRunRef.current)return;
        // Drain earlier tokens before resets, final messages, and tool transitions.
        if (event.type !== "assistant_message_chunk" && event.type !== "model_progress") flushChunks();
        if (event.type !== "assistant_message_chunk") {
          setRunEvents((prev) => {
            const next = updateRunEvents(prev, event);
            runEventsRef.current = next;
            return next;
          });
        }
        switch (event.type) {
          case "verification_report":
            setVerificationReport(event.report);
            break;
          case "run_state":
            setRunState(event.state);
            if (event.state === "completed" || event.state === "partial" || event.state === "failed" || event.state === "cancelled" || event.state === "limit_exceeded") {
              setPendingConfirmation(null);
              const currentEvents = runEventsRef.current.filter((item) => item.type !== "model_progress");
              if (currentEvents.length > 0) {
                setMessages((prev) => {
                  const lastIdx = prev.length - 1;
                  if (lastIdx >= 0 && prev[lastIdx]?.role === "assistant" && (prev[lastIdx]?.runId === event.runId || !prev[lastIdx]?.execution)) {
                    const updated = [...prev];
                    updated[lastIdx] = {
                      ...updated[lastIdx]!,
                      execution: {
                        mode:rid?sessions.current.modes.get(rid):undefined,
                        state: event.state,
                        modelId: activeRouteRef.current?.modelId,
                        taskType: activeRouteRef.current?.taskType,
                        tier: activeRouteRef.current?.tier,
                        reason: activeRouteRef.current?.reason,
                        events: currentEvents,
                        durationMs: runStartTimeRef.current ? Date.now() - runStartTimeRef.current : undefined,
                      },
                    };
                    return updated;
                  }
                  return prev;
                });
              }
            }
            break;
          case "routing":
            activeRouteRef.current = { taskType: event.taskType, tier: event.tier, modelId: event.modelId, reason: event.reason };
            setActiveRoute({ taskType: event.taskType, tier: event.tier, modelId: event.modelId, reason: event.reason });
            break;
          case "confirmation_required":
            setPendingConfirmation(event.action);
            break;
          case "artifact_ready":
            if (
              !runArtifactsRef.current.some(
                (a) =>
                  a.artifactId === event.artifact.artifactId ||
                  (a.runId === event.artifact.runId && a.filename === event.artifact.filename),
              )
            ) {
              runArtifactsRef.current.push(event.artifact);
            }
            setRunArtifacts((prev) => {
              if (
                prev.some(
                  (a) =>
                    a.artifactId === event.artifact.artifactId ||
                    (a.runId === event.artifact.runId && a.filename === event.artifact.filename),
                )
              ) {
                return prev;
              }
              return [...prev, event.artifact];
            });
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "assistant") {
                const existing = last.artifacts ?? [];
                if (
                  !existing.some(
                    (a) =>
                      a.artifactId === event.artifact.artifactId ||
                      a.filename === event.artifact.filename,
                  )
                ) {
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
          case "assistant_message_chunk":
            pendingChunks.push(event);
            if (!chunkTimer) chunkTimer = setTimeout(flushChunks, 50);
            break;
          case "assistant_message_reset":
            // Remove discarded provisional bubbles; keep any attached artifacts.
            setMessages((prev) => prev.flatMap((message) => message.id !== event.messageId ? [message]
              : message.artifacts?.length ? [{ ...message, text: "" }] : []));
            break;
          case "assistant_message":
            setMessages((prev) => {
              const currentEvents = runEventsRef.current.filter((item) => item.type !== "model_progress");
              const executionData = currentEvents.length > 0 ? {
                mode:rid?sessions.current.modes.get(rid):undefined,
                modelId: event.modelId || activeRouteRef.current?.modelId,
                taskType: activeRouteRef.current?.taskType,
                tier: activeRouteRef.current?.tier,
                reason: activeRouteRef.current?.reason,
                events: currentEvents,
                durationMs: runStartTimeRef.current ? Date.now() - runStartTimeRef.current : undefined,
              } : undefined;

              // Consolidate all artifacts from persistent ref plus any messages matching this run
              const matchedArtifacts: any[] = [...runArtifactsRef.current];
              for (const m of prev) {
                if (
                  m.id === event.messageId ||
                  (Boolean(rid) && m.runId === rid && m.role === "assistant") ||
                  m.id.startsWith("artifact-msg-")
                ) {
                  if (m.artifacts) {
                    for (const a of m.artifacts) {
                      if (!matchedArtifacts.some((existing) => existing.artifactId === a.artifactId || existing.filename === a.filename)) {
                        matchedArtifacts.push(a);
                      }
                    }
                  }
                }
              }

              // Find any existing assistant message for this run (by messageId, runId, or empty artifact-msg)
              const existingIdx = prev.findIndex(
                (m) =>
                  m.id === event.messageId ||
                  (Boolean(rid) && m.runId === rid && m.role === "assistant") ||
                  (m.role === "assistant" && (!m.text || m.id.startsWith("artifact-msg-"))),
              );

              if (existingIdx !== -1) {
                // Filter out duplicate assistant messages for this run, keeping just the consolidated one
                const filtered = prev.filter(
                  (m, idx) =>
                    idx === existingIdx ||
                    !(
                      (Boolean(rid) && m.runId === rid && m.role === "assistant") ||
                      (m.role === "assistant" && (!m.text || m.id.startsWith("artifact-msg-")))
                    ),
                );
                const targetIdx = filtered.findIndex((m) => m.id === prev[existingIdx].id);
                if (targetIdx !== -1) {
                  filtered[targetIdx] = {
                    ...filtered[targetIdx],
                    id: event.messageId,
                    text: event.text,
                    runId: rid,
                    artifacts: matchedArtifacts.length > 0 ? matchedArtifacts : filtered[targetIdx].artifacts,
                    execution: executionData ?? filtered[targetIdx]?.execution,
                  };
                  return filtered;
                }
              }

              return [
                ...prev,
                {
                  id: event.messageId,
                  role: "assistant",
                  text: event.text,
                  runId: rid,
                  execution: executionData,
                  artifacts: matchedArtifacts.length > 0 ? matchedArtifacts : undefined,
                },
              ];
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
      if (chunkTimer) clearTimeout(chunkTimer);
      pendingChunks = [];
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
      const snapshot=await wb.getRunSnapshot({chatId:id});
      if(chatIdRef.current!==id)return;
      const loaded=toChatMessages(rows);
      if(snapshot){
        sessions.current.register(snapshot.runId,id,snapshot.mode??undefined);sessions.current.states.set(snapshot.runId,snapshot.state);
        activeRunRef.current=snapshot.runId;setActiveRunId(snapshot.runId);setRunState(snapshot.state);
        setPendingConfirmation(snapshot.pendingAction??null);setVerificationReport(snapshot.verification??null);
        runArtifactsRef.current=snapshot.artifacts;setRunArtifacts(snapshot.artifacts);
        const events=[...(sessions.current.events.get(snapshot.runId)??snapshot.progress),{type:"run_queue" as const,runId:snapshot.runId,queued:snapshot.queued}];
        runEventsRef.current=events;setRunEvents(events);
        if(snapshot.draft?.text&&!loaded.some(m=>m.id===snapshot.draft!.messageId))loaded.push({id:snapshot.draft.messageId,runId:snapshot.runId,role:"assistant",text:snapshot.draft.text,artifacts:snapshot.artifacts});
      }
      setMessages(loaded);
    } catch {
      setPersistent(false);
    }
  }, []);

  const handleSelectChat = useCallback(
    async (id: string) => {
      setChatId(id);
      activeRunRef.current=null;
      // Reset run UI when switching chats
      setActiveRunId(null);
      setRunState(null);
      setActiveRoute(null);
      setPendingConfirmation(null);
      setRunEvents([]);
      setRunArtifacts([]);
      runArtifactsRef.current = [];
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
    runArtifactsRef.current = [];
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
        if(chatIdRef.current===chatId)setChatId(id);
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


  const { btnRef: modelBtnRef, pos: dropdownPos } = useDropdownPosition(modelOpen);

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
    setPendingConfirmation(null);
    try {
      await wb.confirmAction({ runId, actionId, approved });
    } catch (e) {
      setRunError({ code: "confirm_failed", message: e instanceof Error ? e.message : String(e) });
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
    const submissionKey=chatIdRef.current??"new-chat";
    if(pendingSubmissions.current.has(submissionKey))return;
    pendingSubmissions.current.add(submissionKey);setRunRevision(value=>value+1);
    let submittedChatId:string|null=null;
    try {
    const text = input;
    const currentFiles = [...attachedFiles];
    if (currentFiles.length === 0) setInput("");

    // Persistent chat + backend run path
    if (persistent) {
      const cid = await ensureChatId(text);
      if (cid) {
        submittedChatId=cid;pendingSubmissions.current.add(cid);
        try {
          const attachmentTokens: string[] = [];
          let runIdForAttachment: string | undefined;
          if (currentFiles.length > 0) {
            for (const f of currentFiles) {
              const reg = await wb.registerAttachment({ chatId: cid, file: f });
              attachmentTokens.push(reg.attachment.attachmentId);
              if (!runIdForAttachment) runIdForAttachment = reg.runId;
            }
            if(chatIdRef.current===cid){setInput("");setAttachedFiles([]);}
          } else {
            if(chatIdRef.current===cid)setAttachedFiles([]);
          }

          // Persist user message linked with attachment IDs (visible immediately)
          const { messageId } = await wb.sendMessage(
            cid,
            "user",
            text,
            attachmentTokens.length > 0 ? attachmentTokens : undefined,
          );
          if(chatIdRef.current===cid)setMessages((prev) => [
            ...prev,
            {
              id: messageId,
              role: "user",
              text,
              files: currentFiles.length > 0 ? currentFiles.map((f) => ({ name: f.name, size: f.size })) : undefined,
            },
          ]);
          setHistory((prev) => prev.map((c) => (c.id === cid ? { ...c, updated_at: new Date().toISOString() } : c)));

          // Only update the chat that owns this submission.
          if(chatIdRef.current===cid){
          runStartTimeRef.current = Date.now();
          runEventsRef.current = [];
          setRunEvents([]);
          setRunArtifacts([]);
          runArtifactsRef.current = [];
          setRunError(null);
          setActiveRoute(null);
          setPendingConfirmation(null);
          setGroundingStatus(null);
          setRunState("created");
          }

          const clientRunId = runIdForAttachment ?? crypto.randomUUID();
          sessions.current.register(clientRunId,cid,executionMode);
          if(chatIdRef.current===cid){activeRunRef.current = clientRunId;setActiveRunId(clientRunId);}

          const { runId } = await wb.startRun({
            userText: text,
            attachmentToken: attachmentTokens[0],
            attachmentTokens,
            runId: clientRunId,
            chatId: cid,
            temperature,
            groundingEnabled,
            preferredRoute: selectedModel?.id,
            selectedModel: selectedModel?.id,
            mode: executionMode,
          });
          if(chatIdRef.current===cid){setActiveRunId(runId);activeRunRef.current = runId;}

          // Re-sync messages from SQLite in case fast background run finished
          try {
            const latest = await wb.getMessages(cid);
            if (chatIdRef.current===cid && latest && latest.length > 0) {
              setMessages((prev) => {
                const loaded = toChatMessages(latest);
                return loaded.map((m) => {
                  const existing = prev.find((p) => p.id === m.id);
                  return existing?.execution ? { ...m, execution: existing.execution } : m;
                });
              });
            }
          } catch {}

          // Chat stays on cid; run is linked via DB.
          return;
        } catch (e) {
          if(chatIdRef.current===cid)setRunError({ code: "send_failed", message: e instanceof Error ? e.message : String(e) });
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
    }finally{pendingSubmissions.current.delete(submissionKey);if(submittedChatId)pendingSubmissions.current.delete(submittedChatId);setRunRevision(value=>value+1);}
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

  if (onboardingCompleted === false) {
    return (
      <div className="flex flex-col h-screen w-full font-sans overflow-hidden relative" style={{ background: "var(--bg-canvas)" }}>
        <TitleBar />
        <div className="flex-1 overflow-hidden relative">
          <OnboardingPage
            initialConfig={cachedModels}
            onComplete={async () => {
              try {
                const ob = await wb.getOnboardingStatus();
                setCachedModels(ob.configuredModels);
              } catch {}
              setOnboardingCompleted(true);
              void refreshHealth();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-full font-sans overflow-hidden relative page-apple-enter" style={{ background: "var(--bg-canvas)" }}>
      <TitleBar />

      <div className="flex flex-1 overflow-hidden p-3 gap-3 relative z-10" style={{ background: "var(--bg-canvas)" }}>
        <LeftSidebar
          collapsed={leftCollapsed}
          onCollapse={() => setLeftCollapsed(true)}
          chats={history.map(chat=>({...chat,runState:sessions.current.states.get(sessions.current.latest.get(chat.id)??"")}))}
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

        <ChatPanel title={activeTitle} leftCollapsed={leftCollapsed} rightCollapsed={rightCollapsed} onToggleLeft={() => setLeftCollapsed(!leftCollapsed)} onToggleRight={() => setRightCollapsed(!rightCollapsed)} onModelSettings={async () => {
          try {
            const result = await wb.resetOnboarding();
            if (!result.ok) throw new Error("Could not open model settings.");
            setModelSettingsError(null);
            setOnboardingCompleted(false);
          } catch (error) {
            setModelSettingsError(error instanceof Error ? error.message : String(error));
          }
        }}>
          {modelSettingsError && <div className="mx-4 mt-2 px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--status-error)]/40 text-xs text-[var(--status-error)] flex items-center justify-between gap-3"><span>{modelSettingsError}</span><button onClick={() => setModelSettingsError(null)} aria-label="Dismiss model settings error">×</button></div>}
          {runState==="partial"&&activeRunId&&["work","agent"].includes(sessions.current.modes.get(activeRunId)??"")&&<button className="mx-4 mt-2 text-sm text-[var(--accent)]" onClick={()=>{const id=activeRunId;void wb.resumeRun({runId:id}).then(()=>{if(activeRunRef.current===id)setRunState("created");}).catch(error=>setRunError({code:"resume_failed",message:String(error)}));}}>Resume from saved evidence</button>}
          {activeRoute && <RouteBadge route={activeRoute} state={runState} />}
          {runError && (
            <div className="mx-4 mt-2 px-3.5 py-2.5 rounded-[var(--radius-sm)] bg-[var(--status-error)]/15 border border-[var(--status-error)]/30 text-sm text-[var(--status-error)] flex flex-col gap-1 select-text">
              <div className="flex items-start justify-between gap-2">
                <span className="break-words whitespace-pre-wrap cursor-text"><strong>{runError.code}:</strong> {runError.message}</span>
                <button onClick={() => setRunError(null)} className="shrink-0 w-6 h-6 rounded-[var(--radius-sm)] neu-button grid place-items-center text-xs text-[var(--text-secondary)]">✕</button>
              </div>
              <span className="opacity-70 text-xs cursor-text">Full model response is in Model Trace (Settings sidebar & terminal logs) — expand provider_content_raw / normalized to see what the model returned.</span>
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
            onCancel={handleCancelRun}
          />
          <InputBar
            input={input}
            setInput={setInput}
            onSend={handleSend}
            attachedFiles={attachedFiles}
            onAttachFiles={addFiles}
            onRemoveFile={removeAttached}
            disabled={isRunning}
            groundingEnabled={groundingEnabled}
            setGroundingEnabled={setGroundingEnabled}
            mode={isRunning && activeRunId ? sessions.current.modes.get(activeRunId) ?? executionMode : executionMode}
            onModeChange={handleModeChange}
            executionCapabilities={executionCapabilities}
            executionCapabilitiesError={executionCapabilitiesError}
            hasWorkspace={Boolean(activeWorkspace)}
          />
        </ChatPanel>

        <RightSidebar
          collapsed={rightCollapsed}
          onCollapse={() => setRightCollapsed(true)}
          models={availableModels}
          selectedModel={selectedModel}
          modelOpen={modelOpen}
          setModelOpen={setModelOpen}
          modelBtnRef={modelBtnRef}
          activeRoute={activeRoute}
          runState={runState}
          health={serviceHealth}
          healthLoading={healthLoading}
          onRefreshHealth={refreshHealth}
          runEvents={runEvents}
          runId={activeRunId}
          verificationReport={verificationReport}
        />
      </div>

      <ModelDropdown open={modelOpen} pos={dropdownPos} models={availableModels} selected={selectedModel} onSelect={(m) => { setSelectedModel(m); try { localStorage.setItem("workbench_selected_model", m.id); } catch {} setModelOpen(false); }} onClose={() => setModelOpen(false)} />

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
