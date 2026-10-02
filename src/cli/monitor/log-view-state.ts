import {
  cycleMinLevel,
  cycleOption,
  EMPTY_LOG_FILTER,
  type LogFacets,
  type LogFilter,
} from '../../domain/observe/log-filter.js';
import type { LogLine } from '../../domain/observe/log-line.js';

/**
 * Everything the log viewer remembers between keystrokes.
 *
 * A reducer rather than a bag of `useState`s: the interactions have rules that
 * span fields (choosing a server resets an app that does not run there;
 * scrolling up freezes the view) and those rules deserve tests that do not need
 * a terminal.
 */
export interface LogViewState {
  filter: LogFilter;
  /** True while keystrokes are building the search query. */
  typing: boolean;
  /** The buffer as it was when the view was frozen; null means follow the live tail. */
  frozen: readonly LogLine[] | null;
  /** Lines scrolled back from the newest. Only meaningful while frozen. */
  offset: number;
}

export const INITIAL_LOG_VIEW: LogViewState = {
  filter: EMPTY_LOG_FILTER,
  typing: false,
  frozen: null,
  offset: 0,
};

export type LogViewAction =
  | { type: 'cycle'; dimension: 'server' | 'app' | 'process'; direction: 1 | -1; facets: LogFacets }
  | { type: 'cycle-level' }
  | { type: 'toggle-mode' }
  | { type: 'start-search' }
  | { type: 'type'; text: string }
  | { type: 'backspace' }
  | { type: 'commit-search' }
  | { type: 'cancel-search' }
  | { type: 'clear-filters' }
  | { type: 'toggle-pause'; live: readonly LogLine[] }
  | { type: 'resume' }
  | { type: 'scroll'; delta: number; live: readonly LogLine[]; max: number }
  /** Enter the view scoped to what the user was looking at, or unscoped. */
  | { type: 'enter'; server: string | null; app: string | null };

export function logViewReducer(state: LogViewState, action: LogViewAction): LogViewState {
  switch (action.type) {
    case 'cycle': {
      const { dimension, direction, facets } = action;
      if (dimension === 'server') {
        const server = cycleOption(facets.servers, state.filter.server, direction);
        // The new server may not run the chosen app, and the process belongs to the app.
        return { ...state, filter: { ...state.filter, server, app: null, process: null } };
      }
      if (dimension === 'app') {
        const app = cycleOption(facets.apps, state.filter.app, direction);
        return { ...state, filter: { ...state.filter, app, process: null } };
      }
      const process = cycleOption(facets.processes, state.filter.process, direction);
      return { ...state, filter: { ...state.filter, process } };
    }
    case 'cycle-level':
      return { ...state, filter: { ...state.filter, minLevel: cycleMinLevel(state.filter.minLevel) } };
    case 'toggle-mode':
      return { ...state, filter: { ...state.filter, mode: state.filter.mode === 'hide' ? 'dim' : 'hide' } };
    case 'start-search':
      return { ...state, typing: true, filter: { ...state.filter, query: '' } };
    case 'type':
      return { ...state, filter: { ...state.filter, query: state.filter.query + action.text } };
    case 'backspace':
      return { ...state, filter: { ...state.filter, query: state.filter.query.slice(0, -1) } };
    case 'commit-search':
      return { ...state, typing: false };
    case 'cancel-search':
      return { ...state, typing: false, filter: { ...state.filter, query: '' } };
    case 'clear-filters':
      return { ...state, filter: { ...EMPTY_LOG_FILTER, mode: state.filter.mode } };
    case 'toggle-pause':
      return state.frozen === null
        ? { ...state, frozen: action.live, offset: 0 }
        : { ...state, frozen: null, offset: 0 };
    case 'resume':
      return { ...state, frozen: null, offset: 0 };
    case 'scroll': {
      // Scrolling back through history while lines keep arriving would move the
      // page under the reader, so the first scroll up freezes the view.
      const frozen = state.frozen ?? (action.delta > 0 ? action.live : null);
      if (frozen === null) return state;
      const offset = Math.min(Math.max(0, state.offset + action.delta), Math.max(0, action.max));
      return { ...state, frozen, offset };
    }
    case 'enter':
      return {
        ...INITIAL_LOG_VIEW,
        filter: { ...EMPTY_LOG_FILTER, server: action.server, app: action.app },
      };
  }
}
