import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";

export class StatusBar implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;
  private readonly _disposable: vscode.Disposable;

  constructor(sessionManager: SessionManager) {
    this._item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this._item.command = "claudeConductor.openSession";
    this._item.tooltip = "Claude Conductor — click to launch or switch";

    this._update(sessionManager.count);

    this._disposable = sessionManager.onDidChangeSessions(() => {
      this._update(sessionManager.count);
    });
  }

  private _update(count: number): void {
    if (count === 0) {
      this._item.hide();
      return;
    }
    this._item.text = `$(sparkle) ${count} session${count === 1 ? "" : "s"}`;
    this._item.show();
  }

  dispose(): void {
    this._disposable.dispose();
    this._item.dispose();
  }
}
