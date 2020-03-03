import { readFileSync, readFile } from 'fs'
import os from 'os'
import { basename, dirname, extname, join, resolve } from 'path'
import readdirp, { EntryInfo } from 'readdirp'
import vscode, { Event, ProviderResult, TreeDataProvider, Uri, TreeItemCollapsibleState, Command, ExtensionContext } from 'vscode'
import { compile, exists, getProjectDir, isDir, writeFile } from './utils'

async function openFile(filename: string) {
  const uri = vscode.Uri.file(filename)
  const document = await vscode.workspace.openTextDocument(uri)
  if (document) {
    await vscode.window.showTextDocument(document)
  }
}

const PROMPT_YES = 'Yes'
const PROMPT_NO = 'No'

async function confirm(question: string, modal = true) {
  const result = await vscode.window.showWarningMessage(question, { modal }, PROMPT_NO, PROMPT_YES)
  return result === PROMPT_YES
}

async function promptValue(prompt: string) {
  return vscode.window.showInputBox({
    placeHolder: 'Value',
    prompt,
  })
}

async function selectValue(placeHolder: string, items: string[]) {
  return vscode.window.showQuickPick(items, {
    placeHolder,
  })
}

async function multiselectValue(placeHolder: string, items: string[]) {
  return vscode.window.showQuickPick(items, {
    placeHolder,
    canPickMany: true,
  })
}

async function multiselectValueCustom(placeHolder: string, items: string[]) {
  let value: string | undefined = undefined
  const selectedItems: string[] = []
  const itemsList = ['DONE', ...items]
  do {
    const message = selectedItems.length === 0
      ? placeHolder
      : selectedItems.join(', ')
    value = await vscode.window.showQuickPick(itemsList, {
      placeHolder: message,
    })
    if (value) {
      if (value.startsWith('[-] ')) {
        const i = selectedItems.indexOf(value.slice(4))
        selectedItems.splice(i, 1)
        const j = itemsList.indexOf(value)
        itemsList.splice(j, 1, value.slice(4))
      }
      else {
        selectedItems.push(value)
        const i = itemsList.indexOf(value)
        itemsList.splice(i, 1, '[-] ' + value)
      }
    }
  } while (value && value !== 'DONE')

  return selectedItems.slice(0, -1)
}

export interface TreeNode {
  contextValue: 'root' | 'template'
  label: string
}

export interface RootLevelNode extends TreeNode {
  contextValue: 'root'
}

export interface Template extends TreeNode {
  contextValue: 'template'
  name: string
  code: string
  path: string
  command?: Command
  resourceUri?: Uri
}

export interface TemplatesTreeProvider extends TreeDataProvider<TreeNode> {
  showDialog(uri: Uri): Promise<void>
  createFile(template: Template): Promise<string | void>
  create(): Promise<void>
  clone(item: Template): Promise<void>
  edit(item: Template): Promise<void>
  rename(item: Template): Promise<void>
  delete(item: Template): Promise<void>
  refresh(): Promise<void>
}

const readTemplate = async (file: EntryInfo): Promise<Template> => {
  const name = file.basename
  const code = await new Promise<string>((resolve, reject) =>
    readFile(file.fullPath, { encoding: 'utf8' }, (err, data) => err ? reject(err) : resolve(data)))
  const t: Template = {
    contextValue: 'template',
    name,
    label: name,
    code,
    path: file.path,
    resourceUri: vscode.Uri.file(file.fullPath),
  }
  t.command = {
    title: 'Edit',
    command: 'templates.edit',
    arguments: [t],
  }
  return t
}

export const createTemplatesTreeProvider = async (context: ExtensionContext): Promise<TemplatesTreeProvider> => {

  const onDidChange = new vscode.EventEmitter<TreeNode>()
  const templates: Record<string, {
    templates: Template[]
    needUpdate: boolean
    subscriptions: vscode.Disposable[]
  }> = {}

  const getTemplates = async (workspace: string) => {
    if (templates[workspace] && !templates[workspace].needUpdate)
      return templates[workspace].templates


    if (!templates[workspace]) {
      templates[workspace] = {
        templates: [],
        needUpdate: false,
        subscriptions: [],
      }
    }

    const reads = vscode.workspace.workspaceFolders?.filter(x => x.name === workspace).map(async x => {
      const path = x.uri.fsPath
      const files = await readdirp.promise(path, {
        directoryFilter: d => !d.basename.includes('node_modules')
          && !d.basename.includes('dist')
          && !d.basename.includes('build'),
        fileFilter: '*.dotjs',
      })

      return { name: x.name, files }

    }) || []


    if (templates[workspace].subscriptions.length === 0) {

      const makeDirty = () => {
        templates[workspace].needUpdate = true
        onDidChange.fire()
      }

      const watcher = vscode.workspace.createFileSystemWatcher('**/*.dotjs')

      templates[workspace].subscriptions = [
        watcher.onDidCreate(makeDirty),
        watcher.onDidDelete(makeDirty),
        watcher.onDidChange(makeDirty),
      ]
      context.subscriptions.push(...(templates[workspace].subscriptions))
    }

    const [{ files }] = await Promise.all(reads)
    await Promise.all(files.map(readTemplate)).then(x => {
      templates[workspace].templates = x
    })

    return templates[workspace].templates
  }

  return ({
    get onDidChangeTreeData(): Event<TreeNode> {
      //templatesManager.onUpdate()
      return onDidChange.event
    },
    getTreeItem: (element: RootLevelNode | Template) => {
      if (element.contextValue === 'root')
        return {
          label: element.label,
          contextValue: element.contextValue,
          collapsibleState: TreeItemCollapsibleState.Collapsed,
        }

      return {
        label: element.label,
        contextValue: element.contextValue,
        collapsibleState: TreeItemCollapsibleState.None,
      }
    },
    getChildren: (element: TreeNode): ProviderResult<TreeNode[]> => {
      if (!element)
        return vscode.workspace.workspaceFolders?.map(({ name }) => ({
          contextValue: 'root',
          label: name,
        })) || []

      return getTemplates(element.label)
    },
    showDialog: async (uri) => {
      const items = [
        // ...templatesManager.templates.map(({ name }) => ({
        //   label: name,
        //   path: uri ? uri.fsPath : templatesManager.workspacePath,
        //   command: 'templates.createFile',
        // })),
        {
          label: 'Create...',
          description: 'Create new template',
          command: 'templates.create',
        },
      ]
      const selection = await vscode.window.showQuickPick(items, {
        placeHolder: 'Pick a template',
      })
      if (selection) {
        await vscode.commands.executeCommand(selection.command, selection)
      }
    },
    createFile: async ({ label, path }) => {
      try {
        const extension = extname(label)
        const name = await vscode.window.showInputBox({
          placeHolder: 'Filename',
          prompt: `Enter a filename for template ${label}`,
          value: basename(label, extension),
        })
        // if (name) {
        //   const template = templatesManager.get(label)
        //   if (!template)
        //     throw new Error(`Template ${label} not found.`)
        //   const dir = (await isDir(path)) ? path : dirname(path)
        //   const dirName = basename(dir)
        //   const filename = join(dir, `${name}${extension}`)

        //   const isExists = await exists(filename)
        //   if (!isExists || (await confirm(`Replace existing file "${filename}"?`))) {

        //     type interactive = (...args: any[]) => Promise<undefined | boolean | string | string[]>
        //     const interactives = <T extends { [i: string]: interactive }>(map: T) => {
        //       const interactives = new Map<string, { interactive: interactive, args: any[] }>()
        //       const context = Object.entries(map).map(([key, interactive]) => ({
        //         key,
        //         func: (propName: string, ...args: any[]) => {
        //           interactives.set(propName, { interactive, args })
        //           return ''
        //         }
        //       })).reduce((a, { key, func }) => ({ ...a, [key]: func }), {}) as T

        //       const run = async () => {
        //         const result: Record<string, any> = {}
        //         for (const [key, { interactive, args }] of interactives) {
        //           result[key] = await interactive(...args)
        //         }
        //         return result
        //       }

        //       return {
        //         context,
        //         run,
        //       }
        //     }

        //     const { context, run } = interactives({
        //       confirm: async (message: string) => confirm(message),
        //       prompt: async (message: string) => promptValue(message),
        //       select: async (message: string, items: string[]) => selectValue(message, items),
        //       multiselect: async (message: string, items: string[]) => multiselectValueCustom(message, items),
        //       multiselectNative: async (message: string, items: string[]) => multiselectValue(message, items),
        //       multipath: async (message: string, pathBase: string, fileFilter?: string | string[]) => {
        //         const root = getProjectDir()
        //         if (root) {
        //           const baseFolder = join(root, pathBase)
        //           const items = (await readdirp.promise(baseFolder, { fileFilter }))
        //             .map(x => x.path)

        //           return multiselectValueCustom(message, items.map(x => x.replace(baseFolder, '')))
        //         }
        //       },
        //     })

        //     const compiled = compile(template.code, {
        //       ...context,
        //       import(filePath: string) {
        //         const fullPath = resolve(template.path, filePath)
        //         const source = readFileSync(fullPath, { encoding: 'utf8' })
        //         return `{{${source}}}`
        //       },
        //     })

        //     const params = {
        //       DIR: dir,
        //       DIRNAME: dirName,
        //       FILE: `${name}${extension}`,
        //       FILE_PATH: filename,
        //       USER: os.userInfo().username,
        //       NAME: name,
        //       DATE: new Date()
        //         .toISOString()
        //         .replace('T', ' ')
        //         .replace(/\.\w+/, ''),
        //       ...templatesManager.config.customVars,
        //       ...(await run()),
        //     }

        //     await writeFile(filename, compiled(params))
        //     return openFile(filename)
        //   }
        // }

      } catch (error) {
        return vscode.window.showErrorMessage(`Creation interrupted: ${error}`)
      }
    },
    create: async () => {
      const input = await vscode.window.showInputBox({
        placeHolder: 'Filename',
        prompt: 'Enter a template name',
      })
      // if (input) {
      //   const isExists = await templatesManager.has(input)
      //   if (!isExists || (await confirm(`Replace existing template "${input}"?`))) {
      //     await templatesManager.set(input, '')
      //     const filename = templatesManager.getFilename(input)
      //     if (filename)
      //       await openFile(filename)
      //   }
      // }
    },
    clone: async item => {
      const input = await vscode.window.showInputBox({
        placeHolder: 'New Filename',
        prompt: `Clone template ${item.label}`,
        value: ` clone ${item.label}`,
      })
      // if (input && input !== item.label) {
      //   const isExists = await templatesManager.has(input)
      //   if (!isExists || (await confirm(`Replace existing template "${item.label}"?`))) {
      //     await templatesManager.clone(item.label, input)
      //   }
      // }
    },
    edit: async item => {
      // if (item) {
      //   const filename = templatesManager.getFilename(item.label)
      //   if (filename)
      //     await openFile(filename)
      // }
    },
    rename: async item => {
      const input = await vscode.window.showInputBox({
        placeHolder: 'New Filename',
        prompt: `Rename template ${item.label}`,
        value: item.label,
      })
      // if (input && input !== item.label) {
      //   const isExists = await templatesManager.has(input)
      //   if (!isExists || (await confirm(`Replace existing template "${item.label}"?`))) {
      //     await templatesManager.rename(item.label, input)
      //   }
      // }
    },
    delete: async item => {
      // if (item) {
      //   if (await confirm(`Delete template "${item.label}"?`)) {
      //     await templatesManager.remove(item.label)
      //   }
      // }
    },
    refresh: async () => { },// templatesManager.update,
  })
}