import * as vscode from 'vscode';
import * as fs from 'fs';

type Action = 'open' | 'restart';

interface MenuNode {
  id: string;
  label: string;
  description?: string;
  action: Action;
}

const TREE: MenuNode[] = [
  { id: 'new', label: '新对局', description: '开始一局海战棋', action: 'open' },
  { id: 'restart', label: '重开一局', description: '清空棋盘重新布置舰队', action: 'restart' }
];

class BattleShipTreeDataProvider implements vscode.TreeDataProvider<MenuNode> {
  getTreeItem(element: MenuNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    if (element.description) {
      item.description = element.description;
    }
    item.tooltip = element.label;
    item.command = {
      command: element.action === 'open' ? 'battleShip.open' : 'battleShip.restart',
      title: element.label
    };
    return item;
  }

  getChildren(element?: MenuNode): MenuNode[] {
    return element ? [] : TREE;
  }
}

const WEBSITE_URL = 'https://codejson.cn/games/battle_ship/';

let panel: vscode.WebviewPanel | undefined;

// 读取 src/webview/game.html，注入消息钩子后作为 webview 内容
function getWebviewContent(context: vscode.ExtensionContext): string {
  const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'src', 'webview', 'game.html');
  let html = fs.readFileSync(htmlPath.fsPath, 'utf-8');

  // 接收来自扩展的重开消息
  const hook = `<script>
    window.addEventListener('message', e => {
      if (!e.data) return;
      if (e.data.type === 'restart') {
        try { init(); } catch (_) {}
      }
    });
  </script>`;
  html = html.replace('</body>', hook + '\n</body>');

  return html;
}

function openGame(context: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    return;
  }
  panel = vscode.window.createWebviewPanel(
    'battleShip',
    '海战棋 你 vs 机器人',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'src', 'webview')]
    }
  );
  panel.webview.html = getWebviewContent(context);
  panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('battleShip.open', () => openGame(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('battleShip.restart', () => {
      if (panel) {
        panel.reveal(vscode.ViewColumn.One);
        panel.webview.postMessage({ type: 'restart' });
      } else {
        openGame(context);
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('battleShip.openWebsite', () => {
      vscode.env.openExternal(vscode.Uri.parse(WEBSITE_URL));
    })
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('battleShip.menu', new BattleShipTreeDataProvider())
  );
}

export function deactivate() {}
