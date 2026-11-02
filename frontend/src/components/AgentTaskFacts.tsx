type Facts = NonNullable<RunSnapshot["agentTaskFacts"]>;

export default function AgentTaskFacts({facts}:{facts:Facts}) {
  const groups=[
    {label:"Changes applied",items:facts.changesApplied.map(item=>`${item.summary}${item.historical ? " (earlier attempt)" : ""}`)},
    {label:"Checks passed",items:facts.checksPassed.map(item=>`${item.reason}${item.historical ? " (earlier attempt)" : ""}`)},
    {label:"Checks unavailable",items:facts.checksUnavailable.map(item=>`${item.reason}${item.historical ? " (earlier attempt)" : ""}`)},
    {label:"Remaining requirements",items:facts.remainingRequirements.map(item=>item.description)},
    ...(facts.checksFailed.length ? [{label:"Checks failed",items:facts.checksFailed.map(item=>`${item.reason}${item.historical ? " (earlier attempt)" : ""}`)}] : []),
    ...(facts.checksSkipped.length ? [{label:"Checks skipped",items:facts.checksSkipped.map(item=>item.reason)}] : []),
  ];
  return <details aria-label="Agent task results" className="mx-4 mt-2 max-h-[30vh] overflow-auto rounded border border-[var(--border-subtle)] p-3 text-xs text-[var(--text-secondary)]">
    <summary className="cursor-pointer font-medium">Task results</summary>
    <p className="mt-2">Saved checks apply to the file versions tested. Earlier results do not verify later changes.</p>
    <dl className="mt-2 grid gap-2">{groups.map(group=><div key={group.label}>
      <dt className="font-semibold text-[var(--text-primary)]">{group.label} ({group.items.length})</dt>
      <dd>{group.items.length ? <ul className="list-disc pl-5">{group.items.map((item,index)=><li className="break-words" key={index}>{item}</li>)}</ul> : "None recorded"}</dd>
    </div>)}</dl>
  </details>;
}
