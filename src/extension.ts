import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { LanMultiplayer } from "./common";

let currentPanel: vscode.WebviewPanel | undefined = undefined;

// 音效状态以扩展侧为唯一真源，供 TreeView、单人面板(game.html) 与联机面板共享
let soundOn = true;
// 由 activate 注入：单人面板点击音效按钮时通知扩展统一切换
let toggleSoundHandler: () => void = () => {};

// 战舰状态机面板
class BattleShipPanel {
  public static currentPanel: BattleShipPanel | undefined;
  public static readonly viewType = "battleShip.game";
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
    if (BattleShipPanel.currentPanel) {
      BattleShipPanel.currentPanel._panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      BattleShipPanel.viewType, "海战棋（你 vs 机器人）",
      column || vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true }
    );
    BattleShipPanel.currentPanel = new BattleShipPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._update();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    // 单人面板：音效按钮点击后交由扩展统一处理（与 TreeView 状态一致）
    this._panel.webview.onDidReceiveMessage((msg: any) => {
      if (msg && msg.type === "toggleSound") toggleSoundHandler();
    }, null, this._disposables);
  }

  public dispose() {
    BattleShipPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) this._disposables.pop()?.dispose();
  }

  private _update() {
    let html = fs.readFileSync(path.join(this._extensionUri.fsPath, "src", "webview", "game.html"), "utf8");
    // 注入当前音效状态，保证面板初始化即与 TreeView 一致
    html = html.replace("__GAME_SOUND_ON__", JSON.stringify(soundOn));
    this._panel.webview.html = html;
  }

  public static postSoundToWebview(on: boolean) {
    if (BattleShipPanel.currentPanel) {
      BattleShipPanel.currentPanel._panel.webview.postMessage({ type: "setSound", on });
    }
  }
}

// ---- TreeView 菜单 ----
interface MenNode {
  id: string;
  label: string;
  description?: string;
  command?: string;   // 有则点击执行对应命令；无则为分组标题
  icon?: string;
  isHeader?: boolean;
}
class MenuProvider implements vscode.TreeDataProvider<MenNode> {
  private _onDidChange = new vscode.EventEmitter<MenNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  constructor(private getSound: () => boolean) {}
  refresh() { this._onDidChange.fire(); }
  getTreeItem(n: MenNode): vscode.TreeItem {
    const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
    item.description = n.description;
    if (n.command) item.command = { command: n.command, title: n.label, arguments: [] };
    if (n.icon) item.iconPath = new vscode.ThemeIcon(n.icon);
    if (n.isHeader) item.contextValue = "header";
    return item;
  }
  getChildren(): MenNode[] {
    const on = this.getSound();
    return [
      { id: "open", label: "新对局", command: "battleShip.open", icon: "play" },
      { id: "restart", label: "重开一局", command: "battleShip.restart", icon: "refresh" },
      { id: "sep-online", label: "── 联机模式 ──", isHeader: true },
      { id: "multiCreate", label: "创建房间", command: "battleShip.multiCreate", icon: "add" },
      { id: "multiJoin", label: "加入房间", command: "battleShip.multiJoin", icon: "plug" },
      { id: "setNick", label: "设定昵称", command: "battleShip.setNickname", icon: "person" },
      { id: "sound", label: on ? "音效：开 🔊" : "音效：关 🔇", command: "battleShip.toggleSound", icon: on ? "unmute" : "mute" },
    ];
  }
}

export function activate(context: vscode.ExtensionContext) {
  // 音效状态以扩展侧为唯一真源（持久化到 globalState，供 TreeView、单人面板、联机面板共享）
  soundOn = context.globalState.get<boolean>("battleShip.soundOn") ?? true;
  function getSoundOn(): boolean { return soundOn; }
  function setSoundOn(on: boolean) {
    soundOn = on;
    context.globalState.update("battleShip.soundOn", on);
    menu.refresh();
    try { multi.postToWebview({ type: "setSound", on }); } catch { /* 面板未打开时忽略 */ }
    BattleShipPanel.postSoundToWebview(on);   // 同步给单人面板
  }
  // 单人面板音效按钮点击入口
  toggleSoundHandler = () => setSoundOn(!getSoundOn());

  const menu = new MenuProvider(() => getSoundOn());
  // 注意：需与 package.json 中贡献的 view id 保持一致（battleShip.menu）
  vscode.window.registerTreeDataProvider("battleShip.menu", menu);

  // 联机模块（直接复用 common/LanMultiplayer，不自行实现网络）
  const multi = new LanMultiplayer({
    context,
    commandPrefix: "battleShip",
    viewTypeHost: "battleShip.multiHost",
    viewTypeClient: "battleShip.multiClient",
    port: 18765,
    maxPeers: 1,
    webviewHtmlPath: (ctx) => vscode.Uri.joinPath(ctx.extensionUri, "src", "webview", "multiplayer.html"),
    localResourceRoots: (ctx) => [vscode.Uri.joinPath(ctx.extensionUri, "src", "webview")],
    buildBootstrap: (p) => ({
      role: p.role, host: p.host, port: p.port, localIp: p.localIp, nick: getNickname(), soundOn: getSoundOn(),
    }),
    onWebviewMessage: (msg) => {
      // setNickname / toggleSound 为本地交互，拦截后不再转发到网络
      if (msg && msg.type === "setNickname" && typeof msg.nick === "string") { setNickname(msg.nick); return true; }
      if (msg && msg.type === "toggleSound") { setSoundOn(!getSoundOn()); return true; }
      return false;
    },
  });
  multi.registerCommands();

  function getNickname(): string {
    return context.globalState.get<string>("battleShip.nickname") || "玩家";
  }
  function setNickname(nick: string) {
    const n = (nick || "").trim() || "玩家";
    context.globalState.update("battleShip.nickname", n);
    // 同步给本地面板（本地面板再转发给对手）
    try { multi.postToWebview({ type: "setNickname", nick: n }); } catch { /* 面板未打开时忽略 */ }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("battleShip.open", () => BattleShipPanel.createOrShow(context.extensionUri)),
    vscode.commands.registerCommand("battleShip.restart", () => {
      if (BattleShipPanel.currentPanel) { BattleShipPanel.createOrShow(context.extensionUri); }
      else vscode.window.showInformationMessage("请先开始一局游戏（点击「新对局」）。");
    }),
    vscode.commands.registerCommand("battleShip.setNickname", async () => {
      const prev = getNickname();
      const input = await vscode.window.showInputBox({
        title: "设定联机昵称",
        prompt: "输入你的昵称（将显示给对手）",
        value: prev,
        validateInput: (v) => (v.trim().length === 0 ? "昵称不能为空" : undefined),
      });
      if (input !== undefined) setNickname(input);
    }),
    vscode.commands.registerCommand("battleShip.toggleSound", () => {
      setSoundOn(!getSoundOn());
      vscode.window.showInformationMessage("联机对战音效：" + (getSoundOn() ? "开 🔊" : "关 🔇"));
    })
  );

  // 退出时释放联机资源（关闭 WebSocket 服务 / 连接）
  context.subscriptions.push({ dispose: () => multi.dispose() });
}

export function deactivate() {}
