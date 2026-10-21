/**
 * Private text entry.
 *
 * The employer page shares a document with the in-page assistant, so a script on
 * it can register capture-phase key/input/paste listeners on window and observe
 * everything typed into any input in the assistant, even inside a closed shadow
 * root. Text the user types for XpertApply is therefore entered in an
 * extension-origin iframe, whose events never reach the embedding document, and
 * travels only over chrome.runtime messaging.
 */
export const FIELD_ENTRY_PAGE = "fieldentry.html";
export const FIELD_ENTRY_MAX_VALUE = 4096;

export interface FieldEntryField { placeholder: string; value: string }
export interface FieldEntryToggle { label: string; checked: boolean }
export interface FieldEntryConfig {
  tabId: number;
  fields: FieldEntryField[];
  submitLabel: string;
  toggle?: FieldEntryToggle;
  at: number;
}

/** Height of the iframe for a given config (fields are 53px, button row 48px). */
export function fieldEntryHeight(fieldCount: number, hasToggle: boolean): number {
  return fieldCount * 53 + (hasToggle ? 34 : 0) + 52;
}
