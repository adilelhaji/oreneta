import { invoke } from './bridge'

export type PickedFile = {
  name: string
  mime: string
  data: string
}

// Decode the `data:<mime>;base64,<payload>` URL the native picker returns into a
// File. We parse it by hand rather than `fetch(dataUrl)` because the app's CSP
// `connect-src` doesn't allow `data:`, which makes fetch throw "Load failed".
function pickedToFile(picked: PickedFile): File {
  const comma = picked.data.indexOf(',')
  const base64 = comma >= 0 ? picked.data.slice(comma + 1) : picked.data
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const mime = picked.mime || 'application/octet-stream'
  return new File([bytes], picked.name, { type: mime })
}

export async function pickImageFile(title = 'Choose image'): Promise<File | null> {
  const res = await invoke<PickedFile | { cancelled: true }>('system.pickImageFile', { title })
  if ('cancelled' in res && res.cancelled) return null

  return pickedToFile(res as PickedFile)
}

export async function pickFiles(title = 'Choose files'): Promise<File[]> {
  const res = await invoke<{ files: PickedFile[] } | { cancelled: true }>('system.pickFiles', { title })
  if (!('files' in res)) return []
  return Promise.all(res.files.map(pickedToFile))
}

export async function pickImageFiles(title = 'Choose images'): Promise<File[]> {
  const res = await invoke<{ files: PickedFile[] } | { cancelled: true }>('system.pickImageFiles', { title })
  if (!('files' in res)) return []
  return Promise.all(res.files.map(pickedToFile))
}

/**
 * Pick one file and return its bytes as bare base64 — no `data:` prefix, no
 * intermediate `File`. For a caller that wants the bytes themselves (a
 * certificate to import) rather than something to attach, decoding into a
 * `File` and then reading it back out would be a round trip for nothing: the
 * native picker already hands back base64.
 */
export async function pickFileAsBase64(title: string): Promise<{ name: string; base64: string } | null> {
  const res = await invoke<{ files: PickedFile[] } | { cancelled: true }>('system.pickFiles', { title })
  if (!('files' in res) || res.files.length === 0) return null
  const picked = res.files[0]
  const comma = picked.data.indexOf(',')
  return { name: picked.name, base64: comma >= 0 ? picked.data.slice(comma + 1) : picked.data }
}
