export function LinkHoverPreview({ url }: { url: string | null }) {
  if (!url) return null

  return (
    <div
      className="pointer-events-none absolute bottom-0 start-0 z-30 rounded-se-md border border-border/70 bg-chats/95 px-2.5 py-1.5 text-caption font-medium leading-snug text-secondary shadow-raised"
      style={{ maxWidth: 'min(720px, 100%)' }}
    >
      <span className="block truncate">{url}</span>
    </div>
  )
}
