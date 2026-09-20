import { describe, expect, it } from "vitest";
import { extractCodeBlocksWithFilenames } from "../src/main/agent/code-extractor.js";

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
