/**
 * Live execution and strict evaluation runner for Flow A, Flow B, and Flow C.
 * Driven directly via the CLI runtime (tests/.runtime/build/worker.cjs).
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const electronPath = require("electron");

const ROOT = path.resolve(__dirname, "..");
const WORKER_BUNDLE = path.join(ROOT, "tests/.runtime/build/worker.cjs");
const SCHEMA_PATH = path.join(ROOT, "backend/src/main/persistence/schema.sql");

const configuredRegistry = JSON.parse(fs.readFileSync(path.join(ROOT, "config/models.json"), "utf8")).models;
// The demo CLI is a local-model preflight. When onboarding has not saved a
// registry yet, use the documented LM Studio profile; the app config itself
// stays empty and unchanged.
const REGISTRY = configuredRegistry.length
  ? configuredRegistry
  : JSON.parse(fs.readFileSync(path.join(ROOT, "config/models.v0.example.json"), "utf8")).models;

const EMBEDDING = {
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "text-embedding-nomic-embed-text-v1.5",
};

class FlowRunner {
  constructor(flowName, sandboxDir) {
    this.flowName = flowName;
    this.sandboxDir = sandboxDir;
    this.events = [];
    this.pending = new Map();
    this.nextId = 1;
    this.confirmationsCount = 0;
  }

  setupSandbox(knowledgeBaseDocs = []) {
    fs.rmSync(this.sandboxDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(this.sandboxDir, "data"), { recursive: true });
    fs.mkdirSync(path.join(this.sandboxDir, "config"), { recursive: true });
    fs.mkdirSync(path.join(this.sandboxDir, "workspace"), { recursive: true });
    fs.mkdirSync(path.join(this.sandboxDir, "attachments"), { recursive: true });
    fs.mkdirSync(path.join(this.sandboxDir, "kb"), { recursive: true });

    fs.copyFileSync(SCHEMA_PATH, path.join(this.sandboxDir, "config/schema.sql"));
    fs.writeFileSync(
      path.join(this.sandboxDir, "config/models.json"),
      JSON.stringify({ models: REGISTRY }, null, 2)
    );

    const bootConfig = {
      root: this.sandboxDir,
      setup: {
        workspace: [],
        attachments: [],
        knowledgeBase: knowledgeBaseDocs,
        conversation: [],
      },
      campaignType: "behavioral",
      registry: REGISTRY,
      embedding: EMBEDDING,
      schemaPath: path.join(this.sandboxDir, "config/schema.sql"),
    };

    const configFile = path.join(this.sandboxDir, "boot.json");
    fs.writeFileSync(configFile, JSON.stringify(bootConfig, null, 2));
    return configFile;
  }

  async startWorker(configFile) {
    return new Promise((resolve, reject) => {
      this.child = spawn(electronPath, [WORKER_BUNDLE, configFile], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          WORKBENCH_AGENT_V2: "true",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdoutBuf = "";
      this.child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop(); // keep remainder
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this.handleWorkerMessage(msg);
          } catch (e) {
            console.error(`[${this.flowName}] Error parsing stdout line:`, line, e);
          }
        }
      });

      this.child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        // Log warnings/errors but suppress excessive traces
        if (!text.includes("pdfjs-dist") && !text.includes("DeprecationWarning")) {
          process.stderr.write(`[${this.flowName}:stderr] ${text}`);
        }
      });

      this.child.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          console.error(`[${this.flowName}] Worker exited with code ${code}`);
        }
      });

      // Wait for ready
      const checkReady = () => {
        if (this.isReady) {
          resolve();
        } else {
          setTimeout(checkReady, 50);
        }
      };
      setTimeout(checkReady, 100);
      setTimeout(() => {
        if (!this.isReady) reject(new Error("Worker failed to become ready in 30s"));
      }, 30000);
    });
  }

  handleWorkerMessage(msg) {
    if (msg.kind === "ready") {
      this.isReady = true;
      console.log(`[${this.flowName}] Worker ready! Model registry active.`);
    } else if (msg.kind === "response") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.d);
        else p.reject(new Error(msg.e || "Command failed"));
      }
    } else if (msg.kind === "event") {
      this.events.push(msg.event);
      this.logEvent(msg.event);

      // Auto-approve confirmation requests
      if (msg.event.type === "confirmation_required") {
        this.confirmationsCount++;
        const action = msg.event.action;
        console.log(`\n🔔 [${this.flowName}] Confirmation Required #${this.confirmationsCount}:`);
        console.log(`   Action: ${action.title || action.kind}`);
        console.log(`   Preview: ${(action.preview || "").slice(0, 150)}...`);
        console.log(`   --> Auto-approving confirmation gate...`);

        this.callCommand("invoke", {
          channel: "workbench:confirmAction",
          input: {
            runId: msg.event.runId,
            actionId: action.actionId,
            approved: true,
          },
        }).catch((err) => console.error("Error approving:", err));
      }
    } else if (msg.kind === "fatal") {
      console.error(`[${this.flowName}] Fatal worker error:`, msg.e);
    }
  }

  logEvent(e) {
    if (e.type === "routing") {
      console.log(`🧭 [${this.flowName}] Model Selected: ${e.modelId} (Reason: ${e.reason})`);
    } else if (e.type === "agent_thinking") {
      console.log(`💭 [${this.flowName}] Scratchpad (Turn ${e.turn}): ${e.text.slice(0, 180).replace(/\n/g, " ")}...`);
    } else if (e.type === "tool_call") {
      const argsStr = JSON.stringify(e.args || {});
      console.log(`🛠️ [${this.flowName}] Tool Call: ${e.tool}(${argsStr.slice(0, 120)}${argsStr.length > 120 ? "..." : ""})`);
    } else if (e.type === "tool_result") {
      console.log(`✅ [${this.flowName}] Tool Result: ${e.tool} (${e.ok ? "SUCCESS" : "FAILED"})`);
    } else if (e.type === "artifact_ready") {
      console.log(`📦 [${this.flowName}] Artifact Ready: ${e.artifact?.filename ?? e.filename} (${e.artifact?.relativePath ?? e.relativePath})`);
    } else if (e.type === "run_state") {
      console.log(`📍 [${this.flowName}] State: ${e.state}`);
    }
  }

  callCommand(c, a = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ version: 1, id, c, a }) + "\n");
    });
  }

  async waitForTerminalState(runId, timeoutMs = 480000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const terminal = this.events.find(
        (e) => e.runId === runId && e.type === "run_state" && ["completed", "partial", "failed", "cancelled", "limit_exceeded"].includes(e.state)
      );
      if (terminal) return terminal.state;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timeout waiting for run ${runId} to reach terminal state (${timeoutMs}ms)`);
  }

  async shutdown() {
    try {
      await this.callCommand("shutdown");
    } catch {
      if (this.child) this.child.kill();
    }
  }
}

module.exports = { FlowRunner, ROOT, REGISTRY };
