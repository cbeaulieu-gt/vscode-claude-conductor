/**
 * Minimal vscode module mock for unit tests.
 *
 * Covers only the symbols imported by src/** today. Extend as new tests need
 * additional surface area — this is intentionally not exhaustive.
 */
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Disposable
// ---------------------------------------------------------------------------

export class Disposable {
  static from(...disposables: { dispose(): void }[]): Disposable {
    return new Disposable(() => disposables.forEach((d) => d.dispose()));
  }

  constructor(private readonly _callOnDispose: () => void) {}

  dispose(): void {
    this._callOnDispose();
  }
}

// ---------------------------------------------------------------------------
// EventEmitter
// ---------------------------------------------------------------------------

export class EventEmitter<T> {
  private readonly _listeners: Array<(e: T) => void> = [];

  readonly event = (listener: (e: T) => void): Disposable => {
    this._listeners.push(listener);
    return new Disposable(() => {
      const idx = this._listeners.indexOf(listener);
      if (idx !== -1) {
        this._listeners.splice(idx, 1);
      }
    });
  };

  fire(data: T): void {
    for (const l of this._listeners) {
      l(data);
    }
  }

  dispose(): void {
    this._listeners.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Uri
// ---------------------------------------------------------------------------

export class Uri {
  static file(path: string): Uri {
    return new Uri("file", "", path, "", "");
  }

  static parse(value: string): Uri {
    return new Uri("vscode", "", value, "", "");
  }

  readonly fsPath: string;

  constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string
  ) {
    this.fsPath = path;
  }
}

// ---------------------------------------------------------------------------
// TreeItem / enums
// ---------------------------------------------------------------------------

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  label?: string;
  description?: string;
  tooltip?: string;
  iconPath?: unknown;
  contextValue?: string;
  command?: unknown;
  collapsibleState?: TreeItemCollapsibleState;

  constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

// ---------------------------------------------------------------------------
// Enums used by src/
// ---------------------------------------------------------------------------

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum TerminalLocation {
  Panel = 1,
  Editor = 2,
}

// ---------------------------------------------------------------------------
// RelativePattern
// ---------------------------------------------------------------------------

export class RelativePattern {
  constructor(
    readonly base: Uri | string,
    readonly pattern: string
  ) {}
}

// ---------------------------------------------------------------------------
// WorkspaceConfiguration stub
// ---------------------------------------------------------------------------

class WorkspaceConfigurationStub {
  get<T>(section: string, defaultValue: T): T {
    return defaultValue;
  }

  update = vi.fn().mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// OutputChannel stub
// ---------------------------------------------------------------------------

class OutputChannelStub {
  appendLine = vi.fn();
  dispose = vi.fn();
}

// ---------------------------------------------------------------------------
// FileSystemWatcher stub
// ---------------------------------------------------------------------------

class FileSystemWatcherStub {
  onDidCreate = vi.fn().mockReturnValue(new Disposable(() => {}));
  onDidChange = vi.fn().mockReturnValue(new Disposable(() => {}));
  onDidDelete = vi.fn().mockReturnValue(new Disposable(() => {}));
  dispose = vi.fn();
}

// ---------------------------------------------------------------------------
// StatusBarItem stub
// ---------------------------------------------------------------------------

class StatusBarItemStub {
  text = "";
  command: string | undefined = undefined;
  tooltip: string | undefined = undefined;
  show = vi.fn();
  hide = vi.fn();
  dispose = vi.fn();
}

// ---------------------------------------------------------------------------
// window namespace
// ---------------------------------------------------------------------------

export const window = {
  terminals: [] as unknown[],
  activeTerminal: undefined as unknown,

  createTerminal: vi.fn().mockReturnValue({
    name: "mock-terminal",
    show: vi.fn(),
    sendText: vi.fn(),
    dispose: vi.fn(),
    processId: Promise.resolve(undefined),
    shellIntegration: undefined,
    creationOptions: {},
  }),

  onDidOpenTerminal: vi.fn().mockReturnValue(new Disposable(() => {})),
  onDidCloseTerminal: vi.fn().mockReturnValue(new Disposable(() => {})),
  onDidChangeTerminalShellIntegration: vi.fn().mockReturnValue(new Disposable(() => {})),

  createOutputChannel: vi.fn().mockImplementation(() => new OutputChannelStub()),

  showInformationMessage: vi.fn().mockResolvedValue(undefined),
  showWarningMessage: vi.fn().mockResolvedValue(undefined),
  showErrorMessage: vi.fn().mockResolvedValue(undefined),
  showQuickPick: vi.fn().mockResolvedValue(undefined),
  showInputBox: vi.fn().mockResolvedValue(undefined),

  registerTreeDataProvider: vi.fn().mockReturnValue(new Disposable(() => {})),
  registerUriHandler: vi.fn().mockReturnValue(new Disposable(() => {})),
  registerTerminalLinkProvider: vi.fn().mockReturnValue(new Disposable(() => {})),

  createStatusBarItem: vi.fn().mockImplementation(() => new StatusBarItemStub()),
};

// ---------------------------------------------------------------------------
// workspace namespace
// ---------------------------------------------------------------------------

export const workspace = {
  workspaceFolders: undefined as unknown,

  getConfiguration: vi.fn().mockImplementation(() => new WorkspaceConfigurationStub()),

  onDidChangeConfiguration: vi.fn().mockReturnValue(new Disposable(() => {})),

  createFileSystemWatcher: vi.fn().mockImplementation(() => new FileSystemWatcherStub()),

  openTextDocument: vi.fn().mockResolvedValue({}),
};

// ---------------------------------------------------------------------------
// commands namespace
// ---------------------------------------------------------------------------

export const commands = {
  registerCommand: vi.fn().mockReturnValue(new Disposable(() => {})),
  executeCommand: vi.fn().mockResolvedValue(undefined),
};

// ---------------------------------------------------------------------------
// env namespace
// ---------------------------------------------------------------------------

export const env = {
  openExternal: vi.fn().mockResolvedValue(true),
};
