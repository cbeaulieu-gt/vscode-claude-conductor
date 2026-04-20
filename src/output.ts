import * as vscode from "vscode";

const CHANNEL_NAME = "Claude Conductor";

let _channel: vscode.OutputChannel | undefined;

/** Returns the shared Claude Conductor output channel, creating it on first call. */
export function getOutputChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel(CHANNEL_NAME);
  }
  return _channel;
}

/** Append a timestamped line to the Claude Conductor output channel. */
export function log(message: string): void {
  const ts = new Date().toISOString();
  getOutputChannel().appendLine(`[${ts}] ${message}`);
}
