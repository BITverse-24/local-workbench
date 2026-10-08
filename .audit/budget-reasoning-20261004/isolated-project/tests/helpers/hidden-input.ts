export function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("Hidden key input requires a terminal; use the configured environment variable otherwise");
  process.stderr.write(prompt);
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let input = "";
    const cleanup = () => { process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write("\n"); };
    const onData = (bytes: Buffer) => {
      for (const character of bytes.toString()) {
        if (character === "\u0003") { cleanup(); reject(new Error("Credential input cancelled")); return; }
        if (character === "\r" || character === "\n") { cleanup(); resolve(input); return; }
        if (character === "\u007f") input = input.slice(0, -1); else input += character;
      }
    };
    process.stdin.on("data", onData);
  });
}
