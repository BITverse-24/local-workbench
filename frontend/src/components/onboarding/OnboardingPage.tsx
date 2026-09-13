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
    badgeColor: "bg-blue-500/10 text-blue-400 border-blue-500/25",
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
    badgeColor: "bg-purple-500/10 text-purple-400 border-purple-500/25",
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
    badgeColor: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
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
    badgeColor: "bg-amber-500/10 text-amber-400 border-amber-500/25",
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
    badgeColor: "bg-cyan-500/10 text-cyan-400 border-cyan-500/25",
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

  return (
    <div className="w-full h-full min-h-screen flex flex-col justify-between px-8 sm:px-12 lg:px-18 py-8 bg-[#101010] text-[#E8E8E8] overflow-y-auto select-none animate-apple-message">
      <div className="w-full max-w-[1760px] mx-auto flex-1 flex flex-col justify-between space-y-8">
        {/* 1. Header Section */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 pb-6 border-b border-[#222222]">
          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <span className="text-xs font-mono tracking-widest text-emerald-400 uppercase font-semibold px-3 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/25">
                AIR-GAPPED SYSTEM SETUP • ZERO EGRESS • REST OPENAI COMPLIANT
              </span>
            </div>
            <h1 className="text-3xl sm:text-4xl font-semibold text-white tracking-tight pt-1">
              LLM Model Endpoint Configuration
            </h1>
            <p className="text-sm sm:text-base text-neutral-400 max-w-4xl leading-relaxed">
              Industrial multi-model orchestration for defence manufacturing, PSU engineering, and government facilities. Assign offline, OpenAI-compatible model endpoints for each specialized operational role.
            </p>
          </div>

          {/* Quick Presets Toolbar */}
          <div className="flex items-center gap-2.5 flex-wrap shrink-0">
            <button
              type="button"
              onClick={prefillOllama}
              className="px-4 py-2.5 rounded-xl text-xs sm:text-sm font-medium neu-button hover:text-white transition-all hover:bg-[#202020]"
              title="Populate standard local Ollama ports (11434)"
            >
              Ollama Defaults
            </button>
            <button
              type="button"
              onClick={prefillLMStudio}
              className="px-4 py-2.5 rounded-xl text-xs sm:text-sm font-medium neu-button hover:text-white transition-all hover:bg-[#202020]"
              title="Populate standard local LM Studio port (1234)"
            >
              LM Studio (1234)
            </button>
            <button
              type="button"
              onClick={prefillVLLM}
              className="px-4 py-2.5 rounded-xl text-xs sm:text-sm font-medium neu-button hover:text-white transition-all hover:bg-[#202020]"
              title="Populate standard local vLLM port (8000)"
            >
              vLLM (8000)
            </button>
            <button
              type="button"
              onClick={testAllEndpoints}
              disabled={testingAll}
              className="px-4 py-2.5 rounded-xl text-xs sm:text-sm font-medium neu-button hover:text-white transition-all hover:bg-[#202020] disabled:opacity-40"
            >
              {testingAll ? "Testing All..." : "Test All Endpoints"}
            </button>
            <button
              type="button"
              onClick={clearForm}
              className="px-4 py-2.5 rounded-xl text-xs sm:text-sm font-medium neu-button opacity-60 hover:opacity-100 hover:text-red-400 transition-all hover:bg-[#202020]"
            >
              Clear
            </button>
          </div>
        </div>

        {/* 2. Enterprise Instructions & Network Policy Panel (Utilizes Upper Space) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Card 1: Runtime Prerequisites */}
          <div className="neu-card p-6 rounded-2xl border border-[#262626] bg-[#151515] flex flex-col justify-between space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-bold tracking-wider text-neutral-300 uppercase">
                  1. Local Inference Server
                </span>
                <span className="w-2.5 h-2.5 rounded-full bg-blue-400" />
              </div>
              <h3 className="text-sm font-semibold text-white">OpenAI-Compatible REST API</h3>
              <p className="text-xs sm:text-sm text-neutral-400 leading-relaxed">
                Ensure an approved local server (Ollama, vLLM, LM Studio, or llama-server) is listening. Sovereign Workbench communicates via standard HTTP JSON payloads.
              </p>
            </div>
            <div className="text-xs font-mono text-neutral-500 pt-3 border-t border-[#222222]">
              Standard routes: /v1/chat/completions, /v1/models
            </div>
          </div>

          {/* Card 2: Deterministic Routing Architecture */}
          <div className="neu-card p-6 rounded-2xl border border-[#262626] bg-[#151515] flex flex-col justify-between space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-bold tracking-wider text-neutral-300 uppercase">
                  2. Role Delegation Policy
                </span>
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
              </div>
              <h3 className="text-sm font-semibold text-white">Deterministic Task Routing</h3>
              <p className="text-xs sm:text-sm text-neutral-400 leading-relaxed">
                Workloads are strictly partitioned: Vision handles drawings/OCR, Coding executes Python math, Draft writes technical notes, and Embedding executes local RAG vectors.
              </p>
            </div>
            <div className="text-xs font-mono text-neutral-500 pt-3 border-t border-[#222222]">
              Single multi-model engine or distributed cluster
            </div>
          </div>

          {/* Card 3: Air-Gap Boundary & "Allow external requests" Inverse Toggle */}
          <div className="neu-card p-6 rounded-2xl border border-[#262626] bg-[#151515] flex flex-col justify-between space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-bold tracking-wider text-neutral-300 uppercase">
                  3. Air-Gap Isolation Policy
                </span>
                <span
                  className={`w-2.5 h-2.5 rounded-full ${allowExternal ? "bg-amber-400 animate-pulse" : "bg-emerald-400"}`}
                />
              </div>
              <h3 className="text-sm font-semibold text-white">Network Boundary Enforcement</h3>
              <p className="text-xs sm:text-sm text-neutral-400 leading-relaxed">
                By default, all network calls are physically restricted to loopback (127.0.0.1) with zero data egress. Enable external requests only to target air-gapped LAN GPU nodes.
              </p>
            </div>

            {/* The Inverse Toggle */}
            <div className="pt-3 border-t border-[#222222] flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-white">Allow external requests</div>
                <div className="text-xs text-neutral-400 mt-0.5">
                  {allowExternal
                    ? "LAN access enabled — Host/IP inputs unlocked"
                    : "Loopback locked — Host/IP forced to 127.0.0.1"}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={allowExternal}
                onClick={handleToggleAllowExternal}
                className={`relative inline-flex h-7 w-13 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  allowExternal ? "bg-amber-500" : "bg-neutral-700"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                    allowExternal ? "translate-x-6" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </div>
        </div>

        {globalError && (
          <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/25 text-red-300 text-sm flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-red-400 shrink-0" />
            <span>{globalError}</span>
          </div>
        )}

        {/* 3. Model Role Endpoints Table (Moved Down to Fill Lower Space) */}
        <form onSubmit={handleSubmit} className="space-y-6 flex-1 flex flex-col justify-end">
          <div className="space-y-3.5">
            {/* Table Column Headers */}
            <div className="flex items-center gap-4 px-3">
              <div className="flex-1 grid grid-cols-12 gap-4 px-6 py-2 text-xs font-mono uppercase tracking-widest text-neutral-400 font-semibold">
                <div className="col-span-3">Operational Role & Task</div>
                <div className="col-span-3">Model Tag / Identifier</div>
                <div className="col-span-2">Host / IP Address</div>
                <div className="col-span-1">Port</div>
                <div className="col-span-1">Context</div>
                <div className="col-span-2 text-right">Endpoint Status & Test</div>
              </div>
              {/* Header Spacer for the Outside Button */}
              <div className="w-32 text-xs font-mono uppercase tracking-widest text-neutral-500 font-semibold text-center">
                Sync Row
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
                  {/* The Main Table Row Card */}
                  <div className="flex-1 neu-panel border border-[#262626] rounded-2xl p-5 bg-[#161616] hover:bg-[#1A1A1A] transition-all shadow-sm">
                    <div className="grid grid-cols-12 gap-4 items-center">
                      {/* Col 1: Role & Description */}
                      <div className="col-span-3 flex items-start gap-3 pr-2">
                        <span
                          className={`text-xs font-mono px-2.5 py-1 rounded-md border font-bold tracking-wider shrink-0 mt-0.5 ${row.badgeColor}`}
                        >
                          {row.badge}
                        </span>
                        <div>
                          <div className="font-semibold text-white text-sm sm:text-base">{row.title}</div>
                          <div className="text-xs text-neutral-400 leading-normal mt-0.5">
                            {row.description}
                          </div>
                        </div>
                      </div>

                      {/* Col 2: Model Name Input */}
                      <div className="col-span-3">
                        <input
                          type="text"
                          value={row.modelName}
                          onChange={(e) => updateRow(idx, "modelName", e.target.value)}
                          placeholder="e.g. qwen2.5-coder:7b"
                          className={`w-full h-12 px-4 rounded-xl text-sm neu-input outline-none font-mono transition-all ${
                            modelErr
                              ? "border-red-500/80 focus:border-red-500"
                              : "border-[#333333] focus:border-neutral-200"
                          }`}
                        />
                        {modelErr && <span className="text-xs text-red-400 mt-1 block font-mono">{modelErr}</span>}
                      </div>

                      {/* Col 3: Host / IP Address Input (Locked when !allowExternal) */}
                      <div className="col-span-2">
                        <div className="relative">
                          <input
                            type="text"
                            disabled={!allowExternal}
                            value={allowExternal ? row.host : "127.0.0.1"}
                            onChange={(e) => updateRow(idx, "host", e.target.value)}
                            placeholder="127.0.0.1"
                            className={`w-full h-12 px-4 rounded-xl text-sm font-mono outline-none transition-all ${
                              !allowExternal
                                ? "bg-[#111111] border border-[#222222] text-neutral-500 cursor-not-allowed select-none"
                                : hostErr
                                ? "neu-input border-red-500/80 focus:border-red-500 text-white"
                                : "neu-input border-[#333333] focus:border-neutral-200 text-white"
                            }`}
                          />
                          {!allowExternal && (
                            <span className="absolute right-3.5 top-3.5 text-xs font-mono text-neutral-600 select-none uppercase tracking-wider">
                              locked
                            </span>
                          )}
                        </div>
                        {hostErr && <span className="text-xs text-red-400 mt-1 block font-mono">{hostErr}</span>}
                      </div>

                      {/* Col 4: Port Input */}
                      <div className="col-span-1">
                        <input
                          type="number"
                          min={1}
                          max={65535}
                          value={row.port}
                          onChange={(e) => updateRow(idx, "port", e.target.value)}
                          placeholder="11434"
                          className={`w-full h-12 px-3 rounded-xl text-sm neu-input outline-none font-mono transition-all ${
                            portErr
                              ? "border-red-500/80 focus:border-red-500"
                              : "border-[#333333] focus:border-neutral-200"
                          }`}
                        />
                        {portErr && <span className="text-xs text-red-400 mt-1 block font-mono">{portErr}</span>}
                      </div>

                      {/* Col 5: Context Length Input */}
                      <div className="col-span-1">
                        <input
                          type="number"
                          min={512}
                          step={512}
                          value={row.contextLength}
                          onChange={(e) => updateRow(idx, "contextLength", e.target.value)}
                          placeholder="32768"
                          className={`w-full h-12 px-3 rounded-xl text-sm neu-input outline-none font-mono transition-all ${
                            contextErr
                              ? "border-red-500/80 focus:border-red-500"
                              : "border-[#333333] focus:border-neutral-200"
                          }`}
                        />
                        {contextErr && <span className="text-xs text-red-400 mt-1 block font-mono">{contextErr}</span>}
                      </div>

                      {/* Col 6: Status & Test Action ONLY */}
                      <div className="col-span-2 flex items-center justify-end gap-3">
                        {row.testStatus === "testing" && (
                          <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-xs text-amber-300 font-mono">
                            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                            Testing...
                          </span>
                        )}
                        {row.testStatus === "success" && (
                          <span
                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-400 font-mono"
                            title={row.testMessage}
                          >
                            <span className="w-2 h-2 rounded-full bg-emerald-400" />
                            Connected {row.testLatency !== undefined ? `(${row.testLatency}ms)` : ""}
                          </span>
                        )}
                        {row.testStatus === "warning" && (
                          <span
                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-xs text-amber-300 font-mono"
                            title={row.testMessage}
                          >
                            <span className="w-2 h-2 rounded-full bg-amber-400" />
                            Reachable
                          </span>
                        )}
                        {row.testStatus === "error" && (
                          <span
                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/25 text-xs text-red-400 max-w-[150px] truncate font-mono"
                            title={row.testMessage}
                          >
                            <span className="w-2 h-2 rounded-full bg-red-400" />
                            Failed
                          </span>
                        )}

                        <button
                          type="button"
                          onClick={() => testEndpoint(idx)}
                          disabled={row.testStatus === "testing"}
                          className="h-11 px-4 rounded-xl text-xs font-semibold neu-button hover:text-white transition-all disabled:opacity-40"
                        >
                          Test
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* OUTSIDE THE TABLE: Copy to All Button for this specific row */}
                  <button
                    type="button"
                    onClick={() => applyHostPortToAll(idx)}
                    className="w-32 h-12 px-3 rounded-xl border border-[#282828] bg-[#161616] hover:bg-[#222222] hover:border-neutral-400 text-xs font-mono text-neutral-400 hover:text-white transition-all shrink-0 flex items-center justify-center gap-1.5 shadow-sm"
                    title={`Copy Host and Port from ${row.title} (${row.host}:${row.port}) to all other rows`}
                  >
                    <span>Copy to All</span>
                  </button>
                </div>
              );
            })}
          </div>

          {/* 4. Bottom Commit & Launch Action Bar */}
          <div className="pt-6 pb-2 flex flex-col sm:flex-row items-center justify-between gap-6 border-t border-[#222222]">
            <div className="text-xs sm:text-sm text-neutral-400 flex items-center gap-3">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0" />
              <span>
                Configuration is saved to local SQLite database (<code className="font-mono text-neutral-300">workbench.db</code>). Pure offline operation.
              </span>
            </div>

            <button
              type="submit"
              disabled={saving || hasErrors}
              className="h-14 px-10 rounded-2xl font-semibold text-sm neu-button-primary disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-3 shadow-2xl transition-all hover:scale-[1.01] active:scale-[0.99]"
            >
              {saving ? (
                <>
                  <span className="w-4 h-4 border-2 border-neutral-900 border-t-transparent rounded-full animate-spin" />
                  <span>Saving Configuration & Launching...</span>
                </>
              ) : (
                <>
                  <span>Complete Setup & Launch Workbench</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Industrial Footer Notice */}
      <div className="pt-6 pb-2 text-center text-xs text-neutral-600 font-mono tracking-widest uppercase">
        SOVEREIGN WORKBENCH • DEFENCE & PSU MISSION-CRITICAL INTELLIGENCE PLATFORM • AIR-GAPPED VERIFIED
      </div>
    </div>
  );
}
