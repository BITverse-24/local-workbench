/** Scenario setup is runner metadata, not part of the user's model request. */
function taskText(markdown) {
  return markdown.trim().split(/\r?\n\s*\r?\n/).filter(block=>!/^\*\*(?:Chat type|Files to attach|Knowledge base files|Agent workspace):\*\*/i.test(block.trim())).join('\n\n').trim();
}
module.exports={taskText};
