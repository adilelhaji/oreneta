import { folderIcon } from '../../lib/folderIcon'
import { buildFolderTree, type TreeNode } from '../../lib/folderTree'
import type { Folder } from '../../types'
import { MenuItem } from './MenuItem'

/** Does this subtree contain anything worth clicking? */
function hasPickable(node: TreeNode, excluded: Set<string>): boolean {
  if (node.folder && !excluded.has(node.folder.id)) return true
  return node.children.some((child) => hasPickable(child, excluded))
}

function FolderMenuRow({
  node,
  depth,
  excluded,
  onPick,
}: {
  node: TreeNode
  depth: number
  excluded: Set<string>
  onPick: (folder: Folder) => void
}) {
  const folder = node.folder
  const pickable = !!folder && !excluded.has(folder.id)
  const Icon = folderIcon(folder)

  return (
    <div role="none">
      {/* Structural segments and the folder the thread already lives in stay
          visible so the hierarchy reads correctly, but can't be picked: they
          are disabled items, still reached and announced by the arrow keys. */}
      <MenuItem
        disabled={!pickable}
        appearance={pickable ? undefined : 'cursor-default text-secondary'}
        style={{ paddingInlineStart: depth * 14 + 8 }}
        icon={<Icon size={14} strokeWidth={1.75} className="shrink-0 text-secondary" />}
        label={
          <span dir="auto" className="block min-w-0 truncate">
            {node.name}
          </span>
        }
        onClick={() => folder && onPick(folder)}
      />
      {node.children.map((child) =>
        hasPickable(child, excluded) ? (
          <FolderMenuRow
            key={child.folder?.id ?? `${depth}-${child.name}`}
            node={child}
            depth={depth + 1}
            excluded={excluded}
            onPick={onPick}
          />
        ) : null,
      )}
    </div>
  )
}

/**
 * A submenu's folder list rendered as the account's folder hierarchy: nested
 * folders are indented under their parent instead of showing their full path.
 */
export function FolderMenuTree({
  folders,
  excludedFolderIds,
  onPick,
}: {
  folders: Folder[]
  /** Folders shown as context but not selectable (the current folder, etc.). */
  excludedFolderIds?: Iterable<string>
  onPick: (folder: Folder) => void
}) {
  const excluded = new Set(excludedFolderIds ?? [])
  return (
    <>
      {buildFolderTree(folders).map((node) =>
        hasPickable(node, excluded) ? (
          <FolderMenuRow key={node.folder?.id ?? node.name} node={node} depth={0} excluded={excluded} onPick={onPick} />
        ) : null,
      )}
    </>
  )
}
