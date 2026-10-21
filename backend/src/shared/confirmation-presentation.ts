import type { PendingAction } from './contracts.js';

/** Titles describe the approval kind. Model text and commands belong in details. */
export const CONFIRMATION_TITLES: Record<PendingAction['kind'], string> = {
  plan_approval: 'Review action plan',
  execute_python: 'Review Python script',
  uncontained_python: 'Review Python access',
  generate_docx: 'Create Word document',
  generate_xlsx: 'Create spreadsheet',
};

/** Approval records retain the full scope. User copy must not expose audit metadata. */
export const CONFIRMATION_DESCRIPTIONS: Record<PendingAction['kind'], string> = {
  plan_approval: 'Review the steps, commands, and file changes before you approve.',
  execute_python: 'Run the script to continue this task. If OS isolation is unavailable, a separate approval is required.',
  uncontained_python: 'OS isolation is unavailable. This script can access files and the network with your user permissions. Approval applies only to this script and its current dependencies and input files.',
  generate_docx: 'Create the Word document for this task.',
  generate_xlsx: 'Create the spreadsheet for this task.',
};
