declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';

  export function markedTerminal(options?: Record<string, unknown>, highlightOptions?: Record<string, unknown>): MarkedExtension;

  export default class TerminalRenderer {
    constructor(options?: Record<string, unknown>, highlightOptions?: Record<string, unknown>);
  }
}
