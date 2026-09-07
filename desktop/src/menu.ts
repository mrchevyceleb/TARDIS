import { app, Menu, type MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
  bridgeEnabled: boolean;
  setBridgeEnabled(on: boolean): void;
  forgetApprovals(): void;
  stopComputer(): void;
  resumeComputer(): void;
  setComputerAutomatic(on: boolean): void;
  changeServer(): void;
  reloadServer(): void;
  chooseWorkspace(): void;
  openWorkspace(): void;
  clearFetchedCopies(): void;
  checkForUpdates(): void;
  openReleases(): void;
  openRepository(): void;
}

export function installMenu(actions: MenuActions): void {
  const isMac = process.platform === 'darwin';
  const version = `Type 40 TT Capsule · v${app.getVersion()}`;

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [{
        label: app.name,
        submenu: [
          { role: 'about' },
          { label: version, enabled: false },
          { type: 'separator' },
          { label: 'Check for Updates…', click: actions.checkForUpdates },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }]
    : [];

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: 'Ship',
      submenu: [
        { label: 'Change Server Address…', accelerator: 'CmdOrCtrl+Shift+,', click: actions.changeServer },
        { label: 'Reconnect', accelerator: 'CmdOrCtrl+R', click: actions.reloadServer },
        { type: 'separator' },
        { label: 'Open Local Workspace', accelerator: 'CmdOrCtrl+Shift+O', click: actions.openWorkspace },
        { label: 'Local Workspace Folder…', click: actions.chooseWorkspace },
        { label: 'Clear Fetched Copies', click: actions.clearFetchedCopies },
        { type: 'separator' },
        {
          label: 'Allow Agents on This Computer',
          type: 'checkbox',
          checked: actions.bridgeEnabled,
          click: (item) => actions.setBridgeEnabled(item.checked),
        },
        { label: 'Stop Computer Control', click: actions.stopComputer },
        { label: 'Resume Computer Control', click: actions.resumeComputer },
        { label: 'Automatic Computer Control for This Server', click: () => actions.setComputerAutomatic(true) },
        { label: 'Require Computer Control Approval', click: () => actions.setComputerAutomatic(false) },
        { label: 'Forget Approvals', click: actions.forgetApprovals },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close' } as MenuItemConstructorOptions] : [
          { label: 'Check for Updates…', click: actions.checkForUpdates },
          { type: 'separator' } as MenuItemConstructorOptions,
          { role: 'quit' } as MenuItemConstructorOptions,
        ]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [{ role: 'pasteAndMatchStyle' } as MenuItemConstructorOptions, { role: 'delete' } as MenuItemConstructorOptions, { role: 'selectAll' } as MenuItemConstructorOptions]
          : [{ role: 'delete' } as MenuItemConstructorOptions, { type: 'separator' } as MenuItemConstructorOptions, { role: 'selectAll' } as MenuItemConstructorOptions]),
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'front' } as MenuItemConstructorOptions]
          : [{ role: 'close' } as MenuItemConstructorOptions]),
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Releases', click: actions.openReleases },
        { label: 'TARDIS on GitHub', click: actions.openRepository },
        ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { label: version, enabled: false } as MenuItemConstructorOptions]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
