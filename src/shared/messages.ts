// ============================================================================
// Chrome Agent — Shared Message Schema
// All cross-context messages MUST follow this contract.
// ============================================================================

/** Protocol version for forward compatibility. */
export const PROTOCOL_VERSION = 1;

/** All valid action types. Keep in sync with the plan's function definitions. */
export const VALID_ACTIONS = [
  // Page perception
  'get_page_semantic_structure',
  'extract_text',
  // On-demand vision
  'tag_elements',
  'call_vision_model',
  // Page operations
  'execute_click',
  'execute_type',
  'hover',
  'press_key',
  'scroll_page',
  // Flow control
  'wait_for',
  'handle_dialog',
  'ask_user',
  'finish_task',
  // Navigation
  'navigate_to_url',
  // Escape hatch (strictly governed)
  'execute_javascript',
] as const;

export type Action = (typeof VALID_ACTIONS)[number];

// ─── Streaming Protocol ────────────────────────────────────────────────────

export interface StreamChunk {
  type: 'stream_chunk';
  step_id: string;
  delta: string;
  sequence: number;
  done: boolean;
}

export interface StepStatus {
  type: 'step_status';
  step_id: string;
  status: 'thinking' | 'executing' | 'completed' | 'errored';
  detail: string;
}

export interface Heartbeat {
  type: 'heartbeat';
  timestamp: number;
}

// ─── Base Message ──────────────────────────────────────────────────────────

export interface BaseMessage {
  protocolVersion: number;
  action: Action;
  requestId: string; // UUID v4, used for request-response matching
  tabId: number; // Session isolation per tab
}

// ─── Action Request Payloads ───────────────────────────────────────────────

export interface GetPageSemanticStructureRequest extends BaseMessage {
  action: 'get_page_semantic_structure';
}

export interface ExtractTextRequest extends BaseMessage {
  action: 'extract_text';
  element_id: number;
}

export interface TagElementsRequest extends BaseMessage {
  action: 'tag_elements';
  selector: string; // CSS selector, max 500 chars
  region?: string; // Human-readable region description, max 200 chars
}

export interface CallVisionModelRequest extends BaseMessage {
  action: 'call_vision_model';
  question: string; // Question for the vision model, max 2000 chars
}

export interface ExecuteClickRequest extends BaseMessage {
  action: 'execute_click';
  element_id: number;
}

export interface ExecuteTypeRequest extends BaseMessage {
  action: 'execute_type';
  element_id: number;
  text: string; // max 10000 chars
}

export interface HoverRequest extends BaseMessage {
  action: 'hover';
  element_id: number;
}

export interface PressKeyRequest extends BaseMessage {
  action: 'press_key';
  key: 'Enter' | 'Escape' | 'Tab' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
    | 'PageUp' | 'PageDown' | 'Home' | 'End' | 'Backspace' | 'Delete' | 'Control+A'
    | 'Shift+Tab';
}

export interface ScrollPageRequest extends BaseMessage {
  action: 'scroll_page';
  direction: 'up' | 'down' | 'top' | 'bottom';
}

export interface WaitForCondition {
  element_visible?: number;
  element_hidden?: number;
  text_present?: string;
  network_idle?: boolean;
  dom_stable?: boolean;
}

export interface WaitForRequest extends BaseMessage {
  action: 'wait_for';
  condition: WaitForCondition;
  timeout_ms?: number; // default 10000
}

export interface HandleDialogRequest extends BaseMessage {
  action: 'handle_dialog';
  dialog_action: 'accept' | 'dismiss';
  prompt_text?: string; // only for prompt() dialogs
}

export interface AskUserRequest extends BaseMessage {
  action: 'ask_user';
  question: string; // max 2000 chars
}

export interface FinishTaskRequest extends BaseMessage {
  action: 'finish_task';
  summary: string;
}

export interface NavigateToUrlRequest extends BaseMessage {
  action: 'navigate_to_url';
  url: string;
}

export interface ExecuteJavascriptRequest extends BaseMessage {
  action: 'execute_javascript';
  code: string; // sandboxed read-only JS
}

// ─── Union type ────────────────────────────────────────────────────────────

export type ActionRequest =
  | GetPageSemanticStructureRequest
  | ExtractTextRequest
  | TagElementsRequest
  | CallVisionModelRequest
  | ExecuteClickRequest
  | ExecuteTypeRequest
  | HoverRequest
  | PressKeyRequest
  | ScrollPageRequest
  | WaitForRequest
  | HandleDialogRequest
  | AskUserRequest
  | FinishTaskRequest
  | NavigateToUrlRequest
  | ExecuteJavascriptRequest;

// ─── Response Types ────────────────────────────────────────────────────────

export interface BaseResponse {
  requestId: string;
  success: boolean;
  error?: string;
}

export interface SemanticStructureResponse extends BaseResponse {
  success: true;
  data: PageSemanticStructure;
}

export interface PageSemanticStructure {
  title: string;
  url: string; // origin + pathname only (query params stripped)
  mainNav: string[];
  forms: FormArea[];
  interactiveElements: InteractiveElement[];
  structuralAreas: StructuralArea[];
  extractionMetadata: ExtractionMetadata;
}

export interface FormArea {
  region: string; // e.g. "search", "login"
  fields: FormField[];
}

export interface FormField {
  label: string;
  placeholder?: string;
  name?: string; // filtered for security — see content filter pipeline
  type: string; // e.g. "text", "select", "checkbox"
  required: boolean;
}

export interface InteractiveElement {
  id: number; // assigned sequentially in traversal order
  tagName: string;
  text: string; // trimmed text content, max 200 chars
  type?: string; // for inputs: "text" | "button" | "submit" | "select" etc.
  role?: string; // ARIA role if present
  ariaLabel?: string;
  href?: string; // for links — origin + pathname only
  placeholder?: string;
  visible: boolean;
}

export interface StructuralArea {
  type: 'list' | 'card' | 'search_result' | 'navigation' | 'other';
  count?: number; // number of items
  sampleText: string; // first 200 chars of text content
}

export interface ExtractionMetadata {
  mode: 'viewport' | 'full_page';
  totalElements: number;
  interactiveCount: number;
  durationMs: number;
  truncated: boolean;
}

export interface ExtractTextResponse extends BaseResponse {
  success: true;
  text: string;
}

export interface TagElementsResponse extends BaseResponse {
  success: true;
  tagged: TaggedElement[];
  boundsUnion: BoundingBox; // union of all tagged element bounding boxes
}

export interface TaggedElement {
  id: number;
  tagName: string;
  text: string;
  boundingRect: BoundingBox;
  locators: MultiStrategyLocator;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MultiStrategyLocator {
  dataTagId: string; // [data-tag-id="@N"] — most reliable
  cssPath: string; // from nearest stable ancestor
  attributeSelector: string; // tagName[type="..."][aria-label="..."][name="..."]
  textFragment: string; // tagName + textContent first 100 chars — weakest
}

export interface CallVisionModelResponse extends BaseResponse {
  success: true;
  elementId: number; // the element ID returned by the vision model
  confidence?: number;
  reasoning?: string;
}

export interface ExecuteResponse extends BaseResponse {
  success: true;
  actionTaken: string;
  preOperationHash: string;
  postOperationHash: string;
}

export interface WaitForResponse extends BaseResponse {
  success: true;
  conditionMet: boolean;
  elapsedMs: number;
}

export interface AskUserResponse extends BaseResponse {
  success: true;
  answer: string; // user's reply
  cancelled: boolean;
}

export interface FinishTaskResponse extends BaseResponse {
  success: true;
  acknowledged: boolean;
}

export interface ExecuteJavascriptResponse extends BaseResponse {
  success: true;
  result: unknown; // serialized result from the sandboxed code
}

// ─── Internal Messages (Side Panel ↔ Background) ──────────────────────────

export interface UserInputMessage {
  type: 'user_input';
  text: string;
  tabId: number;
}

export interface StopRequestMessage {
  type: 'stop_request';
  tabId: number;
}

export interface ResumeSessionMessage {
  type: 'resume_session';
  tabId: number;
  sessionId: string;
}

export interface CostUpdateMessage {
  type: 'cost_update';
  tabId: number;
  totalTokens: number;
  estimatedCost: number;
  modelBreakdown: Record<string, { tokens: number; cost: number }>;
}

// ─── Validation Helpers ────────────────────────────────────────────────────

export function isValidAction(action: string): action is Action {
  return (VALID_ACTIONS as readonly string[]).includes(action);
}

export function isValidBaseMessage(msg: unknown): msg is BaseMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.protocolVersion === PROTOCOL_VERSION &&
    typeof m.action === 'string' &&
    isValidAction(m.action) &&
    typeof m.requestId === 'string' &&
    typeof m.tabId === 'number' && m.tabId >= 0
  );
}

/** Valid key names for press_key action */
const VALID_KEYS = new Set([
  'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'Delete', 'Control+A', 'Shift+Tab',
]);

export function isValidKey(key: string): boolean {
  return VALID_KEYS.has(key);
}

export function isValidScrollDirection(dir: string): boolean {
  return dir === 'up' || dir === 'down' || dir === 'top' || dir === 'bottom';
}
