import { describe, it, expect } from "vitest";
import {
  classifyIntent,
  hasActionVerb,
  hasContainerNoun,
  hasCommandActionVerb,
  hasCommandTargetNoun,
  normalizeTokens,
  editDistance,
} from "../src/main/router/intent-classifier.js";

describe("Intelligent Intent Classifier", () => {
  it("routes file writing requests with directory context to harness", () => {
    const decision = classifyIntent({
      userText: "Write a txt file in the directory saying hello",
      isWorkspaceActive: true,
    });
    expect(decision.actionTarget).toBe("harness");
    expect(decision.taskType).toBe("code");
    expect(decision.modelId).toBe("code-qwen25coder");
    expect(decision.isWorkspaceAction).toBe(true);
  });

  it("routes user request with specific filename to harness even without active workspace", () => {
    const decision = classifyIntent({
      userText: "Write a txt file in the directory saying 'sample'",
      isWorkspaceActive: false,
    });
    expect(decision.actionTarget).toBe("harness");
    expect(decision.taskType).toBe("code");
    expect(decision.modelId).toBe("code-qwen25coder");
    expect(decision.isWorkspaceAction).toBe(true);
  });

  it("routes file creation with extensions to harness", () => {
    const decision = classifyIntent({
      userText: "create server.ts and write basic express app",
      isWorkspaceActive: false,
    });
    expect(decision.actionTarget).toBe("harness");
    expect(decision.taskType).toBe("code");
    expect(decision.isWorkspaceAction).toBe(true);
  });

  it("routes terminal commands to harness", () => {
    const decision = classifyIntent({
      userText: "run command npm test in this project",
      isWorkspaceActive: true,
    });
    expect(decision.actionTarget).toBe("harness");
    expect(decision.taskType).toBe("code");
    expect(decision.isWorkspaceAction).toBe(true);
  });

  it("routes exploration actions to harness", () => {
    const decision = classifyIntent({
      userText: "list files in this directory",
      isWorkspaceActive: true,
    });
    expect(decision.actionTarget).toBe("harness");
    expect(decision.isWorkspaceAction).toBe(true);
  });

  it("routes CSV attachments to data analysis", () => {
    const decision = classifyIntent({
      userText: "flag out-of-range readings",
      attachment: { mediaType: "text/csv" },
    });
    expect(decision.actionTarget).toBe("data");
    expect(decision.taskType).toBe("code");
    expect(decision.modelId).toBe("code-qwen25coder");
    expect(decision.reason).toBe("CSV/code intent");
  });

  it("routes PDF and image attachments to vision", () => {
    const pdfDecision = classifyIntent({
      userText: "inspect this invoice",
      attachment: { mediaType: "application/pdf" },
    });
    expect(pdfDecision.actionTarget).toBe("vision");
    expect(pdfDecision.taskType).toBe("vision");
    expect(pdfDecision.modelId).toBe("vision-qwen25vl");

    const imgDecision = classifyIntent({
      userText: "read the meter in this picture",
      attachment: { mediaType: "image/png" },
    });
    expect(imgDecision.actionTarget).toBe("vision");
    expect(imgDecision.taskType).toBe("vision");
    expect(imgDecision.modelId).toBe("vision-qwen25vl");
  });

  it("routes conversational requests without filesystem context to chat", () => {
    const decision = classifyIntent({
      userText: "What is the capital of France?",
    });
    expect(decision.actionTarget).toBe("chat");
    expect(decision.taskType).toBe("draft");
    expect(decision.modelId).toBe("draft-qwen3");
    expect(decision.isWorkspaceAction).toBe(false);
  });

  it("routes generic script writing request without file targets to draft chat for legacy compatibility", () => {
    const decision = classifyIntent({
      userText: "write me a small script",
    });
    expect(decision.actionTarget).toBe("chat");
    expect(decision.taskType).toBe("draft");
    expect(decision.modelId).toBe("draft-qwen3");
  });

  describe("Negative Workspace Constraints & Standalone Deliverables", () => {
    it("routes 'generate a python file but not save it in the workspace directory' to standalone_file even when workspace is active", () => {
      const decision = classifyIntent({
        userText: "generate a python file but not save it in the workspace directory",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("standalone_file");
      expect(decision.taskType).toBe("code");
      expect(decision.modelId).toBe("code-qwen25coder");
      expect(decision.isWorkspaceAction).toBe(false);
      expect(decision.isNegativeWorkspaceConstraint).toBe(true);
      expect(decision.suggestedExtension).toBe("py");
    });

    it("routes 'create script.py outside the workspace' to standalone_file", () => {
      const decision = classifyIntent({
        userText: "create script.py outside the workspace",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("standalone_file");
      expect(decision.taskType).toBe("code");
      expect(decision.modelId).toBe("code-qwen25coder");
      expect(decision.isWorkspaceAction).toBe(false);
      expect(decision.extractedFilename).toBe("script.py");
    });

    it("routes 'write a python script as an artifact, don't write to the project' to standalone_file", () => {
      const decision = classifyIntent({
        userText: "write a python script as an artifact, don't write to the project",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("standalone_file");
      expect(decision.taskType).toBe("code");
      expect(decision.isWorkspaceAction).toBe(false);
      expect(decision.isNegativeWorkspaceConstraint).toBe(true);
    });

    it("routes 'generate a typescript file without saving to disk' to standalone_file", () => {
      const decision = classifyIntent({
        userText: "generate a typescript file without saving to disk",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("standalone_file");
      expect(decision.taskType).toBe("code");
      expect(decision.suggestedExtension).toBe("ts");
      expect(decision.isWorkspaceAction).toBe(false);
    });

    it("routes 'create a standalone python file for parsing logs' to standalone_file", () => {
      const decision = classifyIntent({
        userText: "create a standalone python file for parsing logs",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("standalone_file");
      expect(decision.taskType).toBe("code");
      expect(decision.suggestedExtension).toBe("py");
      expect(decision.isWorkspaceAction).toBe(false);
    });

    it("routes 'make a test.py file, never touch the repo' to standalone_file", () => {
      const decision = classifyIntent({
        userText: "make a test.py file, never touch the repo",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("standalone_file");
      expect(decision.taskType).toBe("code");
      expect(decision.extractedFilename).toBe("test.py");
      expect(decision.isWorkspaceAction).toBe(false);
    });

    it("handles token-reduced shorthand 'gen py file no save ws'", () => {
      const decision = classifyIntent({
        userText: "gen py file no save ws",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("standalone_file");
      expect(decision.taskType).toBe("code");
      expect(decision.suggestedExtension).toBe("py");
      expect(decision.isWorkspaceAction).toBe(false);
      expect(decision.isNegativeWorkspaceConstraint).toBe(true);
    });

    it("handles typos like 'artifct' in 'make a python file, artifct only'", () => {
      const decision = classifyIntent({
        userText: "make a python file, artifct only",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("standalone_file");
      expect(decision.taskType).toBe("code");
      expect(decision.suggestedExtension).toBe("py");
      expect(decision.isWorkspaceAction).toBe(false);
    });

    it("handles typos like 'workpsace' in 'create script.py, dont save in workpsace'", () => {
      const decision = classifyIntent({
        userText: "create script.py, dont save in workpsace",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("standalone_file");
      expect(decision.taskType).toBe("code");
      expect(decision.extractedFilename).toBe("script.py");
      expect(decision.isWorkspaceAction).toBe(false);
      expect(decision.isNegativeWorkspaceConstraint).toBe(true);
    });

    it("handles British spelling 'artefact' in 'write a python script as an artefact'", () => {
      const decision = classifyIntent({
        userText: "write a python script as an artefact",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("standalone_file");
      expect(decision.taskType).toBe("code");
      expect(decision.isWorkspaceAction).toBe(false);
    });

    it("handles word-skipping shorthand 'create py file skip workspace'", () => {
      const decision = classifyIntent({
        userText: "create py file skip workspace",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("standalone_file");
      expect(decision.taskType).toBe("code");
      expect(decision.isWorkspaceAction).toBe(false);
      expect(decision.isNegativeWorkspaceConstraint).toBe(true);
    });

    it("handles abbreviations like 'w/o' in 'gen test.py w/o saving to disk'", () => {
      const decision = classifyIntent({
        userText: "gen test.py w/o saving to disk",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("standalone_file");
      expect(decision.taskType).toBe("code");
      expect(decision.extractedFilename).toBe("test.py");
      expect(decision.isWorkspaceAction).toBe(false);
      expect(decision.isNegativeWorkspaceConstraint).toBe(true);
    });
  });

  describe("Approval Note & Office Document Drafting", () => {
    it("routes 'Draft an approval note for a proposed maintenance nuclear reactor shutdown and save it as a Word document.' to draft model even when workspace is active", () => {
      const decision = classifyIntent({
        userText: "Draft an approval note for a proposed maintenance nuclear reactor shutdown and save it as a Word document.",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("chat");
      expect(decision.taskType).toBe("draft");
      expect(decision.modelId).toBe("draft-qwen3");
      expect(decision.isWorkspaceAction).toBe(false);
      expect(decision.reason).toBe("approval note drafting");
    });

    it("routes general approval notes to draft-qwen3", () => {
      const decision = classifyIntent({
        userText: "draft an executive summary note for equipment inspection",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("chat");
      expect(decision.taskType).toBe("draft");
      expect(decision.modelId).toBe("draft-qwen3");
    });
  });

  describe("Workspace File & Command Execution Intent", () => {
    it("routes file execution with stdin inputs to harness", () => {
      const decision = classifyIntent({
        userText: "Okay cool. Now execute the file for the input: nums = [3,2,4], target = 6 You must execute and provide the stdin, not answer from ur own memory",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.taskType).toBe("code");
      expect(decision.modelId).toBe("code-qwen25coder");
      expect(decision.isWorkspaceAction).toBe(true);
      expect(decision.reason).toBe("workspace command execution");
    });

    it("routes compiling and executing C++ files to harness", () => {
      const decision = classifyIntent({
        userText: "compile two_sum.cpp and run the executable with 4 9 2 7 11 15",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.taskType).toBe("code");
      expect(decision.isWorkspaceAction).toBe(true);
    });
  });

  describe("Coding Assistance vs File Creation", () => {
    it("routes 'Write the code for the following problem ... in C++' to chat instead of creating files on disk", () => {
      const decision = classifyIntent({
        userText: "Write the code for the following problem: Given a string s, return the longest palindromic substring in s. in C++",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("chat");
      expect(decision.isWorkspaceAction).toBe(false);
    });

    it("routes meta-inquiry 'I didnt tell u to save it in the directory/workspace, why did you do so' to chat", () => {
      const decision = classifyIntent({
        userText: "I didnt tell u to save it in the directory/workspace, why did you do so",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("chat");
      expect(decision.isWorkspaceAction).toBe(false);
      expect(decision.reason).toBe("meta-conversational inquiry");
    });

    it("routes 'why did you create that file' to chat", () => {
      const decision = classifyIntent({
        userText: "why did you create that file?",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("chat");
      expect(decision.isWorkspaceAction).toBe(false);
      expect(decision.reason).toBe("meta-conversational inquiry");
    });
  });

  describe("Multi-Turn Follow-Ups & Confirmation", () => {
    it("routes affirmative 'Yes' following a workspace deletion prompt to harness", () => {
      const decision = classifyIntent({
        userText: "Yes",
        isWorkspaceActive: true,
        history: [
          { role: "user", content: "Delete all files in the workspace" },
          {
            role: "assistant",
            content: "Are you sure you want to delete all files in the workspace? Please confirm to proceed.",
          },
        ],
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.taskType).toBe("code");
      expect(decision.modelId).toBe("code-qwen25coder");
      expect(decision.isWorkspaceAction).toBe(true);
      expect(decision.reason).toBe("affirmative follow-up in active workspace");
    });

    it("routes affirmative 'proceed' following confirmation request to harness", () => {
      const decision = classifyIntent({
        userText: "proceed",
        isWorkspaceActive: true,
        history: [
          { role: "user", content: "clean the directory" },
          { role: "assistant", content: "This will remove intermediate build files. Confirm to proceed?" },
        ],
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.isWorkspaceAction).toBe(true);
      expect(decision.modelId).toBe("code-qwen25coder");
    });

    it("routes 'execute the file' in active workspace to harness", () => {
      const decision = classifyIntent({
        userText: "execute the file",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.isWorkspaceAction).toBe(true);
      expect(decision.modelId).toBe("code-qwen25coder");
      expect(decision.reason).toBe("script/file execution follow-up in workspace");
    });

    it("routes 'run the script' when workspace is inactive but recent artifacts exist to data sandbox", () => {
      const decision = classifyIntent({
        userText: "run the script",
        isWorkspaceActive: false,
        hasRecentArtifacts: true,
      });
      expect(decision.actionTarget).toBe("data");
      expect(decision.isWorkspaceAction).toBe(false);
      expect(decision.modelId).toBe("code-qwen25coder");
    });

    it("routes affirmative 'Yes' without active workspace to chat", () => {
      const decision = classifyIntent({
        userText: "Yes",
        isWorkspaceActive: false,
      });
      expect(decision.actionTarget).toBe("chat");
      expect(decision.isWorkspaceAction).toBe(false);
    });

    it("routes casual affirmative 'Yes' in active workspace without file/workspace context to chat", () => {
      const decision = classifyIntent({
        userText: "Yes",
        isWorkspaceActive: true,
        history: [
          { role: "user", content: "Do you like philosophy?" },
          { role: "assistant", content: "I find epistemology interesting. Do you want to discuss logic?" },
        ],
      });
      expect(decision.actionTarget).toBe("chat");
      expect(decision.isWorkspaceAction).toBe(false);
    });
  });

  describe("Workspace File Write & Save Overrides", () => {
    it("routes 'Write the updated file into the test directory workspace' to harness even with CSV attachment", () => {
      const decision = classifyIntent({
        userText: "Write the updated file into the test directory workspace",
        isWorkspaceActive: true,
        attachments: [{ mediaType: "text/csv", filename: "vendor-maintenance-log.csv" }],
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.taskType).toBe("code");
      expect(decision.modelId).toBe("code-qwen25coder");
      expect(decision.isWorkspaceAction).toBe(true);
    });

    it("routes 'write the python script into the directory' to harness with Python and CSV attachments", () => {
      const decision = classifyIntent({
        userText: "write the python script into the directory",
        isWorkspaceActive: true,
        attachments: [
          { mediaType: "text/x-python", filename: "vendor_log_parser.py" },
          { mediaType: "text/csv", filename: "vendor-maintenance-log.csv" },
        ],
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.taskType).toBe("code");
      expect(decision.modelId).toBe("code-qwen25coder");
      expect(decision.isWorkspaceAction).toBe(true);
    });

    it("routes 'Save the repaired script into my workspace' to harness", () => {
      const decision = classifyIntent({
        userText: "Save the repaired script into my workspace",
        isWorkspaceActive: true,
        hasRecentArtifacts: true,
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.isWorkspaceAction).toBe(true);
    });

    it("routes 'Copy the artifact to workspace' to harness", () => {
      const decision = classifyIntent({
        userText: "Copy the artifact to workspace",
        isWorkspaceActive: true,
        hasRecentArtifacts: true,
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.isWorkspaceAction).toBe(true);
    });

    it("still routes 'fix the script' with Python and CSV attachments to data sandbox", () => {
      const decision = classifyIntent({
        userText: "fix the script",
        isWorkspaceActive: true,
        attachments: [
          { mediaType: "text/x-python", filename: "vendor_log_parser.py" },
          { mediaType: "text/csv", filename: "vendor-maintenance-log.csv" },
        ],
      });
      expect(decision.actionTarget).toBe("data");
      expect(decision.isWorkspaceAction).toBe(false);
    });

    it("still routes 'flag out-of-range readings' with CSV attachment to data sandbox", () => {
      const decision = classifyIntent({
        userText: "flag out-of-range readings",
        isWorkspaceActive: true,
        attachments: [{ mediaType: "text/csv", filename: "vendor-maintenance-log.csv" }],
      });
      expect(decision.actionTarget).toBe("data");
      expect(decision.isWorkspaceAction).toBe(false);
    });
  });

  describe("Workspace File Deletion & Follow-up Routing", () => {
    const historicalAttachments = [
      { mediaType: "text/x-python", filename: "broken-vendor-log-parser.py" },
      { mediaType: "text/csv", filename: "vendor-maintenance-log.csv" },
    ];

    it("routes 'Remove the file in the workspace' to harness even with historical attachments", () => {
      const decision = classifyIntent({
        userText: "Remove the file in the workspace (there is only one right now)",
        isWorkspaceActive: true,
        attachments: historicalAttachments,
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.isWorkspaceAction).toBe(true);
      expect(decision.modelId).toBe("code-qwen25coder");
    });

    it("routes 'Still hasnt been deleted from the directory' to harness even with historical attachments", () => {
      const decision = classifyIntent({
        userText: "Still hasnt been deleted from the directory",
        isWorkspaceActive: true,
        attachments: historicalAttachments,
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.isWorkspaceAction).toBe(true);
      expect(decision.modelId).toBe("code-qwen25coder");
    });

    it("routes 'Delete the damn file from the workspace bruh' to harness even with historical attachments", () => {
      const decision = classifyIntent({
        userText: "Delete the damn file from the workspace bruh",
        isWorkspaceActive: true,
        attachments: historicalAttachments,
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.isWorkspaceAction).toBe(true);
      expect(decision.modelId).toBe("code-qwen25coder");
    });

    it("routes 'clean up the generated files from the folder' to harness", () => {
      const decision = classifyIntent({
        userText: "clean up the generated files from the folder",
        isWorkspaceActive: true,
        attachments: historicalAttachments,
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.isWorkspaceAction).toBe(true);
      expect(decision.modelId).toBe("code-qwen25coder");
    });
  });

  describe("Typo Tolerance & Expanded Action Verbs", () => {
    it("handles Damerau-Levenshtein transpositions and single-char edits", () => {
      expect(editDistance("udpate", "update")).toBe(1);
      expect(editDistance("isntall", "install")).toBe(1);
      expect(editDistance("modfy", "modify")).toBe(1);
      expect(editDistance("chck", "check")).toBe(1);
      expect(editDistance("wrtie", "write")).toBe(1);
    });

    it("detects typoed action verbs and container nouns via helper functions", () => {
      const text1 = "modfy the midleware to add rate limiting";
      const tokens1 = normalizeTokens(text1);
      expect(hasActionVerb(text1.toLowerCase(), tokens1)).toBe(true);
      expect(hasContainerNoun(text1.toLowerCase(), tokens1)).toBe(true);

      const text2 = "isntall express-rate-limit";
      const tokens2 = normalizeTokens(text2);
      expect(hasCommandActionVerb(text2.toLowerCase(), tokens2)).toBe(true);
    });

    it("routes typoed requests like 'modfy the midleware' to harness", () => {
      const decision = classifyIntent({
        userText: "modfy the midleware to add rate limiting",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.taskType).toBe("code");
      expect(decision.modelId).toBe("code-qwen25coder");
      expect(decision.isWorkspaceAction).toBe(true);
    });

    it("routes typoed requests like 'udpate app.js to use rateLimiter' to harness", () => {
      const decision = classifyIntent({
        userText: "udpate app.js to use rateLimiter",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.taskType).toBe("code");
      expect(decision.isWorkspaceAction).toBe(true);
    });

    it("routes typoed requests like 'isntall express-rate-limit' to harness", () => {
      const decision = classifyIntent({
        userText: "isntall express-rate-limit",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.taskType).toBe("code");
      expect(decision.isWorkspaceAction).toBe(true);
    });

    it("routes typoed requests like 'chck if tests pass' to harness", () => {
      const decision = classifyIntent({
        userText: "chck if tests pass",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.taskType).toBe("code");
      expect(decision.isWorkspaceAction).toBe(true);
    });

    it("routes typoed requests like 'wrtie a file in the directroy' to harness", () => {
      const decision = classifyIntent({
        userText: "wrtie a file in the directroy",
        isWorkspaceActive: true,
      });
      expect(decision.actionTarget).toBe("harness");
      expect(decision.taskType).toBe("code");
      expect(decision.isWorkspaceAction).toBe(true);
    });
  });
});


