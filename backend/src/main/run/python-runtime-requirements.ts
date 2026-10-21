export type PythonRuntimeRequirement =
  | {kind:'deliver'; filename:string}
  | {kind:'execute'; filename:string}
  | {kind:'preserve'; extension:string};

/** Only standalone, explicit runtime clauses are handled mechanically.
 * Compound or unfamiliar requirements stay with the content reviewer.
 */
export function pythonRuntimeRequirement(basis:string):PythonRuntimeRequirement|undefined {
  const text=basis.trim().replace(/[.!]$/,'').trim();
  const filename="[`'\"]?([A-Za-z0-9_][A-Za-z0-9_.-]*\\.[A-Za-z0-9]+)[`'\"]?";
  const delivered=text.match(new RegExp('^(?:Return|Deliver|Provide)\\s+'+filename+'$','i'));
  if(delivered)return {kind:'deliver',filename:delivered[1]};
  const executed=text.match(new RegExp('^(?:Run|Execute)\\s+the\\s+(?:(?:repaired|fixed|corrected)\\s+)?(?:script|program)\\s+(?:on|with|against)\\s+'+filename+'$','i'));
  if(executed)return {kind:'execute',filename:executed[1]};
  const preserved=text.match(/^(?:Do not|Don't|Never)\s+(?:change|modify|edit|overwrite)\s+the\s+input\s+(CSV|TSV|JSON|XLSX|TXT)\s*(?:files?)?$/i);
  if(preserved)return {kind:'preserve',extension:preserved[1].toLowerCase()};
}
