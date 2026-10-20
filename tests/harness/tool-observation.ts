/** Split the host's result-reference header from the untrusted tool payload. */
export function toolObservation(output: string): { resultId?: string; prefix: string; payload: string } {
  const match = /^\[DURABLE RESULT: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}); retrieve_result action=read result_id=\1\]\n/i.exec(output);
  return match ? { resultId: match[1], prefix: match[0], payload: output.slice(match[0].length) } : { prefix: "", payload: output };
}
