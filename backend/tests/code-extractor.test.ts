import { describe, expect, it } from "vitest";
import {
  extractCodeBlocksWithFilenames,
  cleanFinalSummary,
  cleanPlanPreview,
  extractShellCommands,
} from "../src/main/agent/code-extractor.js";

describe("extractCodeBlocksWithFilenames", () => {
  it("extracts files when filename is in comment on line 1", () => {
    const text = `
Here is the express server:
\`\`\`javascript
// app.js
const express = require('express');
const app = express();
app.listen(3000);
\`\`\`
`;
    const files = extractCodeBlocksWithFilenames(text);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("app.js");
    expect(files[0].content).toContain("const express = require('express');");
  });

  it("extracts multiple files from multi-file scaffolding response", () => {
    const text = `
Sure, I'll create the necessary files and add the required code for a modularized Express API app.

Step 1: Create the Main Express App
Create a file named app.js in the root directory of your project.

\`\`\`javascript
// app.js
const express = require('express');
const path = require('path');
const app = express();
module.exports = app;
\`\`\`

Step 2: Create Route Files
Create a file named routes/users.js to handle user-related endpoints:

\`\`\`javascript
const express = require('express');
const router = express.Router();
router.get('/', (req, res) => res.json([]));
module.exports = router;
\`\`\`

Step 3: Create Products Route
Create a file named routes/products.js:

\`\`\`javascript
const express = require('express');
const router = express.Router();
router.get('/', (req, res) => res.json({ message: 'Products endpoint' }));
module.exports = router;
\`\`\`

Step 4: Run the Application
Execute the following command:
\`\`\`bash
node app.js
\`\`\`
`;

    const files = extractCodeBlocksWithFilenames(text);
    expect(files).toHaveLength(3);
    expect(files[0].path).toBe("app.js");
    expect(files[1].path).toBe("routes/users.js");
    expect(files[2].path).toBe("routes/products.js");
    // bash block without filename is ignored
    expect(files.some((f) => f.path.endsWith(".sh"))).toBe(false);
  });

  it("extracts files with python comment # server.py", () => {
    const text = `
\`\`\`python
# server.py
import os
print("hello")
\`\`\`
`;
    const files = extractCodeBlocksWithFilenames(text);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("server.py");
  });

  it("returns empty array when no filenames are associated with code blocks", () => {
    const text = `
Here is some generic code:
\`\`\`python
x = 10
y = 20
print(x + y)
\`\`\`
`;
    const files = extractCodeBlocksWithFilenames(text);
    expect(files).toHaveLength(0);
  });
});

describe("cleanFinalSummary", () => {
  it("does not alter text when hasExecutedTools is false (pure chat)", () => {
    const chatResponse = `To create an Express app, you can write:
\`\`\`javascript
const app = express();
\`\`\`
Hope that helps!`;
    const result = cleanFinalSummary(chatResponse, false);
    expect(result).toBe(chatResponse);
  });

  it("removes redundant source code blocks when hasExecutedTools is true", () => {
    const agentResponse = `
I have set up your Express application in the workspace.

\`\`\`javascript
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('OK'));
module.exports = app;
\`\`\`

### Next Steps
Run the server with:
\`\`\`bash
node app.js
\`\`\`
`;
    const result = cleanFinalSummary(agentResponse, true);
    expect(result).not.toContain("const express = require('express');");
    expect(result).toContain("I have set up your Express application in the workspace.");
    expect(result).toContain("node app.js");
    expect(result).toContain("### Next Steps");
  });

  it("preserves short untagged command blocks and strips code dumps", () => {
    const agentResponse = `
**Implemented**:
- Created \`app.js\` and \`routes/users.js\`.

\`\`\`
const router = express.Router();
router.get('/', (req, res) => res.json([]));
\`\`\`

**Next Steps**:
\`\`\`
npm start
\`\`\`
`;
    const result = cleanFinalSummary(agentResponse, true);
    expect(result).not.toContain("router.get");
    expect(result).toContain("**Implemented**:");
    expect(result).toContain("npm start");
  });
});

describe("cleanPlanPreview", () => {
  it("strips hallucinated [TOOL_RESULT] JSON blocks from turn-1 model responses", () => {
    const rawTurn1 = `
[TOOL_RESULT]
{
  "files": [
    {
      "name": "app.js",
      "type": "file",
      "size": 12000000
    },
    {
      "name": "package.json",
      "type": "file",
      "size": 2870
    }
  ]
}
[END_TOOL_RESULT]

To add a simple rate limiter middleware to the Express app, we need to follow these steps:

1. Install \`express-rate-limit\` package.
2. Create a rate limiter middleware.
3. Apply the rate limiter middleware to specific routes or the entire app.

Let's start by installing \`express-rate-limit\`.

\`\`\`bash
npm install express-rate-limit
\`\`\`

**Implemented**:
- Created \`middleware/rateLimiter.js\` file with rate limiter middleware.
- Updated \`app.js\` to use the rate limiter middleware.

**Next Steps**:
Run the server using \`node app.js\` to start the Express application with the rate limiter in place.
`;

    const cleaned = cleanPlanPreview(rawTurn1);

    // [TOOL_RESULT] and JSON should be completely gone
    expect(cleaned).not.toContain("[TOOL_RESULT]");
    expect(cleaned).not.toContain("[END_TOOL_RESULT]");
    expect(cleaned).not.toContain('"files": [');

    // Code blocks should be stripped from plan preview
    expect(cleaned).not.toContain("```bash");

    // Premature "Implemented" and "Next Steps" should be stripped
    expect(cleaned).not.toContain("**Implemented**");
    expect(cleaned).not.toContain("middleware/rateLimiter.js");
    expect(cleaned).not.toContain("**Next Steps**");

    // The genuine step-by-step plan rationale should remain
    expect(cleaned).toContain("To add a simple rate limiter middleware to the Express app, we need to follow these steps:");
    expect(cleaned).toContain("1. Install `express-rate-limit` package.");
    expect(cleaned).toContain("2. Create a rate limiter middleware.");
    expect(cleaned).toContain("3. Apply the rate limiter middleware to specific routes or the entire app.");
  });

  it("strips <tool_response> and <tool_call> tags", () => {
    const raw = `<tool_response>{"ok": true}</tool_response>I will set up the routes and configure authentication.`;
    expect(cleanPlanPreview(raw)).toBe("I will set up the routes and configure authentication.");
  });

  it("preserves human report findings and markdown when wrapped in [TOOL_RESULT] tags", () => {
    const rawWrapped = `
[TOOL_RESULT]
# Inspection Report E-201 Heat Exchanger
**Report ID:** IR-E201-2026-08-20
**Equipment:** E-201 Heat Exchanger
**Inspection Findings:**
- **Tube Wall Thickness:** Rows 12-15 measured 3.8-4.2 mm.
- **Minimum Allowable Tube Wall Thickness:** 4.6 mm.
[END_TOOL_RESULT]
`;
    const cleaned = cleanPlanPreview(rawWrapped);
    expect(cleaned).not.toContain("[TOOL_RESULT]");
    expect(cleaned).not.toContain("[END_TOOL_RESULT]");
    expect(cleaned).toContain("# Inspection Report E-201 Heat Exchanger");
    expect(cleaned).toContain("Tube Wall Thickness");
  });
});

describe("extractShellCommands", () => {
  it("extracts commands from bash/sh code blocks", () => {
    const text = `
To install and start:
\`\`\`bash
npm install express-rate-limit
node app.js
\`\`\`
`;
    const cmds = extractShellCommands(text);
    expect(cmds).toEqual(["npm install express-rate-limit", "node app.js"]);
  });

  it("strips leading prompt symbols ($ )", () => {
    const text = `
\`\`\`sh
$ npm install
$ npm test
\`\`\`
`;
    const cmds = extractShellCommands(text);
    expect(cmds).toEqual(["npm install", "npm test"]);
  });
});

describe("extractCodeBlocksWithFilenames robust patterns", () => {
  it("extracts files with @ prefix and 'Here is the updated code for' phrasing", () => {
    const text = `
I apologize for the oversight. Let's correct this by invoking the \`write_file\` tool to save the updated \`@middleware/rateLimiter.js\` and \`app.js\` files.

Here is the updated code for \`@middleware/rateLimiter.js\`:

\`\`\`javascript
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
module.exports = limiter;
\`\`\`

And here is the updated code for \`app.js\`:

\`\`\`javascript
const express = require('express');
const rateLimiter = require('./middleware/rateLimiter');
const app = express();
app.use(rateLimiter);
module.exports = app;
\`\`\`
`;
    const files = extractCodeBlocksWithFilenames(text);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("middleware/rateLimiter.js");
    expect(files[0].content).toContain("rateLimit = require");
    expect(files[1].path).toBe("app.js");
    expect(files[1].content).toContain("app.use(rateLimiter)");
  });

  it("extracts from pseudo-CLI write_file calls", () => {
    const text = `
Save the file using:
write_file --path @middleware/rateLimiter.js --content "const x = 1;"
`;
    const files = extractCodeBlocksWithFilenames(text);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("middleware/rateLimiter.js");
    expect(files[0].content).toBe("const x = 1;");
  });

  it("cleans dangling intro lines in cleanFinalSummary", () => {
    const text = `
Here is the updated code for \`@middleware/rateLimiter.js\`:

\`\`\`javascript
const x = 1;
\`\`\`

Implemented:
- Updated middleware/rateLimiter.js.

Next Steps:
- Run node app.js.
`;
    const cleaned = cleanFinalSummary(text, true);
    expect(cleaned).not.toContain("Here is the updated code");
    expect(cleaned).not.toContain("const x = 1");
    expect(cleaned).toContain("Implemented:");
    expect(cleaned).toContain("Next Steps:");
  });
});
