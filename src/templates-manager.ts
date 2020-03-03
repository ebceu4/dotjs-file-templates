import { basename, dirname, join, resolve } from 'path'
import vscode, { ExtensionContext, Uri, WorkspaceConfiguration, Command } from 'vscode'
import { exists, getProjectDir, mkdir, readDir, readFile, rename, unlink, writeFile } from './utils'

export interface Template {
  type: 'template'
  name: string
  label: string
  code: string
  path: string
  command?: Command
  resourceUri?: Uri
}

export interface TemplatesManager {
  workspacePath?: string
  config: WorkspaceConfiguration
  templates: Template[]
  onUpdate: () => void
  getFilename(name: string): string | undefined
  has(name: string): Promise<boolean>
  get(name: string): Template | undefined
  set(name: string, code: string): Promise<void>
  clone(name: string, cloneName: string): Promise<void>
  rename(oldName: string, newName: string): Promise<void>
  remove(name: string): Promise<void>
  update(): Promise<void>
  onDidChange: vscode.EventEmitter<Template>
}

export const createTemplatesManager = async (context: ExtensionContext): Promise<TemplatesManager> => {
  function getFilename(templatesDir: string, name: string) {
    return join(templatesDir, name)
  }

  const templates: Template[] = []
  const onDidChange = new vscode.EventEmitter<Template>()

  const getTemplatesDir = () => {
    const root = getProjectDir()
    if (!root) return undefined
    return resolve(root, '.vscode/templates')
  }

  const createTemplatesDirIfNotExists = async () => {
    const templatesDir = getTemplatesDir()
    if (templatesDir) {
      const e = await exists(templatesDir)
      if (!e) {
        await mkdir(templatesDir)
      }
    }
  }

  async function update() {
    const templatesDir = getTemplatesDir()
    if (templatesDir && await exists(templatesDir)) {
      const filenames: string[] = await readDir(templatesDir)
      const append: Template[] = await Promise.all(
        filenames
          .filter(x => !basename(x).startsWith('_'))
          .map(async (name: string) => {
            const path = dirname(join(templatesDir, name))
            const filename = getFilename(templatesDir, name)
            const t: Template = {
              type: 'template',
              name,
              label: name,
              code: await readFile(filename, 'utf8'),
              path,
              resourceUri: vscode.Uri.file(filename),
            }
            t.command = {
              title: 'Edit',
              command: 'templates.edit',
              arguments: [t],
            }
            return t
          }),
      )
      templates.splice(0, templates.length, ...append)
      onDidChange.fire()
    }
    else {
      templates.splice(0, templates.length)
      onDidChange.fire()
    }
  }

  let subscribed: string | null = null
  const subs: vscode.Disposable[] = []
  const onUpdate = async () => {
    if (vscode.workspace.name && subscribed !== vscode.workspace.name) {
      if (subs.length > 0) {
        subs.forEach(x => x.dispose())
        subs.splice(1, subs.length)
      }
      subscribed = vscode.workspace.name
      const dirWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/templates')
      const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/templates/*')
      subs.push(watcher.onDidCreate(() => update()))
      subs.push(watcher.onDidDelete(() => update()))
      subs.push(watcher.onDidChange(() => update()))
      subs.push(dirWatcher.onDidDelete(() => update()))
      context.subscriptions.push(...subs)
      update()
    }
  }

  return {
    get workspacePath() {
      return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
    },
    get config() {
      return vscode.workspace.getConfiguration('templates')
    },
    onUpdate,
    templates,
    getFilename: (name) => {
      const templatesDir = getTemplatesDir()
      return templatesDir ? getFilename(templatesDir, name) : undefined
    },
    async has(name: string) {
      const templatesDir = getTemplatesDir()
      if (!templatesDir) return false

      return await exists(getFilename(templatesDir, name))
    },
    get(name: string) {
      return templates.find(x => x.name == name)
    },
    async set(name: string, code: string) {
      const templatesDir = getTemplatesDir()
      if (templatesDir) {
        await createTemplatesDirIfNotExists()
        await writeFile(getFilename(templatesDir, name), code)
      }
    },
    async clone(name: string, cloneName: string) {
      const templatesDir = getTemplatesDir()
      if (templatesDir) {
        const code = await readFile(getFilename(templatesDir, name), 'utf8')
        await writeFile(getFilename(templatesDir, cloneName), code)
      }
    },
    async rename(oldName: string, newName: string) {
      const templatesDir = getTemplatesDir()
      if (templatesDir) {
        await rename(getFilename(templatesDir, oldName), getFilename(templatesDir, newName))
      }
    },
    async remove(name: string) {
      const templatesDir = getTemplatesDir()
      if (templatesDir) {
        await unlink(getFilename(templatesDir, name))
      }
    },
    update,
    onDidChange,
  }
}
