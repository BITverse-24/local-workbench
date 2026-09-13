import React, { useState } from "react";
import * as wb from "../../lib/workbench";

export interface OnboardingPageProps {
  onComplete: () => void;
  initialConfig?: ModelConfigRow[];
}

interface RowState {
  role: ModelRoleType;
  title: string;
  description: string;
  badge: string;
  badgeColor: string;
  modelName: string;
  host: string;
  port: string;
  contextLength: string;
  testStatus: "idle" | "testing" | "success" | "warning" | "error";
  testMessage?: string;
  testLatency?: number;
}

const DEFAULT_ROWS: RowState[] = [
  {
    role: "vision",
    title: "Vision & OCR",
    description: "Inspection reports, engineering drawings, P&ID diagrams",
    badge: "VISION",
    badgeColor: "bg-[var(--bg-surface-raised)] text-[var(--text-secondary)] border-[var(--border-subtle)]",
    modelName: "qwen2.5vl:3b",
    host: "127.0.0.1",
    port: "11434",
    contextLength: "32768",
    testStatus: "idle",
  },
  {
    role: "coding",
    title: "Coding & Analysis",
    description: "Python execution, automated script repair, CSV parsing",
    badge: "CODE",
    badgeColor: "bg-[var(--bg-surface-raised)] text-[var(--text-secondary)] border-[var(--border-subtle)]",
    modelName: "qwen2.5-coder:7b",
    host: "127.0.0.1",
    port: "11434",
    contextLength: "32768",
    testStatus: "idle",
  },
  {
    role: "draft",
    title: "Draft & Reasoning",
    description: "Approval notes, synthesis, technical memos, chat",
    badge: "DRAFT",
    badgeColor: "bg-[var(--bg-surface-raised)] text-[var(--text-secondary)] border-[var(--border-subtle)]",
    modelName: "qwen3:8b",
    host: "127.0.0.1",
    port: "11434",
    contextLength: "32768",
    testStatus: "idle",
  },
  {
    role: "plan",
    title: "Routing & Planning",
    description: "Multi-stage pipeline decomposition and subtask routing",
    badge: "PLAN",
    badgeColor: "bg-[var(--bg-surface-raised)] text-[var(--text-secondary)] border-[var(--border-subtle)]",
    modelName: "qwen3:8b",
    host: "127.0.0.1",
    port: "11434",
    contextLength: "8192",
    testStatus: "idle",
  },
  {
    role: "embedding",
    title: "Vector Embedding",
    description: "Local RAG semantic search, SOP grounding (/embeddings)",
    badge: "EMBED",
    badgeColor: "bg-[var(--bg-surface-raised)] text-[var(--text-secondary)] border-[var(--border-subtle)]",
    modelName: "nomic-embed-text:v1.5",
    host: "127.0.0.1",
    port: "11434",
    contextLength: "2048",
    testStatus: "idle",
  },
];

export default function OnboardingPage({ onComplete, initialConfig }: OnboardingPageProps) {
  // Allow external requests toggle: defaults to false (strict localhost 127.0.0.1)
  const [allowExternal, setAllowExternal] = useState<boolean>(() => {
    if (initialConfig && initialConfig.length > 0) {
      return initialConfig.some(
        (c) => c.host && c.host !== "127.0.0.1" && c.host !== "localhost",
      );
    }
    return false;
  });

  const [rows, setRows] = useState<RowState[]>(() => {
    if (initialConfig && initialConfig.length > 0) {
      return DEFAULT_ROWS.map((def) => {
        const found = initialConfig.find((c) => c.role === def.role);
        if (found) {
          return {
            ...def,
            modelName: found.modelName,
            host: found.host,
            port: String(found.port),
            contextLength: String(found.contextLength),
          };
        }
        return def;
      });
    }
    return DEFAULT_ROWS;
  });

  const [saving, setSaving] = useState(false);
  const [testingAll, setTestingAll] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const handleToggleAllowExternal = () => {
    const nextVal = !allowExternal;
    setAllowExternal(nextVal);
    // If switching off, lock all hosts back to 127.0.0.1
    if (!nextVal) {
      setRows((prev) =>
        prev.map((r) => ({
          ...r,
          host: "127.0.0.1",
          testStatus: "idle",
          testMessage: undefined,
        })),
      );
    }
  };

  const updateRow = (index: number, field: keyof RowState, value: string) => {
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value, testStatus: "idle", testMessage: undefined };
      return next;
    });
  };

  const applyHostPortToAll = (sourceIndex: number) => {
    const sourceHost = rows[sourceIndex].host;
    const sourcePort = rows[sourceIndex].port;
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        host: sourceHost,
        port: sourcePort,
        testStatus: "idle",
        testMessage: undefined,
      })),
    );
  };

  const prefillOllama = () => {
    setRows(DEFAULT_ROWS.map((r) => ({ ...r, testStatus: "idle", testMessage: undefined })));
  };

  const prefillLMStudio = () => {
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        host: allowExternal ? r.host : "127.0.0.1",
        port: "1234",
        testStatus: "idle",
        testMessage: undefined,
      })),
    );
  };

  const prefillVLLM = () => {
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        host: allowExternal ? r.host : "127.0.0.1",
        port: "8000",
        testStatus: "idle",
        testMessage: undefined,
      })),
    );
  };

  const clearForm = () => {
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        modelName: "",
        host: allowExternal ? "" : "127.0.0.1",
        port: "",
        contextLength: "",
        testStatus: "idle",
        testMessage: undefined,
      })),
    );
  };

  const testEndpoint = async (index: number) => {
    const r = rows[index];
    const portNum = parseInt(r.port, 10);
    const hostToTest = allowExternal ? r.host.trim() : "127.0.0.1";

    if (!hostToTest || isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setRows((prev) => {
        const next = [...prev];
        next[index] = {
          ...next[index],
          testStatus: "error",
          testMessage: "Valid Host and Port (1-65535) required",
        };
        return next;
      });
      return;
    }

    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], testStatus: "testing", testMessage: undefined };
      return next;
    });

    try {
      const res = await wb.testModelEndpoint({
        host: hostToTest,
        port: portNum,
        modelName: r.modelName.trim(),
        role: r.role,
      });

      setRows((prev) => {
        const next = [...prev];
        if (res.ok) {
          const lat = res.latencyMs !== undefined ? `${res.latencyMs}ms` : "";
          const foundMsg = res.modelFound ? "Verified" : "Reachable (model not in list)";
          next[index] = {
            ...next[index],
            testStatus: res.modelFound ? "success" : "warning",
            testLatency: res.latencyMs,
            testMessage: `${foundMsg} (${lat})`,
          };
        } else {
          next[index] = {
            ...next[index],
            testStatus: "error",
            testMessage: res.error || "Cannot reach endpoint",
          };
        }
        return next;
      });
    } catch (err: any) {
      setRows((prev) => {
        const next = [...prev];
        next[index] = {
          ...next[index],
          testStatus: "error",
          testMessage: err?.message || "Test failed",
        };
        return next;
      });
    }
  };

  const testAllEndpoints = async () => {
    setTestingAll(true);
    await Promise.all(rows.map((_, idx) => testEndpoint(idx)));
    setTestingAll(false);
  };

  // Validation
  const getFieldError = (r: RowState, field: "modelName" | "host" | "port" | "contextLength"): string | null => {
    if (field === "modelName" && !r.modelName.trim()) return "Model name required";
    if (field === "host" && allowExternal && !r.host.trim()) return "Host required";
    if (field === "port") {
      const p = parseInt(r.port, 10);
      if (isNaN(p) || p < 1 || p > 65535) return "1-65535";
    }
    if (field === "contextLength") {
      const c = parseInt(r.contextLength, 10);
      if (isNaN(c) || c < 512) return "Min 512";
    }
    return null;
  };

  const hasErrors = rows.some((r) =>
    ["modelName", "host", "port", "contextLength"].some((f) => getFieldError(r, f as any)),
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setGlobalError(null);

    if (hasErrors) {
      setGlobalError("Please correct the invalid fields highlighted below.");
      return;
    }

    setSaving(true);
    try {
      const payload: ModelConfigRow[] = rows.map((r) => ({
        role: r.role,
        modelName: r.modelName.trim(),
        host: allowExternal ? r.host.trim() : "127.0.0.1",
        port: parseInt(r.port, 10),
        contextLength: parseInt(r.contextLength, 10) || 32768,
      }));

      const res = await wb.saveModelConfig(payload);
      if (res.ok) {
        onComplete();
      } else {
        setGlobalError("Failed to save model configuration.");
      }
    } catch (err: any) {
      setGlobalError(err?.message || "An unexpected error occurred while saving configuration.");
    } finally {
      setSaving(false);
    }
  };

  const step1Done = rows.some((r) => r.testStatus === "success");
  const step2Done = rows.every((r) => r.modelName.trim().length > 0);
  const step3Done = !allowExternal || rows.every((r) => r.host.trim().length > 0);

  const getRoleIcon = (role: string) => {
    switch (role.toLowerCase()) {
      case "vision":
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          </svg>
        );
      case "coding":
      case "code":
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
        );
      case "draft":
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        );
      case "plan":
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 2 7 12 12 22 7 12 2" />
            <polyline points="2 17 12 22 22 17" />
            <polyline points="2 12 12 17 22 12" />
          </svg>
        );
      default:
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="8" />
          </svg>
        );
    }
  };

  return (
    <div className="w-full h-full min-h-screen flex flex-col justify-between px-8 sm:px-12 lg:px-16 py-8 bg-[var(--bg-canvas)] text-[var(--text-primary)] overflow-y-auto select-none">
      <div className="w-full max-w-[1760px] mx-auto flex-1 flex flex-col space-y-5">
        {/* 1. Header Section */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 pb-5 border-b border-[var(--border-subtle)]">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold tracking-[0.02em] uppercase text-[var(--text-tertiary)]">
                Air-gapped system setup
              </span>
            </div>
            <h1 className="text-[20px] font-semibold text-[var(--text-primary)] tracking-tight">
              LLM Model Endpoint Configuration
            </h1>
            <p className="text-xs sm:text-sm text-[var(--text-secondary)] max-w-4xl leading-relaxed">
              Industrial multi-model orchestration for defence manufacturing,
              PSU engineering, and government facilities. Assign offline,
              OpenAI-compatible model endpoints for each specialized operational
              role.
            </p>
          </div>

          {/* Quick Presets Toolbar */}
          <div className="flex items-center gap-2.5 flex-wrap shrink-0">
            <button
              type="button"
              onClick={prefillOllama}
              className="h-9 sm:h-10 px-3.5 sm:px-4 rounded-[var(--radius-sm)] text-xs sm:text-sm font-medium neu-button"
              title="Populate standard local Ollama ports (11434)"
            >
              Ollama (11434)
            </button>
            <button
              type="button"
              onClick={prefillLMStudio}
              className="h-9 sm:h-10 px-3.5 sm:px-4 rounded-[var(--radius-sm)] text-xs sm:text-sm font-medium neu-button"
              title="Populate standard local LM Studio port (1234)"
            >
              LM Studio (1234)
            </button>
            <button
              type="button"
              onClick={prefillVLLM}
              className="h-9 sm:h-10 px-3.5 sm:px-4 rounded-[var(--radius-sm)] text-xs sm:text-sm font-medium neu-button"
              title="Populate standard local vLLM port (8000)"
            >
              vLLM (8000)
            </button>
            <button
              type="button"
              onClick={testAllEndpoints}
              disabled={testingAll}
              className="h-9 sm:h-10 px-3.5 sm:px-4 rounded-[var(--radius-sm)] text-xs sm:text-sm font-medium neu-button disabled:opacity-40"
            >
              {testingAll ? "Testing all…" : "Test all endpoints"}
            </button>
            <button
              type="button"
              onClick={clearForm}
              className="h-9 sm:h-10 px-3.5 sm:px-4 rounded-[var(--radius-sm)] text-xs sm:text-sm font-medium neu-button opacity-70 hover:opacity-100 hover:text-[var(--status-error)] transition-colors"
            >
              Clear
            </button>
          </div>
        </div>

        {/* 2. Enterprise Instructions & Network Policy Panel */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Card 1: Runtime Prerequisites */}
          <div className="neu-card p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface-raised)] flex flex-col justify-between space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--text-secondary)]">
                  Local inference server
                </span>
                <span
                  className={`text-xs font-mono font-semibold ${step1Done ? "text-[var(--status-success)]" : "text-[var(--text-tertiary)]"}`}
                >
                  1
                </span>
              </div>
              <h3 className="text-sm font-medium text-[var(--text-primary)]">
                OpenAI-Compatible REST API
              </h3>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                Ensure an approved local server (Ollama, vLLM, LM Studio, or
                llama-server) is listening. Sovereign Workbench communicates via
                standard HTTP JSON payloads.
              </p>
            </div>
            <div className="text-[11px] font-mono text-[var(--text-tertiary)] pt-2.5 border-t border-[var(--border-subtle)]">
              Standard routes: /v1/chat/completions, /v1/models
            </div>
          </div>

          {/* Card 2: Deterministic Routing Architecture */}
          <div className="neu-card p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface-raised)] flex flex-col justify-between space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--text-secondary)]">
                  Role delegation policy
                </span>
                <span
                  className={`text-xs font-mono font-semibold ${step2Done ? "text-[var(--status-success)]" : "text-[var(--text-tertiary)]"}`}
                >
                  2
                </span>
              </div>
              <h3 className="text-sm font-medium text-[var(--text-primary)]">
                Deterministic Task Routing
              </h3>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                Workloads are strictly partitioned: Vision handles drawings/OCR,
                Coding executes Python math, Draft writes technical notes, and
                Embedding executes local RAG vectors.
              </p>
            </div>
            <div className="text-[11px] font-mono text-[var(--text-tertiary)] pt-2.5 border-t border-[var(--border-subtle)]">
              Single multi-model engine or distributed cluster
            </div>
          </div>

          {/* Card 3: Air-Gap Boundary & "Allow external requests" Inverse Toggle */}
          <div className="neu-card p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface-raised)] flex flex-col justify-between space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--text-secondary)]">
                  Air-gap isolation policy
                </span>
                <span
                  className={`text-xs font-mono font-semibold ${step3Done ? "text-[var(--status-success)]" : "text-[var(--text-tertiary)]"}`}
                >
                  3
                </span>
              </div>
              <h3 className="text-sm font-medium text-[var(--text-primary)]">
                Network Boundary Enforcement
              </h3>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                By default, all network calls are physically restricted to
                loopback (127.0.0.1) with zero data egress. Enable external
                requests only to target air-gapped LAN GPU nodes.
              </p>
            </div>

            {/* Flat Toggle Switch */}
            <div className="pt-2.5 border-t border-[var(--border-subtle)] flex items-center justify-between gap-4">
              <div>
                <div className="text-xs font-medium text-[var(--text-primary)]">
                  Allow external requests
                </div>
                <div className="text-[11px] text-[var(--text-tertiary)] mt-0.5">
                  {allowExternal
                    ? "LAN access enabled — Host/IP unlocked"
                    : "Loopback locked — Host/IP forced to 127.0.0.1"}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={allowExternal}
                onClick={handleToggleAllowExternal}
                className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border border-[var(--border-default)] transition-colors duration-150 ease-in-out focus:outline-none ${
                  allowExternal
                    ? "bg-[var(--accent)]"
                    : "bg-[var(--bg-surface-raised)]"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-[var(--text-primary)] transition duration-150 ease-in-out mt-0.5 ${
                    allowExternal ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          </div>
        </div>

        {globalError && (
          <div className="p-3.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--status-error)]/40 text-[var(--status-error)] text-xs flex items-center gap-2.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-error)] shrink-0" />
            <span>{globalError}</span>
          </div>
        )}

        {/* 3. Model Role Endpoints Table */}
        <form
          onSubmit={handleSubmit}
          className="flex-1 flex flex-col justify-between pt-1"
        >
          <div className="flex-1 flex flex-col justify-between space-y-3 sm:space-y-4">
            {/* Table Column Headers */}
            <div className="flex items-center gap-4 px-2">
              <div className="flex-1 grid grid-cols-12 gap-4 px-4 py-1.5 text-xs text-[var(--text-tertiary)] font-medium">
                <div className="col-span-3">Operational role & task</div>
                <div className="col-span-3">Model tag / identifier</div>
                <div className="col-span-2">Host / IP address</div>
                <div className="col-span-1">Port</div>
                <div className="col-span-1">Context</div>
                <div className="col-span-2 text-right">
                  Endpoint status & test
                </div>
              </div>
              <div className="w-28 text-xs text-[var(--text-tertiary)] font-medium text-center">
                Sync row
              </div>
            </div>

            {/* Rows List */}
            {rows.map((row, idx) => {
              const modelErr = getFieldError(row, "modelName");
              const hostErr = getFieldError(row, "host");
              const portErr = getFieldError(row, "port");
              const contextErr = getFieldError(row, "contextLength");

              return (
                <div key={row.role} className="flex items-center gap-4">
                  {/* Main Table Row Card */}
                  <div className="flex-1 rounded-[var(--radius-md)] p-5 sm:p-6 bg-[var(--bg-surface)] border border-[var(--border-subtle)] hover:border-[var(--border-default)] transition-colors">
                    <div className="grid grid-cols-12 gap-4 items-center">
                      {/* Col 1: Role & Description */}
                      <div className="col-span-3 flex items-start gap-3 pr-2">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-raised)] text-[var(--text-secondary)] text-xs font-mono shrink-0 mt-0.5">
                          <span className="shrink-0">
                            {getRoleIcon(row.role)}
                          </span>
                          <span>{row.badge}</span>
                        </span>
                        <div>
                          <div className="font-semibold text-[var(--text-primary)] text-sm">
                            {row.title}
                          </div>
                          <div className="text-xs text-[var(--text-secondary)] leading-relaxed mt-0.5">
                            {row.description}
                          </div>
                        </div>
                      </div>

                      {/* Col 2: Model Name Input */}
                      <div className="col-span-3">
                        <input
                          type="text"
                          value={row.modelName}
                          onChange={(e) =>
                            updateRow(idx, "modelName", e.target.value)
                          }
                          placeholder="e.g. qwen2.5-coder:7b"
                          className={`w-full h-11 px-3.5 rounded-[var(--radius-sm)] text-sm neu-input font-mono outline-none transition-all ${
                            modelErr
                              ? "border-[var(--status-error)] focus:border-[var(--status-error)]"
                              : "border-[var(--border-default)] focus:border-[var(--accent)]"
                          }`}
                        />
                        {modelErr && (
                          <span className="text-[11px] text-[var(--status-error)] mt-1 block font-mono">
                            {modelErr}
                          </span>
                        )}
                      </div>

                      {/* Col 3: Host / IP Address Input (Locked when !allowExternal) */}
                      <div className="col-span-2">
                        <div className="relative">
                          <input
                            type="text"
                            disabled={!allowExternal}
                            value={allowExternal ? row.host : "127.0.0.1"}
                            onChange={(e) =>
                              updateRow(idx, "host", e.target.value)
                            }
                            placeholder="127.0.0.1"
                            className={`w-full h-11 px-3.5 rounded-[var(--radius-sm)] text-sm font-mono outline-none transition-all ${
                              !allowExternal
                                ? "bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--text-tertiary)] cursor-not-allowed select-none"
                                : hostErr
                                  ? "neu-input border-[var(--status-error)] focus:border-[var(--status-error)] text-[var(--text-primary)]"
                                  : "neu-input border-[var(--border-default)] focus:border-[var(--accent)] text-[var(--text-primary)]"
                            }`}
                          />
                          {!allowExternal && (
                            <span className="absolute right-3 top-3 text-[11px] font-mono text-[var(--text-tertiary)] select-none">
                              locked
                            </span>
                          )}
                        </div>
                        {hostErr && (
                          <span className="text-[11px] text-[var(--status-error)] mt-1 block font-mono">
                            {hostErr}
                          </span>
                        )}
                      </div>

                      {/* Col 4: Port Input */}
                      <div className="col-span-1">
                        <input
                          type="number"
                          min={1}
                          max={65535}
                          value={row.port}
                          onChange={(e) =>
                            updateRow(idx, "port", e.target.value)
                          }
                          placeholder="11434"
                          className={`w-full h-11 px-3 rounded-[var(--radius-sm)] text-sm neu-input font-mono outline-none transition-all ${
                            portErr
                              ? "border-[var(--status-error)] focus:border-[var(--status-error)]"
                              : "border-[var(--border-default)] focus:border-[var(--accent)]"
                          }`}
                        />
                        {portErr && (
                          <span className="text-[11px] text-[var(--status-error)] mt-1 block font-mono">
                            {portErr}
                          </span>
                        )}
                      </div>

                      {/* Col 5: Context Length Input */}
                      <div className="col-span-1">
                        <input
                          type="number"
                          min={512}
                          step={512}
                          value={row.contextLength}
                          onChange={(e) =>
                            updateRow(idx, "contextLength", e.target.value)
                          }
                          placeholder="32768"
                          className={`w-full h-11 px-3 rounded-[var(--radius-sm)] text-sm neu-input font-mono outline-none transition-all ${
                            contextErr
                              ? "border-[var(--status-error)] focus:border-[var(--status-error)]"
                              : "border-[var(--border-default)] focus:border-[var(--accent)]"
                          }`}
                        />
                        {contextErr && (
                          <span className="text-[11px] text-[var(--status-error)] mt-1 block font-mono">
                            {contextErr}
                          </span>
                        )}
                      </div>

                      {/* Col 6: Status & Test Action */}
                      <div className="col-span-2 flex items-center justify-end gap-2.5">
                        {row.testStatus === "testing" && (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-xs text-[var(--status-warning)] font-mono">
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-warning)]" />
                            Testing…
                          </span>
                        )}
                        {row.testStatus === "success" && (
                          <span
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-xs text-[var(--status-success)] font-mono"
                            title={row.testMessage}
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-success)]" />
                            Connected{" "}
                            {row.testLatency !== undefined
                              ? `(${row.testLatency}ms)`
                              : ""}
                          </span>
                        )}
                        {row.testStatus === "warning" && (
                          <span
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-xs text-[var(--status-warning)] font-mono"
                            title={row.testMessage}
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-warning)]" />
                            Reachable
                          </span>
                        )}
                        {row.testStatus === "error" && (
                          <span
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-xs text-[var(--status-error)] max-w-[140px] truncate font-mono"
                            title={row.testMessage}
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-error)]" />
                            Failed
                          </span>
                        )}

                        <button
                          type="button"
                          onClick={() => testEndpoint(idx)}
                          disabled={row.testStatus === "testing"}
                          className="h-11 px-4 rounded-[var(--radius-sm)] text-xs font-semibold neu-button disabled:opacity-40"
                        >
                          Test
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Copy to All Button */}
                  <button
                    type="button"
                    onClick={() => applyHostPortToAll(idx)}
                    className="w-32 h-11 px-3 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface-raised)] hover:bg-[var(--bg-surface-active)] text-xs font-sans text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors shrink-0 flex items-center justify-center gap-1.5"
                    title={`Copy Host and Port from ${row.title} (${row.host}:${row.port}) to all other rows`}
                  >
                    <span>Copy to all</span>
                  </button>
                </div>
              );
            })}
          </div>

          {/* 4. Bottom Commit & Launch Action Bar */}
          <div className="pt-5 pb-2 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-[var(--border-subtle)]">
            <div className="text-xs sm:text-sm text-[var(--text-secondary)] flex items-center gap-2.5">
              <span className="w-2 h-2 rounded-full bg-[var(--status-success)] shrink-0" />
              <span>
                Configuration is saved to local SQLite database (
                <code className="font-mono text-[var(--text-primary)]">
                  workbench.db
                </code>
                ). Offline operation.
              </span>
            </div>

            <button
              type="submit"
              disabled={saving || hasErrors}
              className="h-12 sm:h-13 px-8 sm:px-10 rounded-[var(--radius-sm)] font-semibold text-sm neu-button-primary disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2.5"
            >
              {saving ? (
                <>
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Saving configuration…</span>
                </>
              ) : (
                <span>Launch Workbench</span>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Industrial Footer Notice */}
      <div className="pt-4 pb-1 text-center text-xs text-[var(--text-tertiary)] font-sans">
        Sovereign Workbench · defence & PSU mission-critical intelligence
        platform · air-gapped verified
      </div>
    </div>
  );
}
